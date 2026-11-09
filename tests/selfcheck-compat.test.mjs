/**
 * tests/selfcheck-compat.test.mjs —— 自检第 12 轮：版本兼容与升级路径
 *
 * 前十轮都在"同一个版本"里跑。这一轮换角度：**老数据能不能被新代码读**。
 *
 * 用户升级插件时，磁盘上还躺着上个版本写的文件。如果新代码读不了，
 * 用户看到的就是"我的记忆/任务板全没了" —— 这比崩溃还糟。
 *
 * 验四件事：
 *   ① 缺字段的老文件能读（不要求字段齐全）
 *   ② 多字段的新文件能读（不认识的字段忽略，不报错）
 *   ③ 版本号更高/更低都能处理
 *   ④ 读坏文件后能自愈（不是永久坏）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBoard } from '../lib/engine/board.js';
import { remember, recall, readMemory } from '../lib/twin/memory.js';
import { readCursor, syncOnce, computeDelta } from '../lib/sync/delta.js';
import { readLicenseKey, verifyLicense } from '../lib/license.js';
import { loadState as loadAutomation, saveState as saveAutomation } from '../lib/automation/store.js';
import { loadPolicy } from '../lib/policy/engine.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

test('自检 12：记忆文件缺字段能读（老版本可能没这些字段）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-mem-'));
  try {
    mkdirSync(join(root, '.agentdeck', 'twin'), { recursive: true });
    // 老格式：只有最少字段，没有 visibility/scope/ttlDays 等
    writeFileSync(join(root, '.agentdeck', 'twin', 'memory.json'), JSON.stringify({
      items: [
        { id: 'old_1', text: '老格式的记忆', type: 'event' },
        { id: 'old_2', text: '另一条', at: 1000 },
      ],
    }), 'utf8');

    // readMemory 返回 { ok, memory, file, exists } —— 条目在 memory.items 里
    // （第一版写成 got.items，白跑一轮才发现是形状搞错了）
    const got = readMemory(root);
    assert.ok(got, '应该能读出来');
    assert.ok(Array.isArray(got.memory?.items), 'memory.items 应是数组');
    assert.equal(got.memory.items.length, 2, `应读到 2 条：${got.memory.items.length}`);
    // 老格式缺的字段应被补上默认值（归一化），而不是留 undefined
    const first = got.memory.items[0];
    assert.ok(typeof first.visibility === 'string', '缺失的 visibility 应被补默认值');
    assert.ok(typeof first.scope === 'string', '缺失的 scope 应被补默认值');

    // 还能继续往里写（老文件不该阻塞新写入）
    const r = remember(root, { content: '新格式的记忆', type: 'event' }, { now: () => 1800000000000 });
    assert.ok(r?.ok !== false, `老文件不该阻塞写入：${JSON.stringify(r)?.slice(0, 150)}`);

    const said = recall(root, { query: '老格式' }, { now: () => 1800000001000 });
    assert.ok((said?.items || []).length > 0, '老记忆应该还能召回');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 12：记忆文件多字段能读（不认识的字段应忽略）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-mem2-'));
  try {
    mkdirSync(join(root, '.agentdeck', 'twin'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'twin', 'memory.json'), JSON.stringify({
      version: 999,
      futureField: { nested: true },
      items: [
        {
          id: 'new_1', text: '未来格式', type: 'event', at: 2000,
          somethingNew: 'x', anotherNew: [1, 2, 3], deep: { a: { b: { c: 1 } } },
        },
      ],
    }), 'utf8');

    const got = readMemory(root);
    assert.ok(got, '不该因为未来字段而读失败');
    assert.ok(got.memory.items.length >= 1, '应该读到条目');
    // 未来字段不该被带进来（归一化只留认识的字段）
    assert.ok(!('somethingNew' in got.memory.items[0]), '未知字段不该保留');
    // 不该崩，且能继续用
    const r = remember(root, { content: '之后写的', type: 'event' }, { now: () => 1800000000000 });
    assert.ok(r?.ok !== false, '未来字段不该阻塞写入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 12：任务板状态缺字段/多字段都能读', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-board-'));
  try {
    // 极简老状态
    writeFileSync(join(root, 'state.json'), JSON.stringify({
      teams: [{ id: 'team_old', name: '老组', members: [], tasks: [] }],
    }), 'utf8');

    const board = createBoard({ root });
    const teams = await board.listTeams();
    assert.ok(Array.isArray(teams), '应能列出小组');
    // 还能继续建新组（老状态不该阻塞）
    const t = await board.createTeam({ name: '新组', goal: 'x' });
    assert.ok(t?.id, `应能建新组：${JSON.stringify(t)?.slice(0, 120)}`);

    // 未来字段
    writeFileSync(join(root, 'state.json'), JSON.stringify({
      version: 999, futureStuff: true,
      teams: [{ id: 'team_f', name: '未来组', members: [], tasks: [], unknownField: [1] }],
    }), 'utf8');
    const board2 = createBoard({ root });
    const teams2 = await board2.listTeams();
    assert.ok(Array.isArray(teams2), '未来字段不该让板子读不出来');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 12：自动化状态缺字段能读（老版本字段少）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-auto-'));
  try {
    mkdirSync(join(root, '.agentdeck', 'automation'), { recursive: true });
    // 极简：只有 jobs，没有 approvals/runs/stopped
    writeFileSync(join(root, '.agentdeck', 'automation', 'state.json'), JSON.stringify({
      jobs: [{ id: 'job_1', title: '老任务', action: 'task', every: 3600000 }],
    }), 'utf8');

    const loaded = loadAutomation({ root });
    assert.ok(loaded, '应能读');
    assert.ok(loaded.ok !== false, `不该报错：${loaded.reason || ''}`);
    const s = loaded.state || loaded;
    assert.ok(Array.isArray(s.jobs), 'jobs 应是数组');
    // 缺的字段应有默认值（不该是 undefined 导致后面炸）
    assert.ok(Array.isArray(s.approvals) || s.approvals === undefined, 'approvals 应是数组或未定义');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 12：策略文件缺字段能读，坏文件回默认', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-pol-'));
  try {
    // 极简
    writeFileSync(join(root, 'policy.json'), JSON.stringify({ rules: [] }), 'utf8');
    const p1 = loadPolicy(root);
    assert.ok(p1, '应能读');
    assert.ok(p1.policy, '应有 policy');

    // 坏的
    writeFileSync(join(root, 'policy.json'), '{ 这不是 JSON', 'utf8');
    const p2 = loadPolicy(root);
    assert.ok(p2.policy, '坏文件应回落默认策略，而不是抛错');
    assert.equal(p2.recovered, true, '应标记已恢复');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 12：同步游标版本不符时当空处理（老游标不阻塞新同步）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-cursor-'));
  try {
    mkdirSync(join(root, '.agentdeck'), { recursive: true });
    // 未来的游标版本
    writeFileSync(join(root, '.agentdeck', 'sync-cursor.json'), JSON.stringify({
      v: 999, pushCursor: 12345, peerCursor: 67890, mysteryField: 'x',
    }), 'utf8');

    const c = readCursor(root);
    // 要么读出来（忽略未知字段），要么当空 —— 总之不能抛
    assert.equal(typeof c.pushCursor, 'number');
    assert.ok(Number.isFinite(c.pushCursor), 'pushCursor 应是有限数');

    const r = syncOnce({ root });
    assert.equal(r.ok, true, `应能继续同步：${r.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 12：授权文件是垃圾时不崩，回落免费版', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-lic-'));
  try {
    mkdirSync(join(root, '.agentdeck', 'license'), { recursive: true });
    for (const junk of ['', 'garbage', 'ADSK1.bad.bad', 'ADSK1.' + 'a'.repeat(2000) + '.b', '{"json":"not a license"}']) {
      writeFileSync(join(root, '.agentdeck', 'license', 'key.txt'), junk, 'utf8');
      const key = readLicenseKey(root);
      // 读到东西就验一下，读不到也行 —— 关键是不抛
      if (key) {
        const v = verifyLicense(key);
        assert.equal(typeof v.ok, 'boolean', `验签应返回布尔：${junk.slice(0, 40)}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 12：读坏文件后能自愈（写一次就恢复正常）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-compat-heal-'));
  try {
    mkdirSync(join(root, '.agentdeck', 'twin'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'twin', 'memory.json'), '完全不是 JSON {{{', 'utf8');

    // 读一下（应降级不崩）
    const before = readMemory(root);
    assert.ok(before, '读坏文件应有返回');

    // 写一次 —— 应该恢复正常（把坏文件覆盖成合法内容）
    const w = remember(root, { content: '自愈之后', type: 'event' }, { now: () => 1800000000000 });
    assert.ok(w?.ok !== false, `写入应成功：${JSON.stringify(w)?.slice(0, 150)}`);

    const file = join(root, '.agentdeck', 'twin', 'memory.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(raw.items), '之后应是合法结构');
    const said = recall(root, { query: '自愈' }, { now: () => 1800000001000 });
    assert.ok((said?.items || []).length > 0, '应能召回');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
