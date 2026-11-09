/**
 * lib/market/payout.js —— 卖家的收款方式（人工渠道真正能用的那一半）
 *
 * 为什么需要它：人工渠道的通路是「下单 → 转账 → 确认」，
 * 但中间那句"按约定方式转账"如果没有具体账号，买家根本不知道往哪付 ——
 * 整个流程就卡在第一步。这不是技术问题，是"话没说到位"。
 *
 * 存在哪：`<root>/market/payinfo.json`，卖家自己写一次，之后每次下单都会带上。
 * 为什么不放环境变量：核心**不读环境变量**（见 lib/market/purchase.js 的说明），
 * 而且这份信息要给买家看，落文件比落 env 更稳（换终端、换宿主都还在）。
 *
 * 边界：这里只存"往哪付"，不存任何密钥；也不存二维码图片，只存图片路径或文本账号。
 * 谁都能读这个文件 —— 本来就该谁都能读，它是要给买家看的。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 支持的方式（白名单：写错了就是一行看不懂的字） */
export const PAY_KINDS = Object.freeze([
  { kind: 'alipay', label: '支付宝' },
  { kind: 'wechat', label: '微信支付' },
  { kind: 'bank', label: '银行转账' },
  { kind: 'paypal', label: 'PayPal' },
  { kind: 'stripe', label: 'Stripe 收款链接' },
  { kind: 'other', label: '其他' },
]);

const KIND_SET = new Set(PAY_KINDS.map((item) => item.kind));
const MAX_METHODS = 5;

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** `<root>/market/payinfo.json` */
export function payInfoPath(root) {
  const base = typeof root === 'string' && root.trim() ? root.trim() : '';
  return base ? path.join(base, 'market', 'payinfo.json') : '';
}

/**
 * 归一化一条收款方式。字段不认识的丢掉 —— 买家看到的是"往哪付"，
 * 多出来的字段只可能是误填或注入。
 * @returns {{kind:string,label:string,account:string,name:string,note:string}|null}
 */
export function normalizeMethod(raw) {
  const src = plain(raw);
  const kind = str(src.kind).toLowerCase();
  const account = str(src.account);
  if (!KIND_SET.has(kind) || !account) return null;
  const known = PAY_KINDS.find((item) => item.kind === kind);
  return {
    kind,
    label: str(src.label, known.label).slice(0, 20),
    account: account.slice(0, 120),
    name: str(src.name).slice(0, 40),
    note: str(src.note).slice(0, 80),
  };
}

/**
 * 读收款方式。文件不存在 → 空（不是错误：还没配而已）。
 * @param {string} root
 * @returns {{ ok:boolean, path:string, methods:object[], note:string, updatedAt:string, warnings:string[] }}
 */
export function readPayInfo(root) {
  const file = payInfoPath(root);
  const out = { ok: true, path: file, methods: [], note: '', updatedAt: '', currencyNote: '', warnings: [] };
  if (!file) {
    out.ok = false;
    out.warnings.push('没有工作区路径，读不到收款方式');
    return out;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') out.warnings.push(`收款方式读不了：${err.message || err}`);
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    out.warnings.push('收款方式文件不是合法 JSON，本轮按"还没配"处理（文件没动）');
    return out;
  }
  const src = plain(parsed);
  const methods = [];
  for (const item of Array.isArray(src.methods) ? src.methods : []) {
    const one = normalizeMethod(item);
    if (one && !methods.some((m) => m.kind === one.kind && m.account === one.account)) methods.push(one);
    if (methods.length >= MAX_METHODS) break;
  }
  out.methods = methods;
  out.note = str(src.note).slice(0, 200);
  out.updatedAt = str(src.updatedAt);
  return out;
}

/**
 * 写收款方式（整份覆盖）。给 CLI / 工具层用。
 *
 * @param {string} root
 * @param {{ methods?: object[], note?: string }} input
 * @returns {{ ok:boolean, path?:string, methods?:object[], rejected?:number, reason?:string }}
 */
export function writePayInfo(root, input = {}) {
  const file = payInfoPath(root);
  if (!file) return { ok: false, reason: '没有工作区路径，存不了收款方式' };
  const src = plain(input);
  const rawList = Array.isArray(src.methods) ? src.methods : [];
  const methods = [];
  let rejected = 0;
  for (const item of rawList) {
    const one = normalizeMethod(item);
    if (!one) { rejected += 1; continue; }
    if (methods.some((m) => m.kind === one.kind && m.account === one.account)) continue;
    methods.push(one);
    if (methods.length >= MAX_METHODS) break;
  }
  if (!methods.length) {
    return { ok: false, reason: '至少给一条收款方式：kind 取 alipay/wechat/bank/paypal/stripe/other，account 填账号或链接', rejected };
  }
  const doc = {
    v: 1,
    updatedAt: new Date().toISOString(),
    note: str(src.note).slice(0, 200),
    methods,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { ok: true, path: file, methods, rejected };
  } catch (err) {
    return { ok: false, reason: `写 ${path.basename(file)} 失败：${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * 把收款方式排成给人看的几行（下单时直接贴给买家）。
 * @param {{ methods?:object[], note?:string }} info
 * @returns {string[]} 每行一条；没配返回空数组（调用方据此给"去配一下"的提示）
 */
export function payInfoLines(info) {
  const src = plain(info);
  const methods = Array.isArray(src.methods) ? src.methods : [];
  if (!methods.length) return [];
  const lines = [];
  for (const item of methods) {
    const one = plain(item);
    const who = str(one.name) ? `（${str(one.name)}）` : '';
    const extra = str(one.note) ? `  ${str(one.note)}` : '';
    lines.push(`  · ${str(one.label, str(one.kind))}：${str(one.account)}${who}${extra}`);
  }
  if (str(src.note)) lines.push(`  ${str(src.note)}`);
  return lines;
}
