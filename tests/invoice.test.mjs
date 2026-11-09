/**
 * 1.10.0 发票数据（lib/market/invoice.js）：把已付订单变成一票可查可导出的发票记录。
 *
 * 蓝图第 312 行把「发票、税费」列进真实支付门槛。这一层做的是**票面数据**：
 * 编号、抬头、税号、金额拆分、税额、行项目 —— 渠道或税务平台要什么字段，我们这边先备齐。
 *
 * 这套测试同时也把**边界**钉住：税率没配就说没配，绝不自己编一个 6% 冒充"已含税"；
 * 没付款的订单不许开票；同一张单不重复开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  INVOICE_FILE,
  TAX_RATES,
  TITLE_TYPES,
  exportInvoices,
  invoiceNoOf,
  issueInvoice,
  listInvoices,
  renderInvoice,
  splitTax,
} from '../lib/market/invoice.js';
import { marketDir, writeOrders } from '../lib/market/store.js';

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-inv-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

const localOrder = (id, amount, state, ref = null) => ({
  id,
  skinId: 'premium-aurora',
  skinName: '极光',
  amount,
  state,
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
  ...(ref ? { payment: { ref, provider: 'localpay', paidAt: '2026-11-06T00:01:00.000Z' } } : {}),
});

function seedOrders(root, orders) {
  const saved = writeOrders(root, { version: 1, orders });
  assert.ok(saved.ok, `订单写盘失败：${saved.error}`);
}

const invoicesPath = (root) => join(marketDir(root), INVOICE_FILE);

/* ── 1. 税率拆分 ───────────────────────────────────────────────────────── */

test('含税金额按税率反算：不含税 + 税额 = 含税，且全用整数分算（不出现浮点毛刺）', () => {
  // 未配税率：不拆，且明确标注没配
  const zero = splitTax(1800, 0);
  assert.equal(zero.grossCents, 1800);
  assert.equal(zero.netCents, 1800);
  assert.equal(zero.taxCents, 0);
  assert.equal(zero.rateConfigured, false, '没配税率必须是 false，不许假装配了');

  // 6%：1800 / 1.06 = 1698.11 → 四舍五入 1698，税 102
  const six = splitTax(1800, 0.06);
  assert.equal(six.grossCents, 1800);
  assert.equal(six.netCents, 1698);
  assert.equal(six.taxCents, 102);
  assert.equal(six.netCents + six.taxCents, six.grossCents, '不含税 + 税必须等于含税');
  assert.equal(six.rateConfigured, true);

  // 13%：1800 / 1.13 = 1592.92 → 1593，税 207
  const thirteen = splitTax(1800, 0.13);
  assert.equal(thirteen.netCents + thirteen.taxCents, 1800);
  assert.equal(thirteen.netCents, 1593);

  // 各种面额都不许出现"加起来差一分"
  for (const gross of [1, 7, 99, 100, 1800, 99_99, 30000_00]) {
    for (const rate of TAX_RATES) {
      const s = splitTax(gross, rate);
      assert.equal(s.netCents + s.taxCents, s.grossCents, `${gross} 分 @ ${rate} 加起来不对`);
      assert.ok(s.netCents >= 0 && s.taxCents >= 0);
    }
  }
});

test('税率乱给（负数/NaN/字符串）一律按"没配"处理，不崩也不算错账', () => {
  for (const bad of [-0.06, NaN, 'abc', null, undefined, {}]) {
    const s = splitTax(1800, bad);
    assert.equal(s.grossCents, 1800);
    assert.equal(s.taxCents, 0);
    assert.equal(s.rateConfigured, false);
  }
});

/* ── 2. 发票号稳定 ─────────────────────────────────────────────────────── */

test('发票号：同一天同一单稳定（重开不换号），不同单不撞号', () => {
  const at = Date.parse('2026-11-06T10:00:00+08:00');
  const a1 = invoiceNoOf('ord_0001', at);
  const a2 = invoiceNoOf('ord_0001', at + 3600_000);
  assert.equal(a1, a2, '同一天同一单必须同号');
  assert.match(a1, /^INV-\d{8}-[A-Z0-9]{1,6}$/);

  const b = invoiceNoOf('ord_0002', at);
  assert.notEqual(a1, b, '不同单不能撞号');

  // 跨天会变（这是有意的：号码里带开票日期）
  const nextDay = invoiceNoOf('ord_0001', at + 24 * 3600_000);
  assert.notEqual(a1, nextDay);
});

/* ── 3. 开票主流程 ─────────────────────────────────────────────────────── */

test('已付订单能开票：票面字段齐全并落盘', () => {
  const { root, done } = freshRoot('issue');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'delivered', 'PAY-1')]);
    const r = issueInvoice({
      root,
      orderId: 'ord_0001',
      title: { type: 'company', name: '某某科技有限公司', taxId: '91310000MA1FL0000X' },
      rate: 0.06,
      now: () => Date.parse('2026-11-06T10:00:00+08:00'),
    });
    assert.equal(r.ok, true, r.reason || '');
    const inv = r.invoice;
    assert.match(inv.no, /^INV-20261106-/);
    assert.equal(inv.orderId, 'ord_0001');
    assert.equal(inv.grossCents, 1800);
    assert.equal(inv.netCents + inv.taxCents, 1800);
    assert.equal(inv.taxRate, 0.06);
    assert.equal(inv.title.type, 'company');
    assert.equal(inv.title.taxId, '91310000MA1FL0000X');
    assert.equal(inv.currency, 'CNY');
    assert.equal(inv.state, 'issued');
    assert.equal(inv.externalRef, 'PAY-1', '渠道流水号要带进票面（对账要用）');
    assert.equal(inv.lines.length, 1);
    assert.equal(inv.lines[0].amountCents, inv.netCents);

    // 真落盘
    const onDisk = JSON.parse(readFileSync(invoicesPath(root), 'utf8'));
    assert.equal(onDisk.invoices.length, 1);
    assert.equal(onDisk.invoices[0].no, inv.no);
  } finally {
    done();
  }
});

test('同一张订单重复开票：返回同一张，不重复开', () => {
  const { root, done } = freshRoot('dup');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const first = issueInvoice({ root, orderId: 'ord_0001', rate: 0.06 });
    const second = issueInvoice({ root, orderId: 'ord_0001', rate: 0.13 });
    assert.equal(second.ok, true);
    assert.equal(second.existed, true, '该认出"已经开过了"');
    assert.equal(second.invoice.id, first.invoice.id);
    assert.equal(second.invoice.taxRate, 0.06, '不该被第二次的税率改写');
    const onDisk = JSON.parse(readFileSync(invoicesPath(root), 'utf8'));
    assert.equal(onDisk.invoices.length, 1, '盘上只该有一张');
  } finally {
    done();
  }
});

/* ── 4. 不许凭空开票 ───────────────────────────────────────────────────── */

test('没付款的订单不许开票（created / refunded 都拒）', () => {
  const { root, done } = freshRoot('unpaid');
  try {
    seedOrders(root, [
      localOrder('ord_0001', 1800, 'created'),
      localOrder('ord_0002', 1800, 'refunded', 'PAY-2'),
    ]);
    for (const id of ['ord_0001', 'ord_0002']) {
      const r = issueInvoice({ root, orderId: id });
      assert.equal(r.ok, false, `${id} 不该能开票`);
      assert.match(r.reason, /没付款的不能开票/);
    }
    // 一张都没落盘
    const got = listInvoices({ root });
    assert.equal(got.invoices.length, 0);
  } finally {
    done();
  }
});

test('订单不存在 / 没给 orderId：明确拒绝，不编一张出来', () => {
  const { root, done } = freshRoot('nope');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid')]);
    assert.equal(issueInvoice({ root }).ok, false);
    assert.match(issueInvoice({ root }).reason, /orderId/);
    const missing = issueInvoice({ root, orderId: 'ord_nope99' });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /没有这张订单/);
    assert.equal(listInvoices({ root }).invoices.length, 0);
  } finally {
    done();
  }
});

test('公司抬头没填税号：拒（不生成一张缺税号的废票）', () => {
  const { root, done } = freshRoot('notax');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid')]);
    const r = issueInvoice({ root, orderId: 'ord_0001', title: { type: 'company', name: '某公司' } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /税号/);
    // 个人抬头可以不填
    const ok = issueInvoice({ root, orderId: 'ord_0001', title: { type: 'personal' } });
    assert.equal(ok.ok, true);
    assert.equal(ok.invoice.title.type, 'personal');
  } finally {
    done();
  }
});

/* ── 5. 税率没配就说没配 ───────────────────────────────────────────────── */

test('税率未配置时：票面按不含税处理，并**明写**"税率未配置"', () => {
  const { root, done } = freshRoot('notaxrate');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid')]);
    const r = issueInvoice({ root, orderId: 'ord_0001' });
    assert.equal(r.ok, true);
    assert.equal(r.invoice.taxRate, 0);
    assert.equal(r.invoice.taxCents, 0);
    assert.match(r.invoice.taxNote, /税率未配置/);
    assert.match(renderInvoice(r.invoice), /税率未配置/);
    // 绝不出现"已含税"这种没根据的说法
    assert.doesNotMatch(r.invoice.taxNote, /已含税/);
  } finally {
    done();
  }
});

/* ── 6. 查询与导出 ─────────────────────────────────────────────────────── */

test('按订单查 / 列最近 / 导出 JSON 都对得上', () => {
  const { root, done } = freshRoot('query');
  try {
    seedOrders(root, [
      localOrder('ord_0001', 1800, 'paid', 'PAY-1'),
      localOrder('ord_0002', 2900, 'delivered', 'PAY-2'),
    ]);
    issueInvoice({ root, orderId: 'ord_0001', rate: 0.06 });
    issueInvoice({ root, orderId: 'ord_0002', rate: 0.06 });

    const one = listInvoices({ root, orderId: 'ord_0001' });
    assert.equal(one.invoices.length, 1);
    assert.equal(one.invoices[0].orderId, 'ord_0001');
    assert.equal(one.total, 2, 'total 该是全部张数');

    const all = listInvoices({ root });
    assert.equal(all.invoices.length, 2);
    assert.equal(all.invoices[0].orderId, 'ord_0001', '按开票顺序排');

    const missing = listInvoices({ root, orderId: 'ord_nope99' });
    assert.equal(missing.invoices.length, 0, '查不到就是空，不报错');

    const exp = exportInvoices({ root });
    assert.equal(exp.count, 2);
    const parsed = JSON.parse(exp.json);
    assert.equal(parsed.invoices.length, 2);
    assert.equal(parsed.invoices[0].no, one.invoices[0].no);
  } finally {
    done();
  }
});

/* ── 7. 坏文件不许崩、不许丢数据 ───────────────────────────────────────── */

test('发票文件坏掉时：当成空的继续用，不崩（且下一次开票会重建）', () => {
  const { root, done } = freshRoot('broken');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid')]);
    const file = invoicesPath(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ 这不是 json', 'utf8');

    const got = listInvoices({ root });
    assert.equal(got.ok, true, '读坏了也不许抛');
    assert.equal(got.invoices.length, 0);

    const r = issueInvoice({ root, orderId: 'ord_0001' });
    assert.equal(r.ok, true);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.invoices.length, 1, '坏文件该被重建，不是一直坏着');
  } finally {
    done();
  }
});

/* ── 8. 报告里必须写清边界 ─────────────────────────────────────────────── */

test('发票报告明说"这是数据不是税务合规电子发票"', () => {
  const { root, done } = freshRoot('render');
  try {
    seedOrders(root, [localOrder('ord_0001', 1800, 'paid', 'PAY-1')]);
    const r = issueInvoice({ root, orderId: 'ord_0001', rate: 0.06 });
    const text = renderInvoice(r.invoice);
    assert.match(text, /发票数据/);
    assert.match(text, /不是税务合规的电子发票/);
    assert.match(text, /需要资质/);
    assert.match(text, /¥18\.00/);
    assert.match(text, /不含税 .* \+ 税额 /);
    assert.match(text, /PAY-1/);
  } finally {
    done();
  }
});

test('常量表形状对：税率候选、抬头类型', () => {
  assert.ok(Array.isArray(TAX_RATES) && TAX_RATES.includes(0));
  assert.ok(TAX_RATES.every((r) => r >= 0 && r < 1), '税率都是小数不是百分数');
  assert.deepEqual([...TITLE_TYPES], ['personal', 'company']);
});
