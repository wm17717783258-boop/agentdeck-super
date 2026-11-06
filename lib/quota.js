/**
 * lib/quota.js —— 配额门控：把四档（免费版 / 协作版 / 工作室版 / 企业版）的限额变成真的判断
 *
 * 为什么要有这个文件：
 *   以前配额只是状态页上的一行文字（lib/index.js 的 cloudRoomText()），写着「云房间 0/0」，
 *   但实际谁都还能继续建 —— 等于产品在撒谎。这里把限额做成**纯函数门控**：
 *   调用方先拿到 check() 的结果，再决定拦不拦。配额从"宣传语"变成"真的判断"。
 *
 * 免费档的底线（务必别改坏）：
 *   免费档承诺「安装 → 记忆 → 串门 → 任务」四件事能完整跑通，这四件事**不会被拦**：
 *     - 安装插件（install）：不属于任何计费类型，没有配额；
 *     - 记忆（twinEntries）：免费档 200 条，从 0 开始记不会拦（200 条是规模上限，不是门槛）；
 *     - 串门（visits）：不计配额；产品方案里 FREE 的权益是「无限一对一好友」，所以免费版也必须能串门；
 *     - 任务板（tasks）：不计配额。
 *
 *   关于 rooms（2026-11 口径调整，别改回去）：
 *     rooms = **群组房间总数**（方案定价：免费 3 / 协作 20 / 工作室 50 / 企业不限），
 *     本地群组房间也计入这个数——方案里"3 个群组房间"就是这个意思，写成 0 会和定价页自相矛盾。
 *     以前 rooms=0 想说"免费版不能建云房间"，但正确做法是把**跨机持久云房间**单独拎出来由
 *     license.TIERS.cloudRooms 在 lib/room.js 里守（免费 cloudRooms=0：能一对一串门，但建不了走中继的持久云房间）。
 *     两层门控各管一件事：quota.rooms 管总量，entitlements.cloudRooms 管跨机。
 *
 * 三条铁律：
 *   1. check() **永不抛异常**：任何拿不准的输入一律返回 { ok:true, degraded:true, reason }。
 *      宁可放行，也不许因为一个脏参数把付费用户挡在门外。
 *   2. check() 是**纯函数**：不读盘、不读环境、不看时钟，方便单测；读盘统计只在 countUsed() 里做。
 *   3. Infinity 不能经过 JSON 一圈就变成 0：JSON.stringify(Infinity) === 'null'。
 *      - 读限额时，null 一律按「不限」处理（normalizeLimit），绝不能当 0；
 *      - 输出时用 serializeCheck() / 返回值的 toJSON() 转成
 *        { limit:null, remaining:null, unlimited:true }；
 *      - 消费方判断"有没有超限"只看 ok，判断"是不是不限"只看 unlimited，不要 Number(null)。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 档位顺序：从低到高。升级建议（upgradeTo）就按这个顺序取下一档。 */
export const TIER_ORDER = Object.freeze(['free', 'plus', 'studio', 'business']);

/** 计费类型。顺序即展示顺序。 */
export const KINDS = Object.freeze(['rooms', 'meetings', 'automations', 'twinEntries', 'seats']);

/**
 * 默认限额表。**数字必须与 lib/license.js 的 TIERS 完全一致**（口径来自产品方案的定价章节）：
 *   免费版 3 房间 / 每月 5 场会 / 3 个自动化 / 3 席
 *   协作版 20 房间 / 每月 30 场会 / 20 个自动化 / 8 席
 *   工作室版 50 房间 / 不限场会 / 100 个自动化 / 30 席
 *   企业版 不限房间 / 不限场会 / 不限自动化 / 200 席
 * 改这里也要改 TIERS，反之亦然；tests/quota.test.mjs 有一条专门比对两表是否漂移。
 */
export const DEFAULT_LIMITS = freezeTable({
  free: { rooms: 3, meetings: 5, automations: 3, twinEntries: 200, seats: 3 },
  plus: { rooms: 20, meetings: 30, automations: 20, twinEntries: 2000, seats: 8 },
  studio: { rooms: 50, meetings: 999, automations: 100, twinEntries: 20000, seats: 30 },
  business: { rooms: 999, meetings: Infinity, automations: Infinity, twinEntries: Infinity, seats: 200 },
});

/** 别名：调用方 import { LIMITS } 和 import { DEFAULT_LIMITS } 都行。 */
export const LIMITS = DEFAULT_LIMITS;

/** 档位展示信息：reason 里的人话全从这里取，避免同一档位出现两种叫法。 */
export const TIER_META = Object.freeze({
  free: Object.freeze({ label: '免费版', price: '¥0' }),
  plus: Object.freeze({ label: '协作版', price: '¥29/月' }),
  studio: Object.freeze({ label: '工作室版', price: '¥99/月' }),
  business: Object.freeze({ label: '企业版', price: '¥30000/年' }),
});

/** 计费类型的单位/名词：拼人话时用，例如「3 场会议」「200 条记忆」。 */
export const KIND_META = Object.freeze({
  rooms: Object.freeze({ unit: '个群组房间', short: '个', noun: '群组房间' }),
  meetings: Object.freeze({ unit: '场会议', short: '场', noun: '会议' }),
  automations: Object.freeze({ unit: '条自动化任务', short: '条', noun: '自动化任务' }),
  twinEntries: Object.freeze({ unit: '条记忆', short: '条', noun: '记忆' }),
  seats: Object.freeze({ unit: '个席位', short: '个', noun: '席位' }),
});

/**
 * 不计配额的类型（免费档四件核心事就在这里）。
 * 这些不是"未知类型"，而是明确不收费：传进来 check() 一律放行，并说明原因。
 *
 * 注意：`localRooms` **不在**这里了。产品方案把"3 个群组房间"算进免费档权益，
 * 所以本地群组房间必须真的计数（它已经作为 rooms 的别名，见 normalizeKind）。
 */
export const UNMETERED_KINDS = Object.freeze({
  install: '安装',
  visits: '串门',
  visit: '串门',
  tasks: '任务',
  task: '任务',
});

/* ────────────────────────── 纯函数：归一化与限额表 ────────────────────────── */

/** 冻结整张限额表（含每一档），防止调用方手贱改默认值。 */
function freezeTable(table) {
  for (const tier of TIER_ORDER) {
    const row = table[tier];
    if (row) Object.freeze(row);
  }
  return Object.freeze(table);
}

/**
 * 归一化档位：大小写/空格容错；老授权码写的 `pro` 是 `plus` 的别名（档位只升不降）。
 * 认不出来返回 null —— 由 check() 按"拿不准就放行"处理，不在这里猜成 free。
 */
export function normalizeTier(tier) {
  if (typeof tier !== 'string') return null;
  const key = tier.trim().toLowerCase();
  if (!key) return null;
  if (key === 'pro') return 'plus';
  return TIER_ORDER.includes(key) ? key : null;
}

/** 归一化计费类型：兼容单复数/驼峰（room、cloudRooms、twin…）。认不出来返回 null。 */
export function normalizeKind(kind) {
  if (typeof kind !== 'string') return null;
  const key = kind.trim();
  if (!key) return null;
  if (KINDS.includes(key)) return key;
  const alias = {
    room: 'rooms',
    cloudroom: 'rooms',
    cloudrooms: 'rooms',
    localroom: 'rooms',
    localrooms: 'rooms',
    meeting: 'meetings',
    automation: 'automations',
    twin: 'twinEntries',
    memory: 'twinEntries',
    twinentries: 'twinEntries',
    seat: 'seats',
  };
  return alias[key.toLowerCase()] || null;
}

/**
 * 归一化"上限"。
 * **关键：`null` 必须理解成「不限」，不能理解成 0。**
 * 因为 JSON.stringify(Infinity) === 'null'，限额表经过一次 JSON 往返后，
 * 企业版的不限项全都会变成 null；这时候如果 `Number(null)` 当 0，付费最高档反而被拦死。
 * 拿不准的脏值（负数/NaN/对象）返回 fallback（默认不限），同样遵循"宁可放行"。
 */
export function normalizeLimit(value, fallback = Infinity) {
  if (value === undefined) return fallback;
  if (value === null) return Infinity; // ← Infinity 的 JSON 形态，唯一正确解释是「不限」
  if (typeof value === 'number') {
    if (value === Infinity) return Infinity;
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    return fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    if (n === Infinity) return Infinity;
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return fallback;
}

/** 从一档的原始对象里取某个类型的上限；兼容 license.TIERS 的字段名（localRooms/cloudRooms/maxSeats/meetingsPerMonth）。 */
function pickLimit(raw, kind) {
  if (!raw) return undefined;
  if (raw[kind] !== undefined) return raw[kind];
  // 方案口径里「房间」数写的是 localRooms（3/20/50），cloudRooms 只是其中的云端部分，
  // 所以优先 localRooms；只给了 cloudRooms 的老授权表才回落到它。
  if (kind === 'rooms' && raw.localRooms !== undefined) return raw.localRooms;
  if (kind === 'rooms' && raw.cloudRooms !== undefined) return raw.cloudRooms;
  if (kind === 'meetings' && raw.meetingsPerMonth !== undefined) return raw.meetingsPerMonth;
  if (kind === 'automations' && raw.automations !== undefined) return raw.automations;
  if (kind === 'seats' && raw.maxSeats !== undefined) return raw.maxSeats;
  // 注意：不要再把 meetingTasks 映射成 meetings。
  // meetingTasks 是「一场会议最多拆几个任务」，meetings 是「一共能开几场会议」——
  // 早先这么映射过，结果协作版的会议上限从 20 掉到 8，等于把两个不同的东西当成一个。
  return undefined;
}

/**
 * 合并调用方给的覆盖表：只覆盖给了的字段，没给的沿用默认值。
 * - tiers 不是对象 → 直接用默认表（不抛）；
 * - 某档某字段为 null → 按「不限」处理（见 normalizeLimit）。
 */
export function mergeLimits(tiers) {
  const source = tiers && typeof tiers === 'object' && !Array.isArray(tiers) ? tiers : {};
  const table = {};
  for (const tier of TIER_ORDER) {
    const def = DEFAULT_LIMITS[tier];
    const raw = source[tier] && typeof source[tier] === 'object' && !Array.isArray(source[tier]) ? source[tier] : null;
    const row = {};
    for (const kind of KINDS) row[kind] = normalizeLimit(pickLimit(raw, kind), def[kind]);
    table[tier] = row;
  }
  return freezeTable(table);
}

/* ────────────────────────── 展示小工具 ────────────────────────── */

/** 数字转展示文本：Infinity 不是 0，写成「不限」。 */
export function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '不限';
}

function nextTier(tier) {
  const index = TIER_ORDER.indexOf(tier);
  return index >= 0 && index < TIER_ORDER.length - 1 ? TIER_ORDER[index + 1] : null;
}

/** 把任意值说成人话（只用于 reason，不参与判断）。 */
export function describeValue(value) {
  try {
    if (typeof value === 'string') return `"${value}"`;
    if (value === null) return 'null';
    if (Array.isArray(value)) return `数组(${value.length})`;
    if (typeof value === 'object') return '对象';
    return String(value);
  } catch {
    return '未知值';
  }
}

function errText(err) {
  try {
    return String(err?.message || err);
  } catch {
    return '未知错误';
  }
}

/** 查不计配额类型的展示名（大小写都认）。 */
function unmeteredName(kindInput) {
  if (typeof kindInput !== 'string') return '';
  const key = kindInput.trim();
  if (!key) return '';
  return UNMETERED_KINDS[key] || UNMETERED_KINDS[key.toLowerCase()] || '';
}

/**
 * 用量归一化：只接受非负有限数（数字或数字字符串）。
 * 返回 null 表示"这个用量不可信" —— 调用方按「拿不准就放行」处理。
 */
function normalizeUsed(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  }
  return null;
}

/**
 * 把 check() 的结果转成 JSON 安全的普通对象。
 * Infinity → null，同时给出 unlimited:true —— 消费方必须看 unlimited，
 * 不要拿 Number(null) 当 0，否则最高档的「不限」会被误判成「已用满」。
 */
export function serializeCheck(result) {
  try {
    const src = result && typeof result === 'object' ? result : {};
    const finiteOrNull = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
    const out = {
      ok: src.ok !== false,
      degraded: src.degraded === true,
      tier: typeof src.tier === 'string' && src.tier ? src.tier : 'unknown',
      kind: typeof src.kind === 'string' && src.kind ? src.kind : 'unknown',
      limit: finiteOrNull(src.limit),
      used: finiteOrNull(src.used) ?? 0,
      remaining: finiteOrNull(src.remaining),
      unlimited: src.unlimited === true || src.limit === Infinity,
    };
    if (src.unmetered === true) out.unmetered = true;
    if (typeof src.reason === 'string' && src.reason) out.reason = src.reason;
    if (typeof src.upgradeTo === 'string' && src.upgradeTo) out.upgradeTo = src.upgradeTo;
    return out;
  } catch {
    return {
      ok: true,
      degraded: true,
      tier: 'unknown',
      kind: 'unknown',
      limit: null,
      used: 0,
      remaining: null,
      unlimited: true,
      reason: '配额结果序列化失败，本次先放行',
    };
  }
}

/* ────────────────────────── 工厂：createQuota ────────────────────────── */

/**
 * 创建一套配额门控。
 * @param {{ tiers?: object }} [options] 可选的档位覆盖表（例如 license.TIERS，字段名会自动兼容）
 * @returns {{
 *   limits: object,
 *   check: (tier: string, kind: string, used: number) => object,
 *   checkMany: (tier: string, usage: object) => object,
 *   limitOf: (tier: string, kind: string) => number,
 *   upgradeOf: (tier: string) => (string|null),
 *   countUsed: (input?: { roots?: (string|string[]|object) }) => object,
 * }}
 */
export function createQuota(options = {}) {
  let limits;
  try {
    const args = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    // 容错：createQuota({ tiers }) 是标准用法；直接传 license.TIERS 也认。
    const tiers = args.tiers !== undefined ? args.tiers : (TIER_ORDER.some((tier) => tier in args) ? args : undefined);
    limits = mergeLimits(tiers);
  } catch {
    limits = DEFAULT_LIMITS;
  }

  /** 给结果挂一个非枚举的 toJSON：JSON.stringify(result) 自动走 serializeCheck，不会把 Infinity 变成裸 null。 */
  function finish(result) {
    const out = result;
    Object.defineProperty(out, 'toJSON', {
      enumerable: false,
      configurable: true,
      value() {
        return serializeCheck(out);
      },
    });
    return out;
  }

  /** 降级放行：任何拿不准的情况都走这里，ok 恒为 true。 */
  function degradedResult(tier, kind, reason) {
    return finish({
      ok: true,
      degraded: true,
      tier: tier || 'unknown',
      kind: kind || 'unknown',
      limit: Infinity,
      used: 0,
      remaining: Infinity,
      unlimited: true,
      reason: String(reason || '无法判断配额，本次先放行'),
    });
  }

  /** 不计配额的类型：放行，并说明为什么不占配额。 */
  function unmeteredResult(tier, kindLabel, used, name) {
    return finish({
      ok: true,
      degraded: false,
      unmetered: true,
      tier,
      kind: String(kindLabel).trim(),
      limit: Infinity,
      used,
      remaining: Infinity,
      unlimited: true,
      reason: `「${name}」不占配额，${TIER_META[tier].label}也不拦`,
    });
  }

  /** 真正判断逻辑。外层 check() 再包一层 try/catch，保证永不抛。 */
  function checkInner(tierInput, kindInput, usedInput) {
    const tier = normalizeTier(tierInput);
    const kind = normalizeKind(kindInput);

    // 1) 用量拿不准 → 放行（不能因为一个脏用量把用户拦在门外）
    const used = normalizeUsed(usedInput);
    if (used === null) {
      return degradedResult(tier, kind, `用量数据不可信（${describeValue(usedInput)}），无法判断是否超限，本次先放行`);
    }

    // 2) 档位认不出来 → 放行（可能是老授权/脏数据；不能按免费档拦）
    if (!tier) {
      return degradedResult(null, kind, `未知档位「${describeValue(tierInput)}」，无法判断配额，本次先放行`);
    }

    // 3) 不计配额的类型（安装/串门/任务）→ 明确放行
    if (!kind) {
      const name = unmeteredName(kindInput);
      if (name) return unmeteredResult(tier, kindInput, used, name);
      return degradedResult(tier, null, `未知配额类型「${describeValue(kindInput)}」，本次先放行`);
    }

    // 4) 正常判断
    const limit = normalizeLimit(limits[tier][kind], Infinity);
    const unlimited = limit === Infinity;
    const remaining = unlimited ? Infinity : Math.max(0, limit - used);
    const ok = unlimited || used < limit;

    if (ok) {
      return finish({
        ok: true,
        degraded: false,
        tier,
        kind,
        limit,
        used,
        remaining,
        unlimited,
      });
    }

    const upgradeTo = nextTier(tier);
    return finish({
      ok: false,
      degraded: false,
      tier,
      kind,
      limit,
      used,
      remaining,
      unlimited,
      reason: buildReason(tier, kind, limit, used, upgradeTo),
      ...(upgradeTo ? { upgradeTo } : {}),
    });
  }

  /** 超限说人话 + 给升级建议。 */
  function buildReason(tier, kind, limit, used, upgradeTo) {
    const label = TIER_META[tier].label;
    const meta = KIND_META[kind];
    const usedText = `${formatCount(used)} ${meta.short}`;

    if (!upgradeTo) {
      return `${label}最多 ${formatCount(limit)} ${meta.unit}，本月已用 ${usedText}；已是最高档，需要更多请联系我们扩容。`;
    }

    const next = TIER_META[upgradeTo];
    const nextLimit = limits[upgradeTo][kind];
    const upgradeText = nextLimit === Infinity
      ? `升级到${next.label}（${next.price}）后不再限制`
      : `升级到${next.label}（${next.price}）可到 ${formatCount(nextLimit)} ${meta.unit}`;

    if (limit === 0) {
      const note = kind === 'rooms'
        ? '（这一档的群组房间是 0：一对一串门不受影响，但建不了走中继的跨机持久房间）'
        : '';
      return `${label}不含${meta.noun}${note}；${upgradeText}。`;
    }

    return `${label}最多 ${formatCount(limit)} ${meta.unit}，本月已用 ${usedText}；${upgradeText}。`;
  }

  /** 永不抛的 check()。 */
  function check(tierInput, kindInput, usedInput) {
    try {
      return checkInner(tierInput, kindInput, usedInput);
    } catch (err) {
      return degradedResult(null, normalizeKind(kindInput), `配额判断出错，本次先放行：${errText(err)}`);
    }
  }

  /** 一次性检查一组用量（集成时方便）：返回 { [kind]: 结果 }；形状再怪也不抛。 */
  function checkMany(tierInput, usage = {}) {
    const out = {};
    try {
      const src = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
      for (const [kind, used] of Object.entries(src)) out[kind] = check(tierInput, kind, used);
    } catch {
      /* 统计形状再怪也不抛；空对象让调用方按"没有配额信息"放行 */
    }
    return out;
  }

  /** 查某档某类型的上限；认不出来返回 Infinity（不限），不抛。 */
  function limitOf(tierInput, kindInput) {
    try {
      const tier = normalizeTier(tierInput);
      const kind = normalizeKind(kindInput);
      if (!tier || !kind) return Infinity;
      return limits[tier][kind];
    } catch {
      return Infinity;
    }
  }

  /** 下一档（用于 UI 的升级按钮）；最高档返回 null。 */
  function upgradeOf(tierInput) {
    try {
      const tier = normalizeTier(tierInput);
      return tier ? nextTier(tier) : null;
    } catch {
      return null;
    }
  }

  return { limits, check, checkMany, limitOf, upgradeOf, countUsed };
}

/* ────────────────────────── 真实用量统计（唯一读盘的地方） ────────────────────────── */

/**
 * 统计本机真实用量，喂给 check() 的 used。
 *
 * 数据来源（都跟各模块自己的落盘位置一致，不另造一套账）：
 *   - rooms：       `<root>/.agentdeck/rooms/<roomId>.json`（lib/room.js 的房间会话记录；
 *                   按 roomId 去重——同一房间在工作区和全局目录各存一份不重复算）
 *   - meetings：    `<root>/.agentdeck/meetings/<会议号>/meta.json`（lib/meeting/index.js）
 *   - automations： `<root>/.agentdeck/automation/state.json` 里的 jobs 条数（lib/automation/store.js）
 *   - twinEntries： `<root>/.agentdeck/twin/memory.json` 里的 items 条数（lib/twin/memory.js）
 *
 * 刻意**不**统计任务板（tasks）、串门（visits）：它们不计配额，
 * 免费档四件核心事里的三件都在这里，统计了反而会误导调用方去拦。
 *
 * 1.10.0 口径：rooms 数的是**群组房间总数**（本机 + 走中继的跨机持久房间都算），
 * 免费 3 / 协作 20 / 工作室 50 / 企业 999；跨机这一层另外由 license.TIERS.cloudRooms
 * 在 lib/room.js 里守（免费 0：能一对一串门，但建不了持久云房间）。
 *
 * 底线：任何读写失败都只记 warning、按 0 条算，**绝不 throw**。
 * 宁可少算（放行）也不能多算（把用户拦住）。
 *
 * @param {{ roots?: string|string[]|{workspace?:string, global?:string, [k:string]: any} }} [input]
 * @returns {{ ok:true, counts:{rooms:number,meetings:number,automations:number,twinEntries:number}, total:number,
 *             sources:object, roots:string[], warnings:string[], degraded:boolean }}
 */
export function countUsed({ roots } = {}) {
  const counts = { rooms: 0, meetings: 0, automations: 0, twinEntries: 0 };
  const sources = { rooms: [], meetings: [], automation: [], twin: [] };
  const warnings = [];
  let rootList = [];

  try {
    rootList = normalizeRoots(roots);
    if (rootList.length === 0) {
      warnings.push('没有拿到工作区路径，用量按 0 条算（先放行）');
    }

    const seenRooms = new Set();
    const seenMeetings = new Set();
    const seenTwinFiles = new Set();
    const seenRoots = new Set();

    for (const root of rootList) {
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);

      // ── 云房间：有 roomId 的会话文件才算一个房间 ──
      const roomsDir = join(root, '.agentdeck', 'rooms');
      for (const name of readDirSafe(roomsDir, warnings)) {
        if (!name.endsWith('.json')) continue; // chat.log 之类的附属文件不数
        const file = join(roomsDir, name);
        const record = readJsonSafe(file, warnings);
        const roomId = record && typeof record.roomId === 'string' ? record.roomId.trim() : '';
        if (!roomId) {
          warnings.push(`房间记录缺少 roomId，已跳过：${file}`);
          continue;
        }
        if (seenRooms.has(roomId)) continue;
        seenRooms.add(roomId);
        counts.rooms += 1;
        sources.rooms.push(file);
      }

      // ── 会议：有 meta.json 的会议目录才算一场 ──
      const meetingsDir = join(root, '.agentdeck', 'meetings');
      for (const name of readDirSafe(meetingsDir, warnings)) {
        const metaFile = join(meetingsDir, name, 'meta.json');
        if (!existsSync(metaFile)) continue;
        if (seenMeetings.has(name)) continue;
        seenMeetings.add(name);
        counts.meetings += 1;
        sources.meetings.push(metaFile);
      }

      // ── 自动化：jobs 条数（runs 是执行历史，不算配额） ──
      const automationFile = join(root, '.agentdeck', 'automation', 'state.json');
      if (existsSync(automationFile)) {
        const state = readJsonSafe(automationFile, warnings);
        if (state && Array.isArray(state.jobs)) {
          counts.automations += state.jobs.filter((job) => job && typeof job === 'object' && job.id).length;
          sources.automation.push(automationFile);
        } else if (state) {
          warnings.push(`自动化状态文件形状不对（jobs 不是数组），已跳过：${automationFile}`);
        }
      }

      // ── 记忆：items 条数；同一个文件只数一次 ──
      const twinFile = join(root, '.agentdeck', 'twin', 'memory.json');
      if (existsSync(twinFile) && !seenTwinFiles.has(twinFile)) {
        seenTwinFiles.add(twinFile);
        const memory = readJsonSafe(twinFile, warnings);
        if (memory && Array.isArray(memory.items)) {
          counts.twinEntries += memory.items.length;
          sources.twin.push(twinFile);
        } else if (memory) {
          warnings.push(`记忆文件形状不对（items 不是数组），已跳过：${twinFile}`);
        }
      }
    }

    return {
      ok: true,
      counts,
      total: counts.rooms + counts.meetings + counts.automations + counts.twinEntries,
      sources,
      roots: rootList,
      warnings,
      degraded: warnings.length > 0,
    };
  } catch (err) {
    warnings.push(`统计用量出错，按 0 条算（先放行）：${errText(err)}`);
    return { ok: true, counts, total: 0, sources, roots: rootList, warnings, degraded: true };
  }
}

/** roots 支持 string / string[] / {workspace, global, ...}；去重、转绝对路径。 */
function normalizeRoots(roots) {
  const raw = [];
  if (typeof roots === 'string') raw.push(roots);
  else if (Array.isArray(roots)) raw.push(...roots);
  else if (roots && typeof roots === 'object') {
    for (const value of Object.values(roots)) {
      if (typeof value === 'string') raw.push(value);
      else if (Array.isArray(value)) raw.push(...value);
    }
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    try {
      const abs = resolve(item);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    } catch {
      /* 路径怪就跳过，不抛 */
    }
  }
  return out;
}

/** 读目录：不存在算正常（第一次用），其它错误记 warning 后当空目录。 */
function readDirSafe(dir, warnings) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err?.code !== 'ENOENT') warnings.push(`读取目录失败：${dir}（${errText(err)}）`);
    return [];
  }
}

/** 读 JSON：坏文件记 warning 后返回 null，调用方跳过这一条（少算=放行）。 */
function readJsonSafe(file, warnings) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    warnings.push(`读取 JSON 失败：${file}（${errText(err)}）`);
    return null;
  }
}

/* ────────────────────────── 默认实例（大多数调用方直接用） ────────────────────────── */

const defaultQuota = createQuota();

/** 默认档位表的 check()：纯函数、永不抛。 */
export const check = defaultQuota.check;
/** 默认档位表的批量检查。 */
export const checkMany = defaultQuota.checkMany;
/** 默认档位表的上限查询。 */
export const limitOf = defaultQuota.limitOf;
/** 默认档位表的下一档查询。 */
export const upgradeOf = defaultQuota.upgradeOf;

export default {
  createQuota,
  check,
  checkMany,
  limitOf,
  upgradeOf,
  countUsed,
  serializeCheck,
  DEFAULT_LIMITS,
  LIMITS,
  TIER_ORDER,
  KINDS,
  TIER_META,
  KIND_META,
  UNMETERED_KINDS,
};
