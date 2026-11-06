/**
 * lib/billing/manual.js —— 手工记账渠道（线下转账/现金/内部核算）
 *
 * 存在的意义：很多小团队现在就是"微信转账 + 人工开通"，如果抽象层只认在线支付，
 * 这类用户就只能去改代码。manual 渠道把这些动作纳入同一套接口，但**绝不说谎**：
 * - createCheckout 只生成一个人工收款指令（code = MANUAL-<orderId>），不声称已收款；
 * - verifyWebhook 明确说"手工渠道没有 webhook"；
 * - refund 明确说"需要人工退款"。
 * 真正收到钱之后怎么记账，由调用方自己决定（可以调 confirmPaid 之外的业务逻辑）。
 */

import { assertMinor } from './amount.js';

export const MANUAL_PROVIDER = 'manual';

export function createManualAdapter(config = {}) {
  const instructions = String(
    config.instructions || '按约定方式人工收款（转账/现金），确认到账后由记账人标记为已支付',
  );

  return {
    provider: MANUAL_PROVIDER,

    health() {
      return {
        ok: true,
        provider: MANUAL_PROVIDER,
        configured: true,
        reason: '',
        hint: '',
        mode: 'offline',
        note: 'manual 渠道不会产生任何在线支付请求，也不会自动确认收款',
      };
    },

    createCheckout(args = {}) {
      const orderId = String(args.orderId || '').trim();
      if (!orderId) return { ok: false, provider: MANUAL_PROVIDER, reason: '缺少 orderId' };
      const amount = assertMinor(args.amount, 'amount');
      return {
        ok: true,
        provider: MANUAL_PROVIDER,
        url: null,
        code: `MANUAL-${orderId}`,
        raw: {
          instructions,
          amount,
          currency: String(args.currency || 'CNY'),
          note: '这是人工收款指令，不是支付链接；收到钱之前请勿发货/开通',
        },
      };
    },

    verifyWebhook() {
      return {
        ok: false,
        provider: MANUAL_PROVIDER,
        signatureOk: false,
        reason: 'manual 渠道没有 webhook',
        hint: '人工确认到账后请自行记账（这条渠道不会自动产生支付事件）',
      };
    },

    refund() {
      return {
        ok: false,
        provider: MANUAL_PROVIDER,
        reason: 'manual 渠道的退款需要人工处理',
        hint: '按原收款路径线下退回，再自行冲账',
      };
    },
  };
}
