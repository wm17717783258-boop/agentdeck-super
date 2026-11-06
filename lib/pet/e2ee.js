/**
 * lib/pet/e2ee.js —— 串门便签的端到端加密（1.10.0）
 *
 * 为什么要有这一层：1.10.0 之前，串门便签是**明文**的——Ed25519 签名只保证
 * "没被改过"，不保证"别人看不到"。可邀请链接和便签 JSON 都是要**经过人手/微信**
 * 传的，路上谁都能读。产品方案把「私密串门端到端加密」列成硬门槛，所以这里补上。
 *
 * 做法（标准、不发明密码学）：
 *   · 每个工作区一把 X25519 身份密钥（curve25519），私钥只在本机 `.agentdeck/pet/`；
 *   · 邀请函里带上发起方的 X25519 公钥（`box`），所以收下邀请那台机器**不需要联网、
 *     不需要共享密钥目录**，自己算一把临时密钥就能协商出共享密钥；
 *   · 共享密钥走 HKDF-SHA256 派生，再用 **AES-256-GCM** 加密便签正文；
 *   · AAD 里绑上便签 id / 类型 / 双方 kid，换头换尾都会解密失败（不是只验签名）。
 *
 * 诚实边界（写清楚，不吹）：
 *   · 这是**匿名**密钥交换，没有身份绑定到人：谁拿到邀请函谁就能解（所以邀请函本身要当秘密）。
 *   · 不防"中间人"：没有 CA / 没有带外指纹比对，和所有"扫码互联"产品同一水平。
 *     签名（Ed25519, lib/pet/visit.js）负责"没被改过"，加密负责"别人看不到"，两件事分开。
 *   · 明文老便签照样收（v1），不会因为加了加密就把历史记录读不回来。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BOX_FILE = 'box-key.json';
export const BOX_VERSION = 1;
export const NOTE_ENC_VERSION = 1;
export const KDF_INFO = 'agentdeck-super/visit-note/v1';
/** 单条便签正文上限：加密前就卡住，免得一封巨型密文把接收方撑爆 */
export const MAX_PLAINTEXT_BYTES = 32 * 1024;

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 举例说明：本机 X25519 密钥对（32 字节私钥 / 32 字节公钥），存 raw 的 base64url。 */
function boxPath(root) {
  return join(String(root), '.agentdeck', 'pet', BOX_FILE);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/** raw 32 字节私钥 → KeyObject（PKCS8 包一层 DER 头）。 */
function privateKeyFromRaw(rawB64) {
  const raw = unb64(rawB64);
  if (raw.length !== 32) return null;
  // PKCS8 for X25519: 302e020100300506032b656e04220420 || raw32
  const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  try {
    return createPrivateKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
}

/** raw 32 字节公钥 → KeyObject（SPKI 包一层 DER 头）。 */
function publicKeyFromRaw(rawB64) {
  const raw = unb64(rawB64);
  if (raw.length !== 32) return null;
  // SPKI for X25519: 302a300506032b656e032100 || raw32
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  try {
    return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** 把 KeyObject 的 X25519 公钥导回 raw base64url。 */
function rawOfPublicKey(keyObject) {
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return b64(der.subarray(der.length - 32));
}

/**
 * 取（或生成）本机的 X25519 加密身份。
 * 私钥只落本机盘，绝不进邀请函、绝不进便签。
 * @returns {{ ok:boolean, pub?:string, priv?:string, file?:string, reason?:string }}
 */
export function loadBoxKey(root, { create = true } = {}) {
  const dir = String(root || '');
  if (!dir) return { ok: false, reason: '加密身份需要工作区路径（root）' };
  const file = boxPath(dir);
  const existing = readJson(file);
  if (existing && typeof existing.priv === 'string' && existing.priv) {
    const key = privateKeyFromRaw(existing.priv);
    if (key) {
      return { ok: true, pub: rawOfPublicKey(createPublicKey(key)), priv: existing.priv, file, existing: true };
    }
  }
  if (!create) return { ok: false, reason: '本机还没有加密身份密钥', file, missing: true };

  const pair = generateKeyPairSync('x25519');
  const privDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  const priv = b64(privDer.subarray(privDer.length - 32));
  const pub = rawOfPublicKey(pair.publicKey);
  writeJsonAtomic(file, { v: BOX_VERSION, alg: 'x25519', priv, createdAt: new Date().toISOString() });
  return { ok: true, pub, priv, file, created: true };
}

/**
 * 协商出共享密钥（HKDF-SHA256）。
 * @param {{ myPriv:string, theirPub:string, salt?:string, info?:string }} opts
 * @returns {Buffer|null} 32 字节密钥
 */
export function deriveSharedKey({ myPriv, theirPub, salt = '', info = KDF_INFO } = {}) {
  const mine = privateKeyFromRaw(myPriv);
  const theirs = publicKeyFromRaw(theirPub);
  if (!mine || !theirs) return null;
  let shared = null;
  try {
    shared = diffieHellman({ privateKey: mine, publicKey: theirs });
  } catch {
    return null;
  }
  try {
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(String(salt), 'utf8'), Buffer.from(String(info), 'utf8'), 32));
  } catch {
    return null;
  }
}

/**
 * 加密一段便签正文。
 * @param {object} plain       要加密的对象
 * @param {Buffer} key         32 字节共享密钥
 * @param {string} aad         认证附加数据（绑 id/kind/kid，防止换头）
 * @returns {{ ok:boolean, sealed?:object, reason?:string }}
 */
export function sealJson(plain, key, aad = '') {
  if (!Buffer.isBuffer(key) || key.length !== 32) return { ok: false, reason: '共享密钥不对（要 32 字节）' };
  let text;
  try {
    text = JSON.stringify(plain ?? null);
  } catch (err) {
    return { ok: false, reason: `正文序列化失败：${err?.message || err}` };
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    return { ok: false, reason: `正文太大了（${bytes.length} 字节，上限 ${MAX_PLAINTEXT_BYTES}）` };
  }
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ok: true,
      sealed: { v: NOTE_ENC_VERSION, alg: 'aes-256-gcm', iv: b64(iv), ct: b64(ct), tag: b64(tag) },
    };
  } catch (err) {
    return { ok: false, reason: `加密失败：${err?.message || err}` };
  }
}

/**
 * 解密。**任何异常都返回 ok:false**，绝不抛、绝不返回半截明文。
 * @returns {{ ok:boolean, value?:any, reason?:string }}
 */
export function openSealed(sealed, key, aad = '') {
  if (!isPlainObject(sealed)) return { ok: false, reason: '密文不是对象' };
  if (Number(sealed.v) !== NOTE_ENC_VERSION) return { ok: false, reason: `密文版本不认识：${sealed.v}` };
  if (String(sealed.alg) !== 'aes-256-gcm') return { ok: false, reason: `加密算法不认识：${sealed.alg}` };
  if (!Buffer.isBuffer(key) || key.length !== 32) return { ok: false, reason: '共享密钥不对（要 32 字节）' };
  let iv;
  let ct;
  let tag;
  try {
    iv = unb64(sealed.iv);
    ct = unb64(sealed.ct);
    tag = unb64(sealed.tag);
  } catch {
    return { ok: false, reason: '密文里的 iv/ct/tag 不是合法 base64url' };
  }
  if (iv.length !== 12) return { ok: false, reason: `iv 长度不对：${iv.length}` };
  if (tag.length !== 16) return { ok: false, reason: `认证标签长度不对：${tag.length}` };
  if (ct.length > MAX_PLAINTEXT_BYTES + 64) return { ok: false, reason: '密文太长，拒收' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return { ok: true, value: JSON.parse(out.toString('utf8')) };
  } catch (err) {
    // GCM 校验失败 / JSON 坏 → 都说"解不开"，不泄漏是哪一步失败的细节
    return { ok: false, reason: `解不开（可能不是给你的，或者被改过）：${err?.message || err}` };
  }
}

/** 便签的 AAD：把 id/kind/双方 kid 绑进去，换头就解不开。 */
export function aadOf({ id, kind, fromKid, toKid } = {}) {
  return [String(id || ''), String(kind || ''), String(fromKid || ''), String(toKid || '')].join('\u0001');
}

/** 短指纹：给人眼比对用（两端一样就说明没被调包）。 */
export function fingerprint(pubB64, len = 8) {
  const s = String(pubB64 || '');
  if (!s) return '';
  return createHmac('sha256', 'agentdeck-super/fingerprint').update(s).digest('hex').slice(0, len);
}

/** 两个指纹比一次：用常数时间比较，免得按字符猜。 */
export function sameFingerprint(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export default {
  BOX_FILE,
  NOTE_ENC_VERSION,
  loadBoxKey,
  deriveSharedKey,
  sealJson,
  openSealed,
  aadOf,
  fingerprint,
  sameFingerprint,
};
