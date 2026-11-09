/**
 * lib/hosting/index.js —— 托管服务层（付费点和真正的护城河）
 *
 * 解决什么：授权码是离线签名的，破解者改两行 JS 就能给自己签一张。
 *   唯一拦得住的是「我们不给他、但服务器才有的东西」——云房间配额、托管分身、
 *   模型额度。这个模块就是那层服务端的账本与配额。
 *
 * 设计约束（来自仓库既有铁律，别破）：
 *   - 零第三方依赖、纯 ESM、Node >= 22。
 *   - 额度计量**内部出错一律放行**：宁可少管，不许拿计量故障拦人干活。
 *   - 持久化用原子写（临时文件 + rename），断电不会留半截 JSON。
 *
 * 它**不是**一个独立服务：它是纯函数库 + 一个可挂到 relay 的 handler。
 * 这样自建 relay 的人一行就能带上配额；托管方也只是同一份代码跑在公网。
 *
 * 诚实边界：本模块只管"账"和"配额"。真正的支付回调、发票、对账在
 *   pro/billing/* 与 pro/market/* 里（闭源商业层），各管一段，不在这里重复实现。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOSTING_VERSION = 1;
export const STATE_FILE = 'hosting.json';
/** 设备令牌默认有效期：与授权码同节奏，30 天。 */
export const TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

/** 每档的托管配额。改这里＝改收费口径，改完必须同步 tests/hosting.test.mjs。 */
export const HOSTING_PLANS = Object.freeze({
  free: Object.freeze({
    id: 'free', label: '免费版',
    cloudRooms: 0, seats: 3, parallel: 1,
    hostedTwinHoursPerDay: 0,
    toolCallsPerDay: 200,
    models: [],
  }),
  plus: Object.freeze({
    id: 'plus', label: '协作版',
    cloudRooms: 20, seats: 8, parallel: 3,
    hostedTwinHoursPerDay: 8,
    toolCallsPerDay: 5000,
    models: ['deepseek-chat'],
  }),
  studio: Object.freeze({
    id: 'studio', label: '工作室版',
    cloudRooms: 50, seats: 30, parallel: 6,
    hostedTwinHoursPerDay: 24,
    toolCallsPerDay: 50000,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  }),
  business: Object.freeze({
    id: 'business', label: '企业版',
    cloudRooms: 200, seats: 200, parallel: 10,
    hostedTwinHoursPerDay: 24,
    toolCallsPerDay: Infinity,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  }),
});

/** 老档位名兼容：1.10.0 之前「协作版」的 tier 写的是 pro。 */
const TIER_ALIAS = Object.freeze({ pro: 'plus' });

export function normalizePlan(tier) {
  const raw = String(tier || 'free').trim().toLowerCase();
  const id = TIER_ALIAS[raw] || raw;
  return HOSTING_PLANS[id] ? id : 'free';
}

export function planOf(tier) {
  return HOSTING_PLANS[normalizePlan(tier)];
}

function str(value, max = 200) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 设备 id 只收安全字符：它会进文件名和日志，不能带路径分隔符。 */
export function safeDeviceId(value) {
  const s = str(value, 80);
  if (!s) return '';
  if (s.includes('..') || s.includes('/') || s.includes('\\') || s.includes(':')) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return '';
  return s;
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** 托管状态的落盘根目录（和 relay 的 --data 同一个根）。 */
export function hostingRoot(root) {
  return join(String(root || process.cwd()), 'hosting');
}

export function stateFile(root) {
  return join(hostingRoot(root), STATE_FILE);
}

/** 空状态。 */
export function emptyState() {
  return {
    v: HOSTING_VERSION,
    /** token → { deviceId, tier, exp, issuedAt, revokedAt, used: { day, toolCalls }, rooms: [] } */
    // 必须是 null-prototype：普通对象的 `__proto__` / `constructor` 会命中继承属性，
    // 让任意字符串冒充令牌（第 18 轮自检抓到）。
    tokens: Object.create(null),
  };
}

/** 这些键永远不能当令牌名：它们会命中 Object.prototype 或改写原型。 */
const FORBIDDEN_TOKEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** 安全取令牌记录：只认 own property，且拒绝原型相关的特殊键。 */
function tokenEntry(state, token) {
  const key = str(token, 200);
  if (!key || FORBIDDEN_TOKEN_KEYS.has(key)) return null;
  if (!Object.prototype.hasOwnProperty.call(state.tokens, key)) return null;
  return state.tokens[key];
}

/**
 * 读状态。任何情况下都返回一个可用对象，绝不 throw：
 *   - 不存在 → 空状态
 *   - JSON 坏了 → 空状态 + recovered:true（老文件没被动过，可人工救）
 */
export function loadState({ root } = {}) {
  const file = stateFile(root);
  try {
    if (!existsSync(file)) return { ok: true, missing: true, state: emptyState(), file };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'corrupt', recovered: true, state: emptyState(), file };
    }
    const state = emptyState();
    const tokens = raw.tokens && typeof raw.tokens === 'object' && !Array.isArray(raw.tokens) ? raw.tokens : {};
    for (const [key, entry] of Object.entries(tokens)) {
      if (!key || !entry || typeof entry !== 'object') continue;
      if (FORBIDDEN_TOKEN_KEYS.has(key)) continue;
      state.tokens[key] = {
        deviceId: safeDeviceId(entry.deviceId),
        tier: normalizePlan(entry.tier),
        exp: Number(entry.exp) || 0,
        issuedAt: Number(entry.issuedAt) || 0,
        revokedAt: entry.revokedAt ? String(entry.revokedAt) : null,
        used: {
          day: String(entry?.used?.day || ''),
          toolCalls: Math.max(0, Math.floor(Number(entry?.used?.toolCalls) || 0)),
        },
        rooms: Array.isArray(entry.rooms) ? entry.rooms.map((r) => str(r, 80)).filter(Boolean).slice(0, 500) : [],
      };
    }
    return { ok: true, missing: false, state, file };
  } catch (err) {
    return { ok: false, code: 'io', recovered: true, state: emptyState(), file, error: String(err?.message || err) };
  }
}

export function saveState({ root, state } = {}) {
  const file = stateFile(root);
  try {
    mkdirSync(hostingRoot(root), { recursive: true });
    writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file, error: String(err?.message || err) };
  }
}

/** 本地日历上的"今天"（按 UTC 切，服务端统一口径，免得跨时区对不上账）。 */
export function dayKey(ms = Date.now()) {
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

function newToken() {
  // 不引第三方依赖：用 crypto 的随机字节自己编。
  const bytes = new Uint8Array(24);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `hst_${Buffer.from(bytes).toString('base64url')}`;
}

/**
 * 用离线授权码换一个设备令牌。
 *
 * @param {object} opts
 * @param {string} opts.root      托管状态根
 * @param {string} opts.code      客户的 ADSK1 授权码
 * @param {string} opts.deviceId  设备指纹
 * @param {Function} opts.verify  (code) => { ok, tier, claims, reason } —— 由调用方注入
 *                                （复用 lib/license.js 的 verifyLicense，不在这里重复实现验签）
 * @param {number} [opts.now]
 */
export function activate({ root, code, deviceId, verify, now = Date.now() } = {}) {
  const dev = safeDeviceId(deviceId);
  if (!dev) return { ok: false, code: 'bad_device', reason: 'deviceId 必须是安全的设备标识（字母数字._-）', status: 400 };
  const raw = str(code, 4096);
  if (!raw) return { ok: false, code: 'missing_code', reason: '没有授权码', status: 400 };
  if (typeof verify !== 'function') {
    return { ok: false, code: 'no_verifier', reason: '服务端没配验签器（自己搭的 relay 要注入 verify）', status: 500 };
  }

  let verdict;
  try {
    verdict = verify(raw);
  } catch (err) {
    return { ok: false, code: 'verify_error', reason: `验签出错：${err?.message || err}`, status: 500 };
  }
  if (!verdict || !verdict.ok) {
    return { ok: false, code: 'bad_license', reason: verdict?.reason || '授权码无效', status: 402 };
  }

  const tier = normalizePlan(verdict.tier);
  const loaded = loadState({ root });
  const state = loaded.state;
  const token = newToken();
  state.tokens[token] = {
    deviceId: dev,
    tier,
    exp: Math.floor(Number(now) / 1000) + TOKEN_TTL_SEC,
    issuedAt: Math.floor(Number(now) / 1000),
    revokedAt: null,
    used: { day: dayKey(now), toolCalls: 0 },
    rooms: [],
  };
  const saved = saveState({ root, state });
  if (!saved.ok) return { ok: false, code: 'io', reason: `托管状态写盘失败：${saved.error}`, status: 500 };

  return {
    ok: true,
    token,
    deviceId: dev,
    tier,
    exp: state.tokens[token].exp,
    plan: planOf(tier),
    status: 200,
  };
}

/** 解析 Bearer token → 令牌记录。吊销/过期一律当作"不存在"。 */
export function resolveToken({ root, token, now = Date.now() } = {}) {
  const key = str(token, 200);
  if (!key) return { ok: false, code: 'no_token', reason: '没有令牌', status: 401 };
  const loaded = loadState({ root });
  const entry = tokenEntry(loaded.state, key);
  if (!entry) return { ok: false, code: 'unknown_token', reason: '认不出这个令牌', status: 401 };
  if (entry.revokedAt) return { ok: false, code: 'revoked', reason: '这个令牌已被吊销', status: 403 };
  const nowSec = Math.floor(Number(now) / 1000);
  if (entry.exp && nowSec > entry.exp) return { ok: false, code: 'expired', reason: '令牌已过期，请重新激活', status: 403 };
  return { ok: true, token: key, entry, tier: entry.tier, plan: planOf(entry.tier), status: 200 };
}

export function revokeToken({ root, token, now = Date.now() } = {}) {
  const loaded = loadState({ root });
  const entry = tokenEntry(loaded.state, token);
  if (!entry) return { ok: false, code: 'unknown_token', reason: '认不出这个令牌', status: 404 };
  entry.revokedAt = new Date(Number(now)).toISOString();
  const saved = saveState({ root, state: loaded.state });
  if (!saved.ok) return { ok: false, code: 'io', reason: saved.error, status: 500 };
  return { ok: true, revokedAt: entry.revokedAt, status: 200 };
}

/** 今日用量（跨天自动归零——不需要常驻定时器）。 */
export function usageOf(entry, now = Date.now()) {
  const today = dayKey(now);
  if (!entry?.used || entry.used.day !== today) return { day: today, toolCalls: 0 };
  return { day: today, toolCalls: Math.max(0, Math.floor(Number(entry.used.toolCalls) || 0)) };
}

/**
 * 记一次工具调用。
 * **内部出错一律放行**——计量故障不该拦住干活的人（这是仓库既有原则）。
 */
export function recordUsage({ root, token, cost = 1, now = Date.now() } = {}) {
  try {
    const loaded = loadState({ root });
    const entry = tokenEntry(loaded.state, token);
    if (!entry) return { ok: false, code: 'unknown_token', counted: false, reason: '认不出这个令牌' };
    const u = usageOf(entry, now);
    entry.used = { day: u.day, toolCalls: u.toolCalls + Math.max(1, Math.floor(Number(cost) || 1)) };
    saveState({ root, state: loaded.state });
    return { ok: true, counted: true, used: entry.used.toolCalls };
  } catch (err) {
    return { ok: false, code: 'metering_failed', counted: false, reason: String(err?.message || err) };
  }
}

/**
 * 配额检查：这一步能不能干？
 * kind: 'toolCalls' | 'rooms'
 * 返回 { ok, allowed, used, limit, reason }
 */
export function checkQuota({ root, token, kind = 'toolCalls', cost = 1, now = Date.now() } = {}) {
  const resolved = resolveToken({ root, token, now });
  if (!resolved.ok) return { ok: false, allowed: false, code: resolved.code, reason: resolved.reason, status: resolved.status };
  const plan = resolved.plan;
  const entry = resolved.entry;

  if (kind === 'rooms') {
    const limit = plan.cloudRooms;
    const used = Array.isArray(entry.rooms) ? entry.rooms.length : 0;
    // 注意：limit 只来自代码里的 HOSTING_PLANS（不落盘），所以 Infinity 是可信的。
    // 但调用方可能把 limit 转手写进 JSON（Infinity → null），所以这里两种都认。
    if (limit === Infinity || limit === null) return { ok: true, allowed: true, used, limit: -1, unlimited: true };
    if (limit <= 0) {
      return { ok: true, allowed: false, used, limit, code: 'plan_no_cloud_rooms', reason: '当前档位没有云房间额度（免费版只支持本地房间）' };
    }
    if (used + 1 > limit) {
      return { ok: true, allowed: false, used, limit, code: 'room_limit', reason: `云房间已用满（${used}/${limit}）` };
    }
    return { ok: true, allowed: true, used, limit };
  }

  // 默认按工具调用算
  const limit = plan.toolCallsPerDay;
  const used = usageOf(entry, now).toolCalls;
  if (limit === Infinity || limit === null) return { ok: true, allowed: true, used, limit: -1, unlimited: true };
  const want = Math.max(1, Math.floor(Number(cost) || 1));
  if (used + want > limit) {
    return { ok: true, allowed: false, used, limit, code: 'tool_call_limit', reason: `今日调用额度用满（${used}/${limit}）` };
  }
  return { ok: true, allowed: true, used, limit };
}

/**
 * 把一次建房间记进令牌账本（配额是"服务端才有的东西"，所以必须在这里记，不能靠客户端自报）。
 * 返回 false 表示超配额，调用方应直接拒绝建房。
 */
export function claimRoom({ root, token, roomId, now = Date.now() } = {}) {
  const check = checkQuota({ root, token, kind: 'rooms', now });
  if (!check.ok || !check.allowed) return { ok: false, code: check.code || 'quota', reason: check.reason, status: check.status || 402 };
  const loaded = loadState({ root });
  const entry = tokenEntry(loaded.state, token);
  if (!entry) return { ok: false, code: 'unknown_token', reason: '认不出这个令牌', status: 401 };
  const id = str(roomId, 80);
  if (id && !entry.rooms.includes(id)) entry.rooms.push(id);
  const saved = saveState({ root, state: loaded.state });
  if (!saved.ok) return { ok: false, code: 'io', reason: saved.error, status: 500 };
  return { ok: true, used: entry.rooms.length, limit: planOf(entry.tier).cloudRooms, status: 200 };
}

/** 释放一个房间额度（房主关房时调）。 */
export function releaseRoom({ root, token, roomId } = {}) {
  const loaded = loadState({ root });
  const entry = tokenEntry(loaded.state, token);
  if (!entry) return { ok: false, code: 'unknown_token', reason: '认不出这个令牌', status: 401 };
  const id = str(roomId, 80);
  const before = entry.rooms.length;
  entry.rooms = entry.rooms.filter((r) => r !== id);
  if (entry.rooms.length === before) return { ok: true, released: false, status: 200 };
  saveState({ root, state: loaded.state });
  return { ok: true, released: true, used: entry.rooms.length, status: 200 };
}

/** 从 Authorization: Bearer xxx 里抠出 token。 */
export function bearerOf(headers) {
  const raw = headers && typeof headers === 'object'
    ? headers.authorization ?? headers.Authorization ?? ''
    : '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : '';
}

/**
 * 托管 API 的 handler。挂到既有 HTTP 服务上：
 *   POST /v1/activate  { code, deviceId }        → { token, tier, exp, plan }
 *   POST /v1/usage     { tokens }                → { quotaLeft }
 *   GET  /v1/plans                               → 档位表（公开）
 *   POST /v1/rooms/claim { roomId }              → 建房配额（Bearer）
 *   POST /v1/rooms/release { roomId }            → 关房释放（Bearer）
 *
 * 返回 null 表示"这不是我的路由"（调用方继续往下试），和 lib/engine/adbp.js 约定一致。
 */
export function createHostingApi({ root, verify, now = () => Date.now(), log = () => {} } = {}) {
  const respond = (status, json) => ({ status, json });

  return function handleHosting(method, path, body, headers) {
    const p = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
    const clock = typeof now === 'function' ? now() : Number(now) || Date.now();

    if (method === 'GET' && p === '/v1/plans') {
      return respond(200, { ok: true, version: HOSTING_VERSION, plans: Object.values(HOSTING_PLANS) });
    }

    if (method === 'POST' && p === '/v1/activate') {
      const res = activate({ root, code: body?.code, deviceId: body?.deviceId, verify, now: clock });
      if (!res.ok) log(`激活失败：${res.code} ${res.reason}`);
      return respond(res.status || 400, res.ok
        ? { ok: true, token: res.token, tier: res.tier, exp: res.exp, plan: res.plan }
        : { ok: false, code: res.code, reason: res.reason });
    }

    if (method === 'POST' && p === '/v1/usage') {
      const token = bearerOf(headers);
      const cost = body?.tokens;
      if (cost === undefined) {
        const check = checkQuota({ root, token, kind: 'toolCalls', now: clock });
        if (!check.ok) return respond(check.status || 401, { ok: false, code: check.code, reason: check.reason });
        return respond(200, {
          ok: true,
          used: check.used,
          limit: check.limit,
          quotaLeft: check.unlimited ? -1 : Math.max(0, check.limit - check.used),
        });
      }
      const rec = recordUsage({ root, token, cost: Number(cost) || 1, now: clock });
      if (!rec.ok) return respond(401, { ok: false, code: rec.code, reason: rec.reason });
      const check = checkQuota({ root, token, kind: 'toolCalls', now: clock });
      return respond(200, {
        ok: true,
        used: rec.used,
        limit: check.limit,
        quotaLeft: check.unlimited ? -1 : Math.max(0, check.limit - rec.used),
      });
    }

    if (method === 'POST' && p === '/v1/rooms/claim') {
      const token = bearerOf(headers);
      const res = claimRoom({ root, token, roomId: body?.roomId, now: clock });
      return respond(res.status || (res.ok ? 200 : 402), res.ok
        ? { ok: true, used: res.used, limit: res.limit === Infinity ? -1 : res.limit }
        : { ok: false, code: res.code, reason: res.reason });
    }

    if (method === 'POST' && p === '/v1/rooms/release') {
      const token = bearerOf(headers);
      const res = releaseRoom({ root, token, roomId: body?.roomId });
      return respond(res.status || (res.ok ? 200 : 400), res.ok
        ? { ok: true, released: res.released, used: res.used ?? null }
        : { ok: false, code: res.code, reason: res.reason });
    }

    // 不是托管路由：交给下一个 handler（和 adbp 的约定一致）
    return null;
  };
}

export default {
  HOSTING_VERSION,
  HOSTING_PLANS,
  normalizePlan,
  planOf,
  safeDeviceId,
  hostingRoot,
  stateFile,
  emptyState,
  loadState,
  saveState,
  dayKey,
  activate,
  resolveToken,
  revokeToken,
  usageOf,
  recordUsage,
  checkQuota,
  claimRoom,
  releaseRoom,
  bearerOf,
  createHostingApi,
};
