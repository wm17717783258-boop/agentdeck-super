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

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deriveSharedKey, fingerprint, loadBoxKey, sealJson, openSealed, aadOf } from './e2ee.js';

/** 邀请函默认有效期：一天 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 有效期上下夹子：最少 1 分钟，最多 30 天 */
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 串门范围 */
export const VISIT_SCOPES = ['visit', 'work'];
/** 串门记录（JSONL）文件名 */
export const VISIT_LOG_FILE = 'visits.log';
/** 每台机器一份的签名密钥文件名（v1 的 HMAC 密钥，只为读得懂旧邀请函才留着） */
export const VISIT_SECRET_FILE = 'visit-secret';
/** v2 的 Ed25519 密钥对：公钥进邀请函，所以**任何机器都能验签** */
export const VISIT_KEY_FILE = 'visit-key.json';
/** 邀请函当前版本：2 = Ed25519（跨机器可验）；1 = HMAC（只有本机能验，旧的照旧读得懂） */
export const VISIT_TOKEN_VERSION = 2;
const KEY_ALG = 'ed25519';
/** 便签类型 */
export const NOTE_KINDS = ['gift', 'ask'];
/** 名片里最多带几条习惯 */
const HABITS_TOP = 3;
/** 名片里最多带几项能力 */
const MAX_CAPABILITIES = 8;

const secretCache = new Map();
/** v2 密钥对缓存：一个工作区只生成/读一次 */
const keyCache = new Map();

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

/* ------------------------------ v2：Ed25519 ------------------------------
 * 为什么换成非对称：HMAC 的密钥在**发邀请的那台机器**上，别人手里没有，
 * 所以跨机器只能做格式校验（页面里也一直是这么写实的）。
 * 换成 Ed25519 后公钥随邀请函一起发出去，收的人**手里就有能验的东西**——
 * 能证明的是「这张名片自签发后一个字节都没被改过，确实由 kid_xxx 那个私钥签的」；
 * 证明不了的仍然照实说：这个私钥到底是谁的，得你自己知道链接是谁发的。
 * 想更强就得有身份绑定（域名/DID/交换平台），那是后面的事，这里不假装有了。
 * ---------------------------------------------------------------------- */

/** 公钥指纹：16 位十六进制，人眼看得出「是不是同一个人发的」 */
function kidOf(pub) {
  return `kid_${createHash('sha256').update(String(pub)).digest('hex').slice(0, 12)}`;
}

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
  return { pub, priv, kid: kidOf(pub) };
}

/** 本机密钥对：有工作区就落盘复用（0600），没有就进程内临时（重启即换新身份） */
function loadKeypair(root) {
  const cacheKey = root ? path.join(String(root), '.agentdeck', 'pet', VISIT_KEY_FILE) : '@ephemeral';
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  let record;
  if (!root) {
    record = { ...makeKeypair(), path: null, ephemeral: true };
    keyCache.set(cacheKey, record);
    return record;
  }
  const dir = path.join(String(root), '.agentdeck', 'pet');
  // 盘写不了就退化到临时密钥对：串门照旧能用，只是对方每次看到的是新 kid
  let file = path.join(dir, VISIT_KEY_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const text = String(fs.readFileSync(file, 'utf8')).trim();
      const parsed = JSON.parse(text);
      if (isPlainObject(parsed) && parsed.alg === KEY_ALG && str(parsed.pub) && str(parsed.priv)) {
        record = { pub: parsed.pub, priv: parsed.priv, kid: kidOf(parsed.pub), path: file, ephemeral: false };
        keyCache.set(cacheKey, record);
        return record;
      }
    } catch {
      // 文件不存在 / 坏了：往下走，重新生成
    }
    const fresh = makeKeypair();
    fs.writeFileSync(file, `${JSON.stringify({ v: 1, alg: KEY_ALG, ...fresh, at: new Date().toISOString() }, null, 2)}\n`, {
      mode: 0o600,
    });
    record = { ...fresh, path: file, ephemeral: false };
  } catch {
    record = { ...makeKeypair(), path: null, ephemeral: true };
  }
  keyCache.set(cacheKey, record);
  return record;
}

function signEd25519(priv, body) {
  const key = createPrivateKey({ key: Buffer.from(String(priv), 'base64url'), format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(body, 'utf8'), key).toString('base64url');
}

/** 只验签，不抛：任何解析问题都算「验不过」 */
function verifyEd25519(pub, body, signatureBase64Url) {
  try {
    const key = createPublicKey({ key: Buffer.from(String(pub), 'base64url'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(body, 'utf8'), key, Buffer.from(String(signatureBase64Url), 'base64url'));
  } catch {
    return false;
  }
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
  const keyInfo = loadKeypair(rootValue);

  const payload = {
    v: VISIT_TOKEN_VERSION,
    kind: 'invite',
    id: newId('visit'),
    from: cardResult.card,
    scope: scopeValue,
    iat: baseMs,
    exp: expMs,
    alg: KEY_ALG,
    pub: keyInfo.pub,
    kid: keyInfo.kid,
  };
  // 1.10.0：把发起方的 X25519 加密公钥放进邀请函。
  // 收下邀请那台机器据此协商共享密钥，之后传的便签就是密文——
  // 邀请函和便签都要经过人手/微信，明文等于谁看见谁能读。
  // 拿不到加密身份不算致命（老流程照走），但要在返回值里如实标明。
  const box = loadBoxKey(rootValue);
  if (box.ok) {
    payload.box = box.pub;
    payload.boxFp = fingerprint(box.pub);
  }
  const replyUrl = str(reply);
  if (/^https?:\/\//i.test(replyUrl)) payload.reply = replyUrl;

  const body = b64u(JSON.stringify(payload));
  const token = `${body}.${signEd25519(keyInfo.priv, body)}`;
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
    kid: keyInfo.kid,
    keyPath: keyInfo.path,
    ephemeralKey: keyInfo.ephemeral,
    // 1.10.0：端到端加密身份（对方据此协商共享密钥）
    box: box.ok ? box.pub : null,
    boxFp: box.ok ? fingerprint(box.pub) : null,
    boxReason: box.ok ? null : box.reason || '本机没有加密身份',
    logged: logged.ok,
    ...(typeof log === 'function' && logged.ok === false ? { logWarning: logged.reason } : {}),
  };
}

/**
 * 解析一张邀请函（不产生副作用，供 acceptInvite 和排查用）。
 * 校验顺序：格式 → 版本 → 类型 → 签名 → 有效期 → 范围 → 名片。
 * v2（Ed25519）签名**在任何机器上都验**，验不过直接拒；v1 的老令牌只有本机能验，照旧。
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
  if (payload.v !== 1 && payload.v !== 2) return { ok: false, reason: `邀请凭证版本不认识：${payload.v}`, code: 'bad_version' };
  if (payload.kind !== 'invite') return { ok: false, reason: '这不是一张串门邀请函', code: 'bad_kind' };

  // 签名先验：被改过的令牌不该继续往有效期/范围里走
  let verified = false;
  let verifyNote = '跨机器的邀请只能在本地做格式校验';
  let kid = '';
  let sameMachine = false;
  if (payload.v === 2) {
    const pub = str(payload.pub);
    if (!pub) return { ok: false, reason: '邀请凭证里没有公钥，没法验签', code: 'no_pub' };
    if (!verifyEd25519(pub, parts[0], parts[1])) {
      return { ok: false, reason: '邀请凭证的签名对不上，可能被改过', code: 'bad_signature' };
    }
    verified = true;
    kid = kidOf(pub);
    const localKey = loadKeypair(str(root) || null);
    sameMachine = Boolean(localKey && localKey.kid === kid);
    verifyNote = sameMachine
      ? '签名有效（Ed25519）：本机签发，且凭证自签发后没被改过'
      : `签名有效（Ed25519）：这张名片自签发后没被改过，签发方密钥 ${kid}`;
  } else {
    // v1 老令牌：HMAC 密钥不在别人手里，只有本机发的才验得出
    const secretInfo = loadSecret(str(root) || null);
    if (str(payload.sid) && safeEqual(payload.sid, secretInfo.sid)) {
      const expected = sign(secretInfo.secret, parts[0]);
      if (!safeEqual(expected, parts[1])) {
        return { ok: false, reason: '邀请凭证的签名对不上，可能被改过', code: 'bad_signature' };
      }
      verified = true;
      sameMachine = true;
      verifyNote = '本机签发，签名校验通过（v1）';
    } else if (secretInfo.ephemeral) {
      verifyNote = '没有工作区密钥，签名无法校验';
    }
  }

  const expMs = toMs(payload.exp);
  if (expMs === null) return { ok: false, reason: '邀请凭证没有有效期', code: 'no_exp' };
  const nowMs = nowOf(now);
  if (expMs <= nowMs) return { ok: false, reason: '这张邀请已经过期了', code: 'expired', exp: iso(expMs) };

  const scope = str(payload.scope);
  if (!VISIT_SCOPES.includes(scope)) return { ok: false, reason: `邀请的串门范围不认识：${scope || '（空）'}`, code: 'bad_scope' };

  if (!isPlainObject(payload.from) || !str(payload.from.name)) {
    return { ok: false, reason: '邀请凭证里没有主人的名片', code: 'no_card' };
  }

  return {
    ok: true,
    verified,
    verifyNote,
    sameMachine,
    kid,
    version: payload.v,
    payload: clone(payload),
    host: clone(payload.from),
    scope,
    exp: iso(expMs),
    expMs,
    id: str(payload.id),
    reply: str(payload.reply),
    // 1.10.0：邀请函里带的 X25519 加密公钥（造密文便签要用它）。
    // 老邀请函没有这两个字段 → null，走明文，不影响兼容。
    box: str(payload.box) || null,
    boxFp: str(payload.boxFp) || null,
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
    sameMachine: parsed.sameMachine,
    kid: parsed.kid,
    version: parsed.version,
    visitId: parsed.id,
    scope: parsed.scope,
    exp: parsed.exp,
    hostCard,
    myCard,
    // 1.10.0：把对方的加密公钥一并带出来，方便上层直接拿去造密文便签
    box: parsed.box || null,
    boxFp: parsed.boxFp || null,
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
  const rootValue = str(root) || resolved.root;

  // 1.10.0：能加密就加密。要加密得有两样：
  //   ① 本机自己的 X25519 身份（生成或读盘）；
  //   ② 对方的 X25519 公钥 —— 从"收下的那张邀请函"里来（recipientBox）。
  // 缺任何一样都退回明文，但把原因如实写在返回值里，绝不假装已经加密。
  const noteId = newId('note');
  const note = {
    v: 1,
    kind: kindValue,
    id: noteId,
    from: card.card,
    at: iso(baseMs),
  };
  const toName = str(to);
  if (toName) note.to = toName;

  let encInfo = { encrypted: false, reason: '没提供对方的加密公钥（recipientBox），这条是明文便签' };
  const theirBox = str(payload?.recipientBox);
  if (theirBox) {
    const mine = loadBoxKey(rootValue);
    if (!mine.ok) {
      encInfo = { encrypted: false, reason: `本机没有加密身份：${mine.reason || ''}` };
    } else {
      const shared = deriveSharedKey({ myPriv: mine.priv, theirPub: theirBox });
      if (!shared) {
        encInfo = { encrypted: false, reason: '对方的加密公钥不合法，协商不出共享密钥' };
      } else {
        const aad = aadOf({ id: noteId, kind: kindValue, fromKid: mine.pub, toKid: theirBox });
        const sealed = sealJson(body, shared, aad);
        if (!sealed.ok) {
          encInfo = { encrypted: false, reason: `加密失败：${sealed.reason}` };
        } else {
          // 加密后：正文只留密文，明文字段一个都不带出去
          note.enc = sealed.sealed;
          note.box = mine.pub;          // 我自己的公钥，对方用它协商
          note.toBox = theirBox;        // 收件人公钥，防止发给别人
          note.boxFp = fingerprint(mine.pub);
          encInfo = {
            encrypted: true,
            box: mine.pub,
            boxFp: fingerprint(mine.pub),
            toBox: theirBox,
            toBoxFp: fingerprint(theirBox),
          };
        }
      }
    }
  }
  // 没加密才放明文 payload；加密了就一个字都不留
  if (!note.enc) note.payload = body;

  const logged = appendVisitLog(rootValue, {
    at: note.at,
    event: 'note-out',
    kind: kindValue,
    noteId: note.id,
    to: toName || null,
    encrypted: note.enc ? true : false,
  });

  return {
    ok: true,
    note,
    encrypted: Boolean(note.enc),
    enc: encInfo,
    logged: logged.ok,
    ...(typeof log === 'function' && !logged.ok ? { logWarning: logged.reason } : {}),
  };
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
  const noteId = str(note.id, 'note_unknown');
  const guest = isPlainObject(note.from) ? str(note.from.name, '一位朋友') : '一位朋友';
  const rootValue = str(root);

  // 1.10.0：密文便签先在本机解出来，再走后面完全一样的落盘路径。
  // 解不开就**明确拒收**，绝不退化成"当明文处理"（那是最危险的失败方式）。
  let payload = isPlainObject(note.payload) ? note.payload : {};
  let decrypted = false;
  if (isPlainObject(note.enc)) {
    const theirBox = str(note.box);
    if (!theirBox) return { ok: false, reason: '这是一张密文便签，但没带发件人的加密公钥（box），解不开' };
    const mine = loadBoxKey(rootValue, { create: false });
    if (!mine.ok) {
      return {
        ok: false,
        code: 'no_box_key',
        reason: `这是一张密文便签，但本机没有对应的加密身份，解不开：${mine.reason || ''}`,
      };
    }
    const shared = deriveSharedKey({ myPriv: mine.priv, theirPub: theirBox });
    if (!shared) return { ok: false, reason: '发件人的加密公钥不合法，协商不出共享密钥' };
    const aad = aadOf({ id: noteId, kind, fromKid: theirBox, toKid: str(note.toBox) || mine.pub });
    const opened = openSealed(note.enc, shared, aad);
    if (!opened.ok) {
      return { ok: false, code: 'cannot_decrypt', reason: `密文便签解不开：${opened.reason}` };
    }
    if (!isPlainObject(opened.value)) return { ok: false, reason: '解出来的内容不是一张便签的正文' };
    payload = opened.value;
    decrypted = true;
  }

  if (!board || typeof board !== 'object') return { ok: false, reason: '收便签需要任务板（board）' };

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
    return { ok: true, kind, noteId, taskId: task.id, task, guest, decrypted, logged: logged.ok, ...(logged.ok ? {} : { logWarning: logged.reason }) };
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
  return { ok: true, kind, noteId, event, guest, decrypted, logged: logged.ok, ...(logged.ok ? {} : { logWarning: logged.reason }) };
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
