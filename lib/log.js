// SPDX-License-Identifier: Apache-2.0
/**
 * 结构化运行日志 —— 排障时不用再让用户"把终端里那一坨复制给我"。
 *
 * 落点：`$DSH_HOME/agentdeck-super/logs/nexi-YYYYMMDD.log`（一行一个 JSON）
 *   · 按天分文件，单文件 5 MB 上限，超了轮转成 `.1`；保留 7 天。
 *   · 写失败一律吞掉（磁盘满、只读、权限）—— 日志坏了不能把主流程带崩。
 *   · `NEXI_LOG=0` 关掉；`NEXI_LOG_DIR` 换目录（测试就是这么隔离的）。
 *
 * 为什么是 JSONL 而不是人类可读的文本：
 *   排障要的是"哪一步、多久、什么错"。JSONL 能直接 grep / jq / 贴进 issue，
 *   而 nexi logs 自己会把它渲染成人话 —— 两种读者都不亏。
 */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { stateRoot } from './connect/platform.js';

export const MAX_BYTES = 5 * 1024 * 1024;
export const KEEP_DAYS = 7;

function envOf(env) {
  return env || process.env;
}

/** 日志总开关。默认开（本地文件，不联网）；显式 0/off/false 才关。 */
export function loggingEnabled(env = process.env) {
  const v = String(env.NEXI_LOG ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function logsDir(env = process.env) {
  const custom = String(env.NEXI_LOG_DIR || '').trim();
  return custom || join(stateRoot(), 'logs');
}

/** 当天文件名：nexi-20261110.log（用本地时间，跟用户看日历一致）。 */
export function dayStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

export function logFileFor(day = dayStamp(), env = process.env) {
  return join(logsDir(env), `nexi-${day}.log`);
}

let prunedThisProcess = false;

/** 清掉超过保留期的日志（每个进程只做一次，别在热路径上反复扫目录）。 */
function pruneOnce(dir, env) {
  if (prunedThisProcess) return;
  prunedThisProcess = true;
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of readdirSync(dir)) {
      if (!/^nexi-\d{8}\.log(\.1)?$/.test(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch { /* 单个文件删不掉不影响别的 */ }
    }
  } catch { /* 目录还不存在等情况，忽略 */ }
}

/**
 * 写一条日志。
 * @param {'info'|'warn'|'error'} level
 * @param {string} event 事件名（cli / mcp / install / host …）
 * @param {object} data 附加字段（会自动裁掉超长值）
 */
export function logEvent(level, event, data = {}, opts = {}) {
  const env = envOf(opts.env);
  if (!loggingEnabled(env)) return null;
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
    ...trimData(data),
  };
  try {
    const dir = logsDir(env);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = logFileFor(dayStamp(), env);
    // 轮转：只保留上一份 .1，日志是排障用的，不是档案
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch { /* 轮转失败就继续往原文件追加，不阻断 */ }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    pruneOnce(dir, env);
    return entry;
  } catch {
    return null;
  }
}

/** 超长字段截断：命令行里可能带整段 JSON、token、路径，日志不该把它们全存下来。 */
function trimData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined) continue;
    if (typeof v === 'string') {
      // 看起来像密钥的，只留长度
      if (/token|secret|sha256|password/i.test(k)) {
        out[k] = v ? `[${v.length} 字符]` : '';
        continue;
      }
      out[k] = v.length > 300 ? `${v.slice(0, 300)}…（共 ${v.length} 字符）` : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 读最后 N 条（跨天时按文件名倒序拼）。 */
export function readTail({ lines = 30, env = process.env, day } = {}) {
  const dir = logsDir(env);
  if (!existsSync(dir)) return { dir, files: [], entries: [] };
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /^nexi-\d{8}\.log$/.test(n)).sort();
  } catch {
    return { dir, files: [], entries: [] };
  }
  if (day) names = names.filter((n) => n.includes(day));
  const entries = [];
  for (const name of names.slice(-3)) {
    let text = '';
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* 半截行（进程被杀）直接跳过 */ }
    }
  }
  return { dir, files: names, entries: entries.slice(-Math.max(1, lines)) };
}

/** `nexi logs --clear`：删掉所有日志文件。 */
export function clearLogs(env = process.env) {
  const dir = logsDir(env);
  if (!existsSync(dir)) return { dir, removed: 0 };
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!/^nexi-\d{8}\.log(\.1)?$/.test(name)) continue;
    try { unlinkSync(join(dir, name)); removed += 1; } catch { /* 跳过锁住的 */ }
  }
  return { dir, removed };
}

/** 给人看的一行。 */
export function formatEntry(e) {
  const t = String(e.ts || '').replace('T', ' ').replace('Z', '');
  const parts = [`${t}`, String(e.level || 'info').toUpperCase().padEnd(5), String(e.event || '-').padEnd(12)];
  const rest = Object.entries(e)
    .filter(([k]) => !['ts', 'level', 'event', 'pid'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `${parts.join(' ')} ${rest}`.trimEnd();
}

export default { logEvent, readTail, clearLogs, logsDir, logFileFor, formatEntry, loggingEnabled };
