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
import * as spaceModule from '../team/space.js';
import * as auditModule from '../team/audit.js';
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
      const members = listMembers(d, teamId);
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
  const member = pickMemberByRole(d, task.role, teamId);

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

// ═══════════════════════════════════════════════════════════════════════════
// deck_team —— 团队空间（共享记忆 / 成员权限 / 审计导出）
//
// 和上面的 team_orchestrate 是两件事，别混：
//   team_orchestrate = 把一个目标拆成任务图，派 Agent 去执行（「干活」）；
//   deck_team        = 管这个团队里的人/角色/席位/共享记忆/审计（「记账」）。
// 两者共用同一个 <root>/team 目录：执行留下的痕迹落到审计里，审计导出给合规看。
//
// 三条硬边界（改代码前先读）：
//   1. 席位是真闸门：join 满了就返回 seats_exhausted，绝不静默放行；
//      席位上限从 license 读（读不到才退回默认 3），不写死。
//   2. SSO / SCIM / 私有化部署**没有实现**，status 动作必须原样列出，不许写"已支持"。
//   3. 审计里永远不出现 token/secret：写之前过 redact，导出也一样。
// ═══════════════════════════════════════════════════════════════════════════

/** 失败 code → 人话（每个都要能指导下一步，不写"出错了"）。 */
function teamCodeText(code, res) {
  const detail = String(res?.reason || '').trim();
  const table = {
    no_space: '还没有团队空间 —— 先说「建一个团队」，我建好再拉人。',
    corrupt: '空间文件坏了（不是你的操作问题）：已返回空数据，说「重建团队」我会把坏文件留档后重开。',
    read_failed: '空间文件读不了（权限问题），这一步没做。',
    write_failed: '写盘失败（目录只读或磁盘满），这一步没做。',
    seats_exhausted: '席位已满，这次没有加进去。席位是授权档位定的，升级档位或先让占位的人退出。',
    no_member: '空间里没有这个成员（先 members 看一眼真实 id）。',
    bad_member: '缺少成员 id —— 至少给我 id（例如 "王冕"）或 memberId。',
    bad_role: '角色只能是 lead / worker / reviewer / viewer。',
    last_lead: '至少留一个 lead：先把别人升成 lead，再改这一个人的角色。',
    owner_cannot_leave: '房主不能退出或移除（先把 lead 交给别人）。',
    space_mismatch: '空间 id 对不上（多空间时才会出现）：检查 spaceId。',
    empty_text: '共享记忆不能是空的 —— 给我一句要记住的话。',
    memory_full: '共享记忆条数到上限了，先清理过期条目。',
    bad_action: '审计动作不能为空（这是内部调用问题）。',
    bad_days: '保留天数必须大于 0。',
    internal: '内部错误，这一步没做。',
  };
  return `${table[code] || `这一步没做（code=${code || 'unknown'}）`}${detail ? `\n原因：${detail}` : ''}`;
}

/** 席位一行话。 */
function seatsText(s) {
  if (!s || !Number.isFinite(Number(s.total))) return '席位：未知';
  return `席位：${s.used}/${s.total} 已用${s.free != null ? `（还能进 ${s.free} 人）` : ''}`;
}

/** 成员一行：id（名字）· 角色 · 能力。 */
function memberLine(m, ownerId) {
  const caps = Array.isArray(m.capabilities) && m.capabilities.length ? ` · 能力 ${m.capabilities.join('/')}` : '';
  const owner = m.id === ownerId ? ' · 房主' : '';
  return `- ${m.id}（${m.name}） ${m.roleLabel || m.role}${caps}${owner}`;
}

/**
 * 造 `deck_team` 工具（团队空间）。
 * deps 支持的注入：`deps.team.space` / `deps.team.audit`（测试用），否则直接用本仓库实现；
 * `deps.license` 给 lib/license.js 的模块命名空间或已算好的授权对象，用来读席位。
 */
export function createDeckTeamTool(deps) {
  const raw = deps && typeof deps === 'object' ? deps : {};
  const d = normalizeDeps(raw);
  const space = raw.team?.space && typeof raw.team.space.joinSpace === 'function' ? raw.team.space : spaceModule;
  const audit = raw.team?.audit && typeof raw.team.audit.appendTeamAudit === 'function' ? raw.team.audit : auditModule;

  const rootOf = () => {
    if (d.root) {
      try {
        return String(d.root() || process.cwd());
      } catch { /* 落到下面 */ }
    }
    if (d.workspace) return String(d.workspace);
    return String(process.cwd());
  };

  /** 当前授权（用来读席位）。读不到就 null，space.seatLimit 会退回默认 3。 */
  const licenseOf = () => {
    try {
      const lic = raw.license || d.license || null;
      if (!lic) return null;
      if (typeof lic.currentLicense === 'function') return lic.currentLicense(rootOf());
      return lic;
    } catch {
      return null;
    }
  };

  /** 当前空间 id：审计行要带上它，否则 status 按空间统计会看不到自己刚写的记录。 */
  const currentSpaceId = () => {
    try {
      if (typeof space.getSpace === 'function') return space.getSpace({ root: rootOf() })?.id || '';
      if (typeof space.readSpace === 'function') {
        const r = space.readSpace({ root: rootOf() });
        return r.ok ? r.space.id : '';
      }
    } catch { /* 取不到就留空 */ }
    return '';
  };

  /** 记一条审计：审计失败绝不影响正事。 */
  const note = (action, detail, args) => {
    try {
      return audit.appendTeamAudit({
        root: rootOf(),
        spaceId: String(args?.spaceId || '') || currentSpaceId(),
        actorId: String(args?.actorId || d.cfg?.actorId || 'owner'),
        action,
        detail,
      });
    } catch {
      return { ok: false };
    }
  };

  return {
    name: 'deck_team',
    description: [
      '团队空间：create=建团队，join=拉人进团队，leave=退出，remove=移出成员，members=看成员与席位，',
      'set-role=改角色（lead/worker/reviewer/viewer），share=写共享记忆，recall=查共享记忆，',
      'audit-export=导出审计，audit-sweep=按保留期清理审计，status=总览（默认）。',
      '什么时候用：用户说"建个团队/把老王拉进来/给他评审权限/记一下这个结论/导出审计"。',
      '席位满时 join 会明确拒绝并说清上限（席位来自授权档位），不会静默加进去。',
      'SSO、SCIM、私有化部署未实现，status 会如实列出来。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '要做什么，默认 status。',
          enum: ['create', 'join', 'leave', 'remove', 'members', 'set-role', 'share', 'recall', 'audit-export', 'audit-sweep', 'status'],
        },
        spaceId: { type: 'string', description: '空间 id（可选，单空间时不用给）。' },
        name: { type: 'string', description: 'create：团队名；join：成员显示名。' },
        ownerId: { type: 'string', description: 'create：房主 id（默认 owner）。' },
        memberId: { type: 'string', description: 'join/leave/remove/set-role：成员 id。' },
        memberName: { type: 'string', description: 'join：成员显示名（不给就用 id）。' },
        role: { type: 'string', description: 'join/set-role：lead|worker|reviewer|viewer。' },
        capabilities: {
          type: 'array',
          description: 'join：成员能力标签（可选，例如 ["node","写文档"]）。',
          items: { type: 'string' },
        },
        actorId: { type: 'string', description: '谁在操作（写进审计，默认 owner）。' },
        text: { type: 'string', description: 'share：要记住的文本。' },
        scope: { type: 'string', description: 'share：team=全团队可见（默认），private=只有作者可见。' },
        source: { type: 'string', description: 'share：这条记忆的来源（谁说的/哪次会话/哪份文档）。' },
        ttlDays: { type: 'number', description: 'share：几天后过期（不填=永不过期）。' },
        query: { type: 'string', description: 'recall：关键词（不填=全部可见记忆）。' },
        viewerId: { type: 'string', description: 'recall：谁在查（private 记忆只对作者本人可见）。' },
        format: { type: 'string', description: 'audit-export：json（默认）或 csv。' },
        from: { type: 'string', description: 'audit-export：起始时间（ISO 或毫秒时间戳）。' },
        to: { type: 'string', description: 'audit-export：结束时间（ISO 或毫秒时间戳）。' },
        days: { type: 'number', description: 'audit-sweep：保留多少天，更早的删掉。' },
      },
    },
    output: TOOL_OUTPUT,
    timeoutMs: 15_000,
    execute: safeExecute('deck_team', async (rawArgs) => {
      // 宿主传进来的 args 不保证是对象（可能是 null/字符串/数组），先归一化再干活
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const action = String(args.action || 'status').trim();
      const root = rootOf();
      const sid = String(args.spaceId || d.cfg?.teamSpaceId || '');
      const who = String(args.actorId || d.cfg?.actorId || 'owner');

      // ── create：建团队 ────────────────────────────────────────────────
      if (action === 'create') {
        const res = space.createSpace({
          root,
          name: args.name,
          ownerId: String(args.ownerId || who),
          license: licenseOf(),
        });
        if (!res.ok) return `【deck_team】没建成。${teamCodeText(res.code, res)}`;
        if (!res.created) {
          const st = space.spaceStatus({ root, license: licenseOf() });
          return [
            `【deck_team】团队空间已存在：${res.space?.name || ''}（${res.space?.id || ''}）`,
            st.ok ? seatsText(st.seats) : '',
            '没覆盖任何已有数据；想重开请先备份 <工作区>/team/space.json。',
          ].filter(Boolean).join('\n');
        }
        note('space.create', { name: res.space?.name, seats: res.space?.seats?.total }, args);
        const lines = [
          `【deck_team】团队空间已创建：${res.space.name}（${res.space.id}）`,
          `房主：${res.space.ownerId}（自动占 1 席）`,
          `席位：1/${res.space.seats.total} 已用 —— 上限来自授权档位，不是写死的。`,
          '下一步：说「把 XX 拉进来」或「记一下：……」。',
        ];
        if (res.recovered) {
          lines.push(`注意：原 space.json 已损坏，已留档到 ${res.corruptBackup}，新文件是干净的。`);
        }
        return lines.join('\n');
      }

      // ── join：拉人（席位闸门在这里） ──────────────────────────────────
      if (action === 'join') {
        const memberId = String(args.memberId || '').trim();
        if (!memberId) return '【deck_team】拉谁进来？给我 memberId（例如 "王冕"）。';
        const res = space.joinSpace({
          root,
          spaceId: sid,
          member: {
            id: memberId,
            name: args.memberName,
            role: args.role,
            capabilities: args.capabilities,
          },
          license: licenseOf(),
        });
        if (!res.ok) {
          if (res.code === 'seats_exhausted') {
            const s = res.seats || {};
            return [
              `【deck_team】${memberId} 没加进去：${seatsText(s)}，已经满了。`,
              '这不是 bug：席位上限就是授权档位里的 maxSeats。',
              '怎么办：① 让不占位的人先 leave；② 升级档位（升级后 seats 会变多）；③ 把这个人当外部访客，不占团队席位。',
            ].join('\n');
          }
          return `【deck_team】没加成。${teamCodeText(res.code, res)}`;
        }
        if (!res.existing) note('member.join', { memberId, role: res.member?.role }, args);
        const st = space.spaceStatus({ root, license: licenseOf() });
        return [
          res.existing
            ? `【deck_team】${memberId} 本来就在团队里（角色 ${res.member?.roleLabel || res.member?.role}），没重复占席位。`
            : `【deck_team】已加入：${memberId}（${res.member?.name}）· ${res.member?.roleLabel || res.member?.role}`,
          st.ok ? seatsText(st.seats) : seatsText(res.seats),
        ].filter(Boolean).join('\n');
      }

      // ── leave / remove：退出与移出 ────────────────────────────────────
      if (action === 'leave' || action === 'remove') {
        const memberId = String(args.memberId || '').trim();
        if (!memberId) return `【deck_team】给个 memberId（members 看一眼真实 id）。`;
        const fn = action === 'leave' ? space.leaveSpace : space.removeMember;
        const res = fn({ root, spaceId: sid, memberId });
        if (!res.ok) return `【deck_team】没成功。${teamCodeText(res.code, res)}`;
        note(action === 'leave' ? 'member.leave' : 'member.remove', {
          memberId,
          clearedPrivateMemory: res.clearedPrivate,
        }, args);
        const keep = res.clearedPrivate > 0
          ? `同时清掉了他自己的 ${res.clearedPrivate} 条 private 记忆（team 范围的知识保留）。`
          : '没有需要清理的 private 记忆。';
        return `【deck_team】已${action === 'leave' ? '退出' : '移出'}：${memberId}。${keep}\n${seatsText(res.seats)}`;
      }

      // ── members：成员与席位 ──────────────────────────────────────────
      if (action === 'members') {
        const res = space.listMembers({ root, spaceId: sid });
        if (!res.ok) return `【deck_team】看不了成员。${teamCodeText(res.code, res)}`;
        const st = space.spaceStatus({ root, spaceId: sid, license: licenseOf() });
        const ownerId = st.ok ? st.space.ownerId : '';
        return [
          `【deck_team】${st.ok ? st.space.name : '团队'}：${res.members.length} 人 · ${seatsText(res.seats)}`,
          ...res.members.map((m) => memberLine(m, ownerId)),
        ].join('\n');
      }

      // ── set-role：改角色 ────────────────────────────────────────────
      if (action === 'set-role') {
        const memberId = String(args.memberId || '').trim();
        const role = String(args.role || '').trim();
        if (!memberId) return '【deck_team】给个 memberId（members 看一眼真实 id）。';
        if (!role) return '【deck_team】改成什么角色？lead / worker / reviewer / viewer。';
        const res = space.setRole({ root, spaceId: sid, memberId, role });
        if (!res.ok) return `【deck_team】没改成。${teamCodeText(res.code, res)}`;
        note('member.set-role', { memberId, from: res.from, to: res.to }, args);
        return `【deck_team】${memberId} 的角色：${res.from} → ${res.to}（审计已记一条）。`;
      }

      // ── share：写共享记忆 ───────────────────────────────────────────
      if (action === 'share') {
        const res = space.shareMemory({
          root,
          spaceId: sid,
          text: args.text,
          scope: args.scope,
          source: args.source,
          ttlDays: args.ttlDays,
          authorId: who,
        });
        if (!res.ok) return `【deck_team】没记住。${teamCodeText(res.code, res)}`;
        note('memory.share', { scope: res.entry.scope, source: res.entry.source, chars: res.entry.text.length }, args);
        const exp = res.entry.expiresAt ? `，${res.entry.expiresAt} 过期` : '，永久有效';
        return `【deck_team】已记住（${res.entry.id}，${res.entry.scope}${exp}）。\n原文：${oneLine(res.entry.text, 200)}`;
      }

      // ── recall：查共享记忆 ──────────────────────────────────────────
      if (action === 'recall') {
        const viewerId = String(args.viewerId || who);
        const res = space.recallTeamMemory({ root, spaceId: sid, query: args.query, viewerId });
        if (!res.ok) return `【deck_team】查不了。${teamCodeText(res.code, res)}`;
        const head = `【deck_team】共享记忆：命中 ${res.totalMatched} 条${args.query ? `（关键词「${args.query}」）` : ''}`;
        if (!res.items.length) {
          return `${head}\n没有匹配的。${res.filtered?.expired ? `（另有 ${res.filtered.expired} 条已过期，自然查不到）` : ''}`;
        }
        const rows = res.items.map((e, i) => {
          const exp = e.expiresAt ? ` · ${e.expiresAt} 过期` : '';
          return `${i + 1}. [${e.scope}] ${oneLine(e.text, 160)}\n   来源 ${e.source || '未知'} · ${e.authorId} · ${e.createdAt}${exp}`;
        });
        const tail = res.filtered?.expired ? `\n另有 ${res.filtered.expired} 条已过期（不返回）` : '';
        return `${head}\n${rows.join('\n')}${tail}`;
      }

      // ── audit-export：导出审计 ──────────────────────────────────────
      if (action === 'audit-export') {
        const res = audit.exportAudit({ root, spaceId: sid, from: args.from, to: args.to, format: args.format });
        if (!res.ok) return `【deck_team】导出失败。${teamCodeText(res.code, res)}`;
        if (!res.count) {
          return '【deck_team】审计是 0 条，没生成空文件。先做点事（建团队/拉人/共享记忆都会留痕）再导出。';
        }
        return `【deck_team】审计已导出：${res.count} 条 · ${res.format}\n路径：${res.path}${res.skipped ? `\n（读取时跳过 ${res.skipped} 行坏数据）` : ''}`;
      }

      // ── audit-sweep：按保留期清理 ──────────────────────────────────
      if (action === 'audit-sweep') {
        const st = space.spaceStatus({ root, spaceId: sid, license: licenseOf() });
        const days = args.days != null ? args.days : (st.ok ? st.policy.auditRetentionDays : 180);
        const res = audit.retentionSweep({ root, spaceId: sid, days });
        if (!res.ok) return `【deck_team】清理失败。${teamCodeText(res.code, res)}`;
        note('audit.sweep', { days, removed: res.removed, kept: res.kept }, args);
        return `【deck_team】审计清理完成：删除 ${res.removed} 条（早于 ${days} 天），保留 ${res.kept} 条。`;
      }

      // ── status：总览（默认） ────────────────────────────────────────
      if (action === 'status') {
        const st = space.spaceStatus({ root, spaceId: sid, license: licenseOf() });
        if (!st.ok) {
          if (st.code === 'no_space') {
            return [
              '【deck_team】还没有团队空间。',
              '说「建一个团队」我就建（默认你当房主，占 1 席）。',
              '未实现（别当成已支持）：sso、scim、private-deploy',
            ].join('\n');
          }
          return `【deck_team】看不了状态。${teamCodeText(st.code, st)}`;
        }
        const a = audit.auditStats({ root, spaceId: st.space.id });
        const roles = Object.entries(st.members.byRole)
          .filter(([, n]) => n > 0)
          .map(([r, n]) => `${r} ${n}`)
          .join(' / ');
        return [
          `【deck_team】团队空间：${st.space.name}（${st.space.id}）`,
          `房主：${st.space.ownerId} · 建于 ${st.space.createdAt}`,
          seatsText(st.seats),
          `成员：${st.members.total} 人（${roles || '无'}）`,
          `共享记忆：team ${st.memory.team} 条 · private ${st.memory.private} 条 · 已过期 ${st.memory.expired} 条`,
          `审计：${a.total} 条${a.lastAt ? `（最近 ${a.lastAt}）` : ''} · 保留 ${st.policy.auditRetentionDays} 天`,
          `未实现（别当成已支持）：${spaceModule.UNIMPLEMENTED.join('、')}`,
        ].join('\n');
      }

      return `【deck_team】不认识的动作 "${action}"。可用：create、join、leave、remove、members、set-role、share、recall、audit-export、audit-sweep、status。`;
    }),
  };
}

export default { createTeamTool, createDeckTeamTool };
