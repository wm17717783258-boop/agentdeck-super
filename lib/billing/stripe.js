/**
 * lib/billing/stripe.js —— Stripe Checkout / Webhook / Refund 的真实实现（只用 fetch + node:crypto）
 *
 * 为什么不用官方 SDK：本项目铁律是零第三方依赖、package.json 不许动。Stripe 的 REST 就是
 * 表单 + JSON，签名规范也稳定，自己实现反而少一层供应链风险，还能精确控制"没配密钥就说没配"。
 *
 * 三个动作对应三条真实 API：
 * - 发起支付：POST /v1/checkout/sessions（返回托管收银台 url，卡号不经过我们）
 * - 收款回调：HMAC-SHA256 校验 Stripe-Signature（t=…,v1=…），带 300s 时间戳容差防重放
 * - 退款：POST /v1/refunds（必须给 payment_intent 或 charge，orderId 只是我们自己的单号）
 *
 * 安全约定：secretKey / webhookSecret 只在本文件内存里出现，不进日志、不进返回值、
 * 不进 raw（raw 是 Stripe 的响应体，本身不含我们的密钥）。
 */

import { hmacSha256Hex, safeEqual } from './sign.js';
import { headerValue, httpCall, providerMessage, unconfiguredResult, UNCONFIGURED } from './shared.js';
import { assertMinor } from './amount.js';

export const STRIPE_PROVIDER = 'stripe';
export const STRIPE_API_BASE = 'https://api.stripe.com';
export const STRIPE_TOLERANCE_SEC = 300;

/** 这些事件类型代表"钱真的到账了"；其余事件一律 paid:false，交给调用方决定要不要管。 */
const PAID_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'payment_intent.succeeded',
  'charge.succeeded',
  'invoice.paid',
  'invoice.payment_succeeded',
]);

/** 解析 `t=1690000000,v1=abc,v1=def`；格式不对返回 null。 */
export function parseStripeSignature(header) {
  const text = String(header ?? '').trim();
  if (!text) return null;
  let t = null;
  const v1 = [];
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) t = Number(value);
    else if (key === 'v1' && value) v1.push(value);
  }
  if (t == null || v1.length === 0) return null;
  return { t, v1 };
}

function isPaidEvent(type, obj) {
  if (!PAID_EVENT_TYPES.has(type)) return false;
  if (type === 'checkout.session.completed') return obj?.payment_status === 'paid';
  if (type === 'payment_intent.succeeded') return obj?.status === 'succeeded';
  return true;
}

/**
 * @param {object} config Stripe 配置（全部可选，缺了就是"未配置"）
 * @param {string} [config.secretKey] sk_live_… / sk_test_… / rk_…
 * @param {string} [config.webhookSecret] whsec_…
 * @param {string} [config.successUrl] 支付成功回跳地址
 * @param {string} [config.cancelUrl]  用户放弃支付的回跳地址
 * @param {string} [config.currency]   默认 cny（Stripe 用小写三位代码）
 * @param {string} [config.apiBase]    默认 https://api.stripe.com（测试可指向本地假服务器）
 * @param {number} [config.webhookToleranceSec] 时间戳容差，默认 300
 * @param {object} [deps] { fetchImpl, now }
 */
export function createStripeAdapter(config = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const secretKey = String(config.secretKey || '').trim();
  const webhookSecret = String(config.webhookSecret || '').trim();
  const apiBase = String(config.apiBase || STRIPE_API_BASE).replace(/\/+$/, '');
  const currency = String(config.currency || 'cny').trim().toLowerCase();
  const toleranceSec = Number.isFinite(Number(config.webhookToleranceSec))
    ? Number(config.webhookToleranceSec)
    : STRIPE_TOLERANCE_SEC;
  const configured = Boolean(secretKey);
  const webhookConfigured = Boolean(webhookSecret);

  const mode = /^sk_live_|^rk_live_/.test(secretKey)
    ? 'live'
    : /^sk_test_|^rk_test_/.test(secretKey)
      ? 'test'
      : 'unknown';

  return {
    provider: STRIPE_PROVIDER,

    /** 配置状态：ok 只代表"能发请求"，绝不代表"收到过钱"。 */
    health() {
      return {
        ok: configured,
        provider: STRIPE_PROVIDER,
        configured,
        reason: configured ? '' : UNCONFIGURED,
        hint: configured ? '' : '设置 billing.stripe.secretKey（sk_test_… 或 sk_live_…）',
        mode,
        webhookConfigured,
        webhookHint: webhookConfigured ? '' : '设置 billing.stripe.webhookSecret（whsec_…）才能校验回调',
      };
    },

    /**
     * 发起一次托管收银台支付。成功只代表"链接建好了"，**不代表已付款**。
     * @param {{orderId: string, amount: number, currency?: string, subject?: string, successUrl?: string, cancelUrl?: string}} args
     */
    async createCheckout(args = {}) {
      if (!configured) return unconfiguredResult('设置 billing.stripe.secretKey（sk_test_… 或 sk_live_…）');
      const orderId = String(args.orderId || '').trim();
      if (!orderId) return { ok: false, reason: '缺少 orderId（我们这边的订单号，用于对账）' };
      const amount = assertMinor(args.amount, 'amount');
      const useCurrency = String(args.currency || currency).trim().toLowerCase();
      if (!/^[a-z]{3}$/.test(useCurrency)) {
        return { ok: false, reason: `currency 必须是三位小写货币代码（例如 cny/usd），收到 ${JSON.stringify(args.currency)}` };
      }
      const successUrl = String(args.successUrl || config.successUrl || '').trim();
      const cancelUrl = String(args.cancelUrl || config.cancelUrl || '').trim();
      if (!successUrl || !cancelUrl) {
        return {
          ok: false,
          reason: '缺少 successUrl / cancelUrl',
          hint: 'Stripe Checkout 必须给支付成功和取消后的回跳地址（绝对 URL）',
        };
      }
      const subject = String(args.subject || `订单 ${orderId}`).trim().slice(0, 240);

      const form = new URLSearchParams();
      form.set('mode', 'payment');
      form.set('success_url', successUrl);
      form.set('cancel_url', cancelUrl);
      form.set('client_reference_id', orderId);
      form.set('line_items[0][quantity]', '1');
      form.set('line_items[0][price_data][currency]', useCurrency);
      form.set('line_items[0][price_data][unit_amount]', String(amount));
      form.set('line_items[0][price_data][product_data][name]', subject);
      form.set('metadata[orderId]', orderId);
      if (args.customerEmail) form.set('customer_email', String(args.customerEmail));

      const res = await httpCall(fetchImpl, `${apiBase}/v1/checkout/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': orderId,
        },
        body: form.toString(),
      });
      if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail, provider: STRIPE_PROVIDER };
      if (res.status < 200 || res.status >= 300) {
        const message = providerMessage(res.json, res.text?.slice(0, 200) || '');
        return {
          ok: false,
          provider: STRIPE_PROVIDER,
          reason: `Stripe 拒单（HTTP ${res.status}）：${message || '没有返回错误说明'}`,
          httpStatus: res.status,
          detail: message,
        };
      }
      const session = res.json || {};
      if (!session.url) {
        return { ok: false, provider: STRIPE_PROVIDER, reason: 'Stripe 返回里没有支付链接（url）', raw: session };
      }
      return { ok: true, provider: STRIPE_PROVIDER, url: String(session.url), code: String(session.id || ''), raw: session };
    },

    /**
     * 校验回调并解析出「谁付了多少钱」。
     * 返回 signatureOk 与 ok 分开：签名过了但 body 坏了/不是付款事件，调用方还能区分。
     * @param {{headers?: object, rawBody?: string}} args rawBody 必须是**原始字节串**（不能先 JSON.parse 再 stringify）
     */
    verifyWebhook(args = {}) {
      if (!webhookConfigured) {
        return {
          ok: false,
          provider: STRIPE_PROVIDER,
          signatureOk: false,
          reason: UNCONFIGURED,
          hint: '设置 billing.stripe.webhookSecret（whsec_…）后才能校验回调',
        };
      }
      const rawBody = String(args.rawBody ?? '');
      const header = headerValue(args.headers, 'stripe-signature');
      if (!header) {
        return { ok: false, provider: STRIPE_PROVIDER, signatureOk: false, reason: '缺少 Stripe-Signature 请求头' };
      }
      const parsed = parseStripeSignature(header);
      if (!parsed) {
        return { ok: false, provider: STRIPE_PROVIDER, signatureOk: false, reason: 'Stripe-Signature 格式不对（应为 t=…,v1=…）' };
      }
      const nowSec = Math.floor(now() / 1000);
      const skew = Math.abs(nowSec - parsed.t);
      if (skew > toleranceSec) {
        return {
          ok: false,
          provider: STRIPE_PROVIDER,
          signatureOk: false,
          reason: `签名时间戳超出 ${toleranceSec}s 容差（可能是重放攻击）`,
          timestampSkew: skew,
        };
      }
      const expected = hmacSha256Hex(webhookSecret, `${parsed.t}.${rawBody}`);
      const matched = parsed.v1.some((sig) => safeEqual(sig, expected));
      if (!matched) {
        return {
          ok: false,
          provider: STRIPE_PROVIDER,
          signatureOk: false,
          reason: '签名不匹配（内容被篡改，或 webhookSecret 不对）',
        };
      }

      let event = null;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return { ok: false, provider: STRIPE_PROVIDER, signatureOk: true, reason: '签名通过，但 body 不是合法 JSON' };
      }
      const type = String(event?.type || '');
      const obj = event?.data?.object || {};
      const orderId = obj?.client_reference_id || obj?.metadata?.orderId || null;
      const paidAmount = Number.isInteger(obj?.amount_total)
        ? obj.amount_total
        : Number.isInteger(obj?.amount_received)
          ? obj.amount_received
          : Number.isInteger(obj?.amount)
            ? obj.amount
            : null;
      return {
        ok: true,
        provider: STRIPE_PROVIDER,
        signatureOk: true,
        event: { id: String(event?.id || ''), type },
        orderId: orderId == null ? null : String(orderId),
        paidAmount,
        paid: isPaidEvent(type, obj),
        raw: event,
      };
    },

    /**
     * 退款。Stripe 的退款接口按 payment_intent / charge 退，不认我们自己的 orderId，
     * 所以必须由调用方带上 paymentIntentId（或 chargeId）——这是规范限制，不是没实现。
     */
    async refund(args = {}) {
      if (!configured) return unconfiguredResult('设置 billing.stripe.secretKey（sk_test_… 或 sk_live_…）');
      const amount = assertMinor(args.amount, 'amount');
      const paymentIntentId = String(args.paymentIntentId || '').trim();
      const chargeId = String(args.chargeId || '').trim();
      if (!paymentIntentId && !chargeId) {
        return {
          ok: false,
          provider: STRIPE_PROVIDER,
          reason: '缺少 paymentIntentId',
          hint: 'Stripe 按 payment_intent / charge 退款；orderId 是我们这边的单号，不能代替',
        };
      }
      const stripeReason = ['duplicate', 'fraudulent', 'requested_by_customer'].includes(args.reason)
        ? args.reason
        : 'requested_by_customer';

      const form = new URLSearchParams();
      if (paymentIntentId) form.set('payment_intent', paymentIntentId);
      else form.set('charge', chargeId);
      form.set('amount', String(amount));
      form.set('reason', stripeReason);
      if (args.orderId) form.set('metadata[orderId]', String(args.orderId));
      if (args.reason && !['duplicate', 'fraudulent', 'requested_by_customer'].includes(args.reason)) {
        form.set('metadata[reason]', String(args.reason).slice(0, 200));
      }

      const res = await httpCall(fetchImpl, `${apiBase}/v1/refunds`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          ...(args.orderId ? { 'idempotency-key': `refund:${args.orderId}:${amount}` } : {}),
        },
        body: form.toString(),
      });
      if (!res.ok) return { ok: false, reason: res.reason, detail: res.detail, provider: STRIPE_PROVIDER };
      if (res.status < 200 || res.status >= 300) {
        const message = providerMessage(res.json, res.text?.slice(0, 200) || '');
        return {
          ok: false,
          provider: STRIPE_PROVIDER,
          reason: `Stripe 退款被拒（HTTP ${res.status}）：${message || '没有返回错误说明'}`,
          httpStatus: res.status,
        };
      }
      const refund = res.json || {};
      if (!refund.id) return { ok: false, provider: STRIPE_PROVIDER, reason: 'Stripe 返回里没有退款单号（id）', raw: refund };
      return { ok: true, provider: STRIPE_PROVIDER, refundId: String(refund.id), status: String(refund.status || ''), raw: refund };
    },
  };
}
