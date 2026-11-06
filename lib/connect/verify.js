/**
 * lib/connect/verify.js —— 宿主认证：装 → 调 → 卸 → 配置恢复，四步都留原始输出
 *
 * 为什么要有这个：README 里"支持 8 个宿主"这句话，如果没有逐台的原始输出，
 * 就是一句宣传。这里把每一台都按同一套动作跑一遍，跑不动的老实标成
 * 「实验性」或「未安装」，不写"全兼容"。
 *
 * 判定口径：
 *   verified    装上了 → 宿主自己报连接成功（claude/codex 的 `mcp list`）→ 卸干净 → 配置逐字节还原
 *   config-only 装了、卸了、还原了，但这台机器上没有可问的宿主命令行，无法让宿主任自己确认
 *   not-installed 宿主没装（不伪造配置）
 *   failed      任何一步没过
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { HOSTS, detectHosts, findHost, installHost, uninstallHost, REPO_ROOT } from './hosts.js'

/** 只有这些宿主有"问一句它认不认"的命令行；没有的就不假装验过 */
const CALL_PROBES = {
  'claude-code': { cmd: 'claude', args: ['mcp', 'list'], label: 'claude mcp list' },
  codex: { cmd: 'codex', args: ['mcp', 'list'], label: 'codex mcp list' },
  'gemini-cli': { cmd: 'gemini', args: ['mcp', 'list'], label: 'gemini mcp list' },
}

/**
 * 没有探针的宿主，把**为什么没有**记下来。
 *
 * 为什么值得单独一张表：矩阵里写「无法真调用：no-probe-command」会让人分不清
 * 「我们没去试」和「这东西本来就没法非交互调用」——前者是欠账，后者是平台事实。
 * 本机实测（2026-11-06）：claude-desktop.exe --version 能出 4.4212.0，
 * 但 --help / mcp list 都会把桌面 GUI 拉起来并挂住，不是 CLI。
 */
const NO_PROBE_REASONS = {
  'claude-desktop': 'Claude Desktop 是 GUI 应用（claude-desktop.exe --version 可跑，但 --help / mcp list 会拉起桌面窗口并挂住），没有可非交互调用的 mcp 子命令',
}

const MAX_RAW = 4000

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function clip(text) {
  const s = String(text ?? '')
  return s.length > MAX_RAW ? `${s.slice(0, MAX_RAW)}\n…（截断，共 ${s.length} 字符）` : s
}

function probeCall(hostId, timeoutMs) {
  const probe = CALL_PROBES[hostId]
  if (!probe) {
    // 区分「没去试」和「本来就没法试」：有原因表的照实说，没记的就说没探针。
    return {
      ran: false,
      ok: false,
      reason: 'no-probe-command',
      label: '',
      why: NO_PROBE_REASONS[hostId] || '这个宿主没有可非交互调用的 mcp 子命令',
    }
  }
  // Windows 上这些命令是 .cmd 垫片，必须过 shell；过 shell 时把参数拼成一条命令串，
  // 免得 Node 报 DEP0190（参数与环境变量混用有注入风险）。这里的命令是写死的，不含用户输入。
  const isWin = process.platform === 'win32'
  const res = isWin
    ? spawnSync(`${probe.cmd} ${probe.args.join(' ')}`, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: true })
    : spawnSync(probe.cmd, probe.args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim()
  if (res.error) {
    return { ran: false, ok: false, reason: String(res.error.message || res.error), label: probe.label, raw: clip(out) }
  }
  const hit = /nexi/i.test(out)
  return { ran: true, ok: hit, reason: hit ? '' : '宿主自己列的清单里没有 nexi', label: probe.label, raw: clip(out), exitCode: res.status }
}

function snapshot(file) {
  if (!existsSync(file)) return { existed: false, text: '', hash: '' }
  const text = readFileSync(file, 'utf8')
  return { existed: true, text, hash: sha256(text) }
}

/**
 * 验一台宿主。
 * @param {string} id
 * @param {{timeoutMs?: number, stamp?: string, dryRun?: boolean}} opts
 */
export function verifyHost(id, opts = {}) {
  const host = findHost(id)
  if (!host) return { id, ok: false, status: 'failed', reason: `不认识宿主：${id}`, known: HOSTS.map((h) => h.id) }
  const timeoutMs = opts.timeoutMs || 120000
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-')

  const detected = detectHosts().find((h) => h.id === id)
  // opts.path：显式指定一份配置文件（测试用，或宿主装在非标准位置时）
  const file = opts.path || detected.path
  const installed = opts.path ? existsSync(opts.path) : detected.installed
  const steps = []
  const out = { id, label: host.label, tier: host.tier, kind: host.kind, path: file, installed, steps }

  if (!installed) {
    steps.push({ name: 'detect', ok: false, detail: `宿主未安装（找过：${(host.paths() || []).join(' / ')}），不伪造配置` })
    return { ...out, ok: false, status: 'not-installed' }
  }
  steps.push({ name: 'detect', ok: true, detail: file })

  const before = snapshot(file)
  // 快照这一步只负责"记下起点长什么样"，不是判据：
  // 有些宿主（Gemini CLI）配置是第一次用才创建的，起点就是"没有这个文件"——
  // 那是**正常起点**，不是失败。真正的还原判据在下面的 restore 里。
  steps.push({ name: 'snapshot', ok: true, detail: `${before.existed ? `${before.text.length} 字符` : '装前没有这个文件（首次使用才创建，属正常起点）'} sha256=${before.hash ? `${before.hash.slice(0, 16)}…` : '（无）'}` })

  if (opts.dryRun) {
    return { ...out, ok: true, status: 'dry-run', steps }
  }

  // 先把可能残留的 nexi 条目清掉，保证这一轮真的从"没有"走到"有"
  if (before.existed && /nexi/i.test(before.text)) {
    const purge = uninstallHost(id, { stamp: `${stamp}-verify`, path: file })
    const afterPurge = snapshot(file)
    steps.push({ name: 'baseline', ok: purge.ok && !/nexi/i.test(afterPurge.text), detail: `清掉上一轮残留的 nexi 条目（备份 ${purge.backup || '无'}），本轮从干净配置开始` })
  } else {
    steps.push({ name: 'baseline', ok: true, detail: '安装前配置里没有 nexi，干净起点' })
  }

  const inst = installHost(id, { stamp: `${stamp}-verify`, path: file })
  if (!inst.ok) {
    steps.push({ name: 'install', ok: false, detail: inst.reason || '安装失败', warnings: inst.warnings })
    return { ...out, ok: false, status: 'failed', steps }
  }
  const afterInstall = snapshot(file)
  const wroteNexi = /nexi/i.test(afterInstall.text)
  steps.push({ name: 'install', ok: inst.changed && wroteNexi, detail: `写入成功${inst.changed ? '' : '（无变化）'}；备份 ${inst.backup || '无'}；sha256=${afterInstall.hash.slice(0, 16)}…` })

  const call = opts.path && !detected.installed
    ? { ran: false, ok: false, reason: '宿主没装，这份只是临时配置：能验装/卸/还原，验不了宿主自己认不认', label: '' }
    : probeCall(id, timeoutMs)
  steps.push({
    name: 'call',
    ok: call.ran && call.ok,
    // 没能真调用时，把**为什么**写出来：是"我们没试"还是"平台不允许"，
    // 看矩阵的人有权知道区别，不然会把平台事实当成欠账（或反过来）。
    detail: call.ran
      ? `${call.label} → ${call.ok ? '宿主自己报出 nexi' : call.reason}`
      : `无法真调用：${call.why || call.reason}`,
    raw: call.raw,
  })

  const unin = uninstallHost(id, { stamp: `${stamp}-verify`, path: file })
  const afterUninstall = snapshot(file)
  const cleaned = unin.ok && afterUninstall.text !== afterInstall.text && !/nexi/i.test(afterUninstall.text)
  steps.push({ name: 'uninstall', ok: cleaned, detail: unin.ok ? `nexi 条目已移除（备份 ${unin.backup || '无'}）` : unin.reason || '卸载失败' })

  let restored = afterUninstall.hash === before.hash
  let rewrite = ''
  if (!restored && unin.ok) {
    if (!before.existed) {
      // 装之前**根本没有这个文件**（有些宿主第一次用才创建配置）：
      // 还原的正确做法是把文件删掉，而不是写回一个空文件——
      // 留一个空 settings.json 会污染用户配置，也说明"还原"没做到位。
      try {
        rmSync(file, { force: true })
      } catch { /* 删不掉留给下面的复核去报 */ }
      const afterDelete = snapshot(file)
      restored = !afterDelete.existed
      rewrite = restored ? '（装前不存在，已把新建的文件删掉）' : '（装前不存在，但新建的文件删不掉）'
    } else {
      // 卸载后和装之前不完全一致（多余的空白/换行），用快照原样写回，再比一次
      writeFileSync(file, before.text, 'utf8')
      const afterRewrite = snapshot(file)
      restored = afterRewrite.hash === before.hash
      rewrite = restored ? '（顺序/空白有差，已用快照原样写回并复核）' : '（快照写回后仍不一致）'
    }
  }
  steps.push({
    name: 'restore',
    ok: restored,
    detail: restored ? `配置逐字节等于安装前 sha256=${before.hash.slice(0, 16)}…${rewrite}` : `配置没能完全还原${rewrite}`,
  })

  const failed = steps.filter((s) => !s.ok && s.name !== 'call')
  const callOk = steps.some((s) => s.name === 'call' && s.ok)
  const status = failed.length ? 'failed' : callOk ? 'verified' : 'config-only'
  return { ...out, ok: status !== 'failed', status, steps }
}

/** 全部宿主跑一遍（只跑装了的那几台，其余直接标 not-installed） */
export function verifyAll(opts = {}) {
  return HOSTS.map((h) => verifyHost(h.id, opts))
}

function statusLabel(status) {
  return (
    {
      verified: '✅ 已认证（装→调→卸→还原 四步）',
      'config-only': '🟡 只验到配置层（宿主命令行不在本机，标「实验性」）',
      'not-installed': '⚪ 未安装（不伪造配置）',
      failed: '❌ 失败',
      'dry-run': '⚪ 试运行',
    }[status] || status
  )
}

/** 把一轮结果写成证据文件（原文含每步 raw 输出） */
export function recordHostsEvidence(results, version, outFile) {
  const lines = []
  lines.push(`# 宿主认证矩阵 · agentdeck-super ${version}`)
  lines.push('')
  lines.push(`· 时间：${new Date().toISOString()}（本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`)
  lines.push(`· 机器：${process.platform}-${process.arch} / Node ${process.version}`)
  lines.push(`· 口径：每台都跑「装 → 让宿主自己确认 → 卸 → 配置逐字节还原」，跑不动的老实标注`)
  lines.push('')
  lines.push('| 宿主 | 层级 | 结论 | 依据 |')
  lines.push('| --- | --- | --- | --- |')
  for (const r of results) {
    const call = (r.steps || []).find((s) => s.name === 'call')
    const restore = (r.steps || []).find((s) => s.name === 'restore')
    const why = r.status === 'not-installed' ? '宿主未安装' : `${call ? (call.ok ? call.detail : call.detail) : '无调用步骤'}；${restore ? restore.detail : ''}`
    lines.push(`| ${r.label}（\`${r.id}\`） | ${r.tier} | ${statusLabel(r.status)} | ${String(why).replace(/\|/g, '/').slice(0, 300)} |`)
  }
  lines.push('')
  for (const r of results) {
    lines.push(`## ${r.label}（\`${r.id}\`）· ${statusLabel(r.status)}`)
    lines.push('')
    lines.push(`· 配置文件：${r.path || '（无）'}`)
    for (const s of r.steps || []) {
      lines.push(`  ${s.ok ? '✔' : '✖'} ${s.name}：${s.detail}`)
      if (s.raw) {
        lines.push('    ```')
        for (const line of String(s.raw).split(/\r?\n/)) lines.push(`    ${line}`)
        lines.push('    ```')
      }
    }
    lines.push('')
  }
  const target = outFile || join(REPO_ROOT, 'docs', 'evidence', `hosts-${version}.txt`)
  mkdirSync(resolve(target, '..'), { recursive: true })
  writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
  return target
}

export function summarize(results) {
  const count = (s) => results.filter((r) => r.status === s).length
  return {
    total: results.length,
    verified: count('verified'),
    configOnly: count('config-only'),
    notInstalled: count('not-installed'),
    dryRun: count('dry-run'),
    failed: count('failed'),
  }
}

export default { verifyHost, verifyAll, recordHostsEvidence, summarize }
