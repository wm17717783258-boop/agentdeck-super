/**
 * lib/automation/schedule.js —— 定时规则的解析与「下次什么时候跑」
 *
 * 刻意只支持两种写法，够用、也好验证：
 *   1. `every: '30s' | '10m' | '2h' | '1d'` —— 周期任务（锚点 = 上次计划时间，不飘）
 *   2. `at: '2026-11-05T20:00:00+08:00'` —— 一次性任务（跑完自动失活）
 *
 * 不引 cron：cron 表达式对普通用户是天书，而且时区坑一堆；
 * 真需要复杂规则时，用 `at` 一条条排，反而看得见、可审计。
 *
 * 时间一律从注入的 now() 取，测试可复现；所有函数不 throw。
 */

import { newId } from './store.js';

/** 周期下限 1 秒（再快就是在刷盘），上限 30 天。 */
export const MIN_EVERY_MS = 1000;
export const MAX_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
/** 一次性任务的提前量上限（防止写错年份导致永远不触发）。 */
export const MAX_AT_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** 任务标题长度上限。 */
const MAX_TITLE_CHARS = 200;
/** 一次 tick 最多跑几个（防止积压时一次炸掉）。 */
export const MAX_PER_TICK = 5;

export const JOB_ACTIONS = ['task', 'agent'];

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/** `'30s'` / `'10m'` / `'2h'` / `'1d'` / 纯数字（毫秒）→ 毫秒；不认识给 null。 */
export function parseEvery(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!m) return null;
  const value = Number(m[1]) * UNIT_MS[m[2]];
  return Number.isFinite(value) ? value : null;
}

/** 毫秒 → 人话（'2 小时' / '30 秒' / '1.5 天'）。 */
export function describeEvery(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '（非法周期）';
  if (n % UNIT_MS.d === 0) return `${n / UNIT_MS.d} 天`;
  if (n % UNIT_MS.h === 0) return `${n / UNIT_MS.h} 小时`;
  if (n % UNIT_MS.m === 0) return `${n / UNIT_MS.m} 分钟`;
  if (n % UNIT_MS.s === 0) return `${n / UNIT_MS.s} 秒`;
  return `${(n / 1000).toFixed(1)} 秒`;
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * 把用户/模型给的参数整理成一条能落盘的 job。
 * 返回 { ok:true, job } 或 { ok:false, error }（error 是人话，直接能回给用户）。
 */
export function normalizeJob(input = {}, { now = () => Date.now() } = {}) {
  const at = Number(now());
  const title = str(input.title || input.name);
  if (!title) return { ok: false, error: '定时任务得有个标题（参数 title），不然到点了不知道要干嘛。' };
  if (title.length > MAX_TITLE_CHARS) return { ok: false, error: `标题太长了（上限 ${MAX_TITLE_CHARS} 字）。` };

  const everyMs = input.every == null ? null : parseEvery(input.every);
  const atRaw = str(input.at);
  if (everyMs == null && !atRaw) return { ok: false, error: '得给 `every`（周期，如 "30m"）或者 `at`（一次性时间，ISO 格式），二选一。' };
  if (input.every != null && everyMs == null) return { ok: false, error: `看不懂周期 "${input.every}"，用 30s / 10m / 2h / 1d 这种写法。` };
  if (everyMs != null && (everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS)) {
    return { ok: false, error: `周期得在 ${describeEvery(MIN_EVERY_MS)} ~ ${describeEvery(MAX_EVERY_MS)} 之间，收到的是 ${describeEvery(everyMs)}。` };
  }

  let firstAt = null;
  if (atRaw) {
    const ms = Date.parse(atRaw);
    if (!Number.isFinite(ms)) return { ok: false, error: `看不懂时间 "${atRaw}"，请用带时区的 ISO，例如 2026-11-05T20:00:00+08:00。` };
    if (ms - at > MAX_AT_AHEAD_MS) return { ok: false, error: '一次性任务最多排到一年以内（检查一下年份？）。' };
    firstAt = ms;
  }

  const action = str(input.action, 'task').toLowerCase();
  if (!JOB_ACTIONS.includes(action)) return { ok: false, error: `不认识的执行方式 "${action}"，只能 task（往任务板丢一条）或 agent（真的跑一次 Agent）。` };
  if (action === 'agent' && !str(input.prompt)) return { ok: false, error: 'action:"agent" 要带 prompt（到点让 Agent 干什么）。' };

  // 周期任务从"现在 + 一个周期"开始，避免刚建完就立刻跑一次（用户会以为出 bug）。
  const nextAt = firstAt != null ? firstAt : at + everyMs;

  const job = {
    id: str(input.id) || newId('job'),
    title,
    action,
    every: everyMs,
    at: firstAt != null ? new Date(firstAt).toISOString() : null,
    // 到点干什么
    acceptance: str(input.acceptance) || null,
    role: str(input.role, 'worker'),
    teamId: str(input.teamId) || null,
    prompt: str(input.prompt) || null,
    agent: str(input.agent) || null,
    // 审批：true 时到点只进审批队列，人点头才真干
    needsApproval: Boolean(input.needsApproval),
    enabled: input.enabled === false ? false : true,
    createdAt: new Date(at).toISOString(),
    nextAt: new Date(nextAt).toISOString(),
    lastRunAt: null,
    lastStatus: null,
    runCount: 0,
    maxRuns: Number.isFinite(Number(input.maxRuns)) && Number(input.maxRuns) > 0 ? Math.min(1000, Math.round(Number(input.maxRuns))) : null,
    source: str(input.source, 'user'),
  };
  return { ok: true, job };
}

/** 算下一次该跑的时间；一次性任务返回 null（跑完就退休）。 */
export function nextRunAt(job, nowMs) {
  if (!job) return null;
  if (job.at) return null; // 一次性
  const every = Number(job.every);
  if (!Number.isFinite(every) || every <= 0) return null;
  const base = Number.isFinite(Date.parse(job.nextAt)) ? Date.parse(job.nextAt) : Number(nowMs);
  // 锚点推进：跳过错过的格子，但绝不"补跑"一串（补跑= 半夜把机器打满）
  let next = base;
  while (next <= Number(nowMs)) next += every;
  return new Date(next).toISOString();
}

/** 有没有到点（未停用、没超次数）。 */
export function isDue(job, nowMs) {
  if (!job || job.enabled === false) return false;
  if (job.maxRuns != null && Number(job.runCount) >= Number(job.maxRuns)) return false;
  const due = Date.parse(job.nextAt);
  return Number.isFinite(due) && due <= Number(nowMs);
}

/** 取当前到点的任务（按时间先后，最多 limit 条）。 */
export function dueJobs(state, nowMs, limit = MAX_PER_TICK) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  return jobs
    .filter((j) => isDue(j, nowMs))
    .sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))
    .slice(0, Math.max(1, Number(limit) || MAX_PER_TICK));
}

/** 一条 job 的一句话描述（列表/状态页/CLI 共用）。 */
export function describeJob(job) {
  const when = job.at
    ? `一次性，${job.at}`
    : `${describeEvery(job.every)}一次，下次 ${job.nextAt}`;
  const what = job.action === 'agent' ? `跑 Agent：${String(job.prompt || '').slice(0, 60)}` : `丢任务到板子：${job.title}`;
  const flags = [
    job.needsApproval ? '要审批' : '',
    job.enabled === false ? '已停用' : '',
    job.maxRuns != null ? `最多 ${job.maxRuns} 次` : '',
    `已跑 ${job.runCount} 次`,
  ].filter(Boolean).join('｜');
  return `${job.id} — ${job.title}｜${when}｜${what}${flags ? `｜${flags}` : ''}`;
}

export default { parseEvery, describeEvery, normalizeJob, nextRunAt, isDue, dueJobs, describeJob, JOB_ACTIONS, MIN_EVERY_MS, MAX_EVERY_MS };
