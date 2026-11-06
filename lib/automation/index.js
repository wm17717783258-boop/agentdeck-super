/**
 * lib/automation/index.js —— `deck_automation` 工具：定时 / 审批 / 全局停止
 *
 * 一个工具管四件事（都是 action，不是四个工具：模型少选一次就少错一次）：
 *   add      加一条定时任务（周期或一次性；可要求人工审批）
 *   list     看所有定时任务 + 审批队列 + 最近执行
 *   remove   删掉一条（软删：直接摘掉，但 runs 记录留着）
 *   run      立刻跑一次（不等到点；照样受"全局停止"和审批约束）
 *   approve / deny  审批队列放行或拒绝（放行=立刻执行那一次）
 *   stop / resume   全局停止 / 恢复
 *   status   一眼看住：停没停、有几条到点、跑了多少次
 *
 * 为什么"全局停止"要落盘：`nexi stop` 是另一个进程执行的，
 * 只改内存标志位的话正在跑的宿主根本不知道 —— 那就不叫停。
 */

import { loadState, updateState } from './store.js';
import { createRunner } from './runner.js';
import { describeEvery, describeJob, normalizeJob } from './schedule.js';
import { normalizeDeps, safeExecute, TOOL_OUTPUT, workspaceRoot } from '../tools/common.js';

const ACTIONS = ['add', 'list', 'remove', 'run', 'approve', 'deny', 'stop', 'resume', 'status'];

/** 时间戳 → 本地可读（'11-05 20:13'）。 */
function clock(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso || '');
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function agoText(iso, nowMs) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Number(nowMs) - ms);
  if (diff < 60000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  return `${Math.round(diff / 86400000)} 天前`;
}

function renderStatus(state, nowMs) {
  const jobs = state.jobs || [];
  const pending = (state.approvals || []).filter((a) => a.status === 'pending');
  const enabled = jobs.filter((j) => j.enabled !== false);
  const head = state.stopped
    ? `⏸ 全局已停止（${clock(state.stopped.at)} 由 ${state.stopped.by || '某人'} 停的${state.stopped.reason ? `：${state.stopped.reason}` : ''}）—— 到点也不动`
    : '▶ 自动化在跑';
  const rows = [
    `${head}`,
    `定时任务 ${jobs.length} 条（启用的 ${enabled.length} 条），待审批 ${pending.length} 条，执行记录 ${(state.runs || []).length} 条`,
  ];
  const nextUp = enabled
    .map((j) => ({ j, ms: Date.parse(j.nextAt) }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms)[0];
  if (nextUp) {
    const diff = nextUp.ms - Number(nowMs);
    rows.push(diff <= 0
      ? `下一条该跑了：${nextUp.j.title}（已到点 ${agoText(nextUp.j.nextAt, nowMs)}）`
      : `下一条：${nextUp.j.title}，还有 ${Math.round(diff / 1000)} 秒`);
  }
  return rows.join('\n');
}

export function createAutomationTool(deps) {
  const d = normalizeDeps(deps);
  const now = () => Date.now();

  /** runner 懒建：工具被调用时才碰盘，插件启动时不因为自动化模块出问题而炸。 */
  let runner = null;
  const runnerOf = () => {
    if (!runner) runner = createRunner({ root: workspaceRoot(d), deps: d, now, log: (m) => d.emit?.('log', { text: m }) });
    return runner;
  };

  return {
    name: 'deck_automation',
    description: [
      '定时任务 + 人工审批 + 全局停止：让事情到点自己发生，或者到点先问你一声。',
      'add=加一条（every:"30m" 周期 或 at:"2026-11-05T20:00:00+08:00" 一次性；action:"task" 丢任务到任务板，action:"agent" 真跑一次 Agent；needsApproval:true 则到点只进审批队列）',
      'list=看全部；run=立刻跑一次；approve/deny=放行或拒绝待审批；stop/resume=全局停止/恢复；status=一眼看住。',
      'stop 是落盘的：命令行 `nexi stop` 也能停住正在跑的宿主。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'add/list/remove/run/approve/deny/stop/resume/status。默认 status。' },
        title: { type: 'string', description: 'add：任务标题（人话，会出现在任务板上）。' },
        every: { type: 'string', description: 'add：周期，如 "30s"/"10m"/"2h"/"1d"。' },
        at: { type: 'string', description: 'add：一次性时间，ISO 带时区，如 2026-11-05T20:00:00+08:00。' },
        kind: { type: 'string', enum: ['task', 'agent'], description: 'add：执行方式，默认 task（丢任务到任务板）。' },
        acceptance: { type: 'string', description: 'add：验收标准（会写进任务）。' },
        role: { type: 'string', description: 'add：任务角色，默认 worker。' },
        teamId: { type: 'string', description: 'add：落到哪个小组（不填=唯一的小组）。' },
        prompt: { type: 'string', description: 'add+kind:agent：到点让 Agent 干什么。' },
        agent: { type: 'string', description: 'add+kind:agent：用哪个 Agent（claude/codex/dsh…）。' },
        needsApproval: { type: 'boolean', description: 'add：true=到点只进审批队列，人点头才真干。' },
        maxRuns: { type: 'number', description: 'add：最多跑几次。' },
        jobId: { type: 'string', description: 'remove/run：哪一条定时任务。' },
        approvalId: { type: 'string', description: 'approve/deny：哪一条待审批。' },
        reason: { type: 'string', description: 'stop/deny：原因（会记录）。' },
        limit: { type: 'number', description: 'list：最多显示几条，默认 20。' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('deck_automation', async (args) => {
      const action = String(args.action || 'status').toLowerCase();
      if (!ACTIONS.includes(action)) return `【deck_automation】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      const root = workspaceRoot(d);

      if (action === 'stop') {
        const saved = updateState({ root }, (state) => {
          const reason = String(args.reason || '').trim();
          state.stopped = { at: new Date(now()).toISOString(), by: 'deck_automation', reason };
        });
        if (!saved.ok) return `【deck_automation】停止标志写盘失败：${saved.error}`;
        return '【deck_automation】已全局停止：到点的任务一条都不会跑（已进审批队列的也先搁着）。恢复用 action:"resume"，命令行等价于 `nexi stop` / `nexi resume`。';
      }

      if (action === 'resume') {
        const saved = updateState({ root }, (state) => { state.stopped = null; });
        if (!saved.ok) return `【deck_automation】恢复失败：${saved.error}`;
        return '【deck_automation】已恢复：下一轮到点的任务照常执行。';
      }

      if (action === 'add') {
        const built = normalizeJob({
          title: args.title,
          // 参数名对外的叫 kind（跟模型习惯一致），内部字段叫 action
          action: args.kind || 'task',
          every: args.every,
          at: args.at,
          acceptance: args.acceptance,
          role: args.role,
          teamId: args.teamId,
          prompt: args.prompt,
          agent: args.agent,
          needsApproval: args.needsApproval,
          maxRuns: args.maxRuns,
        }, { now });
        if (!built.ok) return `【deck_automation】${built.error}`;
        const saved = updateState({ root }, (state) => { state.jobs.push(built.job); });
        if (!saved.ok) return `【deck_automation】写盘失败：${saved.error}`;
        const j = built.job;
        return [
          `【deck_automation】排好了：${j.title}`,
          j.at ? `- 时间：一次性，${clock(j.at)}` : `- 时间：每 ${describeEvery(j.every)} 一次，下次 ${clock(j.nextAt)}`,
          `- 做法：${j.action === 'agent' ? `到点让 Agent 跑一次（${j.agent || '默认 Agent'}）` : '到点往任务板丢一条任务'}`,
          `- 审批：${j.needsApproval ? '要你点头（到点先进审批队列）' : '不要审批，到点直接干'}`,
          `- 编号：${j.id}`,
        ].join('\n');
      }

      if (action === 'list') {
        const { state } = loadState({ root });
        const jobs = state.jobs || [];
        const pendings = (state.approvals || []).filter((a) => a.status === 'pending');
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
        const out = [renderStatus(state, now())];
        if (!jobs.length) out.push('（还没有定时任务，用 action:"add" 加一条）');
        for (const j of jobs.slice(0, limit)) out.push(`- ${describeJob(j)}`);
        if (pendings.length) {
          out.push(`待审批 ${pendings.length} 条：`);
          for (const a of pendings.slice(0, limit)) out.push(`- ${a.id} — ${a.title}（${a.at} 到点的，approve:"${a.id}" 放行）`);
        }
        const runs = (state.runs || []).slice(-5).reverse();
        if (runs.length) {
          out.push('最近执行：');
          for (const r of runs) out.push(`- ${clock(r.at)} ${r.ok ? '✅' : '❌'} ${r.jobTitle}${r.detail ? `：${r.detail}` : ''}`);
        }
        return out.join('\n');
      }

      if (action === 'remove') {
        const jobId = String(args.jobId || '').trim();
        if (!jobId) return '【deck_automation】remove 要给 jobId。';
        let found = false;
        const saved = updateState({ root }, (state) => {
          const before = state.jobs.length;
          state.jobs = state.jobs.filter((j) => j.id !== jobId);
          found = state.jobs.length < before;
          state.approvals = state.approvals.filter((a) => a.jobId !== jobId || a.status !== 'pending');
        });
        if (!saved.ok) return `【deck_automation】写盘失败：${saved.error}`;
        return found ? `【deck_automation】已删掉 ${jobId}（执行记录留着，方便回看）。` : `【deck_automation】没有这个定时任务：${jobId}`;
      }

      if (action === 'run') {
        const jobId = String(args.jobId || '').trim();
        if (!jobId) return '【deck_automation】run 要给 jobId。';
        const { state } = loadState({ root });
        if (state.stopped) return `【deck_automation】全局已停止（${state.stopped.at}），先 action:"resume" 再跑。`;
        const job = (state.jobs || []).find((j) => j.id === jobId);
        if (!job) return `【deck_automation】没有这个定时任务：${jobId}`;
        if (job.needsApproval) {
          // 手动跑一条"要审批"的任务：不偷偷执行，塞进审批队列等人点头
          const aprId = `apr_${job.id.slice(-8)}${Math.random().toString(16).slice(2, 6)}`;
          updateState({ root }, (draft) => {
            draft.approvals.push({ id: aprId, jobId: job.id, title: job.title, action: job.action, at: new Date(now()).toISOString(), status: 'pending' });
          });
          return `【deck_automation】这条要审批，已送进队列：${aprId}（${job.title}）。approve approvalId:"${aprId}" 才会真跑。`;
        }
        const res = await runnerOf().runJob(jobId, { by: 'manual' });
        return `【deck_automation】${res.ok ? '✅ 跑完了' : '❌ 没跑成'}：${res.detail}`;
      }

      if (action === 'approve' || action === 'deny') {
        const approvalId = String(args.approvalId || '').trim();
        if (!approvalId) return `【deck_automation】${action} 要给 approvalId。`;
        const { state } = loadState({ root });
        if (state.stopped) return `【deck_automation】全局已停止（${state.stopped.at}），先 resume 再审批执行。`;
        const apr = (state.approvals || []).find((a) => a.id === approvalId && a.status === 'pending');
        if (!apr) return `【deck_automation】没有这条待审批记录：${approvalId}（可能已经处理过）`;
        if (action === 'deny') {
          const saved = updateState({ root }, (draft) => {
            const target = draft.approvals.find((a) => a.id === approvalId);
            if (target) { target.status = 'denied'; target.doneAt = new Date(now()).toISOString(); target.reason = String(args.reason || ''); }
          });
          if (!saved.ok) return `【deck_automation】写盘失败：${saved.error}`;
          return `【deck_automation】已拒绝：${apr.title}（这次不执行，下一轮到点还会再问）。`;
        }
        const res = await runnerOf().runJob(apr.jobId, { by: 'approval' });
        return `【deck_automation】审批放行 ${apr.title} → ${res.ok ? '✅ 已执行' : '❌ 执行失败'}：${res.detail}`;
      }

      // status
      const { state } = loadState({ root });
      return `【deck_automation】\n${renderStatus(state, now())}`;
    }),
  };
}

export default { createAutomationTool };
