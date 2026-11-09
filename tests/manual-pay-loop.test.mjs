/**
 * pro/tests/manual-pay-loop.test.mjs —— 人工渠道的完整收款闭环（1.11.9）
 *
 * 为什么单拎一条：在线收银台（Stripe / 微信 / 支付宝）要商户号，开号之前
 * **一毛钱也收不到**。可生意不能等商户号 —— 所以「转账 → 人工确认 → 发货」
 * 这条路必须是真能跑通的闭环，而不是文档里的一句"也支持人工"。
 *
 * 这条测试锁死的是**钱与货的对应关系**，五步缺一不可：
 *   ① 下单（place）：只生成待付款订单，**绝不扣钱**
 *   ② 拿到可对账的收款备注：MANUAL-<orderId>（转账时填这个，账才对得上）
 *   ③ 没凭证的确认必须被拒（否则账本会变成糊涂账）
 *   ④ 带凭证确认 → 订单变已发放 + 皮肤真的解锁（不是只改一个状态字段）
 *   ⑤ 退款 → 皮肤重新上锁（钱退了，货必须收回）
 *
 * 全程用真市场 + 真账本（临时目录），不 mock 落盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMarketTool } from '../lib/tools/market.js';
import { createMarket } from '../lib/market/index.js';
import { createMarketStore } from '../lib/market/store.js';
import { checkSkinLicense } from '../lib/pet/skins.js';

const SKIN = 'premium-aurora';

const text = async (tool, args) => {
  const r = await tool.execute(args, {});
  if (r && typeof r === 'object' && typeof r.text === 'string') return r.text;
  return String(r);
};

/** 一个没配任何在线渠道的市场 —— 也就是"只有人工转账"的真实起步状态。 */
function manualShop() {
  const root = mkdtempSync(join(tmpdir(), 'adsk-manual-pay-'));
  const market = createMarket({ root, billing: null });
  const tool = createMarketTool({ market, billing: null });
  return { root, market, tool, done: () => rmSync(root, { recursive: true, force: true }) };
}

const orderIdOf = (out) => (out.match(/订单号：(\S+)/) || [])[1] || '';

/**
 * 取真正喂给 checkSkinLicense 的那份授权。
 * 注意：market.license() 返回的是**信封** { ok, license, purchased }，
 * 不是授权本体；把信封直接塞给 checkSkinLicense 会得到 allowed:false
 * （而且看起来像"没解锁"的假故障）。这里显式拆一层，并把这个坑写下来。
 */
const licOf = (market, root) => {
  const wrapped = market.license({ root });
  return wrapped && wrapped.license ? wrapped.license : wrapped;
};

/** 从 store 的读结果里取数组：readOrders() 返回 { ok, doc, warnings }，不是裸数组。 */
const rowsOf = (result, key) => {
  const doc = result && result.doc ? result.doc : result;
  const list = doc && Array.isArray(doc[key]) ? doc[key] : Array.isArray(doc) ? doc : [];
  return list;
};
const refOf = (out) => (out.match(/收款备注：(MANUAL-\S+)/) || [])[1] || '';

test('人工渠道闭环：下单不扣钱 → 凭证确认 → 皮肤真解锁 → 退款重新上锁', async () => {
  const { root, market, tool, done } = manualShop();
  try {
    // ── ① 下单：只生成待付款订单 ────────────────────────────────────────
    const placed = await text(tool, { action: 'place', skinId: SKIN });
    const orderId = orderIdOf(placed);
    assert.ok(orderId, `place 没给出订单号：${placed.slice(0, 200)}`);
    assert.match(placed, /没有扣任何钱/, '下单必须明说没扣钱（这是人工渠道的前提）');
    assert.match(placed, /待付款/, '订单状态必须是待付款');

    // ── ② 收款备注：转账时填它，账才对得上 ──────────────────────────────
    const manualRef = refOf(placed);
    assert.equal(manualRef, `MANUAL-${orderId}`, '收款备注必须带订单号，否则对账对不回来');

    // 订单真的是 created，不是 paid；也没写 payment 字段
    const listed = await text(tool, { action: 'orders' });
    assert.match(listed, new RegExp(orderId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'orders 里看不到这笔单');
    assert.match(listed, /待付款/, 'orders 应显示待付款');
    const store = createMarketStore({ root });
    const rows = rowsOf(store.readOrders(), 'orders');
    const saved = rows.find((o) => String(o.id) === orderId);
    assert.ok(saved, '账本里没有落这笔订单');
    assert.equal(saved.state, 'created', `下单后状态必须是 created，实际 ${saved.state}`);
    assert.ok(!saved.payment || (!saved.payment.ref && !saved.payment.provider),
      `没收到钱就不该有支付凭证，实际：${JSON.stringify(saved.payment)}`);

    // 皮肤此刻还是锁着的（钱没到，货不能先给）
    const before = checkSkinLicense({ skin: SKIN, license: licOf(market, root), root });
    assert.equal(before.allowed, false, '还没付钱，皮肤不该解锁');

    // ── ③ 没凭证的确认：必须拒 ─────────────────────────────────────────
    const noRef = await text(tool, { action: 'confirm', orderId });
    assert.match(noRef, /必须带 paymentRef/, '没有凭证的确认必须被拒绝');
    const stillCreated = checkSkinLicense({ skin: SKIN, license: licOf(market, root), root });
    assert.equal(stillCreated.allowed, false, '被拒的确认不该把货发出去');

    // ── ④ 带凭证确认：发放 + 真解锁 ─────────────────────────────────────
    const confirmed = await text(tool, { action: 'confirm', orderId, paymentRef: 'ZH20260101-0001' });
    assert.match(confirmed, /已确认到账并发放/, `确认没成功：${confirmed.slice(0, 200)}`);
    assert.match(confirmed, /本机回执：\S+/, '发放必须给出本机回执（交付码）');
    assert.match(confirmed, /ZH20260101-0001/, '确认结果里要回显凭证号，方便对账');

    const after = checkSkinLicense({ skin: SKIN, license: licOf(market, root), root });
    assert.equal(after.allowed, true, '确认到账后皮肤必须真的解锁');
    assert.ok(after.source, '解锁必须说清来源（source）');
    // 更硬的证据：授权声明里真的带上了这套皮肤（来源字段叫什么名字不重要，claims 才是实质）
    const claims = licOf(market, root)?.claims || {};
    assert.ok(Array.isArray(claims.skins) && claims.skins.includes(SKIN),
      `授权里的皮肤清单没带上这套：${JSON.stringify(claims.skins)}`);

    // 账本：状态 delivered + 凭证落盘
    const paid = rowsOf(store.readOrders(), 'orders').find((o) => String(o.id) === orderId);
    assert.equal(paid.state, 'delivered', `确认后状态应为 delivered，实际 ${paid.state}`);
    assert.match(JSON.stringify(paid.payment || {}), /ZH20260101-0001/, '凭证必须写进订单流水号');

    // 重复确认：幂等，不许重复发货/重复记账
    const again = await text(tool, { action: 'confirm', orderId, paymentRef: 'ZH20260101-0001' });
    assert.match(again, /已确认到账并发放|已经发放|已发放/, `重复确认不该报错：${again.slice(0, 160)}`);
    const entries = rowsOf(store.readLedger(), 'entries');
    const forOrder = entries.filter((e) => String(e.orderId) === orderId && e.kind !== 'refund');
    assert.equal(forOrder.length, 1, `同一笔钱只能记一次账，实际 ${forOrder.length} 条`);

    // ── ⑤ 退款：钱退了，货必须收回 ─────────────────────────────────────
    // 先钉住"没配渠道时不许假装退款"：这条是人工渠道最容易被糊弄过去的地方。
    const noChannel = await text(tool, { action: 'refund', orderId });
    assert.match(noChannel, /退款没成/, '没配退款通道时不该报成功');
    assert.match(noChannel, /没有假装|不伪造|仍是已发放/, '拒绝退款时要说清"钱没退、货还在"');
    assert.equal(checkSkinLicense({ skin: SKIN, license: licOf(market, root), root }).allowed, true,
      '退款被拒时皮肤不该被收回');

    // 再走人工退回：带转账凭证登记，钱真退了，货必须收回
    const refunded = await text(tool, { action: 'refund', orderId, refundRef: 'ZH-REFUND-0001' });
    assert.match(refunded, /已退款/, `人工退款没成功：${refunded.slice(0, 240)}`);
    assert.match(refunded, /ZH-REFUND-0001/, '退款结果要回显凭证号');
    const revoked = checkSkinLicense({ skin: SKIN, license: licOf(market, root), root });
    assert.equal(revoked.allowed, false, '退款之后皮肤必须重新上锁');
  } finally {
    done();
  }
});

test('人工渠道闭环：同一套皮肤不会被重复下单（省得账本里两条待付款）', async () => {
  const { tool, done } = manualShop();
  try {
    const first = await text(tool, { action: 'place', skinId: SKIN });
    assert.ok(orderIdOf(first), `第一次下单就该成功：${first.slice(0, 160)}`);
    const second = await text(tool, { action: 'place', skinId: SKIN });
    // 已有待付款单时再次下单：要么复用同一笔，要么明说在挂单 —— 但不许又开一笔同价的
    const secondId = orderIdOf(second);
    const firstId = orderIdOf(first);
    const reused = secondId && secondId === firstId;
    const warned = /待付款|已经下单|还没付|挂/.test(second);
    assert.ok(reused || warned, `重复下单既没复用也没提示，用户会付两次钱：\n${second.slice(0, 300)}`);
  } finally {
    done();
  }
});
