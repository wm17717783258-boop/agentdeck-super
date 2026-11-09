/**
 * lib/meeting/tool.js —— `deck_meeting` 工具：让不同厂商的 Agent 坐进同一场会
 *
 * 有它之后，"三个 Agent 开会"就不再是某个宿主里的私事：
 * Claude Code、Codex、DSH 各自通过 MCP 调同一个 deck_meeting，
 * 意见追加进同一份 proposals.jsonl，纪要落盘，任务进同一个任务板。
 *
 * 动作：
 *   open             开会（议题 + 参与人 + 可选议程）
 *   submit           发言（谁、什么厂商、支持/反对/补充、说了什么）
 *   agenda           看议程（含 owner、结论状态、投票分布、冲突数）
 *   agenda-add       追加议程项
 *   agenda-assign    按能力给议程项派 owner（匹配不到就说 no_match，不硬塞）
 *   agenda-done      给某一项议程写结论
 *   conflict-raise   登记冲突（挂在某项议程上，点名双方 + 争什么）
 *   conflict-resolve 了结冲突（必须写清怎么解决的）
 *   vote             投票（一人一票，改票会标出来并给最新分布）
 *   conclude         结会（决议 + 拍板人 + 理由 + 拆任务 → 任务板 + minutes.md）
 *   show             看纪要
 *   list             看开过哪些会
 */

import {
  addAgenda,
  assignAgenda,
  castVote,
  concludeMeeting,
  decisionText,
  getMeeting,
  listMeetings,
  normalizeCapabilities,
  openMeeting,
  raiseConflict,
  readMinutes,
  renderMinutes,
  resolveAgendaItem,
  resolveConflict,
  submitProposal,
  tallyVotes,
  vendorLabel,
} from './index.js';
import { listMembers, normalizeDeps, safeExecute, TOOL_OUTPUT, workspaceRoot } from '../tools/common.js';

const ACTIONS = [
  'open',
  'submit',
  'agenda',
  'agenda-add',
  'agenda-assign',
  'agenda-done',
  'conflict-raise',
  'conflict-resolve',
  'vote',
  'conclude',
  'show',
  'list',
];

export function createMeetingTool(deps) {
  const d = normalizeDeps(deps);

  /** 决议落地用：把任务板包成 addTask(payload) 形状，缺板子就返回 null 让纪要如实说明。 */
  const addTaskViaBoard = async (payload) => {
    const board = d.board;
    if (!board || typeof board.addTask !== 'function') return null;
    let teamId = payload.teamId;
    if (!teamId) {
      const teams = await board.listTeams?.();
      if (Array.isArray(teams) && teams.length === 1) teamId = teams[0]?.id ?? teams[0]?.teamId ?? null;
      else if (Array.isArray(teams) && teams.length > 1) {
        // 多个小组又没指定：不猜。抛出来让纪要如实写"为什么没落"，别让人以为写进去了
        const names = teams.map((t) => t?.id ?? t?.name).filter(Boolean).slice(0, 5).join('、');
        throw new Error(`小组不止一个（${names}），得给 teamId 才知道落哪个`);
      }
    }
    if (!teamId) return null;
    return board.addTask(teamId, {
      title: payload.title,
      role: payload.role,
      acceptance: payload.acceptance,
      fromAgendaId: payload.fromAgendaId ?? null,
      source: 'meeting',
      meetingId: payload.meetingId,
    });
  };

  /** 能力池：宿主登记的成员（registry 里带 capabilities 的）+ 会议参与人（lib 侧自己会并）。 */
  const agentPool = () => listMembers(d).map((m) => ({
    name: m.name || m.id,
    capabilities: normalizeCapabilities(m.raw?.capabilities ?? m.raw?.capability),
  }));

  return {
    name: 'deck_meeting',
    description: [
      '跨厂商会议：让 Claude / Codex / DSH 这些不同 Agent 把意见写进同一份会议纪要，结会时把决议拆成任务进任务板。',
      'open=开会（topic 必填，agenda 可带议程，participants 可给名字或 {name,vendor,capabilities}）；submit=发言（meetingId + text）；',
      'agenda=看议程；agenda-add=加议程项；agenda-assign=按能力派 owner（capability 匹配不到会直接说 no_match）；agenda-done=写某项结论；',
      'conflict-raise=登记冲突（agendaId + between + summary）；conflict-resolve=了结冲突（conflictId + resolution）；vote=投票（agendaId + agentId + choice，一人一票）；',
      'conclude=结会（有议程的会必须给 decision + decidedBy + rationale，议程没结论或没理由都会被拒）；show=看纪要；list=看开过哪些会。',
      '和自己脑内讨论的区别：每条意见都来自真实进程，原样落盘、可追责，不经过模型改写。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'open/submit/agenda/agenda-add/agenda-assign/agenda-done/conflict-raise/conflict-resolve/vote/conclude/show/list，默认 list。' },
        topic: { type: 'string', description: 'open：议题。' },
        goal: { type: 'string', description: 'open：这场会要解决什么。' },
        participants: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  vendor: { type: 'string' },
                  role: { type: 'string' },
                  capabilities: { type: 'array', items: { type: 'string' } },
                },
                required: ['name'],
              },
            ],
          },
          description: 'open：参与人。可写 "名字:厂商" 字符串，也可写 {name,vendor,role,capabilities:["node","写文档"]}，能力用于 agenda-assign 匹配。',
        },
        agenda: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  owner: { type: 'string' },
                  minutes: { type: 'number' },
                },
                required: ['title'],
              },
            ],
          },
          description: 'open/agenda-add：议程项。给了议程的会，结会时每项都必须有结论。',
        },
        meetingId: { type: 'string', description: 'submit/agenda*/conflict*/vote/conclude/show：会议号。' },
        agendaId: { type: 'string', description: 'agenda-assign/agenda-done/conflict-raise/vote：议程项 id（先用 action:"agenda" 看）。' },
        capability: { type: 'string', description: 'agenda-assign：按这项能力找 owner（如 node、写文档）。匹配不到返回 no_match。' },
        agentId: { type: 'string', description: 'agenda-assign：直接指定 agent；vote：谁投的票（不填用 from）。' },
        conclusion: { type: 'string', description: 'agenda-done：这一项议程的结论。' },
        between: { type: 'array', items: { type: 'string' }, description: 'conflict-raise：冲突双方 [甲, 乙]。' },
        summary: { type: 'string', description: 'conflict-raise：争的是什么。' },
        conflictId: { type: 'string', description: 'conflict-resolve：冲突 id。' },
        resolution: { type: 'string', description: 'conflict-resolve：怎么解决的。' },
        choice: { type: 'string', description: 'vote：选项（赞成/反对/弃权，或自定义词）。' },
        from: { type: 'string', description: 'submit/vote/agenda-done：谁在发言（Agent 名/人名）。' },
        vendor: { type: 'string', description: 'submit：哪个厂商的 Agent（claude/codex/dsh/gemini…）。' },
        stance: { type: 'string', enum: ['支持', '反对', '补充'], description: 'submit：态度。' },
        text: { type: 'string', description: 'submit：发言内容。' },
        decision: { type: 'string', description: 'conclude：最终决议（中文一段话）。' },
        decidedBy: { type: 'string', description: 'conclude：谁拍的板（用户/lead 身份）。有议程的会必填。' },
        rationale: { type: 'string', description: 'conclude：为什么这么定。有议程的会必填，缺了会被拒（rationale_required）。' },
        conflictsResolved: { type: 'array', items: { type: 'string' }, description: 'conclude：这次裁决了结的冲突 id（必须是真的已了结的）。' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              role: { type: 'string' },
              acceptance: { type: 'string' },
              fromAgendaId: { type: 'string' },
            },
            required: ['title'],
          },
          description: 'conclude：要拆出来的任务；fromAgendaId 标明来自哪项议程（追溯用）。',
        },
        teamId: { type: 'string', description: 'conclude：任务落到哪个小组（不填=唯一的小组）。' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('deck_meeting', async (args) => {
      const action = String(args.action || 'list').toLowerCase();
      if (!ACTIONS.includes(action)) return `【deck_meeting】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      const root = workspaceRoot(d);

      if (action === 'open') {
        const participants = (Array.isArray(args.participants) ? args.participants : [])
          .map((p) => {
            if (typeof p !== 'string') return p;
            const [name, vendor] = p.split(':');
            return { name: name.trim(), vendor: (vendor || '').trim() };
          });
        const res = openMeeting({ root, topic: args.topic, goal: args.goal, participants, agenda: args.agenda });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        const m = res.meeting;
        const lines = [
          `【deck_meeting】会开起来了：${m.topic}`,
          `- 会议号：${m.id}`,
          `- 参与：${m.participants.length ? m.participants.map((p) => `${p.name}${p.vendor ? `（${vendorLabel(p.vendor)}）` : ''}${p.capabilities.length ? `[${p.capabilities.join('/')}]` : ''}`).join('、') : '（边开边进人）'}`,
        ];
        if (m.agenda.length) {
          lines.push(`- 议程：${m.agenda.length} 项`);
          for (const a of m.agenda) lines.push(`  · [${a.id}] ${a.title}${a.owner ? `（${a.owner}）` : ''}`);
          lines.push('- 下一步：agenda-assign 按能力派 owner，agenda-done 写每项结论，最后 conclude（要 decidedBy + rationale）。');
        } else {
          lines.push(`- 下一步：让每个 Agent 调 deck_meeting action:"submit" meetingId:"${m.id}" 说自己的意见，最后由一个人 action:"conclude"。`);
        }
        return lines.join('\n');
      }

      if (action === 'submit') {
        const res = submitProposal({
          root,
          meetingId: args.meetingId,
          from: args.from || args.agent || d?.cfg?.name,
          vendor: args.vendor,
          stance: args.stance,
          text: args.text,
        });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        return `【deck_meeting】记下了（第 ${res.count} 条）：${res.proposal.from}（${res.proposal.vendor ? vendorLabel(res.proposal.vendor) : '未标厂商'}）${res.proposal.stance} — ${res.proposal.text.slice(0, 80)}${res.proposal.text.length > 80 ? '…' : ''}`;
      }

      if (action === 'agenda') {
        if (!args.meetingId) return '【deck_meeting】agenda 要给 meetingId（不知道就从 action:"list" 看）。';
        const res = getMeeting({ root, meetingId: args.meetingId });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        const m = res.meeting;
        if (!m.agenda.length) return `【deck_meeting】${m.id} 还没有议程。用 action:"agenda-add" agenda:[{title:"…"}] 补，或新开一场时直接给 agenda。`;
        const lines = [
          `【deck_meeting】${m.topic}｜议程 ${m.agenda.length} 项（${m.status === 'concluded' ? '已结会' : '进行中'}）`,
        ];
        for (const a of m.agenda) {
          const v = tallyVotes(m.votes, a.id);
          const dist = Object.entries(v.byChoice).map(([k, n]) => `${k} ${n}`).join('、');
          lines.push(`- [${a.id}] ${a.title}${a.owner ? `｜owner：${a.owner}${a.capability ? `（${a.capability}）` : ''}` : '｜owner：待认领'}｜${a.status === 'resolved' && a.conclusion ? '✅ 已结论' : '🟡 未结论'}`);
          if (a.conclusion) lines.push(`  · 结论：${a.conclusion}`);
          if (v.total) lines.push(`  · 投票：${dist || '（空）'}（共 ${v.total} 票）`);
        }
        if (m.conflicts.length) {
          const open = m.conflicts.filter((c) => c.status !== 'resolved');
          lines.push(`- 冲突：${m.conflicts.length} 条，未了结 ${open.length} 条${open.length ? `（${open.map((c) => c.id).join('、')}）` : ''}`);
        }
        return lines.join('\n');
      }

      if (action === 'agenda-add') {
        const res = addAgenda({ root, meetingId: args.meetingId, agenda: args.agenda });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        return [`【deck_meeting】加了 ${res.added.length} 项议程：`, ...res.added.map((a) => `- [${a.id}] ${a.title}`)].join('\n');
      }

      if (action === 'agenda-assign') {
        const res = assignAgenda({
          root,
          meetingId: args.meetingId,
          agendaId: args.agendaId,
          capability: args.capability,
          agentId: args.agentId,
          agents: agentPool(),
        });
        if (!res.ok) {
          if (res.code === 'no_match') return `【deck_meeting】没人能接：${res.error}（不猜、不硬塞；可以补 capabilities 或直接给 agentId）`;
          return `【deck_meeting】${res.error}`;
        }
        return `【deck_meeting】[${res.agendaId}] ${res.agenda.title} → owner：${res.owner}（${res.matchedBy === 'capability' ? `按能力 ${res.agenda.capability} 匹配` : '直接指定'}）`;
      }

      if (action === 'agenda-done') {
        const res = resolveAgendaItem({
          root,
          meetingId: args.meetingId,
          agendaId: args.agendaId,
          conclusion: args.conclusion,
          by: args.decidedBy || args.from,
        });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        const left = res.unresolved.length
          ? `还剩 ${res.unresolved.length} 项没结论：${res.unresolved.map((u) => u.id).join('、')}`
          : '议程全部有结论了，可以 conclude。';
        return `【deck_meeting】[${res.agenda.id}] ${res.agenda.title} 的结论记下了：${res.agenda.conclusion}\n- ${left}`;
      }

      if (action === 'conflict-raise') {
        const res = raiseConflict({
          root,
          meetingId: args.meetingId,
          agendaId: args.agendaId,
          between: args.between,
          summary: args.summary,
          by: args.from || args.decidedBy,
        });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        return `【deck_meeting】冲突登记了：${res.conflict.id}｜[${res.conflict.agendaId}] ${res.conflict.between.join(' vs ')}｜${res.conflict.summary}（结会前用 action:"conflict-resolve" 写清怎么解决的）`;
      }

      if (action === 'conflict-resolve') {
        const res = resolveConflict({
          root,
          meetingId: args.meetingId,
          conflictId: args.conflictId,
          resolution: args.resolution,
          by: args.from || args.decidedBy,
        });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        return `【deck_meeting】冲突了结了：${res.conflict.id} — ${res.conflict.resolution}`;
      }

      if (action === 'vote') {
        const res = castVote({
          root,
          meetingId: args.meetingId,
          agendaId: args.agendaId,
          agentId: args.agentId || args.from,
          choice: args.choice,
        });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        const dist = Object.entries(res.tally.byChoice).map(([k, n]) => `${k} ${n}`).join('、');
        const head = res.revoted
          ? `【deck_meeting】改票记下了：${res.agentId} 原投「${res.previous ?? '（未记）'}」，现投「${res.choice}」`
          : `【deck_meeting】票记下了：${res.agentId} → ${res.choice}`;
        return [head, `- 议程 [${res.agendaId}] 当前分布：${dist || '（还没票）'}（共 ${res.tally.total} 票）`].join('\n');
      }

      if (action === 'conclude') {
        const res = await concludeMeeting({
          root,
          meetingId: args.meetingId,
          decision: args.decision,
          tasks: args.tasks,
          teamId: args.teamId,
          decidedBy: args.decidedBy,
          rationale: args.rationale,
          conflictsResolved: args.conflictsResolved,
          addTask: addTaskViaBoard,
        });
        if (!res.ok) {
          const lines = [`【deck_meeting】${res.error}`];
          if (Array.isArray(res.unresolved) && res.unresolved.length) {
            for (const u of res.unresolved) lines.push(`  · [${u.id}] ${u.title}${u.owner ? `（${u.owner}）` : ''}`);
          }
          return lines.join('\n');
        }
        const lines = [
          `【deck_meeting】结会了：${res.meeting.topic}`,
          `- 收到了 ${res.proposals} 条意见`,
          `- 决议：${decisionText(res.meeting)}`,
          `- 纪要：${res.minutesFile}`,
        ];
        if (res.decisionRecord) {
          lines.push(`- 拍板：${res.decisionRecord.decidedBy}｜理由：${res.decisionRecord.rationale}`);
          if (res.decisionRecord.conflictsResolved.length) lines.push(`- 了结的冲突：${res.decisionRecord.conflictsResolved.join('、')}`);
        }
        if (res.openConflicts.length) {
          lines.push(`- ⚠️ 还有 ${res.openConflicts.length} 条冲突没了结：${res.openConflicts.map((c) => c.id).join('、')}（纪要里如实列着，不会被算成已解决）`);
        }
        if (!res.boardUsed) lines.push('- 注意：宿主没有任务板，任务只写进纪要，没有进任务板。');
        else lines.push(`- 任务：${res.tasksCreated} 条已写进任务板${res.tasksFailed.length ? `，${res.tasksFailed.length} 条没写进去` : ''}`);
        for (const t of res.meeting.tasks || []) {
          lines.push(`  · ${t.taskId ? `[${t.taskId}] ` : ''}${t.title}${t.role ? `（${t.role}）` : ''}${t.fromAgendaId ? `｜来自议程 ${t.fromAgendaId}` : ''}`);
        }
        for (const f of res.tasksFailed || []) lines.push(`  · ⚠️ ${f.title} 没写成：${f.why}`);
        return lines.join('\n');
      }

      if (action === 'show') {
        if (!args.meetingId) return '【deck_meeting】show 要给 meetingId（不知道就从 action:"list" 看）。';
        const res = readMinutes({ root, meetingId: args.meetingId });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        return res.text;
      }

      // list
      const res = listMeetings({ root });
      if (!res.meetings.length) return '【deck_meeting】还没开过会。action:"open" + topic 开一场。';
      const rows = res.meetings.slice(0, 20).map((m, i) => {
        const mark = m.status === 'concluded' ? '✅ 已结会' : '🟡 进行中';
        const ag = Array.isArray(m.agenda) && m.agenda.length ? `｜议程 ${m.agenda.length} 项` : '';
        return `${i + 1}. ${m.id} — ${m.topic}｜${mark}｜${m.participants.length} 人${ag}｜${m.createdAt}`;
      });
      return [`【deck_meeting】共 ${res.meetings.length} 场会`, ...rows].join('\n');
    }),
  };
}

/** 给状态页/CLI 复用：直接渲染某场会的纪要文本。 */
export function minutesOf({ root, meetingId }) {
  const meta = readMinutes({ root, meetingId });
  return meta.ok ? meta.text : renderMinutes({ id: meetingId, topic: '（找不到这场会）', participants: [], createdAt: '', status: 'open' }, []);
}

export default { createMeetingTool };
