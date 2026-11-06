/**
 * lib/billing/sign.js —— 支付签名/验签的密码学底座（只用 node:crypto，零第三方依赖）
 *
 * 为什么要单独一层：
 * - 三家支付渠道的密码学动作只有两种：Stripe 用 HMAC-SHA256，微信/支付宝用 RSA-SHA256（RSA2）。
 *   但"拼串规则"（签什么内容）每家都不一样，那部分留在各自适配器里，方便对着官方文档逐字核对；
 *   这里只提供不会写错的原子动作：算 HMAC、RSA 签名、RSA 验签、常量时间比较、PEM 归一化。
 * - **支付密钥只经过这里，不写日志、不进返回值、不落盘**。这个文件没有任何 I/O。
 */

import {
  createHmac,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** HMAC-SHA256 的十六进制小写结果（Stripe webhook 就是它）。 */
export function hmacSha256Hex(secret, payload) {
  return createHmac('sha256', secret ?? '').update(String(payload ?? ''), 'utf8').digest('hex');
}

/** 任意内容的 sha256（用来给"没有 event id"的 webhook 造一个稳定的去重键）。 */
export function sha256Hex(text) {
  return createHmac('sha256', '').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 常量时间字符串比较：比较签名时必须用它，避免按字节提前返回泄露信息。
 * 长度不等直接 false（长度本身不是秘密）。
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 把"只有 base64 正文"的私钥/公钥补成标准 PEM。
 *
 * 真实场景：微信 apiclient_key.pem 一定是完整 PEM，但很多用户是从后台复制的那一串
 * base64，直接丢给 createSign 会抛错。这里做一次归一化，报错更少。
 */
export function normalizePem(text, kind = 'PRIVATE KEY') {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (raw.includes('-----BEGIN')) return raw.endsWith('\n') ? raw : `${raw}\n`;
  const body = raw.replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${kind}-----\n${lines.join('\n')}\n-----END ${kind}-----\n`;
}

/** 把 PEM（公钥或 X.509 证书）变成 KeyObject；解析不了就返回 null。 */
export function publicKeyFromPem(pem) {
  const raw = String(pem ?? '').trim();
  if (!raw) return null;
  try {
    if (raw.includes('BEGIN CERTIFICATE')) return createPublicKey(raw);
    return createPublicKey(normalizePem(raw, 'PUBLIC KEY'));
  } catch {
    return null;
  }
}

/** RSA-SHA256 签名，返回 base64（微信/支付宝都要求 base64）。 */
export function rsaSignBase64(privateKeyPem, message) {
  const pem = normalizePem(privateKeyPem, 'PRIVATE KEY');
  const signer = createSign('RSA-SHA256');
  signer.update(String(message ?? ''), 'utf8');
  return signer.sign(pem, 'base64');
}

/**
 * RSA-SHA256 验签。任何异常（PEM 坏、签名 base64 坏、公钥类型不对）都当成"验签失败"，
 * 绝不向上抛——验签失败是业务结论，不是程序崩溃。
 */
export function rsaVerifyBase64(publicKeyPem, message, signatureBase64) {
  const key = publicKeyFromPem(publicKeyPem);
  if (!key) return false;
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(String(message ?? ''), 'utf8');
    return verifier.verify(key, String(signatureBase64 ?? ''), 'base64');
  } catch {
    return false;
  }
}

/** 随机 nonce（微信要求 32 位以内随机串，16 字节 hex 正好 32 位）。 */
export function randomNonce(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

/**
 * 从一段 JSON 文本里抠出一个节点（含最外层花括号）的**原始子串**。
 *
 * 支付宝的响应验签规则很坑：不是对整段 body 验签，而是对 `alipay_xxx_response` 这个
 * 子串**原样字节**验签（空格、字段顺序都算）。所以不能 JSON.parse 再 stringify，必须抠原文。
 */
export function extractJsonNode(text, nodeName) {
  const raw = String(text ?? '');
  const key = `"${nodeName}"`;
  const at = raw.indexOf(key);
  if (at < 0) return null;
  const start = raw.indexOf('{', at + key.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
