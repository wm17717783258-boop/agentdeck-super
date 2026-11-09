/**
 * lib/identity.js —— Agent 通行证 v1（Ed25519 能力卡）
 *
 * 解决什么：把 Agent 加进小组以后，对方凭什么相信"它确实会这几样本事、权限到这一层"？
 *   串门令牌证明的是"这张邀请没被改过"，护照证明的是"这张能力卡没被改过，且还是那台机器发的"。
 *   两者都是 Ed25519 + 公钥随卡走，所以**别人的机器上也能离线验**，不需要先交换公钥。
 *
 * 诚实边界（必须写进所有对外文案）：
 *   - 验签通过 = 卡没被改、kid 与公钥对得上、在有效期内。**不等于**「操作者真的是那个人」。
 *   - 没有 CA、没有实名、没有吊销中心：信任来自"你第一次看到这个 kid 时记住它"（`--kid` 固定校验）。
 *   - 所以对外只说"可验、可对账、可复现"，不说"认证身份"。
 *
 * 卡为什么是"一行字符串"而不是 JSON 对象：
 *   贴进聊天窗口、写进 `.env`、塞进 ADBP 握手、印在二维码里，一行都不会被换行截断。
 *   格式 `NEXP1.<payload>.<sig>`，payload 里自带 `pub`，所以任何机器不需要先装什么就能验。
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 卡前缀：换版本换前缀，老卡永远还能被老代码认出来。 */
export const PASSPORT_PREFIX = 'NEXP1';
export const PASSPORT_VERSION = 1;
/** 默认有效期：30 天。通行证是"这段时间我能干这些"，不该长期永久。 */
export const DEFAULT_TTL_DAYS = 30;
/** 单张卡最多写多少项能力：防止有人把工具全表塞进去当摆设。 */
const MAX_CAPABILITIES = 32;

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64uDecode(str) {
  return Buffer.from(String(str), 'base64url');
}
/**
 * base64url 必须是非填充、字母表内、且解码后重编码能逐字还原。
 * Buffer.from(..., 'base64url') 对末尾填充位很宽容：最后一个字符换了，
 * 解出来的字节可能完全一样。通行证是安全边界，这里不能接受非规范编码。
 */
function isCanonicalB64u(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return b64uEncode(b64uDecode(value)) === value;
  } catch {
    return false;
  }
}

/** 公钥 → kid：`kid_` + sha256(SPKI DER) 前 16 个 base64url 字符。公钥变了 kid 必变。 */
export function kidOfPublicKey(publicKeyDer) {
  const der = Buffer.isBuffer(publicKeyDer) ? publicKeyDer : b64uDecode(publicKeyDer);
  const digest = createHash('sha256').update(der).digest();
  return `kid_${b64uEncode(digest).slice(0, 16)}`;
}

/** 机级身份目录：跟人走，不跟项目走（和授权同一个根）。 */
export function identityDir(root) {
  const base = root && String(root).trim() ? String(root) : process.cwd();
  return join(base, '.agentdeck', 'identity');
}

export function identityPaths(root) {
  const dir = identityDir(root);
  return {
    dir,
    keyPem: join(dir, 'key.pem'),
    pubTxt: join(dir, 'pub.txt'),
    store: join(dir, 'passports.json'),
  };
}

function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    if (mode) chmodSync(tmp, mode);
  } catch { /* Windows 上 chmod 基本是空操作，失败不影响功能 */ }
  renameSync(tmp, file);
}

/**
 * 拿到本机身份（没有就当场生成一对 Ed25519）。**永不 throw**。
 * @returns {{ ok:boolean, kid?:string, privateKeyPem?:string, publicKeyB64Url?:string, created?:boolean, path?:string, reason?:string }}
 */
export function ensureIdentity(root) {
  const p = identityPaths(root);
  try {
    if (existsSync(p.keyPem)) {
      const privateKeyPem = readFileSync(p.keyPem, 'utf8');
      const pub = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'der', type: 'spki' });
      return {
        ok: true,
        kid: kidOfPublicKey(pub),
        privateKeyPem,
        publicKeyB64Url: b64uEncode(pub),
        created: false,
        path: p.keyPem,
      };
    }
    mkdirSync(p.dir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const pubDer = publicKey.export({ format: 'der', type: 'spki' });
    const kid = kidOfPublicKey(pubDer);
    writeAtomic(p.keyPem, privateKeyPem, 0o600);
    writeAtomic(p.pubTxt, `${kid}\n${b64uEncode(pubDer)}\n`, 0o644);
    return { ok: true, kid, privateKeyPem, publicKeyB64Url: b64uEncode(pubDer), created: true, path: p.keyPem };
  } catch (err) {
    return { ok: false, reason: `${err?.name || 'Error'}: ${err?.message || err}`, path: p.dir };
  }
}

/** 把外部输入整理成固定形状（字段固定、顺序固定、丢未知字段），保证签名可复现。 */
export function normalizePassportClaims(input = {}) {
  const nowSec = Math.floor(Number(input.iat) || Date.now() / 1000);
  const ttlDays = Math.max(1, Math.min(365, Math.floor(Number(input.ttlDays) || DEFAULT_TTL_DAYS)));
  const expIn = Math.floor(Number(input.exp) || 0);
  const capabilities = Array.isArray(input.capabilities)
    ? [...new Set(input.capabilities.map((c) => String(c).trim()).filter(Boolean))].slice(0, MAX_CAPABILITIES)
    : [];
  return {
    v: PASSPORT_VERSION,
    kid: String(input.kid || ''),
    name: String(input.name || '').slice(0, 80),
    agent: String(input.agent || 'dsh').slice(0, 60),
    host: String(input.host || '').slice(0, 60),
    capabilities,
    tier: String(input.tier || 'free').slice(0, 20),
    seats: Math.max(0, Math.floor(Number(input.seats) || 0)),
    iat: nowSec,
    exp: expIn > 0 ? expIn : nowSec + ttlDays * 86400,
    nonce: String(input.nonce || ''),
    pub: String(input.pub || ''),
  };
}

/** 签名用的规范串：字段顺序写死，任何一端改动顺序都会验签失败（这是故意的）。 */
function canonicalPassport(c) {
  return JSON.stringify([
    c.v,
    c.kid,
    c.name,
    c.agent,
    c.host,
    c.capabilities,
    c.tier,
    c.seats,
    c.iat,
    c.exp,
    c.nonce,
    c.pub,
  ]);
}

/**
 * 签发一张卡（只会用本机私钥）。
 * @param {object} claims 见 normalizePassportClaims
 * @param {string} privateKeyPem Ed25519 私钥（PKCS8 PEM）
 * @returns {string} `NEXP1.<payload>.<sig>`
 */
export function encodePassport(claims, privateKeyPem) {
  const c = normalizePassportClaims(claims);
  const sig = cryptoSign(null, Buffer.from(canonicalPassport(c)), privateKeyPem);
  return `${PASSPORT_PREFIX}.${b64uEncode(JSON.stringify(c))}.${b64uEncode(sig)}`;
}

/**
 * 校验一张卡。**永不 throw**。
 * @param {string} card `NEXP1.xxx.yyy`
 * @param {{ now?:number, skewSec?:number, kid?:string, requiredCapabilities?:string[] }} [opts]
 *   now=毫秒时间戳；kid=只接受这个签发者（第一次见过就记住它）；requiredCapabilities=必须包含的能力
 * @returns {{ ok:boolean, claims?:object, kid?:string, reason?:string, code?:string }}
 */
export function verifyPassport(card, opts = {}) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  try {
    if (typeof card !== 'string' || !card.trim()) return fail('empty', '没有卡片内容');
    const raw = card.trim().replace(/\s+/g, '');
    const parts = raw.split('.');
    if (parts.length !== 3) return fail('format', `卡片格式不对（应为 ${PASSPORT_PREFIX}.payload.sig）`);
    if (parts[0] !== PASSPORT_PREFIX) return fail('format', `卡片前缀不是 ${PASSPORT_PREFIX}`);
    if (!isCanonicalB64u(parts[1])) return fail('bad_encoding', '卡片内容不是规范的 base64url（可能被填充、改写或截断）');
    if (!isCanonicalB64u(parts[2])) return fail('bad_encoding', '签名不是规范的 base64url（可能被填充、改写或截断）');

    let claims;
    try {
      claims = JSON.parse(b64uDecode(parts[1]).toString('utf8'));
    } catch {
      return fail('payload', '卡片内容读不出来（不是合法 JSON 或 base64 被截断）');
    }
    if (!claims || typeof claims !== 'object') return fail('payload', '卡片内容不是对象');
    if (Number(claims.v) !== PASSPORT_VERSION) return fail('version', `不认识的卡片版本 ${claims.v}`);

    // pub 必须自带且能解析，否则没法离线验（也就没意义）
    if (!claims.pub) return fail('payload', '卡片里没有公钥（pub），无法验签');
    if (!isCanonicalB64u(String(claims.pub))) return fail('bad_encoding', '卡片里的公钥不是规范的 base64url');
    let pub;
    try {
      pub = createPublicKey({ key: b64uDecode(claims.pub), format: 'der', type: 'spki' });
    } catch {
      return fail('payload', '卡片里的公钥解析失败');
    }

    // kid ↔ 公钥必须自洽：改了公钥就必须改 kid，改了 kid 签名又对不上
    const expectKid = kidOfPublicKey(b64uDecode(claims.pub));
    if (String(claims.kid) !== expectKid) {
      return fail('kid_mismatch', `kid 与公钥不匹配（卡上 ${claims.kid || '空'}，实际 ${expectKid}）`);
    }
    if (opts.kid && String(opts.kid) !== expectKid) {
      return fail('kid_mismatch', `这张卡不是 ${opts.kid} 签发的（实际 ${expectKid}）`);
    }

    const sigOk = cryptoVerify(null, Buffer.from(canonicalPassport(normalizePassportClaims(claims))), pub, b64uDecode(parts[2]));
    if (!sigOk) return fail('bad_signature', '签名对不上：卡被改过，或者不是这台机器签的');

    const nowMs = Number(opts.now) || Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const skew = Math.max(0, Number(opts.skewSec) || 0);
    if (Number(claims.exp) && nowSec > Number(claims.exp) + skew) {
      return fail('expired', `卡已过期（到期 ${new Date(Number(claims.exp) * 1000).toISOString().slice(0, 10)}）`);
    }
    if (Number(claims.iat) && Number(claims.iat) > nowSec + Math.max(skew, 300)) {
      return fail('not_yet', '卡上的签发时间在未来（时钟明显不对）');
    }

    const required = Array.isArray(opts.requiredCapabilities) ? opts.requiredCapabilities.map(String) : [];
    const have = Array.isArray(claims.capabilities) ? claims.capabilities.map(String) : [];
    const missing = required.filter((r) => !have.includes(r));
    if (missing.length) return fail('missing_capability', `这张卡没有声明的能力：${missing.join('、')}`);

    return { ok: true, claims: normalizePassportClaims(claims), kid: expectKid };
  } catch (err) {
    return fail('internal', `${err?.name || 'Error'}: ${err?.message || err}`);
  }
}

/** 读已签发的卡（坏文件当空处理，不当故障）。 */
export function readPassports(root) {
  const p = identityPaths(root);
  try {
    if (!existsSync(p.store)) return { v: 1, cards: [] };
    const json = JSON.parse(readFileSync(p.store, 'utf8'));
    return { v: 1, cards: Array.isArray(json?.cards) ? json.cards : [] };
  } catch {
    return { v: 1, cards: [] };
  }
}

function writePassports(root, data) {
  const p = identityPaths(root);
  mkdirSync(p.dir, { recursive: true });
  writeAtomic(p.store, `${JSON.stringify({ v: 1, cards: data.cards || [] }, null, 2)}\n`, 0o600);
  return p.store;
}

/**
 * 签发并落盘一张卡。**永不 throw**。
 * @param {string} root 机级根目录
 * @param {object} input { name, agent, host, capabilities, tier, seats, ttlDays }
 * @returns {{ ok:boolean, card?:string, claims?:object, kid?:string, created?:boolean, path?:string, reason?:string }}
 */
export function issuePassport(root, input = {}) {
  const id = ensureIdentity(root);
  if (!id.ok) return { ok: false, reason: `本机身份不可用：${id.reason}` };
  try {
    const caps = Array.isArray(input.capabilities) ? input.capabilities : [];
    const claims = normalizePassportClaims({
      ...input,
      kid: id.kid,
      pub: id.publicKeyB64Url,
      iat: Math.floor(Date.now() / 1000),
      nonce: `psp_${Math.random().toString(36).slice(2, 10)}`,
    });
    const card = encodePassport(claims, id.privateKeyPem);
    const store = readPassports(root);
    // 同一 kid 的旧卡留着（那是历史凭证），只在同 nonce 时替换
    store.cards = store.cards.filter((c) => c?.claims?.nonce !== claims.nonce);
    store.cards.push({
      kid: id.kid,
      name: claims.name,
      agent: claims.agent,
      host: claims.host,
      capabilities: claims.capabilities,
      tier: claims.tier,
      seats: claims.seats,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      card,
      claims,
    });
    // 只留最近 50 张，避免文件无界增长
    if (store.cards.length > 50) store.cards = store.cards.slice(-50);
    const path = writePassports(root, store);
    return { ok: true, card, claims, kid: id.kid, created: id.created, path, caps: caps.length };
  } catch (err) {
    return { ok: false, reason: `${err?.name || 'Error'}: ${err?.message || err}` };
  }
}

/** 吊销（本地账本打标；卡本身仍然验得过——离线凭证没有吊销中心，这一点必须说明）。 */
export function revokePassport(root, kidOrNonce) {
  const key = String(kidOrNonce || '').trim();
  if (!key) return { ok: false, reason: '要吊销哪张？给 kid 或 nonce' };
  const store = readPassports(root);
  let hit = 0;
  const now = new Date().toISOString();
  for (const c of store.cards) {
    const sameKid = String(c?.kid) === key;
    const sameNonce = String(c?.claims?.nonce) === key;
    if ((sameKid || sameNonce) && !c.revokedAt) {
      c.revokedAt = now;
      hit += 1;
    }
  }
  if (!hit) return { ok: false, reason: `本地账本里没有 ${key} 这张卡（可能不是本机签发的）` };
  const path = writePassports(root, store);
  return { ok: true, revoked: hit, path };
}

/** 本机身份摘要（给状态页/工具看，不含私钥）。create=false 时只读，不生成密钥。 */
export function identitySummary(root, opts = {}) {
  const p = identityPaths(root);
  const store = readPassports(root);
  const wantCreate = opts.create !== false;
  const exists = existsSync(p.keyPem);
  if (!wantCreate && !exists) {
    return {
      ok: false,
      kid: '',
      publicKey: '',
      created: false,
      keyPath: p.keyPem,
      storePath: p.store,
      passports: store.cards.length,
      active: store.cards.filter((c) => !c.revokedAt).length,
      reason: '本机还没有身份密钥（第一次签发通行证时才会生成）',
      missing: true,
    };
  }
  const id = ensureIdentity(root);
  return {
    ok: Boolean(id.ok),
    kid: id.kid || '',
    publicKey: id.publicKeyB64Url || '',
    created: Boolean(id.created),
    keyPath: p.keyPem,
    storePath: p.store,
    passports: store.cards.length,
    active: store.cards.filter((c) => !c.revokedAt).length,
    reason: id.reason || '',
    missing: false,
  };
}

export default {
  PASSPORT_PREFIX,
  DEFAULT_TTL_DAYS,
  kidOfPublicKey,
  ensureIdentity,
  normalizePassportClaims,
  encodePassport,
  verifyPassport,
  issuePassport,
  readPassports,
  revokePassport,
  identitySummary,
  identityPaths,
};
