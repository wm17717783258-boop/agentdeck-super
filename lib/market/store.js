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
 *   4. **读-改-写必须跨进程互斥**：见下面的 withFileLock —— 两个宿主同时开着时，
 *      光靠原子 rename 只能保证"文件不撕裂"，挡不住"后写的覆盖先写的"（实测丢过 9/15 单）。
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
import { SEAL_KEY_FILE, loadSealKey, sealDoc, verifyDocSeal, SEAL_STATUS } from './integrity.js';

/** 市场目录名（放在 root 下，不跟 .agentdeck 目录抢位置） */
export const MARKET_DIR_NAME = 'market';
export const ORDERS_FILE = 'orders.json';
export const LEDGER_FILE = 'ledger.json';
export const ORDERS_VERSION = 1;
export const LEDGER_VERSION = 1;

/** 订单状态机：只认这四个，别的一律当没写 */
export const ORDER_STATES = Object.freeze(['created', 'paid', 'delivered', 'refunded']);

/**
 * 单文件最多载入多少单。
 * 超出的部分**不删**（原文件一个字都不动），只是这轮不载入，并给一条 warning。
 * 以前是 `break` 静默截断 —— 用户完全不知道自己看到的不是全部账。
 */
export const MAX_ORDERS = 5000;

/** 隔离区上限：认不出来的行原样留档，最多留这么多条，防止坏文件把账本撑爆 */
export const QUARANTINE_MAX = 200;

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
  const licenseKey = str(deliverySrc.licenseKey);
  const delivery = /^SKIN-[A-Z0-9-]{1,64}$/.test(code)
    ? {
      code,
      deliveredAt: isoOr(deliverySrc.deliveredAt, Date.parse(updatedAt)),
      // 签名授权（ADSK1）：可选的「硬凭据」，验签通过才算数，伪造不了
      ...(licenseKey.startsWith('ADSK1.') && licenseKey.length <= 4096 ? { licenseKey } : {}),
    }
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
    refund: refundSrc.at || refundSrc.reason || refundSrc.ref || refundSrc.refundId
      ? {
        reason: str(refundSrc.reason, '用户申请退款').slice(0, 200),
        at: isoOr(refundSrc.at, Date.parse(updatedAt)),
        provider: str(refundSrc.provider, '').slice(0, 40) || undefined,
        ref: str(refundSrc.ref, '').slice(0, 160) || undefined,
        refundId: str(refundSrc.refundId, '').slice(0, 80) || undefined,
      }
      : null,
    meta,
  };
}

/** 订单文件归一化：坏行直接丢，重复 id 只留第一条 */
/**
 * 归一化订单。
 *
 * `warnings` 是可选收集器：认不出来的行**不能静默丢**。
 * 账本是付款凭据 —— 静默丢一行，等于"用户付过钱但系统查不到这笔单"，
 * 而且下次写入会把丢掉的形态落盘，现场再也回不来。
 * 所以认不出来的行进 `quarantined` 原样留档，并给一条 warning。
 *
 * @param {any} raw
 * @param {number} [nowMs]
 * @param {string[]|null} [warnings]
 */
export function normalizeOrders(raw, nowMs = Date.now(), warnings = null) {
  const src = plain(raw);
  const list = Array.isArray(src.orders) ? src.orders : [];
  const orders = [];
  const seen = new Set();
  const rejected = [];
  let dropped = 0;
  let dup = 0;
  let truncated = 0;
  for (const item of list) {
    const order = normalizeOrder(item, nowMs);
    if (!order) {
      dropped += 1;
      if (rejected.length < QUARANTINE_MAX) rejected.push(item);
      continue;
    }
    if (seen.has(order.id)) {
      dup += 1;
      continue;
    }
    seen.add(order.id);
    if (orders.length >= MAX_ORDERS) {
      truncated += 1;
      continue;
    }
    orders.push(order);
  }
  // 之前已经隔离过的行继续原样带着，别在这一轮洗掉
  const carried = Array.isArray(src.quarantined) ? src.quarantined : [];
  const quarantined = [...carried, ...rejected].slice(-QUARANTINE_MAX);
  if (warnings) {
    if (dropped) {
      warnings.push(`订单文件里有 ${dropped} 行认不出来（缺 id / skinId 不合法 / 被改过），`
        + `已原样移入 quarantined 保留，未参与对账`);
    }
    if (dup) warnings.push(`订单文件里有 ${dup} 行订单号重复，已保留第一条`);
    if (truncated) warnings.push(`订单超过 ${MAX_ORDERS} 单，超出部分未载入（原文件没动）`);
  }
  const out = { v: ORDERS_VERSION, updatedAt: isoOr(src.updatedAt, nowMs), orders };
  if (quarantined.length) out.quarantined = quarantined;
  // 印章必须原样带回去：读 → 归一化 → 校验，一路都得看得见它
  if (typeof src.seal === 'string' && src.seal) out.seal = src.seal;
  return out;
}

function normalizePurchase(raw, nowMs) {
  const src = plain(raw);
  const skinId = safeSkinId(src.skinId);
  const orderId = safeOrderId(src.orderId);
  if (!skinId || !orderId) return null;
  const code = str(src.code);
  const licenseKey = str(src.licenseKey);
  const out = {
    skinId,
    orderId,
    at: isoOr(src.at, nowMs),
    // 金额跟着记一笔：交叉核对要拿它和订单比，否则「改个订单号就能换贵皮肤」
    amount: Math.max(0, cents(src.amount)),
    code: /^SKIN-[A-Z0-9-]{1,64}$/.test(code) ? code : null,
    refundedAt: safeIso(src.refundedAt) || null,
  };
  // 签名授权（ADSK1）原样留着：它不是本机推导的，伪造不了，跟着账本走反而更方便换机
  if (licenseKey.startsWith('ADSK1.') && licenseKey.length <= 4096) out.licenseKey = licenseKey;
  return out;
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
    provider: str(src.provider, '').slice(0, 40) || undefined,
    channelRef: str(src.channelRef, '').slice(0, 160) || undefined,
    channel: plain(src.channel).ref
      ? {
        provider: str(src.channel.provider, '').slice(0, 40) || undefined,
        ref: str(src.channel.ref, '').slice(0, 160),
        refundId: str(src.channel.refundId, '').slice(0, 80) || undefined,
      }
      : undefined,
  };
}

/** 分账账本归一化 */
export function normalizeLedger(raw, nowMs = Date.now(), warnings = null) {
  const src = plain(raw);
  const purchases = [];
  const seenPurchase = new Set();
  const rejected = [];
  let droppedPurchase = 0;
  for (const item of Array.isArray(src.purchases) ? src.purchases : []) {
    const purchase = normalizePurchase(item, nowMs);
    if (!purchase) {
      droppedPurchase += 1;
      if (rejected.length < QUARANTINE_MAX) rejected.push({ where: 'purchases', row: item });
      continue;
    }
    const key = `${purchase.orderId}|${purchase.skinId}`;
    if (seenPurchase.has(key)) continue;
    seenPurchase.add(key);
    purchases.push(purchase);
  }
  const entries = [];
  const seenEntry = new Set();
  let droppedEntry = 0;
  let unbalanced = 0;
  for (const item of Array.isArray(src.entries) ? src.entries : []) {
    const entry = normalizeEntry(item, nowMs);
    if (!entry) {
      droppedEntry += 1;
      if (rejected.length < QUARANTINE_MAX) rejected.push({ where: 'entries', row: item });
      continue;
    }
    if (seenEntry.has(entry.id)) continue;
    seenEntry.add(entry.id);
    entries.push(entry);
  }
  // 分账对不上的行单独数一遍：那是"钱和记录不一致"的强信号，值得单独说
  for (const item of Array.isArray(src.entries) ? src.entries : []) {
    const raw2 = plain(item);
    const amount = cents(raw2.amount);
    if (!amount) continue;
    if (cents(plain(raw2.creator).amount) + cents(plain(raw2.platform).amount) !== amount) unbalanced += 1;
  }
  const carried = Array.isArray(src.quarantined) ? src.quarantined : [];
  const quarantined = [...carried, ...rejected].slice(-QUARANTINE_MAX);
  if (warnings) {
    if (droppedPurchase) warnings.push(`账本里有 ${droppedPurchase} 条已购记录认不出来，已原样移入 quarantined`);
    if (droppedEntry) warnings.push(`账本里有 ${droppedEntry} 条分账记录认不出来，已原样移入 quarantined`);
    if (unbalanced) warnings.push(`账本里有 ${unbalanced} 条分账两半加起来不等于总额（文件被改过？），未计入合计`);
  }
  const out = { v: LEDGER_VERSION, updatedAt: isoOr(src.updatedAt, nowMs), purchases, entries };
  if (quarantined.length) out.quarantined = quarantined;
  if (typeof src.seal === 'string' && src.seal) out.seal = src.seal;
  return out;
}

/**
 * 已购（且没退款）的皮肤 id，顺序按购买先后。
 *
 * 1.11.9 起**不再单独采信** purchases 这一份文件：账本说「买过」还要订单说得上话。
 * 传了 `orders` 就交叉核对（每条已购记录必须有对应的 delivered 订单，金额还要对得上）；
 * 传了 `trusted === false`（封印对不上）就一条都不认。
 *
 * 为什么必须交叉核对：只用一份文件判定归属，改那一行就够了 —— 实测确实能解锁付费皮肤。
 * 两份文件 + 封印之后，造假变成「改两个文件、还要重算 HMAC」。
 *
 * @param {object} doc 账本文档
 * @param {{ orders?: object, trusted?: boolean, warnings?: string[] }} [opts]
 * @returns {string[]}
 */
export function purchasedSkinIds(doc, opts = {}) {
  const src = plain(doc);
  const o = plain(opts);
  const warnings = Array.isArray(o.warnings) ? o.warnings : null;
  const out = [];
  if (o.trusted === false) {
    if (warnings) warnings.push('账本完整性校验没通过，本轮不采信任何本地购买凭据（签名授权不受影响）');
    return out;
  }

  // 订单侧证据：只有 delivered 且没退款的订单才算数
  let proof = null;
  if (o.orders && typeof o.orders === 'object') {
    proof = new Map();
    for (const raw of Array.isArray(o.orders.orders) ? o.orders.orders : []) {
      const order = plain(raw);
      const id = str(order.id);
      if (!id) continue;
      if (order.state !== 'delivered') continue;
      proof.set(id, order);
    }
  }

  let unproven = 0;
  for (const item of Array.isArray(src.purchases) ? src.purchases : []) {
    const purchase = plain(item);
    const skinId = safeSkinId(purchase.skinId);
    if (!skinId || purchase.refundedAt) continue;
    if (proof) {
      const order = proof.get(str(purchase.orderId));
      if (!order) { unproven += 1; continue; }
      // 金额与皮肤都得对得上，免得「拿一张便宜单的号去换贵皮肤」
      if (safeSkinId(order.skinId) !== skinId) { unproven += 1; continue; }
      // 老账本里的 purchase 没有 amount，只验订单号 + 皮肤；有新字段就一起验
      const paidCents = cents(purchase.amount);
      if (paidCents > 0 && cents(order.amount) !== paidCents) { unproven += 1; continue; }
    }
    if (!out.includes(skinId)) out.push(skinId);
  }
  if (unproven && warnings) {
    warnings.push(`账本里有 ${unproven} 条已购记录找不到对应的已发放订单（或被改过），未计入已购`);
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
// 跨进程互斥锁
// ---------------------------------------------------------------------------

/**
 * 为什么非要有这把锁：
 *   `writeJsonAtomic` 保证的是「文件不会撕裂」，**不是**「更新不会丢」。
 *   两个宿主（比如 Claude Code 和 Cursor 同时开着 nexi）读同一份 orders.json 时，
 *   两边都读到 5 单，各自加 1 单再 rename，后写的那个把先写的整份覆盖掉。
 *
 *   实测（3 进程 × 5 单）：账本只剩 5 单、销售流水 2 条 —— 用户付了钱，订单凭空消失。
 *   这不是理论风险，是本机多宿主、以及同一台机器上开两个终端时的日常。
 *
 * 锁的做法：<file>.lock 用 O_EXCL 原子创建（`wx`），拿到才干活，干完删掉。
 *   · 同步等待：业务代码是同步读-改-写，所以这里用 Atomics.wait 阻塞，不引入 async 传染；
 *   · 陈旧锁：持锁进程崩了不会删锁，靠 mtime 超过 staleMs 直接抢（宁可误抢，也不能永久锁死）；
 *   · 超时：等不到就如实返回失败，让上层告诉用户「账本正被另一个进程写」，绝不硬写。
 */
export const LOCK_TIMEOUT_MS = 8000;
export const LOCK_STALE_MS = 15000;
const LOCK_RETRY_MIN_MS = 8;
const LOCK_RETRY_JITTER_MS = 22;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 极少数运行时禁用 SharedArrayBuffer：退化成忙等（时间很短，能接受）
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * 给某个文件加跨进程锁。
 * @returns {{ ok:true, release:Function } | { ok:false, reason:string }}
 */
export function acquireFileLock(file, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastLockError = 'EEXIST';
  // 第一次写入时 market/ 目录还不存在 —— 锁文件比它要保护的文件先到位，得自己把目录建出来
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch { /* 建不出来让下面的 open 报具体原因 */ }
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          // Windows 上刚 close 的句柄可能还占着，rm 偶发 EPERM。
          // 删不掉会让下一个进程一直等到 TTL（15 秒）—— 所以这里多试几次。
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              fs.rmSync(lock, { force: true });
              return;
            } catch {
              sleepSync(4 + attempt * 6);
            }
          }
        },
      };
    } catch (err) {
      // EEXIST = 锁在别人手里；EPERM / EACCES 在 Windows 上是「对方刚释放，
      // 句柄还处在 delete-pending」，本质上也是「现在拿不到，等一会儿就好」。
      // 以前把 EPERM 当致命错误直接返回 ok:false，于是并发下偶发少写一两条 ——
      // 子进程静默跳过，用户看到的是「我明明下了 18 单，账本只有 16 单」。
      const transient = err && (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!transient) {
        return { ok: false, reason: `账本加锁失败：${err && err.message ? err.message : String(err)}` };
      }
      lastLockError = err && err.code ? err.code : 'EEXIST';
      // 锁在那儿：先看是不是崩溃留下的陈旧锁
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // 刚好被别人删掉了，立刻重试
      }
      if (age > staleMs) {
        try { fs.rmSync(lock, { force: true }); } catch { /* 抢不到就下一轮 */ }
        continue;
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: `账本正被另一个进程写入（${path.basename(lock)} 还在，最后一次错误 ${lastLockError}），`
            + `等了 ${Math.round(Math.max(0, timeoutMs))}ms 仍没拿到；稍等一两秒重试即可`,
        };
      }
      sleepSync(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS));
    }
  }
}

/**
 * 在锁里跑 fn。fn 抛错也一定释放锁。
 * @template T
 * @param {string} file 被保护的文件
 * @param {() => T} fn
 * @returns {T | { ok:false, reason:string }}
 */
export function withFileLock(file, fn) {
  const got = acquireFileLock(file);
  if (!got.ok) return { ok: false, reason: got.reason };
  try {
    return fn();
  } finally {
    got.release();
  }
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

function readDocFile(file, normalize, nowMs, label, sealKey = null) {
  const warnings = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      warnings.push(`${label}读不了：${err.message || err}`);
    }
    return { ok: true, doc: normalize({}, nowMs), recovered: false, warnings, integrity: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const corruptPath = parkCorruptFile(file, nowMs, warnings);
    return { ok: true, doc: normalize({}, nowMs), recovered: true, corruptPath, warnings, integrity: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const corruptPath = parkCorruptFile(file, nowMs, warnings);
    return { ok: true, doc: normalize({}, nowMs), recovered: true, corruptPath, warnings, integrity: null };
  }
  // 第三参数把"有行认不出来"这类问题带上来 —— 静默丢记录是最难查的一类事故
  const doc = normalize(parsed, nowMs, warnings);
  // 封印校验放在归一化之后：写盘时盖的是归一化后的文档，这里必须对同一形状重算
  const integrity = verifyDocSeal(doc, sealKey);
  if (integrity.status === SEAL_STATUS.TAMPERED) {
    warnings.push(`${label}${integrity.reason}；本地购买凭据本轮不采信（签名授权仍按验签结果认）`);
  } else if (integrity.status === SEAL_STATUS.UNPROTECTED) {
    warnings.push(`${label}${integrity.reason}`);
  }
  return { ok: true, doc, recovered: false, warnings, integrity };
}

// ---------------------------------------------------------------------------
// 对外：直接按 root 读写（不需要先建 store）
// ---------------------------------------------------------------------------

/** 读订单：文件不存在 → 空账本；文件坏了 → 归档 + 空账本，永不抛错 */
export function readOrders(root, { now, sealKey = null } = {}) {
  return readDocFile(ordersPath(root), normalizeOrders, clockOf(now), '订单文件', sealKey);
}

/** 读分账账本（含已购皮肤） */
export function readLedger(root, { now, sealKey = null } = {}) {
  return readDocFile(ledgerPath(root), normalizeLedger, clockOf(now), '分账账本', sealKey);
}

/** 写订单（原子写；写前归一化，脏字段进不了文件） */
export function writeOrders(root, doc, { now, sealKey = null } = {}) {
  return writeJsonAtomic(ordersPath(root), sealDoc(normalizeOrders(doc, clockOf(now)), sealKey));
}

/** 写分账账本（原子写） */
export function writeLedger(root, doc, { now, sealKey = null } = {}) {
  return writeJsonAtomic(ledgerPath(root), sealDoc(normalizeLedger(doc, clockOf(now)), sealKey));
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

  // 封印密钥懒加载：只在真的读账本时才碰文件系统，也不让 createMarketStore 因为有/没有密钥而失败
  const sealKeyFile = path.join(dir, SEAL_KEY_FILE);
  let sealKeyCache;
  const sealKey = () => {
    if (sealKeyCache === undefined) sealKeyCache = loadSealKey(sealKeyFile, warnings);
    return sealKeyCache;
  };

  const remember = (result) => {
    for (const line of result && Array.isArray(result.warnings) ? result.warnings : []) {
      if (!warnings.includes(line)) warnings.push(line);
    }
    return result;
  };

  /**
   * 读 → 改 → 写，全程持锁。
   * 锁必须包住**读**，只锁写等于没锁（两个进程都会读到旧值）。
   */
  const updateFile = (file, normalize, mutator, label) => withFileLock(file, () => {
    const read = remember(readDocFile(file, normalize, clock(), label, sealKey()));
    let next;
    try {
      next = mutator(read.doc) || read.doc;
    } catch (err) {
      return { ok: false, reason: `更新${label}时出错：${err && err.message ? err.message : String(err)}` };
    }
    const normalizedWarnings = [];
    const normalized = normalize(next, clock(), normalizedWarnings);
    normalized.updatedAt = isoOf(clock());
    const wrote = writeJsonAtomic(file, sealDoc(normalized, sealKey()));
    if (!wrote.ok) return { ok: false, reason: wrote.reason, doc: read.doc };
    const allWarnings = [...(read.warnings || []), ...normalizedWarnings];
    for (const line of allWarnings) remember({ warnings: [line] });
    return {
      ok: true,
      doc: normalized,
      recovered: read.recovered,
      warnings: allWarnings,
      integrity: read.integrity,
    };
  });

  return {
    ok: true,
    root: base,
    dir,
    ordersFile,
    ledgerFile,
    now: () => clock(),
    warnings: () => warnings.slice(),
    location: () => ({ root: base, dir, ordersFile, ledgerFile }),
    readOrders: () => remember(readOrders(base, { now: clock(), sealKey: sealKey() })),
    writeOrders: (doc) => withFileLock(ordersFile, () => writeOrders(base, doc, { now: clock(), sealKey: sealKey() })),
    updateOrders: (mutator) => updateFile(ordersFile, normalizeOrders, mutator, '订单'),
    readLedger: () => remember(readLedger(base, { now: clock(), sealKey: sealKey() })),
    writeLedger: (doc) => withFileLock(ledgerFile, () => writeLedger(base, doc, { now: clock(), sealKey: sealKey() })),
    updateLedger: (mutator) => updateFile(ledgerFile, normalizeLedger, mutator, '分账账本'),
    /** 封印密钥文件路径（诊断/迁移工具用；业务层不该用） */
    sealKeyFile,
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
