/**
 * lib/market/store.js —— 皮肤市场的本地账本：订单 + 分账流水
 *
 * 为什么要有这一层：
 *   皮肤市场得能「不连数据库、不起服务」先跑通——订单和分账先落本地文件；
 *   等真接了支付渠道，业务代码只换 billing 适配器，账本格式不用动。
 *
 * 三条硬规矩（市场这块最容易做假，所以写死在这一层）：
 *   1. **金额一律整数分（cents）**：文件里不出现小数，累加也只加整数；
 *   2. **写盘必须原子**：同目录写 .tmp → fsync → rename，中途断电不会留下半截 JSON；
 *   3. **读坏文件不许崩**：现场归档成 <file>.corrupt-<ms>.json，账本恢复成空，继续开门做生意。
 *
 * 目录（root 由调用方传入，插件里是 $DSH_HOME/agentdeck-super）：
 *   <root>/market/orders.json   订单状态机：created → paid → delivered → refunded
 *   <root>/market/ledger.json   已购皮肤 + 80/20 分账流水
 *
 * 时间一律由调用方注入（now 可以是函数 / Date / 毫秒数），这里不自己调 Date.now() 做业务判断。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** 市场目录名（放在 root 下，不跟 .agentdeck 目录抢位置） */
export const MARKET_DIR_NAME = 'market';
export const ORDERS_FILE = 'orders.json';
export const LEDGER_FILE = 'ledger.json';
export const ORDERS_VERSION = 1;
export const LEDGER_VERSION = 1;

/** 订单状态机：只认这四个，别的一律当没写 */
export const ORDER_STATES = Object.freeze(['created', 'paid', 'delivered', 'refunded']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 金额归一成整数分：负数、NaN、小数一律拍平，绝不让浮点混进账本 */
function cents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** 皮肤 id 只允许保守字符集（和 lib/pet/skins.js 的规则一致） */
function safeSkinId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id) && !id.includes('..') ? id : '';
}

function safeOrderId(value) {
  const id = String(value || '').trim();
  return /^ord_[a-z0-9]{4,32}$/i.test(id) ? id : '';
}

function safeIso(value) {
  const text = str(value);
  if (!text) return '';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function isoOr(value, fallbackMs) {
  return safeIso(value) || isoOf(fallbackMs);
}

/** 统一的时钟入口：函数 / Date / 毫秒数都认 */
export function clockOf(now) {
  if (typeof now === 'function') {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(ms) ? ms : Date.now();
  }
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  const ms = Number(now);
  return Number.isFinite(ms) ? ms : Date.now();
}

export function isoOf(ms) {
  return new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now()).toISOString();
}

function shortHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 8);
}

/** 流水行 id 由订单 + 类型决定，重复发放不会写出两条 */
export function ledgerEntryId(orderId, kind) {
  return `led_${shortHash(`${orderId}|${kind}`)}`;
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 默认根：插件里状态都跟人走（$DSH_HOME/agentdeck-super），但市场层优先用调用方传的 root */
function defaultRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'agentdeck-super');
}

/** 账本根目录（root 为空时退到 $DSH_HOME/agentdeck-super，和 lib/pet 的约定一致） */
export function marketRoot(root) {
  return typeof root === 'string' && root.trim() ? root.trim() : defaultRoot();
}

export function marketDir(root) {
  return path.join(marketRoot(root), MARKET_DIR_NAME);
}

export function ordersPath(root) {
  return path.join(marketDir(root), ORDERS_FILE);
}

export function ledgerPath(root) {
  return path.join(marketDir(root), LEDGER_FILE);
}

/** 一次拿齐路径，日志/状态页直接展示 */
export function marketPaths(root) {
  const base = marketRoot(root);
  return { root: base, dir: path.join(base, MARKET_DIR_NAME), ordersFile: ordersPath(base), ledgerFile: ledgerPath(base) };
}

// ---------------------------------------------------------------------------
// 归一化（读盘、写盘都过这里：脏数据不进业务层）
// ---------------------------------------------------------------------------

function normalizeOrder(raw, nowMs) {
  const src = plain(raw);
  const id = safeOrderId(src.id);
  const skinId = safeSkinId(src.skinId);
  if (!id || !skinId) return null;

  const state = ORDER_STATES.includes(src.state) ? src.state : 'created';
  const createdAt = isoOr(src.createdAt, nowMs);
  const updatedAt = isoOr(src.updatedAt, Date.parse(createdAt));

  const paymentSrc = plain(src.payment);
  const deliverySrc = plain(src.delivery);
  const refundSrc = plain(src.refund);
  const metaSrc = plain(src.meta);

  const code = str(deliverySrc.code);
  const delivery = /^SKIN-[A-Z0-9-]{1,64}$/.test(code)
    ? { code, deliveredAt: isoOr(deliverySrc.deliveredAt, Date.parse(updatedAt)) }
    : null;

  const buyer = str(src.buyer, 'local').slice(0, 64);
  const meta = {};
  // meta 只留短字符串/整数，别把任意对象存进账本
  for (const [key, value] of Object.entries(metaSrc)) {
    if (typeof value === 'string') meta[key] = value.slice(0, 200);
    else if (Number.isInteger(value)) meta[key] = value;
  }

  return {
    id,
    skinId,
    skinName: str(src.skinName, skinId).slice(0, 80),
    author: str(src.author, '').slice(0, 80),
    state,
    amount: cents(src.amount),
    currency: 'CNY',
    buyer,
    createdAt,
    updatedAt,
    payment: paymentSrc.provider || paymentSrc.ref
      ? {
        provider: str(paymentSrc.provider, 'custom').slice(0, 40),
        ref: str(paymentSrc.ref, '').slice(0, 120),
        paidAt: isoOr(paymentSrc.paidAt, Date.parse(updatedAt)),
      }
      : null,
    delivery,
    refund: refundSrc.at || refundSrc.reason
      ? { reason: str(refundSrc.reason, '用户申请退款').slice(0, 200), at: isoOr(refundSrc.at, Date.parse(updatedAt)) }
      : null,
    meta,
  };
}

/** 订单文件归一化：坏行直接丢，重复 id 只留第一条 */
export function normalizeOrders(raw, nowMs = Date.now()) {
  const src = plain(raw);
  const list = Array.isArray(src.orders) ? src.orders : [];
  const orders = [];
  const seen = new Set();
  for (const item of list) {
    const order = normalizeOrder(item, nowMs);
    if (!order || seen.has(order.id)) continue;
    seen.add(order.id);
    orders.push(order);
    if (orders.length >= 5000) break; // 账本撑爆时先保住前 5000 单
  }
  return { v: ORDERS_VERSION, updatedAt: isoOr(src.updatedAt, nowMs), orders };
}

function normalizePurchase(raw, nowMs) {
  const src = plain(raw);
  const skinId = safeSkinId(src.skinId);
  const orderId = safeOrderId(src.orderId);
  if (!skinId || !orderId) return null;
  const code = str(src.code);
  return {
    skinId,
    orderId,
    at: isoOr(src.at, nowMs),
    code: /^SKIN-[A-Z0-9-]{1,64}$/.test(code) ? code : null,
    refundedAt: safeIso(src.refundedAt) || null,
  };
}

function normalizeEntry(raw, nowMs) {
  const src = plain(raw);
  const orderId = safeOrderId(src.orderId);
  const skinId = safeSkinId(src.skinId);
  const kind = src.kind === 'refund' ? 'refund' : src.kind === 'sale' ? 'sale' : '';
  const amount = cents(src.amount);
  if (!orderId || !skinId || !kind || amount <= 0) return null;
  const creatorSrc = plain(src.creator);
  const platformSrc = plain(src.platform);
  const creatorAmount = cents(creatorSrc.amount);
  const platformAmount = cents(platformSrc.amount);
  // 分账两半必须刚好等于总额；对不上说明文件被改过，宁可丢掉这行也不记账
  if (creatorAmount + platformAmount !== amount) return null;
  return {
    id: str(src.id, ledgerEntryId(orderId, kind)).slice(0, 32),
    at: isoOr(src.at, nowMs),
    orderId,
    skinId,
    kind,
    amount,
    currency: 'CNY',
    creator: { shareBps: Math.max(0, Math.min(10000, Math.round(num(creatorSrc.shareBps, 8000)))), amount: creatorAmount },
    platform: { shareBps: Math.max(0, Math.min(10000, Math.round(num(platformSrc.shareBps, 2000)))), amount: platformAmount },
    reason: str(src.reason, '').slice(0, 200) || undefined,
  };
}

/** 分账账本归一化 */
export function normalizeLedger(raw, nowMs = Date.now()) {
  const src = plain(raw);
  const purchases = [];
  const seenPurchase = new Set();
  for (const item of Array.isArray(src.purchases) ? src.purchases : []) {
    const purchase = normalizePurchase(item, nowMs);
    if (!purchase) continue;
    const key = `${purchase.orderId}|${purchase.skinId}`;
    if (seenPurchase.has(key)) continue;
    seenPurchase.add(key);
    purchases.push(purchase);
  }
  const entries = [];
  const seenEntry = new Set();
  for (const item of Array.isArray(src.entries) ? src.entries : []) {
    const entry = normalizeEntry(item, nowMs);
    if (!entry || seenEntry.has(entry.id)) continue;
    seenEntry.add(entry.id);
    entries.push(entry);
  }
  return { v: LEDGER_VERSION, updatedAt: isoOr(src.updatedAt, nowMs), purchases, entries };
}

/** 已购（且没退款）的皮肤 id，顺序按购买先后 */
export function purchasedSkinIds(doc) {
  const src = plain(doc);
  const out = [];
  for (const item of Array.isArray(src.purchases) ? src.purchases : []) {
    const purchase = plain(item);
    const skinId = safeSkinId(purchase.skinId);
    if (!skinId || purchase.refundedAt) continue;
    if (!out.includes(skinId)) out.push(skinId);
  }
  return out;
}

/** 分账合计：全是整数分，退款按负数抵消 */
export function ledgerTotals(doc) {
  const src = plain(doc);
  const entries = Array.isArray(src.entries) ? src.entries : [];
  let gross = 0;
  let creator = 0;
  let platform = 0;
  let refunded = 0;
  const saleOrders = new Set();
  for (const raw of entries) {
    const entry = plain(raw);
    const amount = cents(entry.amount);
    if (!amount) continue;
    const creatorAmount = cents(plain(entry.creator).amount);
    const platformAmount = cents(plain(entry.platform).amount);
    if (entry.kind === 'refund') {
      refunded += amount;
      gross -= amount;
      creator -= creatorAmount;
      platform -= platformAmount;
    } else {
      saleOrders.add(str(entry.orderId));
      gross += amount;
      creator += creatorAmount;
      platform += platformAmount;
    }
  }
  return {
    currency: 'CNY',
    orders: saleOrders.size,
    gross,
    creator,
    platform,
    refunded,
    purchases: purchasedSkinIds(src).length,
  };
}

// ---------------------------------------------------------------------------
// 原子写 / 坏文件恢复
// ---------------------------------------------------------------------------

/**
 * 原子写 JSON：同目录 .tmp → fsync → rename。
 * 失败时把 .tmp 清掉，原文件保持原样（绝不出现「写了一半」的订单文件）。
 * @returns {{ ok:boolean, path?:string, bytes?:number, reason?:string }}
 */
export function writeJsonAtomic(file, doc) {
  let tmp = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { ok: true, path: file, bytes: Buffer.byteLength(text) };
  } catch (err) {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清不掉就留着，不影响原文件 */
      }
    }
    return { ok: false, reason: `写 ${path.basename(file)} 失败：${err && err.message ? err.message : String(err)}` };
  }
}

/** 读坏文件时归档现场（rename 不动原内容），返回归档路径 */
function parkCorruptFile(file, nowMs, warnings) {
  const dest = `${file}.corrupt-${Math.round(nowMs)}.json`;
  try {
    fs.renameSync(file, dest);
    warnings.push(`${path.basename(file)} 读坏了，现场已归档为 ${path.basename(dest)}，账本恢复为空`);
    return dest;
  } catch (err) {
    warnings.push(`${path.basename(file)} 读坏了，而且归档失败（${err && err.message ? err.message : String(err)}），账本按空处理`);
    return '';
  }
}

function readDocFile(file, normalize, nowMs, label) {
  const warnings = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      warnings.push(`${label}读不了：${err.message || err}`);
    }
    return { ok: true, doc: normalize({}, nowMs), recovered: false, warnings };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const corruptPath = parkCorruptFile(file, nowMs, warnings);
    return { ok: true, doc: normalize({}, nowMs), recovered: true, corruptPath, warnings };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const corruptPath = parkCorruptFile(file, nowMs, warnings);
    return { ok: true, doc: normalize({}, nowMs), recovered: true, corruptPath, warnings };
  }
  return { ok: true, doc: normalize(parsed, nowMs), recovered: false, warnings };
}

// ---------------------------------------------------------------------------
// 对外：直接按 root 读写（不需要先建 store）
// ---------------------------------------------------------------------------

/** 读订单：文件不存在 → 空账本；文件坏了 → 归档 + 空账本，永不抛错 */
export function readOrders(root, { now } = {}) {
  return readDocFile(ordersPath(root), normalizeOrders, clockOf(now), '订单文件');
}

/** 读分账账本（含已购皮肤） */
export function readLedger(root, { now } = {}) {
  return readDocFile(ledgerPath(root), normalizeLedger, clockOf(now), '分账账本');
}

/** 写订单（原子写；写前归一化，脏字段进不了文件） */
export function writeOrders(root, doc, { now } = {}) {
  return writeJsonAtomic(ordersPath(root), normalizeOrders(doc, clockOf(now)));
}

/** 写分账账本（原子写） */
export function writeLedger(root, doc, { now } = {}) {
  return writeJsonAtomic(ledgerPath(root), normalizeLedger(doc, clockOf(now)));
}

// ---------------------------------------------------------------------------
// store：把 root + 时钟 + 两个文件绑成一个对象（业务层只拿这一样东西）
// ---------------------------------------------------------------------------

/**
 * @param {{ root?:string, now?:Function|Date|number }} [opts]
 * @returns {{ ok:true, root:string, dir:string, ordersFile:string, ledgerFile:string,
 *   now:()=>number, warnings:()=>string[], location:()=>object,
 *   readOrders:Function, writeOrders:Function, updateOrders:Function,
 *   readLedger:Function, writeLedger:Function, updateLedger:Function, reset:Function }}
 */
export function createMarketStore({ root, now } = {}) {
  const warnings = [];
  const base = marketRoot(root);
  if (!(typeof root === 'string' && root.trim())) {
    warnings.push('createMarketStore 没有收到 root，账本落在 $DSH_HOME/agentdeck-super/market 下');
  }
  const dir = marketDir(base);
  const ordersFile = ordersPath(base);
  const ledgerFile = ledgerPath(base);
  const clock = () => clockOf(now);

  const remember = (result) => {
    for (const line of result && Array.isArray(result.warnings) ? result.warnings : []) {
      if (!warnings.includes(line)) warnings.push(line);
    }
    return result;
  };

  const updateFile = (file, normalize, mutator, label) => {
    const read = remember(readDocFile(file, normalize, clock(), label));
    let next;
    try {
      next = mutator(read.doc) || read.doc;
    } catch (err) {
      return { ok: false, reason: `更新${label}时出错：${err && err.message ? err.message : String(err)}` };
    }
    const normalized = normalize(next, clock());
    normalized.updatedAt = isoOf(clock());
    const wrote = writeJsonAtomic(file, normalized);
    if (!wrote.ok) return { ok: false, reason: wrote.reason, doc: read.doc };
    return { ok: true, doc: normalized, recovered: read.recovered, warnings: read.warnings };
  };

  return {
    ok: true,
    root: base,
    dir,
    ordersFile,
    ledgerFile,
    now: () => clock(),
    warnings: () => warnings.slice(),
    location: () => ({ root: base, dir, ordersFile, ledgerFile }),
    readOrders: () => remember(readOrders(base, { now: clock() })),
    writeOrders: (doc) => writeOrders(base, doc, { now: clock() }),
    updateOrders: (mutator) => updateFile(ordersFile, normalizeOrders, mutator, '订单'),
    readLedger: () => remember(readLedger(base, { now: clock() })),
    writeLedger: (doc) => writeLedger(base, doc, { now: clock() }),
    updateLedger: (mutator) => updateFile(ledgerFile, normalizeLedger, mutator, '分账账本'),
    reset: () => {
      try {
        fs.rmSync(ordersFile, { force: true });
        fs.rmSync(ledgerFile, { force: true });
        return { ok: true, dir };
      } catch (err) {
        return { ok: false, reason: `清空账本失败：${err && err.message ? err.message : String(err)}` };
      }
    },
  };
}
