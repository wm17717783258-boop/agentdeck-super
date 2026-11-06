/**
 * lib/market/invoice.js —— 发票数据（1.10.0）
 *
 * 蓝图第 312 行把「发票、税费」列进真实支付门槛。这里做的是**发票数据**这一层：
 * 把一张已付订单变成一份合规形状的发票记录（编号、抬头、税号、金额拆分、税额、行项目），
 * 并落盘可查、可导出。
 *
 * 诚实边界（写清楚，这是最容易吹过头的部分）：
 *   · 这里**不是**税务合规的电子发票。真正的增值税发票要走税控设备/税务平台（金税、航信等），
 *     或者让 Stripe / 支付宝这类渠道去开——那些都需要资质，本机没有。
 *   · 税率是**可配置**的，默认 0（未配置），并且明确标注「税率未配置」。
 *     绝不会自己编一个 6% 出来冒充"已含税"。
 *   · 不做税额计算的法律判断（什么该免税、能不能抵扣），只做"票面金额怎么拆"这一层算术。
 *
 * 所以这一层的定位是：**渠道或税务平台要给什么字段，我们这边先备齐**，
 * 而不是"我们已经能开票了"。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { marketDir, readOrders } from './store.js';

export const INVOICE_FILE = 'invoices.json';
export const INVOICE_VERSION = 1;
/** 常见税率（仅作下拉候选，绝不自动选一个） */
export const TAX_RATES = Object.freeze([0, 0.01, 0.03, 0.06, 0.09, 0.13]);
/** 抬头类型 */
export const TITLE_TYPES = Object.freeze(['personal', 'company']);

const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function invoicesPath(root) {
  return join(marketDir(root), INVOICE_FILE);
}

function readDoc(root) {
  const file = invoicesPath(root);
  if (!existsSync(file)) return { v: INVOICE_VERSION, invoices: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(raw?.invoices) ? raw.invoices : [];
    return { v: INVOICE_VERSION, invoices: list.filter((i) => i && typeof i === 'object' && i.id) };
  } catch {
    // 坏文件不覆盖、不崩：当成空的，让下一次写盘去修
    return { v: INVOICE_VERSION, invoices: [] };
  }
}

function writeDoc(root, doc) {
  const file = invoicesPath(root);
  mkdirSync(marketDir(root), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: INVOICE_VERSION, invoices: doc.invoices }, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/** 发票号：INV-<年月日>-<订单号后 6 位>，同一天同一单稳定（重开不换号）。 */
export function invoiceNoOf(orderId, atMs = Date.now()) {
  const d = new Date(Number(atMs) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const tail = String(orderId || '').replace(/^ord_/, '').slice(-6).toUpperCase() || 'XXXXXX';
  return `INV-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${tail}`;
}

/**
 * 票价拆分：含税总额按税率反算不含税金额与税额。
 * 用"分"做整数运算（先乘后除再四舍五入），避免浮点把 18.00 算成 17.999999。
 *
 * @param {number} totalCents 含税总额（分）
 * @param {number} rate       税率（0.06 = 6%）；0 表示未配置
 * @returns {{grossCents:number, netCents:number, taxCents:number, rate:number, rateConfigured:boolean}}
 */
export function splitTax(totalCents, rate) {
  const gross = Math.max(0, Math.round(num(totalCents)));
  const r = num(rate, 0);
  if (!Number.isFinite(r) || r <= 0) {
    return { grossCents: gross, netCents: gross, taxCents: 0, rate: 0, rateConfigured: false };
  }
  // 含税 → 不含税：net = gross / (1 + rate)
  const net = Math.round(gross / (1 + r));
  return { grossCents: gross, netCents: net, taxCents: gross - net, rate: r, rateConfigured: true };
}

/**
 * 开一张发票（数据层）。同一张订单重复调用返回同一张，不重复开。
 *
 * @param {{root:string, orderId:string, title?:object, rate?:number, now?:Function}} opts
 * @returns {{ok:boolean, invoice?:object, existed?:boolean, reason?:string}}
 */
export function issueInvoice({ root, orderId, title = {}, rate = 0, now } = {}) {
  const id = str(orderId);
  if (!id) return { ok: false, reason: '要开哪张单的发票？给 orderId（orders 里能看到）。' };

  const ordersDoc = readOrders(root, { now });
  const orders = Array.isArray(ordersDoc?.doc?.orders) ? ordersDoc.doc.orders : [];
  const order = orders.find((o) => o.id === id);
  if (!order) return { ok: false, reason: `没有这张订单：${id}（先 orders 看一眼）` };

  // 只有真付过钱的才能开票。created/failed 开票等于凭空造凭证。
  if (order.state !== 'paid' && order.state !== 'delivered') {
    return { ok: false, reason: `订单 ${id} 当前是 ${order.state}，没付款的不能开票。` };
  }

  const doc = readDoc(root);
  const existed = doc.invoices.find((i) => i.orderId === id);
  if (existed) return { ok: true, invoice: existed, existed: true };

  const atMs = Number(now ? (typeof now === 'function' ? now() : now) : Date.now());
  const split = splitTax(order.amount, rate);
  const type = TITLE_TYPES.includes(str(title.type)) ? str(title.type) : 'personal';
  const buyerName = str(title.name, type === 'company' ? '（未填开票抬头）' : '个人');
  const buyerTaxId = str(title.taxId);

  if (type === 'company' && !buyerTaxId) {
    return { ok: false, reason: '公司抬头要填税号（title.taxId）；不想填就按个人抬头开。' };
  }

  const invoice = {
    id: `inv_${atMs.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    no: invoiceNoOf(id, atMs),
    orderId: id,
    skinId: order.skinId || null,
    skinName: order.skinName || order.skinId || null,
    title: { type, name: buyerName, ...(buyerTaxId ? { taxId: buyerTaxId } : {}) },
    currency: order.currency || 'CNY',
    grossCents: split.grossCents,
    netCents: split.netCents,
    taxCents: split.taxCents,
    taxRate: split.rate,
    // 税率没配就明写，绝不假装已含税
    taxNote: split.rateConfigured ? `${(split.rate * 100).toFixed(0)}% 已按含税价反算` : '税率未配置，票面按不含税处理',
    state: 'issued',
    issuedAt: new Date(atMs).toISOString(),
    lines: [{
      name: `皮肤：${order.skinName || order.skinId || '（未命名）'}`,
      qty: 1,
      unitCents: split.netCents,
      amountCents: split.netCents,
    }],
    // 外部凭证号（渠道/税务平台给了就填；没给就是 null，不编）
    externalRef: order.payment?.ref || null,
  };

  doc.invoices.push(invoice);
  writeDoc(root, doc);
  return { ok: true, invoice, existed: false };
}

/** 查发票：给 orderId 查那一张，不给就列最近的。 */
export function listInvoices({ root, orderId, limit = 20 } = {}) {
  const doc = readDoc(root);
  const wanted = str(orderId);
  if (wanted) {
    const one = doc.invoices.find((i) => i.orderId === wanted);
    return { ok: true, invoices: one ? [one] : [], total: doc.invoices.length };
  }
  const n = Math.min(200, Math.max(1, Math.round(num(limit, 20))));
  return { ok: true, invoices: doc.invoices.slice(-n), total: doc.invoices.length };
}

/** 导出成渠道/财务能吃的样子（JSON 字符串）。 */
export function exportInvoices({ root, orderId } = {}) {
  const got = listInvoices({ root, orderId });
  return { ok: true, json: `${JSON.stringify({ v: INVOICE_VERSION, invoices: got.invoices }, null, 2)}\n`, count: got.invoices.length };
}

/** 给人看的一行发票。 */
export function renderInvoice(inv) {
  if (!inv) return '（没有这张发票）';
  const yuan = (c) => `¥${(num(c) / 100).toFixed(2)}`;
  const title = inv.title?.type === 'company' ? `${inv.title.name}（税号 ${inv.title.taxId}）` : '个人';
  const lines = [
    `【发票】${inv.no}`,
    `订单：${inv.orderId}｜状态：${inv.state === 'issued' ? '已开（数据层）' : inv.state}`,
    `抬头：${title}`,
    `金额：${yuan(inv.grossCents)}（不含税 ${yuan(inv.netCents)} + 税额 ${yuan(inv.taxCents)}）`,
    `税率：${inv.taxNote}`,
    `开票时间：${String(inv.issuedAt || '').replace('T', ' ').slice(0, 19)}`,
    inv.externalRef ? `渠道流水：${inv.externalRef}` : '渠道流水：（没有）',
    '',
    '注意：这是**发票数据**，不是税务合规的电子发票——真要开票得走税务平台或让渠道开，',
    '那需要资质；本机只负责把票面字段备齐、可查、可导出。',
  ];
  return lines.join('\n');
}

export default { INVOICE_FILE, TAX_RATES, TITLE_TYPES, invoiceNoOf, splitTax, issueInvoice, listInvoices, exportInvoices, renderInvoice };
