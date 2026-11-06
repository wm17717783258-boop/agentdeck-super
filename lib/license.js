/**
 * 授权与权益（licensing + entitlements）
 *
 * 设计原则（很重要，决定了开源与收费能不能同时成立）：
 * 1. 代码全部开源，收费的是「我们独有的东西」：云房间/中转、席位、付费皮肤、自动执行额度。
 * 2. 授权是 **Ed25519 签名的离线凭证**：私钥只在卖家机器上，公钥写死在插件里。
 *    离线可验、不可伪造、不需要服务器；联网只是可选增强。
 * 3. 本地永远不"锁死功能"：没有授权也能完整使用单机能力，只是跨机/多人/付费皮肤不开放。
 *    任何校验失败都必须降级到 free，**绝不允许崩**。
 *
 * 凭证串格式：`ADSK1.<b64url(payload JSON)>.<b64url(sig)>`
 * payload 形如：
 *   { v:1, id:'lic_xxx', tier:'pro', sub:'张三', iat:1730000000, exp:1761536000, seats:5, skins:['aurora'] }
 */

import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** 卖家公钥（Ed25519/SPKI/DER 的 base64url）。私钥不在本仓库里，也不该在。 */
export const ISSUER_PUBLIC_SPKI_B64URL =
  'MCowBQYDK2VwAyEAIYxoPvvhsjdwmDS_05i-ds_Mbao1JqhDnI6866g-qzs';

/**
 * 实际用于校验的公钥：环境变量 `AGENTDECK_LICENSE_PUBKEY` 优先。
 *
 * 为什么要有这个开关：`tools/license-cli.mjs init` 自己生成一对密钥，如果你要
 * **自己卖授权**（或者公司内部自建发码），换公钥就行，不用改代码；测试也用它
 * 塞一对临时的密钥，从而在不起真卖家私钥的前提下把"激活"整条链路验一遍。
 *
 * 这不是后门：本仓库是 MIT，改代码绕过校验本来就是允许的；换公钥只影响
 * "我认谁的签名"，不改变任何功能语义。
 */
export function issuerPublicKeyB64Url() {
  const fromEnv = typeof process.env.AGENTDECK_LICENSE_PUBKEY === 'string'
    ? process.env.AGENTDECK_LICENSE_PUBKEY.trim()
    : '';
  return fromEnv || ISSUER_PUBLIC_SPKI_B64URL;
}

/** 凭证前缀与版本 */
export const LICENSE_PREFIX = 'ADSK1';

/**
 * 档位与权益表。**这里是唯一真源**：代码里所有"能不能做某事"的判断都查这张表。
 * 关键词：free 单机齐全；plus 多人/跨机；studio 团队与商用；business 私有化。
 *
 * 数字口径来自产品方案的定价章节（FREE/PLUS/STUDIO/BUSINESS 四档的额度表），
 * 改数字只改这里 + lib/quota.js 的 DEFAULT_LIMITS，别处不许再写第二份。
 *
 * 关于 `remoteJoin`：方案里 FREE 的权益是「无限一对一好友」，所以免费版也必须能
 * 邀请/接受好友串门（remoteJoin:true）。付费卡的是**群组房间数量**（localRooms /
 * cloudRooms）和**每月会议场次**，不是"能不能交朋友"。这条边界是刻意的：
 * 社交是留存引擎，把交朋友收费等于自杀。
 *
 * 老授权码里写的是 `pro`，现在 `pro` 是 `plus`（协作版）的只读别名（见文件末尾 defineProperty），
 * 已经发出去的码不作废——档位只升不降，别名不参与价格表。
 */
export const TIERS = {
  free: {
    id: 'free',
    label: '免费版',
    price: 0,
    yearPrice: 0,
    localRooms: 3,       // 方案：3 个群组房间
    cloudRooms: 0,       // 云端托管房间属付费能力
    maxSeats: 3,
    includedSeats: 3,
    parallel: 1,
    meetingsPerMonth: 5, // 方案：每月 5 场 Agent 会议
    meetingRounds: 2,
    meetingTasks: 5,
    automations: 3,      // 方案：3 个活跃自动化
    premiumSkins: false, // 方案：基础桌宠 + 2 套官方皮肤（本仓库实发 basic/nio/ink 三套，多给不算违约）
    autoRun: false,
    auditExport: false,
    remoteJoin: true,    // 方案：无限一对一好友
  },
  plus: {
    id: 'plus',
    label: '协作版',
    price: 29,
    yearPrice: 288,
    localRooms: 20,      // 方案：20 个群组房间
    cloudRooms: 20,
    maxSeats: 8,
    includedSeats: 8,
    parallel: 3,
    meetingsPerMonth: 30, // 方案：每月 30 场会议
    meetingRounds: 3,
    meetingTasks: 8,
    automations: 20,     // 方案：20 个活跃自动化
    premiumSkins: true,  // 方案：全部官方基础皮肤
    autoRun: true,
    auditExport: false,
    remoteJoin: true,
  },
  studio: {
    id: 'studio',
    label: '工作室版',
    price: 99,
    yearPrice: 999,
    localRooms: 50,      // 方案：50 个团队房间
    cloudRooms: 50,
    maxSeats: 30,
    includedSeats: 3,    // 方案：含 3 席位
    extraSeat: 25,       // 方案：额外席位 ¥25/月
    parallel: 6,
    meetingsPerMonth: 999,
    meetingRounds: 5,
    meetingTasks: 20,
    automations: 100,    // 方案：100 个活跃自动化
    premiumSkins: true,
    autoRun: true,
    auditExport: true,
    remoteJoin: true,
  },
  business: {
    id: 'business',
    label: '企业版',
    price: 30000,
    yearPrice: 30000,
    localRooms: 999,
    cloudRooms: 200,
    maxSeats: 200,
    includedSeats: 10,
    parallel: 10,
    // 企业版会议与自动化「不限」：这里必须用 Infinity，不能写 999——
    // lib/quota.js 的 DEFAULT_LIMITS.business 用的是 Infinity（对外承诺"不限"），
    // tests/quota.test.mjs 有一条把两张表逐格对账，写 999 会立刻红。
    meetingsPerMonth: Infinity,
    meetingRounds: 5,
    meetingTasks: 50,
    automations: Infinity,
    premiumSkins: true,
    autoRun: true,
    auditExport: true,
    remoteJoin: true,
  },
};

/** 供状态页/文档展示的价格表（人民币）。顺序即展示顺序，tier 必须与 TIERS 一一对应。 */
export const PRICE_TABLE = [
  { tier: 'free', name: '免费版', price: '¥0', per: '', sell: '无限一对一好友、3 个群组房间、每月 5 场会议、3 个自动化、3 套官方皮肤' },
  { tier: 'plus', name: '协作版', price: '¥29', per: '/月（年付 ¥288）', sell: '20 个群组房间、20 席、每月 30 场会议、20 个自动化、多设备加密同步、全部官方基础皮肤' },
  { tier: 'studio', name: '工作室版', price: '¥99', per: '/月（年付 ¥999，含 3 席，加席 ¥25/席·月）', sell: '50 个团队房间、30 席、100 个自动化、团队共享记忆、审计日志与成员分析' },
  { tier: 'business', name: '企业版', price: '¥30000 起', per: '/年（私有化部署，含 10 席）', sell: '200 个云房间、SSO+SCIM、数据驻留、私有连接器、审计导出与安全评审、SLA' },
];

/** 免费档的兜底权益（任何时候都能拿到） */
export function entitlements(tier) {
  const key = typeof tier === 'string' ? tier.toLowerCase() : 'free';
  return TIERS[key] || TIERS.free;
}

// 老授权码里写的是 pro：只读别名指向 plus，不可枚举——价格表和 Object.keys 里不会多出一档，
// 但已经发出去的 pro 码永远还能验通（档位只升不降）。
Object.defineProperty(TIERS, 'pro', { value: TIERS.plus, enumerable: false, configurable: false, writable: false });

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64uDecode(str) {
  return Buffer.from(String(str), 'base64url');
}

/** 把 claims 归一化成可签名/可比较的形状（字段固定、顺序固定、丢弃未知字段） */
export function normalizeClaims(input = {}) {
  const tier = String(input.tier || 'free').toLowerCase();
  const nowSec = Math.floor(Number(input.iat) || 0);
  const tierSeats = TIERS[tier]?.maxSeats || 1;
  // seats 缺省 → 用档位上限；显式给了（哪怕是 0/负数）→ 至少 1，不静默放行
  const rawSeats = input.seats == null || input.seats === '' ? null : Math.floor(Number(input.seats));
  const seats = rawSeats == null || Number.isNaN(rawSeats) ? tierSeats : Math.max(1, rawSeats);
  return {
    v: 1,
    id: String(input.id || ''),
    tier: TIERS[tier] ? tier : 'free',
    sub: String(input.sub || ''),
    iat: nowSec,
    exp: Math.floor(Number(input.exp) || 0),
    seats,
    skins: Array.isArray(input.skins) ? input.skins.map(String).slice(0, 32) : [],
  };
}

function canonical(claims) {
  // 固定顺序拼接，保证签名可复现
  const c = normalizeClaims(claims);
  return JSON.stringify([c.v, c.id, c.tier, c.sub, c.iat, c.exp, c.seats, c.skins]);
}

/**
 * 用私钥签发一张授权（只在卖家机器上调用）。
 * @param {object} claims 见 normalizeClaims
 * @param {string} privateKeyPem Ed25519 私钥（PKCS8 PEM）
 * @returns {string} `ADSK1.<payload>.<sig>`
 */
export function encodeLicense(claims, privateKeyPem) {
  const c = normalizeClaims(claims);
  const payload = JSON.stringify(c);
  const sig = cryptoSign(null, Buffer.from(canonical(c)), privateKeyPem);
  return `${LICENSE_PREFIX}.${b64uEncode(payload)}.${b64uEncode(sig)}`;
}

/**
 * 校验一张授权。**永不 throw**。
 * @param {string} key 授权串
 * @param {{ now?: () => number, publicKeyB64Url?: string, skewSec?: number }} [opts]
 * @returns {{ ok:boolean, claims?:object, tier:string, reason?:string, code?:string }}
 */
export function verifyLicense(key, opts = {}) {
  const fail = (code, reason) => ({ ok: false, tier: 'free', code, reason });
  try {
    if (typeof key !== 'string' || !key.trim()) return fail('empty', '没有填写授权码');
    const raw = key.trim().replace(/\s+/g, '');
    const parts = raw.split('.');
    if (parts.length !== 3) return fail('format', '授权码格式不对（应为 ADSK1.xxx.yyy）');
    if (parts[0] !== LICENSE_PREFIX) return fail('version', `授权码版本不认识：${parts[0]}`);
    let claims;
    try {
      claims = JSON.parse(b64uDecode(parts[1]).toString('utf8'));
    } catch {
      return fail('payload', '授权码内容损坏，无法解析');
    }
    if (!claims || typeof claims !== 'object') return fail('payload', '授权码内容损坏');

    const pubB64 = opts.publicKeyB64Url || issuerPublicKeyB64Url();
    let pub;
    try {
      pub = createPublicKey({ key: Buffer.from(pubB64, 'base64url'), format: 'der', type: 'spki' });
    } catch {
      return fail('pubkey', '公钥无法加载（这属于打包错误）');
    }
    let sigOk = false;
    try {
      sigOk = cryptoVerify(null, Buffer.from(canonical(claims)), pub, b64uDecode(parts[2]));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return fail('signature', '授权码签名不匹配：可能是伪造或被改过');

    const c = normalizeClaims(claims);
    if (!TIERS[c.tier]) return fail('tier', `未知档位：${c.tier}`);
    const nowMs = opts.now ? opts.now() : Date.now();
    const skew = (Number(opts.skewSec) || 0) * 1000;
    if (c.exp && nowMs > c.exp * 1000 + skew) {
      return fail('expired', `授权已于 ${new Date(c.exp * 1000).toLocaleDateString('zh-CN')} 到期`);
    }
    return { ok: true, claims: c, tier: c.tier, entitlements: entitlements(c.tier) };
  } catch (err) {
    return fail('unknown', `授权校验异常：${err && err.message ? err.message : String(err)}`);
  }
}

/** 已校验的 claims → 权益；无效/过期一律 free */
export function entitlementsOf(verified) {
  if (!verified || !verified.ok) return entitlements('free');
  return entitlements(verified.tier || verified.claims?.tier);
}

/** 授权文件默认位置 */
export function licensePath(root) {
  return join(root, '.agentdeck', 'license', 'key.txt');
}

/**
 * 从磁盘读授权串（没有就返回 null，不抛错）
 * @param {string} root 工作区根
 */
export function readLicenseKey(root) {
  try {
    const p = licensePath(root);
    if (!existsSync(p)) return null;
    const txt = readFileSync(p, 'utf8').trim();
    return txt || null;
  } catch {
    return null;
  }
}

/**
 * 落盘授权串（原子写）
 * @param {string} root
 * @param {string} key
 * @returns {{ ok:boolean, path?:string, reason?:string }}
 */
export function writeLicenseKey(root, key) {
  try {
    const p = licensePath(root);
    mkdirSync(join(root, '.agentdeck', 'license'), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, String(key || '').trim(), 'utf8');
    renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, reason: `写授权文件失败：${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * 一步到位：读盘 + 校验 + 得权益（任何异常都退化成 free）
 * @param {string} root
 * @param {{ now?: () => number }} [opts]
 */
export function currentLicense(root, opts = {}) {
  const key = readLicenseKey(root);
  if (!key) return { ok: false, code: 'none', tier: 'free', entitlements: entitlements('free'), reason: '还没有授权码（免费版可用）' };
  const v = verifyLicense(key, opts);
  return { ...v, entitlements: entitlementsOf(v), key };
}

/**
 * 给模型/状态页看的权益摘要（中文一句话）
 * @param {object} ent
 */
export function describeEntitlements(ent) {
  const e = ent || entitlements('free');
  const meetings = Number.isFinite(e.meetingsPerMonth) ? `每月 ${e.meetingsPerMonth} 场会议` : '会议不限';
  const automations = Number.isFinite(e.automations) ? `${e.automations} 个活跃自动化` : '自动化不限';
  return `${e.label}：群组房间 ${e.localRooms}（云 ${e.cloudRooms}）、席位 ${e.maxSeats}、并行 ${e.parallel}、${meetings}、${automations}` +
    `${e.remoteJoin ? '、可邀请好友跨机（一对一不限）' : '、仅本机'}${e.premiumSkins ? '、官方皮肤全解锁' : ''}`;
}


