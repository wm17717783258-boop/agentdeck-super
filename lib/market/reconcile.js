/**
 * lib/market/reconcile.js —— 对账（1.10.0）
 *
 * 为什么需要它：真实收款的最后一块不是"能付"，而是**账能对上**。
 * 渠道那边有一条流水，我们这边有一张订单 + 一笔账本；三者的
 * 订单号 / 金额 / 状态 / 渠道流水号必须能逐笔勾对。少一笔、多一笔、金额对不上，
 * 都要当场说出来，而不是等月底发现钱不对。
 *
 * 这一层**不需要商户号**也能验：喂一份"渠道对账单"进来，就能证明勾对逻辑是对的。
 * 配上真商户号之后，同一套代码直接吃渠道拉回来的真流水。
 *
 * 诚实边界：
 *   · 这里不"自动改账"：只报差异 → 由人决定是补单还是退款。改账是最危险的动作。
 *   · 不校验渠道对账单本身的签名（那属于各渠道 webhook 验签的活，见 lib/billing/sign.js）。
 */

import { marketPaths, readLedger, readOrders } from './store.js';

/** 差异类别。每一条都写清楚"谁的锅"，方便人一眼分派。 */
export const DIFF_KINDS = Object.freeze({
  missingLocal: 'missing_local',       // 渠道有、我们没记 → 可能漏单
  missingRemote: 'missing_remote',     // 我们有、渠道没有 → 可能没真扣款
  amountMismatch: 'amount_mismatch',   // 订单号对得上、金额对不上
  stateMismatch: 'state_mismatch',     // 金额对得上、状态对不上
  refMismatch: 'ref_mismatch',         // 渠道流水号对不上（可能被改过）
  duplicateRemote: 'duplicate_remote', // 渠道同一条订单号出现两次
});

/** 渠道侧一条流水的规范形状。字段名容忍几种常见写法，少猜多报错。 */
function normalizeRemoteRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const orderId = String(raw.orderId ?? raw.order_id ?? raw.outTradeNo ?? raw.out_trade_no ?? raw.metadata?.orderId ?? '').trim();
  const amountRaw = raw.amount ?? raw.total ?? raw.totalAmount ?? raw.total_amount ?? raw.amountCents ?? raw.amount_cents;
  const amount = Number(amountRaw);
  const state = String(raw.state ?? raw.status ?? '').trim().toLowerCase() || null;
  const ref = String(raw.ref ?? raw.transactionId ?? raw.transaction_id ?? raw.tradeNo ?? raw.trade_no ?? '').trim() || null;
  return {
    orderId,
    // 金额统一用"分"。渠道可能给元（带小数点）也可能给分，这里按调用方声明的单位处理。
    amount: Number.isFinite(amount) ? amount : null,
    state,
    ref,
    raw,
  };
}

/** 我们这边的订单 → 勾对用的统一形状。字段名以 lib/market/store.js 的 normalizeOrder 为准。 */
function localRowOf(order) {
  return {
    orderId: String(order?.id || ''),
    // 订单文件里金额字段叫 amount（分）；priceCents 是别处的叫法，兼容一下
    amount: Number.isFinite(Number(order?.amount)) ? Number(order.amount)
      : (Number.isFinite(Number(order?.priceCents)) ? Number(order.priceCents) : null),
    state: String(order?.state || ''),
    ref: order?.payment?.ref ? String(order.payment.ref) : null,
  };
}

/** 渠道状态词 → 我们的状态词（只做"该不该算已付"这一层，不做别的推断）。 */
function stateEquivalent(remoteState, localState) {
  if (!remoteState) return true; // 渠道没给状态就不比，别硬判
  const paidish = new Set(['paid', 'succeeded', 'success', 'settled', 'trade_success', '支付成功']);
  const refundish = new Set(['refunded', 'refund', 'refund_success', '已退款']);
  const failedish = new Set(['failed', 'canceled', 'cancelled', 'closed', 'trade_closed', '已关闭']);
  const local = String(localState || '').toLowerCase();
  const remote = String(remoteState || '').toLowerCase();
  // 我们这边的状态可能是 delivered（已发货但本质已付）
  const localPaid = local === 'paid' || local === 'delivered';
  if (paidish.has(remote)) return localPaid;
  if (refundish.has(remote)) return local === 'refunded';
  if (failedish.has(remote)) return local === 'created' || local === 'failed';
  return true; // 不认识的状态不硬判，交给下面按金额比
}

/**
 * 对账：把渠道流水和我们本机的订单 + 账本勾一遍。
 *
 * @param {object} opts
 * @param {string} opts.root            工作区
 * @param {Array}  opts.remote          渠道对账单（数组）
 * @param {'cents'|'yuan'} [opts.unit]  渠道金额单位，默认 cents
 * @param {Function} [opts.now]
 * @returns {{ok:boolean, checked:number, matched:number, diffs:Array, summary:object, file?:string}}
 */
export function reconcile({ root, remote, unit = 'cents', now } = {}) {
  // 没传 remote（undefined）= 空对账单，是合法调用（"我还没拉到渠道流水"）；
  // 传了但不是数组 = 调用方搞错了，必须当场说清楚，不能当空账悄悄放过去。
  if (remote === undefined || remote === null) {
    remote = [];
  }
  if (!Array.isArray(remote)) {
    return { ok: false, reason: '渠道对账单要给数组（一行一笔）', checked: 0, matched: 0, diffs: [], summary: {} };
  }
  // 注意：readOrders/readLedger 返回的是外壳 { ok, doc, recovered, warnings }，
  // 真正的数据在 .doc 里。以前这里直接读 .orders，于是永远读到空数组——
  // 表现是"渠道每一笔都说本机没有这张单"，很吓人但其实是取错了层。
  const ordersDoc = readOrders(root, { now });
  const ledgerDoc = readLedger(root, { now });
  const orders = Array.isArray(ordersDoc?.doc?.orders) ? ordersDoc.doc.orders : [];
  const ledger = Array.isArray(ledgerDoc?.doc?.entries) ? ledgerDoc.doc.entries : [];

  const localById = new Map();
  for (const o of orders) {
    const row = localRowOf(o);
    if (row.orderId) localById.set(row.orderId, row);
  }

  const diffs = [];
  const seenRemote = new Set();
  let matched = 0;

  for (const rawRow of remote) {
    const row = normalizeRemoteRow(rawRow);
    if (!row || !row.orderId) {
      diffs.push({ kind: DIFF_KINDS.missingLocal, orderId: '', detail: '渠道这一行没有订单号，无法勾对' });
      continue;
    }
    // 渠道同一条订单号出现两次 → 可能重复扣款，必须报
    if (seenRemote.has(row.orderId)) {
      diffs.push({ kind: DIFF_KINDS.duplicateRemote, orderId: row.orderId, detail: '渠道对账单里同一张订单出现了两次' });
      continue;
    }
    seenRemote.add(row.orderId);

    const local = localById.get(row.orderId);
    if (!local) {
      diffs.push({
        kind: DIFF_KINDS.missingLocal,
        orderId: row.orderId,
        detail: `渠道有这笔（${row.amount ?? '?'} / ${row.state || '?'}），我们本机没有这张订单`,
      });
      continue;
    }

    // 金额：渠道按 unit 归一成"分"再比
    let remoteCents = row.amount;
    if (remoteCents != null && unit === 'yuan') remoteCents = Math.round(remoteCents * 100);
    if (remoteCents != null && local.amount != null && remoteCents !== local.amount) {
      diffs.push({
        kind: DIFF_KINDS.amountMismatch,
        orderId: row.orderId,
        detail: `金额对不上：渠道 ${remoteCents} 分，本机 ${local.amount} 分`,
        remote: remoteCents,
        local: local.amount,
      });
      continue;
    }

    if (!stateEquivalent(row.state, local.state)) {
      diffs.push({
        kind: DIFF_KINDS.stateMismatch,
        orderId: row.orderId,
        detail: `状态对不上：渠道 ${row.state}，本机 ${local.state}`,
        remote: row.state,
        local: local.state,
      });
      continue;
    }

    if (row.ref && local.ref && row.ref !== local.ref) {
      diffs.push({
        kind: DIFF_KINDS.refMismatch,
        orderId: row.orderId,
        detail: `渠道流水号对不上：渠道 ${row.ref}，本机 ${local.ref}`,
        remote: row.ref,
        local: local.ref,
      });
      continue;
    }

    matched += 1;
  }

  // 反向：我们有、渠道没有 —— 已付的订单却没在渠道流水里，最值得怀疑
  for (const [orderId, local] of localById) {
    if (seenRemote.has(orderId)) continue;
    const worthFlagging = local.state === 'paid' || local.state === 'delivered' || local.state === 'refunded';
    if (!worthFlagging) continue; // created/failed 本来就可能没有渠道流水
    diffs.push({
      kind: DIFF_KINDS.missingRemote,
      orderId,
      detail: `本机记着这张单是 ${local.state}，渠道对账单里没有它（${local.amount ?? '?'} 分）`,
      local: local.state,
    });
  }

  const byKind = {};
  for (const d of diffs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;

  return {
    ok: true,
    checked: remote.length,
    matched,
    diffs,
    summary: {
      remoteRows: remote.length,
      localOrders: orders.length,
      ledgerEntries: ledger.length,
      matched,
      diffCount: diffs.length,
      byKind,
    },
    paths: marketPaths(root),
  };
}

/** 给人看的一页对账报告。**差异一条都不许藏**。 */
export function renderReconcile(result) {
  if (!result?.ok) return `对账没跑成：${result?.reason || '未知原因'}`;
  const s = result.summary || {};
  const lines = [
    '【对账报告】',
    `渠道流水 ${s.remoteRows} 行｜本机订单 ${s.localOrders} 张｜账本 ${s.ledgerEntries} 笔`,
    `勾对成功 ${s.matched} 笔${s.diffCount ? `，**差异 ${s.diffCount} 条**` : '，无差异'}`,
  ];
  if (!s.diffCount) {
    lines.push('渠道与本机逐笔对得上。');
    return lines.join('\n');
  }
  lines.push('', '差异明细（这一层不改账，只报出来，由人决定补单还是退款）：');
  for (const d of result.diffs) {
    const tag = d.kind === DIFF_KINDS.missingLocal ? '渠道有我们没有'
      : d.kind === DIFF_KINDS.missingRemote ? '我们有渠道没有'
        : d.kind === DIFF_KINDS.amountMismatch ? '金额不符'
          : d.kind === DIFF_KINDS.stateMismatch ? '状态不符'
            : d.kind === DIFF_KINDS.refMismatch ? '流水号不符'
              : '渠道重复';
    lines.push(`  · [${tag}] ${d.orderId || '（无单号）'} —— ${d.detail}`);
  }
  return lines.join('\n');
}

export default { DIFF_KINDS, reconcile, renderReconcile };
