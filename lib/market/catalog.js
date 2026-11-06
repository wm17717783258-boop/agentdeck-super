/**
 * lib/market/catalog.js —— 皮肤市场目录：把已有皮肤定义翻成「货架条目」
 *
 * 这一层刻意不做自己的授权判断，只做三件事：
 *   1. 复用 lib/pet/skins.js 的 listSkins() 拿皮肤清单（不重复扫盘、不另造一份定义）；
 *   2. 复用 lib/pet/skins.js 的 checkSkinLicense() 当**唯一**的 owned / 锁定判定；
 *   3. 把价格从「皮肤定义里的整数元」翻成「市场里的整数分」。
 *
 * 已购皮肤怎么参与判定：
 *   买过的皮肤记在 <root>/market/ledger.json；市场把「本机购买凭据」合并成一份
 *   claims（skins 里多几个 id），再交给 checkSkinLicense 一起判——所以「拥有」只有一个裁判，
 *   免费皮肤 / 签名授权 / 档位权益 / 本地购买，四条来源走同一条判定路径。
 *
 * 诚实说明（别当成签名授权）：
 *   本地购买凭据是本机订单推导出来的，不是 lib/license.js 的 ADSK1 签名凭证，
 *   换机器不跟走；跨机授权仍然由授权码体系负责（见 docs/PET.md 的授权一节）。
 */

import { SKIN_STATES, STATE_LABELS, listSkins, checkSkinLicense } from '../pet/skins.js';
import { currentLicense, entitlements } from '../license.js';
import { createMarketStore, purchasedSkinIds, clockOf, isoOf } from './store.js';

/** 市场结算币种：人民币，金额一律整数分 */
export const MARKET_CURRENCY = 'CNY';

/** 官方作者署名（内置皮肤的权益方） */
export const OFFICIAL_AUTHOR = 'AgentDeck 官方';

/** 预览用的 5 个状态 emoji（和 SKIN_STATES 一一对应） */
export const STATE_EMOJI = Object.freeze({
  idle: '🐾',
  working: '🔧',
  meeting: '🗣️',
  visiting: '🚪',
  sleeping: '😴',
});

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 元 → 分。皮肤定义里 price 是整数元（18），市场对外一律整数分（1800）。
 * 这里只做一次单位换算，不参与任何累加；非数字/负数一律当 0（免费）。
 * @param {any} yuan
 * @returns {number} 整数分
 */
export function toCents(yuan) {
  const n = Number(yuan);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/**
 * 整数分 → 展示价（'¥18' / '¥18.50'），格式化过程也不碰浮点。
 * @param {number} cents
 */
export function formatCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '¥0';
  const value = Math.round(n);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const yuan = Math.trunc(abs / 100);
  const fen = abs % 100;
  return `${sign}¥${yuan}${fen ? `.${String(fen).padStart(2, '0')}` : ''}`;
}

/**
 * 预览信息：状态色 + 每个状态的 emoji（市场列表、详情页都能直接用）。
 * @param {object} skin listSkins() 给的皮肤条目
 */
export function previewOf(skin) {
  const src = plain(skin);
  return {
    accent: str(src.accent, '#b26a2f'),
    emoji: STATE_EMOJI.idle,
    states: SKIN_STATES.map((state) => ({ state, label: STATE_LABELS[state], emoji: STATE_EMOJI[state] })),
  };
}

/**
 * 把「本机已购皮肤」合并进一份 license/claims 对象。
 *
 * 返回值形状和 currentLicense() 一致（ok/tier/entitlements/claims），
 * 所以可以直接喂给 checkSkinLicense()、activateSkin()，不需要市场另写一套判定。
 *
 * 小心两点：
 *   - 基础授权失效（过期/验签失败）时，不继承它的 tier 权益（否则等于白送 premiumSkins）；
 *   - 已购皮肤是本机记录，没有过期时间，所以基础授权失效后它们仍然算拥有。
 *
 * @param {any} license currentLicense() 的结果、验证后的 claims，或裸 claims
 * @param {string[]} skinIds 已购皮肤 id
 */
export function licenseWithPurchases(license, skinIds = []) {
  const ids = (Array.isArray(skinIds) ? skinIds : [])
    .map((id) => str(id).toLowerCase())
    .filter((id) => /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id) && !id.includes('..'));
  const base = license && typeof license === 'object' && !Array.isArray(license) ? license : null;

  if (!ids.length) return base || license;

  const rawClaims = base && plain(base.claims).tier !== undefined
    ? plain(base.claims)
    : (base && (base.tier !== undefined || base.skins !== undefined) ? base : null);
  // 和 lib/pet/skins.js 的 normalizeLicense 同一口径：没写 ok 就按已验证处理
  const verified = Boolean(rawClaims) && (base && typeof base.ok === 'boolean' ? base.ok : true);

  const tier = verified ? str(rawClaims && rawClaims.tier, 'free') : 'free';
  const baseSkins = verified && Array.isArray(rawClaims.skins) ? rawClaims.skins.map((id) => String(id)) : [];
  const merged = [...new Set([...baseSkins, ...ids])];

  const claims = {
    v: 1,
    id: str(rawClaims && rawClaims.id, 'local_purchases'),
    tier,
    sub: str(rawClaims && rawClaims.sub, ''),
    iat: Math.max(0, Math.round(num(rawClaims && rawClaims.iat, 0))),
    // 本地购买没有期限：基础授权失效后不要让它把已购皮肤一起带走
    exp: verified ? Math.max(0, Math.round(num(rawClaims && rawClaims.exp, 0))) : 0,
    seats: Math.max(1, Math.round(num(rawClaims && rawClaims.seats, 1))),
    skins: merged,
  };

  return {
    ok: true,
    tier: claims.tier,
    entitlements: verified && base && base.entitlements ? base.entitlements : entitlements(claims.tier),
    claims,
    local: true,
    localSkins: ids.slice(),
    reason: verified ? '' : '本地购买凭据（没有可用的签名授权）',
    note: '购买记录来自本机订单，不是 ADSK1 签名凭证：换机器不跟走，跨机授权仍由授权码签发体系负责',
  };
}

/**
 * 拿一份「可用于判定的授权」：没传就按工作区读真实授权（读不到就是免费版）。
 * @returns {any}
 */
export function resolveLicense({ root, license, now } = {}) {
  if (license !== undefined) return license;
  const base = typeof root === 'string' && root.trim() ? root.trim() : '';
  if (!base) return { ok: false, tier: 'free', reason: '没有工作区路径，按免费版处理' };
  const clock = () => clockOf(now);
  return currentLicense(base, { now: clock });
}

/**
 * 目录条目：皮肤定义 + 价格（整数分）+ 预览 + owned/锁定。
 * @param {object} skin
 * @param {{ license:any, root?:string, now?:any, purchased?:string[] }} ctx
 */
function entryOf(skin, { license, root, now, purchased = [] }) {
  const price = toCents(skin.price);
  const verdict = checkSkinLicense({ skin, license, root, now: clockOf(now) });
  const owned = verdict.allowed === true;
  const fromPurchase = purchased.includes(skin.id);
  const author = str(skin.author, skin.builtin ? OFFICIAL_AUTHOR : '匿名创作者');
  return {
    id: skin.id,
    name: str(skin.name, skin.id),
    author,
    description: str(skin.description, ''),
    version: str(skin.version, ''),
    premium: skin.premium === true,
    builtin: skin.builtin === true,
    source: str(skin.source, 'builtin'),
    spritePath: str(skin.spritePath, ''),
    // 价格：对外只有整数分，元只用于展示字符串
    price,
    currency: MARKET_CURRENCY,
    priceLabel: formatCents(price),
    freeTrial: price === 0,
    // 判定：全部来自 checkSkinLicense，市场不自己算
    owned,
    locked: !owned && price > 0,
    grant: owned ? (fromPurchase ? 'purchase' : str(verdict.source, 'license')) : 'none',
    reason: str(verdict.reason, ''),
    preview: previewOf(skin),
  };
}

/**
 * 列市场目录。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 工作区/状态根（账本在 <root>/market）
 * @param {object} [opts.store] createMarketStore() 出来的账本（有就直接用）
 * @param {any} [opts.license] 授权对象；不传就按 root 读真实授权
 * @param {any} [opts.now] 注入时钟
 * @param {boolean} [opts.includeLocked=true] 传 false 只返回已拥有/免费的
 * @returns {{ ok:true, currency:string, tier:string, license:object, skins:object[],
 *   purchased:string[], warnings:string[], dirs:object }}
 */
export function listCatalog({ root, store, license, now, includeLocked = true } = {}) {
  const clock = () => clockOf(now);
  const base = str(root) || (store && str(store.root)) || '';
  let s = store;
  if (!s) {
    if (!base) return { ok: false, reason: '列市场目录需要工作区路径（root）' };
    s = createMarketStore({ root: base, now: clock });
  }

  const ledger = s.readLedger();
  const purchased = purchasedSkinIds(ledger.doc);
  const baseLicense = resolveLicense({ root: base, license, now });
  const merged = licenseWithPurchases(baseLicense, purchased);

  const listed = listSkins({ root: base || undefined });
  if (!listed || listed.ok === false) {
    return { ok: false, reason: (listed && listed.reason) || '皮肤清单读取失败' };
  }

  const skins = [];
  for (const skin of listed.skins) {
    const entry = entryOf(skin, { license: merged, root: base, now, purchased });
    if (!includeLocked && !entry.owned) continue;
    skins.push(entry);
  }

  return {
    ok: true,
    currency: MARKET_CURRENCY,
    tier: merged && merged.ok ? str(merged.tier, 'free') : 'free',
    license: {
      ok: Boolean(baseLicense && baseLicense.ok),
      tier: baseLicense && baseLicense.ok ? str(baseLicense.tier, 'free') : 'free',
      reason: str(baseLicense && baseLicense.reason, ''),
      localSkins: purchased.slice(),
    },
    skins,
    purchased,
    warnings: [...(Array.isArray(listed.warnings) ? listed.warnings : []), ...(s.warnings ? s.warnings() : [])],
    dirs: listed.dirs || {},
    generatedAt: isoOf(clock()),
  };
}

/**
 * 货架上找一件皮肤（下单前用，省得业务层自己遍历）。
 * @returns {{ ok:true, entry:object } | { ok:false, reason:string }}
 */
export function getCatalogEntry({ root, store, license, now, skinId } = {}) {
  const id = str(skinId).toLowerCase();
  if (!id) return { ok: false, reason: '要买哪套皮肤？skinId 是空的' };
  const catalog = listCatalog({ root, store, license, now });
  if (!catalog.ok) return catalog;
  const entry = catalog.skins.find((item) => item.id === id);
  if (!entry) {
    const names = catalog.skins.map((item) => item.id).join('、');
    return { ok: false, reason: `市场里没有这套皮肤：${id}（现有：${names || '无'}）` };
  }
  return { ok: true, entry };
}

/**
 * 按皮肤 id 取一份「可用于 activateSkin 的授权」（已含本机购买）。
 * @param {{ root?:string, store?:object, license?:any, now?:any, skinId:string }} opts
 */
export function licenseForSkin({ root, store, license, now, skinId } = {}) {
  const clock = () => clockOf(now);
  const base = str(root) || (store && str(store.root)) || '';
  const s = store || (base ? createMarketStore({ root: base, now: clock }) : null);
  const purchased = s ? purchasedSkinIds(s.readLedger().doc) : [];
  const merged = licenseWithPurchases(resolveLicense({ root: base, license, now }), purchased);
  return {
    ok: true,
    skinId: str(skinId).toLowerCase(),
    license: merged,
    purchased,
  };
}
