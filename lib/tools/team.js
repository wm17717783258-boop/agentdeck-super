/**
 * tools/team.js —— 暴露给宿主的 `team_orchestrate` 工具（拆解 + 派活 + 验收）
 *
 * 契约（CONTRACTS 2.8）：createTeamTool(deps) => { name, description, parameters, execute }
 *
 * 它做四件事，顺序不能乱：
 *   1) 出计划：让组长角色（模型）把目标拆成任务图；用户也可以直接传 plan 跳过模型；
 *   2) 落板：把任务写进小组任务板（带上角色/验收/依赖），拿回真实 id；
 *   3) 并行执行：按依赖图跑，默认 3 路并发，每条任务派给"角色匹配"的成员；
 *   4) 过闸+回写：验收不通过按重试次数再跑，最终把状态写回任务板并给一份人话报告。
 *
 * 关键取舍：没有成员、没有任务板也必须能干活。降级顺序是
 *   派给成员 → 组长自己用模型做 → 明确告诉用户缺什么。
 */

import { planProject, validatePlan, defaultGate, systemFor, ROLES } from '../engine/roles.js';
import {
  callBoard,
  clipText,
  dispatchTo,
  emitSafe,
  fmtMs,
  listMembers,
  normalizeDeps,
  pickMemberByRole,
  requireFields,
  resolveTeamId,
  safeExecute,
  TOOL_OUTPUT,
} from './common.js';

export function createTeamTool(deps) {
  const d = normalizeDeps(deps);
  return {
    name: 'team_orchestrate',
    description: [
      '把一个大目标拆成分工明确的子任务，派给小组里的多个成员并行完成，并对每条产出做验收。',
      '什么时候用：需求能自然拆成 2 个以上可并行的子任务（"前后端一起改""三个人分别查三个模块"）。',
      '单个目标只需一个人干完，请用 super_agent（更省 token）；只想先看拆解结果不想执行，传 dryRun:true。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '总目标：写清要交付什么、验收标准是什么。' },
        brief: { type: 'string', description: '补充上下文/约束/已知信息（可选）。' },
        teamId: { type: 'string', description: '在哪个小组里编排（可选，默认当前小组）。' },
        maxTasks: { type: 'number', description: '最多拆多少条任务，默认 8。' },
        concurrency: { type: 'number', description: '同时最多跑几条任务，默认 3。' },
        dryRun: { type: 'boolean', description: 'true = 只出计划不执行。' },
        plan: {
          type: 'array',
          description: '直接用你给的任务数组，跳过模型拆解（每项：id/title/role/acceptance/dependsOn）。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              role: { type: 'string' },
              acceptance: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
      },
      required: ['goal'],
    },
    execute: safeExecute('team_orchestrate', async (args, exec) => {
      const bad = requireFields(args, ['goal']);
      if (bad) return `【team_orchestrate】${bad}`;

      const goal = String(args.goal).trim();
      const maxTasks = Math.min(20, Math.max(1, Number(args.maxTasks) || 8));
      const concurrency = Math.min(8, Math.max(1, Number(args.concurrency) || 3));

      // ---- 1) 计划 ----
      let plan;
      if (args.plan != null) {
        const raw = typeof args.plan === 'string' ? safeJson(args.plan) : args.plan;
        const checked = validatePlan(raw, { maxTasks });
        plan = {
          ok: checked.ok,
          goal,
          tasks: checked.tasks,
          warnings: checked.warnings,
          errors: checked.errors,
          model: '（用户给定）',
          degraded: !checked.ok,
        };
        if (!checked.tasks.length) return `【team_orchestrate】计划里没有有效任务：${checked.errors.join('；')}`;
      } else {
        if (!d.brain || typeof d.brain.chat !== 'function') {
          return '【team_orchestrate】没有可用的大脑，无法拆解目标。可以改用 super_agent，或直接传 plan 参数给定任务数组。';
        }
        plan = await planProject({
          brain: d.brain,
          brief: args.brief ? `${goal}\n\n补充说明：${args.brief}` : goal,
          opts: { maxTasks, signal: exec?.signal },
        });
      }

      const planText = renderPlan(goal, plan);
      if (args.dryRun) {
        emitSafe(d, 'team_planned', { goal, tasks: plan.tasks.length, dryRun: true });
        return `${planText}\n\n（dryRun：只出计划，未执行任何任务。确认无误后可去掉 dryRun 重新调用。）`;
      }

      // ---- 2) 落板 ----
      const teamId = await resolveTeamId(d, args, exec);
      const boardReady = Boolean(d.board);
      if (!boardReady) plan.warnings.push('宿主没有任务板，本次只在内存里编排，进度不会持久化');
      if (!teamId && boardReady) plan.warnings.push('当前没有绑定小组，任务板写入已跳过');

      const created = await materializeTasks(d, { teamId, tasks: plan.tasks, boardReady: Boolean(teamId) });
      const runTasks = created.tasks;
      const members = listMembers(d);
      if (!members.length) plan.warnings.push('小组里没有登记成员，本次由组长（模型）自己按角色逐条完成');
      if (!d.runAgent) plan.warnings.push('宿主没有注入派活能力（runAgent），本次由组长自己完成');

      emitSafe(d, 'team_start', { goal, teamId, tasks: runTasks.length, concurrency });

      // ---- 3) 执行 + 4) 过闸回写 ----
      const { runGraph } = await import('../engine/roles.js');
      // runGraph 按契约只回 {ok,output,error}，所以"谁做的/耗时"另存一份，报告里才写得出来
      const side = new Map();
      const graph = await runGraph({
        tasks: runTasks,
        concurrency,
        run: async (task) => {
          const result = await runTask(d, task, { goal, teamId, exec, members });
          side.set(task.id, { by: result?.by, ms: result?.ms });
          return result;
        },
        gate: async (task, result) => {
          const verdict = gateOf(task, result);
          await syncBoard(d, teamId, task, verdict, result);
          return verdict;
        },
      });

      emitSafe(d, 'team_done', { goal, teamId, ok: graph.ok, failures: graph.failures.length });
      return `${planText}\n\n${renderRun({ goal, graph, tasks: runTasks, side })}`;
    }),
    output: TOOL_OUTPUT,
    timeoutMs: 30 * 60 * 1000,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 把计划落成任务板任务，并按拓扑顺序创建（这样 dependsOn 能换成真实 board id）。
 * 没有任务板时退回计划 id，编排照样能跑。
 */
async function materializeTasks(d, { teamId, tasks, boardReady }) {
  const idMap = new Map();
  const out = [];
  const remaining = [...tasks];
  let guard = 0;
  while (remaining.length && guard < 200) {
    guard += 1;
    let progressed = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const t = remaining[i];
      const deps = t.dependsOn || [];
      if (!deps.every((dep) => idMap.has(dep))) continue;
      const payload = {
        title: t.title,
        role: t.role,
        acceptance: t.acceptance,
        dependsOn: deps.map((dep) => idMap.get(dep)).filter(Boolean),
        note: t.brief || '',
      };
      let boardId = null;
      if (boardReady && teamId) {
        const row = await callBoard(d, 'addTask', teamId, payload);
        boardId = row && (row.id ?? row.taskId) ? String(row.id ?? row.taskId) : null;
      }
      const id = boardId || t.id;
      idMap.set(t.id, id);
      out.push({ ...t, id, boardId, planId: t.id });
      remaining.splice(i, 1);
      i -= 1;
      progressed = true;
    }
    if (!progressed) {
      // 依赖成环或指向不存在的任务：剩下的直接按无依赖跑，别让整单卡死
      for (const t of remaining) {
        idMap.set(t.id, t.id);
        out.push({ ...t, id: t.id, boardId: null, planId: t.id });
      }
      remaining.length = 0;
    }
  }
  return { tasks: out, idMap };
}

/**
 * 跑一条任务：优先派给角色匹配的成员；没成员/没派活能力时由组长自己用模型完成。
 * 返回 { ok, output, error, by, ms } 给 runGraph 过闸。
 */
async function runTask(d, task, { goal, teamId, exec, members }) {
  const prompt = buildTaskPrompt(task, goal);
  const member = pickMemberByRole(d, task.role);

  if (member && typeof d.runAgent === 'function') {
    const res = await dispatchTo(d, member, prompt, {
      cwd: exec?.cwd,
      signal: exec?.signal,
      timeoutMs: 10 * 60 * 1000,
      role: task.role,
    });
    emitSafe(d, 'task_run', { teamId, taskId: task.id, member: member.name, ok: res.ok, ms: res.ms });
    if (!res.ok) {
      return { ok: false, output: clipText(`${res.out}\n${res.err}`.trim(), 8000), error: res.err || `成员 ${member.name} 返回码 ${res.rc}`, by: member.name, ms: res.ms };
    }
    return { ok: true, output: clipText(res.out || '（成员没有输出文字）', 8000), by: member.name, ms: res.ms };
  }

  // 降级：组长自己按该角色的 system prompt 回答（不做工具循环，避免递归烧配额）
  if (!d.brain || typeof d.brain.chat !== 'function') {
    return { ok: false, output: '', error: '没有可用成员，也没有可用模型通道', by: 'none', ms: 0 };
  }
  const started = Date.now();
  try {
    const res = await d.brain.chat({
      messages: [
        { role: 'system', content: systemFor(task.role, `总目标：${goal}`) },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 2000,
      signal: exec?.signal,
    });
    const out = String(res?.content ?? '').trim();
    const ms = Date.now() - started;
    emitSafe(d, 'task_run', { teamId, taskId: task.id, member: 'lead-self', ok: Boolean(out), ms });
    return out ? { ok: true, output: clipText(out, 8000), by: `组长(${task.role})`, ms } : { ok: false, output: '', error: '模型没有产出内容', by: 'lead-self', ms };
  } catch (err) {
    return { ok: false, output: '', error: `模型调用失败：${err?.message || err}`, by: 'lead-self', ms: Date.now() - started };
  }
}

function buildTaskPrompt(task, goal) {
  const role = ROLES[task.role] || ROLES.worker;
  return [
    `【总目标】${goal}`,
    `【你的角色】${role.name}（${task.role}）—— 只做这个角色该做的事：${role.whenToUse}。`,
    `【你的任务】${task.title}`,
    task.brief ? `【上下文】${task.brief}` : '',
    task.context ? `【上游产出】\n${clipText(task.context, 3000)}` : '',
    `【验收标准】${task.acceptance}`,
    '',
    '请直接动手完成（该读文件就读、该改就改、该跑命令就跑），不要只给建议。',
    '完成后用中文简要汇报：做了什么、产物在哪（文件路径/命令）、怎么验证、有什么风险。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 验收闸门：默认按"有产出且执行成功"判定，并把 acceptance 带进结论。 */
function gateOf(task, result) {
  const base = defaultGate(task, result);
  if (!base.ok && result?.error) return { ok: false, reason: String(result.error).slice(0, 200) };
  return base;
}

/** 把结果写回任务板（完成/失败都写，进度才有意义）。 */
async function syncBoard(d, teamId, task, verdict, result) {
  if (!d.board || !teamId || !task.boardId) return;
  try {
    if (verdict.ok) {
      await callBoard(d, 'completeTask', teamId, task.boardId, { ok: true, output: clipText(String(result?.output ?? ''), 4000), by: result?.by });
    } else {
      await callBoard(d, 'failTask', teamId, task.boardId, verdict.reason || '验收不通过');
    }
    await callBoard(d, 'appendEvent', teamId, {
      kind: verdict.ok ? 'task_done' : 'task_failed',
      taskId: task.boardId,
      text: `${task.title}：${verdict.ok ? '通过验收' : `未通过 —— ${verdict.reason}`}`,
    });
  } catch { /* 回写失败不影响编排结果 */ }
}

function renderPlan(goal, plan) {
  const lines = [
    `【team_orchestrate】计划 · 目标：${goal}`,
    `来源：${plan.model || (plan.degraded ? '降级兜底' : '模型拆解')} · 任务数：${plan.tasks.length}`,
  ];
  if (plan.warnings?.length) lines.push(`说明：${plan.warnings.join('；')}`);
  if (plan.errors?.length) lines.push(`⚠️ 计划问题：${plan.errors.join('；')}`);
  lines.push('', '任务图：');
  for (const t of plan.tasks) {
    const deps = t.dependsOn?.length ? `依赖 ${t.dependsOn.join(',')}` : '无依赖（可并行）';
    lines.push(`- ${t.id} [${t.role}] ${t.title}`);
    lines.push(`    验收：${t.acceptance}`);
    lines.push(`    ${deps}`);
  }
  return lines.join('\n');
}

function renderRun({ goal, graph, tasks, side }) {
  const rows = tasks.map((t) => {
    const r = graph.results[t.id];
    // 执行者/耗时来自 side（runGraph 只回契约字段）；也容错地读一下 r，万一日后契约放宽
    const extra = side?.get?.(t.id) || {};
    const by = r?.by || extra.by || '';
    const msVal = Number(r?.ms || extra.ms || 0);
    const mark = r?.ok ? '✓' : '✗';
    const who = by ? ` · ${by}` : '';
    const ms = msVal > 0 ? ` · ${fmtMs(msVal)}` : '';
    const out = r?.output ? `\n    产出：${oneLine(r.output, 300)}` : '';
    const err = r?.error ? `\n    原因：${r.error}` : '';
    return `${mark} ${t.id} [${t.role}] ${t.title}${who}${ms}${out}${err}`;
  });
  const okCount = tasks.filter((t) => graph.results[t.id]?.ok).length;
  const failCount = graph.failures.length;
  const head = graph.ok
    ? `【执行结果】全部通过（${okCount}/${tasks.length}）`
    : `【执行结果】成功 ${okCount}/${tasks.length}，失败/跳过 ${failCount}`;
  const parts = [head, '', '任务明细：', ...rows];
  if (graph.warnings?.length) parts.push('', `过程提示：${graph.warnings.slice(0, 8).join('；')}`);
  if (!graph.ok) {
    parts.push('', '【失败任务与建议】');
    for (const f of graph.failures.slice(0, 8)) parts.push(`- ${f.id}：${f.error}`);
    parts.push('建议：先修失败项（可用 super_agent 针对单条任务重跑），或把依赖它的任务改小后重试。');
  }
  parts.push('', `【总目标】${goal}`);
  return parts.join('\n');
}

function oneLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export default { createTeamTool };
