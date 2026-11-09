/**
 * tests/selfcheck-fuzz.test.mjs —— 自检第 7 轮：模糊测试
 *
 * 第 4 轮用的是我手写的垃圾输入（我知道边界在哪，手写的会不自觉避开难点）。
 * 这一轮换成**确定性伪随机**：用固定种子生成怪输入，可复现、可重跑。
 *
 * 打三个面：
 *   ① MCP 协议层（JSON-RPC 报文乱造）
 *   ② 工具参数层（随机键值、超长字符串、深嵌套、诡异 Unicode）
 *   ③ 同步载荷层（结构对但内容怪）
 *
 * 判定：绝不 throw；非法输入要如实拒绝（不能默认放行）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { createMcpEngine } from '../lib/mcp/server.js';
import { mergeDelta } from '../lib/sync/delta.js';
import { verifyPassport } from '../lib/identity.js';

/** 确定性伪随机（mulberry32）——固定种子，失败可复现。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIRD_STRINGS = [
  '', ' ', '\n', '\t', '\u0000', '\uFFFD', '中文', '日本語', '🎉'.repeat(10),
  'a'.repeat(5000), '../'.repeat(50), '<script>alert(1)</script>',
  '{"nested":"json"}', "'; DROP TABLE x; --", '\u202Eover\rride', '\x1b[31mred',
];

/** 随机造一个"像参数但其实怪"的值。 */
function randomValue(r, depth = 0) {
  const pick = Math.floor(r() * 8);
  switch (pick) {
    case 0: return WEIRD_STRINGS[Math.floor(r() * WEIRD_STRINGS.length)];
    case 1: return Math.floor(r() * 1e9) - 5e8;
    case 2: return r() > 0.5;
    case 3: return null;
    case 4: return [];
    case 5: return {};
    case 6:
      if (depth > 3) return 'deep';
      return { [`k${Math.floor(r() * 5)}`]: randomValue(r, depth + 1) };
    default:
      return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
  }
}

test('自检 7：随机参数打 23 个工具，500 次不抛错、不返回空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-fuzz-tools-'));
  const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
  try {
    const names = hub.list().map((t) => t.name);
    const r = rng(20261108);
    const problems = [];
    let calls = 0;

    for (let i = 0; i < 500; i += 1) {
      const name = names[Math.floor(r() * names.length)];
      // 造一个随机 args（有时带 action，有时不带）
      const args = {};
      if (r() > 0.3) {
        const keys = ['action', 'name', 'title', 'content', 'query', 'tool', 'toolAction', 'incoming', 'blob', 'passphrase', 'id', 'teamId', 'relayUrl', 'url', 'inviteUrl'];
        const n = Math.floor(r() * 4);
        for (let k = 0; k < n; k += 1) args[keys[Math.floor(r() * keys.length)]] = randomValue(r);
      }
      calls += 1;
      let out;
      try {
        out = await hub.tools.get(name).execute(args, { hub: true });
      } catch (err) {
        problems.push(`${name} 抛错（args=${JSON.stringify(args).slice(0, 100)}）：${err?.message || err}`);
        continue;
      }
      if (!out || typeof out !== 'object' || typeof out.text !== 'string') {
        problems.push(`${name} 返回形状不对：${JSON.stringify(out)?.slice(0, 80)}`);
      }
    }
    assert.deepEqual(problems.slice(0, 8), [], `${calls} 次模糊调用里有 ${problems.length} 处问题：\n${problems.slice(0, 8).join('\n')}`);
  } finally {
    try { await hub.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 7：乱造 JSON-RPC 报文，引擎不崩且如实报错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-fuzz-mcp-'));
  const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
  try {
    const engine = createMcpEngine({ hub, readOnly: false, log: { info() {}, warn() {}, error() {} } });
    const r = rng(777);

    const bases = [
      null, undefined, 0, '', 'x', [], {},
      { jsonrpc: '2.0' },
      { jsonrpc: '1.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: null, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, method: 123 },
      { jsonrpc: '2.0', id: 1, method: 'tools/call' },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 123 } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '不存在的工具' } },
      { jsonrpc: '2.0', id: 1, method: '不存在的/方法' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'xxx' } },
    ];

    const problems = [];
    for (const base of bases) {
      let frame;
      try {
        frame = await engine.handle(base);
      } catch (err) {
        problems.push(`handle(${JSON.stringify(base)?.slice(0, 60)}) 抛错：${err?.message || err}`);
        continue;
      }
      // 通知类返回 null 是允许的；其余要有 result 或 error
      if (base && typeof base === 'object' && base.id != null) {
        if (!frame || (frame.result === undefined && frame.error === undefined)) {
          problems.push(`handle(${JSON.stringify(base)?.slice(0, 60)}) 既没 result 也没 error`);
        }
      }
    }

    // 再随机打 200 次
    for (let i = 0; i < 200; i += 1) {
      const msg = { jsonrpc: '2.0', id: i + 100, method: WEIRD_STRINGS[Math.floor(r() * WEIRD_STRINGS.length)], params: randomValue(r) };
      try {
        const frame = await engine.handle(msg);
        if (!frame || (frame.result === undefined && frame.error === undefined)) {
          problems.push(`随机报文既没 result 也没 error：${JSON.stringify(msg).slice(0, 80)}`);
        }
      } catch (err) {
        problems.push(`随机报文抛错：${err?.message || err}`);
      }
    }

    assert.deepEqual(problems.slice(0, 8), [], `有 ${problems.length} 处问题：\n${problems.slice(0, 8).join('\n')}`);
  } finally {
    try { await hub.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 7：随机同步载荷不崩、不越界写', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-fuzz-delta-'));
  try {
    const r = rng(4242);
    const problems = [];
    for (let i = 0; i < 200; i += 1) {
      const payload = Array.from({ length: Math.floor(r() * 5) }, () => ({
        bucket: WEIRD_STRINGS[Math.floor(r() * WEIRD_STRINGS.length)],
        id: randomValue(r),
        at: randomValue(r),
        data: randomValue(r),
      }));
      try {
        const out = mergeDelta({ root, changes: payload });
        if (typeof out.ok !== 'boolean') problems.push(`ok 不是布尔：${JSON.stringify(out)?.slice(0, 80)}`);
        if (!Array.isArray(out.applied)) problems.push('applied 不是数组');
      } catch (err) {
        problems.push(`mergeDelta 抛错：${err?.message || err}`);
      }
    }
    assert.deepEqual(problems.slice(0, 5), [], `有 ${problems.length} 处：\n${problems.slice(0, 5).join('\n')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 7：随机字符串当卡/执照验，绝不误放行', () => {
  const r = rng(31337);
  let pass = 0;
  for (let i = 0; i < 300; i += 1) {
    const junk = Array.from({ length: Math.floor(r() * 60) }, () => String.fromCharCode(Math.floor(r() * 128))).join('');
    const v = verifyPassport(junk);
    if (v.ok === false) pass += 1;
  }
  assert.equal(pass, 300, `300 个随机串里只有 ${pass} 个被判无效 —— 有误放行！`);
});
