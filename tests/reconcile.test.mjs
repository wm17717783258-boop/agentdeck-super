/**
 * 1.10.0 对账（lib/market/reconcile.js）：渠道流水 ↔ 本机订单 ↔ 账本，逐笔勾对。
 *
 * 为什么值得单写一套：真实收款的最后一块不是"能付"，而是**账能对上**。
 * 少一笔、多一笔、金额/状态/流水号对不上，都要当场说出来，不能等月底发现钱不对。
 *
 * 这一层不需要商户号也能验：喂一份"渠道对账单"进来，就证明勾对逻辑是对的；
 * 配上真商户号之后，同一套代码直接吃渠道拉回来的真流水。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DIFF_KINDS, reconcile, renderReconcile } from '../lib/market/reconcile.js';
import { ordersPath, writeOrders } from '../lib/market/store.js';

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-recon-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * 造几条本机订单（直接写盘，不跑支付流程——这一层测的是勾对，不是收款）。
 * 字段名跟着 lib/market/store.js 的 normalizeOrder 走：金额字段是 `amount`（分），
 * 渠道流水号在 `payment.ref`，皮肤 id 必填（否则这张单会被归一化时丢掉）。
 */
function seedOrders(root, orders) {
  const saved = writeOrders(root, { version: 1, orders });
  assert.ok(saved.ok, `订单写盘失败：${saved.error}`);
}

const localOrder = (id, amountCents, state, ref = null) => ({
  id,
  skinId: 'premium-aurora',
  amount: amountCents,
  state,
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
  ...(ref ? { payment: { ref, provider: 'localpay', paidAt: '2026-11-06T00:01:00.000Z' } } : {}),
});

/* ── 1. 全对上：一笔差异都不许报 ───────────────────────────────────────── */

test('渠道与本机逐笔对得上时：零差异，勾对数等于渠道行数', () => {
  const { root, done } = freshRoot('clean');
  try {
    seedOrders(root, [
      localOrder('ord_0001', 1800, 'delivered', 'PAY-1'),
      localOrder('ord_0002', 1800, 'paid', 'PAY-2'),
      localOrder('ord_0003', 1800, 'created'),
    ]);
    const r = reconcile({
      root,
      remote: [
        { orderId: 'ord_0001', amount: 1800, state: 'paid', ref: 'PAY-1' },
        { orderId: 'ord_0002', amount: 1800, state: 'succeeded', ref: 'PAY-2' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.matched, 2);
    assert.equal(r.diffs.length, 0, `不该有差异：${JSON.stringify(r.diffs)}`);
    assert.equal(r.summary.localOrders, 3);
    assert.equal(r.summary.diffCount, 0);
    // created 的单没有渠道流水是正常的，不该被当成"缺失"
    assert.ok(!r.diffs.some((d) => d.orderId === 'ord_0003'), 'created 的单不该被报缺失');
    assert.match(renderReconcile(r), /无差异/);
  } finally {
    done();
  }
});

/* ── 2. 渠道有、我们没有 → 可能漏单 ────────────────────────────────────── */

test('渠道有这笔、本机没这张订单：报 missing_local（可能漏单）', () => {
  const { root, done } = freshRoot('missing-local');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [
        { orderId: 'ord_0001', amount: 1800, state: 'paid', ref: 'PAY-1' },
        { orderId: 'ord_ghost1', amount: 2900, state: 'paid', ref: 'PAY-9' },
      ],
    });
    assert.equal(r.matched, 1);
    assert.equal(r.diffs.length, 1);
    assert.equal(r.diffs[0].kind, DIFF_KINDS.missingLocal);
    assert.equal(r.diffs[0].orderId, 'ord_ghost1');
    assert.match(r.diffs[0].detail, /本机没有这张订单/);
    assert.match(renderReconcile(r), /渠道有我们没有/);
  } finally {
    done();
  }
});

/* ── 3. 我们有、渠道没有 → 可能没真扣款 ───────────────────────────────── */

test('本机记着已付、渠道对账单里没有：报 missing_remote（可能没真扣款）', () => {
  const { root, done } = freshRoot('missing-remote');
  try {
    seedOrders(root, [
      localOrder('ord_paid01', 1800, 'paid', 'PAY-1'),
      localOrder('ord_creat1', 1800, 'created'),
    ]);
    const r = reconcile({ root, remote: [] });
    assert.equal(r.diffs.length, 1, '只有已付那张该被报出来');
    assert.equal(r.diffs[0].kind, DIFF_KINDS.missingRemote);
    assert.equal(r.diffs[0].orderId, 'ord_paid01');
    assert.match(renderReconcile(r), /我们有渠道没有/);
  } finally {
    done();
  }
});

/* ── 4. 金额对不上 ─────────────────────────────────────────────────────── */

test('订单号对得上但金额对不上：报 amount_mismatch，并把两边数字都列出来', () => {
  const { root, done } = freshRoot('amount');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [{ orderId: 'ord_0001', amount: 1500, state: 'paid', ref: 'PAY-1' }],
    });
    assert.equal(r.matched, 0);
    assert.equal(r.diffs[0].kind, DIFF_KINDS.amountMismatch);
    assert.equal(r.diffs[0].remote, 1500);
    assert.equal(r.diffs[0].local, 1800);
    assert.match(r.diffs[0].detail, /1500 分/);
    assert.match(r.diffs[0].detail, /1800 分/);
    assert.match(renderReconcile(r), /金额不符/);
  } finally {
    done();
  }
});

test('渠道按「元」给金额时也能对上（unit:"yuan"，内部归一成分）', () => {
  const { root, done } = freshRoot('yuan');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const ok = reconcile({
      root, unit: 'yuan',
      remote: [{ orderId: 'ord_0001', amount: 18, state: 'paid', ref: 'PAY-1' }],
    });
    assert.equal(ok.matched, 1, `按元给也该对得上：${JSON.stringify(ok.diffs)}`);

    // 元模式下 18.5 → 1850 分，跟本机 1800 对不上，要报
    const bad = reconcile({
      root, unit: 'yuan',
      remote: [{ orderId: 'ord_0001', amount: 18.5, state: 'paid', ref: 'PAY-1' }],
    });
    assert.equal(bad.diffs[0].kind, DIFF_KINDS.amountMismatch);
    assert.equal(bad.diffs[0].remote, 1850);
  } finally {
    done();
  }
});

/* ── 5. 状态对不上 ─────────────────────────────────────────────────────── */

test('金额对得上但状态对不上：报 state_mismatch（渠道说成功、本机还停在待支付）', () => {
  const { root, done } = freshRoot('state');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'created')]);
    const r = reconcile({
      root,
      remote: [{ orderId: 'ord_0001', amount: 1800, state: 'paid', ref: null }],
    });
    assert.equal(r.diffs[0].kind, DIFF_KINDS.stateMismatch);
    assert.match(r.diffs[0].detail, /渠道 paid/);
    assert.match(r.diffs[0].detail, /本机 created/);
  } finally {
    done();
  }
});

test('渠道说退款、本机还是已付：报状态不符', () => {
  const { root, done } = freshRoot('refund-state');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'delivered', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [{ orderId: 'ord_0001', amount: 1800, state: 'refunded', ref: 'PAY-1' }],
    });
    assert.equal(r.diffs[0].kind, DIFF_KINDS.stateMismatch);
    assert.match(r.diffs[0].detail, /refunded/);
  } finally {
    done();
  }
});

test('退款状态也对得上时：不算差异', () => {
  const { root, done } = freshRoot('refund-ok');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'refunded', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [{ orderId: 'ord_0001', amount: 1800, state: 'refund_success', ref: 'PAY-1' }],
    });
    assert.equal(r.diffs.length, 0, `退款对齐了不该报差异：${JSON.stringify(r.diffs)}`);
    assert.equal(r.matched, 1);
  } finally {
    done();
  }
});

/* ── 6. 流水号对不上 / 渠道重复 ────────────────────────────────────────── */

test('渠道流水号与本机记的不一样：报 ref_mismatch（可能被改过）', () => {
  const { root, done } = freshRoot('ref');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-ORIGINAL')]);
    const r = reconcile({
      root,
      remote: [{ orderId: 'ord_0001', amount: 1800, state: 'paid', ref: 'PAY-TAMPERED' }],
    });
    assert.equal(r.diffs[0].kind, DIFF_KINDS.refMismatch);
    assert.match(r.diffs[0].detail, /PAY-TAMPERED/);
  } finally {
    done();
  }
});

test('渠道对账单里同一张订单出现两次：报 duplicate_remote（可能重复扣款）', () => {
  const { root, done } = freshRoot('dup');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [
        { orderId: 'ord_0001', amount: 1800, state: 'paid', ref: 'PAY-1' },
        { orderId: 'ord_0001', amount: 1800, state: 'paid', ref: 'PAY-1' },
      ],
    });
    assert.equal(r.matched, 1, '第一笔算对上');
    assert.equal(r.diffs[0].kind, DIFF_KINDS.duplicateRemote);
    assert.match(renderReconcile(r), /渠道重复/);
  } finally {
    done();
  }
});

/* ── 7. 脏输入不许崩、不许漏报 ─────────────────────────────────────────── */

test('渠道对账单不是数组：明确说不行，不崩', () => {
  const { root, done } = freshRoot('badinput');
  try {
    // 传了但不是数组 = 调用方搞错了 → 必须拒
    for (const bad of ['string', 42, { rows: [] }, true]) {
      const r = reconcile({ root, remote: bad });
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 该被拒`);
      assert.match(r.reason, /数组/);
    }
    // 没传 / 显式 null = "还没拉到渠道流水"，是合法调用，按空对账单处理
    for (const empty of [undefined, null]) {
      const r = reconcile({ root, remote: empty });
      assert.equal(r.ok, true, `${String(empty)} 该按空对账单处理`);
      assert.equal(r.checked, 0);
    }
    // 空数组当然也合法
    assert.equal(reconcile({ root, remote: [] }).ok, true);
  } finally {
    done();
  }
});

test('渠道行缺订单号：如实报出来，不静默跳过', () => {
  const { root, done } = freshRoot('norow');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [
        { orderId: 'ord_0001', amount: 1800, state: 'paid', ref: 'PAY-1' },
        { amount: 999, state: 'paid' },
        null,
      ],
    });
    assert.equal(r.matched, 1);
    // 两行脏数据都该被报出来
    assert.equal(r.diffs.filter((d) => d.kind === DIFF_KINDS.missingLocal).length, 2,
      `脏行漏报了：${JSON.stringify(r.diffs)}`);
  } finally {
    done();
  }
});

test('渠道字段名容忍常见写法（out_trade_no / transaction_id / total_amount）', () => {
  const { root, done } = freshRoot('aliases');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [{ out_trade_no: 'ord_0001', total_amount: 1800, status: 'TRADE_SUCCESS', transaction_id: 'PAY-1' }],
    });
    assert.equal(r.matched, 1, `别名没认出来：${JSON.stringify(r.diffs)}`);
    assert.equal(r.diffs.length, 0);
  } finally {
    done();
  }
});

/* ── 8. 报告本身 ───────────────────────────────────────────────────────── */

test('报告把每一条差异都列出来（一条都不许藏），并说明"不改账"', () => {
  const { root, done } = freshRoot('report');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const r = reconcile({
      root,
      remote: [
        { orderId: 'ord_ghost1', amount: 2900, state: 'paid' },
        { orderId: 'ord_0001', amount: 1500, state: 'paid', ref: 'PAY-1' },
      ],
    });
    const text = renderReconcile(r);
    assert.match(text, /差异 2 条|差异 \d+ 条/);
    assert.match(text, /ord_ghost/);
    assert.match(text, /ord_0001/);
    assert.match(text, /不改账|由人决定/);
    // 报告里必须逐个类别都出现
    assert.match(text, /渠道有我们没有/);
    assert.match(text, /金额不符/);
  } finally {
    done();
  }
});

test('对账结论是纯读的：跑完订单文件一个字节都没变', () => {
  const { root, done } = freshRoot('readonly');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const before = readFileSync(ordersPath(root), 'utf8');
    reconcile({ root, remote: [{ orderId: 'ord_0001', amount: 9999, state: 'refunded', ref: 'X' }] });
    const after = readFileSync(ordersPath(root), 'utf8');
    assert.equal(after, before, '对账不该动订单文件');
  } finally {
    done();
  }
});
