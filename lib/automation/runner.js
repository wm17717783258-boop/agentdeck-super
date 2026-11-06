/**
 * lib/automation/runner.js —— 真到点真执行的那一层
 *
 * 一次 tick 做四件事：
 *   1. 读状态（从盘上读！这样另一个进程 `nexi stop` 立刻生效）；
 *   2. 全局停止中 → 一条都不跑，返回 { skipped: 'stopped' }；
 *   3. 到点的任务：要审批的进审批队列（并推进下次时间，免得每分钟刷一条），
 *      不要审批的直接执行；
 *   4. 执行结果记进 runs，写回盘。
 *
 * 执行只有两种：
 *   - action:'task'  → 往任务板丢一条任务（Agent 自己去认领，这才是"人走机器干活"）
 *   - action:'agent' → 用宿主注入的 runAgent 真的跑一次 Agent（Claude/Codex/dsh 都行）
 *
 * 底线：单个任务失败不许影响别的任务；tick 永不 throw。
 */

import { loadState, pushRun, updateState } from './store.js';
import { dueJobs, nextRunAt } from './schedule.js';
import { callBoard } from '../tools/common.js';

/** 找出这条 job 该落哪个小组：任务指定 > 默认配置 > 唯一的小组。 */
async function resolveTeam(deps, job) {
  if (job.teamId) return job.teamId;
  const teams = await callBoard(deps, 'listTeams');
  if (Array.isArray(teams) && teams.length === 1) return teams[0]?.id ?? teams[0]?.teamId ?? null;
  return null;
}

/** 真执行一条 job：返回 { ok, detail } —— detail 是要写进 runs 的人话。 */
async function execute(deps, job, nowMs) {
  if (job.action === 'agent') {
    if (typeof deps?.runAgent !== 'function') {
      return { ok: false, detail: '宿主没有派活能力（deps.runAgent 缺失），这条 agent 任务没跑。' };
    }
    const spec = job.agent ? { name: job.agent, agent: job.agent } : {};
    try {
      const res = await deps.runAgent(spec, job.prompt, { timeoutMs: 10 * 60 * 1000 });
      const rc = Number(res?.rc ?? res?.exitCode ?? (res?.ok === false ? 1 : 0));
      const out = String(res?.out ?? res?.stdout ?? res?.output ?? res?.content ?? '').trim();
      return rc === 0
        ? { ok: true, detail: `Agent 跑完（${out ? `${out.slice(0, 120)}…` : '没有输出文字'}）` }
        : { ok: false, detail: `Agent 返回码 ${rc}：${String(res?.err ?? '').slice(0, 120)}` };
    } catch (err) {
      return { ok: false, detail: `派活失败：${String(err?.message || err)}` };
    }
  }

  // action === 'task'
  const teamId = await resolveTeam(deps, job);
  if (!teamId) {
    return { ok: false, detail: '还没建小组（或者小组不止一个却没指定 teamId），这条任务没地方落。先 team_board create 一次。' };
  }
  const added = await callBoard(deps, 'addTask', teamId, {
    title: job.title,
    role: job.role,
    acceptance: job.acceptance,
    source: 'automation',
    jobId: job.id,
  });
  if (!added) return { ok: false, detail: `往小组 ${teamId} 加任务失败（任务板没接住）。` };
  const id = added?.id ?? added?.task?.id ?? '?';
  return { ok: true, detail: `已在小组 ${teamId} 建任务 ${id}`, taskId: id, teamId };
}

/**
 * 造一个 runner。
 * @param {object} opts
 * @param {string} opts.root     工作区（自动化状态落在这里）
 * @param {object} opts.deps     工具依赖（要有 board / runAgent 才真能干）
 * @param {Function} [opts.now]  时钟注入
 * @param {Function} [opts.log]  日志
 */
export function createRunner({ root, deps, now = () => Date.now(), log = () => {} } = {}) {
  /** 推进一条 job 的时间戳（周期任务算下一次；一次性任务退休）。 */
  function advance(job, nowMs) {
    job.lastRunAt = new Date(Number(nowMs)).toISOString();
    job.runCount = Number(job.runCount || 0) + 1;
    const next = nextRunAt(job, nowMs);
    if (next) job.nextAt = next;
    else { job.enabled = false; job.nextAt = job.at || job.nextAt; }
  }

  /** 跑一条具体的 job（tick 和"立刻跑一次"共用同一条路）。 */
  async function runJob(jobId, { by = 'schedule', nowMs = Number(now()) } = {}) {
    const loaded = loadState({ root });
    const job = (loaded.state.jobs || []).find((j) => j.id === jobId);
    if (!job) return { ok: false, error: `没有这个定时任务：${jobId}` };

    const res = await execute(deps, job, nowMs);
    const saved = updateState({ root }, (state) => {
      const target = state.jobs.find((j) => j.id === jobId);
      if (target) {
        advance(target, nowMs);
        target.lastStatus = res.ok ? 'ok' : 'failed';
        if (!res.ok) target.lastError = res.detail;
      }
      pushRun(state, {
        at: nowMs, jobId, jobTitle: job.title, action: job.action, by, ok: res.ok,
        detail: res.detail, taskId: res.taskId ?? null,
      });
      // 审批通过之后那条记录标记为已执行
      if (by === 'approval') {
        const apr = state.approvals.find((a) => a.jobId === jobId && a.status === 'pending');
        if (apr) { apr.status = res.ok ? 'done' : 'failed'; apr.doneAt = new Date(nowMs).toISOString(); }
      }
    });
    if (!saved.ok) log(`自动化状态写盘失败：${saved.error}`);
    return { ok: res.ok, detail: res.detail, taskId: res.taskId ?? null };
  }

  /** 一次调度巡检。 */
  async function tick({ nowMs = Number(now()) } = {}) {
    const loaded = loadState({ root });
    if (!loaded.ok) log(`自动化状态读取失败，本次不跑：${loaded.error}`);
    const state = loaded.state;
    if (state.stopped) return { ok: true, skipped: 'stopped', stopped: state.stopped, executed: [], queued: [] };

    const due = dueJobs(state, nowMs);
    if (!due.length) return { ok: true, executed: [], queued: [] };

    const executed = [];
    const queued = [];
    for (const job of due) {
      if (job.needsApproval) {
        // 只排一次审批：已经有一条待审批的同 jobId 记录就不再排队
        const existed = state.approvals.some((a) => a.jobId === job.id && a.status === 'pending');
        updateState({ root }, (draft) => {
          const target = draft.jobs.find((j) => j.id === job.id);
          if (target) {
            target.lastRunAt = new Date(nowMs).toISOString();
            const next = nextRunAt(target, nowMs);
            if (next) target.nextAt = next; else { target.enabled = false; }
            target.lastStatus = 'awaiting-approval';
          }
          if (!existed) {
            draft.approvals.push({
              id: `apr_${job.id.slice(-8)}${Math.random().toString(16).slice(2, 6)}`,
              jobId: job.id, title: job.title, action: job.action,
              at: new Date(nowMs).toISOString(), status: 'pending',
            });
          }
        });
        if (!existed) queued.push({ jobId: job.id, title: job.title });
        continue;
      }
      const res = await runJob(job.id, { by: 'schedule', nowMs });
      executed.push({ jobId: job.id, title: job.title, ok: res.ok, detail: res.detail, taskId: res.taskId });
    }
    return { ok: true, executed, queued };
  }

  return { tick, runJob, root };
}

/**
 * 在插件/宿主里挂一个巡检定时器。
 * 默认 30 秒一次；`automation.tickMs` 可改。返回 disposer（插件卸载时清掉）。
 */
export function startTicker({ runner, tickMs = 30000, log = () => {} } = {}) {
  const interval = Math.max(1000, Number(tickMs) || 30000);
  let busy = false;
  const run = async () => {
    if (busy) return; // 上一轮还没跑完就跳过，绝不叠加
    busy = true;
    try {
      const res = await runner.tick();
      if (res?.executed?.length) log(`自动化：跑了 ${res.executed.length} 条定时任务`);
      if (res?.queued?.length) log(`自动化：${res.queued.length} 条进了审批队列`);
    } catch (err) {
      log(`自动化巡检出错（已忽略，下轮继续）：${String(err?.message || err)}`);
    } finally {
      busy = false;
    }
  };
  // 起来 2 秒后先巡一次：宿主刚启动时"已经到点"的任务不用再等一整个周期
  const kickoff = setTimeout(() => { void run(); }, 2000);
  const timer = setInterval(() => { void run(); }, interval);
  if (typeof kickoff.unref === 'function') kickoff.unref();
  if (typeof timer.unref === 'function') timer.unref();
  return () => { clearTimeout(kickoff); clearInterval(timer); };
}

export default { createRunner, startTicker };
