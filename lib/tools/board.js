/**
 * tools/board.js —— 暴露给宿主的 `team_board` 工具（任务板读写）
 *
 * 契约（CONTRACTS 2.8）：createBoardTool(deps) => { name, description, parameters, execute }
 *
 * 模型需要"看进度/记账"：加任务、领任务、标完成、看统计、翻事件流。
 * 这些操作本身很机械，但如果每次都让模型自己拼 board API 调用，很容易参数写错，
 * 所以包成 action 枚举 + 人话渲染。
 *
 * 重要：任务板是**别人**（plugin-core）的模块，方法名/返回结构可能微调，
 * 因此这里全部用 callBoard 做安全调用：方法缺失或抛错都退化成一句可读提示，绝不炸。
 */

import {
  callBoard,
  clipText,
  emitSafe,
  normalizeDeps,
  requireFields,
  resolveTeamId,
  safeExecute,
  TOOL_OUTPUT,
} from './common.js';

const ACTIONS = ['list', 'add', 'done', 'fail', 'claim', 'next', 'stats', 'events', 'create', 'teams'];

export function createBoardTool(deps) {
  const d = normalizeDeps(deps);
  return {
    name: 'team_board',
    description: [
      '直接读写小组任务板：建小组/查小组/查任务/加任务/标记完成/领取任务/看统计和事件流。',
      '什么时候用：你要把长任务记下来防止遗漏、查看别人做到哪了、或者把某条任务标成完成/失败。',
      '第一次用并且还没有小组时，先用 action:"create" 建一个小组（会返回 teamId），之后动作都要带这个 teamId。',
      '需要真正执行任务的请用 super_agent / team_orchestrate；本工具只负责记账。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'list=看任务（默认）；add=加任务；done=标完成；fail=标失败；claim=领取；next=取我的下一条；stats=看统计；events=看事件流；create=新建小组；teams=列出所有小组。',
          enum: ACTIONS,
        },
        teamId: { type: 'string', description: '小组 id（可选，默认当前小组）。' },
        taskId: { type: 'string', description: '任务 id（done/fail/claim 时必填）。' },
        title: { type: 'string', description: '任务标题（add 时必填）。' },
        name: { type: 'string', description: '小组名（create 时必填）。' },
        goal: { type: 'string', description: '小组目标（create 时填写，便于之后找回上下文）。' },
        members: { type: 'array', items: { type: 'string' }, description: '建组时一并加入的成员名（create 时可选）。' },
        role: { type: 'string', description: '负责角色：lead|architect|critic|worker|tester|scribe。' },
        acceptance: { type: 'string', description: '验收标准（add 时强烈建议填写）。' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的任务 id。' },
        output: { type: 'string', description: '完成说明/产出摘要（done 时填写）。' },
        note: { type: 'string', description: '补充说明或失败原因。' },
        memberId: { type: 'string', description: '领取/查询时指定成员 id。' },
        status: { type: 'string', description: 'list 时按状态过滤：todo|doing|done|failed。' },
        limit: { type: 'number', description: 'events 最多显示几条，默认 20。' },
      },
      required: [],
    },
    execute: safeExecute('team_board', async (args, exec) => {
      const action = String(args.action || 'list').toLowerCase();
      if (!ACTIONS.includes(action)) return `【team_board】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      if (!d.board) return '【team_board】宿主没有注入任务板服务（deps.board 缺失），暂时无法读写任务。可以先用文件记录进度（fs_write）。';

      // create / teams 不需要既有 teamId：它们本身就是"怎么弄出一个小队"的入口。
      if (action === 'teams') {
        const teams = await callBoard(d, 'listTeams');
        if (teams === undefined) return '【team_board】listTeams 调用失败，暂时看不到小组列表。';
        if (!Array.isArray(teams) || !teams.length) return '【team_board】还没有任何小组。用 action:"create"、参数 name 建一个。';
        const rows = teams.map((t, i) => {
          const id = t?.id ?? t?.teamId ?? '?';
          const members = Array.isArray(t?.members) ? t.members.length : 0;
          return `${i + 1}. ${id} — ${t?.name ?? '(未命名)'}${t?.goal ? `｜目标：${clipText(String(t.goal), 100)}` : ''}${members ? `｜成员 ${members} 人` : ''}`;
        });
        return [`【team_board】共 ${teams.length} 个小组`, ...rows].join('\n');
      }

      if (action === 'create') {
        const name = String(args.name || args.title || '').trim();
        const bad = requireFields({ name }, ['name']);
        if (bad) return `【team_board】create 需要 name（小组名），例如 {"action":"create","name":"支付重构","goal":"把支付模块拆干净"}。`;
        const members = Array.isArray(args.members)
          ? args.members.map((m) => (typeof m === 'string' ? { name: m } : m && typeof m === 'object' ? m : null)).filter(Boolean)
          : [];
        const team = await callBoard(d, 'createTeam', { name, goal: String(args.goal || ''), members });
        if (team === undefined) return '【team_board】createTeam 调用失败（接口缺失或抛错），小组没有创建。';
        const teamId = team?.id ?? team?.teamId ?? '(未知 id)';
        emitSafe(d, 'team_create', { teamId, name, members: members.length });
        return [
          `【team_board】已创建小组 ${teamId}（${name}）`,
          String(args.goal || '') ? `目标：${String(args.goal)}` : '目标：（未填写，建议补 goal 便于之后找回上下文）',
          members.length ? `成员：${members.map((m) => m.name || m.id).join('、')}` : '成员：（暂无，可用 agent_join 或 super_agent 带入）',
          `下一步：用 {"action":"add","teamId":"${teamId}","title":"…","acceptance":"…"} 落任务，或用 team_orchestrate 直接开跑。`,
        ].join('\n');
      }

      const teamId = await resolveTeamId(d, args, exec);
      if (!teamId) return '【team_board】当前没有绑定小组，无法操作任务板。请传 teamId，或先用 {"action":"create","name":"…"} 建一个小组，也可以用 {"action":"teams"} 看看现有小组。';

      switch (action) {
        case 'list': {
          const rows = await callBoard(d, 'listTasks', teamId, args.status ? { status: String(args.status) } : {});
          return renderTasks(teamId, rows, args.status);
        }
        case 'add': {
          const bad = requireFields(args, ['title']);
          if (bad) return `【team_board】${bad}`;
          const payload = {
            title: String(args.title),
            role: String(args.role || 'worker'),
            acceptance: String(args.acceptance || ''),
            dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [],
            note: String(args.note || ''),
          };
          const row = await callBoard(d, 'addTask', teamId, payload);
          if (row === undefined) return '【team_board】addTask 调用失败（接口缺失或抛错），任务没有写进任务板。';
          const id = row?.id ?? row?.taskId ?? '(未知 id)';
          emitSafe(d, 'task_add', { teamId, taskId: id, title: payload.title, role: payload.role });
          return [
            `【team_board】已添加任务 ${id}`,
            `标题：${payload.title}`,
            `角色：${payload.role}`,
            `验收：${payload.acceptance || '（未填写，建议补上）'}`,
            payload.dependsOn.length ? `依赖：${payload.dependsOn.join(',')}` : '依赖：无（可立即开始）',
          ].join('\n');
        }
        case 'done': {
          const bad = requireFields(args, ['taskId']);
          if (bad) return `【team_board】${bad}`;
          const res = await callBoard(d, 'completeTask', teamId, String(args.taskId), {
            output: clipText(String(args.output || args.note || ''), 4000),
          });
          if (res === undefined) return `【team_board】completeTask 调用失败，任务 ${args.taskId} 状态未更新。`;
          emitSafe(d, 'task_done', { teamId, taskId: args.taskId });
          return `【team_board】任务 ${args.taskId} 已标记完成。${args.output ? `\n产出摘要：${clipText(String(args.output), 800)}` : ''}`;
        }
        case 'fail': {
          const bad = requireFields(args, ['taskId']);
          if (bad) return `【team_board】${bad}`;
          const reason = String(args.note || args.output || '未说明原因');
          const res = await callBoard(d, 'failTask', teamId, String(args.taskId), reason);
          if (res === undefined) return `【team_board】failTask 调用失败，任务 ${args.taskId} 状态未更新。`;
          emitSafe(d, 'task_failed', { teamId, taskId: args.taskId, reason });
          return `【team_board】任务 ${args.taskId} 已标记失败，原因：${reason}`;
        }
        case 'claim': {
          const bad = requireFields(args, ['taskId']);
          if (bad) return `【team_board】${bad}`;
          const res = await callBoard(d, 'claimTask', teamId, String(args.taskId), args.memberId ? String(args.memberId) : undefined);
          if (res === undefined) return `【team_board】claimTask 调用失败，任务 ${args.taskId} 未领取。`;
          return `【team_board】已领取任务 ${args.taskId}${args.memberId ? `（成员 ${args.memberId}）` : ''}。现在可以用 super_agent 把它做完。`;
        }
        case 'next': {
          const row = await callBoard(d, 'nextTaskFor', teamId, args.memberId ? String(args.memberId) : undefined);
          if (row === undefined) return '【team_board】nextTaskFor 调用失败，暂时拿不到下一条任务。';
          if (!row) return '【team_board】当前没有可领取的任务（都已完成或依赖未满足）。';
          return [
            `【team_board】下一条任务：${row.id ?? row.taskId ?? '(未知 id)'}`,
            `标题：${row.title || '(无标题)'}`,
            `角色：${row.role || '未指定'}`,
            `验收：${row.acceptance || '（未填写）'}`,
          ].join('\n');
        }
        case 'stats': {
          const st = await callBoard(d, 'stats', teamId);
          if (st === undefined) return '【team_board】stats 调用失败，暂时拿不到统计。';
          if (!st || typeof st !== 'object') return `【team_board】统计结果：${String(st)}`;
          const pretty = Object.entries(st)
            .map(([k, v]) => `· ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join('\n');
          return `【team_board】小组 ${teamId} 统计\n${pretty}`;
        }
        case 'events': {
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
          const rows = await callBoard(d, 'listEvents', teamId, { limit });
          if (rows === undefined) return '【team_board】listEvents 调用失败，暂时拿不到事件流。';
          if (!Array.isArray(rows) || !rows.length) return '【team_board】还没有任何事件记录。';
          const lines = rows.slice(-limit).map((e, i) => {
            const t = e?.at || e?.ts || e?.time || '';
            const kind = e?.kind || e?.type || 'event';
            const text = e?.text ?? e?.message ?? e?.title ?? '';
            return `${i + 1}. ${t ? `[${t}] ` : ''}${kind}${text ? ` — ${clipText(String(text), 160)}` : ''}`;
          });
          return `【team_board】事件流（最近 ${lines.length} 条）\n${lines.join('\n')}`;
        }
        default:
          return `【team_board】未实现的动作 ${action}`;
      }
    }),
    output: TOOL_OUTPUT,
    timeoutMs: 60 * 1000,
  };
}

function renderTasks(teamId, rows, statusFilter) {
  if (rows === undefined) return '【team_board】listTasks 调用失败（接口缺失或抛错），无法读取任务。';
  if (!Array.isArray(rows) || !rows.length) {
    return `【team_board】小组 ${teamId} 的任务板是空的${statusFilter ? `（筛选：${statusFilter}）` : ''}。可以用 action:"add" 加任务，或让 team_orchestrate 自动拆解落板。`;
  }
  const mark = (t) => (t === 'done' ? '✓' : t === 'failed' ? '✗' : t === 'doing' ? '▶' : '·');
  const lines = [`【team_board】小组 ${teamId} 任务（${rows.length} 条${statusFilter ? `，筛选 ${statusFilter}` : ''}）`, ''];
  for (const r of rows) {
    const id = r?.id ?? r?.taskId ?? '?';
    const st = String(r?.status ?? 'todo');
    const deps = Array.isArray(r?.dependsOn) && r.dependsOn.length ? ` 依赖:${r.dependsOn.join(',')}` : '';
    const who = r?.assignee || r?.owner ? ` 负责:${r.assignee || r.owner}` : '';
    lines.push(`${mark(st)} ${id} [${st}] ${r?.title ?? '(无标题)'}${r?.role ? `  角色:${r.role}` : ''}${who}${deps}`);
    if (r?.acceptance) lines.push(`    验收：${clipText(String(r.acceptance), 120)}`);
  }
  const done = rows.filter((r) => String(r?.status) === 'done').length;
  lines.push('', `进度：完成 ${done}/${rows.length}`);
  return lines.join('\n');
}

export default { createBoardTool };
