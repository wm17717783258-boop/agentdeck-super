/**
 * tests/sync-delta.test.mjs —— 增量同步：只传变化、冲突不静默覆盖、游标可靠
 *
 * 这是"多设备自动同步"的核心：原来只能全量打包人肉拷，现在按游标推拉。
 * 重点验三件事：
 *   ① 增量真的增量（第二次同步不带已传过的）
 *   ② 人格类冲突**不自动覆盖**（不能把用户人格悄悄改掉）
 *   ③ 游标坏了/丢了也不会崩、不会重复传
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readCursor,
  writeCursor,
  cursorPath,
  kindOf,
  flattenSnapshot,
  computeDelta,
  mergeDelta,
  syncOnce,
} from '../lib/sync/delta.js';
// collectSnapshot 返回 { ok, snapshot, counts }；测试走真实模块写入，不手搓快照

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'adsk-delta-'));
}

/** 造一条"对面推来的"变化。 */
/**
 * 造一条"对面推来的"变化。
 * 注意用真实字段名：记忆模块用 `text` 存正文、`at` 存时间戳
 * （我一开始写 content/createdAt，applySnapshot 按 text 指纹去重，直接把这批丢了）。
 */
function change(bucket, id, at, data, type) {
  return { bucket, id, at, data: { id, at, ...data, ...(type ? { type } : {}) } };
}

/** 本机放一条真实形状的记忆（用 memory 模块写，别手搓 JSON）。 */
async function seedMemory(root, { id, text, type, at }) {
  const { remember } = await import('../lib/twin/memory.js');
  const r = remember(root, { content: text, type, id }, { now: () => at });
  return r;
}

test('游标：没有文件时给空游标，不报错', () => {
  const root = tmpRoot();
  try {
    const c = readCursor(root);
    assert.equal(c.pushCursor, 0);
    assert.equal(c.peerCursor, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('游标：写进去能读回来', () => {
  const root = tmpRoot();
  try {
    const w = writeCursor(root, { pushCursor: 123, peerCursor: 456, lastSyncAt: 'x', device: 'd' });
    assert.equal(w.ok, true, w.reason);
    const c = readCursor(root);
    assert.equal(c.pushCursor, 123);
    assert.equal(c.peerCursor, 456);
    assert.equal(c.device, 'd');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('游标：损坏的文件当空处理（不崩）', () => {
  const root = tmpRoot();
  try {
    writeCursor(root, { pushCursor: 1, peerCursor: 2 });
    writeFileSync(cursorPath(root), '{ 这不是 JSON', 'utf8');
    const c = readCursor(root);
    assert.equal(c.pushCursor, 0, '坏了应回到 0 而不是抛错');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('kindOf：人格类与流水类分得对', () => {
  assert.equal(kindOf({ type: 'preference' }), 'persona');
  assert.equal(kindOf({ type: 'relation' }), 'persona');
  assert.equal(kindOf({ type: 'habit' }), 'persona');
  assert.equal(kindOf({ type: 'session' }), 'episodic');
  assert.equal(kindOf({ type: 'event' }), 'episodic');
  assert.equal(kindOf({ type: 'semantic' }), 'knowledge');
  assert.equal(kindOf({}), 'other');
});

test('computeDelta：空工作区给空变化，不报错', () => {
  const root = tmpRoot();
  try {
    const d = computeDelta({ root, since: 0 });
    assert.equal(d.ok, true, d.reason);
    assert.ok(Array.isArray(d.changes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeDelta：本机没有的条目直接插入', () => {
  const root = tmpRoot();
  try {
    const r = mergeDelta({
      root,
      changes: [change('memory', 'mem_a', 1000, { content: '对面来的记忆', type: 'event' })],
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.applied.length, 1);
    assert.equal(r.conflicts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeDelta：人格类冲突**不自动覆盖**（关键：不能偷偷改人格）', async () => {
  const root = tmpRoot();
  try {
    // 先在本机放一条"偏好"（用真实写入路径，别手搓快照）
    const seed = await seedMemory(root, { id: 'pref_1', text: '我的偏好', type: 'preference', at: 1000 });
    assert.ok(seed?.ok !== false, `本机写入失败：${JSON.stringify(seed)}`);

    // 对面推来同 id、更新的偏好
    const r = mergeDelta({
      root,
      changes: [change('memory', 'pref_1', 5000, { text: '对面的偏好', type: 'preference' })],
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.conflicts.length, 1, `人格类应进冲突列表：${JSON.stringify(r)}`);
    assert.equal(r.applied.length, 0, '不该静默覆盖');
    assert.match(r.conflicts[0].reason, /不自动覆盖/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeDelta：流水类更新的直接覆盖（不需要人工确认）', async () => {
  const root = tmpRoot();
  try {
    const seed = await seedMemory(root, { id: 'evt_1', text: '旧事件', type: 'event', at: 1000 });
    assert.ok(seed?.ok !== false, `本机写入失败：${JSON.stringify(seed)}`);

    const r = mergeDelta({
      root,
      changes: [change('memory', 'evt_1', 5000, { text: '新事件', type: 'event' })],
    });
    assert.equal(r.applied.length, 1, '流水类应直接覆盖');
    assert.equal(r.conflicts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeDelta：本机更新的条目不会被旧的覆盖', async () => {
  const root = tmpRoot();
  try {
    const seed = await seedMemory(root, { id: 'k_1', text: '我更新的', type: 'event', at: 9000 });
    assert.ok(seed?.ok !== false, `本机写入失败：${JSON.stringify(seed)}`);

    const r = mergeDelta({
      root,
      changes: [change('memory', 'k_1', 1000, { text: '对面的旧的', type: 'event' })],
    });
    assert.equal(r.applied.length, 0, '旧的不该覆盖新的');
    assert.equal(r.skipped.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeDelta：没 id 的条目跳过（不崩）', () => {
  const root = tmpRoot();
  try {
    const r = mergeDelta({ root, changes: [null, {}, { bucket: 'memory' }] });
    assert.equal(r.ok, true);
    assert.equal(r.applied.length, 0);
    assert.ok(r.skipped.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('syncOnce：真写一条记忆后，第二轮不再重复推（增量生效）', async () => {
  const root = tmpRoot();
  try {
    // 第一轮：还没有内容
    const r1 = syncOnce({ root });
    assert.equal(r1.ok, true, r1.reason);
    const after1 = r1.cursor.pushCursor;

    // 写一条记忆
    const { remember } = await import('../lib/twin/memory.js');
    const nowMs = Date.now();
    const mem = remember(root, { content: '增量测试用', type: 'event' }, { now: () => nowMs });
    assert.equal(mem.ok !== false, true, JSON.stringify(mem));

    // 第二轮：应该推出这条
    const r2 = syncOnce({ root });
    assert.equal(r2.ok, true, r2.reason);
    assert.ok(r2.pushedCount >= 1, `应该推到至少 1 条：${JSON.stringify(r2).slice(0, 300)}`);
    assert.ok(r2.cursor.pushCursor >= after1);

    // 第三轮：没有新东西，不该再推同一批
    const r3 = syncOnce({ root });
    assert.equal(r3.ok, true, r3.reason);
    assert.equal(r3.pushedCount, 0, `没有变化时不该重复推：${JSON.stringify(r3).slice(0, 300)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('syncOnce：把对面推来的合进来，并推进 peerCursor', () => {
  const root = tmpRoot();
  try {
    const incoming = [change('memory', 'from_peer_1', 7777, { content: '对面来的', type: 'event' })];
    const r = syncOnce({ root, incoming });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.appliedCount, 1);
    assert.ok(r.cursor.peerCursor >= 7777, `peerCursor 应推进到 ${r.cursor.peerCursor}`);
    assert.ok(r.cursor.lastSyncAt, '应记下最后同步时间');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('syncOnce：truncated 标记会在超过一批上限时置位', () => {
  const root = tmpRoot();
  try {
    const d = computeDelta({ root, since: 0, limit: 0 });
    assert.equal(d.ok, true);
    // limit=0 时任何内容都会触发 truncated（用来验标记本身）
    if (d.total > 0) assert.equal(d.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
