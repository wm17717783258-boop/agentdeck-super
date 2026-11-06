/**
 * lib/market/index.js —— 皮肤市场对外门面
 *
 * 用法（Lead 接线时只需要这一层）：
 *   const market = createMarket({ root, license, billing });
 *   market.catalog()                       // 货架（价格是整数分，owned 已经判好）
 *   await market.buy({ skinId:'premium-aurora' })   // 没配渠道 → { ok:false, reason:'环境未配' }
 *   market.license()                       // 喂给 activateSkin() 的授权（含本机购买）
 *   market.refund({ orderId })             // 退款冲正
 *
 * 组合关系：
 *   catalog.js  货架 + owned 判定（唯一裁判是 lib/pet/skins.js 的 checkSkinLicense）
 *   store.js    原子写账本 + 坏文件恢复
 *   purchase.js 下单 / 确认支付 / 发放 / 退款（没配渠道一律如实失败）
 *   split.js    80/20 整数分账
 */

import { createMarketStore, ledgerTotals, marketPaths } from './store.js';
import { listCatalog, getCatalogEntry, licenseForSkin, formatCents, toCents } from './catalog.js';
import {
  buyNow,
  confirmPayment,
  deliveryCode,
  getOrder,
  listOrders,
  marketLicense,
  placeOrder,
  purchasedSkins,
  refundOrder,
  resolveBilling,
  billingFromEnv,
} from './purchase.js';
import { CREATOR_SHARE_BPS, PLATFORM_SHARE_BPS, splitCents, splitOrder, verifySplits } from './split.js';

export {
  // 账本
  createMarketStore,
  ledgerTotals,
  marketPaths,
  // 货架
  listCatalog,
  getCatalogEntry,
  licenseForSkin,
  formatCents,
  toCents,
  // 交易
  placeOrder,
  confirmPayment,
  buyNow,
  refundOrder,
  listOrders,
  getOrder,
  purchasedSkins,
  marketLicense,
  deliveryCode,
  resolveBilling,
  billingFromEnv,
  // 分账
  splitCents,
  splitOrder,
  verifySplits,
  CREATOR_SHARE_BPS,
  PLATFORM_SHARE_BPS,
};

/**
 * 建一个市场实例（把 root / 授权 / 支付渠道绑好，下面每次调用都不用重复传）。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 工作区根（账本落在 <root>/market）
 * @param {any} [opts.license] currentLicense() 的结果；不传就按 root 读真实授权
 * @param {any} [opts.billing] 支付渠道适配器（见 purchase.js 的 BillingAdapter）
 * @param {{ post:Function }} [opts.http] 注入的 http 客户端（本模块绝不自己联网）
 * @param {any} [opts.now] 注入时钟（函数 / Date / 毫秒数）
 * @returns {object}
 */
export function createMarket({ root, license, billing, http, now, store } = {}) {
  const base = typeof root === 'string' && root.trim() ? root.trim() : (store && store.root) || '';
  if (!base) {
    return { ok: false, reason: '皮肤市场需要工作区路径（root）：账本不能落在匿名目录里' };
  }
  const s = store || createMarketStore({ root: base, now });
  const shared = { store: s, root: base, license, now };

  return {
    ok: true,
    root: base,
    store: s,
    paths: marketPaths(base),
    /** 货架 */
    catalog: (opts = {}) => listCatalog({ ...shared, ...opts }),
    /** 单件皮肤 */
    entry: (skinId, opts = {}) => getCatalogEntry({ ...shared, ...opts, skinId }),
    /** 带本机购买的授权（activateSkin 用这个） */
    license: (opts = {}) => marketLicense({ ...shared, ...opts }),
    /** 下单（不动钱） */
    placeOrder: (opts = {}) => placeOrder({ ...shared, ...opts }),
    /** 确认支付（没配渠道 → { ok:false, reason:'环境未配' }） */
    confirm: (opts = {}) => confirmPayment({ ...shared, billing, http, ...opts }),
    /** 下单 + 确认支付 */
    buy: (opts = {}) => buyNow({ ...shared, billing, http, ...opts }),
    /** 退款冲正 */
    refund: (opts = {}) => refundOrder({ ...shared, ...opts }),
    /** 订单列表 / 单张订单 */
    orders: (opts = {}) => listOrders({ ...shared, ...opts }),
    order: (orderId, opts = {}) => getOrder({ ...shared, ...opts, orderId }),
    /** 已购皮肤 */
    purchases: (opts = {}) => purchasedSkins({ ...shared, ...opts }),
    /** 分账合计（全是整数分） */
    totals: () => ledgerTotals(s.readLedger().doc),
    /** 单笔分账 */
    split: (amountCents, opts = {}) => splitCents(amountCents, opts),
  };
}
