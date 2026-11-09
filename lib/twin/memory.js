/**
 * Nexi Twin · 分身记忆（M2）
 *
 * 为什么单独一份而不是塞进桌宠档案：
 *   桌宠档案（lib/pet/profile.js）记的是"行为统计与习惯"，是**推导出来的画像**；
 *   这里记的是"用户明确说过、或系统明确干过的事"，是**可引用的原始记忆**。
 *   两者混在一起，删记忆就会把习惯统计一起打坏。
 *
 * 五类记忆（对齐产品方案）：
 *   session    会话记忆：这次聊了什么、结论是什么
 *   event      事件记忆：某天真干过什么（任务完成、房间同步…）
 *   semantic   语义记忆：项目/人物的稳定事实（技术栈、目录约定、术语）
 *   preference 偏好记忆：用户要的做事方式（"先给结论"、"别动生产库"）
 *   relation   关系记忆：谁是谁、谁能派活给谁、跨机关系
 *
 * 四级可见性：private（默认，永不出本机）< friend（好友可见）< room（房间内可见）< public（可公开）
 * 读的时候按 maxVisibility 卡住，写的时候把 visibility 记死——跨用户协作（M3）就靠这一层，
 * 不靠调用方自觉。
 *
 * 全部纯本地 JSON，原子写（tmp + rename），不联网、不上传。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const MEMORY_VERSION = 1;
export const TWIN_DIR = '.agentdeck';
export const TWIN_SUBDIR = 'twin';

/** 五类记忆。用英文 key，界面层再翻中文。 */
export const MEMORY_TYPES = Object.freeze(['session', 'event', 'semantic', 'preference', 'relation']);
export const TYPE_LABELS = Object.freeze({
  session: '会话',
  event: '事件',
  semantic: '语义',
  preference: '偏好',
  relation: '关系',
});

/** 四级可见性，顺序即权限高低。 */
export const VISIBILITIES = Object.freeze(['private', 'friend', 'room', 'public']);
export const VISIBILITY_LABELS = Object.freeze({
  private: '私有',
  friend: '好友',
  room: '房间',
  public: '公开',
});

export const MAX_ITEMS = 800;
export const MAX_TEXT = 2000;
export const MAX_TAGS = 6;
export const MAX_TAG_LEN = 24;
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// 文件位置
// ---------------------------------------------------------------------------

export function twinDirOf(root) {
  const base = root || process.cwd();
  return join(base, TWIN_DIR, TWIN_SUBDIR);
}

export function memoryPath(root) {
  return join(twinDirOf(root), 'memory.json');
}

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : Date.now();
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function strArr(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampText(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

function cleanTags(tags) {
  const out = [];
  for (const tag of strArr(tags)) {
    const t = tag.replace(/\s+/g, ' ').slice(0, MAX_TAG_LEN);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 可见性归一：认中文也认英文，认不出就落最保守的 private。 */
export function normalizeVisibility(value) {
  const raw = str(value).toLowerCase();
  if (!raw) return 'private';
  if (VISIBILITIES.includes(raw)) return raw;
  const zh = { 私有: 'private', 好友: 'friend', 房间: 'room', 公开: 'public' };
  if (zh[raw]) return zh[raw];
  if (raw === 'friends') return 'friend';
  return 'private';
}

export function normalizeType(value) {
  const raw = str(value).toLowerCase();
  if (MEMORY_TYPES.includes(raw)) return raw;
  const zh = { 会话: 'session', 事件: 'event', 语义: 'semantic', 偏好: 'preference', 关系: 'relation' };
  return zh[raw] || 'event';
}

export function visibilityRank(value) {
  const idx = VISIBILITIES.indexOf(normalizeVisibility(value));
  return idx < 0 ? 0 : idx;
}

/**
 * 可见性闸门（这条是 M3 跨用户协作的地基，别改松）。
 *
 * audience 是「谁在看」：
 *   private = 本人（默认）：看得到自己全部记忆，包括私有
 *   friend  = 好友：只看得到标了 friend / room / public 的
 *   room    = 房间成员：只看得到标了 room / public 的
 *   public  = 陌生人：只看得到标了 public 的
 *
 * 也就是说：条目的 visibility 写的是「最少谁能看」，不是「最多谁能看」。
 */
export function visibleTo(visibility, audience) {
  const who = normalizeVisibility(audience ?? 'private');
  if (who === 'private') return true; // 本人什么都看得到
  return visibilityRank(visibility) >= visibilityRank(who);
}

/** 兼容旧名。 */
export const visibleWithin = visibleTo;

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

export function defaultMemory() {
  return { version: MEMORY_VERSION, updatedAt: null, items: [] };
}

/* ── 1.10.0：作用域（scope）＋ 有效期（TTL） ───────────────────────────────
 * scope 决定"这条记忆是给谁用的"，ttlDays 决定"多久之后自动作废"。
 * 这两件事以前只能靠 tags 糊，模型和用户都记不住；现在是一等字段。 */

/** 作用域：personal=只跟你有关；project=这个项目；team=这个小组；global=哪都算。 */
export const SCOPES = Object.freeze(['personal', 'project', 'team', 'global']);
export const SCOPE_LABELS = Object.freeze({
  personal: '只跟你有关',
  project: '这个项目',
  team: '这个小组',
  global: '哪都用得上',
});

export function normalizeScope(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (SCOPES.includes(s)) return s;
  // 常见别名，模型爱写这些
  if (s === 'me' || s === 'self' || s === 'user') return 'personal';
  if (s === 'repo' || s === 'workspace' || s === 'code') return 'project';
  if (s === 'group' || s === 'room') return 'team';
  if (s === 'all' || s === 'any') return 'global';
  return 'personal';
}

/** 天数 → 到期毫秒时间戳；给 null/0/负数 = 永不过期。 */
export function ttlToExpiresAt(ttlDays, at) {
  const n = Number(ttlDays);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Number(at) + Math.min(3650, n) * 24 * 60 * 60 * 1000);
}

/** 这条记忆现在过期了吗（pinned 的永不过期——是用户亲手钉住的）。 */
export function isExpired(item, nowMs) {
  if (!item) return false;
  if (item.pinned === true) return false;
  const exp = Number(item.expiresAt);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  return exp <= Number(nowMs);
}

/** 顺手把过期的清掉（写盘时才调用；readMemory 是纯读，不动盘）。 */
export function sweepExpired(memory, nowMs) {
  const items = Array.isArray(memory?.items) ? memory.items : [];
  const kept = items.filter((it) => !isExpired(it, nowMs));
  return { memory: { ...memory, items: kept }, removed: items.length - kept.length };
}

export function normalizeMemory(raw) {
  const source = plainObject(raw);
  const items = [];
  for (const item of Array.isArray(source.items) ? source.items : []) {
    const entry = plainObject(item);
    const text = clampText(entry.text);
    if (!text) continue;
    items.push({
      id: str(entry.id) || `mem_${Math.random().toString(36).slice(2, 10)}`,
      type: normalizeType(entry.type),
      text,
      tags: cleanTags(entry.tags),
      visibility: normalizeVisibility(entry.visibility),
      source: str(entry.source, 'local'),
      at: Number(entry.at) || null,
      updatedAt: Number(entry.updatedAt) || Number(entry.at) || null,
      hits: Math.max(0, Math.floor(Number(entry.hits) || 0)),
      pinned: entry.pinned === true,
      // 1.10.0：作用域 + 有效期（老档案没有这两个字段 → 回落成"个人、永不过期"）
      scope: normalizeScope(entry.scope),
      ttlDays: Number.isFinite(Number(entry.ttlDays)) && Number(entry.ttlDays) > 0 ? Number(entry.ttlDays) : null,
      expiresAt: Number.isFinite(Number(entry.expiresAt)) && Number(entry.expiresAt) > 0 ? Number(entry.expiresAt) : null,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return { version: MEMORY_VERSION, updatedAt: Number(source.updatedAt) || null, items };
}

/** 读档案。文件不存在 / 坏了都返回空档案（坏文件留个 reason 让上层能提示）。 */
export function readMemory(root, { now } = {}) {
  const file = memoryPath(root);
  if (!existsSync(file)) return { ok: true, memory: defaultMemory(), file, exists: false };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { ok: true, memory: normalizeMemory(raw), file, exists: true };
  } catch (err) {
    return { ok: false, memory: defaultMemory(), file, exists: true, reason: `记忆文件读不出来：${err.message}` };
  }
}

export function writeMemory(root, memory) {
  const file = memoryPath(root);
  const dir = dirname(file);
  // 写盘各步都可能失败（目录被占、磁盘满、权限不够、断电留下的路径冲突）。
  // 按仓库铁律：**失败要如实返回 ok:false，绝不把异常抛给调用方** ——
  // 抛出去会让上层工具崩，而工具契约是"永不 throw"。
  // （真机自检第 14 轮抓到的：把 .agentdeck/twin 换成一个文件，remember 直接抛 EEXIST。）
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const payload = { ...normalizeMemory(memory), version: MEMORY_VERSION };
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return { ok: true, file, memory: payload };
  } catch (err) {
    return {
      ok: false,
      file,
      reason: `记忆写盘失败（${err?.code || err?.name || 'Error'}）：${err?.message || err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 写一条
// ---------------------------------------------------------------------------

function fingerprint(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 记住一件事。
 * @returns {{ok:boolean, item?:object, deduped?:boolean, reason?:string, file?:string}}
 */
export function remember(root, input = {}, { now } = {}) {
  const text = clampText(input.text ?? input.content ?? input.note);
  if (!text) return { ok: false, reason: '要记的东西是空的：给 text 一句话' };
  const at = nowMs(now ?? input.at);
  const type = normalizeType(input.type);
  const visibility = normalizeVisibility(input.visibility);
  const tags = cleanTags(input.tags);
  const source = str(input.source, 'local');
  const pinned = input.pinned === true;
  const scope = normalizeScope(input.scope);
  const ttlDays = Number.isFinite(Number(input.ttlDays)) && Number(input.ttlDays) > 0 ? Math.min(3650, Number(input.ttlDays)) : null;
  const expiresAt = ttlToExpiresAt(ttlDays, at);

  const loaded = readMemory(root, { now });
  const memory = loaded.memory;
  // 1.10.0：每次写盘顺手清掉已过期的（TTL 到了就不用再留着占额度）
  const swept = sweepExpired(memory, at);
  memory.items = swept.memory.items;
  const fp = fingerprint(text);
  const dup = memory.items.find((item) => fingerprint(item.text) === fp && (!item.type || item.type === type));
  if (dup) {
    // 十分钟内重复写同一条：不新增，只把时间和命中数往前推（避免刷屏）
    const recent = dup.updatedAt && Math.abs(at - dup.updatedAt) <= DEDUPE_WINDOW_MS;
    dup.updatedAt = at;
    if (pinned) dup.pinned = true;
    const merged = cleanTags([...(dup.tags || []), ...tags]);
    dup.tags = merged;
    // 重记一次等于续期/改作用域：显式给了就覆盖，没给就保持原样
    if (input.scope != null) dup.scope = scope;
    if (ttlDays != null) { dup.ttlDays = ttlDays; dup.expiresAt = expiresAt; }
    const wrote = writeMemory(root, { ...memory, updatedAt: at });
    // 写盘失败必须如实说 —— 不能返回 ok:true 让调用方以为记住了
    if (!wrote.ok) return { ok: false, reason: wrote.reason, file: wrote.file };
    return {
      ok: true,
      deduped: true,
      item: dup,
      file: memoryPath(root),
      reason: recent ? '刚记过同一条，已合并' : '之前记过同一条，已更新',
    };
  }

  const item = {
    id: str(input.id) || `mem_${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type,
    text,
    tags,
    visibility,
    source,
    at,
    updatedAt: at,
    hits: 0,
    pinned,
    scope,
    ttlDays,
    expiresAt,
  };
  if (input.id) {
    const old = memory.items.findIndex((it) => it.id === item.id);
    if (old >= 0) memory.items.splice(old, 1);
  }
  memory.items.push(item);
  if (memory.items.length > MAX_ITEMS) {
    // 超限：先丢最旧的、没钉住的、非偏好类（偏好/关系更值钱，尽量留）
    const keepBehind = new Set(['preference', 'relation']);
    const sorted = memory.items.slice().sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pa - pb;
      const ka = keepBehind.has(a.type) ? 1 : 0;
      const kb = keepBehind.has(b.type) ? 1 : 0;
      if (ka !== kb) return ka - kb;
      return (Number(a.at) || 0) - (Number(b.at) || 0);
    });
    const drop = sorted.slice(0, memory.items.length - MAX_ITEMS).map((it) => it.id);
    memory.items = memory.items.filter((it) => !drop.includes(it.id));
  }
  const written = writeMemory(root, { ...memory, updatedAt: at });
  // 同上：写不进去就是没记住，不能假报成功
  if (!written.ok) return { ok: false, reason: written.reason, file: written.file };
  return { ok: true, item, deduped: false, file: written.file };
}

// ---------------------------------------------------------------------------
// 召回
// ---------------------------------------------------------------------------

function bigrams(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) {
    const pair = s.slice(i, i + 2);
    if (/[\s\p{P}]/u.test(pair)) continue;
    out.add(pair);
  }
  return out;
}

function score(item, { query, tags, type }) {
  let total = 0;
  if (type && item.type === type) total += 6;
  const wanted = cleanTags(tags);
  if (wanted.length) {
    const have = new Set(item.tags || []);
    for (const t of wanted) if (have.has(t)) total += 5;
  }
  if (query) {
    const q = String(query).toLowerCase().trim();
    const text = String(item.text || '').toLowerCase();
    if (text.includes(q)) total += 10;
    const qb = bigrams(q);
    if (qb.size) {
      const ib = bigrams(text);
      let hit = 0;
      for (const g of qb) if (ib.has(g)) hit += 1;
      total += Math.min(8, Math.round((hit / qb.size) * 8));
    }
    for (const tag of item.tags || []) if (tag.toLowerCase().includes(q)) total += 4;
  }
  if (item.pinned) total += 2;
  total += Math.min(3, Math.floor(item.hits / 3));
  return total;
}

/**
 * 召回：query / tags / type 三选一即可；audience 决定"谁在看"（默认本人）。
 * 命中的条目会 hits+1（写回盘），这样"常用的记忆"会自然浮上来。
 */
export function recall(root, input = {}, { now } = {}) {
  const loaded = readMemory(root, { now });
  if (!loaded.ok && loaded.reason) {
    // 文件坏了不该让工具崩：明说读不出来
    return { ok: false, reason: loaded.reason, items: [], total: 0 };
  }
  const audience = normalizeVisibility(input.audience ?? input.maxVisibility ?? 'private');
  const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit) || 5)));
  const wantedType = input.type ? normalizeType(input.type) : null;
  const at = nowMs(now);
  // 1.10.0：过期的（TTL 到了）默认不再召回；想看见就用 includeExpired:true（排查用）
  const alive = loaded.memory.items.filter((item) => input.includeExpired === true || !isExpired(item, at));
  const expiredCount = loaded.memory.items.length - alive.length;
  // 先把"看得见"的那部分圈出来，再按类型硬过滤；两者都不能靠打分软放行。
  const visible = alive.filter((item) => visibleTo(item.visibility, audience));
  // 1.10.0：作用域过滤。不给 scope 就不筛（老行为）；给了就只留这一档 + global。
  const wantedScope = input.scope != null && input.scope !== '' ? normalizeScope(input.scope) : null;
  const inScope = wantedScope
    ? visible.filter((item) => normalizeScope(item.scope) === wantedScope || normalizeScope(item.scope) === 'global')
    : visible;
  const pool = wantedType ? inScope.filter((item) => item.type === wantedType) : inScope;
  const ranked = pool
    .map((item) => ({ item, s: score(item, { ...input, type: wantedType }) }))
    .filter((row) => (input.any ? true : row.s > 0))
    .sort((a, b) => (b.s - a.s) || ((Number(b.item.updatedAt) || 0) - (Number(a.item.updatedAt) || 0)))
    .slice(0, limit);

  if (ranked.length && input.track !== false) {
    for (const row of ranked) {
      row.item.hits = Math.max(0, Math.floor(Number(row.item.hits) || 0)) + 1;
      row.item.updatedAt = row.item.updatedAt || at;
    }
    writeMemory(root, loaded.memory);
  }
  return {
    ok: true,
    items: ranked.map((row) => ({ ...row.item, score: row.s })),
    total: pool.length,
    audience,
    scope: wantedScope,
    expired: expiredCount,
    hidden: loaded.memory.items.length - visible.length,
    file: loaded.file,
  };
}

// ---------------------------------------------------------------------------
// 删除 / 导出 / 统计
// ---------------------------------------------------------------------------

/**
 * 删记忆。三档：按 id 精确删、按 query/tag 批量删、all=true 清空（必须 confirm:true）。
 * 删除是物理删除，不软删——但会先写一份 .bak，防手抖。
 */
export function forget(root, input = {}, { now } = {}) {
  const loaded = readMemory(root, { now });
  if (!loaded.ok || !loaded.exists) return { ok: true, removed: 0, reason: '本来就没记忆' };
  const memory = loaded.memory;
  const at = nowMs(now);
  let removed = [];
  if (input.all === true) {
    if (input.confirm !== true) return { ok: false, reason: '清空全部记忆要带 confirm:true（这动作不可撤销）', removed: 0 };
    removed = memory.items.slice();
    memory.items = [];
  } else if (input.id) {
    removed = memory.items.filter((item) => item.id === input.id);
    memory.items = memory.items.filter((item) => item.id !== input.id);
  } else {
    const hits = recall(root, { ...input, limit: 50, track: false });
    const ids = new Set((hits.items || []).map((item) => item.id));
    removed = memory.items.filter((item) => ids.has(item.id));
    memory.items = memory.items.filter((item) => !ids.has(item.id));
  }
  if (!removed.length) return { ok: true, removed: 0, reason: '没匹配到要删的记忆' };
  const file = memoryPath(root);
  try {
    writeFileSync(`${file}.bak`, `${JSON.stringify(memory, null, 2)}\n`, 'utf8');
  } catch { /* 备份失败不阻塞删除 */ }
  writeMemory(root, { ...memory, updatedAt: at });
  return { ok: true, removed: removed.length, ids: removed.map((item) => item.id) };
}

export function stats(root, { now } = {}) {
  const loaded = readMemory(root, { now });
  const at = nowMs(now);
  const byType = {};
  const byVisibility = {};
  const byScope = {};
  for (const type of MEMORY_TYPES) byType[type] = 0;
  for (const vis of VISIBILITIES) byVisibility[vis] = 0;
  for (const scope of SCOPES) byScope[scope] = 0;
  let expired = 0;
  for (const item of loaded.memory.items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    byVisibility[item.visibility] = (byVisibility[item.visibility] || 0) + 1;
    byScope[normalizeScope(item.scope)] = (byScope[normalizeScope(item.scope)] || 0) + 1;
    if (isExpired(item, at)) expired += 1;
  }
  return {
    ok: loaded.ok,
    total: loaded.memory.items.length,
    byType,
    byVisibility,
    byScope,
    expired,
    withTtl: loaded.memory.items.filter((it) => Number(it.expiresAt) > 0).length,
    updatedAt: loaded.memory.updatedAt,
    file: loaded.file,
    exists: loaded.exists,
  };
}

/** 导出：json 给机器，md 给人看（也是"记忆可携带"的证据）。 */
export function exportMemory(root, input = {}) {
  const loaded = readMemory(root);
  const fmt = str(input.format, 'json').toLowerCase();
  if (fmt === 'md' || fmt === 'markdown') {
    const lines = ['# Nexi 灵犀 · 分身记忆导出', ''];
    const groups = new Map();
    for (const item of loaded.memory.items) {
      if (!groups.has(item.type)) groups.set(item.type, []);
      groups.get(item.type).push(item);
    }
    for (const type of MEMORY_TYPES) {
      const list = groups.get(type) || [];
      if (!list.length) continue;
      lines.push(`## ${TYPE_LABELS[type]}（${list.length}）`, '');
      for (const item of list) {
        const when = item.at ? new Date(item.at).toISOString().slice(0, 16).replace('T', ' ') : '—';
        const tags = item.tags?.length ? ` [${item.tags.join(', ')}]` : '';
        // 1.10.0：导出里带上作用域和到期时间，别让"这条只在本项目里算数"这种信息在路上丢掉
        const scope = SCOPE_LABELS[normalizeScope(item.scope)] || normalizeScope(item.scope);
        const ttl = Number(item.expiresAt) > 0 ? ` · 到 ${new Date(Number(item.expiresAt)).toISOString().slice(0, 10)} 失效` : '';
        lines.push(`- ${when} · ${VISIBILITY_LABELS[item.visibility]} · ${scope}${ttl}${tags} ${item.text.replace(/\n/g, ' ')}`);      }
      lines.push('');
    }
    lines.push('> 本文件由本机生成，只包含你允许导出的记忆；删除请用 `twin_forget`。', '');
    return { ok: true, format: 'md', text: lines.join('\n'), count: loaded.memory.items.length };
  }
  return { ok: true, format: 'json', text: `${JSON.stringify(loaded.memory, null, 2)}\n`, count: loaded.memory.items.length };
}
