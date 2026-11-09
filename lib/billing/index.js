/**
 * lib/billing/index.js —— 支付抽象层入口（可插拔适配器 + 幂等账本）
 *
 * 设计目标：**同一套调用，接哪家都长一样；没接就诚实说没接。**
 *
 *   const billing = createBilling({ provider: 'stripe', stripe: { secretKey, webhookSecret } });
 *   await billing.createCheckout({ orderId, amount: 1999, currency: 'cny', subject, successUrl, cancelUrl });
 *   billing.verifyWebhook({ headers, rawBody });   // → { ok, paid, orderId, paidAmount, duplicate }
 *   await billing.refund({ orderId, amount: 1999, paymentIntentId: 'pi_…' });
 *   billing.health();                              // → { ok, provider, configured, reason, hint }
 *
 * 三条硬规则（这个文件负责兜住）：
 * 1. **不许伪造成功**：provider 没配 / 不认识的 provider / 渠道缺关键参数，一律结构化失败，
 *    绝不返回 ok:true 让上层以为钱到了。
 * 2. **webhook 只处理一次**：验签通过后用 event.id 在落盘账本里认领，重复投递返回 duplicate:true，
 *    onPaid 回调只在第一次、且事件确实是"付款成功"时触发。
 * 3. **密钥不出内存**：适配器只管用，不写日志、不进返回值；账本只落去重必需的最小字段。
 *
 * 渠道实现分别在 ./stripe.js ./wechat.js ./alipay.js ./manual.js；
 * 各自的"写不出来的部分"（缺参数、查单未实现等）都在对应文件里明确报错，不在这里假装。
 */

import { createStripeAdapter } from './stripe.js';
import { createWechatAdapter } from './wechat.js';
import { createAlipayAdapter } from './alipay.js';
import { createManualAdapter } from './manual.js';
import { createEventStore } from './idempotency.js';
import { sha256Hex } from './sign.js';
import { DEFAULT_HINT, UNCONFIGURED } from './shared.js';

export { createStripeAdapter } from './stripe.js';
export { createWechatAdapter } from './wechat.js';
export { createAlipayAdapter } from './alipay.js';
export { createManualAdapter } from './manual.js';
export { createEventStore, eventsFile, billingRoot } from './idempotency.js';
export { assertMinor, isMinor, minorToYuan, yuanToMinor } from './amount.js';
export { UNCONFIGURED, DEFAULT_HINT } from './shared.js';

/** 已实现的渠道。加渠道 = 在这里加一行 + 一个文件，别的地方不用动。 */
const ADAPTER_FACTORIES = {
  stripe: createStripeAdapter,
  wechat: createWechatAdapter,
  alipay: createAlipayAdapter,
  manual: createManualAdapter,
};

export const BILLING_PROVIDERS = Object.freeze(Object.keys(ADAPTER_FACTORIES));

/** 没配 provider 时的空适配器：四个方法全部如实失败。 */
function createUnconfiguredAdapter(provider = null, hint = DEFAULT_HINT) {
  const fail = () => ({ ok: false, provider, reason: UNCONFIGURED, hint });
  return {
    provider,
    health: () => ({ ok: false, provider, configured: false, reason: UNCONFIGURED, hint }),
    createCheckout: fail,
    verifyWebhook: () => ({ ...fail(), signatureOk: false }),
    refund: fail,
  };
}

/** 写了 provider 但我们没实现（比如 paypal）：同样如实失败，并报出可选值。 */
function createUnsupportedAdapter(provider) {
  const hint = `目前支持：${BILLING_PROVIDERS.join(' / ')}；要接新渠道请在 lib/billing/ 下加适配器`;
  const fail = () => ({ ok: false, provider, reason: '不支持的 provider', hint });
  return {
    provider,
    health: () => ({ ok: false, provider, configured: false, reason: '不支持的 provider', hint }),
    createCheckout: fail,
    verifyWebhook: () => ({ ...fail(), signatureOk: false }),
    refund: fail,
  };
}

/**
 * @param {object} [config]
 * @param {'stripe'|'wechat'|'alipay'|'manual'|null} [config.provider]
 * @param {string} [config.root] 状态根目录（默认 $DSH_HOME，再退 ~/.dsh）；幂等账本在 <root>/billing/events.json
 * @param {string} [config.eventsFile] 直接指定账本文件（迁移/测试用）
 * @param {(event: object) => any} [config.onPaid] 首次确认收款成功时回调（每个事件最多一次）
 * @param {object} [config.stripe|config.wechat|config.alipay|config.manual] 各渠道自己的配置
 * @param {object} [deps] { fetchImpl, now } —— 测试注入用；生产不传
 */
export function createBilling(config = {}, deps = {}) {
  const rawProvider = config.provider;
  const provider = rawProvider == null || String(rawProvider).trim() === ''
    ? null
    : String(rawProvider).trim().toLowerCase();

  let adapter;
  if (!provider) adapter = createUnconfiguredAdapter(null, DEFAULT_HINT);
  else if (!ADAPTER_FACTORIES[provider]) adapter = createUnsupportedAdapter(provider);
  else adapter = ADAPTER_FACTORIES[provider](config[provider] || {}, deps);

  const store = createEventStore({ root: config.root, file: config.eventsFile, now: deps.now });
  const onPaid = typeof config.onPaid === 'function' ? config.onPaid : null;

  /** 适配器内部对非法入参是抛 TypeError 的；对外层 API 统一转成结构化失败，不炸调用方。 */
  async function guarded(fn, args, fallbackProvider) {
    try {
      return await fn(args);
    } catch (err) {
      return {
        ok: false,
        provider: fallbackProvider,
        reason: String((err && err.message) || err),
        ...(err instanceof TypeError ? { invalidInput: true } : {}),
      };
    }
  }

  return {
    provider,
    /** 幂等账本（暴露出来是为了让上层能查、能对账、能测试）。 */
    events: store,
    eventsFile: store.file,

    /** 配置/连通状态。ok 只代表"这个渠道配好了"，不代表收到过钱。 */
    health() {
      const base = adapter.health();
      return { ...base, events: store.size };
    },

    /** 发起支付（返回链接或二维码 code）。成功 ≠ 已付款。 */
    createCheckout(args = {}) {
      return guarded(adapter.createCheckout.bind(adapter), args, provider);
    },

    /**
     * 校验回调并做幂等。返回值在渠道原始结果上补：
     * - eventId：去重键（平台事件 id；没有就用 body 的 sha256）
     * - duplicate：true = 这个事件之前已经处理过，**不要重复发货**
     * - onPaidError / onPaidResult：回调的返回/异常（异常不会让 ok 变成 false，因为收款是真的）
     */
    async verifyWebhook(args = {}) {
      let result;
      try {
        result = await adapter.verifyWebhook(args);
      } catch (err) {
        return {
          ok: false,
          provider,
          signatureOk: false,
          reason: `处理回调时出错：${String((err && err.message) || err)}`,
        };
      }
      if (!result || result.ok !== true || result.signatureOk !== true) return result;

      const eventId = result.event?.id || (args.rawBody ? `sha256:${sha256Hex(args.rawBody)}` : '');
      if (!eventId) return { ...result, duplicate: false, eventId: null };

      const claim = store.claim(eventId, {
        type: result.event?.type,
        orderId: result.orderId,
        amount: result.paidAmount,
      });
      if (!claim.ok) return { ...result, ...claim, eventId };
      if (claim.duplicate) {
        return { ...result, duplicate: true, eventId, idempotency: 'duplicate', firstSeenAt: claim.entry.at };
      }

      let onPaidResult = null;
      let onPaidError = null;
      if (result.paid === true && onPaid) {
        try {
          onPaidResult = await onPaid({ ...result, eventId });
        } catch (err) {
          // 钱是真的到账了，回调抛错不能把 ok 改成 false；错误单独带出去让人补处理
          onPaidError = String((err && err.message) || err);
        }
      }
      return {
        ...result,
        duplicate: false,
        eventId,
        idempotency: 'first',
        ...(onPaidResult === undefined ? {} : { onPaidResult }),
        ...(onPaidError ? { onPaidError } : {}),
      };
    },

    /** 退款。缺渠道必需信息（如 Stripe 的 paymentIntentId）时明确报缺什么，不静默假装退了。 */
    refund(args = {}) {
      return guarded(adapter.refund.bind(adapter), args, provider);
    },
  };
}

export default createBilling;
