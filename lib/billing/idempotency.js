/**
 * lib/billing/idempotency.js —— webhook 幂等账本（同一 event.id 只处理一次）
 *
 * 为什么必须落盘而不是放内存：
 * - 支付平台的重试是**跨进程**的：进程重启、插件重载、宿主崩溃后重投都算新进程，
 *   内存 Set 一重启就忘，结果就是重复发货 / 重复加额度。
 * - 账本要能被人看懂、被工具修：所以是普通 JSON，不是二进制。
 *
 * 为什么自己写临时文件再 rename：
 * - 「写一半断电」会留下半截 JSON，下次启动解析失败 = 把已处理的订单当没处理 = 重复发货。
 *   同一目录下写 <file>.<pid>.<rand>.tmp 再 rename 是原子的（NTFS/POSIX 都保证），
 *   最坏情况是留下一个孤儿 .tmp，账本本身永远是完整 JSON。
 *
 * 只记录"去重所需的最小事实"（事件 id / 类型 / 订单号 / 金额 / 时间）：
 * **绝不落盘原始 webhook body、绝不落盘任何密钥**——body 里有用户信息，密钥更是不能出内存。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const EVENTS_FILE_VERSION = 1;
export const DEFAULT_EVENT_LIMIT = 5000;

/**
 * 状态根目录：显式传入 > $DSH_HOME > ~/.dsh。
 * 跟 lib/engine/board.js 的约定一致（隔离档用 DSH_HOME 各用各的状态）。
 */
export function billingRoot(root) {
  if (root) return path.resolve(String(root));
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.resolve(home);
}

/** 幂等账本的默认路径：<root>/billing/events.json。 */
export function eventsFile(root) {
  return path.join(billingRoot(root), 'billing', 'events.json');
}

/** 只允许白名单字段进账本：调用方塞进来的 raw body / headers 一律过滤掉。 */
function sanitizeMeta(meta = {}) {
  const out = {};
  const id = meta.eventId ?? meta.id;
  if (id != null) out.id = String(id);
  if (meta.type != null) out.type = String(meta.type).slice(0, 120);
  if (meta.orderId != null) out.orderId = String(meta.orderId).slice(0, 200);
  if (Number.isInteger(meta.amount)) out.amount = meta.amount;
  return out;
}

/** 原子写：同目录临时文件 + rename。 */
function atomicWriteJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * 创建幂等账本。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 状态根目录（默认 $DSH_HOME）
 * @param {string} [opts.file] 直接指定账本文件（测试/迁移用）
 * @param {number} [opts.limit] 账本最多保留多少条（默认 5000，防止无限增长）
 * @param {() => number} [opts.now] 时间源（默认 Date.now，测试可注入）
 */
export function createEventStore(opts = {}) {
  const file = opts.file ? path.resolve(String(opts.file)) : eventsFile(opts.root);
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_EVENT_LIMIT;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** @type {Map<string, {id: string, at: string, type?: string, orderId?: string, amount?: number}>} */
  let entries = new Map();
  let loadError = '';

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed?.events) ? parsed.events : [];
    for (const item of list) {
      if (item && item.id != null) entries.set(String(item.id), { ...item, id: String(item.id) });
    }
  } catch (err) {
    // 文件不存在 = 全新账本；文件坏了 = 当空账本（宁可重放一次也不让支付流程起不来），但要留痕
    if (err && err.code !== 'ENOENT') loadError = String(err.message || err);
    entries = new Map();
  }

  function persist() {
    const list = [...entries.values()];
    const kept = list.length > limit ? list.slice(list.length - limit) : list;
    atomicWriteJson(file, { version: EVENTS_FILE_VERSION, updatedAt: new Date(now()).toISOString(), events: kept });
  }

  return {
    file,
    loadError,
    get size() {
      return entries.size;
    },
    has(eventId) {
      return entries.has(String(eventId));
    },
    get(eventId) {
      return entries.get(String(eventId)) || null;
    },
    list() {
      return [...entries.values()];
    },
    /**
     * 认领一个事件：第一次返回 {ok:true, duplicate:false}，重复投递返回 {ok:true, duplicate:true}。
     * 这是"只处理一次"的闸门——调用方拿到 duplicate:true 就必须跳过发货。
     */
    claim(eventId, meta = {}) {
      const key = String(eventId ?? '');
      if (!key) return { ok: false, reason: '缺少事件 id', duplicate: false };
      const existing = entries.get(key);
      if (existing) return { ok: true, duplicate: true, entry: existing };
      const entry = { ...sanitizeMeta(meta), id: key, at: new Date(now()).toISOString() };
      entries.set(key, entry);
      persist();
      return { ok: true, duplicate: false, entry };
    },
  };
}
