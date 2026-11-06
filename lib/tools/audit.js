/**
 * lib/tools/audit.js —— `deck_audit` 工具（看审计流 / 按条件查 / 导出 JSONL）
 *
 * 审计数据从哪来（老实说，不编路径）：
 *   1) 任务板事件流：仓库里唯一"真的会持久化"的事件流（state.json 里的 events），
 *      通过 board.listTeams() + board.listEvents(teamId) 读；宿主 emit 出来的事件也在里面。
 *   2) 本地审计流：<root>/audit.jsonl，追加式 JSONL。仓库原先没有这个文件，是本次新增的
 *      写入口（lib/policy/audit.js）；宿主接线时把「工具/动作/结果/耗时」append 进去即可。
 *   两条来源都没有时，工具明确返回"没有审计来源"，不会假装读到了 events.jsonl。
 *
 * 边界：工具调用本身目前不会被宿主自动记账（grep 过：没有 tool_call 事件生产者）。
 * 所以 deck_audit 只能展示"已经有人写进去"的记录；要不要让每次工具调用都落审计，
 * 需要宿主在 lib/index.js 统一接线（不是本文件的范围）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDeps, safeExecute, workspaceRoot, emitSafe, callBoard, clipText, TOOL_OUTPUT } from './common.js';
import { readAudit, normalizeAuditRecord } from '../policy/audit.js';
import { matchGlob, redact } from '../policy/engine.js';

const ACTIONS = ['tail', 'query', 'export'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

function normalizeAction(value) {
  const action = String(value || 'tail').trim().toLowerCase();
  if (action === 'list' || action === 'recent') return 'tail';
  return ACTIONS.includes(action) ? action : '';
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

/** 时间参数：支持毫秒时间戳或 ISO/日期串；看不懂就标 invalid 让上层提示（不静默当成 0）。 */
function parseTime(value) {
  if (value === undefined || value === null || value === '') return { ms: null, raw: '' };
  if (typeof value === 'number' && Number.isFinite(value)) return { ms: value, raw: String(value) };
  const text = String(value).trim();
  if (!text) return { ms: null, raw: '' };
  if (/^\d+$/.test(text)) return { ms: Number(text), raw: text };
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return { ms, raw: text };
  return { ms: null, raw: text, invalid: true };
}

function fmtTime(ts) {
  if (!ts) return '(无时间)';
  return String(ts).replace('T', ' ').replace(/\.\d+Z$/, '').slice(0, 19);
}

/** 一条记录压成一行；展示前先脱敏（审计里也可能混进密钥，别原样打出来）。 */
function recordLine(record, index) {
  const who = record.tool ? `${record.tool}${record.action ? `/${record.action}` : ''}` : record.kind || '事件';
  const text = redact(String(record.text || record.summary || ''));
  return `${index + 1}. ${fmtTime(record.ts)}  [${who}] ${record.result}${text ? ` ｜ ${clipText(text, 140)}` : ''}`;
}

/**
 * 汇总两个来源。返回 { records, sources, warnings }；任何一路失败都只降级、不抛错。
 */
async function collectRecords(d, root, args = {}) {
  const records = [];
  const sources = [];
  const warnings = [];

  const local = readAudit(root);
  if (!local.ok) {
    warnings.push(`本地审计流读取失败：${local.error}`);
  } else if (local.missing) {
    warnings.push(`本地审计流还没有内容（${local.file} 不存在）`);
  } else {
    records.push(...local.records);
    sources.push(`本地审计流 ${local.file}（${local.records.length} 条）`);
    if (local.skipped > 0) warnings.push(`本地审计流有 ${local.skipped} 行坏行，已跳过`);
  }

  if (d.board) {
    let teamIds = [];
    if (args.teamId) {
      teamIds = [String(args.teamId)];
    } else {
      const teams = await callBoard(d, 'listTeams');
      if (Array.isArray(teams)) teamIds = teams.map((t) => String(t?.id ?? '')).filter(Boolean);
      else warnings.push('任务板 listTeams() 没返回数组，读不到小组事件流');
    }
    let eventCount = 0;
    for (const teamId of teamIds) {
      const events = await callBoard(d, 'listEvents', teamId, 0);
      if (!Array.isArray(events)) {
        warnings.push(`小组 ${teamId} 的事件读取失败`);
        continue;
      }
      eventCount += events.length;
      for (const evt of events) {
        records.push(normalizeAuditRecord({
          ts: evt?.ts,
          kind: evt?.kind,
          text: evt?.text,
          payload: evt?.payload,
          teamId: evt?.teamId || teamId,
          seq: evt?.seq,
        }, 'board'));
      }
    }
    if (eventCount > 0) sources.push(`任务板事件流（${teamIds.length} 个小组，${eventCount} 条）`);
    else if (teamIds.length > 0) warnings.push('任务板里还没有事件');
  } else {
    warnings.push('宿主没有注入任务板服务（deps.board 缺失），只读本地审计流');
  }

  // 同一来源的完全重复记录去重（例如工具重复 append），不同来源保留（来源本身就是信息）。
  const seen = new Set();
  const merged = [];
  for (const record of records) {
    const key = [record.source, record.ts, record.teamId || '', record.seq ?? '', record.kind, record.tool, record.action, record.result, record.text].join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  merged.sort((a, b) => {
    const am = Date.parse(a.ts);
    const bm = Date.parse(b.ts);
    const delta = (Number.isFinite(am) ? am : 0) - (Number.isFinite(bm) ? bm : 0);
    if (delta !== 0) return delta;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });
  return { records: merged, sources, warnings };
}

/** 按 tool / result / kind / teamId / 时间段过滤；看不懂的时间参数降级为忽略并提示。 */
function filterRecords(records, args = {}) {
  const warnings = [];
  const tool = String(args.tool || '').trim();
  const result = String(args.result || '').trim().toLowerCase();
  const kind = String(args.kind || '').trim().toLowerCase();
  const teamId = String(args.teamId || '').trim();
  const since = parseTime(args.since);
  const until = parseTime(args.until);
  if (since.invalid) warnings.push(`since 看不懂（${since.raw}），已忽略该过滤条件`);
  if (until.invalid) warnings.push(`until 看不懂（${until.raw}），已忽略该过滤条件`);

  const filtered = records.filter((record) => {
    if (tool && !matchGlob(tool, record.tool)) return false;
    if (result && String(record.result || '').toLowerCase() !== result) return false;
    if (kind && !String(record.kind || '').toLowerCase().includes(kind)) return false;
    if (teamId && String(record.teamId || '') !== teamId) return false;
    const ms = Date.parse(record.ts);
    if (since.ms !== null && !(Number.isFinite(ms) && ms >= since.ms)) return false;
    if (until.ms !== null && !(Number.isFinite(ms) && ms <= until.ms)) return false;
    return true;
  });
  return { records: filtered, warnings };
}

function filterSummary(args = {}) {
  const bits = [];
  if (args.tool) bits.push(`tool=${args.tool}`);
  if (args.result) bits.push(`result=${args.result}`);
  if (args.kind) bits.push(`kind=${args.kind}`);
  if (args.teamId) bits.push(`teamId=${args.teamId}`);
  if (args.since) bits.push(`since=${args.since}`);
  if (args.until) bits.push(`until=${args.until}`);
  return bits.length ? bits.join('，') : '无（全部）';
}

/** 导出文件名：带毫秒时间戳；已存在就加 -2/-3，绝不覆盖别人的导出。 */
function exportFileOf(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let file = join(String(root || process.cwd()), `audit-export-${stamp}.jsonl`);
  let n = 2;
  while (existsSync(file)) {
    file = join(String(root || process.cwd()), `audit-export-${stamp}-${n}.jsonl`);
    n += 1;
  }
  return file;
}

export function createAuditTool(deps) {
  const d = normalizeDeps(deps);
  const rootOf = () => {
    try {
      if (d.root) return String(d.root());
    } catch {
      // root 句柄坏了就走工作区兜底。
    }
    return String(workspaceRoot(d));
  };

  return {
    name: 'deck_audit',
    description: [
      '查看 agentdeck-super 的审计流：',
      'tail=最近 N 条（默认）；query=按 tool/result/kind/时间过滤；export=把筛选结果写成 <root>/audit-export-<时间戳>.jsonl 并返回路径与条数。',
      '数据来源只有两条，都是真的：任务板事件流（state.json 里的 events）+ 本地审计流 <root>/audit.jsonl。',
      '工具调用本身目前不会自动落审计（宿主还没有 tool_call 记账点）；要让每次调用都进审计，需宿主接线时 append 到本地审计流。',
      '本工具不会读环境变量里的密钥，展示前会对文本做脱敏。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'tail / query / export（默认 tail）' },
        limit: { type: 'number', description: `显示条数（默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}）` },
        teamId: { type: 'string', description: '只看某个小组（任务板事件按小组隔离；本地审计按记录里的 teamId 过滤）' },
        tool: { type: 'string', description: '按工具名过滤，支持 * 通配，例如 deck_*' },
        result: { type: 'string', description: '按结果过滤：allow / confirm / deny / ok / failed / unknown' },
        kind: { type: 'string', description: '按事件类型过滤（子串，例如 host / policy / fail）' },
        since: { type: 'string', description: '起始时间（ISO 字符串或毫秒时间戳）' },
        until: { type: 'string', description: '结束时间（ISO 字符串或毫秒时间戳）' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('deck_audit', async (args = {}) => {
      const root = rootOf();
      const action = normalizeAction(args.action);
      if (!action) return `【deck_audit】不认识的动作：${String(args.action)}。可用：${ACTIONS.join(' / ')}。`;

      const collected = await collectRecords(d, root, args);
      const filtered = filterRecords(collected.records, args);
      const warnings = [...collected.warnings, ...filtered.warnings];
      const sourcesLine = collected.sources.length ? `来源：${collected.sources.join('；')}` : '来源：没有可读的审计来源';
      const warnLines = warnings.length ? [`提示：${warnings.join('；')}`] : [];

      if (action === 'export') {
        const records = filtered.records;
        const file = exportFileOf(root);
        try {
          mkdirSync(String(root || process.cwd()), { recursive: true });
          const body = records.map((record) => JSON.stringify(record)).join('\n');
          writeFileSync(file, records.length ? `${body}\n` : '', { encoding: 'utf8', flag: 'wx' });
        } catch (err) {
          return [
            `【deck_audit】导出失败：${String(err && err.message ? err.message : err)}`,
            `目标文件：${file}`,
            sourcesLine,
            ...warnLines,
          ].join('\n');
        }
        const label = records.length === 0 ? '0 条（空文件已建，方便下游直接读）' : `${records.length} 条`;
        emitSafe(d, 'audit_export', { file, count: records.length });
        return [
          `【deck_audit】已导出 ${label}：${file}`,
          `筛选条件：${filterSummary(args)}`,
          sourcesLine,
          ...warnLines,
        ].join('\n');
      }

      const limit = clampLimit(args.limit);
      const total = collected.records.length;
      const matched = filtered.records;
      const shown = matched.slice(-limit);

      const header = action === 'tail'
        ? `【deck_audit】最近 ${shown.length} 条（筛选后 ${matched.length} 条 / 共 ${total} 条）`
        : `【deck_audit】匹配 ${matched.length} 条（共 ${total} 条，显示最近 ${shown.length} 条）`;
      const lines = [header];
      if (action === 'query') lines.push(`筛选条件：${filterSummary(args)}`);
      lines.push(sourcesLine);
      if (warnLines.length) lines.push(...warnLines);
      if (!shown.length) {
        lines.push(total === 0
          ? '没有记录。任务板里还没有事件，本地审计流也还没人写；这不是故障。'
          : '这一次筛选没有命中任何记录；把过滤条件放宽再试。');
      } else {
        shown.forEach((record, index) => lines.push(recordLine(record, index)));
        if (matched.length > shown.length) lines.push(`（还有 ${matched.length - shown.length} 条更早的匹配没显示；要看全量请用 export）`);
      }
      return lines.join('\n');
    }),
  };
}

export default { createAuditTool };
