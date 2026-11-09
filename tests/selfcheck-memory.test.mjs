/**
 * tests/selfcheck-memory.test.mjs —— 自检第 11 轮：内存与资源占用
 *
 * 前十轮验的是"行为对不对"，没验"资源会不会涨"。这一轮补上：
 *   ① 反复操作后堆内存不该持续上涨（无泄漏迹象）
 *   ② 大文件/大载荷不该一次性吃满内存
 *   ③ 异常路径（报错分支）不该留残余引用
 *
 * 说明：Node 的 GC 不保证立即回收，所以判定用**宽松阈值**——
 * 看的是"增长量级"而不是"精确字节"，避免误报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { remember, recall } from '../lib/twin/memory.js';
import { syncOnce, computeDelta } from '../lib/sync/delta.js';
import { verifyPassport } from '../lib/identity.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');
const MB = 1024 * 1024;

/** 取当前堆占用（MB）。 */
function heapMB() {
  return process.memoryUsage().heapUsed / MB;
}

/** 尽量触发 GC（没开 --expose-gc 时就是空操作，不影响断言）。 */
function tryGc() {
  if (typeof globalThis.gc === 'function') {
    try { globalThis.gc(); } catch { /* 忽略 */ }
  }
}

test('自检 11：反复调用工具 2000 次，堆内存增长可控', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mem-tools-'));
  const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
  try {
    // 预热，避免把初始化开销算进来
    for (let i = 0; i < 100; i += 1) {
      await hub.tools.get('deck_license').execute({ action: 'status' }, { hub: true });
    }
    tryGc();
    const before = heapMB();

    for (let i = 0; i < 2000; i += 1) {
      const tool = ['deck_license', 'deck_team', 'deck_meeting', 'deck_automation', 'deck_policy'][i % 5];
      await hub.tools.get(tool).execute({ action: 'status' }, { hub: true });
    }
    tryGc();
    const after = heapMB();
    const growth = after - before;

    assert.ok(
      growth < 80,
      `2000 次调用后堆增长 ${growth.toFixed(1)}MB（超阈值 80MB）—— 可能有泄漏`,
    );
  } finally {
    try { await hub.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 11：反复写读记忆 1000 次，内存不持续上涨', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mem-mem-'));
  try {
    for (let i = 0; i < 50; i += 1) {
      remember(root, { content: `预热 ${i}`, type: 'event' }, { now: () => 1800000000000 + i });
    }
    tryGc();
    const before = heapMB();

    for (let i = 0; i < 1000; i += 1) {
      remember(root, { content: `循环 ${i}`, type: 'event' }, { now: () => 1800001000000 + i });
      recall(root, { query: '循环' }, { now: () => 1800002000000 });
    }
    tryGc();
    const after = heapMB();
    // 写 1000 条进内存 + 落盘，增长是**预期内**的；这里只防"指数级泄漏"
    assert.ok(after - before < 150, `1000 次写读后增长 ${(after - before).toFixed(1)}MB（超阈值 150MB）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 11：大载荷（5MB 文本）不炸、处理完能释放', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mem-big-'));
  try {
    const big = 'x'.repeat(5 * MB);
    tryGc();
    const before = heapMB();

    // 超长内容应被截断（记忆模块有 MAX_TEXT），不该原样吞下
    const r = remember(root, { content: big, type: 'event' }, { now: () => 1800000000000 });
    assert.ok(r?.ok !== false, `超长内容不该写失败：${JSON.stringify(r)?.slice(0, 150)}`);

    // 落盘的内容应该被截断过
    const raw = JSON.parse(readFileSync(join(root, '.agentdeck', 'twin', 'memory.json'), 'utf8'));
    const stored = String(raw.items?.[0]?.text || '');
    assert.ok(stored.length < big.length, `应被截断：${stored.length} vs ${big.length}`);

    tryGc();
    const after = heapMB();
    assert.ok(after - before < 100, `处理 5MB 载荷后残留 ${(after - before).toFixed(1)}MB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 11：报错路径不泄漏（1000 次失败调用）', () => {
  tryGc();
  const before = heapMB();
  for (let i = 0; i < 1000; i += 1) {
    // 全是无效输入 → 全走错误分支
    verifyPassport('NEXP1.bad.bad');
    verifyPassport('');
    verifyPassport(null);
  }
  tryGc();
  const after = heapMB();
  assert.ok(after - before < 50, `1000 次失败验签后增长 ${(after - before).toFixed(1)}MB`);
});

test('自检 11：反复同步 100 轮，内存与游标都稳定', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mem-sync-'));
  try {
    for (let i = 0; i < 20; i += 1) remember(root, { content: `预热 ${i}`, type: 'event' }, { now: () => 1800000000000 + i });
    tryGc();
    const before = heapMB();

    for (let round = 0; round < 100; round += 1) {
      remember(root, { content: `同步轮 ${round}`, type: 'event' }, { now: () => 1800001000000 + round * 1000 });
      const r = syncOnce({ root });
      assert.equal(r.ok, true, `第 ${round} 轮失败：${r.reason}`);
    }
    tryGc();
    const after = heapMB();
    assert.ok(after - before < 120, `100 轮同步后增长 ${(after - before).toFixed(1)}MB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
