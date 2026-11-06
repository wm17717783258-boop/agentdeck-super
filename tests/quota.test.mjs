/**
 * tests/quota.test.mjs —— 配额门控（lib/quota.js）的验收测试
 *
 * 重点覆盖：
 *   1. 四档限额表（免费/协作/工作室/企业）与任务单一致；
 *   2. 超限时给的是人话 + 升级建议，不是一句冷冰冰的 false；
 *   3. Infinity（企业版不限）经过 JSON 一圈后仍然是"不限"，不能被当成 0 拦死；
 *   4. 任何脏参数都不抛异常，一律降级放行（宁可放行，不挡付费用户）；
 *   5. 免费档「安装 → 记忆 → 串门 → 任务」四件事一件都不拦（rooms=0 只管跨机云房间）；
 *   6. remaining 计算正确；
 *   7. countUsed() 能按真实落盘位置数出 rooms/meetings/automations/twinEntries。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_LIMITS,
  check,
  checkMany,
  countUsed,
  createQuota,
  limitOf,
  normalizeLimit,
  normalizeTier,
  serializeCheck,
  upgradeOf,
  LIMITS,
} from '../lib/quota.js';

/** 建一个临时工作区，按相对路径写文件（值是对象就 JSON 序列化）。 */
function makeRoot(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-quota-'));
  for (const [rel, value] of Object.entries(files)) {
    const file = join(root, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

function cleanup(...roots) {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

/* ────────────────────────── 1. 四档限额表 ────────────────────────── */

test('四档限额表与任务单一致（云房间/席位必须和 license.TIERS 对得上）', () => {
  // 这两列是对外承诺（定价页、deck_license 都从 license.TIERS 读），所以不能自己另写一套数。
  assert.deepEqual(DEFAULT_LIMITS.free, { rooms: 0, meetings: 3, automations: 3, twinEntries: 200, seats: 3 });
  assert.deepEqual(DEFAULT_LIMITS.plus, { rooms: 1, meetings: 20, automations: 20, twinEntries: 2000, seats: 8 });
  assert.deepEqual(DEFAULT_LIMITS.studio, { rooms: 5, meetings: 200, automations: 200, twinEntries: 20000, seats: 30 });
  assert.deepEqual(DEFAULT_LIMITS.business, {
    rooms: 50,
    meetings: Infinity,
    automations: Infinity,
    twinEntries: Infinity,
    seats: 200,
  });
  // 别名导出与默认表是同一份，且冻结（防止调用方改默认值）
  assert.equal(LIMITS, DEFAULT_LIMITS);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));
  assert.ok(Object.isFrozen(DEFAULT_LIMITS.free));
  assert.ok(Object.isFrozen(DEFAULT_LIMITS.business));
});

test('档位归一化：大小写容错，老授权 pro 是 plus 的别名', () => {
  assert.equal(normalizeTier('free'), 'free');
  assert.equal(normalizeTier(' PLUS '), 'plus');
  assert.equal(normalizeTier('pro'), 'plus');
  assert.equal(normalizeTier('business'), 'business');
  assert.equal(normalizeTier('nope'), null);
  assert.equal(normalizeTier(null), null);
  assert.equal(normalizeTier(42), null);
});

test('限额归一化：null 是 Infinity 的 JSON 形态，绝不能当 0', () => {
  assert.equal(normalizeLimit(Infinity), Infinity);
  assert.equal(normalizeLimit(null), Infinity);
  assert.equal(normalizeLimit(undefined, 7), 7);
  assert.equal(normalizeLimit('20'), 20);
  assert.equal(normalizeLimit(0), 0);
  assert.equal(normalizeLimit(-5, 3), 3); // 负数不猜成 0（0 会拦死）
  assert.equal(normalizeLimit('abc', 3), 3);
});

/* ────────────────────────── 2. 限额内 / 超限 / remaining ────────────────────────── */

test('限额内放行，remaining 计算正确', () => {
  const q = createQuota();
  const meeting = q.check('plus', 'meetings', 5);
  assert.equal(meeting.ok, true);
  assert.equal(meeting.limit, 20);
  assert.equal(meeting.used, 5);
  assert.equal(meeting.remaining, 15);
  assert.equal(meeting.unlimited, false);
  assert.equal(meeting.degraded, false);

  const studioRoom = q.check('studio', 'rooms', 4);
  assert.equal(studioRoom.ok, true);
  assert.equal(studioRoom.limit, 5);
  assert.equal(studioRoom.remaining, 1);

  const memory = q.check('free', 'twinEntries', 199);
  assert.equal(memory.ok, true);
  assert.equal(memory.remaining, 1);
});

test('超限拦截给中文档位 + 数量 + 升级建议', () => {
  const q = createQuota();
  const meeting = q.check('free', 'meetings', 3);
  assert.equal(meeting.ok, false);
  assert.equal(meeting.used, 3);
  assert.equal(meeting.remaining, 0);
  assert.equal(meeting.upgradeTo, 'plus');
  assert.match(meeting.reason, /免费版/);
  assert.match(meeting.reason, /最多 3 场会议/);
  assert.match(meeting.reason, /已用 3 场/);
  assert.match(meeting.reason, /协作版/);
  assert.match(meeting.reason, /20 场会议/);

  const automation = q.check('studio', 'automations', 200);
  assert.equal(automation.ok, false);
  assert.equal(automation.upgradeTo, 'business');
  assert.match(automation.reason, /工作室版/);
  assert.match(automation.reason, /企业版/);
  assert.match(automation.reason, /不再限制/);

  const seats = q.check('business', 'seats', 200);
  assert.equal(seats.ok, false);
  assert.equal(seats.upgradeTo, undefined);
  assert.match(seats.reason, /企业版/);
  assert.match(seats.reason, /最高档/);
});

test('免费档 rooms=0 只拦跨机云房间，并说明本地不受影响', () => {
  const q = createQuota();
  const room = q.check('free', 'rooms', 0);
  assert.equal(room.ok, false);
  assert.equal(room.limit, 0);
  assert.equal(room.upgradeTo, 'plus');
  assert.match(room.reason, /不含云房间/);
  assert.match(room.reason, /本地房间/);
  assert.match(room.reason, /跨机/);
});

/* ────────────────────────── 3. 免费档四件核心事不拦 ────────────────────────── */

test('免费档「安装 → 记忆 → 串门 → 任务」四件事一件都不拦', () => {
  const q = createQuota();

  // 安装：不计配额
  const install = q.check('free', 'install', 0);
  assert.equal(install.ok, true);
  assert.equal(install.unmetered, true);
  assert.equal(install.limit, Infinity);

  // 记忆：免费档 200 条，从 0 开始记不会被拦
  const memory = q.check('free', 'twinEntries', 0);
  assert.equal(memory.ok, true);
  assert.equal(memory.limit, 200);
  assert.equal(memory.remaining, 200);

  // 串门：不计配额
  const visit = q.check('free', 'visits', 999);
  assert.equal(visit.ok, true);
  assert.equal(visit.unmetered, true);

  // 任务板：不计配额
  const task = q.check('free', 'tasks', 5000);
  assert.equal(task.ok, true);
  assert.equal(task.unmetered, true);

  // 本地房间也属于"免费版照常"，别被 rooms=0 连坐
  const localRoom = q.check('free', 'localRooms', 10);
  assert.equal(localRoom.ok, true);
  assert.equal(localRoom.unmetered, true);

  // 但跨机云房间确实要付费（rooms=0 的真实含义）
  assert.equal(q.check('free', 'rooms', 0).ok, false);
});

/* ────────────────────────── 4. Infinity / JSON 往返 ────────────────────────── */

test('企业版不限：Infinity 不经过 JSON 也不会被当成 0', () => {
  const q = createQuota();
  const business = q.check('business', 'meetings', 1_000_000);
  assert.equal(business.ok, true);
  assert.equal(business.unlimited, true);
  assert.equal(business.limit, Infinity);
  assert.equal(business.remaining, Infinity);

  // 限额表 JSON 往返后 Infinity → null，再建 quota 必须仍是"不限"
  const roundTripped = JSON.parse(JSON.stringify(DEFAULT_LIMITS));
  assert.equal(roundTripped.business.meetings, null);
  const q2 = createQuota({ tiers: roundTripped });
  assert.equal(q2.limits.business.meetings, Infinity);
  assert.equal(q2.limits.business.rooms, 50);
  assert.equal(q2.check('business', 'meetings', 1_000_000).ok, true);
  assert.equal(q2.check('business', 'meetings', 1_000_000).unlimited, true);

  // 显式 null 也是"不限"，不是"0 条"
  const q3 = createQuota({ tiers: { free: { meetings: null } } });
  assert.equal(q3.limits.free.meetings, Infinity);
  assert.equal(q3.check('free', 'meetings', 999).ok, true);
});

test('check 结果可安全 JSON 化：limit=null 但 unlimited=true', () => {
  const q = createQuota();
  const serialized = serializeCheck(q.check('business', 'twinEntries', 10));
  assert.equal(serialized.limit, null);
  assert.equal(serialized.remaining, null);
  assert.equal(serialized.unlimited, true);
  assert.equal(serialized.ok, true);

  // JSON.stringify 自动走 toJSON，得到的对象不会被误读成 0
  const wire = JSON.parse(JSON.stringify(q.check('business', 'twinEntries', 10)));
  assert.equal(wire.limit, null);
  assert.equal(wire.unlimited, true);

  // 把线上下来的 limit:null 再传给 createQuota，仍然是不限
  const restored = createQuota({ tiers: { business: { twinEntries: wire.limit } } });
  assert.equal(restored.limits.business.twinEntries, Infinity);
  assert.equal(restored.check('business', 'twinEntries', 99_999).ok, true);

  // 脏输入也不许抛
  assert.doesNotThrow(() => serializeCheck(null));
  assert.equal(serializeCheck(null).unlimited, false);
});

/* ────────────────────────── 5. 非法输入：永不抛、一律放行 ────────────────────────── */

test('任何非法输入都不抛，返回降级放行（ok:true, degraded:true）', () => {
  const q = createQuota();
  const cases = [
    () => q.check(),
    () => q.check(null, null, null),
    () => q.check('nope', 'meetings', 1),
    () => q.check('free', 'nope', 1),
    () => q.check('free', 'meetings', 'abc'),
    () => q.check('free', 'meetings', -1),
    () => q.check('free', 'meetings', Number.NaN),
    () => q.check('free', 'meetings', Infinity),
    () => q.check('free', null, {}),
    () => q.check({ tier: 'free' }, 'meetings', 1),
    () => q.check('free', 'meetings', [1]),
    () => q.check('free', 'meetings', undefined),
    () => q.check('free', 'meetings', '  '),
  ];
  for (const run of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = run();
    });
    assert.equal(result.ok, true, '拿不准必须放行');
    assert.equal(result.degraded, true);
    assert.equal(result.unlimited, true);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }

  // 未知档位不能按免费档拦（否则老授权/脏数据会挡住付费用户）
  assert.equal(q.check('nope', 'meetings', 999).ok, true);
  // 未知类型也不能当 0 条拦
  assert.equal(q.check('free', 'whatever', 999).ok, true);
});

test('createQuota 对脏参数也不抛，回退默认表', () => {
  assert.doesNotThrow(() => createQuota(null));
  assert.doesNotThrow(() => createQuota('nope'));
  assert.doesNotThrow(() => createQuota({ tiers: 'nope' }));
  const fallback = createQuota({ tiers: 'nope' });
  assert.equal(fallback.limits.free.meetings, 3);
  assert.equal(fallback.limits.business.rooms, 50);
});

/* ────────────────────────── 6. 覆盖表 / 批量检查 / 小工具 ────────────────────────── */

test('createQuota({tiers}) 只覆盖给了的字段，并兼容 license 字段名', () => {
  const q = createQuota({ tiers: { free: { meetings: 5 }, plus: { cloudRooms: 2 } } });
  assert.equal(q.limits.free.meetings, 5);
  assert.equal(q.limits.plus.rooms, 2); // cloudRooms 别名
  assert.equal(q.limits.free.rooms, 0); // 没覆盖的沿用默认
  assert.equal(q.limits.free.automations, 3);

  assert.equal(q.check('free', 'meetings', 4).ok, true);
  assert.equal(q.check('free', 'meetings', 4).remaining, 1);
  assert.equal(q.check('free', 'meetings', 5).ok, false);
  assert.equal(q.check('plus', 'rooms', 1).ok, true);
  assert.equal(q.check('plus', 'rooms', 2).ok, false);
});

test('limitOf / upgradeOf / checkMany 行为稳定', () => {
  const q = createQuota();
  assert.equal(q.limitOf('free', 'meetings'), 3);
  assert.equal(q.limitOf('business', 'meetings'), Infinity);
  assert.equal(q.limitOf('nope', 'meetings'), Infinity); // 认不出=不限
  assert.equal(q.upgradeOf('free'), 'plus');
  assert.equal(q.upgradeOf('studio'), 'business');
  assert.equal(q.upgradeOf('business'), null);

  const batch = q.checkMany('free', { meetings: 3, twinEntries: 200, install: 0, garbage: 1 });
  assert.equal(Object.keys(batch).length, 4);
  assert.equal(batch.meetings.ok, false);
  assert.equal(batch.twinEntries.ok, false);
  assert.equal(batch.install.ok, true);
  assert.equal(batch.install.unmetered, true);
  assert.equal(batch.garbage.ok, true);
  assert.equal(batch.garbage.degraded, true);

  assert.doesNotThrow(() => q.checkMany('free', null));
  assert.deepEqual(q.checkMany('free', null), {});
  assert.deepEqual(q.checkMany('free', 'nope'), {});
});

test('默认导出的 check / limitOf / upgradeOf 与工厂一致', () => {
  assert.equal(check('free', 'meetings', 2).ok, true);
  assert.equal(limitOf('plus', 'twinEntries'), 2000);
  assert.equal(upgradeOf('free'), 'plus');
  assert.equal(checkMany('free', { install: 1 }).install.ok, true);
});

/* ────────────────────────── 7. countUsed：真实落盘统计 ────────────────────────── */

test('countUsed 按房间/会议/自动化/记忆的真实落盘位置统计', () => {
  const rootA = makeRoot({
    '.agentdeck/rooms/room_a.json': { roomId: 'room_a', peers: [] },
    '.agentdeck/rooms/room_b.json': { roomId: 'room_b', peers: [] },
    '.agentdeck/rooms/chat.log': '不是房间记录',
    '.agentdeck/meetings/m1/meta.json': { id: 'm1' },
    '.agentdeck/meetings/m2/meta.json': { id: 'm2' },
    '.agentdeck/automation/state.json': { jobs: [{ id: 'job_1' }, { id: 'job_2' }] },
    '.agentdeck/twin/memory.json': { items: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] },
  });
  const rootB = makeRoot({
    // 同一个房间在两个工作区各有一份会话记录：按 roomId 去重，只算一个
    '.agentdeck/rooms/room_a.json': { roomId: 'room_a' },
    '.agentdeck/automation/state.json': { jobs: [{ id: 'job_3' }] },
    '.agentdeck/twin/memory.json': { items: [{ id: 't4' }, { id: 't5' }] },
  });

  try {
    const used = countUsed({ roots: [rootA, rootB] });
    assert.equal(used.ok, true);
    assert.equal(used.degraded, false);
    assert.deepEqual(used.warnings, []);
    assert.equal(used.counts.rooms, 2);
    assert.equal(used.counts.meetings, 2);
    assert.equal(used.counts.automations, 3);
    assert.equal(used.counts.twinEntries, 5);
    assert.equal(used.total, 12);
    assert.equal(used.roots.length, 2);
    assert.equal(used.sources.rooms.length, 2);

    // 用真实统计喂 check：PLUS 只含 1 个云房间，这台机器已经用了 2 个 → 该拦
    const q = createQuota();
    assert.equal(q.check('plus', 'rooms', used.counts.rooms).ok, false);
    assert.equal(q.check('plus', 'rooms', 0).ok, true);

    // string 形式也支持
    const single = countUsed({ roots: rootA });
    assert.equal(single.counts.rooms, 2);
    assert.equal(single.counts.meetings, 2);
    assert.equal(single.counts.automations, 2);
    assert.equal(single.counts.twinEntries, 3);
    assert.equal(single.total, 9);

    // 对象形式（workspace/global）也支持
    const rootC = makeRoot({
      '.agentdeck/twin/memory.json': { items: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }, { id: 'g4' }] },
    });
    try {
      const both = countUsed({ roots: { workspace: rootA, global: rootC } });
      assert.equal(both.counts.twinEntries, 7); // 3 + 4
      assert.equal(both.counts.rooms, 2);
    } finally {
      cleanup(rootC);
    }

    // 重复传同一个根目录只算一次
    const dup = countUsed({ roots: [rootA, rootA] });
    assert.equal(dup.total, 9);
  } finally {
    cleanup(rootA, rootB);
  }
});

test('countUsed 对缺失目录/坏文件/畸形状态一律不抛（少算=放行）', () => {
  const missing = join(tmpdir(), 'adsk-quota-definitely-not-exists');
  const absent = countUsed({ roots: missing });
  assert.equal(absent.ok, true);
  assert.equal(absent.degraded, false); // 目录本来就不存在，不算异常
  assert.equal(absent.counts.rooms, 0);
  assert.equal(absent.counts.meetings, 0);
  assert.equal(absent.counts.automations, 0);
  assert.equal(absent.counts.twinEntries, 0);

  // 没有 roots：按 0 条算并留 warning，仍然 ok
  const empty = countUsed();
  assert.equal(empty.ok, true);
  assert.equal(empty.degraded, true);
  assert.equal(empty.total, 0);
  assert.ok(empty.warnings.length >= 1);

  const broken = makeRoot({
    '.agentdeck/rooms/bad.json': '{不是合法 JSON',
    '.agentdeck/meetings/m9/meta.json': { id: 'm9' },
    '.agentdeck/automation/state.json': { jobs: '不是数组' },
    '.agentdeck/twin/memory.json': { items: {} },
  });
  try {
    let counted;
    assert.doesNotThrow(() => {
      counted = countUsed({ roots: broken });
    });
    assert.equal(counted.ok, true);
    assert.equal(counted.degraded, true);
    assert.equal(counted.counts.rooms, 0); // 坏文件跳过，不瞎猜
    assert.equal(counted.counts.meetings, 1);
    assert.equal(counted.counts.automations, 0);
    assert.equal(counted.counts.twinEntries, 0);
    assert.ok(counted.warnings.length >= 3);

    // 坏目录和好目录混着传：好的照常数，坏的不影响
    const rootGood = makeRoot({
      '.agentdeck/meetings/m1/meta.json': { id: 'm1' },
      '.agentdeck/meetings/m2/meta.json': { id: 'm2' },
    });
    try {
      const mixed = countUsed({ roots: [broken, rootGood] });
      assert.equal(mixed.counts.meetings, 3);
      assert.equal(mixed.ok, true);
    } finally {
      cleanup(rootGood);
    }
  } finally {
    cleanup(broken);
  }
});
