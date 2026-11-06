/**
 * M4 跨厂商会议：开会 → 三方各自发言 → 结会出纪要 → 决议拆成任务进任务板。
 *
 * 重点验证两件事：
 *   1. 意见是"原样落盘"的（proposals.jsonl 一行一条，纪要里逐条可追）；
 *   2. 结会拆的任务是真的进了任务板（不是只写在纪要里骗人）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_PROPOSALS,
  STATUS_CONCLUDED,
  concludeMeeting,
  listMeetings,
  meetingDir,
  meetingsRoot,
  newMeetingId,
  openMeeting,
  readMinutes,
  renderMinutes,
  submitProposal,
  vendorLabel,
} from '../lib/meeting/index.js';
import { createMeetingTool, minutesOf } from '../lib/meeting/tool.js';

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-meeting-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeBoard({ teams = [{ id: 'team_a' }], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async listTeams() {
      return teams;
    },
    async addTask(teamId, payload) {
      if (fail) throw new Error('板子拒收');
      calls.push({ teamId, payload });
      return { id: `task_${calls.length}` };
    },
  };
}

async function callTool(tool, args) {
  const out = await tool.execute(args);
  assert.ok(out && typeof out.text === 'string', 'deck_meeting 必须返回 {text}');
  return out.text;
}

test('开会：有议题就建目录，没议题给中文原因', () => {
  const { root, done } = freshRoot('open');
  try {
    const bad = openMeeting({ root });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /议题/);

    const res = openMeeting({ root, topic: '怎么统一任务板', goal: '定接口', participants: ['小犀', { name: '小鹿', vendor: 'codex' }] });
    assert.equal(res.ok, true);
    assert.equal(res.meeting.status, 'open');
    assert.equal(res.meeting.participants.length, 2);
    assert.equal(res.meeting.participants[1].vendor, 'codex');
    assert.ok(existsSync(join(meetingDir(root, res.meeting.id), 'meta.json')));
    assert.ok(existsSync(join(meetingDir(root, res.meeting.id), 'proposals.jsonl')));
    assert.ok(res.meeting.id.startsWith('mtg_'));
    // 会议号带日期，撞不了
    assert.notEqual(newMeetingId(Date.parse('2026-11-05T00:00:00Z')), newMeetingId(Date.parse('2026-11-05T00:00:00Z')));
  } finally {
    done();
  }
});

test('发言：一行一条追加落盘，第一次发言的人自动进名单', () => {
  const { root, done } = freshRoot('submit');
  try {
    const { meeting } = openMeeting({ root, topic: '甲' });
    const id = meeting.id;
    const a = submitProposal({ root, meetingId: id, from: 'Claude Code', vendor: 'claude-code', stance: '支持', text: '我建议先统一任务板' });
    assert.equal(a.ok, true);
    assert.equal(a.count, 1);
    const b = submitProposal({ root, meetingId: id, from: 'Codex', vendor: 'codex', stance: '反对', text: '先统一鉴权再说' });
    assert.equal(b.ok, true);
    assert.equal(b.count, 2);
    // 没标态度默认"补充"；不认识的厂商原样显示
    const c = submitProposal({ root, meetingId: id, from: '人', vendor: 'acme', stance: '随便', text: '都行' });
    assert.equal(c.proposal.stance, '补充');

    const lines = readFileSync(join(meetingDir(root, id), 'proposals.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).text, '我建议先统一任务板');
    assert.deepEqual(JSON.parse(lines[1]).vendor, 'codex');

    // 名单自动长大
    const meta = JSON.parse(readFileSync(join(meetingDir(root, id), 'meta.json'), 'utf8'));
    assert.equal(meta.participants.length, 3);

    // 空意见、不存在的会：都要拒绝
    assert.match(submitProposal({ root, meetingId: id, from: 'x', text: '   ' }).error, /空的/);
    assert.match(submitProposal({ root, meetingId: 'mtg_无此会', text: '甲' }).error, /没有这场会/);
    assert.equal(vendorLabel('claude-code'), 'Claude Code');
    assert.equal(vendorLabel('unknown-vendor'), 'unknown-vendor');
  } finally {
    done();
  }
});

test('纪要：逐条列出谁说了什么、什么态度，末行写明"原样保留不改写"', () => {
  const { root, done } = freshRoot('minutes');
  try {
    const { meeting } = openMeeting({ root, topic: '排期', goal: '定时间' });
    submitProposal({ root, meetingId: meeting.id, from: '小犀', vendor: 'dsh', stance: '支持', text: '周三能交' });
    submitProposal({ root, meetingId: meeting.id, from: '小鹿', vendor: 'claude', stance: '反对', text: '周三太紧，周四' });
    const { text } = readMinutes({ root, meetingId: meeting.id });
    assert.match(text, /# 会议纪要：排期/);
    assert.match(text, /1\. \*\*小犀｜DSH\*\*（支持）：周三能交/);
    assert.match(text, /2\. \*\*小鹿｜Claude\*\*（反对）：周三太紧，周四/);
    assert.match(text, /## 决议/);
    assert.match(text, /（还没定）/);
    assert.match(text, /原样保留，不改写/);
    // 还没结会时 show 也要能给（现拼一份，不落盘）
    assert.match(minutesOf({ root, meetingId: meeting.id }), /排期/);
    assert.match(minutesOf({ root, meetingId: 'mtg_none' }), /找不到这场会/);
  } finally {
    done();
  }
});

test('结会：决议 + 拆任务真的写进任务板，纪要落盘', async () => {
  const { root, done } = freshRoot('conclude');
  try {
    const board = fakeBoard();
    const { meeting } = openMeeting({ root, topic: '上线计划', participants: ['小犀:dsh', '小鹿:codex'] });
    submitProposal({ root, meetingId: meeting.id, from: '小犀', vendor: 'dsh', stance: '支持', text: '我来打包' });
    submitProposal({ root, meetingId: meeting.id, from: '小鹿', vendor: 'codex', stance: '补充', text: '我补回归' });

    const res = await concludeMeeting({
      root,
      meetingId: meeting.id,
      decision: '周三发 1.7.0，小犀打包，小鹿补测试',
      tasks: [{ title: '打 1.7.0 包', role: 'worker', acceptance: 'tgz 能装' }, '补 20 条回归'],
      addTask: async (payload) => board.addTask('team_a', payload),
    });
    assert.equal(res.ok, true);
    assert.equal(res.meeting.status, STATUS_CONCLUDED);
    assert.equal(res.proposals, 2);
    assert.equal(res.tasksCreated, 2);
    assert.equal(res.boardUsed, true);
    // 任务板真收了两条，带 source/meetingId 方便溯源
    assert.equal(board.calls.length, 2);
    assert.equal(board.calls[0].payload.title, '打 1.7.0 包');
    assert.equal(board.calls[0].payload.source, 'meeting');
    assert.equal(board.calls[0].payload.meetingId, meeting.id);
    assert.deepEqual(res.meeting.taskIds, ['task_1', 'task_2']);

    // 纪要文件里的决议与任务都在
    const text = readFileSync(res.minutesFile, 'utf8');
    assert.match(text, /周三发 1\.7\.0/);
    assert.match(text, /## 拆出的任务（2 条）/);
    assert.match(text, /\[task_1\] 打 1\.7\.0 包（worker）｜验收：tgz 能装/);

    // 结完会不再收意见，决议不许覆盖
    assert.match(submitProposal({ root, meetingId: meeting.id, from: 'x', text: '还想说' }).error, /已经结会/);
    const again = await concludeMeeting({ root, meetingId: meeting.id, decision: '改主意' });
    assert.equal(again.ok, false);
    assert.match(again.error, /已经结过/);

    // 没给决议不许结
    const { meeting: m2 } = openMeeting({ root, topic: '乙' });
    assert.match((await concludeMeeting({ root, meetingId: m2.id })).error, /决议/);
  } finally {
    done();
  }
});

test('没有任务板时如实说：任务只在纪要里，boardUsed=false', async () => {
  const { root, done } = freshRoot('noboard');
  try {
    const { meeting } = openMeeting({ root, topic: '丙' });
    const res = await concludeMeeting({ root, meetingId: meeting.id, decision: '就这样', tasks: ['甲任务'] });
    assert.equal(res.ok, true);
    assert.equal(res.boardUsed, false);
    assert.equal(res.tasksCreated, 0);
    assert.match(readFileSync(res.minutesFile, 'utf8'), /甲任务/);
  } finally {
    done();
  }
});

test('意见条数封顶：60 条之后拒绝，并让人先结会', () => {
  const { root, done } = freshRoot('cap');
  try {
    const { meeting } = openMeeting({ root, topic: '长会' });
    for (let i = 0; i < MAX_PROPOSALS; i += 1) {
      assert.equal(submitProposal({ root, meetingId: meeting.id, from: `人${i}`, text: `第 ${i} 条` }).ok, true);
    }
    const over = submitProposal({ root, meetingId: meeting.id, from: '多余', text: '再说一句' });
    assert.equal(over.ok, false);
    assert.match(over.error, /先结会/);
  } finally {
    done();
  }
});

test('工具层：open/submit/conclude/show/list 一路走通，任务落在唯一的小组上', async () => {
  const { root, done } = freshRoot('tool');
  try {
    const board = fakeBoard();
    const tool = createMeetingTool({ board, workspace: root });
    assert.equal(tool.name, 'deck_meeting');

    assert.match(await callTool(tool, { action: '放火' }), /不认识的动作/);
    assert.match(await callTool(tool, { action: 'open' }), /议题/);
    assert.match(await callTool(tool, { action: 'list' }), /还没开过会/);
    assert.match(await callTool(tool, { action: 'show' }), /要给 meetingId/);

    const opened = await callTool(tool, { action: 'open', topic: '要不要开源', participants: ['小犀:dsh', '小鹿:codex'] });
    assert.match(opened, /会开起来了：要不要开源/);
    assert.match(opened, /小犀（DSH）/);
    const meetingId = opened.match(/会议号：(\S+)/)[1];

    const said = await callTool(tool, { action: 'submit', meetingId, from: '小鹿', vendor: 'codex', stance: '支持', text: '开源能拉人' });
    assert.match(said, /记下了（第 1 条）：小鹿（Codex）支持/);

    const concluded = await callTool(tool, {
      action: 'conclude',
      meetingId,
      decision: '开开源核心，收费走云额度',
      tasks: [{ title: '写 LICENSE', acceptance: 'MIT' }],
    });
    assert.match(concluded, /结会了：要不要开源/);
    assert.match(concluded, /收到了 1 条意见/);
    assert.match(concluded, /任务：1 条已写进任务板/);
    assert.equal(board.calls.length, 1);
    assert.equal(board.calls[0].payload.acceptance, 'MIT');

    const shown = await callTool(tool, { action: 'show', meetingId });
    assert.match(shown, /开开源核心/);
    const listed = await callTool(tool, { action: 'list' });
    assert.match(listed, /共 1 场会/);
    assert.match(listed, /✅ 已结会/);
  } finally {
    done();
  }
});

test('多个小组又没指定 teamId：不猜，任务只进纪要（不落错地方）', async () => {
  const { root, done } = freshRoot('multiteam');
  try {
    const board = fakeBoard({ teams: [{ id: 'team_a' }, { id: 'team_b' }] });
    const tool = createMeetingTool({ board, workspace: root });
    const opened = await callTool(tool, { action: 'open', topic: '多组' });
    const meetingId = opened.match(/会议号：(\S+)/)[1];
    const out = await callTool(tool, { action: 'conclude', meetingId, decision: '先不落', tasks: ['甲'] });
    assert.match(out, /没写进去/);
    assert.match(out, /小组不止一个/);
    assert.equal(board.calls.length, 0);

    // 明确指定 teamId 就必须落进去
    const opened2 = await callTool(tool, { action: 'open', topic: '多组-指定' });
    const id2 = opened2.match(/会议号：(\S+)/)[1];
    const out2 = await callTool(tool, { action: 'conclude', meetingId: id2, decision: '落 A', tasks: ['乙'], teamId: 'team_b' });
    assert.match(out2, /任务：1 条已写进任务板/);
    assert.equal(board.calls.length, 1);
    assert.equal(board.calls[0].teamId, 'team_b');
  } finally {
    done();
  }
});

test('会议列表：多场会按时间倒序，坏目录不影响整体', () => {
  const { root, done } = freshRoot('list');
  try {
    openMeeting({ root, topic: '第一场', now: () => Date.parse('2026-11-05T10:00:00Z') });
    const second = openMeeting({ root, topic: '第二场', now: () => Date.parse('2026-11-05T11:00:00Z') });
    const list = listMeetings({ root });
    assert.equal(list.ok, true);
    assert.equal(list.meetings.length, 2);
    assert.equal(list.meetings[0].topic, '第二场');
    assert.ok(list.meetings[0].id === second.meeting.id);
    assert.ok(meetingsRoot(root).endsWith('.agentdeck/meetings') || meetingsRoot(root).endsWith('.agentdeck\\meetings'));
    // 空的渲染也不能崩
    assert.match(renderMinutes({ id: 'mtg_x', topic: '空会', participants: [], createdAt: '', status: 'open' }, []), /还没有人发言/);
    assert.equal(listMeetings({ root: join(root, 'nope') }).meetings.length, 0);
  } finally {
    done();
  }
});
