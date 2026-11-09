#!/usr/bin/env node
/**
 * tools/verify-acceptance.mjs —— 逐项验收总控（每一项都留独立证据）
 *
 * 和 verify-all.mjs 的区别：
 *   verify-all        按"模块"跑，一个脚本一份证据，红一个就整体退出
 *   verify-acceptance 按"用户能感知的功能"跑，逐项打分，输出一张**验收矩阵**，
 *                     并汇总成一份可交给人的报告（docs/evidence/acceptance-<版本>.txt）
 *
 * 为什么要它：发布前需要的不是"测试全绿"，而是"**每一项功能都有人验过、有据可查**"。
 * 所以这里每一项都写明：验的是什么、用哪条命令、结果、证据文件、以及边界（没做到的照写）。
 *
 * 用法：
 *   node tools/verify-acceptance.mjs                  # 全跑
 *   node tools/verify-acceptance.mjs --list           # 只看清单，不跑
 *   node tools/verify-acceptance.mjs --only=mcp,hosting
 *   node tools/verify-acceptance.mjs --no-browser     # 跳过需要图形界面的项
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PRESETS, resolveCommand } from '../lib/engine/cli.js';
import { parseEvidenceCounts } from './lib-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const argv = process.argv.slice(2);

function flagValue(name, fallback = '') {
  const eq = `${name}=`;
  const withEq = argv.find((a) => a.startsWith(eq));
  if (withEq) return withEq.slice(eq.length);
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const ONLY = (() => {
  const raw = flagValue('--only', '');
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();
const NO_BROWSER = argv.includes('--no-browser');

const version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const OUT = join(PKG, 'docs', 'evidence', `acceptance-${version}.txt`);

/**
 * Node 的 --test 不接受 shell glob。验证器以前直接把
 * "tests/*.test.mjs" 传进去，Windows 上会变成"找不到这个文件"，于是
 * 统计看起来像 0 条。这里只支持我们实际用的两种模式：
 *   tests/*.test.mjs
 *   tests/mandate*.test.mjs
 * 返回真实文件的绝对路径数组。
 */
function expandNodeTests(pattern) {
  const m = /^tests[\\/](.+)$/.exec(pattern);
  if (!m) throw new Error(`不认识的测试模式：${pattern}`);
  const glob = m[1];
  const re = new RegExp(`^${glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')}$`);
  return readdirSync(join(PKG, 'tests'))
    .filter((name) => name.endsWith('.test.mjs') && re.test(name))
    .sort()
    .map((name) => join(PKG, 'tests', name));
}

/**
 * 验收项。每一项 = 用户能感知的一个功能。
 *   id       标识（--only 用）
 *   feature  用户看到的功能名
 *   script   跑哪个脚本（相对仓库根）
 *   evidence 它会写哪份证据（可有多个）
 *   needs    额外前置条件；不满足就标「跳过」并写明原因，不算失败
 *   boundary 这一项**验不到**的东西（诚实边界）
 */
const ITEMS = [
  {
    id: 'tests',
    feature: '全量单元/集成测试',
    script: null,
    nodeTest: 'tests/*.test.mjs',
    evidence: [],
    boundary: '测得是模块行为；真机交互不在这一层',
  },
  {
    id: 'gate',
    feature: '回归门禁 + 红队越权用例',
    script: 'tools/verify-security.mjs',
    evidence: [`gate-${version}.txt`, `security-redteam-${version}.txt`],
    boundary: '红队用例是"我们想到的攻击"；不等于没有别的洞',
  },
  {
    id: 'mcp',
    feature: 'MCP 协议（别的 Agent 能接进来用）',
    script: 'tools/verify-mcp-plugin.mjs',
    evidence: [`mcp-plugin-${version}.txt`],
    boundary: '用真 JSON-RPC 走一遍协议；不替代各家宿主的 UI 集成',
  },
  {
    id: 'readonly',
    feature: '只读模式（借给别人用时不让他改东西）',
    // 用不依赖 dsh 的那份：核心承诺（协议层真拒 + 盘上无残留）本机就能验。
    // 要验"装了 dsh 的宿主里 UI 也置灰"，用 tools/verify-readonly.mjs（需要真宿主）。
    script: 'tools/verify-readonly-core.mjs',
    evidence: [`readonly-core-${version}.txt`],
    boundary: '验的是服务端拦截；宿主 UI 是否置灰需另跑 verify-readonly.mjs（要装 dsh）',
  },
  {
    id: 'mandate',
    feature: '分身执照（桌宠能自主到什么程度）',
    nodeTest: 'tests/mandate*.test.mjs',
    evidence: [],
    boundary: '验的是本地判定与闸门；跨机器的离线吊销做不到（无吊销中心）',
  },
  {
    id: 'hosting',
    feature: '托管层（发码换令牌 / 配额 / 用量）',
    nodeTest: 'tests/hosting.test.mjs',
    evidence: [],
    boundary: '验的是账与配额逻辑；真钱进账要商户号',
  },
  {
    id: 'relay-hosting',
    feature: '托管 API 挂进 relay（真 HTTP 真验签）',
    nodeTest: 'tests/relay-hosting.test.mjs',
    evidence: [],
    boundary: '起的是本地 HTTP；公网要另配 TLS',
  },
  {
    id: 'twomachines',
    feature: '两台电脑协作（解包/建房间/进房/双向消息/重启持久化/加密串门）',
    script: 'tools/verify-twomachines.mjs',
    evidence: [`twomachines-${version}.txt`],
    needs: { file: `agentdeck-super-${version}.tgz`, hint: '先跑 npm pack --pack-destination .' },
    boundary: '在一台机器上用两个独立目录/身份模拟；真机只改 relay 地址',
  },
  {
    id: 'crosshost',
    feature: '跨机走真实网络（两个独立进程 + relay 绑局域网地址）',
    script: 'tools/verify-crosshost.mjs',
    evidence: [`crosshost-${version}.txt`],
    boundary: '走真网卡（非 127.0.0.1），但仍是同一台物理机；公网 HTTPS 未验',
  },
  {
    id: 'visit',
    feature: '跨进程串门（两个真人两个身份）',
    script: 'tools/verify-visit.mjs',
    evidence: [`visit-2user-${version}.txt`],
    boundary: '点对点；没有中转时不自动同步（靠人传链接）',
  },
  {
    id: 'meeting',
    feature: '多 Agent 会议（发言→表决→决议落成任务）',
    script: 'tools/verify-meeting.mjs',
    evidence: [`meeting-3agent-${version}.txt`],
    boundary: '会议质量取决于宿主模型；治理闸门已验',
  },
  {
    id: 'passport',
    feature: 'Agent 通行证（离线能力卡）',
    script: 'tools/verify-passport.mjs',
    scriptArgs: ['--pkg', '.'],
    evidence: [`passport-${version}.txt`],
    boundary: '证明"卡没被改"，不证明"屏幕前是谁"',
  },
  {
    id: 'pay',
    feature: '支付链路（到账→解锁→幂等→退款）',
    script: 'tools/verify-pay.mjs',
    evidence: [`pay-${version}.txt`],
    boundary: '本地假网关；本机没有商户号，真钱这条没走通',
  },
  {
    id: 'recovery',
    feature: '故障恢复（断网/崩溃/升级/迁移）',
    script: 'tools/verify-recovery.mjs',
    scriptArgs: ['--pkg', '.'],
    evidence: [`recovery-${version}.txt`],
    boundary: '覆盖进程级故障；断电/磁盘坏道这类 OS 层故障没覆盖',
  },
  {
    id: 'pack',
    feature: '交付包体检（不许带凭据/内部资料）',
    script: 'tools/pack-clean.mjs',
    scriptArgs: ['--json'],
    evidence: [],
    boundary: '只检查；删不删由人决定',
  },
  {
    id: 'portable',
    feature: '可移植性（包拷到别的目录/电脑能直接起服务）',
    script: 'tools/verify-portable.mjs',
    needs: { file: `agentdeck-super-${version}.tgz`, hint: '先跑 npm pack --pack-destination .' },
    evidence: [],
    boundary: '验的是"照配置能起来"；没验跨操作系统（Windows→Linux 未测）',
  },
  {
    id: 'installed-host',
    feature: '装在真 DSH 宿主里跑（宿主集成）',
    script: 'tools/verify-mcp-http.mjs',
    evidence: [`mcp-http-${version}.txt`, `mcp-http-${version}.jsonl`],
    needsCommand: { cmd: 'dsh', hint: '需要本机装 DeepSeek Harness（dsh 命令）' },
    boundary: '真宿主 + Streamable HTTP；没实现 SSE 推流（规范允许直接 405）',
  },
  {
    id: 'm4',
    feature: 'M4 会议/自动化在真宿主里跑',
    script: 'tools/verify-m4.mjs',
    evidence: [`m4-${version}.txt`],
    needsCommand: { cmd: 'dsh', hint: '需要本机装 DeepSeek Harness（dsh 命令）' },
    boundary: '需要真宿主；本机没装就跳过，不算失败',
  },
];

if (argv.includes('--list')) {
  console.log(`验收清单（版本 ${version}）\n`);
  for (const it of ITEMS) {
    const how = it.script || `node --test ${it.nodeTest}`;
    console.log(`  ${it.id.padEnd(16)} ${it.feature}`);
    console.log(`  ${''.padEnd(16)} → ${how}`);
    if (it.boundary) console.log(`  ${''.padEnd(16)} ⚠ ${it.boundary}`);
  }
  process.exit(0);
}

const picked = ITEMS.filter((it) => (ONLY ? ONLY.has(it.id) : true));
const results = [];

/**
 * 命令是否存在。不能只查 PATH：桌面版 DeepSeek Harness 的 dsh.cmd
 * 装在 "Programs\DeepSeek Harness\resources\runtime\cli\bin" 下，
 * `where dsh` 查不到，但 nexi doctor 和实际宿主都能用。
 */
function hasCommand(cmd) {
  const extraPaths = cmd === 'dsh' && AGENT_PRESETS.dsh?.detect?.extraPaths
    ? AGENT_PRESETS.dsh.detect.extraPaths
    : [];
  return Boolean(resolveCommand(cmd, { extraPaths }));
}

console.log(`Nexi 灵犀 —— 逐项验收（版本 ${version}）`);
console.log(`仓库：${PKG}`);
console.log(`要验：${picked.length} 项\n`);

for (const it of picked) {
  // 前置条件检查：不满足就如实标「跳过」，不伪装成通过也不假装失败
  if (it.needs && !existsSync(join(PKG, it.needs.file))) {
    results.push({ ...it, status: 'skipped', detail: `缺 ${it.needs.file}（${it.needs.hint}）`, took: 0, files: [] });
    console.log(`⏭  ${it.id.padEnd(16)} ${it.feature}\n     跳过：缺 ${it.needs.file} —— ${it.needs.hint}\n`);
    continue;
  }
  if (it.needsCommand && !hasCommand(it.needsCommand.cmd)) {
    results.push({ ...it, status: 'skipped', detail: `缺命令 ${it.needsCommand.cmd}（${it.needsCommand.hint}）`, took: 0, files: [] });
    console.log(`⏭  ${it.id.padEnd(16)} ${it.feature}\n     跳过：本机没有 ${it.needsCommand.cmd} —— ${it.needsCommand.hint}\n`);
    continue;
  }

  const t0 = Date.now();
  let cmd;
  let args;
  if (it.nodeTest) {
    const nodeFiles = expandNodeTests(it.nodeTest);
    if (!nodeFiles.length) {
      results.push({ ...it, status: 'fail', detail: `没有匹配的测试文件：${it.nodeTest}`, took: 0, files: [] });
      console.log(`❌ ${it.id.padEnd(16)} ${it.feature}\n     失败：没有匹配的测试文件 ${it.nodeTest}\n`);
      continue;
    }
    cmd = process.execPath;
    args = ['--test', '--test-concurrency=1', ...nodeFiles];
  } else {
    cmd = process.execPath;
    args = [join(PKG, it.script), ...(it.scriptArgs || []), '--record'];
  }

  console.log(`▶ ${it.id.padEnd(16)} ${it.feature}`);
  const r = spawnSync(cmd, args, {
    cwd: PKG,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 900000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  const files = (it.evidence || []).map((f) => {
    const p = join(PKG, 'docs', 'evidence', f);
    return { name: f, exists: existsSync(p), size: existsSync(p) ? statSync(p).size : 0 };
  });
  // 全量测试失败时只留下 "pass 1047 / fail 1" 等于没留证据：
  // 具体是哪条断言坏了、原始 stderr 是什么，必须写进独立文件，下一轮才能定位。
  // 成功也写，方便把"这轮到底跑了什么"与验收矩阵一起归档。
  if (it.nodeTest) {
    const logName = it.id === 'tests' ? `tests-${version}.txt` : `node-${it.id}-${version}.txt`;
    const logPath = join(PKG, 'docs', 'evidence', logName);
    const header = [
      `# ${it.feature} · agentdeck-super ${version}`,
      `# 时间：${new Date().toISOString()}`,
      `# 命令：node --test --test-concurrency=1 <${it.nodeTest}>`,
      `# 退出码：${r.status === null ? 'null' : r.status}${r.error ? ` · ${r.error.message}` : ''}`,
      '',
    ].join('\n');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${header}${out}\n`, 'utf8');
    const size = statSync(logPath).size;
    files.push({ name: logName, exists: true, size });
    if (r.status !== 0) console.log(`    测试明细：${logPath}`);
  }

  // 计数来源有两个：脚本的 stdout（node --test 给 ℹ pass/fail），
  // 以及**证据文件本身**（很多验收脚本把自己的 ✅/❌ 写进 txt，stdout 只给摘要）。
  // 只读 stdout 会得到一堆 0，报告看起来像"什么都没验"——那是解析问题，不是真没验。
  const evidenceText = files
    .filter((f) => f.exists && /\.(txt|md|jsonl)$/i.test(f.name))
    .map((f) => {
      try {
        return readFileSync(join(PKG, 'docs', 'evidence', f.name), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  // stdout 和证据文件经常包含**同一份** ✅ 列表（脚本既打印又落盘）。
  // 两份拼起来会把 28 条断言数成 56 条 —— 这是报告统计 bug，不是多验了 28 项。
  // 有证据文本时以证据为准；只有没有证据文件时才读 stdout。
  const countText = evidenceText.trim() ? evidenceText : out;

  const passNum = Number((out.match(/^ℹ pass (\d+)/m) || [])[1] || 0);
  const failNum = Number((out.match(/^ℹ fail (\d+)/m) || [])[1] || 0);
  // 断言数优先认脚本自己的结论句，其次只数断言区里的独立列表行。
  // 不能裸数全文 ✅：M4 的表格和命令回显里也有 ✅，会把 17 条数成 22 个。
  const counts = parseEvidenceCounts(countText);
  const okCount = counts.pass;
  const badCount = counts.fail;
  const missingEvidence = files.filter((f) => !f.exists || f.size === 0);
  const evidenceHasFail = files.some((f) => {
    if (!f.exists) return false;
    try {
      return parseEvidenceCounts(readFileSync(join(PKG, 'docs', 'evidence', f.name), 'utf8')).fail > 0;
    } catch {
      return false;
    }
  });

  const ok = r.status === 0 && !missingEvidence.length && !evidenceHasFail;
  const detail = it.nodeTest
    ? `pass ${passNum} / fail ${failNum}`
    : (okCount || badCount)
      ? `✅ ${okCount} / ❌ ${badCount}`
      : `exit=${r.status}`;

  results.push({ ...it, status: ok ? 'pass' : 'fail', detail, took, files, exit: r.status });
  console.log(`    → ${ok ? '通过' : '失败'}　${detail}　${took}s${missingEvidence.length ? `　缺证据：${missingEvidence.map((m) => m.name).join(',')}` : ''}`);
  console.log('');
}

// ── 汇总报告 ────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const skipped = results.filter((r) => r.status === 'skipped').length;

const lines = [];
lines.push(`# Nexi 灵犀 · 真实验收矩阵（${version}）`);
lines.push(`# 生成时间：${new Date().toISOString()}`);
lines.push(`# 仓库：${PKG}`);
lines.push('');
lines.push(`合计 ${results.length} 项：通过 ${pass}，失败 ${fail}，跳过 ${skipped}`);
lines.push('');
lines.push('| 功能 | 结果 | 明细 | 耗时 | 证据 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const r of results) {
  const mark = r.status === 'pass' ? '✅ 通过' : r.status === 'fail' ? '❌ 失败' : '⏭ 跳过';
  const ev = r.files.length
    ? r.files.map((f) => `${f.name}${f.exists ? `(${f.size}B)` : ' ❌缺失'}`).join(' + ')
    : '—';
  lines.push(`| ${r.feature} | ${mark} | ${r.detail || '—'} | ${r.took}s | ${ev} |`);
}
lines.push('');
lines.push('## 每一项的诚实边界（没做到的照写）');
lines.push('');
for (const r of results) {
  lines.push(`- **${r.feature}**：${r.boundary || '（未声明）'}`);
}
lines.push('');
lines.push('## 怎么自己复跑');
lines.push('');
lines.push('```bash');
lines.push('node tools/verify-acceptance.mjs          # 全跑');
lines.push('node tools/verify-acceptance.mjs --list   # 先看清单');
lines.push('node tools/verify-acceptance.mjs --only=mcp,twomachines');
lines.push('```');
lines.push('');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');

console.log('='.repeat(72));
console.log(`汇总：${pass}/${results.length} 通过${fail ? `，${fail} 失败` : ''}${skipped ? `，${skipped} 跳过` : ''}`);
for (const r of results) {
  const mark = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭';
  console.log(`  ${mark} ${r.id.padEnd(16)} ${r.detail || r.status}  ${r.took}s`);
}
console.log('');
console.log(`验收矩阵已写入：${OUT}`);
process.exitCode = fail ? 1 : 0;
