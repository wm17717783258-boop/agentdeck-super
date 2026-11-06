/**
 * lib/automation/store.js —— 自动化的状态文件（定时任务 / 审批队列 / 执行记录 / 全局停止开关）
 *
 * 为什么单独一个文件而不是塞进任务板：
 *   任务板是「人派给 Agent 的活」，自动化是「到点自己动的触发器」；
 *   两套账混在一起，`nexi stop` 就没法只停住"自己动"的那一半。
 *
 * 落盘位置：`<工作区>/.agentdeck/automation/state.json`
 *   - 跟任务板（boardRoot）分开：任务板可能在共享盘上，自动化状态是本机行为；
 *   - 原子写（先写 .tmp 再 rename）：宿主可能同时被 CLI 和自己读到，
 *     读到半个 JSON 会直接把定时任务搞丢。
 *
 * 底线：任何读写失败都不 throw，只返回空状态 + 一句原因，调用方负责降级。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 状态版本：将来加字段时靠它做迁移，别直接改结构。 */
export const STATE_VERSION = 1;
/** 执行记录最多留多少条（防止文件无限长）。 */
export const MAX_RUNS = 200;
/** 审批队列最多留多少条。 */
export const MAX_APPROVALS = 100;

export function automationDir(root) {
  return join(String(root || process.cwd()), '.agentdeck', 'automation');
}

export function stateFile(root) {
  return join(automationDir(root), 'state.json');
}

/** 新 id：`job_1a2b3c4d` 这种，前缀可读、后缀随机。 */
export function newId(prefix) {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    // null = 没停；否则 { at, by, reason }
    stopped: null,
    jobs: [],
    approvals: [],
    runs: [],
  };
}

/** 把任意形状的对象修成能用的状态（老文件、手改坏了、字段缺失都靠这一步兜）。 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const out = {
    version: STATE_VERSION,
    stopped: raw.stopped && typeof raw.stopped === 'object' && raw.stopped.at ? {
      at: String(raw.stopped.at),
      by: String(raw.stopped.by ?? ''),
      reason: String(raw.stopped.reason ?? ''),
    } : null,
    jobs: Array.isArray(raw.jobs) ? raw.jobs.filter((j) => j && typeof j === 'object' && j.id) : [],
    approvals: Array.isArray(raw.approvals) ? raw.approvals.filter((a) => a && typeof a === 'object' && a.id) : [],
    runs: Array.isArray(raw.runs) ? raw.runs.filter((r) => r && typeof r === 'object') : [],
  };
  if (out.runs.length > MAX_RUNS) out.runs = out.runs.slice(-MAX_RUNS);
  if (out.approvals.length > MAX_APPROVALS) out.approvals = out.approvals.slice(-MAX_APPROVALS);
  return out;
}

/** 读状态：文件不在就是空状态（第一次用），坏了就保底 + 给出原因。 */
export function loadState({ root } = {}) {
  const file = stateFile(root);
  try {
    const text = readFileSync(file, 'utf8');
    return { ok: true, state: normalizeState(JSON.parse(text)), file };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, state: emptyState(), file, missing: true };
    return { ok: false, state: emptyState(), file, error: String(err?.message || err) };
  }
}

/** 原子写：先写同目录 .tmp 再 rename（Windows 上 rename 覆盖是原子的）。 */
export function saveState({ root, state } = {}) {
  const file = stateFile(root);
  const next = normalizeState(state);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return { ok: true, file, state: next };
  } catch (err) {
    return { ok: false, file, state: next, error: String(err?.message || err) };
  }
}

/**
 * 改状态：读 → 改 → 写，返回 { ok, state, error }。
 * 加工函数拿到的是副本的引用，可以直接改；抛错则整次放弃（不写半个状态）。
 */
export function updateState({ root } = {}, mutate) {
  const loaded = loadState({ root });
  const draft = loaded.state;
  let changed;
  try {
    changed = mutate(draft);
  } catch (err) {
    return { ok: false, state: loaded.state, error: String(err?.message || err) };
  }
  const saved = saveState({ root, state: draft });
  return { ok: saved.ok, state: saved.state, error: saved.error, result: changed };
}

/** 记一条执行记录（内部用：runner 每跑一次就记一笔）。 */
export function pushRun(state, entry) {
  // at 允许传毫秒数，落盘统一 ISO（人看得懂、也省得各处再转）
  const atMs = Number(entry?.at ?? Date.now());
  const run = {
    ...entry,
    id: newId('run'),
    at: new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString(),
    ok: Boolean(entry?.ok),
  };
  state.runs.push(run);
  if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS);
  return run;
}
