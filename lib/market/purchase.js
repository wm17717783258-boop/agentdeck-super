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
 * 拆分边界（1.11.9）：
 *   本文件在**开源侧**，负责"订单怎么走、钱到了怎么发货"这套账务规则；
 *   "从环境变量认出真实渠道"（billingFromEnv / billingHealth）搬去了 pro/billing/from-env.js。
 *   这么切的好处很实在：免费用户也能下单、人工确认、拿授权码、退款，
 *   只是在线收银台要装 Pro —— 而不是像拆分前那样，连买东西的入口都一起没了。
 *
 * BillingAdapter：
 *   {
 *     id: 'afdian',            // 渠道标识，进订单流水
 *     configured: true,        // 老字段：购买通道是否可用；显式 false = 当没配
 *     purchaseConfigured: true,// 购买通道（新字段，优先于 configured）
 *     refundConfigured: true,  // 退款通道（和购买分开；只配退款也能退款）
 *     charge: async ({ order, amount, currency, skinId, http }) =>
 *       { ok:true, paid:true, ref:'渠道流水号' } | { ok:false, reason:'渠道原话' },
 *     refund: async ({ order, amount, currency, skinId, refundId, paymentRef, reason, http }) =>
 *       { ok:true, refunded:true, ref:'退款流水号' } | { ok:false, reason:'渠道原话' }
 *   }
 */

import { createHash, randomUUID } from 'node:crypto';
import { getCatalogEntry, licenseWithPurchases, resolveLicense, MARKET_CURRENCY } from './catalog.js';
import { clockOf, isoOf, ledgerEntryId, createMarketStore, purchasedSkinIds } from './store.js';
import { splitCents } from './split.js';

/** 没配支付渠道时的统一答复（对外文案就是这四个字，别改） */
export const ENV_UNCONFIGURED = '环境未配';

/** 支付渠道的展示名（核心与商业层共用同一份，避免两边叫法不一致） */
export const PAYMENT_LABELS = Object.freeze({ afdian: '爱发电', wechat: '微信支付', stripe: 'Stripe', apple: 'App Store', custom: '自定义渠道' });

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
  // updateLedger 也是必需的：账本的读-改-写必须在锁里一次做完，
  // 缺了它就只能退回"先读整份、再整份写回"，多进程同时确认会互相覆盖。
  if (typeof store.updateLedger !== 'function') return null;
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
    const purchaseOk = typeof item.purchaseConfigured === 'boolean'
      ? item.purchaseConfigured
      : item.configured !== false;
    if (!purchaseOk) return null;
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
 * 退款渠道的解析规则和收款分开：
 *   只给了 charge 函数（老的自定义渠道 / 裸函数）不算能退款；
 *   必须显式提供 refund 函数，且 configured 不能是 false。
 */
export function resolveRefundBilling(billing) {
  const fail = (detail) => ({ ok: false, reason: ENV_UNCONFIGURED, detail });
  if (billing === undefined || billing === null) {
    return fail('没有配置退款渠道（billing 为空）：本机不会伪造“已退款”');
  }
  if (typeof billing === 'function') {
    return fail('只给了扣款函数，没有退款函数：退款必须由真实渠道确认');
  }
  const pick = (item) => {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.refund !== 'function') return null;
    const refundOk = typeof item.refundConfigured === 'boolean'
      ? item.refundConfigured
      : item.configured !== false;
    if (!refundOk) return null;
    return item;
  };
  if (Array.isArray(billing)) {
    for (const item of billing) {
      const adapter = pick(item);
      if (adapter) return { ok: true, adapter };
    }
    return fail('退款渠道列表里没有能用的（configured/refundConfigured 是 false，或者没有 refund 函数）');
  }
  const adapter = pick(billing);
  if (!adapter) return fail('退款渠道形状不对：需要 refund 函数，且 configured/refundConfigured 不能是 false');
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
        return {
          ok: true, order: existing, amount: existing.amount, currency: MARKET_CURRENCY,
          payable: existing.amount, reused: true, reusedBecause: 'idempotency_key',
        };
      }
    }

    /*
     * 同一套皮肤已经有待付款单 → 复用那张，不再开新的。
     *
     * 为什么这条很要紧（不是洁癖）：
     *   人工收款的付款备注是 `MANUAL-<orderId>`。如果用户问两次"买这套"就生成两张单，
     *   账本里会躺着两个不同的备注 —— 转账时按哪个？确认时确认哪张？
     *   结果就是另一张永远挂在"待付款"，对账时全是噪音，退款时更说不清。
     *   这跟电商的常识也一致：**未支付订单是复用，不是堆积**。
     *
     * 只在同一个 buyer 内复用：不同人各买各的，不能因为"A 挂着一张没付"就拦着 B 下单。
     */
    const pending = read.doc.orders.find((order) => order.skinId === id
      && order.state === 'created'
      && str(order.buyer, 'local') === who);
    if (pending) {
      return {
        ok: true,
        order: pending,
        amount: pending.amount,
        currency: MARKET_CURRENCY,
        payable: pending.amount,
        reused: true,
        reusedBecause: 'pending_order',
      };
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
  // 读-改-写必须在锁里一次做完：先 readLedger 再 writeLedger(ledger) 的写法，
  // 在两个宿主同时确认时会把对方的流水整份覆盖掉（实测丢过单）。
  const entryId = ledgerEntryId(order.id, 'sale');
  const wroteLedger = store.updateLedger((ledger) => {
    if (!ledger.entries.some((entry) => entry.id === entryId)) {
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
    return ledger;
  });
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

    // state === 'created'：这里才需要真渠道。
    // 核心**不读环境变量** —— "从 env 认出渠道"属闭源层（pro/billing/from-env.js）。
    // 没传 billing 就等于没配：宁可如实说"环境未配"，也不猜。
    const source = billing === undefined ? null : billing;
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
 * 退款：先让真实渠道确认退款成功，再冲正本地账、收回皮肤。
 *
 * 三条硬边界（任何一条没满足都不许说“已退款”）：
 *   1. 没配退款通道（AGENTDECK_PAY_REFUND_URL / 注入的 refund 适配器）→ refund_unconfigured；
 *   2. 渠道报错、拒绝、没返回 refunded:true 或没有退款流水号 → refund_failed；
 *   3. 只有渠道明确成功之后，才写退款流水、把订单改成 refunded、收回皮肤。
 *
 * 失败时订单保持 delivered（皮肤仍可用），本地账本一分不动。
 * refundId 由订单号固定派生，重试同一张单不会生成第二个退款号。
 *
 * @param {{ store?:object, root?:string, orderId:string, billing?:any, http?:object,
 *   reason?:string, now?:any, profile?:object }} opts
 * @returns {Promise<object>}
 */
export async function refundOrder({ store, root, orderId, billing, http, reason = '用户申请退款', now, profile } = {}) {
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

    // 同上：核心不读 env，没传就是没配。
    const source = billing === undefined ? null : billing;
    const resolved = resolveRefundBilling(source);
    if (!resolved.ok) {
      return {
        ok: false,
        code: 'refund_unconfigured',
        reason: ENV_UNCONFIGURED,
        detail: resolved.detail,
        order,
        note: '退款通道没配：订单保持已发放，皮肤仍可用；本机没有假装钱已经退回。',
      };
    }

    const at = isoOf(ms);
    const why = str(reason, '用户申请退款').slice(0, 200);
    const refundId = plain(order.refund).refundId
      ? String(order.refund.refundId)
      : `rfd_${order.id}`;

    // 如果上一轮渠道已成功、但本地订单没写完，账本里会有带 channelRef 的退款流水。
    // 这时不再发第二次退款请求，只把本地状态补齐。
    const ledgerRead = s.readLedger();
    const entryId = ledgerEntryId(order.id, 'refund');
    const existingEntry = ledgerRead.doc.entries.find((entry) => entry.id === entryId) || null;
    let channelRef = existingEntry && existingEntry.channelRef ? String(existingEntry.channelRef) : '';
    let provider = existingEntry && existingEntry.channel && existingEntry.channel.provider
      ? String(existingEntry.channel.provider)
      : '';

    if (!channelRef) {
      let result;
      try {
        result = await resolved.adapter.refund({
          order,
          amount: order.amount,
          currency: order.currency || MARKET_CURRENCY,
          skinId: order.skinId,
          refundId,
          paymentRef: plain(order.payment).ref || '',
          reason: why,
          http,
        });
      } catch (err) {
        return {
          ok: false,
          code: 'refund_failed',
          reason: `退款渠道报错：${errText(err)}`,
          detail: '订单保持已发放，皮肤仍可用；本地账本没有改动。',
          order,
          refundId,
        };
      }

      const channelOk = result
        && typeof result === 'object'
        && result.ok === true
        && result.refunded === true
        && str(result.ref) !== '';
      if (!channelOk) {
        const whyFailed = str(
          result && result.reason,
          '退款渠道没有确认退款成功（需要 refunded:true 和非空退款流水号）',
        );
        return {
          ok: false,
          code: result && result.code === 'refund_unconfigured' ? 'refund_unconfigured' : 'refund_failed',
          reason: whyFailed,
          detail: result && result.detail ? String(result.detail) : '订单保持已发放，皮肤仍可用；本地账本没有改动。',
          order,
          refundId,
          channel: result && typeof result === 'object' ? result : null,
        };
      }
      channelRef = str(result.ref).slice(0, 160);
      provider = str(result.provider, str(resolved.adapter.id, 'custom')).slice(0, 40);
    }

    if (!provider) provider = str(resolved.adapter.id, 'custom').slice(0, 40);

    // 渠道那边已经退完钱了，落账这一步必须在锁里重读一遍再改：
    // 前面那次 readLedger 只是为了判断"上一轮是否已经退过"，
    // 它拿到的是好几秒前的快照，直接写回去会把并发产生的其它流水抹掉。
    const wroteLedger = s.updateLedger((doc) => {
      const found = doc.entries.find((entry) => entry.id === entryId) || null;
      if (!found) {
        doc.entries.push({
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
          provider,
          channelRef,
          channel: { provider, ref: channelRef, refundId },
        });
      } else {
        found.provider = provider;
        found.channelRef = channelRef;
        found.channel = { provider, ref: channelRef, refundId };
      }
      for (const purchase of doc.purchases) {
        if (purchase.orderId === order.id && !purchase.refundedAt) purchase.refundedAt = at;
      }
      doc.updatedAt = at;
      return doc;
    });
    if (!wroteLedger || wroteLedger.ok === false) {
      return {
        ok: false,
        code: 'persist_failed',
        reason: `渠道已确认退款，但退款流水没写进磁盘：${(wroteLedger && wroteLedger.reason) || '未知原因'}（用同一个退款号重试不会重复退）`,
        order,
        refundId,
        channel: { provider, ref: channelRef, refundId },
      };
    }

    const refundedOrder = {
      ...order,
      state: 'refunded',
      updatedAt: at,
      refund: {
        provider,
        ref: channelRef,
        refundId,
        reason: why,
        at,
      },
    };
    const wroteOrders = s.updateOrders((doc) => {
      replaceOrder(doc, refundedOrder);
      doc.updatedAt = at;
      return doc;
    });
    if (!wroteOrders || wroteOrders.ok === false) {
      return {
        ok: false,
        code: 'persist_failed',
        reason: `退款流水已记，但订单状态没落盘：${(wroteOrders && wroteOrders.reason) || '未知原因'}（用同一个退款号重试即可，不会重复退）`,
        order: refundedOrder,
        refundId,
        channel: { provider, ref: channelRef, refundId },
      };
    }
    const saved = wroteOrders.doc.orders.find((item) => item.id === order.id) || refundedOrder;

    // 退款成功不等于"皮肤还在用"：如果用户已经把退掉的那套设为当前外观，
    // 必须在账本冲正后把外观切回 basic。是否收回以市场自己的 owned 判定为准：
    // 同一套皮肤如果还被签名授权/档位权益覆盖，就不能误伤。
    let profileReset = null;
    try {
      const p = profile && typeof profile.get === 'function' && typeof profile.update === 'function'
        ? profile
        : null;
      if (p) {
        const before = p.get() || {};
        const active = str(before.skins && before.skins.active);
        const refundedSkin = str(order.skinId);
        if (active && active === refundedSkin) {
          const after = getCatalogEntry({ store: s, root: s.root, skinId: refundedSkin });
          const stillOwned = Boolean(after && after.ok !== false && after.entry && after.entry.owned);
          profileReset = { needed: !stillOwned, ok: true, active, next: stillOwned ? active : 'basic' };
          if (!stillOwned) {
            const wroteProfile = p.update((draft) => {
              draft.skins = { ...(plain(draft.skins)), active: 'basic' };
              draft.updatedAt = at;
            });
            if (!wroteProfile || wroteProfile.ok === false) {
              profileReset.ok = false;
              profileReset.reason = (wroteProfile && wroteProfile.reason) || '档案写入失败';
            }
          }
        } else {
          profileReset = { needed: false, ok: true, active: active || 'basic' };
        }
      }
    } catch (err) {
      profileReset = { needed: true, ok: false, active: 'unknown', reason: errText(err) };
    }

    return {
      ok: true,
      order: saved,
      refunded: true,
      amount: order.amount,
      currency: MARKET_CURRENCY,
      reason: why,
      split,
      refundId,
      channel: { provider, ref: channelRef, refundId },
      profileReset,
      note: profileReset && profileReset.ok === false
        ? '渠道已确认退款；本机账已冲正，皮肤授权已收回，但当前外观切回 basic 失败（渲染仍会按授权 fail-closed）。'
        : '渠道已确认退款；本机账已冲正，皮肤授权已收回。',
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
