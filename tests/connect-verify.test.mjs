/**
 * tests/connect-verify.test.mjs —— 宿主认证（nexi verify-host）的回归
 *
 * 只用临时配置文件跑，绝不碰真实的 ~/.claude.json / ~/.codex/config.toml：
 *  - 装了但没法真调用的宿主 → config-only（老实标实验性，不吹成全兼容）
 *  - 装 → 卸 → 配置逐字节还原（多一个空白都算没还原）
 *  - 没装的宿主 → not-installed，且不创建任何文件
 *  - 证据文件真的写出来了
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verifyHost, verifyAll, recordHostsEvidence, summarize } from '../lib/connect/verify.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'nexi-verify-host-'))
}

test('装了但没命令行可问的宿主：四步走完，结论是 config-only，不是 verified', () => {
  const root = tempRoot()
  try {
    const file = join(root, 'mcp.json')
    writeFileSync(file, `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`, 'utf8')
    const before = readFileSync(file, 'utf8')

    const res = verifyHost('cursor', { path: file, stamp: 'test' })
    assert.equal(res.status, 'config-only', `实际 ${res.status}`)
    assert.equal(res.ok, true)

    const byName = Object.fromEntries(res.steps.map((s) => [s.name, s]))
    assert.equal(byName.detect.ok, true)
    assert.equal(byName.snapshot.ok, true)
    assert.equal(byName.baseline.ok, true, '干净起点')
    assert.equal(byName.install.ok, true, '真的写进去了')
    assert.equal(byName.call.ok, false, '没有命令行就不许算"调通"')
    assert.match(byName.call.detail, /验不了宿主自己认不认|no-probe-command/)
    assert.equal(byName.uninstall.ok, true)
    assert.equal(byName.restore.ok, true, '配置必须逐字节还原')

    const after = readFileSync(file, 'utf8')
    assert.equal(after, before, '收摊后配置要和开跑前一模一样')
    assert.ok(!/nexi/i.test(after), '不能留下 nexi 条目')
    assert.match(after, /other/, '别人的条目不能被碰掉')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('配置里本来就有 nexi（上一轮残留）：先清再装，收摊还回原样', () => {
  const root = tempRoot()
  try {
    const file = join(root, 'config.json')
    const original = {
      mcpServers: { nexi: { command: 'node', args: ['C:\\old\\nexi.mjs', 'mcp'] }, keepme: { command: 'y' } },
    }
    writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`, 'utf8')
    const before = readFileSync(file, 'utf8')

    const res = verifyHost('windsurf', { path: file, stamp: 'test' })
    const byName = Object.fromEntries(res.steps.map((s) => [s.name, s]))
    assert.equal(byName.baseline.ok, true)
    assert.match(byName.baseline.detail, /清掉上一轮残留/)
    assert.equal(byName.install.ok, true, '清完之后必须真的重新写进去')
    assert.equal(byName.restore.ok, true)
    assert.equal(readFileSync(file, 'utf8'), before, '原来那条要原封不动还回去')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('临时配置不存在：装不上就老实报，不创建文件', () => {
  const root = tempRoot()
  try {
    const file = join(root, 'nope.json')
    const res = verifyHost('cline', { path: file, stamp: 'test' })
    assert.equal(res.status, 'not-installed')
    assert.equal(res.ok, false)
    assert.equal(existsSync(file), false, '不许凭空造配置')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('不认识的宿主 id：直接拒绝并列出现有的', () => {
  const res = verifyHost('not-a-host')
  assert.equal(res.status, 'failed')
  assert.deepEqual(res.known.length, 8)
})

test('verifyAll 八台都报结论，没装的标 not-installed，汇总对得上', () => {
  const results = verifyAll({ dryRun: true })
  assert.equal(results.length, 8)
  for (const r of results) {
    assert.ok(['dry-run', 'not-installed'].includes(r.status), `${r.id} 实际 ${r.status}`)
  }
  const sum = summarize(results)
  assert.equal(sum.total, 8)
  assert.equal(sum.verified + sum.configOnly + sum.notInstalled + sum.dryRun + sum.failed, 8)
})

test('证据文件：跑得出来、写得进、原文带每步结论', () => {
  const root = tempRoot()
  try {
    const file = join(root, 'cfg.json')
    writeFileSync(file, '{}\n', 'utf8')
    const results = [verifyHost('continue', { path: file, stamp: 'test' })]
    const out = join(root, 'hosts-test.txt')
    const written = recordHostsEvidence(results, '9.9.9', out)
    assert.equal(written, out)
    const text = readFileSync(out, 'utf8')
    assert.match(text, /宿主认证矩阵 · agentdeck-super 9\.9\.9/)
    assert.match(text, /continue/)
    assert.match(text, /只验到配置层|未安装|已认证/)
    assert.match(text, /✔ install/)
    assert.match(text, /✔ restore/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
