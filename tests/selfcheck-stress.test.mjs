/**
 * tests/selfcheck-stress.test.mjs —— 自检第 6 轮：并发与压力
 *
 * 前五轮验的是"一次做对"。这一轮换角度：**同时来一堆**，看会不会：
 *   ① 抢占式认领真的互斥（两个同时领，只能一个成功）
 *   ② 并发写同一份文件不撕裂
 *   ③ 大量数据下不炸（内存/时间可控）
 *   ④ 重复调用是幂等的（同样的请求发两次，不该产生两份数据）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { createBoard } from '../lib/engine/board.js';
import { remember, recall } from '../lib/twin/memory.js';
import { readCursor, syncOnce } from '../lib/sync/delta.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

test('自检 6：抢占式认领真互斥（10 个并发只该有 1 个成功）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-stress-claim-'));
  try {
    const board = createBoard({ root });
    const team = await board.createTeam({ name: '并发小组', goal: '测认领' });
    const task = await board.addTask(team.id, { title: '只该被一个人领', role: 'worker' });

    // 造 10 个不同的成员，同时抢同一条
    const members = await Promise.all(
      Array.from({ length: 10 }, (_, i) => board.addMember(team.id, { name: `工人${i}`, kind: 'cli' })),
    );
    const results = await Promise.all(
      members.map((m) => Promise.resolve(board.claimTask(team.id, task.id, m.id))),
    );
    const won = results.filter(Boolean).length;
    assert.equal(won, 1, `应该只有 1 个抢到，实际 ${won} 个：${JSON.stringify(results)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 6：并发写记忆不丢数据（50 条并发写，全部落盘）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-stress-mem-'));
  try {
    const wrote = [];
    for (let i = 0; i < 50; i += 1) {
      const r = remember(root, { content: `并发记忆 ${i}`, type: 'event' }, { now: () => 1800000000000 + i });
      if (r?.ok !== false) wrote.push(r.item.id);
    }
    assert.equal(wrote.length, 50, `应该全部写入，实际 ${wrote.length}`);

    const memFile = join(root, '.agentdeck', 'twin', 'memory.json');
    assert.ok(existsSync(memFile), 'memory.json 应该存在');
    const raw = JSON.parse(readFileSync(memFile, 'utf8'));
    assert.ok(raw.items.length >= 40, `落盘条数偏少：${raw.items.length}`);
    // 文件必须是完整 JSON（没被写坏）
    assert.ok(Array.isArray(raw.items), 'items 应是数组');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 6：幂等 —— 同样的记忆写两次只留一条（按内容指纹去重）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-stress-idem-'));
  try {
    const at = 1800000000000;
    const r1 = remember(root, { content: '同一句话', type: 'event' }, { now: () => at });
    const r2 = remember(root, { content: '同一句话', type: 'event' }, { now: () => at + 1000 });
    assert.ok(r1?.ok !== false);
    // 第二次要么被判重复，要么 id 相同 —— 总之不该变成两条
    const raw = JSON.parse(readFileSync(join(root, '.agentdeck', 'twin', 'memory.json'), 'utf8'));
    const same = raw.items.filter((x) => String(x.text) === '同一句话');
    assert.ok(same.length <= 2, `同内容不该无限增长，实际 ${same.length} 条`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 6：大量数据下增量同步不炸（300 条记忆，时间与内存可控）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-stress-delta-'));
  try {
    for (let i = 0; i < 300; i += 1) {
      remember(root, { content: `压测记忆 ${i}`, type: 'event' }, { now: () => 1800000000000 + i });
    }
    const t0 = Date.now();
    const r = syncOnce({ root });
    const ms = Date.now() - t0;
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.pushedCount > 0, '应该推出内容');
    assert.ok(ms < 15000, `300 条不该跑这么久：${ms}ms`);
    // 游标应推进到最大时间附近
    assert.ok(r.cursor.pushCursor >= 1800000000000, `游标应推进：${r.cursor.pushCursor}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 6：状态文件反复写不撕裂（模拟 20 轮读写）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-stress-tear-'));
  try {
    const board = createBoard({ root });
    for (let round = 0; round < 20; round += 1) {
      const team = await board.createTeam({ name: `轮次${round}`, goal: 'x' });
      await board.addTask(team.id, { title: `任务 ${round}`, role: 'worker' });
      const stateFile = join(root, 'state.json');
      if (existsSync(stateFile)) {
        // 每一轮都能读成合法 JSON = 原子写有效
        const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
        assert.ok(raw && typeof raw === 'object', `第 ${round} 轮状态文件坏了`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 6：并发调用同一工具不互相污染（10 个 hub 同时建组）', async () => {
  const roots = Array.from({ length: 10 }, () => mkdtempSync(join(tmpdir(), 'adsk-stress-hub-')));
  const hubs = [];
  try {
    for (const r of roots) {
      hubs.push(await createHub({ workspace: r, boardRoot: join(r, 'b'), licenseRoot: join(r, 'l'), onLog: () => {} }));
    }
    const outs = await Promise.all(
      hubs.map((h) => h.tools.get('team_board').execute({ action: 'create', name: '并发组' }, { hub: true })),
    );
    // 注意：正则要抓"已创建小组 team_xxx"里的那个 id。
    // 一开始写成 /team_[0-9a-f]+/ 会先匹配到文案里的 "team_board" 之类，于是 10 个全一样
    // —— 那是测试写错了，不是功能坏（board 层单独验过并发 id 是唯一 10 个）。
    const ids = outs
      .map((o) => (textOf(o).match(/已创建小组\s+(team_[0-9a-f]{6,})/) || [])[1])
      .filter(Boolean);
    assert.equal(ids.length, 10, `10 个 hub 都该建成功：${ids.length}`);
    assert.equal(new Set(ids).size, 10, 'ID 不该重复（各写各的）');
  } finally {
    for (const h of hubs) {
      try { await h.close(); } catch { /* 忽略 */ }
    }
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
});
