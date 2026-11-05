/**
 * lib/pet/visit.js —— 串门（第一次见面的握手 + 便签）
 *
 * 一次串门分三段：
 *   1. 主人发邀请函：makeInvite → { token, url:'dsh://agentdeck/visit?t=<token>', exp }
 *      邀请函自带有效期（ttlMs）和范围（scope: visit 只看热闹 / work 可以派活）；
 *   2. 客人收邀请：acceptInvite → 校验有效期、范围、签名，回一张**只有名片**的卡片
 *      （name / petSkin / habitsTop3 / capabilities），不交任何原始数据；
 *   3. 双方互留便签：makeNote({kind:'gift'|'ask'}) → receiveNote → 礼物记一条事件，求助落一条任务。
 *
 * 跨机器靠注入的 http（形状 { post(url, body) }），**本模块绝不自己起服务、绝不联网**。
 *
 * 隐私底线：跨机器只走名片与便签，原始信号（signals/seen/stats 明细）永远不出门。
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 邀请函默认有效期：一天 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 有效期上下夹子：最少 1 分钟，最多 30 天 */
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 串门范围 */
export const VISIT_SCOPES = ['visit', 'work'];
/** 串门记录（JSONL）文件名 */
export const VISIT_LOG_FILE = 'visits.log';
/** 每台机器一份的签名密钥文件名 */
export const VISIT_SECRET_FILE = 'visit-secret';
/** 便签类型 */
export const NOTE_KINDS = ['gift', 'ask'];
/** 名片里最多带几条习惯 */
const HABITS_TOP = 3;
/** 名片里最多带几项能力 */
const MAX_CAPABILITIES = 8;

const secretCache = new Map();

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.getTime === 'function') return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nowOf(clock) {
  if (typeof clock !== 'function') return Date.now();
  try {
    const value = clock();
    const ms = toMs(value);
    return ms === null ? Date.now() : ms;
  } catch {
    return Date.now();
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function unb64u(text) {
  return Buffer.from(String(text), 'base64url').toString('utf8');
}

function newId(prefix) {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把 profile store 或裸 profile 统一成 { profile, root } */
export function resolveProfileInput(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: '需要一份桌宠档案（profile）' };
  if (typeof input.get === 'function') {
    let profile = null;
    try {
      profile = input.get();
    } catch (err) {
      return { ok: false, reason: `读档案失败：${err && err.message ? err.message : err}` };
    }
    const root = typeof input.root === 'string' && input.root ? input.root : null;
    return { ok: true, profile, store: input, root };
  }
  if (typeof input.name === 'string') return { ok: true, profile: input, store: null, root: null };
  return { ok: false, reason: '需要一份桌宠档案（profile）' };
}

/**
 * 对外名片：只挑能见人的字段。
 * 明确**不**包含 signals / seen / days / stats 明细 / persona 原文。
 */
export function profileCard(input) {
  const resolved = resolveProfileInput(input);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const profile = resolved.profile || {};
  const skins = isPlainObject(profile.skins) ? profile.skins : {};
  const habits = Array.isArray(profile.habits) ? profile.habits : [];
  const habitsTop3 = habits
    .filter((habit) => habit && typeof habit === 'object' && str(habit.label))
    .slice()
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, HABITS_TOP)
    .map((habit) => ({
      key: str(habit.key),
      label: str(habit.label),
      confidence: Number(habit.confidence) || 0,
    }));

  const card = {
    name: str(profile.name, '一个数字分身'),
    petSkin: str(skins.active, 'basic'),
    habitsTop3,
    capabilities: capabilitiesOf(profile),
  };
  return { ok: true, card, root: resolved.root };
}

/** 能力清单：档案里写了就用档案的，没写就从习惯里推，实在没有给个保守默认 */
function capabilitiesOf(profile) {
  const explicit =
    (isPlainObject(profile.traits) && Array.isArray(profile.traits.capabilities) && profile.traits.capabilities) ||
    (Array.isArray(profile.capabilities) && profile.capabilities) ||
    [];
  const clean = explicit.map((item) => str(item)).filter(Boolean).slice(0, MAX_CAPABILITIES);
  if (clean.length) return clean;

  const fromHabits = (Array.isArray(profile.habits) ? profile.habits : [])
    .map((habit) => str(habit && habit.label))
    .filter(Boolean)
    .slice(0, 5);
  if (fromHabits.length) return fromHabits;
  return ['聊天', '记笔记'];
}

/** 本机签名密钥：有 root 就落盘复用，没有就用进程内临时密钥（重启即失效） */
function loadSecret(root) {
  if (!root) {
    const secret = randomBytes(32).toString('hex');
    return { secret, sid: sidOf(secret), path: null, ephemeral: true };
  }
  const dir = path.join(root, '.agentdeck', 'pet');
  const file = path.join(dir, VISIT_SECRET_FILE);
  const cached = secretCache.get(file);
  if (cached) return cached;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      const text = String(fs.readFileSync(file, 'utf8')).trim();
      if (/^[0-9a-f]{64}$/i.test(text)) {
        const record = { secret: text.toLowerCase(), sid: sidOf(text), path: file, ephemeral: false };
        secretCache.set(file, record);
        return record;
      }
    }
    const secret = randomBytes(32).toString('hex');
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    const record = { secret, sid: sidOf(secret), path: file, ephemeral: false };
    secretCache.set(file, record);
    return record;
  } catch {
    // 盘写不了就退化到临时密钥：串门照旧能用，只是重开进程后旧邀请函验不了签
    const secret = randomBytes(32).toString('hex');
    const record = { secret, sid: sidOf(secret), path: null, ephemeral: true };
    secretCache.set(file, record);
    return record;
  }
}

/** 密钥指纹：用来判断一张邀请函是不是本机发的（不泄露密钥本身） */
function sidOf(secret) {
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
}

function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/** 串门记录：JSONL 追加，写不了就算了（不抛） */
function appendVisitLog(root, entry) {
  if (!root) return { ok: false, reason: '没有工作区路径，串门记录没落盘' };
  try {
    const dir = path.join(root, '.agentdeck', 'pet');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, VISIT_LOG_FILE);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

/** 读串门记录（测试/运维用；坏行跳过） */
export function readVisitLog({ root, limit = 200 } = {}) {
  if (!root) return { ok: false, reason: '需要工作区路径', entries: [] };
  const file = path.join(String(root), '.agentdeck', 'pet', VISIT_LOG_FILE);
  try {
    if (!fs.existsSync(file)) return { ok: true, path: file, entries: [] };
    const lines = String(fs.readFileSync(file, 'utf8')).split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (isPlainObject(parsed)) entries.push(parsed);
      } catch {
        // 坏行跳过，不污染结果
      }
    }
    return { ok: true, path: file, entries: entries.slice(-Math.max(1, Number(limit) || 200)) };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err), entries: [] };
  }
}

function clampTtl(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(n)));
}

/**
 * 造一张邀请函。
 * @param {{profile:object, ttlMs?:number, scope?:'visit'|'work', now?:Function, root?:string, reply?:string, log?:Function}} opts
 */
export function makeInvite({ profile, ttlMs = DEFAULT_TTL_MS, scope = 'visit', now, root, reply, log } = {}) {
  const resolved = resolveProfileInput(profile);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const cardResult = profileCard(resolved.profile);
  if (!cardResult.ok) return { ok: false, reason: cardResult.reason };

  const scopeValue = str(scope, 'visit');
  if (!VISIT_SCOPES.includes(scopeValue)) return { ok: false, reason: `串门范围只能是 ${VISIT_SCOPES.join(' / ')}，收到的是 ${scopeValue}` };

  const ttl = clampTtl(ttlMs);
  const baseMs = nowOf(now);
  const expMs = baseMs + ttl;
  const rootValue = str(root) || resolved.root;
  const secretInfo = loadSecret(rootValue);

  const payload = {
    v: 1,
    kind: 'invite',
    id: newId('visit'),
    from: cardResult.card,
    scope: scopeValue,
    iat: baseMs,
    exp: expMs,
    sid: secretInfo.sid,
  };
  const replyUrl = str(reply);
  if (/^https?:\/\//i.test(replyUrl)) payload.reply = replyUrl;

  const body = b64u(JSON.stringify(payload));
  const token = `${body}.${sign(secretInfo.secret, body)}`;
  const url = `dsh://agentdeck/visit?t=${token}`;

  const logged = appendVisitLog(rootValue, {
    at: iso(baseMs),
    event: 'invite',
    visitId: payload.id,
    scope: scopeValue,
    exp: iso(expMs),
    guest: payload.from.name,
  });

  return {
    ok: true,
    token,
    url,
    exp: iso(expMs),
    expMs,
    id: payload.id,
    scope: scopeValue,
    card: payload.from,
    secretPath: secretInfo.path,
    ephemeralSecret: secretInfo.ephemeral,
    logged: logged.ok,
    ...(typeof log === 'function' && logged.ok === false ? { logWarning: logged.reason } : {}),
  };
}

/**
 * 解析一张邀请函（不产生副作用，供 acceptInvite 和排查用）。
 * 校验顺序：格式 → 版本 → 类型 → 有效期 → 范围 → 签名（本机签的才验）。
 */
export function readInviteToken(token, { now, root } = {}) {
  const raw = str(token);
  if (!raw) return { ok: false, reason: '邀请链接里没有凭证', code: 'no_token' };
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: '邀请凭证格式不对', code: 'bad_format' };

  let payload = null;
  try {
    payload = JSON.parse(unb64u(parts[0]));
  } catch {
    return { ok: false, reason: '邀请凭证解析不出来', code: 'bad_payload' };
  }
  if (!isPlainObject(payload)) return { ok: false, reason: '邀请凭证解析不出来', code: 'bad_payload' };
  if (payload.v !== 1) return { ok: false, reason: `邀请凭证版本不认识：${payload.v}`, code: 'bad_version' };
  if (payload.kind !== 'invite') return { ok: false, reason: '这不是一张串门邀请函', code: 'bad_kind' };

  const expMs = toMs(payload.exp);
  if (expMs === null) return { ok: false, reason: '邀请凭证没有有效期', code: 'no_exp' };
  const nowMs = nowOf(now);
  if (expMs <= nowMs) return { ok: false, reason: '这张邀请已经过期了', code: 'expired', exp: iso(expMs) };

  const scope = str(payload.scope);
  if (!VISIT_SCOPES.includes(scope)) return { ok: false, reason: `邀请的串门范围不认识：${scope || '（空）'}`, code: 'bad_scope' };

  if (!isPlainObject(payload.from) || !str(payload.from.name)) {
    return { ok: false, reason: '邀请凭证里没有主人的名片', code: 'no_card' };
  }

  // 签名：只有本机发的（sid 对得上）才验，跨机器没法验也不该假装验过
  const secretInfo = loadSecret(str(root) || null);
  let verified = false;
  let verifyNote = '跨机器的邀请只能在本地做格式校验';
  if (str(payload.sid) && safeEqual(payload.sid, secretInfo.sid)) {
    const expected = sign(secretInfo.secret, parts[0]);
    if (!safeEqual(expected, parts[1])) {
      return { ok: false, reason: '邀请凭证的签名对不上，可能被改过', code: 'bad_signature' };
    }
    verified = true;
    verifyNote = '本机签发，签名校验通过';
  } else if (secretInfo.ephemeral) {
    verifyNote = '没有工作区密钥，签名无法校验';
  }

  return {
    ok: true,
    verified,
    verifyNote,
    payload: clone(payload),
    host: clone(payload.from),
    scope,
    exp: iso(expMs),
    expMs,
    id: str(payload.id),
    reply: str(payload.reply),
  };
}

/**
 * 收邀请：校验 → 回名片 → 可选地把名片交给注入的 http 送回去。
 * 注意：这里**不碰档案**，串门是只读的社交。
 */
export function acceptInvite({ token, profile, http, now, root, expectedScope, log } = {}) {
  const resolved = resolveProfileInput(profile);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const rootValue = str(root) || resolved.root;
  const parsed = readInviteToken(token, { now, root: rootValue });
  if (!parsed.ok) return parsed;

  if (str(expectedScope) && str(expectedScope) !== parsed.scope) {
    return { ok: false, reason: `这张邀请的范围是 ${parsed.scope}，不是 ${str(expectedScope)}`, code: 'scope_mismatch' };
  }

  const mine = profileCard(resolved.profile);
  if (!mine.ok) return { ok: false, reason: mine.reason };
  const myCard = mine.card;

  let handshake = 'manual';
  let handshakeError = '';
  let hostCard = parsed.host;
  if (parsed.reply && http && typeof http.post === 'function') {
    try {
      const response = http.post(parsed.reply, { token: String(token), card: myCard });
      if (response && typeof response.then === 'function') {
        // 注进来的 http 是异步的：名片递出去了，但这次拿不到回执
        handshake = 'sent';
      } else if (response && isPlainObject(response) && isPlainObject(response.card)) {
        hostCard = response.card;
        handshake = 'exchange';
      } else if (response && response.ok === false) {
        handshake = 'failed';
        handshakeError = str(response.reason, '对方没接住名片');
      } else {
        handshake = 'exchange';
      }
    } catch (err) {
      handshake = 'failed';
      handshakeError = err && err.message ? err.message : String(err);
    }
  }

  const logged = appendVisitLog(rootValue, {
    at: iso(nowOf(now)),
    event: 'accept',
    visitId: parsed.id,
    scope: parsed.scope,
    host: parsed.host.name,
    verified: parsed.verified,
    handshake,
  });

  return {
    ok: true,
    verified: parsed.verified,
    verifyNote: parsed.verifyNote,
    visitId: parsed.id,
    scope: parsed.scope,
    exp: parsed.exp,
    hostCard,
    myCard,
    handshake,
    ...(handshakeError ? { handshakeError } : {}),
    logged: logged.ok,
    ...(handshake === 'failed' && typeof log === 'function' ? { logWarning: handshakeError } : {}),
  };
}

/**
 * 造一张便签：gift（礼物）/ ask（求助）。
 * @param {{profile:object, kind:'gift'|'ask', payload:object, now?:Function, root?:string, to?:string, log?:Function}} opts
 */
export function makeNote({ profile, kind, payload, now, root, to, log } = {}) {
  const resolved = resolveProfileInput(profile);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const kindValue = str(kind);
  if (!NOTE_KINDS.includes(kindValue)) return { ok: false, reason: `便签类型只能是 ${NOTE_KINDS.join(' / ')}，收到的是 ${kindValue || '（空）'}` };
  if (!isPlainObject(payload)) return { ok: false, reason: '便签得带点内容（payload）' };

  const card = profileCard(resolved.profile);
  if (!card.ok) return { ok: false, reason: card.reason };

  const body = clone(payload) || {};
  if (kindValue === 'ask' && !str(body.title)) return { ok: false, reason: '求助便签得有个标题（payload.title）' };
  if (kindValue === 'gift' && !str(body.skin) && !str(body.message)) {
    return { ok: false, reason: '礼物便签得带点东西：皮肤（skin）或者一句话（message）' };
  }

  const baseMs = nowOf(now);
  const note = {
    v: 1,
    kind: kindValue,
    id: newId('note'),
    from: card.card,
    at: iso(baseMs),
    payload: body,
  };
  const toName = str(to);
  if (toName) note.to = toName;

  const rootValue = str(root) || resolved.root;
  const logged = appendVisitLog(rootValue, {
    at: note.at,
    event: 'note-out',
    kind: kindValue,
    noteId: note.id,
    to: toName || null,
  });

  return { ok: true, note, logged: logged.ok, ...(typeof log === 'function' && !logged.ok ? { logWarning: logged.reason } : {}) };
}

/**
 * 收便签：ask 落一条任务，gift 记一条事件。
 * 任务板写不进去就如实报错，绝不假装成功。
 */
export function receiveNote({ note, board, teamId, now, root, log } = {}) {
  if (!isPlainObject(note)) return { ok: false, reason: '收到的不是一张便签' };
  if (note.v !== undefined && note.v !== 1) return { ok: false, reason: `便签版本不认识：${note.v}` };
  const kind = str(note.kind);
  if (!NOTE_KINDS.includes(kind)) return { ok: false, reason: `便签类型不认识：${kind || '（空）'}` };
  const payload = isPlainObject(note.payload) ? note.payload : {};
  const noteId = str(note.id, 'note_unknown');
  const guest = isPlainObject(note.from) ? str(note.from.name, '一位朋友') : '一位朋友';

  if (!board || typeof board !== 'object') return { ok: false, reason: '收便签需要任务板（board）' };
  const rootValue = str(root);

  if (kind === 'ask') {
    const title = str(payload.title);
    if (!title) return { ok: false, reason: '这张求助便签没有标题' };
    const id = str(teamId);
    if (!id) return { ok: false, reason: '收求助便签得指明落到哪个队（teamId）' };
    if (typeof board.addTask !== 'function') return { ok: false, reason: '任务板缺少 addTask' };
    let task = null;
    try {
      task = board.addTask(id, {
        title,
        role: str(payload.role, 'worker'),
        acceptance: str(payload.acceptance) || null,
        context: {
          from: 'pet_visit',
          noteId,
          guest,
          ask: str(payload.note),
          scope: str(note.scope, 'visit'),
        },
      });
    } catch (err) {
      return { ok: false, reason: `求助便签没落进任务板：${err && err.message ? err.message : err}` };
    }
    if (!task || !task.id) return { ok: false, reason: '求助便签没落进任务板' };
    const logged = appendVisitLog(rootValue, {
      at: iso(nowOf(now)),
      event: 'note-in',
      kind,
      noteId,
      taskId: task.id,
      guest,
    });
    return { ok: true, kind, noteId, taskId: task.id, task, guest, logged: logged.ok, ...(logged.ok ? {} : { logWarning: logged.reason }) };
  }

  // gift：只记一条事件，不往任务板塞活
  if (typeof board.appendEvent !== 'function') return { ok: false, reason: '任务板缺少 appendEvent' };
  const id = str(teamId);
  if (!id) return { ok: false, reason: '收礼物便签得指明落在哪个队（teamId）' };
  let event = null;
  try {
    event = board.appendEvent(id, {
      kind: 'visit/gift',
      text: `收到${guest}的礼物${str(payload.skin) ? `：皮肤 ${str(payload.skin)}` : ''}${str(payload.message) ? `，附言「${str(payload.message)}」` : ''}`,
      noteId,
      gift: clone(payload),
      guest,
    });
  } catch (err) {
    return { ok: false, reason: `礼物没记进任务板：${err && err.message ? err.message : err}` };
  }
  if (!event) return { ok: false, reason: '礼物没记进任务板' };
  const logged = appendVisitLog(rootValue, { at: iso(nowOf(now)), event: 'note-in', kind, noteId, guest });
  return { ok: true, kind, noteId, event, guest, logged: logged.ok, ...(logged.ok ? {} : { logWarning: logged.reason }) };
}

/**
 * 串门宿主：把档案/任务板/时钟绑好，给上层一组顺手的方法。
 * @param {{profile:object, board:object, log?:Function, root?:string, http?:object, now?:Function}} deps
 */
export function createVisitHost({ profile, board, log, root, http, now } = {}) {
  const resolved = resolveProfileInput(profile);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const rootValue = str(root) || resolved.root || null;
  const clock = typeof now === 'function' ? now : null;

  return {
    ok: true,
    root: rootValue,
    /** 自己的名片（只读，不含隐私明细） */
    card: () => profileCard(resolved.profile),
    makeInvite: (opts = {}) => makeInvite({ ...opts, profile: opts.profile || resolved.profile, root: rootValue, now: opts.now || clock, log }),
    acceptInvite: (opts = {}) =>
      acceptInvite({
        ...opts,
        profile: opts.profile || resolved.profile,
        http: opts.http || http,
        root: rootValue,
        now: opts.now || clock,
        log,
      }),
    makeNote: (opts = {}) => makeNote({ ...opts, profile: opts.profile || resolved.profile, root: rootValue, now: opts.now || clock, log }),
    receiveNote: (opts = {}) => receiveNote({ ...opts, board: opts.board || board, root: opts.root || rootValue, now: opts.now || clock, log }),
    /** 串门记录（JSONL） */
    readLog: (opts = {}) => readVisitLog({ root: rootValue, ...opts }),
  };
}

export default { createVisitHost, makeInvite, acceptInvite, makeNote, receiveNote, readInviteToken, profileCard, readVisitLog };
