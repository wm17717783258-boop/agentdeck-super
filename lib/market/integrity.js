/**
 * lib/market/integrity.js —— 账本完整性封印（改一行就不再是「买了」）
 *
 * 为什么需要这一层：
 *   `checkSkinLicense` 认两种购买证据：签名授权（ADSK1，issuer 私钥不在买家手上）
 *   和本地购买凭据（ledger.json 的 purchases）。前者伪造不了，后者原本**改一行 JSON 就能伪造** ——
 *   实测往 purchases 里塞一条 { skinId: "premium-aurora" } 就 allowed:true。
 *
 * 做法：
 *   1. 每份账本写入时算一个 HMAC-SHA256（覆盖整份文档、键序固定），存进文档的 `seal` 字段。
 *      封印跟着文档一起原子落盘，不存在「文件写好了、封印还没写」的窗口。
 *   2. 读盘时重算比对，不匹配 → `tampered`，业务层据此**不采信**这份账本里的购买凭据。
 *   3. 密钥是 `<root>/market/.integrity.key`（32 字节，0600，首次写入时生成）。
 *
 * 边界（必须如实说，别对外讲成「密码学防伪」）：
 *   单机 BYOK 下密钥就在同一台机器上。能读密钥、能重算 HMAC 的人仍然能伪造 ——
 *   这一层挡的是「打开编辑器改个数字」「抄一条 JSON 进去」这类顺手作弊，
 *   把门槛从「改一行」抬到「读懂两个文件的结构并重算封印」。
 *   真防伪只有 ADSK1 签名（签发私钥只在卖家/服务端手里，买家拿不到）。
 *   两者可以叠加：本地凭据管「这台机器买了就能用」，签名授权管「换机器也认、且伪造不了」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 封印算法标识（写进 seal 字符串，将来换算法能识别老格式） */
export const SEAL_ALGO = 'hmac-sha256';

/** 文档里存封印的字段名（计算时排除自身） */
export const SEAL_FIELD = 'seal';

/** 密钥文件名（放在 market/ 目录下，和 orders.json 同级） */
export const SEAL_KEY_FILE = '.integrity.key';

/** 读盘结论：ok 匹配 / unsealed 老账本没封印 / tampered 对不上 / unprotected 拿不到密钥 */
export const SEAL_STATUS = Object.freeze({
  OK: 'ok',
  UNSEALED: 'unsealed',
  TAMPERED: 'tampered',
  UNPROTECTED: 'unprotected',
});

/**
 * 稳定序列化：对象键排序、数组保序、跳过 seal 自身。
 * 封印必须可复现，所以不能用 JSON.stringify 的默认键序（依赖插入顺序）。
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const src = value;
    const keys = Object.keys(src)
      .filter((key) => key !== SEAL_FIELD && src[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(src[key])}`).join(',')}}`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'bigint') return JSON.stringify(String(value));
  return JSON.stringify(value);
}

/**
 * 算一份文档的封印（不含 seal 字段本身）。
 * @param {object} doc
 * @param {Buffer|string} key
 * @returns {string} `hmac-sha256:<hex>`
 */
export function sealOf(doc, key) {
  if (!key) return '';
  const mac = createHmac('sha256', key).update(stableStringify(doc), 'utf8').digest('hex');
  return `${SEAL_ALGO}:${mac}`;
}

/**
 * 给文档盖章（返回新对象，不改入参）。
 * 没有密钥时原样返回 —— 宁可明确「没保护」，也不要塞一个假封印让人误以为验过了。
 * @param {object} doc
 * @param {Buffer|string} key
 * @returns {object}
 */
export function sealDoc(doc, key) {
  const src = doc && typeof doc === 'object' ? doc : {};
  if (!key) return { ...src };
  return { ...src, [SEAL_FIELD]: sealOf(src, key) };
}

/**
 * 校验文档封印。**永不 throw**。
 * @param {object} doc
 * @param {Buffer|string} key
 * @returns {{ status:string, ok:boolean, sealed:boolean, reason:string }}
 */
export function verifyDocSeal(doc, key) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const got = typeof src[SEAL_FIELD] === 'string' ? src[SEAL_FIELD].trim() : '';
  if (!key) {
    return { status: SEAL_STATUS.UNPROTECTED, ok: false, sealed: false, reason: '拿不到账本封印密钥，跳过完整性校验' };
  }
  if (!got) {
    return { status: SEAL_STATUS.UNSEALED, ok: false, sealed: false, reason: '这份账本是盖章之前写的（没有 seal 字段），下次写入会补上' };
  }
  const want = sealOf(src, key);
  // 长度不同直接判否；长度相同再用定时安全比较，避免逐字节计时差
  const same = got.length === want.length
    && timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'));
  if (same) return { status: SEAL_STATUS.OK, ok: true, sealed: true, reason: '封印匹配' };
  return {
    status: SEAL_STATUS.TAMPERED,
    ok: false,
    sealed: true,
    reason: '封印对不上：这份账本在上次写入之后被改过（手改 / 别的工具重写过 / 从别处拷过来的）',
  };
}

/**
 * 读密钥；没有就生成一把（32 字节随机，0600）。
 * 密钥文件读坏了 → 返回 null 并给警告，**不**自动换新密钥：
 * 换新密钥会让所有老封印立刻变成 tampered，把「密钥坏了」误报成「有人篡改账本」。
 *
 * @param {string} keyFile
 * @param {string[]} [warnings]
 * @returns {Buffer|null}
 */
export function loadSealKey(keyFile, warnings = null) {
  const warn = (line) => { if (Array.isArray(warnings)) warnings.push(line); };
  if (!keyFile) return null;
  try {
    const text = fs.readFileSync(keyFile, 'utf8').trim();
    if (text) {
      const buf = Buffer.from(text, 'hex');
      if (buf.length >= 16) return buf;
      warn('账本封印密钥太短（可能被截断），本轮跳过完整性校验');
      return null;
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      warn(`账本封印密钥读不了（${err.message || err}），本轮跳过完整性校验`);
      return null;
    }
  }
  // 不存在 → 首次使用，生成
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    const key = randomBytes(32);
    fs.writeFileSync(keyFile, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    // 并发下别人先建了（EEXIST）→ 再读一次
    if (err && err.code === 'EEXIST') {
      try {
        const buf = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
        if (buf.length >= 16) return buf;
      } catch { /* 落到下面 */ }
    }
    warn(`建不了账本封印密钥（${err && err.message ? err.message : String(err)}），本轮跳过完整性校验`);
    return null;
  }
}
