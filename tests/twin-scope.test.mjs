/**
 * 1.10.0 分身记忆的两个新维度：作用域（scope）＋ 有效期（TTL）。
 *
 * 为什么必须有：以前只有 tags 能糊"这条只在本项目里算数"，
 * 模型和用户都记不住，等于没有。TTL 则解决"临时信息永久占位"。
 *
 * 全部落 tmpdir，断言依据是盘上的 memory.json，不是返回值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  SCOPES,
  isExpired,
  memoryPath,
  normalizeMemory,
  normalizeScope,
  readMemory,
  recall,
  remember,
  stats,
  sweepExpired,
  ttlToExpiresAt,
} from '../lib/twin/memory.js';
import { createTwinTools } from '../lib/twin/index.js';

const T0 = Date.parse('2026-11-05T20:00:00+08:00');
const DAY = 24 * 60 * 60 * 1000;

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-scope-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const disk = (root) => JSON.parse(readFileSync(memoryPath(root), 'utf8'));

/* ── 1. 作用域规范化 ───────────────────────────────────────────────────── */

test('作用域：四档 + 常见别名，乱写的回落成 personal', () => {
  assert.deepEqual([...SCOPES], ['personal', 'project', 'team', 'global']);
  assert.equal(normalizeScope('project'), 'project');
  assert.equal(normalizeScope('PROJECT'), 'project');
  assert.equal(normalizeScope('repo'), 'project', 'repo 是 project 的别名');
  assert.equal(normalizeScope('workspace'), 'project');
  assert.equal(normalizeScope('group'), 'team');
  assert.equal(normalizeScope('room'), 'team');
  assert.equal(normalizeScope('me'), 'personal');
  assert.equal(normalizeScope('any'), 'global');
  assert.equal(normalizeScope('随便'), 'personal', '乱写的回落，不是崩');
  assert.equal(normalizeScope(undefined), 'personal');
});

test('老档案（没有 scope/ttl 字段）读出来就是"个人、永不过期"', () => {
  const old = {
    version: 1,
    items: [{ id: 'mem_old', type: 'event', text: '以前记的', visibility: 'private', at: T0, updatedAt: T0, hits: 0 }],
  };
  const norm = normalizeMemory(old);
  assert.equal(norm.items[0].scope, 'personal');
  assert.equal(norm.items[0].expiresAt, null);
  assert.equal(norm.items[0].ttlDays, null);
});

/* ── 2. TTL 计算与过期判定 ─────────────────────────────────────────────── */

test('TTL：天数换算成到期时间；0/负数/空 = 永不过期', () => {
  assert.equal(ttlToExpiresAt(null, T0), null);
  assert.equal(ttlToExpiresAt(0, T0), null);
  assert.equal(ttlToExpiresAt(-3, T0), null);
  assert.equal(ttlToExpiresAt('abc', T0), null);
  assert.equal(ttlToExpiresAt(1, T0), T0 + DAY);
  assert.equal(ttlToExpiresAt(7, T0), T0 + 7 * DAY);
  // 上限 3650 天，防止"记一万年"
  assert.equal(ttlToExpiresAt(99999, T0), T0 + 3650 * DAY);
});

test('过期判定：到点才算过期；钉住的不受过期影响', () => {
  assert.equal(isExpired({ expiresAt: T0 + DAY }, T0), false);
  assert.equal(isExpired({ expiresAt: T0 }, T0), true, '正好到点就该算过期');
  assert.equal(isExpired({ expiresAt: T0 - 1 }, T0), true);
  assert.equal(isExpired({ expiresAt: null }, T0), false);
  assert.equal(isExpired({ expiresAt: T0 - 1, pinned: true }, T0), false, '钉住的永不过期');
});

test('sweepExpired 只清该清的，数量如实报', () => {
  const memory = {
    items: [
      { id: 'a', expiresAt: T0 - 1 },
      { id: 'b', expiresAt: T0 + DAY },
      { id: 'c', expiresAt: null },
      { id: 'd', expiresAt: T0 - 1, pinned: true },
    ],
  };
  const out = sweepExpired(memory, T0);
  assert.equal(out.removed, 1);
  assert.deepEqual(out.memory.items.map((i) => i.id), ['b', 'c', 'd']);
});

/* ── 3. 写盘：scope/ttl 真落盘 ────────────────────────────────────────── */

test('remember 把 scope 和 ttlDays 写进盘，并算出 expiresAt', () => {
  const { root, done } = freshRoot('write');
  try {
    const w = remember(root, { text: '这个仓库用 pnpm', type: 'semantic', scope: 'project', ttlDays: 30 }, { now: () => T0 });
    assert.equal(w.ok, true);
    const item = disk(root).items[0];
    assert.equal(item.scope, 'project');
    assert.equal(item.ttlDays, 30);
    assert.equal(item.expiresAt, T0 + 30 * DAY);
  } finally {
    done();
  }
});

test('重记同一条：显式给 scope/ttl 就覆盖，没给就保持原样', () => {
  const { root, done } = freshRoot('merge');
  try {
    remember(root, { text: '部署要过 CI', scope: 'project' }, { now: () => T0 });
    // 没给 scope → 保持 project，不会被打回 personal
    remember(root, { text: '部署要过 CI' }, { now: () => T0 + 1000 });
    assert.equal(disk(root).items[0].scope, 'project');
    assert.equal(disk(root).items[0].expiresAt, null);

    // 给了 ttl → 覆盖续期
    remember(root, { text: '部署要过 CI', ttlDays: 3 }, { now: () => T0 + 2000 });
    assert.equal(disk(root).items[0].expiresAt, T0 + 2000 + 3 * DAY);
    assert.equal(disk(root).items.length, 1, '合并了就不该多一条');
  } finally {
    done();
  }
});

/* ── 4. 召回：过期的不带出、scope 能筛 ────────────────────────────────── */

test('召回默认不带过期条目；includeExpired 才带', () => {
  const { root, done } = freshRoot('recall-ttl');
  try {
    remember(root, { text: '临时验证码 1234', type: 'event', ttlDays: 1 }, { now: () => T0 });
    remember(root, { text: '长期偏好：用中文回复', type: 'preference' }, { now: () => T0 });

    const later = T0 + 2 * DAY;
    const fresh = recall(root, { any: true, limit: 10, track: false }, { now: () => later });
    assert.equal(fresh.items.length, 1, '过期的该被挡在外面');
    assert.equal(fresh.items[0].text, '长期偏好：用中文回复');
    assert.equal(fresh.expired, 1, '要如实报有 1 条过期');

    const all = recall(root, { any: true, limit: 10, track: false, includeExpired: true }, { now: () => later });
    assert.equal(all.items.length, 2);
  } finally {
    done();
  }
});

test('召回按 scope 过滤：global 永远算数，别的档只留自己', () => {
  const { root, done } = freshRoot('recall-scope');
  try {
    remember(root, { text: '甲项目用 vitest', scope: 'project', type: 'semantic' }, { now: () => T0 });
    remember(root, { text: '我讨厌周会', scope: 'personal', type: 'preference' }, { now: () => T0 });
    remember(root, { text: '全公司都过 CI 才发版', scope: 'global', type: 'semantic' }, { now: () => T0 });

    const proj = recall(root, { any: true, limit: 10, track: false, scope: 'project' }, { now: () => T0 });
    const texts = proj.items.map((i) => i.text).sort();
    assert.deepEqual(texts, ['global 那条', '甲项目用 vitest'].map((s) => (s === 'global 那条' ? '全公司都过 CI 才发版' : s)).sort());
    assert.equal(proj.scope, 'project');

    const personal = recall(root, { any: true, limit: 10, track: false, scope: 'personal' }, { now: () => T0 });
    assert.equal(personal.items.length, 2, 'personal + global');

    // 不给 scope：老行为，全都看得到
    const all = recall(root, { any: true, limit: 10, track: false }, { now: () => T0 });
    assert.equal(all.items.length, 3);
    assert.equal(all.scope, null);
  } finally {
    done();
  }
});

/* ── 5. 写盘时顺手清过期 ──────────────────────────────────────────────── */

test('过期条目在下次写入时被真清掉（盘上少一条）', () => {
  const { root, done } = freshRoot('sweep');
  try {
    remember(root, { text: '一小时后作废', ttlDays: 1 }, { now: () => T0 });
    remember(root, { text: '留着', type: 'preference' }, { now: () => T0 });
    assert.equal(disk(root).items.length, 2);

    remember(root, { text: '新的一条', type: 'event' }, { now: () => T0 + 2 * DAY });
    const items = disk(root).items;
    assert.equal(items.length, 2, '过期的该被清掉');
    assert.ok(!items.some((i) => i.text === '一小时后作废'));
    assert.ok(items.some((i) => i.text === '留着'));
  } finally {
    done();
  }
});

/* ── 6. 统计与读取 ────────────────────────────────────────────────────── */

test('stats 报出作用域分布、带有效期条数、过期条数', () => {
  const { root, done } = freshRoot('stats');
  try {
    remember(root, { text: 'a', scope: 'project', ttlDays: 10 }, { now: () => T0 });
    remember(root, { text: 'b', scope: 'global' }, { now: () => T0 });
    const info = stats(root, { now: () => T0 + 1 });
    assert.equal(info.total, 2);
    assert.equal(info.byScope.project, 1);
    assert.equal(info.byScope.global, 1);
    assert.equal(info.byScope.personal, 0);
    assert.equal(info.withTtl, 1);
    assert.equal(info.expired, 0);

    const later = stats(root, { now: () => T0 + 11 * DAY });
    assert.equal(later.expired, 1);
  } finally {
    done();
  }
});

test('记忆文件坏掉时 readMemory 如实报原因，不抛异常', () => {
  const { root, done } = freshRoot('broken');
  try {
    const file = memoryPath(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ 这不是 json', 'utf8');
    const loaded = readMemory(root);
    assert.equal(loaded.ok, false);
    assert.match(loaded.reason, /读不出来/);
    assert.deepEqual(loaded.memory.items, []);
  } finally {
    done();
  }
});

/* ── 7. 工具层：模型真的能用上这两个参数 ───────────────────────────────── */

test('twin_remember / twin_recall 工具把 scope 和 TTL 透出来', async () => {
  const { root, done } = freshRoot('tools');
  try {
    const tools = createTwinTools({ root: () => root });
    const byName = (n) => tools.find((t) => t.name === n);
    assert.ok(byName('twin_remember'), 'twin_remember 没注册');
    assert.ok(byName('twin_recall'), 'twin_recall 没注册');

    const schema = byName('twin_remember').parameters.properties;
    assert.ok(schema.scope, 'twin_remember 少了 scope 参数');
    assert.ok(schema.ttlDays, 'twin_remember 少了 ttlDays 参数');
    assert.ok(byName('twin_recall').parameters.properties.scope, 'twin_recall 少了 scope 参数');

    const written = String((await byName('twin_remember').execute(
      { text: '这个项目用 pnpm', type: 'semantic', scope: 'project', ttlDays: 5 }, {},
    ))?.text);
    assert.match(written, /作用域/);
    assert.match(written, /这个项目/);
    assert.match(written, /失效/, '写了 TTL 就该告诉人什么时候失效');

    const recalled = String((await byName('twin_recall').execute({ any: true, scope: 'project' }, {}))?.text);
    assert.match(recalled, /这个项目用 pnpm/);

    const other = String((await byName('twin_recall').execute({ any: true, scope: 'personal' }, {}))?.text);
    assert.doesNotMatch(other, /这个项目用 pnpm/, 'personal 视角不该看到 project 的条目');

    const statLine = String((await byName('twin_forget').execute({ action: 'stats' }, {}))?.text);
    assert.match(statLine, /按作用域/);
    assert.match(statLine, /带有效期的 1 条/);
  } finally {
    done();
  }
});
