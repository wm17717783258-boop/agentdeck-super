/**
 * lib/policy/audit.js —— 本地审计流（<root>/audit.jsonl）的读写小仓库
 *
 * 为什么要有这个文件？
 *   任务板事件（state.json 里的 events）是仓库里唯一"真的会持久化"的事件流，但它只在
 *   board.appendEvent / 宿主 emit 时才有内容；工具调用本身目前没有任何落盘记录（grep 过，
 *   没有 events.jsonl，也没有 tool_call 生产者）。所以审计工具要能干活，得有一个自己的
 *   追加式文件：宿主接线时把「工具名 / 动作 / 结果 / 耗时」写进来，deck_audit 就能 tail/query/export。
 *
 * 这个文件只负责最底层的 JSONL 追加和读取，不做过滤、不做展示；过滤留给 deck_audit。
 * 所有函数都吞异常：审计坏了不能反过来把宿主弄挂。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 审计流文件名（相对 root）。 */
export const AUDIT_FILE = 'audit.jsonl';

/** 单次最多回读多少行，防止有人把审计文件养成几个 G 把内存吃光。 */
const MAX_READ_LINES = 10_000;

/** 审计流绝对路径；root 缺失时退回当前目录（和 policy.json 保持同一套习惯）。 */
export function auditFile(root) {
  return join(String(root || process.cwd()), AUDIT_FILE);
}

/** 时间统一成 ISO 字符串：人看得懂，排序也稳定；解析不了就留空，交给上层忽略。 */
export function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const text = String(value).trim();
  if (!text) return '';
  const ms = Date.parse(text);
  if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  return '';
}

function pickText(value, max = 400) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把任意来源（本地审计行 / 任务板事件 / 宿主 emit 的 payload）归一成同一形状。
 * 只挑白名单字段，绝不整段展开 raw —— 免得把 token/密钥原样带进审计和回复。
 */
export function normalizeAuditRecord(raw = {}, source = 'audit') {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const payload = obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload) ? obj.payload : {};
  const ts = normalizeTimestamp(obj.ts ?? obj.at ?? obj.time ?? obj.timestamp);
  const tool = pickText(obj.tool ?? obj.toolName ?? payload.tool ?? payload.toolName ?? '', 120).trim();
  const action = pickText(obj.action ?? obj.toolAction ?? payload.action ?? payload.toolAction ?? '', 120).trim();
  const kind = pickText(obj.kind ?? obj.type ?? payload.kind ?? payload.type ?? '', 120).trim();

  let result = pickText(obj.result ?? obj.outcome ?? payload.result ?? payload.outcome ?? '', 40).trim().toLowerCase();
  if (!result) {
    if (payload.effect) result = pickText(payload.effect, 40).trim().toLowerCase();
    else if (typeof payload.ok === 'boolean') result = payload.ok ? 'ok' : 'failed';
    else if (typeof obj.ok === 'boolean') result = obj.ok ? 'ok' : 'failed';
  }
  if (!result && kind) {
    const k = kind.toLowerCase();
    if (k.includes('fail') || k.includes('error') || k.includes('deny')) result = 'failed';
    else if (k.includes('done') || k.includes('complete') || k.includes('allow') || k.includes('ok')) result = 'ok';
  }
  if (!result) result = 'unknown';

  const teamId = pickText(obj.teamId ?? payload.teamId ?? '', 64).trim();
  const seq = Number.isFinite(Number(obj.seq)) ? Number(obj.seq) : null;
  const text = pickText(obj.text ?? obj.title ?? payload.text ?? payload.title ?? payload.message ?? '', 400);
  const cost = Number(obj.cost ?? payload.cost);
  const durationMs = Number(obj.durationMs ?? obj.ms ?? payload.durationMs ?? payload.ms);

  const record = {
    ts,
    tool,
    action,
    result,
    kind,
    text,
    source: pickText(source, 40),
  };
  if (teamId) record.teamId = teamId;
  if (seq !== null) record.seq = seq;
  if (Number.isFinite(cost) && cost > 0) record.cost = cost;
  if (Number.isFinite(durationMs) && durationMs >= 0) record.durationMs = Math.round(durationMs);
  const summary = pickText(obj.summary ?? payload.summary ?? '', 200).trim();
  if (summary) record.summary = summary;
  return record;
}

/**
 * 追加一条审计记录。返回 { ok, file, record } 或 { ok:false, file, error }，不 throw。
 * 落盘失败只影响审计，不影响工具本身的返回值 —— 调用方不该因为审计写不进去就失败。
 */
export function appendAudit(root, record = {}) {
  const file = auditFile(root);
  const normalized = normalizeAuditRecord(
    { ...record, ts: record?.ts ?? new Date().toISOString() },
    record?.source || 'audit',
  );
  try {
    mkdirSync(String(root || process.cwd()), { recursive: true });
    appendFileSync(file, `${JSON.stringify(normalized)}\n`, 'utf8');
    return { ok: true, file, record: normalized };
  } catch (err) {
    return { ok: false, file, error: String(err && err.message ? err.message : err), record: normalized };
  }
}

/**
 * 读审计流（按文件顺序，旧 → 新）。缺文件不算错（missing:true），坏行跳过并计数。
 * limit 取最后 N 行：tail 场景只关心最新的，别把几万行全读进内存。
 */
export function readAudit(root, options = {}) {
  const file = auditFile(root);
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : MAX_READ_LINES;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, file, missing: true, records: [], skipped: 0 };
    return { ok: false, file, missing: false, records: [], skipped: 0, error: String(err && err.message ? err.message : err) };
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const picked = lines.length > limit ? lines.slice(-limit) : lines;
  const records = [];
  let skipped = 0;
  for (const line of picked) {
    try {
      const raw = JSON.parse(line);
      if (!raw || typeof raw !== 'object') {
        skipped += 1;
        continue;
      }
      records.push(normalizeAuditRecord(raw, raw.source || 'audit'));
    } catch {
      skipped += 1;
    }
  }
  return { ok: true, file, missing: false, records, skipped, totalLines: lines.length };
}

export default { AUDIT_FILE, appendAudit, auditFile, normalizeAuditRecord, normalizeTimestamp, readAudit };
