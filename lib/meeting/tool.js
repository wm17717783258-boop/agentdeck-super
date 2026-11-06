/**
 * lib/meeting/tool.js —— `deck_meeting` 工具：让不同厂商的 Agent 坐进同一场会
 *
 * 有它之后，"三个 Agent 开会"就不再是某个宿主里的私事：
 * Claude Code、Codex、DSH 各自通过 MCP 调同一个 deck_meeting，
 * 意见追加进同一份 proposals.jsonl，纪要落盘，任务进同一个任务板。
 *
 * 动作：
 *   open     开会（议题 + 参与人）
 *   submit   发言（谁、什么厂商、支持/反对/补充、说了什么）
 *   conclude 结会（决议 + 拆任务 → 写进任务板 + 出 minutes.md）
 *   show     看纪要
 *   list     看开过哪些会
 */

import { concludeMeeting, listMeetings, openMeeting, readMinutes, renderMinutes, submitProposal, vendorLabel } from './index.js';
import { normalizeDeps, safeExecute, TOOL_OUTPUT, workspaceRoot } from '../tools/common.js';

const ACTIONS = ['open', 'submit', 'conclude', 'show', 'list'];

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
      source: 'meeting',
      meetingId: payload.meetingId,
    });
  };

  return {
    name: 'deck_meeting',
    description: [
      '跨厂商会议：让 Claude / Codex / DSH 这些不同 Agent 把意见写进同一份会议纪要，结会时把决议拆成任务进任务板。',
      'open=开会（topic 必填，participants 可给名字或 {name,vendor}）；submit=发言（meetingId + text，from/vendor/stance 可选）；',
      'conclude=结会（decision 必填，tasks 数组会真写进任务板）；show=看纪要；list=看开过哪些会。',
      '和自己脑内讨论的区别：每条意见都来自真实进程，原样落盘、可追责，不经过模型改写。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'open/submit/conclude/show/list，默认 list。' },
        topic: { type: 'string', description: 'open：议题。' },
        goal: { type: 'string', description: 'open：这场会要解决什么。' },
        participants: { type: 'array', items: { type: 'string' }, description: 'open：参与人名字（也可写 "Claude:claude-code" 这种 名字:厂商）。' },
        meetingId: { type: 'string', description: 'submit/conclude/show：会议号。' },
        from: { type: 'string', description: 'submit：谁在发言（Agent 名/人名）。' },
        vendor: { type: 'string', description: 'submit：哪个厂商的 Agent（claude/codex/dsh/gemini…）。' },
        stance: { type: 'string', enum: ['支持', '反对', '补充'], description: 'submit：态度。' },
        text: { type: 'string', description: 'submit：发言内容。' },
        decision: { type: 'string', description: 'conclude：最终决议（中文一段话）。' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              role: { type: 'string' },
              acceptance: { type: 'string' },
            },
            required: ['title'],
          },
          description: 'conclude：要拆出来的任务。',
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
        const res = openMeeting({ root, topic: args.topic, goal: args.goal, participants });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        const m = res.meeting;
        return [
          `【deck_meeting】会开起来了：${m.topic}`,
          `- 会议号：${m.id}`,
          `- 参与：${m.participants.length ? m.participants.map((p) => `${p.name}${p.vendor ? `（${vendorLabel(p.vendor)}）` : ''}`).join('、') : '（边开边进人）'}`,
          `- 下一步：让每个 Agent 调 deck_meeting action:"submit" meetingId:"${m.id}" 说自己的意见，最后由一个人 action:"conclude"。`,
        ].join('\n');
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

      if (action === 'conclude') {
        const res = await concludeMeeting({
          root,
          meetingId: args.meetingId,
          decision: args.decision,
          tasks: args.tasks,
          teamId: args.teamId,
          addTask: addTaskViaBoard,
        });
        if (!res.ok) return `【deck_meeting】${res.error}`;
        const lines = [
          `【deck_meeting】结会了：${res.meeting.topic}`,
          `- 收到了 ${res.proposals} 条意见`,
          `- 决议：${res.meeting.decision}`,
          `- 纪要：${res.minutesFile}`,
        ];
        if (!res.boardUsed) lines.push('- 注意：宿主没有任务板，任务只写进纪要，没有进任务板。');
        else lines.push(`- 任务：${res.tasksCreated} 条已写进任务板${res.tasksFailed.length ? `，${res.tasksFailed.length} 条没写进去` : ''}`);
        for (const t of res.meeting.tasks || []) lines.push(`  · ${t.taskId ? `[${t.taskId}] ` : ''}${t.title}${t.role ? `（${t.role}）` : ''}`);
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
        return `${i + 1}. ${m.id} — ${m.topic}｜${mark}｜${m.participants.length} 人｜${m.createdAt}`;
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
