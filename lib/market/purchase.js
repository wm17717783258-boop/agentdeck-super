/**
 * lib/market/purchase.js —— 下单 / 确认支付 / 发放 / 退款
 *
 * 这块的关键不是「能买到」，而是**买不到的时候不撒谎**：
 *   - 没有配真实支付渠道 → confirmPayment 一律返回 { ok:false, reason:'环境未配' }，
 *     绝不自作主张把订单标成 paid，也绝不假装发放成功；
 *   - 支付渠道说没收到钱（返回里没有 paid:true）→ 订单留在 created，等配置好了重试；
 *   - 渠道报错 / 半路抛异常 → 包成 { ok:false, reason }，不往上抛。
 *
 * 真实收款只发生在注入的 billing 适配器里（形状见下方 BillingAdapter），
 * 本模块不联网、不读密钥、不伪造支付回执。
 *
 * BillingAdapter：
 *   {
 *     id: 'afdian',            // 渠道标识，进订单流水
 *     configured: true,        // 必须 true（或省略）；显式 false = 当没配
 *     charge: async ({ order, amount, currency, skinId, http }) =>
 *       { ok:true, paid:true, ref:'渠道流水号' } | { ok:false, reason:'渠道原话' }
 *   }
 */

import { createHash, randomUUID } from 'node:crypto';
import { getCatalogEntry, licenseWithPurchases, resolveLicense, MARKET_CURRENCY } from './catalog.js';
import { clockOf, isoOf, ledgerEntryId, createMarketStore, purchasedSkinIds } from './store.js';
import { splitCents } from './split.js';

/** 没配支付渠道时的统一答复（对外文案就是这四个字，别改） */
export const ENV_UNCONFIGURED = '环境未配';

/** 订单未支付时的默认留档原因 */
const PAYMENT_LABELS = Object.freeze({ afdian: '爱发电', wechat: '微信支付', stripe: 'Stripe', apple: 'App Store', custom: '自定义渠道' });

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function badStore() {
  return { ok: false, reason: '需要一个 createMarketStore() 建出来的账本 store（拿 root 现建也行）' };
}

function ensureStore(store) {
  if (!store || typeof store !== 'object') return null;
  if (typeof store.readOrders !== 'function' || typeof store.updateOrders !== 'function') return null;
  if (typeof store.readLedger !== 'function' || typeof store.writeLedger !== 'function') return null;
  return store;
}

/** 时钟：显式 now 优先，其次 store 自己的时钟 */
function nowOf(store, now) {
  if (now !== undefined && now !== null) return clockOf(now);
  if (store && typeof store.now === 'function') return clockOf(store.now());
  return Date.now();
}

function replaceOrder(doc, order) {
  const index = doc.orders.findIndex((item) => item.id === order.id);
  if (index >= 0) doc.orders[index] = order;
  else doc.orders.push(order);
  return doc;
}

/**
 * 发放凭证：由订单 + 皮肤算出来，重试也得到同一个码（幂等靠它）。
 * 注意这不是 ADSK1 授权码，只是本机购买回执号。
 */
export function deliveryCode(orderId, skinId) {
  const hash = createHash('sha256').update(`${orderId}|${skinId}`).digest('hex').slice(0, 8).toUpperCase();
  const tag = String(skinId || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return `SKIN-${tag}-${hash}`;
}

// ---------------------------------------------------------------------------
// 支付渠道：只有「显式配置过」才算配了
// ---------------------------------------------------------------------------

/**
 * 把调用方给的 billing 归一成一个可用适配器。
 * 认三种写法：函数 / 适配器对象 / 适配器数组；其它一律当没配。
 * @param {any} billing
 * @returns {{ ok:true, adapter:object } | { ok:false, reason:'环境未配', detail:string }}
 */
export function resolveBilling(billing) {
  const fail = (detail) => ({ ok: false, reason: ENV_UNCONFIGURED, detail });
  if (billing === undefined || billing === null) {
    return fail('没有配置支付渠道（billing 为空）：本机不会伪造支付成功');
  }
  if (typeof billing === 'function') {
    return { ok: true, adapter: { id: 'custom', label: PAYMENT_LABELS.custom, configured: true, charge: billing } };
  }
  const pick = (item) => {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.charge !== 'function') return null;
    if (item.configured === false) return null;
    return item;
  };
  if (Array.isArray(billing)) {
    for (const item of billing) {
      const adapter = pick(item);
      if (adapter) return { ok: true, adapter };
    }
    return fail('支付渠道列表里没有能用的（configured 都是 false，或者没有 charge 函数）');
  }
  const adapter = pick(billing);
  if (!adapter) return fail('支付渠道形状不对：需要 charge 函数，且 configured 不能是 false');
  return { ok: true, adapter };
}

/**
 * 从环境变量拼一个真实渠道适配器（只在显式配了 provider + url 时才成功）。
 * 这里只准备适配器，真正发请求靠注入的 http（形状 { post(url, body) }）。
 * @param {object} [env] 默认 process.env
 * @param {{ http?:object }} [opts]
 */
export function billingFromEnv(env = process.env, { http } = {}) {
  const source = plain(env);
  const provider = str(source.AGENTDECK_PAY_PROVIDER).toLowerCase();
  const url = str(source.AGENTDECK_PAY_URL);
  if (!provider || !url) {
    return {
      ok: false,
      reason: ENV_UNCONFIGURED,
      detail: '环境变量里没有支付渠道：AGENTDECK_PAY_PROVIDER / AGENTDECK_PAY_URL 至少要配一个真实渠道地址',
    };
  }
  const token = str(source.AGENTDECK_PAY_TOKEN);
  const adapter = {
    id: provider,
    label: PAYMENT_LABELS[provider] || `${provider} 支付`,
    configured: true,
    url,
    charge: ({ order, amount, currency, http: injected } = {}) => {
      const client = injected || http;
      if (!client || typeof client.post !== 'function') {
        return { ok: false, reason: '没有注入 http 客户端，发不出支付请求（本机不会假装收到钱）' };
      }
      return client.post(url, {
        orderId: order && order.id,
        skinId: order && order.skinId,
        amount,
        currency,
        provider,
        token,
      });
    },
  };
  return { ok: true, adapter };
}

// ---------------------------------------------------------------------------
// 下单
// ---------------------------------------------------------------------------

/**
 * 建一张待支付订单（不碰钱，只落本地账本）。
 *
 * @param {{ store?:object, root?:string, skinId:string, license?:any, now?:any,
 *   buyer?:string, idempotencyKey?:string }} opts
 * @returns {{ ok:true, order:object, amount:number, currency:'CNY', payable:number, reused:boolean }
 *   | { ok:false, reason:string, code?:string }}
 */
export function placeOrder({ store, root, skinId, license, now, buyer = 'local', idempotencyKey = '' } = {}) {
  try {
    const s = ensureStore(store) || (root ? createMarketStore({ root, now }) : null);
    if (!s) return badStore();
    const ms = nowOf(s, now);
    const id = str(skinId).toLowerCase();
    if (!id) return { ok: false, code: 'bad_skin', reason: '要买哪套皮肤？skinId 是空的' };

    const found = getCatalogEntry({ store: s, license, now: ms, skinId: id });
    if (!found.ok) return { ok: false, code: 'no_skin', reason: found.reason };
    const skin = found.entry;
    // 先判免费：免费皮肤本来就 owned，别报成「已拥有」让人以为买过
    if (skin.price <= 0) {
      return { ok: false, code: 'free_skin', reason: `「${skin.name}」是免费皮肤，直接激活就行，不用下单`, skinId: skin.id };
    }
    if (skin.owned) {
      return { ok: false, code: 'already_owned', reason: `「${skin.name}」你已经有授权了，不用再买`, skinId: skin.id };
    }

    const key = str(idempotencyKey);
    const who = str(buyer, 'local').slice(0, 64);
    const read = s.readOrders();
    if (key) {
      const existing = read.doc.orders.find((order) => order.buyer === who && str(plain(order.meta).idempotencyKey) === key);
      if (existing) {
        return { ok: true, order: existing, amount: existing.amount, currency: MARKET_CURRENCY, payable: existing.amount, reused: true };
      }
    }

    const at = isoOf(ms);
    const order = {
      id: `ord_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      skinId: skin.id,
      skinName: skin.name,
      author: skin.author,
      state: 'created',
      amount: skin.price, // 整数分，直接用目录里的价格
      currency: MARKET_CURRENCY,
      buyer: who,
      createdAt: at,
      updatedAt: at,
      payment: null,
      delivery: null,
      refund: null,
      meta: key ? { idempotencyKey: key } : {},
    };
    const wrote = s.updateOrders((doc) => {
      doc.orders.push(order);
      doc.updatedAt = at;
      return doc;
    });
    if (!wrote || wrote.ok === false) {
      return { ok: false, code: 'persist_failed', reason: wrote && wrote.reason ? wrote.reason : '订单没能写进磁盘' };
    }
    const saved = wrote.doc.orders.find((item) => item.id === order.id) || order;
    return { ok: true, order: saved, amount: saved.amount, currency: MARKET_CURRENCY, payable: saved.amount, reused: false };
  } catch (err) {
    return { ok: false, code: 'exception', reason: `下单时出错：${errText(err)}` };
  }
}

// ---------------------------------------------------------------------------
// 发放（确认收款之后才走这里）
// ---------------------------------------------------------------------------

function deliverPaid(store, order, ms) {
  const split = splitCents(order.amount);
  if (!split.ok) return { ok: false, code: 'split_failed', reason: `分账算不出来：${split.reason}`, order };

  const at = isoOf(ms);
  const code = plain(order.delivery).code ? String(order.delivery.code) : deliveryCode(order.id, order.skinId);
  const ledgerRead = store.readLedger();
  const ledger = ledgerRead.doc;
  const entryId = ledgerEntryId(order.id, 'sale');
  const alreadyBooked = ledger.entries.some((entry) => entry.id === entryId);

  if (!alreadyBooked) {
    ledger.entries.push({
      id: entryId,
      at,
      orderId: order.id,
      skinId: order.skinId,
      kind: 'sale',
      amount: order.amount,
      currency: MARKET_CURRENCY,
      creator: { shareBps: split.creatorBps, amount: split.creator },
      platform: { shareBps: split.platformBps, amount: split.platform },
    });
  }
  if (!ledger.purchases.some((item) => item.orderId === order.id)) {
    ledger.purchases.push({ skinId: order.skinId, orderId: order.id, at, code, refundedAt: null });
  }
  ledger.updatedAt = at;
  const wroteLedger = store.writeLedger(ledger);
  if (!wroteLedger || wroteLedger.ok === false) {
    return {
      ok: false,
      code: 'persist_failed',
      reason: `钱收到了，但分账账本写不进去：${(wroteLedger && wroteLedger.reason) || '未知原因'}（重试确认即可，不会重复扣款）`,
      order,
      split,
    };
  }

  const delivered = { ...order, state: 'delivered', updatedAt: at, delivery: { code, deliveredAt: at } };
  const wroteOrders = store.updateOrders((doc) => {
    replaceOrder(doc, delivered);
    doc.updatedAt = at;
    return doc;
  });
  if (!wroteOrders || wroteOrders.ok === false) {
    return {
      ok: false,
      code: 'persist_failed',
      reason: `皮肤凭证已经记进账本，但订单状态没落盘：${(wroteOrders && wroteOrders.reason) || '未知原因'}（重试确认即可）`,
      order: delivered,
      deliveryCode: code,
      split,
    };
  }
  const saved = wroteOrders.doc.orders.find((item) => item.id === order.id) || delivered;
  return { ok: true, order: saved, code, split, delivered: true, already: false };
}

// ---------------------------------------------------------------------------
// 确认支付
// ---------------------------------------------------------------------------

/**
 * 确认一张订单的支付。三种结局分得很清楚：
 *   1. 没配渠道 → { ok:false, reason:'环境未配' }，订单原样留在 created；
 *   2. 渠道说没收到钱 → { ok:false, reason: 渠道原话 }，订单还是 created；
 *   3. 真收到钱 → 发放 + 分账 + 订单 delivered（重试返回 already:true，不重复记账）。
 *
 * @param {{ store?:object, root?:string, orderId:string, billing?:any, http?:object, now?:any }} opts
 * @returns {Promise<object>} 永不抛错
 */
export async function confirmPayment({ store, root, orderId, billing, http, now } = {}) {
  try {
    const s = ensureStore(store) || (root ? createMarketStore({ root, now }) : null);
    if (!s) return badStore();
    const ms = nowOf(s, now);
    const id = str(orderId);
    const read = s.readOrders();
    const order = read.doc.orders.find((item) => item.id === id);
    if (!order) return { ok: false, code: 'no_order', reason: `没有这个订单：${id || '(空)'}` };

    if (order.state === 'refunded') {
      return { ok: false, code: 'refunded', reason: '订单已经退过款了，不能再支付', order };
    }
    if (order.state === 'delivered') {
      return { ok: true, already: true, order, code: plain(order.delivery).code || null, split: splitCents(order.amount) };
    }
    if (order.state === 'paid') {
      // 钱已经付了，只是上次发放没走完：接着发放，绝不再扣一次
      const done = deliverPaid(s, order, ms);
      return { ...done, already: true };
    }

    // state === 'created'：这里才需要真渠道
    const source = billing === undefined ? billingFromEnv(process.env, { http }).adapter : billing;
    const resolved = resolveBilling(source);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: ENV_UNCONFIGURED,
        code: 'billing_unconfigured',
        detail: resolved.detail,
        order,
        split: null,
      };
    }

    let result;
    try {
      result = await resolved.adapter.charge({
        order,
        amount: order.amount,
        currency: order.currency || MARKET_CURRENCY,
        skinId: order.skinId,
        http,
      });
    } catch (err) {
      return { ok: false, code: 'charge_error', reason: `支付渠道报错：${errText(err)}`, order };
    }

    const paid = result && typeof result === 'object' && result.paid === true && result.ok !== false;
    if (!paid) {
      const why = str(result && result.reason, '支付渠道没有确认收款（响应里没有 paid:true）');
      return { ok: false, code: 'charge_failed', reason: why, detail: '订单保持待支付，配好渠道后可以重试', order };
    }

    const at = isoOf(ms);
    const provider = str(result.provider, str(resolved.adapter.id, 'custom'));
    const paidOrder = {
      ...order,
      state: 'paid',
      updatedAt: at,
      payment: { provider: provider.slice(0, 40), ref: str(result.ref).slice(0, 120), paidAt: at },
    };
    const wrote = s.updateOrders((doc) => {
      replaceOrder(doc, paidOrder);
      doc.updatedAt = at;
      return doc;
    });
    if (!wrote || wrote.ok === false) {
      return {
        ok: false,
        code: 'persist_failed',
        reason: `钱可能已经付了，但订单状态没落盘：${(wrote && wrote.reason) || '未知原因'}（重试确认即可，渠道那边有流水号）`,
        order: paidOrder,
      };
    }
    return deliverPaid(s, paidOrder, ms);
  } catch (err) {
    return { ok: false, code: 'exception', reason: `确认支付时出错：${errText(err)}` };
  }
}

/** 一键买：先下单再确认支付（没配渠道时第一步成功、第二步如实失败） */
export async function buyNow({ store, root, skinId, license, billing, http, now, buyer, idempotencyKey } = {}) {
  const placed = placeOrder({ store, root, skinId, license, now, buyer, idempotencyKey });
  if (!placed.ok) return placed;
  const paid = await confirmPayment({ store, root, orderId: placed.order.id, billing, http, now });
  return { ...paid, order: paid.order || placed.order, placed };
}

// ---------------------------------------------------------------------------
// 退款
// ---------------------------------------------------------------------------

/**
 * 退款：订单转 refunded，分账记一条负数抵消的流水，已购皮肤失效。
 * 真退款动作由支付渠道负责——本模块只记本地账，不假装钱已经退回。
 *
 * @param {{ store?:object, root?:string, orderId:string, reason?:string, now?:any }} opts
 */
export function refundOrder({ store, root, orderId, reason = '用户申请退款', now } = {}) {
  try {
    const s = ensureStore(store) || (root ? createMarketStore({ root, now }) : null);
    if (!s) return badStore();
    const ms = nowOf(s, now);
    const id = str(orderId);
    const read = s.readOrders();
    const order = read.doc.orders.find((item) => item.id === id);
    if (!order) return { ok: false, code: 'no_order', reason: `没有这个订单：${id || '(空)'}` };
    if (order.state === 'refunded') {
      return { ok: false, code: 'already_refunded', reason: '这笔订单已经退过款了', order };
    }
    if (order.state !== 'paid' && order.state !== 'delivered') {
      return { ok: false, code: 'not_paid', reason: '订单还没支付，不用退款', order };
    }
    const split = splitCents(order.amount);
    if (!split.ok) return { ok: false, code: 'split_failed', reason: `分账算不出来：${split.reason}`, order };

    const at = isoOf(ms);
    const why = str(reason, '用户申请退款').slice(0, 200);
    const ledgerRead = s.readLedger();
    const ledger = ledgerRead.doc;
    const entryId = ledgerEntryId(order.id, 'refund');
    if (!ledger.entries.some((entry) => entry.id === entryId)) {
      ledger.entries.push({
        id: entryId,
        at,
        orderId: order.id,
        skinId: order.skinId,
        kind: 'refund',
        amount: order.amount,
        currency: MARKET_CURRENCY,
        creator: { shareBps: split.creatorBps, amount: split.creator },
        platform: { shareBps: split.platformBps, amount: split.platform },
        reason: why,
      });
    }
    for (const purchase of ledger.purchases) {
      if (purchase.orderId === order.id && !purchase.refundedAt) purchase.refundedAt = at;
    }
    ledger.updatedAt = at;
    const wroteLedger = s.writeLedger(ledger);
    if (!wroteLedger || wroteLedger.ok === false) {
      return { ok: false, code: 'persist_failed', reason: (wroteLedger && wroteLedger.reason) || '退款流水没写进磁盘', order };
    }

    const refundedOrder = { ...order, state: 'refunded', updatedAt: at, refund: { reason: why, at } };
    const wroteOrders = s.updateOrders((doc) => {
      replaceOrder(doc, refundedOrder);
      doc.updatedAt = at;
      return doc;
    });
    if (!wroteOrders || wroteOrders.ok === false) {
      return {
        ok: false,
        code: 'persist_failed',
        reason: `退款流水已记，但订单状态没落盘：${(wroteOrders && wroteOrders.reason) || '未知原因'}`,
        order: refundedOrder,
      };
    }
    const saved = wroteOrders.doc.orders.find((item) => item.id === order.id) || refundedOrder;
    return {
      ok: true,
      order: saved,
      refunded: true,
      amount: order.amount,
      currency: MARKET_CURRENCY,
      reason: why,
      split,
      note: '本地账已冲正；真实退款动作由支付渠道执行，本模块不代付',
    };
  } catch (err) {
    return { ok: false, code: 'exception', reason: `退款时出错：${errText(err)}` };
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 列订单（可按状态过滤） */
export function listOrders({ store, root, state, now } = {}) {
  const s = ensureStore(store) || (root ? createMarketStore({ root, now }) : null);
  if (!s) return badStore();
  const read = s.readOrders();
  const orders = (state ? read.doc.orders.filter((order) => order.state === state) : read.doc.orders)
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const counts = { created: 0, paid: 0, delivered: 0, refunded: 0 };
  for (const order of read.doc.orders) counts[order.state] = (counts[order.state] || 0) + 1;
  return { ok: true, orders, counts, recovered: read.recovered, warnings: read.warnings };
}

/** 按 id 取一张订单 */
export function getOrder({ store, root, orderId, now } = {}) {
  const s = ensureStore(store) || (root ? createMarketStore({ root, now }) : null);
  if (!s) return badStore();
  const read = s.readOrders();
  const order = read.doc.orders.find((item) => item.id === str(orderId));
  if (!order) return { ok: false, code: 'no_order', reason: `没有这个订单：${str(orderId) || '(空)'}` };
  return { ok: true, order };
}

/** 已购皮肤（列表 + 明细） */
export function purchasedSkins({ store, root, now } = {}) {
  const s = ensureStore(store) || (root ? createMarketStore({ root, now }) : null);
  if (!s) return badStore();
  const read = s.readLedger();
  return {
    ok: true,
    skins: purchasedSkinIds(read.doc),
    purchases: read.doc.purchases.slice(),
    recovered: read.recovered,
    warnings: read.warnings,
  };
}

/**
 * 给 activateSkin / checkSkinLicense 用的授权：真实授权 + 本机购买记录。
 * 这是「市场买过的皮肤能装备」的唯一入口，别让业务层自己去拼 claims。
 *
 * @param {{ store?:object, root?:string, license?:any, now?:any }} opts
 */
export function marketLicense({ store, root, license, now } = {}) {
  const s = ensureStore(store) || (root ? createMarketStore({ root, now }) : null);
  if (!s) return badStore();
  const purchased = purchasedSkinIds(s.readLedger().doc);
  const base = license !== undefined ? license : resolveLicense({ root: s.root, license, now });
  const merged = licenseWithPurchases(base, purchased);
  return {
    ok: true,
    license: merged,
    purchased,
    tier: merged && merged.tier ? merged.tier : 'free',
    local: true,
  };
}
