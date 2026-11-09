/**
 * lib/market/index.js —— 皮肤市场对外门面（开源核心）
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
 *   split.js    80/20 整数分账（账本正确性所需，整数分不差分）
 *
 * 拆分边界（1.11.9）：
 *   货架、账本、下单、人工确认发放、退款、分账计算 —— 全在这里，开源。
 *   在线渠道识别（billing/from-env.js）、对账、发票、主题包 —— 在 pro/，闭源。
 *   所以免费用户买得到东西，Pro 用户才有多渠道与结算工具。
 */

import { createMarketStore, ledgerTotals, marketPaths } from './store.js';
import { listCatalog, getCatalogEntry, licenseForSkin, formatCents, toCents } from './catalog.js';
import {
  buyNow,
  confirmPayment,
  deliveryCode,
  ENV_UNCONFIGURED,
  getOrder,
  listOrders,
  marketLicense,
  placeOrder,
  purchasedSkins,
  refundOrder,
  resolveBilling,
  resolveRefundBilling,
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
  resolveRefundBilling,
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
 * @param {object} [opts.profile] 桌宠档案 store；退款成功后用于收回当前外观
 * @returns {object}
 */
export function createMarket({ root, license, billing, http, now, store, profile } = {}) {
  const base = typeof root === 'string' && root.trim() ? root.trim() : (store && store.root) || '';
  if (!base) {
    return { ok: false, reason: '皮肤市场需要工作区路径（root）：账本不能落在匿名目录里' };
  }
  const s = store || createMarketStore({ root: base, now });
  const shared = { store: s, root: base, license, billing, http, now, profile };

  /**
   * 合并调用参数。
   *
   * 为什么要这一层，而不是直接 `{ ...shared, ...opts }`：
   *   对象展开会把显式传进来的 `undefined` 也覆盖上去。调用方写
   *   `market.refund({ root, orderId })` 时 opts 里没有 billing 这个键，
   *   但只要有人写成 `market.refund({ root, orderId, billing: maybeUndefined })`，
   *   构造时绑好的在线渠道就会被悄悄抹成 undefined —— 表现是"退款明明配好了却说没配"。
   *   这种 bug 极难查：症状是"配了但没用"，而不是报错。
   *   所以规则钉死：**undefined 不算传参，不能覆盖已有值**。
   */
  const merge = (opts) => {
    const out = { ...shared };
    const src = opts && typeof opts === 'object' ? opts : {};
    for (const key of Object.keys(src)) {
      if (src[key] !== undefined) out[key] = src[key];
    }
    return out;
  };

  return {
    ok: true,
    root: base,
    store: s,
    paths: marketPaths(base),
    /** 货架 */
    catalog: (opts = {}) => listCatalog(merge(opts)),
    /** 单件皮肤 */
    entry: (skinId, opts = {}) => getCatalogEntry({ ...merge(opts), skinId }),
    /** 带本机购买的授权（activateSkin 用这个） */
    license: (opts = {}) => marketLicense(merge(opts)),
    /** 下单（不动钱） */
    placeOrder: (opts = {}) => placeOrder(merge(opts)),
    /** 确认支付（没配渠道 → { ok:false, reason:'环境未配' }） */
    confirm: (opts = {}) => confirmPayment(merge(opts)),
    /** 下单 + 确认支付 */
    buy: (opts = {}) => buyNow(merge(opts)),
    /** 真渠道退款 → 本地冲正（没配退款通道 → refund_unconfigured） */
    refund: (opts = {}) => refundOrder(merge(opts)),
    /**
     * 购买/退款两个通道配没配（分开说，不混成一句"已配置"）。
     * 渠道状态的判定需要商业层的 billingHealth —— 由调用方注入，market 层不自己读 env。
     */
    health: (opts = {}) => {
      if (typeof opts.billingHealth === 'function') return opts.billingHealth(billing, { http, ...opts });
      const adapter = resolveBilling(billing);
      const refund = resolveRefundBilling(billing);
      return {
        ok: adapter.ok,
        provider: adapter.ok ? String(adapter.adapter.id || 'custom') : '',
        configured: adapter.ok,
        purchaseConfigured: adapter.ok,
        refundConfigured: refund.ok,
        reason: adapter.ok ? '' : ENV_UNCONFIGURED,
        hint: adapter.ok
          ? (refund.ok ? '' : '购买已通；退款渠道还没配')
          : '没有在线收款渠道。人工渠道可用：deck_market place → 转账 → confirm。',
      };
    },
    /** 订单列表 / 单张订单 */
    orders: (opts = {}) => listOrders(merge(opts)),
    order: (orderId, opts = {}) => getOrder({ ...merge(opts), orderId }),
    /** 已购皮肤 */
    purchases: (opts = {}) => purchasedSkins(merge(opts)),
    /** 分账合计（全是整数分） */
    totals: () => ledgerTotals(s.readLedger().doc),
    /** 单笔分账 */
    split: (amountCents, opts = {}) => splitCents(amountCents, opts),
  };
}
