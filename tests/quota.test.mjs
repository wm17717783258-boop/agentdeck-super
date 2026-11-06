/**
 * tests/quota.test.mjs —— 配额门控（lib/quota.js）的验收测试
 *
 * 重点覆盖：
 *   1. 四档限额表（免费/协作/工作室/企业）与任务单一致；
 *   2. 超限时给的是人话 + 升级建议，不是一句冷冰冰的 false；
 *   3. Infinity（企业版不限）经过 JSON 一圈后仍然是"不限"，不能被当成 0 拦死；
 *   4. 任何脏参数都不抛异常，一律降级放行（宁可放行，不挡付费用户）；
 *   5. 免费档「安装 → 记忆 → 串门 → 任务」四件事一件都不拦；rooms 是**群组房间总数**
 *      （方案定价：免费 3 / 协作 20 / 工作室 50 / 企业不限），跨机持久云房间另由
 *      license.TIERS.cloudRooms 守（免费 0 个）；
 *   6. remaining 计算正确；
 *   7. countUsed() 能按真实落盘位置数出 rooms/meetings/automations/twinEntries。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TIERS } from '../lib/license.js';

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

test('四档限额表与产品方案一致（房间/会议/自动化/席位必须和 license.TIERS 对得上）', () => {
  // 这四列是对外承诺（定价页、deck_license 都从 license.TIERS 读），所以不能自己另写一套数。
  // 口径来自产品方案定价章节：免费 3 房间 / 每月 5 场会 / 3 个自动化；协作 20 / 30 / 20；
  // 工作室 50 / 不限 / 100；企业 不限 / 不限 / 不限。
  assert.deepEqual(DEFAULT_LIMITS.free, { rooms: 3, meetings: 5, automations: 3, twinEntries: 200, seats: 3 });
  assert.deepEqual(DEFAULT_LIMITS.plus, { rooms: 20, meetings: 30, automations: 20, twinEntries: 2000, seats: 8 });
  assert.deepEqual(DEFAULT_LIMITS.studio, { rooms: 50, meetings: 999, automations: 100, twinEntries: 20000, seats: 30 });
  assert.deepEqual(DEFAULT_LIMITS.business, {
    rooms: 999,
    meetings: Infinity,
    automations: Infinity,
    twinEntries: Infinity,
    seats: 200,
  });

  // 真正的防漂移断言：拿 license.TIERS 走一遍 createQuota，四列必须和默认表逐个相等。
  // 只要有人只改一边（定价页改了、配额表没改，或者反过来），这条立刻红。
  const fromLicense = createQuota({ tiers: TIERS });
  for (const tier of ['free', 'plus', 'studio', 'business']) {
    for (const kind of ['rooms', 'meetings', 'automations', 'seats']) {
      assert.equal(
        fromLicense.limits[tier][kind],
        DEFAULT_LIMITS[tier][kind],
        `${tier}.${kind} 在 license.TIERS 和 quota.DEFAULT_LIMITS 里不一致`,
      );
    }
  }
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
  assert.equal(meeting.limit, 30);
  assert.equal(meeting.used, 5);
  assert.equal(meeting.remaining, 25);
  assert.equal(meeting.unlimited, false);
  assert.equal(meeting.degraded, false);

  const studioRoom = q.check('studio', 'rooms', 4);
  assert.equal(studioRoom.ok, true);
  assert.equal(studioRoom.limit, 50);
  assert.equal(studioRoom.remaining, 46);

  const memory = q.check('free', 'twinEntries', 199);
  assert.equal(memory.ok, true);
  assert.equal(memory.remaining, 1);
});

test('超限拦截给中文档位 + 数量 + 升级建议', () => {
  const q = createQuota();
  const meeting = q.check('free', 'meetings', 5);
  assert.equal(meeting.ok, false);
  assert.equal(meeting.used, 5);
  assert.equal(meeting.remaining, 0);
  assert.equal(meeting.upgradeTo, 'plus');
  assert.match(meeting.reason, /免费版/);
  assert.match(meeting.reason, /最多 5 场会议/);
  assert.match(meeting.reason, /已用 5 场/);
  assert.match(meeting.reason, /协作版/);
  assert.match(meeting.reason, /30 场会议/);

  const automation = q.check('studio', 'automations', 100);
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

test('免费档 3 个群组房间：第 4 个才拦；跨机持久云房间是另一层门控', () => {
  const q = createQuota();
  // 前 3 个照常建（方案定价：免费版 3 个群组房间），不能一上来就拦
  assert.equal(q.check('free', 'rooms', 0).ok, true);
  assert.equal(q.check('free', 'rooms', 2).ok, true);

  const room = q.check('free', 'rooms', 3);
  assert.equal(room.ok, false);
  assert.equal(room.limit, 3);
  assert.equal(room.upgradeTo, 'plus');
  assert.match(room.reason, /免费版/);
  assert.match(room.reason, /最多 3 个群组房间/);
  assert.match(room.reason, /协作版/);
  assert.match(room.reason, /20 个群组房间/);

  // 跨机持久云房间由 license 档位单独守（不在 quota.rooms 里）：免费 0 个，协作 20 个。
  // 两层门控各管一件事：quota 管总量，entitlements.cloudRooms 管能不能走中继。
  assert.equal(TIERS.free.cloudRooms, 0);
  assert.equal(TIERS.plus.cloudRooms, 20);
  assert.equal(TIERS.free.localRooms, 3);
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

  // 本地群组房间也计入 rooms（方案：免费 3 个）——不是"随便建"，但也绝不是 0：
  // 前 3 个必须能建，否则免费版连群组都开不起来；第 4 个才提示升级。
  const localRoom = q.check('free', 'localRooms', 2);
  assert.equal(localRoom.ok, true);
  assert.equal(localRoom.kind, 'rooms'); // 别名归一：localRooms / cloudRooms 都是 rooms
  assert.equal(q.check('free', 'localRooms', 3).ok, false);
  assert.equal(q.check('free', 'cloudRooms', 2).ok, true);
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
  assert.equal(q2.limits.business.rooms, 999);
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
  assert.equal(fallback.limits.free.meetings, 5);
  assert.equal(fallback.limits.business.rooms, 999);
});

/* ────────────────────────── 6. 覆盖表 / 批量检查 / 小工具 ────────────────────────── */

test('createQuota({tiers}) 只覆盖给了的字段，并兼容 license 字段名', () => {
  const q = createQuota({ tiers: { free: { meetings: 9 }, plus: { cloudRooms: 2 } } });
  assert.equal(q.limits.free.meetings, 9);
  assert.equal(q.limits.plus.rooms, 2); // cloudRooms 别名
  assert.equal(q.limits.free.rooms, 3); // 没覆盖的沿用默认
  assert.equal(q.limits.free.automations, 3);

  assert.equal(q.check('free', 'meetings', 8).ok, true);
  assert.equal(q.check('free', 'meetings', 8).remaining, 1);
  assert.equal(q.check('free', 'meetings', 9).ok, false);
  assert.equal(q.check('plus', 'rooms', 1).ok, true);
  assert.equal(q.check('plus', 'rooms', 2).ok, false);
});

test('limitOf / upgradeOf / checkMany 行为稳定', () => {
  const q = createQuota();
  assert.equal(q.limitOf('free', 'meetings'), 5);
  assert.equal(q.limitOf('business', 'meetings'), Infinity);
  assert.equal(q.limitOf('nope', 'meetings'), Infinity); // 认不出=不限
  assert.equal(q.upgradeOf('free'), 'plus');
  assert.equal(q.upgradeOf('studio'), 'business');
  assert.equal(q.upgradeOf('business'), null);

  const batch = q.checkMany('free', { meetings: 5, twinEntries: 200, install: 0, garbage: 1 });
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

    // 用真实统计喂 check：这台机器已经建了 2 个房间，免费档 3 个还剩 1 个位，
    // 再建第 3 个（下标 3，即第 4 个）就该提示升级。
    const q = createQuota();
    assert.equal(q.check('free', 'rooms', used.counts.rooms).ok, true);
    assert.equal(q.check('free', 'rooms', used.counts.rooms).remaining, 1);
    assert.equal(q.check('free', 'rooms', 3).ok, false);

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
