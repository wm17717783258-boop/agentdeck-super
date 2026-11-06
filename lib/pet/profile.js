/**
 * lib/pet/profile.js —— 桌宠的「数字分身档案」+ 习惯进化
 *
 * 定位（见 docs/VISION.md 六概念里的 Visit 与 L4 社交层）：
 *   桌宠不是一个会动的小人，而是「用户在本机的数字分身」——它记住用户的工作习惯，
 *   在你不在场时替你开会、替你带话。这个文件负责最底层的一件事：
 *   **把用户的行为攒成一份可解释、可导出、可迁移的档案**。
 *
 * 设计红线（与 docs/CONTRACTS.md / 团队约定一致）：
 *   1. 纯 ESM、零第三方依赖、无构建步骤，Node >= 22；
 *   2. 任何函数都不向调用方 throw（缺参数这种编程错误也尽量返回 { ok:false }）；
 *   3. 所有落盘都在 .agentdeck/pet/ 下，路径一律由调用方传入的 root 拼出来，
 *      绝不硬编码盘符或家目录；
 *   4. 时间只从注入的 now() 或事件自带的 at 来，不直接取 Date.now()（可测性）；
 *   5. observe() 幂等：同一条事件喂两次，计数只加一次。
 *
 * 落盘形状（.agentdeck/pet/profile.json）：
 *   {
 *     version: 1,
 *     name: '桌宠',                       // 分身名（用户可改）
 *     createdAt, updatedAt,               // ISO 字符串
 *     skins: { owned: ['basic'], active: 'basic' },
 *     traits: {},                         // 留给后续版本的特征槽位
 *     habits: [{ id, key, label, confidence, evidence, updatedAt }],
 *     stats: { tasksDone, tasksClaimed, chats, sessions },
 *     persona: { tone: '简洁', language: 'zh' },
 *     // —— 以下是内部账本，用于幂等与升习惯，导出时会一并带走 ——
 *     signals: { '22-24|worker|sql,test': { count, firstAt, lastAt, types, bucket, role, tags } },
 *     days: ['2026-11-01', ...],          // 有行为发生的本地日期（用于 activeDays / firstDay）
 *     seen: [{ k: '指纹', at: 毫秒 }]      // 幂等去重窗口
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** 档案 schema 版本（importProfile 只认这个版本） */
export const PROFILE_VERSION = 1;
/** 档案相对工作区的目录（唯一一处定义，别的地方都用 petDirOf） */
export const PET_DIR_NAME = '.agentdeck';
export const PET_SUBDIR = 'pet';
/** 同一 (时段, 角色, 标签) 出现多少次升为「习惯」 */
export const HABIT_PROMOTE_AT = 3;
/** 习惯条数上限，超出按置信度淘汰 */
export const MAX_HABITS = 40;
/** 观察计数器上限（防止 signals 无限膨胀） */
export const MAX_SIGNALS = 200;
/** 幂等窗口：没有显式 id / at 的事件，同指纹 5 分钟内视为同一条 */
export const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
/** 幂等记录上限 */
export const MAX_SEEN = 400;
/** 允许的事件类型 */
export const EVENT_TYPES = Object.freeze(['task_done', 'task_claimed', 'task_added', 'chat', 'session_start']);
/** 同一类型事件计数落到 stats 的哪个字段 */
const STAT_KEY = Object.freeze({
  task_done: 'tasksDone',
  task_claimed: 'tasksClaimed',
  task_added: 'tasksAdded',
  chat: 'chats',
  session_start: 'sessions',
});
/** 类型 → 习惯标签里的动词 */
const TYPE_VERB = Object.freeze({
  task_done: '完成任务',
  task_claimed: '接活',
  task_added: '拆任务',
  chat: '聊天',
  session_start: '开工',
});
const MAX_LABEL = 80;
const MAX_IMPORT_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function strArr(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    // structuredClone 对函数会抛，这里兜一层（档案里不该有函数，容错而已）
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}

/**
 * 把各种时间写法归一成毫秒时间戳。认：Date / 秒 / 毫秒 / ISO 字符串。
 * 认不出来返回 null（调用方决定退化成注入的 now()）。
 */
export function toMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 10 位数是秒（2026 年大约是 1.8e9），13 位数是毫秒
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

/** 本地日期 YYYY-MM-DD（跨天判断用本地时区，跟用户感受一致） */
export function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 2 小时一段的时段桶：22 点 → '22-24'，0 点 → '0-2' */
export function hourBucket(ms) {
  const h = new Date(ms).getHours();
  const start = h - (h % 2);
  return `${start}-${start + 2}`;
}

function hashKey(key) {
  return createHash('sha1').update(String(key)).digest('hex').slice(0, 8);
}

function tempPathFor(file) {
  return `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
}

/** 档案目录（root/.agentdeck/pet），唯一拼接点 */
export function petDirOf(root) {
  const base = typeof root === 'string' && root.trim() ? root.trim() : process.cwd();
  return path.join(base, PET_DIR_NAME, PET_SUBDIR);
}

/** 档案文件绝对路径（root/.agentdeck/pet/profile.json） */
export function profilePath(root) {
  return path.join(petDirOf(root), 'profile.json');
}

// ---------------------------------------------------------------------------
// 默认档案 / 归一化 / 校验
// ---------------------------------------------------------------------------

/**
 * 造一份全新档案。返回的就是契约里那张表，恰好 8 个字段（内部账本在归一化时补）。
 * @param {{ name?: string, now?: number|Date|string }} [opts]
 */
export function defaultProfile({ name, now } = {}) {
  const ms = toMs(now) ?? Date.now();
  return {
    version: PROFILE_VERSION,
    name: str(name, '桌宠').slice(0, 64),
    createdAt: isoOf(ms),
    skins: { owned: ['basic'], active: 'basic' },
    traits: {},
    habits: [],
    stats: {},
    persona: { tone: '简洁', language: 'zh' },
  };
}

function normalizeHabit(raw) {
  const src = plainObject(raw);
  const key = str(src.key);
  if (!key) return null;
  return {
    id: str(src.id, `habit_${hashKey(key)}`),
    key,
    label: str(src.label, key).slice(0, MAX_LABEL),
    confidence: Math.max(0, Math.min(1, num(src.confidence, 0))),
    evidence: Math.max(0, Math.floor(num(src.evidence, 0))),
    updatedAt: str(src.updatedAt, '') || null,
  };
}

function normalizeHabits(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const habit = normalizeHabit(item);
    if (!habit || seen.has(habit.key)) continue;
    seen.add(habit.key);
    out.push(habit);
    if (out.length >= MAX_HABITS * 5) break; // 导入脏数据时别撑爆
  }
  return out;
}

function normalizeSeen(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && item) out.push({ k: item, at: 0 });
    else if (item && typeof item === 'object' && typeof item.k === 'string' && item.k) {
      out.push({ k: item.k, at: num(item.at, 0) });
    }
  }
  return out.slice(-MAX_SEEN);
}

/**
 * 把任意来源的对象揉成合法档案（宽容；坏字段回退默认值）。
 * 用于读盘、导入前归一化、以及外部传进来的档案快照。
 * @param {any} raw 任意来源
 * @param {any} [now] 时间兜底（不传就用系统时间；正常路径都由 store 注入）
 */
export function normalizeProfile(raw, now) {
  const src = plainObject(raw);
  const createdAtMs = toMs(src.createdAt) ?? toMs(src.updatedAt) ?? toMs(now) ?? Date.now();
  const created = isoOf(createdAtMs);
  const skins = plainObject(src.skins);
  const owned = strArr(skins.owned);
  const active = str(skins.active, 'basic');
  if (!owned.includes('basic')) owned.unshift('basic');
  if (!owned.includes(active)) owned.push(active);
  const persona = plainObject(src.persona);
  const days = strArr(src.days).sort();
  const profile = {
    version: PROFILE_VERSION,
    name: str(src.name, '桌宠').slice(0, 64),
    createdAt: created,
    updatedAt: str(src.updatedAt, '') || created,
    skins: { owned, active },
    traits: plainObject(src.traits),
    habits: normalizeHabits(src.habits),
    stats: plainObject(src.stats),
    persona: { tone: str(persona.tone, '简洁'), language: str(persona.language, 'zh') },
    signals: plainObject(src.signals),
    days: days.slice(-1000),
    seen: normalizeSeen(src.seen),
  };
  return profile;
}

/**
 * 严格校验一份要导入的档案（importProfile 用）。
 * @returns {{ ok:boolean, problems:string[] }}
 */
export function validateProfile(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: ['档案必须是一个对象'] };
  }
  if (num(raw.version, NaN) !== PROFILE_VERSION) {
    problems.push(`version 必须是 ${PROFILE_VERSION}（收到 ${JSON.stringify(raw.version)}）`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) problems.push('name 必须是非空字符串');
  else if (raw.name.length > 64) problems.push('name 太长（最多 64 字）');
  if (raw.createdAt !== undefined && toMs(raw.createdAt) === null) problems.push('createdAt 不是合法时间');
  const skins = raw.skins;
  if (skins !== undefined) {
    if (!skins || typeof skins !== 'object' || Array.isArray(skins)) problems.push('skins 必须是对象');
    else {
      if (skins.owned !== undefined && !Array.isArray(skins.owned)) problems.push('skins.owned 必须是数组');
      if (skins.active !== undefined && typeof skins.active !== 'string') problems.push('skins.active 必须是字符串');
    }
  }
  if (raw.habits !== undefined) {
    if (!Array.isArray(raw.habits)) problems.push('habits 必须是数组');
    else {
      raw.habits.forEach((habit, i) => {
        if (!habit || typeof habit !== 'object' || Array.isArray(habit)) problems.push(`habits[${i}] 必须是对象`);
        else if (typeof habit.key !== 'string' || !habit.key.trim()) problems.push(`habits[${i}].key 必须是非空字符串`);
        else if (habit.confidence !== undefined && !Number.isFinite(Number(habit.confidence))) {
          problems.push(`habits[${i}].confidence 必须是数字`);
        }
      });
    }
  }
  if (raw.stats !== undefined && (!raw.stats || typeof raw.stats !== 'object' || Array.isArray(raw.stats))) {
    problems.push('stats 必须是对象');
  }
  if (raw.persona !== undefined && (!raw.persona || typeof raw.persona !== 'object' || Array.isArray(raw.persona))) {
    problems.push('persona 必须是对象');
  }
  if (raw.signals !== undefined && (!raw.signals || typeof raw.signals !== 'object' || Array.isArray(raw.signals))) {
    problems.push('signals 必须是对象');
  }
  if (raw.days !== undefined && !Array.isArray(raw.days)) problems.push('days 必须是数组');
  return { ok: problems.length === 0, problems: problems.slice(0, 12) };
}

// ---------------------------------------------------------------------------
// 落盘（原子写：同目录 .tmp → rename）
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `建目录失败：${dir}（${err && err.message ? err.message : err}）` };
  }
}

/**
 * 原子写档案。写失败不会破坏原文件（先写 .tmp 再 rename）。
 * @returns {{ ok:boolean, path?:string, reason?:string }}
 */
export function writeProfileFile(file, profile) {
  const dir = path.dirname(file);
  const made = ensureDir(dir);
  if (!made.ok) return made;
  const text = `${JSON.stringify(profile, null, 2)}\n`;
  const tmp = tempPathFor(file);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, reason: `写临时档案失败：${err && err.message ? err.message : err}` };
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, reason: `落盘失败（原档案未改动）：${err && err.message ? err.message : err}` };
  }
  return { ok: true, path: file };
}

/** 读档案；文件不存在/损坏都返回默认档案 + 原因，不抛错。 */
function readProfile(file, nowMs) {
  const fallback = () => normalizeProfile(null, nowMs);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, profile: fallback(), fresh: true };
    return { ok: false, profile: fallback(), reason: `读档案失败：${err && err.message ? err.message : err}（先按默认档案继续）` };
  }
  if (!text.trim()) {
    const parked = parkCorruptFile(file, nowMs);
    return { ok: false, profile: fallback(), reason: `档案是空文件${parked ? `（已挪到 ${path.basename(parked)}）` : ''}，先按默认档案继续` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const parked = parkCorruptFile(file, nowMs);
    return {
      ok: false,
      profile: fallback(),
      reason: `档案不是合法 JSON${parked ? `（已挪到 ${path.basename(parked)}）` : ''}：${err && err.message ? err.message : err}`,
    };
  }
  return { ok: true, profile: normalizeProfile(raw, nowMs) };
}

/** 坏档案不要直接覆盖掉：改名留档，用户还能自己救回来 */
function parkCorruptFile(file, nowMs) {
  try {
    const dest = `${file}.corrupt-${new Date(toMs(nowMs) ?? Date.now()).getTime()}.json`;
    fs.renameSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// store：档案的读写句柄
// ---------------------------------------------------------------------------

/**
 * 建一个档案 store。root 是工作区根（调用方给），档案落在 <root>/.agentdeck/pet/profile.json。
 * 永不 throw；root 没给就退回当前工作目录并记一条 warning。
 *
 * @param {{ root?:string, now?:() => number }} [opts]
 * @returns {object} store（ok / root / dir / file / now / warnings / location / get / read / write / update / reset）
 */
export function createProfileStore({ root, now } = {}) {
  const warnings = [];
  const warn = (msg) => {
    const text = String(msg);
    if (text && !warnings.includes(text) && warnings.length < 50) warnings.push(text);
  };
  let base = typeof root === 'string' ? root.trim() : '';
  if (!base) {
    base = process.cwd();
    warn('createProfileStore 没有收到 root，档案落在当前工作目录的 .agentdeck/pet 下');
  }
  const clock = typeof now === 'function' ? now : () => Date.now();
  /** 当前毫秒时间戳（所有时间判断都走它，方便测试注入假时钟） */
  const nowMs = () => toMs(clock()) ?? Date.now();
  const dir = petDirOf(base);
  const file = path.join(dir, 'profile.json');

  const store = {
    /** store 自身是否可用（永远 true，留着给调用方统一判断） */
    ok: true,
    root: base,
    dir,
    file,
    path: file,
    now: clock,
    /** 记录了哪些可恢复的问题（读盘坏了、没给 root 等） */
    warnings: () => warnings.slice(),
    location: () => ({ root: base, dir, file }),
    /** 当前档案（每次从盘上读，多进程/多 store 也能看到最新；读不到给默认档案） */
    get() {
      const result = readProfile(file, nowMs());
      if (!result.ok && result.reason) warn(result.reason);
      return result.profile;
    },
    /** get 的别名，读起来更顺 */
    read() {
      return store.get();
    },
    /** 整份写入（原子） */
    write(profile) {
      const normalized = normalizeProfile(profile, nowMs());
      const written = writeProfileFile(file, normalized);
      if (!written.ok) return { ok: false, reason: written.reason };
      return { ok: true, profile: normalized, path: file };
    },
    /**
     * 读-改-写。mutator 拿到一份草稿，可以就地改，也可以 return 新对象。
     * @param {(draft:object) => (object|void)} mutator
     */
    update(mutator) {
      if (typeof mutator !== 'function') return { ok: false, reason: 'update 需要一个修改函数' };
      const draft = clone(store.get());
      let ret;
      try {
        ret = mutator(draft);
      } catch (err) {
        return { ok: false, reason: `修改档案时出错：${err && err.message ? err.message : err}` };
      }
      const next = ret && typeof ret === 'object' ? ret : draft;
      return store.write(next);
    },
    /** 恢复默认档案（会覆盖；调用方明确要求才用） */
    reset({ name } = {}) {
      const fresh = defaultProfile({ name, now: nowMs() });
      return store.write(fresh);
    },
  };
  return store;
}

function ensureStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.write !== 'function') {
    return { ok: false, reason: '需要一个 createProfileStore 建出来的档案 store' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// observe：把事件攒成习惯
// ---------------------------------------------------------------------------

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? String(value).split(/[,，\s]+/)
      : [];
  const out = [];
  for (const item of raw) {
    const tag = String(item).trim().toLowerCase().slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 6).sort();
}

/**
 * 归一化一个行为事件：{ type, at?, role?, tags?, text?, ms?, id? }
 * @returns {{ ok:true, ... } | { ok:false, reason:string }}
 */
function normalizeEvent(event, nowMs) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, reason: 'observe 需要一个事件对象，例如 { type:"task_done", role:"worker", tags:["test"] }' };
  }
  const type = str(event.type).toLowerCase();
  if (!EVENT_TYPES.includes(type)) {
    return { ok: false, reason: `未知的事件类型：${type || '(空)'}（只认 ${EVENT_TYPES.join(' / ')}）` };
  }
  const explicitAt = toMs(event.at) ?? toMs(event.time);
  const atMs = explicitAt ?? nowMs;
  const role = str(event.role, 'general').toLowerCase().slice(0, 24);
  const tags = normalizeTags(event.tags);
  const text = typeof event.text === 'string' ? event.text.slice(0, 500) : '';
  const ms = Number.isFinite(Number(event.ms)) && event.ms !== null && event.ms !== undefined
    ? Math.max(0, Math.round(Number(event.ms)))
    : 0;
  const id = str(event.id).slice(0, 120);
  // 指纹：显式 at 才算「同一条事件」的强身份；没给 at 就靠指纹 + 时间窗口兜
  const base = [type, role, tags.join(','), text, ms].join('|');
  const fingerprint = id ? `id:${id}` : explicitAt !== null ? `${base}|@${atMs}` : base;
  return {
    ok: true,
    type,
    atMs,
    role,
    tags,
    text,
    ms,
    id,
    fingerprint,
    // 有 id 或显式 at 的事件视为「可精确定位」，去重窗口无限；否则只在时间窗内去重
    windowMs: id ? Number.POSITIVE_INFINITY : explicitAt !== null ? 0 : DEDUPE_WINDOW_MS,
  };
}

function isDuplicate(seen, fingerprint, atMs, windowMs) {
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const item = seen[i];
    if (!item || item.k !== fingerprint) continue;
    if (windowMs === Number.POSITIVE_INFINITY) return true;
    if (Math.abs(atMs - num(item.at, 0)) <= windowMs) return true;
  }
  return false;
}

function confidenceOf(count) {
  const raw = 0.5 + (count - HABIT_PROMOTE_AT) * 0.08;
  return Math.min(0.95, Math.max(0.1, Math.round(raw * 100) / 100));
}

/** 习惯的人类可读标签：'常在 22-24 点完成任务，常涉及 sql、test（角色：worker）' */
function habitLabel(signal) {
  const types = plainObject(signal.types);
  const ranked = Object.entries(types).sort((a, b) => num(b[1]) - num(a[1]) || (a[0] < b[0] ? -1 : 1));
  const verb = TYPE_VERB[ranked[0] ? ranked[0][0] : ''] || '干活';
  const tags = strArr(signal.tags).slice(0, 3);
  const tagText = tags.length ? `，常涉及 ${tags.join('、')}` : '';
  const role = str(signal.role);
  const roleText = role && role !== 'general' ? `（角色：${role}）` : '';
  return `常在 ${str(signal.bucket, '?')} 点${verb}${tagText}${roleText}`.slice(0, MAX_LABEL);
}

function byRank(a, b) {
  return num(b.confidence) - num(a.confidence)
    || num(b.evidence) - num(a.evidence)
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
}

function trimSignals(signals) {
  const keys = Object.keys(signals);
  if (keys.length <= MAX_SIGNALS) return 0;
  keys.sort((a, b) => num(signals[b].count) - num(signals[a].count)
    || num(signals[b].lastAt) - num(signals[a].lastAt)
    || a.localeCompare(b));
  const dropped = keys.slice(MAX_SIGNALS);
  for (const key of dropped) delete signals[key];
  return dropped.length;
}

/**
 * 记一条行为事件，顺便维护习惯。
 *
 * 幂等：同一条事件（同 id，或同指纹且落在窗口内）重复喂只算一次，
 * 第二次返回 { ok:true, skipped:true }——不是错误，调用方不用管。
 *
 * @param {object} store createProfileStore 的返回值
 * @param {{ type:string, at?:any, role?:string, tags?:string[]|string, text?:string, ms?:number, id?:string }} event
 * @returns {{ ok:boolean, skipped?:boolean, key?:string, count?:number, habit?:object|null, reason?:string }}
 */
export function observe(store, event) {
  const checked = ensureStore(store);
  if (!checked.ok) return checked;
  const nowMs = toMs(store.now()) ?? Date.now();
  const ev = normalizeEvent(event, nowMs);
  if (!ev.ok) return ev;

  const profile = store.get();
  const seen = Array.isArray(profile.seen) ? profile.seen : [];
  if (isDuplicate(seen, ev.fingerprint, ev.atMs, ev.windowMs)) {
    return { ok: true, skipped: true, reason: '重复事件，已忽略（幂等）', key: null };
  }

  // ---- 统计 ----
  const stats = plainObject(profile.stats);
  const statKey = STAT_KEY[ev.type];
  if (statKey) stats[statKey] = Math.max(0, Math.floor(num(stats[statKey]))) + 1;
  profile.stats = stats;

  // ---- 活跃日 ----
  const day = localDay(ev.atMs);
  const days = strArr(profile.days);
  if (!days.includes(day)) {
    days.push(day);
    days.sort();
    if (days.length > 1000) days.splice(0, days.length - 1000);
  }
  profile.days = days;

  // ---- (时段, 角色, 标签) 频次 ----
  const bucket = hourBucket(ev.atMs);
  const key = `${bucket}|${ev.role}|${ev.tags.join(',')}`;
  const signals = plainObject(profile.signals);
  const prev = plainObject(signals[key]);
  const types = plainObject(prev.types);
  types[ev.type] = Math.max(0, Math.floor(num(types[ev.type]))) + 1;
  const signal = {
    count: Math.max(0, Math.floor(num(prev.count))) + 1,
    firstAt: num(prev.firstAt, ev.atMs) || ev.atMs,
    lastAt: ev.atMs,
    types,
    bucket,
    role: ev.role,
    tags: ev.tags,
  };
  signals[key] = signal;
  trimSignals(signals);
  profile.signals = signals;

  // ---- 够次数就升为习惯（同 key 只更新，不新增） ----
  let habit = null;
  if (signal.count >= HABIT_PROMOTE_AT && signals[key]) {
    const habits = Array.isArray(profile.habits) ? profile.habits : [];
    const id = `habit_${hashKey(key)}`;
    const next = {
      id,
      key,
      label: habitLabel(signal),
      confidence: confidenceOf(signal.count),
      evidence: signal.count,
      updatedAt: isoOf(ev.atMs),
    };
    const at = habits.findIndex((item) => item && (item.key === key || item.id === id));
    if (at >= 0) habits[at] = next;
    else habits.push(next);
    if (habits.length > MAX_HABITS) {
      const keep = new Set(habits.slice().sort(byRank).slice(0, MAX_HABITS));
      profile.habits = habits.filter((item) => keep.has(item));
    } else {
      profile.habits = habits;
    }
    habit = profile.habits.find((item) => item && item.key === key) || null;
  }

  // ---- 幂等账本 ----
  profile.seen = [...seen, { k: ev.fingerprint, at: ev.atMs }].slice(-MAX_SEEN);
  profile.updatedAt = isoOf(nowMs);

  const written = store.write(profile);
  if (!written.ok) return { ok: false, reason: written.reason || '写档案失败' };
  return { ok: true, skipped: false, key, count: signal.count, habit };
}

// ---------------------------------------------------------------------------
// summarize：给人看也给 LLM 看
// ---------------------------------------------------------------------------

/**
 * 汇总档案：前 5 条习惯 + 关键统计 + 一段可以直接塞进 system prompt 的中文画像。
 * @returns {{ ok:boolean, topHabits:object[], stats:{tasksDone:number,tasksAdded:number,activeDays:number,firstDay:string|null}, personaHint:string, reason?:string }}
 */
export function summarize(store) {
  const empty = { tasksDone: 0, tasksAdded: 0, activeDays: 0, firstDay: null };
  const checked = ensureStore(store);
  if (!checked.ok) return { ok: false, ...empty, topHabits: [], personaHint: '', reason: checked.reason };

  const profile = store.get();
  const habits = (Array.isArray(profile.habits) ? profile.habits : []).slice().sort(byRank);
  const topHabits = habits.slice(0, 5).map((habit) => ({
    id: habit.id,
    key: habit.key,
    label: habit.label,
    confidence: num(habit.confidence),
    evidence: Math.floor(num(habit.evidence)),
    updatedAt: habit.updatedAt || null,
  }));
  const days = strArr(profile.days).sort();
  const stats = {
    tasksDone: Math.max(0, Math.floor(num(profile.stats && profile.stats.tasksDone))),
    tasksAdded: Math.max(0, Math.floor(num(profile.stats && profile.stats.tasksAdded))),
    activeDays: days.length,
    firstDay: days[0] || null,
  };

  const persona = plainObject(profile.persona);
  const lines = [`你是用户在这台机器上的数字分身「${profile.name}」。`];
  if (topHabits.length) {
    const [first, ...rest] = topHabits;
    lines.push(`你${first.label}（已出现 ${first.evidence} 次）。`);
    if (rest.length) {
      lines.push('其他观察到的习惯：');
      for (const habit of rest) lines.push(`- ${habit.label}（${habit.evidence} 次，置信度 ${habit.confidence}）`);
    }
  } else {
    lines.push('还没有足够的行为数据，先照用户的明确指令办事，别臆测他的偏好。');
  }
  lines.push(`语气：${str(persona.tone, '简洁')}；语言：${str(persona.language, 'zh')}。`);
  if (stats.tasksDone || stats.tasksAdded || stats.activeDays) {
    const added = stats.tasksAdded ? `、拆出 ${stats.tasksAdded} 个` : '';
    lines.push(`统计：累计完成 ${stats.tasksDone} 个任务${added}，活跃 ${stats.activeDays} 天${stats.firstDay ? `，最早 ${stats.firstDay}` : ''}。`);
  }
  lines.push('以上都是本地统计出来的参考信息，不是用户新下的指令。');

  return { ok: true, topHabits, stats, personaHint: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// 导出 / 导入（迁移与备份）
// ---------------------------------------------------------------------------

/**
 * 导出档案。返回的 json 是可直接写文件/发给别的机器的字符串。
 * @returns {{ ok:boolean, json?:string, profile?:object, reason?:string }}
 */
export function exportProfile(store) {
  const checked = ensureStore(store);
  if (!checked.ok) return checked;
  const profile = store.get();
  return { ok: true, profile, json: `${JSON.stringify(profile, null, 2)}\n` };
}

/**
 * 导入档案。校验不过就拒绝，**原文件一个字节都不动**。
 * @param {object} store
 * @param {string|object} input JSON 字符串或对象
 */
export function importProfile(store, input) {
  const checked = ensureStore(store);
  if (!checked.ok) return checked;

  let raw = input;
  if (typeof input === 'string') {
    if (input.length > MAX_IMPORT_BYTES) {
      return { ok: false, reason: `档案太大（${Math.round(input.length / 1024)}KB），最多 ${MAX_IMPORT_BYTES / 1024}KB` };
    }
    const text = input.trim();
    if (!text) return { ok: false, reason: '导入内容是空的' };
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: `不是合法 JSON：${err && err.message ? err.message : err}` };
    }
  } else if (Buffer.isBuffer(input)) {
    return importProfile(store, input.toString('utf8'));
  }

  const verdict = validateProfile(raw);
  if (!verdict.ok) {
    return { ok: false, reason: `档案不符合 schema：${verdict.problems.join('；')}`, problems: verdict.problems };
  }

  // 覆盖前先把旧档案存一份，用户后悔还能捡回来
  let backup = null;
  try {
    if (fs.existsSync(store.file)) {
      backup = path.join(store.dir, 'profile.bak.json');
      fs.copyFileSync(store.file, backup);
    }
  } catch {
    backup = null;
  }

  const profile = normalizeProfile(raw);
  const written = store.write(profile);
  if (!written.ok) return { ok: false, reason: written.reason || '写档案失败' };
  return { ok: true, profile, backup };
}

export default {
  PROFILE_VERSION,
  HABIT_PROMOTE_AT,
  MAX_HABITS,
  MAX_SIGNALS,
  EVENT_TYPES,
  createProfileStore,
  defaultProfile,
  normalizeProfile,
  validateProfile,
  observe,
  summarize,
  exportProfile,
  importProfile,
  petDirOf,
  profilePath,
  writeProfileFile,
  toMs,
  localDay,
  hourBucket,
};
