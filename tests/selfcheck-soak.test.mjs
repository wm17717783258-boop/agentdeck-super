/**
 * tests/selfcheck-soak.test.mjs —— 自检第 8 轮：长时间稳定性（soak）
 *
 * 前七轮都是"跑一次看对不对"。这一轮换角度：**反复跑同一件事很多遍**，
 * 看有没有累积性问题：
 *   ① 反复建/关 hub 会不会漏释放（句柄/定时器泄漏）
 *   ② 反复写同一个文件会不会越来越慢（性能退化）
 *   ③ 反复同步会不会把游标推歪（状态漂移）
 *   ④ 反复出错后还能不能恢复正常（不是"错一次就废"）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { remember, recall } from '../lib/twin/memory.js';
import { readCursor, syncOnce, computeDelta } from '../lib/sync/delta.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

test('自检 8：反复起停 hub 20 轮，不泄漏、不越跑越慢', async () => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-soak-hub-'));
  try {
    const times = [];
    for (let i = 0; i < 20; i += 1) {
      const root = join(base, `r${i}`);
      const t0 = Date.now();
      const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
      const n = hub.list().length;
      await hub.close();
      times.push(Date.now() - t0);
      assert.ok(n >= 20, `第 ${i} 轮工具数不对：${n}`);
    }
    // 前后半段耗时不该差太多（差 5 倍以上说明有累积问题）
    const first = times.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const last = times.slice(-5).reduce((a, b) => a + b, 0) / 5;
    assert.ok(
      last < Math.max(first * 5, 3000),
      `越跑越慢：前 5 轮均 ${first.toFixed(0)}ms，后 5 轮均 ${last.toFixed(0)}ms`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('自检 8：反复写同一份记忆文件 300 次，文件不损坏且能读回', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-soak-write-'));
  try {
    for (let i = 0; i < 300; i += 1) {
      remember(root, { content: `soak ${i}`, type: 'event' }, { now: () => 1800000000000 + i * 1000 });
    }
    const file = join(root, '.agentdeck', 'twin', 'memory.json');
    assert.ok(existsSync(file), '文件应存在');
    // 关键：文件必须是**完整合法 JSON**（原子写生效）
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(raw.items), 'items 应是数组');
    assert.ok(raw.items.length > 0, '应该有内容');

    // 能召回
    const r = recall(root, { query: 'soak' }, { now: () => 1800001000000 });
    assert.ok((r?.items || []).length > 0, '应该召回得到');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 8：反复同步 50 轮，游标单调递增且不漂移', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-soak-cursor-'));
  try {
    let prev = 0;
    for (let round = 0; round < 50; round += 1) {
      // 每轮写一条，然后同步
      remember(root, { content: `轮次 ${round}`, type: 'event' }, { now: () => 1800000000000 + round * 10000 });
      const r = syncOnce({ root });
      assert.equal(r.ok, true, `第 ${round} 轮同步失败：${r.reason}`);
      assert.ok(
        r.cursor.pushCursor >= prev,
        `游标不该回退：第 ${round} 轮 ${r.cursor.pushCursor} < ${prev}`,
      );
      prev = r.cursor.pushCursor;
    }
    const c = readCursor(root);
    assert.ok(c.lastSyncAt, '应记下最后同步时间');
    assert.equal(c.v, 1, '版本字段应稳定');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 8：反复喂坏输入后仍能正常工作（不是错一次就废）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-soak-recover-'));
  try {
    // 先猛喂坏的
    for (let i = 0; i < 100; i += 1) {
      computeDelta({ root, since: 'bad' });
      syncOnce({ root, incoming: [null, {}, 'x'] });
    }
    // 然后正常工作
    const w = remember(root, { content: '坏输入之后写的一条', type: 'event' }, { now: () => 1800000000000 });
    assert.ok(w?.ok !== false, `坏输入之后应还能写：${JSON.stringify(w)}`);
    const r = recall(root, { query: '坏输入之后' }, { now: () => 1800000001000 });
    assert.ok((r?.items || []).length > 0, '应该召回得到');
    const s = syncOnce({ root });
    assert.equal(s.ok, true, `坏输入之后应还能同步：${s.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 8：反复开合房间客户端不泄漏（走真 relay 20 轮）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-soak-room-'));
  try {
    const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
    try {
      const times = [];
      for (let i = 0; i < 20; i += 1) {
        const t0 = Date.now();
        // info 会走一遍客户端 ensure/缓存逻辑
        const out = textOf(await hub.tools.get('deck_room').execute({ action: 'info' }, { hub: true }));
        times.push(Date.now() - t0);
        assert.equal(typeof out, 'string');
      }
      const first = times.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const last = times.slice(-5).reduce((a, b) => a + b, 0) / 5;
      assert.ok(last < Math.max(first * 5, 1000), `房间调用越跑越慢：${first.toFixed(0)}ms -> ${last.toFixed(0)}ms`);
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
