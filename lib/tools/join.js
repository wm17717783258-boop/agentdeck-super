/**
 * tools/join.js —— 暴露给宿主的 `agent_join` 工具（成员入组/查看/派单）
 *
 * 契约（CONTRACTS 2.8）：createJoinTool(deps) => { name, description, parameters, execute }
 *
 * 场景：用户说"把 claude 拉进来当执行者""看看小组里现在有谁""这条任务交给 tester"。
 * 本工具只做"人事"操作，不跑任务——跑任务走 team_orchestrate 或 super_agent。
 *
 * 为什么动作要合并到一个工具：宿主里工具越多，模型选错的概率越大；
 * 用一个 agent_join + action 枚举，模型几乎不会选错。
 */

import {
  callBoard,
  emitSafe,
  listMembers,
  normalizeDeps,
  pickMember,
  resolveTeamId,
  safeExecute,
  TOOL_OUTPUT,
} from './common.js';

const ACTIONS = ['list', 'join', 'leave', 'assign', 'capabilities'];

export function createJoinTool(deps) {
  const d = normalizeDeps(deps);
  return {
    name: 'agent_join',
    description: [
      '管理小组的人：查看当前成员、把某个本地 CLI Agent（claude/codex/dsh 等）拉进小组、移出成员、把任务指派给某人。',
      '什么时候用：用户想"加人/换人/看有谁/指定谁来做"，或者你想确认某角色有没有可用成员时。',
      '注意：它不执行任务；要真正干活请用 team_orchestrate（并行分工）或 super_agent（自己动手）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'list=看成员（默认）；join=拉人进来；leave=移出；assign=指派任务；capabilities=看某成员能力。',
          enum: ACTIONS,
        },
        name: { type: 'string', description: '成员名字/标识（join 时必填；leave/assign/capabilities 时用于定位成员）。' },
        role: { type: 'string', description: '成员角色：lead|architect|critic|worker|tester|scribe。' },
        agent: { type: 'string', description: '本地 CLI 预设或可执行命令，例如 claude / codex / dsh / gemini。' },
        capabilities: { type: 'array', items: { type: 'string' }, description: '能力标签，例如 ["node","python","写文档"]。' },
        teamId: { type: 'string', description: '小组 id（可选，默认当前小组）。' },
        taskId: { type: 'string', description: 'assign 时要指派的任务 id。' },
      },
      required: [],
    },
    execute: safeExecute('agent_join', async (args, exec) => {
      const action = String(args.action || 'list').toLowerCase();
      if (!ACTIONS.includes(action)) {
        return `【agent_join】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      }
      const teamId = await resolveTeamId(d, args, exec);

      if (action === 'list') return renderList(d, teamId);

      if (action === 'join') {
        const name = String(args.name || '').trim();
        if (!name) return '【agent_join】join 需要 name（成员名字，例如 "claude-worker"）。';
        if (!teamId) return '【agent_join】当前没有绑定小组，无法拉人。请先创建/选择一个小组，或传 teamId。';
        const member = {
          name,
          role: String(args.role || 'worker'),
          agent: String(args.agent || args.name || ''),
          capabilities: Array.isArray(args.capabilities) ? args.capabilities.map(String) : [],
          status: 'idle',
          joinedAt: new Date().toISOString(),
        };
        const row = await callBoard(d, 'addMember', teamId, member);
        if (row === undefined) return '【agent_join】宿主没有提供任务板（或 addMember 不可用），无法持久化成员。请检查 board 服务是否注入。';
        emitSafe(d, 'member_join', { teamId, name, role: member.role, agent: member.agent });
        const id = row?.id ?? row?.memberId ?? name;
        return `【agent_join】已加入小组 ${teamId}\n成员：${name}（id: ${id}）\n角色：${member.role}\nCLI：${member.agent || '（与名字相同）'}\n能力：${member.capabilities.join('、') || '未标注'}\n\n提示：现在可以让 team_orchestrate 把 ${member.role} 角色的任务派给他。`;
      }

      if (action === 'leave') {
        const name = String(args.name || '').trim();
        if (!name) return '【agent_join】leave 需要 name。';
        if (!teamId) return '【agent_join】当前没有绑定小组。';
        const member = pickMember(d, name);
        // 先按注册表里的 id 找，找不到就用名字（板子两种都认）
        const target = member?.id || name;
        const res = await callBoard(d, 'removeMember', teamId, target);

        // 三种情况都要说清，绝不许"回一句已移出、其实没动"：
        //   ① 板子没这个方法（老宿主）→ 明说移不了
        //   ② 方法在但没这个人     → 明说没这个人
        //   ③ 真移除了             → 才说成功
        if (res === undefined) {
          return `【agent_join】宿主任务板没有 removeMember 接口，无法移出 ${name}。可以改为把它标记为空闲或调整任务指派。`;
        }
        if (res && res.removed === false) {
          return `【agent_join】没能移出 ${name}：${res.reason || '小组里没有这个人'}。先用 action:"list" 看一眼成员名单。`;
        }
        emitSafe(d, 'member_leave', { teamId, name });
        return `【agent_join】已把 ${name} 移出小组 ${teamId}。注意：他名下未完成的任务需要重新指派。`;
      }

      if (action === 'assign') {
        const name = String(args.name || '').trim();
        const taskId = String(args.taskId || '').trim();
        if (!name || !taskId) return '【agent_join】assign 需要 name 和 taskId。';
        if (!teamId) return '【agent_join】当前没有绑定小组。';
        const member = pickMember(d, name);
        const target = member?.id || name;
        const res = await callBoard(d, 'assignTask', teamId, taskId, target);
        if (res === undefined) {
          return `【agent_join】宿主任务板没有 assignTask 接口，无法指派 ${taskId} 给 ${name}。可以改用 team_orchestrate 让系统自动按角色挑人。`;
        }
        emitSafe(d, 'task_assign', { teamId, taskId, member: target });
        return `【agent_join】已把任务 ${taskId} 指派给 ${member?.name || name}。`;
      }

      // capabilities
      const name = String(args.name || '').trim();
      if (!name) return renderList(d, teamId);
      const member = pickMember(d, name);
      if (!member) return `【agent_join】小组里没找到成员 "${name}"。用 action:"list" 查看现有成员。`;
      const caps = member.raw?.capabilities ?? [];
      return [
        `【agent_join】成员：${member.name}（id: ${member.id}）`,
        `角色：${member.role}`,
        `CLI：${member.agent || '未指定'}`,
        `状态：${member.status}`,
        `能力：${Array.isArray(caps) && caps.length ? caps.join('、') : '未标注'}`,
      ].join('\n');
    }),
    output: TOOL_OUTPUT,
    timeoutMs: 60 * 1000,
  };
}

function renderList(d, teamId) {
  // 两个来源都要看，缺一个就会出现"刚 join 的人看不见"这种自相矛盾：
  //   · 宿主注册表（deps.registry）：环境里探测到的 Agent（Claude Code / Codex / dsh…）
  //   · 任务板成员（board.listMembers）：join 真正写进去的地方
  // 以前这里只看注册表，于是 join 说"已加入"、list 里却没有他 —— 真机验出来的。
  const registryMembers = listMembers(d);
  const boardMembers = (() => {
    const team = String(teamId || '').trim();
    if (!team) return [];
    try {
      const rows = d?.board?.listMembers?.(team);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  })();

  // 合并：同名的以任务板为准（那是"真加进去的"）
  const seen = new Set();
  const members = [];
  for (const m of boardMembers) {
    const name = String(m?.name ?? m?.id ?? '');
    if (!name) continue;
    seen.add(name.toLowerCase());
    members.push({
      id: String(m?.id ?? m?.memberId ?? name),
      name,
      role: String(m?.role ?? 'worker'),
      status: String(m?.status ?? 'idle'),
      agent: String(m?.agent ?? ''),
      capabilities: Array.isArray(m?.capabilities) ? m.capabilities : [],
      from: 'board',
    });
  }
  for (const m of registryMembers) {
    if (seen.has(String(m.name).toLowerCase())) continue;
    members.push({
      id: m.id,
      name: m.name,
      role: m.role,
      status: m.status,
      agent: m.agent,
      capabilities: Array.isArray(m.raw?.capabilities) ? m.raw.capabilities : [],
      from: 'registry',
    });
  }

  if (!members.length) {
    return [
      '【agent_join】小组里还没有登记任何成员。',
      '',
      '下一步：',
      '· 加人：action:"join"，name:"claude-worker"，role:"worker"，agent:"claude"；',
      '· 或者不做分工，直接用 super_agent 自己把活干完。',
    ].join('\n');
  }
  const lines = [`【agent_join】成员列表${teamId ? `（小组 ${teamId}）` : ''}：共 ${members.length} 人`, ''];
  for (const m of members) {
    const caps = m.capabilities.length ? m.capabilities.join('、') : '未标注';
    const tag = m.from === 'board' ? '已登记' : '环境探测';
    lines.push(`· ${m.name}  [${m.role}]  状态：${m.status}  CLI：${m.agent || '未指定'}  能力：${caps}  （${tag}）`);
  }
  const byRole = members.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});
  lines.push('', `角色分布：${Object.entries(byRole).map(([r, n]) => `${r}×${n}`).join('  ') || '无'}`);
  return lines.join('\n');
}

export default { createJoinTool };
