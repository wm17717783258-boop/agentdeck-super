/**
 * lib/sync/delta.js —— 增量同步（多设备不再需要"全量打包传文件"）
 *
 * 问题：原来的 deck_sync 是**全量打包** —— 导出一个大 blob，人肉拷到另一台再导入。
 *   多设备日常用起来别扭：改一条记忆也要重新导一次全量。
 *
 * 这个模块做**按时间游标的增量推拉**：
 *   · 每台设备维护自己的 cursor（推到哪了 / 收到哪了）
 *   · 只传 cursor 之后发生的变化
 *   · 冲突按"时间新者胜"，但人格/偏好类**不静默覆盖**，标出来让人确认
 *
 * 传输层不在这里：本模块只负责"算出该传什么"和"把收到的合进来"。
 * 字节流仍沿用 lib/sync/index.js 的端到端加密（AES-256-GCM + scrypt）。
 *
 * 诚实边界：
 *   · 没有自动发现 —— 两台设备怎么找到对方（relay/房间/手动 URL）由调用方决定
 *   · 不做 CRDT —— 同字段两边同改，按时间戳定胜负，不做字符级合并
 *   · 时钟不一致时会选错赢家（所以每条都带 updatedAt）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { collectSnapshot, deviceId } from './index.js';

export const DELTA_VERSION = 1;
/** 游标文件位置：跟工作区走（每个项目一份同步进度）。 */
export const CURSOR_FILE = 'sync-cursor.json';
/** 一次最多推多少条，防止首次同步就把整包塞过去。 */
export const MAX_BATCH = 500;

/** 能真正落盘的分区。不在表里的分区一律跳过，绝不"报 applied 但没写"。 */
const SUPPORTED_BUCKETS = new Set(['memory', 'habits', 'habitsRejected', 'automation', 'policy']);
/** 人格类分区：两边都改过时不自动覆盖。 */
const PERSONA_BUCKETS = new Set(['habits', 'habitsRejected', 'petProfile']);

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

export function cursorPath(root) {
  return join(String(root || process.cwd()), '.agentdeck', CURSOR_FILE);
}

/** 读游标；坏了当空（不因为游标损坏就同步不了）。 */
export function readCursor(root) {
  const empty = { v: DELTA_VERSION, peerCursor: 0, pushCursor: 0, lastSyncAt: "", device: "" };
  try {
    const p = cursorPath(root);
    if (!existsSync(p)) return empty;
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return {
      v: DELTA_VERSION,
      // peerCursor：我们已经从对面收到哪个时间点了
      peerCursor: Number(raw?.peerCursor) || 0,
      // pushCursor：我们上次推给对面到哪个时间点
      pushCursor: Number(raw?.pushCursor) || 0,
      lastSyncAt: String(raw?.lastSyncAt || ""),
      device: String(raw?.device || ""),
    };
  } catch {
    return empty;
  }
}

export function writeCursor(root, cursor) {
  try {
    const p = cursorPath(root);
    mkdirSync(join(String(root || process.cwd()), '.agentdeck'), { recursive: true });
    writeAtomic(p, `${JSON.stringify({ ...cursor, v: DELTA_VERSION }, null, 2)}\n`);
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/** 一个条目属于哪一类（决定冲突时能不能静默覆盖）。 */
export function kindOf(item) {
  const t = String(item?.type || item?.kind || '').toLowerCase();
  if (t === 'preference' || t === 'relation' || t === 'habit' || t === 'habits') return 'persona';
  if (t === 'session' || t === 'event') return 'episodic';
  if (t === 'semantic') return 'knowledge';
  return 'other';
}

/** 把一个时间字段转成毫秒数；数字与 ISO 字符串都认，坏的当 0。 */
function timeValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === 'string' && value.trim()) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * 条目的"最后变化时间"。
 * 不能只看 at/createdAt：记忆重记一次会更新 updatedAt 但 at 不变，
 * 只按 at 过滤会导致这条改动永远推不出去（第 16 轮自检抓到的）。
 */
export function latestAt(item) {
  let max = 0;
  for (const field of ['updatedAt', 'at', 'createdAt', 'confirmedAt', 'rejectedAt']) {
    max = Math.max(max, timeValue(item?.[field]));
  }
  return max;
}

/** 从快照里把所有带时间戳的条目摊平成一维列表（含来源分区）。 */
export function flattenSnapshot(snapshot) {
  const out = [];
  const push = (bucket, list, { idOf = (i) => String(i?.id || i?.key || ''), atOf = latestAt } = {}) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const at = atOf(item) || 0;
      out.push({ bucket, at, id: idOf(item), data: item });
    }
  };

  const habitId = (i) => String(i?.key || i?.id || '');
  push("memory", snapshot?.memory?.items);
  push("habits", snapshot?.habits?.confirmed, { idOf: habitId });
  push("habitsRejected", snapshot?.habits?.rejected, { idOf: habitId });
  push("automation", snapshot?.automation?.jobs);
  push("policy", snapshot?.policy?.rules);
  push("petProfile", snapshot?.pet?.habits);

  return out;
}

/**
 * 算出"从 since 之后发生的变化"。
 * @returns {{ ok:boolean, changes:object[], maxAt:number, truncated:boolean, total:number, reason?:string }}
 */
export function computeDelta({ root, since = 0, now = () => Date.now(), limit = MAX_BATCH } = {}) {
  try {
    // collectSnapshot 返回 { ok, snapshot, counts } —— 要的是里面那层 snapshot
    const got = collectSnapshot({ root, now });
    if (!got || got.ok === false) {
      return { ok: false, changes: [], maxAt: Number(since) || 0, truncated: false, total: 0, reason: got?.reason || "读快照失败" };
    }
    const snap = got.snapshot || got;
    const all = flattenSnapshot(snap)
      // 只保留比游标新的；at 为 0 的（没时间戳）一律带上 —— 宁可多传，不可漏传
      .filter((x) => x.at === 0 || x.at > Number(since))
      .sort((a, b) => a.at - b.at);
    const truncated = all.length > limit;
    const changes = all.slice(0, limit);
    const maxAt = changes.reduce((m, x) => Math.max(m, x.at), Number(since) || 0);
    return { ok: true, changes, maxAt, truncated, total: all.length };
  } catch (err) {
    return { ok: false, changes: [], maxAt: Number(since) || 0, truncated: false, total: 0, reason: String(err?.message || err) };
  }
}

/**
 * 把对面推来的变化合进本机。
 *
 * 冲突策略（写死，不猜）：
 *   · episodic（流水）/ knowledge（知识）→ 时间新的覆盖旧的
 *   · persona（人格/偏好/习惯）→ **不自动覆盖**，进 conflicts 让人确认
 *   · 本机没有的 id → 直接插入（不论类别）
 */
export function mergeDelta({ root, changes = [], now = () => Date.now() } = {}) {
  const applied = [];
  const conflicts = [];
  const skipped = [];

  let snap;
  try {
    const got = collectSnapshot({ root, now });
    if (!got || got.ok === false) {
      return { ok: false, applied, conflicts, skipped, reason: `读本机快照失败：${got?.reason || "未知"}` };
    }
    snap = got.snapshot || got;
  } catch (err) {
    return { ok: false, applied, conflicts, skipped, reason: `读本机快照失败：${err?.message || err}` };
  }

  const localIndex = new Map();
  for (const item of flattenSnapshot(snap)) {
    if (item.id) localIndex.set(`${item.bucket}:${item.id}`, item);
  }

  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change !== 'object' || !change.id) {
      skipped.push({ reason: '没有 id' });
      continue;
    }
    const bucket = String(change.bucket || 'memory');
    if (!SUPPORTED_BUCKETS.has(bucket)) {
      skipped.push({ id: change.id, reason: `不认识的分区：${bucket}` });
      continue;
    }
    const key = `${bucket}:${change.id}`;
    const mine = localIndex.get(key);
    const kind = PERSONA_BUCKETS.has(bucket) ? 'persona' : kindOf(change.data);

    if (!mine) {
      applied.push({ ...change, bucket });
      continue;
    }
    if (Number(change.at) > Number(mine.at)) {
      if (kind === 'persona') {
        // 人格类：不静默覆盖，交给用户
        conflicts.push({
          kind,
          bucket,
          id: change.id,
          mineAt: mine.at,
          theirsAt: change.at,
          theirs: change.data,
          // 同一份数据再给一个 data 别名：这样冲突对象可以**原样**传回
          // resolveConflict，不用调用方自己把 theirs 改名成 data。
          data: change.data,
          reason: '两边都改过人格/偏好类条目，按设计不自动覆盖',
        });
      } else {
        applied.push({ ...change, bucket });
      }
    } else {
      skipped.push({ id: change.id, reason: '本机的不比它旧' });
    }
  }

  // 关键：算完必须**真写盘**。
  // 之前只把"该合什么"算出来就返回了，调用方以为已经落盘 —— 结果 memory.json
  // 根本没生成，跨进程 E2E 直接抓到这个（applied=1 但文件不存在）。
  if (applied.length) {
    const wrote = persistApplied({ root, applied, now });
    if (!wrote.ok) {
      return { ok: false, applied: [], conflicts, skipped, reason: `合并结果写盘失败：${wrote.reason}` };
    }
  }

  return { ok: true, applied, conflicts, skipped };
}

function readJsonSafe(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // 坏了当空：同步不能因为一个坏文件就整批失败
  }
  return fallback;
}

/** 按 keyOf 合并进某个数组字段，保留文件里其他字段。 */
function mergeIntoFile({ root, rel, fallback, listField, keyOf, items, at }) {
  const file = join(String(root), rel);
  const cur = readJsonSafe(file, fallback);
  if (!Array.isArray(cur[listField])) cur[listField] = [];
  const index = new Map();
  cur[listField].forEach((item, idx) => {
    const k = keyOf(item);
    if (k) index.set(k, idx);
  });

  let changed = 0;
  for (const item of items) {
    const k = keyOf(item);
    if (!k) continue;
    if (index.has(k)) cur[listField][index.get(k)] = item;
    else {
      index.set(k, cur[listField].length);
      cur[listField].push(item);
    }
    changed += 1;
  }
  if (!changed) return 0;

  if (Object.prototype.hasOwnProperty.call(cur, 'updatedAt')) cur.updatedAt = at;
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(cur, null, 2)}\n`);
  return changed;
}

/**
 * 把 applied 的变化写回各模块自己的文件。
 *
 * 之前这里只写 memory，其余分区只记数量 —— 调用方看到 applied，文件却没变。
 * 现在逐分区按各自的主键（记忆 id / 习惯 key / 任务 id / 规则 id）合并写回；
 * 任何一个分区写失败就整体返回 ok:false，不假报。
 */
function persistApplied({ root, applied, now }) {
  const at = Number(typeof now === 'function' ? now() : now) || Date.now();
  const byBucket = new Map();
  for (const change of applied) {
    const key = String(change.bucket || 'memory');
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(change.data);
  }

  try {
    const wrote = {};
    const mem = byBucket.get('memory') || [];
    if (mem.length) {
      wrote.memory = mergeIntoFile({
        root,
        rel: join('.agentdeck', 'twin', 'memory.json'),
        fallback: { version: 1, items: [] },
        listField: 'items',
        keyOf: (x) => String(x?.id || ''),
        items: mem,
        at,
      });
    }

    const habits = byBucket.get('habits') || [];
    if (habits.length) {
      wrote.habits = mergeIntoFile({
        root,
        rel: join('.agentdeck', 'twin', 'habits.json'),
        fallback: { version: 1, confirmed: [], rejected: [] },
        listField: 'confirmed',
        keyOf: (x) => String(x?.key || ''),
        items: habits,
        at,
      });
    }

    const rejected = byBucket.get('habitsRejected') || [];
    if (rejected.length) {
      wrote.habitsRejected = mergeIntoFile({
        root,
        rel: join('.agentdeck', 'twin', 'habits.json'),
        fallback: { version: 1, confirmed: [], rejected: [] },
        listField: 'rejected',
        keyOf: (x) => String(x?.key || ''),
        items: rejected,
        at,
      });
    }

    const jobs = byBucket.get('automation') || [];
    if (jobs.length) {
      wrote.automation = mergeIntoFile({
        root,
        rel: join('.agentdeck', 'automation', 'state.json'),
        fallback: { version: 1, jobs: [], approvals: [], runs: [] },
        listField: 'jobs',
        keyOf: (x) => String(x?.id || ''),
        items: jobs,
        at,
      });
    }

    const rules = byBucket.get('policy') || [];
    if (rules.length) {
      wrote.policy = mergeIntoFile({
        root,
        rel: 'policy.json',
        fallback: { version: 1, rules: [] },
        listField: 'rules',
        keyOf: (x) => String(x?.id || ''),
        items: rules,
        at,
      });
    }

    return { ok: true, wrote };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * 走一轮同步：算出要推的、把对面给的合进来、推进游标。
 *
 * @param {{ root:string, incoming?:object[], now?:Function }} opts
 * @returns 报告：推了什么、合了什么、有什么冲突、新游标是多少
 */
export function syncOnce({ root, incoming = [], now = () => Date.now() } = {}) {
  const cursor = readCursor(root);
  const stamp = Number(now());

  // 1) 算出要推给对面的（从 pushCursor 之后）
  const delta = computeDelta({ root, since: cursor.pushCursor, now });
  if (!delta.ok) return { ok: false, reason: delta.reason, cursor };

  // 2) 合并对面推来的
  const merged = mergeDelta({ root, changes: incoming, now });
  if (!merged.ok) return { ok: false, reason: merged.reason, cursor };

  // 3) 推进游标
  const maxIncomingAt = (Array.isArray(incoming) ? incoming : [])
    .reduce((m, c) => Math.max(m, Number(c?.at) || 0), cursor.peerCursor);
  const next = {
    ...cursor,
    pushCursor: delta.maxAt,
    peerCursor: maxIncomingAt,
    lastSyncAt: new Date(stamp).toISOString(),
    device: cursor.device || deviceId({ root }),
  };
  const saved = writeCursor(root, next);
  if (!saved.ok) return { ok: false, reason: saved.reason, cursor: next };

  return {
    ok: true,
    pushed: delta.changes,
    pushedCount: delta.changes.length,
    truncated: delta.truncated,
    total: delta.total,
    appliedCount: merged.applied.length,
    conflicts: merged.conflicts,
    skippedCount: merged.skipped.length,
    cursor: next,
  };
}

/** 把冲突应用掉（用户点"用对面的"时调）。 */
export function resolveConflict({ root, change, now = () => Date.now() } = {}) {
  const data = change?.data || change?.theirs;
  if (!change || !change.id || !data) {
    return { ok: false, reason: '冲突条目缺 id 或 data' };
  }
  try {
    const bucket = String(change.bucket || '');
    if (!SUPPORTED_BUCKETS.has(bucket)) {
      return { ok: false, reason: `不认识的分区：${bucket || '(空)'}` };
    }
    const wrote = persistApplied({ root, applied: [{ ...change, bucket, data }], now });
    if (!wrote.ok) return { ok: false, reason: wrote.reason || '写回失败' };
    return { ok: true, bucket, id: change.id };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export default {
  DELTA_VERSION,
  cursorPath,
  readCursor,
  writeCursor,
  kindOf,
  latestAt,
  flattenSnapshot,
  computeDelta,
  mergeDelta,
  syncOnce,
  resolveConflict,
};

