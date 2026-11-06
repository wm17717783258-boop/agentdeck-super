/**
 * lib/team/audit.js —— 团队审计日志（append / 导出 / 保留期清理）
 *
 * 为什么单独一个文件：审计是团队空间里唯一「只增不改」的数据，
 * 它和业务状态必须解耦——就算 space.json 坏了，审计也不能丢；
 * 反过来，审计写失败也绝不能把加入团队/共享记忆这种正事搞挂。
 *
 * 存储：`<root>/team/audit.jsonl`，一行一条 JSON（追加写，不重写整个文件）。
 * 三个刻意设计：
 *   1. 每行自带 `ts`（ISO）和 `at`（epoch 毫秒）：人看得懂、代码比得快。
 *   2. `detail` 落盘前过一遍脱敏（token/secret/password/apiKey/authorization 一律打码），
 *      审计日志是最容易被导出/贴群里的东西，绝不能变成泄密渠道。
 *   3. 坏行不炸：读到半截 JSON 就跳过并计数（`skipped`），不因为一行坏了整份日志作废。
 *
 * 企业能力边界：SSO/SCIM/私有化部署**没做**，所以这里也没有"审计推送到 SIEM"之类的假接口。
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { teamDir } from './space.js';

export const AUDIT_FILE = 'audit.jsonl';

/** 单次导出的最大行数：导出是给人看的报表，不是数据库备份。 */
export const MAX_EXPORT_ROWS = 50_000;

/**
 * 脱敏字段名（小写比较，命中即替换）。
 * 故意放得很宽（连 licenseKey/apiKey 都算）：审计日志最容易被导出贴群里，
 * 宁可多打码一次，也不能漏出一个串——过脱敏的代价只是少一列信息。
 */
const SECRET_KEY_RE = /(token|secret|password|passwd|authorization|cookie|key)/i;

/** `<root>/team/audit.jsonl` */
export function auditPath(root) {
  return join(teamDir(root), AUDIT_FILE);
}

const str = (v) => (v == null ? '' : String(v)).trim();

function nowMs(now) {
  try {
    if (typeof now === 'function') return nowMs(now());
    if (now instanceof Date) return now.getTime();
    const n = Number(now);
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  } catch {
    return Date.now();
  }
}

const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

/**
 * 深度脱敏：对象/数组递归（最多 4 层，防环也防炸栈）。
 * 命中敏感键 → 值替换成 '[redacted]'；长字符串里的 `Bearer xxx` 也顺手打码。
 */
export function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return '[深度截断]';
  if (typeof value === 'string') {
    return value.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer [redacted]');
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 时间边界：接受 ISO 字符串 / epoch 毫秒 / Date，解析不出就当作"不限"。 */
function boundMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 追加一条审计。
 * @param {{ root:string, spaceId?:string, actorId?:string, action:string,
 *           detail?:any, now?:number|Date }} o
 * @returns {{ok:true, entry:object, path:string}|{ok:false, code:string, reason:string}}
 */
export function appendTeamAudit({ root, spaceId, actorId, action, detail, now } = {}) {
  const act = str(action);
  if (!act) return fail('bad_action', '审计动作不能为空');
  const t = nowMs(now);
  const entry = {
    ts: new Date(t).toISOString(),
    at: t,
    spaceId: str(spaceId) || '',
    actorId: str(actorId) || 'anonymous',
    action: act,
    detail: detail === undefined ? null : redact(detail),
  };
  try {
    mkdirSync(teamDir(root), { recursive: true });
    appendFileSync(auditPath(root), `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true, entry, path: auditPath(root) };
  } catch (err) {
    return fail('write_failed', `写审计失败：${err?.message || err}`);
  }
}

/**
 * 读审计（按时间升序，坏行跳过计数）。
 * @param {{ root:string, spaceId?:string, from?:any, to?:any }} o
 * @returns {{ok:true, entries:object[], total:number, skipped:number}
 *          |{ok:false, code:string, reason:string, entries:[], skipped:number}}
 */
export function readAudit({ root, spaceId, from, to } = {}) {
  const file = auditPath(root);
  if (!existsSync(file)) return { ok: true, entries: [], total: 0, skipped: 0 };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { ...fail('read_failed', `读审计失败：${err?.message || err}`), entries: [], skipped: 0 };
  }
  const wantSpace = str(spaceId);
  const tFrom = boundMs(from);
  const tTo = boundMs(to);
  const entries = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      skipped += 1;
      continue;
    }
    if (!rec || typeof rec !== 'object') {
      skipped += 1;
      continue;
    }
    if (wantSpace && str(rec.spaceId) !== wantSpace) continue;
    const at = Number.isFinite(Number(rec.at)) ? Number(rec.at) : Date.parse(String(rec.ts || ''));
    if (tFrom != null && !(at >= tFrom)) continue;
    if (tTo != null && !(at <= tTo)) continue;
    entries.push(rec);
  }
  entries.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  return { ok: true, entries, total: entries.length, skipped };
}

/** CSV 单元格转义：含逗号/引号/换行就整体加引号，内部引号翻倍。 */
function csvCell(v) {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 审计行 → CSV 文本（表头固定，导出报表可被 Excel 直接打开）。 */
export function toCsv(entries) {
  const header = 'ts,spaceId,actorId,action,detail';
  const rows = (Array.isArray(entries) ? entries : []).map((e) => [
    csvCell(e.ts),
    csvCell(e.spaceId),
    csvCell(e.actorId),
    csvCell(e.action),
    csvCell(e.detail),
  ].join(','));
  return [header, ...rows].join('\n');
}

/**
 * 导出审计到 `<root>/team/audit-export-<ts>.<ext>`。
 * 空结果：**返回 count:0 且不写文件**（`written:false`），不制造空壳文件。
 * @param {{ root:string, spaceId?:string, from?:any, to?:any, format?:'json'|'csv', now?:any }} o
 */
export function exportAudit({ root, spaceId, from, to, format, now } = {}) {
  const fmt = str(format).toLowerCase() === 'csv' ? 'csv' : 'json';
  const got = readAudit({ root, spaceId, from, to });
  if (!got.ok) return got;
  if (!got.entries.length) {
    return { ok: true, written: false, path: '', count: 0, format: fmt, skipped: got.skipped };
  }
  const rows = got.entries.slice(0, MAX_EXPORT_ROWS);
  const t = nowMs(now);
  const stamp = new Date(t).toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const file = join(teamDir(root), `audit-export-${stamp}.${fmt}`);
  const body = fmt === 'csv' ? `${toCsv(rows)}\n` : `${JSON.stringify({
    spaceId: str(spaceId) || rows[0]?.spaceId || '',
    exportedAt: new Date(t).toISOString(),
    count: rows.length,
    entries: rows,
  }, null, 2)}\n`;
  try {
    mkdirSync(teamDir(root), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
    return {
      ok: true, written: true, path: file, count: rows.length, format: fmt, skipped: got.skipped,
    };
  } catch (err) {
    return fail('write_failed', `写导出文件失败：${err?.message || err}`);
  }
}

/**
 * 保留期清理：删掉早于 `now - days` 的行，保留的原子写回。
 * @returns {{ok:true, removed:number, kept:number}|{ok:false, code:string, reason:string}}
 */
export function retentionSweep({ root, spaceId, days, now } = {}) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return fail('bad_days', `保留天数必须 > 0，收到 "${days ?? ''}"`);
  const file = auditPath(root);
  if (!existsSync(file)) return { ok: true, removed: 0, kept: 0 };
  const cutoff = nowMs(now) - d * 86400_000;
  const wantSpace = str(spaceId);

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return fail('read_failed', `读审计失败：${err?.message || err}`);
  }

  const keep = [];
  let removed = 0;
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      skipped += 1;
      continue;
    }
    const at = Number.isFinite(Number(rec?.at)) ? Number(rec.at) : Date.parse(String(rec?.ts || ''));
    // 只清理指定空间的；别的空间（或多空间混写）的行一律保留
    const sameSpace = !wantSpace || str(rec?.spaceId) === wantSpace;
    if (sameSpace && Number.isFinite(at) && at < cutoff) {
      removed += 1;
      continue;
    }
    keep.push(JSON.stringify(rec));
  }

  // 一条都没删就完全不动文件（避免无意义的重写和 mtime 抖动）
  if (removed === 0) return { ok: true, removed: 0, kept: keep.length, skipped };

  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, file);
    return { ok: true, removed, kept: keep.length, skipped };
  } catch (err) {
    return fail('write_failed', `清理审计失败：${err?.message || err}`);
  }
}

/** 审计概况（工具 status 用）。 */
export function auditStats({ root, spaceId } = {}) {
  const got = readAudit({ root, spaceId });
  if (!got.ok) return { ok: false, code: got.code, reason: got.reason, total: 0, lastAt: '', skipped: got.skipped };
  const last = got.entries[got.entries.length - 1];
  const byAction = {};
  for (const e of got.entries) byAction[e.action] = (byAction[e.action] || 0) + 1;
  return {
    ok: true,
    total: got.entries.length,
    skipped: got.skipped,
    lastAt: last ? last.ts : '',
    byAction,
    path: auditPath(root),
  };
}

export default {
  AUDIT_FILE,
  auditPath,
  redact,
  appendTeamAudit,
  readAudit,
  toCsv,
  exportAudit,
  retentionSweep,
  auditStats,
};
