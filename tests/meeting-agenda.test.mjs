/**
 * 1.9 会议升级：议程 / 能力匹配 / 冲突 / 投票 / 裁决。
 *
 * 这一组用例只认一件事：会要开得像会 ——
 *   · 议程项没结论就不许结会（不能靠决议一句话糊过去）；
 *   · 有议程的会结会必须给拍板人 + 理由，缺理由直接拒；
 *   · 派活按能力匹配，匹配不到就明说 no_match，不硬塞；
 *   · 冲突、投票都留痕，改票/未了结的冲突不许被算成已解决；
 *   · 坏了 meta.json 也不能把工具搞崩。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addAgenda,
  assignAgenda,
  castVote,
  concludeMeeting,
  decisionRecordOf,
  decisionText,
  getMeeting,
  isGoverned,
  listMeetings,
  meetingDir,
  openMeeting,
  raiseConflict,
  readMinutes,
  renderMinutes,
  resolveAgendaItem,
  resolveConflict,
  submitProposal,
  tallyVotes,
  unresolvedAgenda,
} from '../lib/meeting/index.js'
import { createMeetingTool } from '../lib/meeting/tool.js'

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-agenda-${label}-`))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

function fakeBoard({ teams = [{ id: 'team_a' }], fail = false } = {}) {
  const calls = []
  return {
    calls,
    async listTeams() {
      return teams
    },
    async addTask(teamId, payload) {
      if (fail) throw new Error('板子拒收')
      calls.push({ teamId, payload })
      return { id: `task_${calls.length}` }
    },
  }
}

async function callTool(tool, args) {
  const out = await tool.execute(args)
  assert.ok(out && typeof out.text === 'string', 'deck_meeting 必须返回 {text}')
  return out.text
}

const CLOCK = () => Date.parse('2026-11-20T09:00:00Z')

// 同一个临时工作区里连开两场会时，会议号是「日期 + 随机 6 位」——
// 时钟写死也照样会撞号，所以每次开会把秒针往前拨一格，别让第二场覆盖第一场。
let clockTick = 0
function tickClock() {
  clockTick += 1
  return () => CLOCK() + clockTick * 60_000
}

/** 开一场带议程的会，所有人名字/能力都固定，省得每个用例重写。 */
function governedMeeting(root, agenda) {
  const res = openMeeting({
    root,
    topic: '1.9 会议升级',
    participants: [
      { name: '小犀', vendor: 'dsh', capabilities: ['node', '写文档'] },
      { name: '小鹿', vendor: 'codex', capabilities: ['codex', '测试'] },
    ],
    agenda,
    now: tickClock(),
  })
  assert.equal(res.ok, true)
  return res.meeting
}

test('议程没结论不许结会：unresolved 逐条点名，补完才放行', async () => {
  const { root, done } = freshRoot('unresolved')
  try {
    const meeting = governedMeeting(root, [
      { id: 'ag_1', title: '定价怎么定' },
      { id: 'ag_2', title: '谁来写文档' },
    ])
    assert.equal(isGoverned(meeting), true)
    assert.equal(unresolvedAgenda(meeting).length, 2)

    const blocked = await concludeMeeting({
      root,
      meetingId: meeting.id,
      decision: '先免费拉人',
      decidedBy: 'lead',
      rationale: '现在最缺的是用户量',
      now: CLOCK,
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'agenda_unresolved')
    assert.deepEqual(blocked.unresolved.map((u) => u.id), ['ag_1', 'ag_2'])
    assert.match(blocked.error, /2 项议程没结论/)
    assert.equal(getMeeting({ root, meetingId: meeting.id }).meeting.status, 'open', '被拦住时不能偷偷改状态')

    const half = resolveAgendaItem({ root, meetingId: meeting.id, agendaId: 'ag_1', conclusion: '基础功能免费，云额度收费', now: CLOCK })
    assert.equal(half.ok, true)
    assert.deepEqual(half.unresolved.map((u) => u.id), ['ag_2'])
    assert.equal((await concludeMeeting({ root, meetingId: meeting.id, decision: 'x', decidedBy: 'lead', rationale: 'y' })).code, 'agenda_unresolved')

    const rest = resolveAgendaItem({ root, meetingId: meeting.id, agendaId: 'ag_2', conclusion: '小犀写 README', by: '小犀', now: CLOCK })
    assert.equal(rest.ok, true)
    assert.equal(rest.unresolved.length, 0)

    const ok = await concludeMeeting({
      root,
      meetingId: meeting.id,
      decision: '基础功能免费，云额度收费',
      decidedBy: 'lead',
      rationale: '先攒口碑，再谈钱',
      now: CLOCK,
    })
    assert.equal(ok.ok, true)
    assert.equal(ok.meeting.status, 'concluded')
    assert.equal(ok.meeting.decision.chosen, '基础功能免费，云额度收费')
    assert.equal(ok.meeting.decision.decidedBy, 'lead')
  } finally {
    done()
  }
})

test('裁决必须有理由：缺 rationale / decidedBy 都拒，且不补默认值', async () => {
  const { root, done } = freshRoot('rationale')
  try {
    const meeting = governedMeeting(root, ['只剩一项议程'])
    resolveAgendaItem({ root, meetingId: meeting.id, agendaId: 'ag_1', conclusion: '就这么办', now: CLOCK })

    const noWhy = await concludeMeeting({ root, meetingId: meeting.id, decision: '定了', decidedBy: 'lead', now: CLOCK })
    assert.equal(noWhy.ok, false)
    assert.equal(noWhy.code, 'rationale_required')
    assert.match(noWhy.error, /为什么/)

    const noBy = await concludeMeeting({ root, meetingId: meeting.id, decision: '定了', rationale: '因为对', now: CLOCK })
    assert.equal(noBy.ok, false)
    assert.equal(noBy.code, 'decidedby_required')

    const noDecision = await concludeMeeting({ root, meetingId: meeting.id, decidedBy: 'lead', rationale: '因为对', now: CLOCK })
    assert.equal(noDecision.ok, false)
    assert.equal(noDecision.code, 'decision_required')

    // 缺理由的尝试没有落盘任何"半个决议"
    const after = getMeeting({ root, meetingId: meeting.id }).meeting
    assert.equal(after.status, 'open')
    assert.equal(decisionRecordOf(after), null)
    assert.equal(after.decision, null)

    const ok = await concludeMeeting({
      root,
      meetingId: meeting.id,
      decision: '就这么办',
      decidedBy: 'lead',
      rationale: '成本最低、当天能上线',
      now: CLOCK,
    })
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.decisionRecord, {
      decidedBy: 'lead',
      rationale: '成本最低、当天能上线',
      chosen: '就这么办',
      conflictsResolved: [],
    })
    const text = readMinutes({ root, meetingId: meeting.id }).text
    assert.match(text, /- 拍板：lead/)
    assert.match(text, /- 理由：成本最低、当天能上线/)
    assert.equal(decisionText(ok.meeting), '就这么办')
    const onDisk = JSON.parse(readFileSync(join(meetingDir(root, meeting.id), 'meta.json'), 'utf8'))
    assert.equal(onDisk.decision.rationale, '成本最低、当天能上线')
    assert.equal(onDisk.decision.chosen, '就这么办')
  } finally {
    done()
  }
})

test('能力匹配：命中就派，匹配不到就 no_match（不硬塞一个人上去）', () => {
  const { root, done } = freshRoot('match')
  try {
    const meeting = governedMeeting(root, [
      { id: 'ag_1', title: '写迁移脚本' },
      { id: 'ag_2', title: '跑回归' },
      { id: 'ag_3', title: '找人做压测' },
    ])

    const hit = assignAgenda({ root, meetingId: meeting.id, agendaId: 'ag_1', capability: 'Node', now: CLOCK })
    assert.equal(hit.ok, true)
    assert.equal(hit.owner, '小犀')
    assert.equal(hit.matchedBy, 'capability')
    assert.equal(getMeeting({ root, meetingId: meeting.id }).meeting.agenda[0].capability, 'node', '能力要归一成小写再存')

    const hit2 = assignAgenda({ root, meetingId: meeting.id, agendaId: 'ag_2', capability: '测试' })
    assert.equal(hit2.owner, '小鹿')

    const miss = assignAgenda({ root, meetingId: meeting.id, agendaId: 'ag_3', capability: 'rust', now: CLOCK })
    assert.equal(miss.ok, false)
    assert.equal(miss.code, 'no_match')
    assert.match(miss.error, /没人认领「rust」/)
    const untouched = getMeeting({ root, meetingId: meeting.id }).meeting.agenda[2]
    assert.equal(untouched.owner, null, 'no_match 不许改写 owner')

    // 直接点名也要在名单里，不在就同样 no_match
    assert.equal(assignAgenda({ root, meetingId: meeting.id, agendaId: 'ag_3', agentId: '小犀' }).owner, '小犀')
    const ghost = assignAgenda({ root, meetingId: meeting.id, agendaId: 'ag_3', agentId: '路上捡的' })
    assert.equal(ghost.code, 'no_match')
    assert.equal(assignAgenda({ root, meetingId: meeting.id, agendaId: 'ag_9', capability: 'node' }).code, 'no_agenda')
    assert.equal(assignAgenda({ root, meetingId: meeting.id, agendaId: 'ag_1' }).code, 'no_match', '既没能力也没点名：如实说匹配不了')
  } finally {
    done()
  }
})

test('冲突：登记要点名双方 + 说清争什么，了结要写清怎么解决', async () => {
  const { root, done } = freshRoot('conflict')
  try {
    const meeting = governedMeeting(root, ['要不要开源'])
    const base = { root, meetingId: meeting.id, agendaId: 'ag_1' }

    assert.equal(raiseConflict({ ...base, between: ['小犀'], summary: 'x' }).code, 'invalid_between')
    assert.equal(raiseConflict({ ...base, between: ['小犀', '小犀'], summary: 'x' }).code, 'invalid_between')
    assert.equal(raiseConflict({ ...base, between: ['小犀', '小鹿'] }).code, 'summary_required')
    assert.equal(raiseConflict({ ...base, agendaId: 'ag_9', between: ['小犀', '小鹿'], summary: 'x' }).code, 'no_agenda')

    const raised = raiseConflict({ ...base, between: ['小犀', '小鹿'], summary: '小犀要 MIT，小鹿要 Apache', by: '小犀', now: CLOCK })
    assert.equal(raised.ok, true)
    assert.equal(raised.conflict.id, 'cf_1')
    assert.equal(raised.conflict.status, 'open')
    assert.deepEqual(raised.conflict.between, ['小犀', '小鹿'])
    assert.equal(raised.conflicts.length, 1)

    assert.equal(resolveConflict({ root, meetingId: meeting.id, conflictId: 'cf_1' }).code, 'resolution_required')
    assert.equal(resolveConflict({ root, meetingId: meeting.id, conflictId: 'cf_404', resolution: 'x' }).code, 'no_conflict')
    const done1 = resolveConflict({ root, meetingId: meeting.id, conflictId: 'cf_1', resolution: '两人各让一步：MIT + 附加专利条款', by: 'lead', now: CLOCK })
    assert.equal(done1.ok, true)
    assert.equal(done1.conflict.status, 'resolved')
    assert.equal(done1.conflict.resolution, '两人各让一步：MIT + 附加专利条款')

    // 未了结的冲突不许被写进 conflictsResolved
    raiseConflict({ ...base, between: ['小犀', '小鹿'], summary: '商标归谁', now: CLOCK })
    resolveAgendaItem({ root, meetingId: meeting.id, agendaId: 'ag_1', conclusion: '开源核心', now: CLOCK })
    const lie = await concludeMeeting({
      root,
      meetingId: meeting.id,
      decision: '开源核心',
      decidedBy: 'lead',
      rationale: '先把生态做起来',
      conflictsResolved: ['cf_1', 'cf_2'],
      now: CLOCK,
    })
    assert.equal(lie.ok, false)
    assert.equal(lie.code, 'conflict_open')
    assert.match(lie.error, /cf_2/)

    const ok = await concludeMeeting({
      root,
      meetingId: meeting.id,
      decision: '开源核心',
      decidedBy: 'lead',
      rationale: '先把生态做起来',
      conflictsResolved: ['cf_1'],
      now: CLOCK,
    })
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.decisionRecord.conflictsResolved, ['cf_1'])
    assert.deepEqual(ok.openConflicts.map((c) => c.id), ['cf_2'], '没解决的冲突要如实列出来')
    assert.match(ok.minutes, /还有 1 条冲突没了结|未了结/)
  } finally {
    done()
  }
})

test('投票：一人一票，改票覆盖并标 revoted，分布随时可查', () => {
  const { root, done } = freshRoot('vote')
  try {
    const meeting = governedMeeting(root, ['选周五还是周一发版'])
    const base = { root, meetingId: meeting.id, agendaId: 'ag_1' }

    assert.equal(castVote({ ...base, choice: '赞成' }).code, 'agent_required')
    assert.equal(castVote({ ...base, agentId: '小犀', choice: '  ' }).code, 'choice_required')
    assert.equal(castVote({ ...base, agendaId: 'ag_9', agentId: '小犀', choice: '赞成' }).code, 'no_agenda')

    const a = castVote({ ...base, agentId: '小犀', choice: '赞成', now: CLOCK })
    assert.equal(a.ok, true)
    assert.equal(a.revoted, false)
    castVote({ ...base, agentId: '小鹿', choice: '反对', now: CLOCK })
    castVote({ ...base, agentId: '小犀', choice: '弃权', now: CLOCK }) // 改票

    const again = castVote({ ...base, agentId: '小犀', choice: '赞成', now: CLOCK })
    assert.equal(again.revoted, true, '同一个人再投一次必须标 revoted')
    assert.equal(again.previous, '弃权')
    assert.equal(again.tally.total, 2, '改票不新增票数（一人一票）')
    assert.deepEqual(again.tally.byChoice, { 反对: 1, 赞成: 1 })
    assert.deepEqual(again.tally.voters.sort(), ['小鹿', '小犀'].sort())

    const upper = castVote({ ...base, agentId: 'Alice', choice: '赞成', now: CLOCK })
    const lower = castVote({ ...base, agentId: 'alice', choice: '反对', now: CLOCK })
    assert.equal(upper.revoted, false)
    assert.equal(lower.revoted, true, '大小写不同也得认成同一个人')

    const meta = getMeeting({ root, meetingId: meeting.id }).meeting
    assert.equal(meta.votes.length, 3)
    assert.equal(tallyVotes(meta.votes, 'ag_1').total, 3)
    assert.match(readMinutes({ root, meetingId: meeting.id }).text, /## 投票/)
  } finally {
    done()
  }
})

test('结会：决议落盘 + 任务带 fromAgendaId + 纪要含议程/投票/冲突', async () => {
  const { root, done } = freshRoot('conclude')
  try {
    const board = fakeBoard()
    const { meeting } = openMeeting({
      root,
      topic: '1.9 落地分工',
      participants: [
        { name: '小犀', vendor: 'dsh', capabilities: ['node'] },
        { name: '小鹿', vendor: 'codex', capabilities: ['测试'] },
      ],
      agenda: [
        { id: 'ag_1', title: '议程持久化' },
        { id: 'ag_2', title: '投票语义' },
      ],
      now: CLOCK,
    })
    assert.equal(meeting.status, 'open')
    const id = meeting.id
    submitProposal({ root, meetingId: id, from: '小犀', vendor: 'dsh', stance: '支持', text: '我来写 meta.json 落盘', now: CLOCK })
    resolveAgendaItem({ root, meetingId: id, agendaId: 'ag_1', conclusion: '先 .tmp 再 rename，写崩也不撕裂', now: CLOCK })
    resolveAgendaItem({ root, meetingId: id, agendaId: 'ag_2', conclusion: '一人一票，改票标 revoted', now: CLOCK })
    castVote({ root, meetingId: id, agendaId: 'ag_2', agentId: '小犀', choice: '赞成', now: CLOCK })
    const cf = raiseConflict({ root, meetingId: id, agendaId: 'ag_2', between: ['小犀', '小鹿'], summary: '改票要不要通知别人', now: CLOCK })
    resolveConflict({ root, meetingId: id, conflictId: cf.conflict.id, resolution: '纪要里显示最新分布 + revoted 标记', now: CLOCK })

    const res = await concludeMeeting({
      root,
      meetingId: id,
      decision: '按议程结论执行，本周内落地',
      decidedBy: 'lead',
      rationale: '两项议程都已定，风险可控',
      conflictsResolved: [cf.conflict.id],
      tasks: [
        { title: '写 meta 原子落盘', role: 'worker', acceptance: '断电不撕裂', fromAgendaId: 'ag_1' },
        { title: '补投票用例', role: 'tester', acceptance: '改票有 revoted', fromAgendaId: 'ag_2' },
        { title: '写 release note', role: 'scribe', acceptance: '一句话说清' },
      ],
      addTask: async (payload) => {
        const added = await board.addTask('team_a', payload)
        return added
      },
      now: CLOCK,
    })
    assert.equal(res.ok, true)
    assert.equal(res.tasksCreated, 3)
    assert.deepEqual(res.meeting.tasks.map((t) => t.fromAgendaId), ['ag_1', 'ag_2', null], '只有一项指向不明时留空，不瞎猜')
    assert.deepEqual(board.calls.map((c) => c.payload.fromAgendaId), ['ag_1', 'ag_2', null], '任务板 payload 也要带来源议程')
    assert.deepEqual(board.calls.map((c) => c.payload.acceptance), ['断电不撕裂', '改票有 revoted', '一句话说清'])

    const text = readMinutes({ root, meetingId: id }).text
    assert.match(text, /## 议程（2 项）/)
    assert.match(text, /结论：先 \.tmp 再 rename，写崩也不撕裂/)
    assert.match(text, /## 投票/)
    assert.match(text, /赞成 1/)
    assert.match(text, /## 冲突（1 条）/)
    assert.match(text, /## 拆出的任务（3 条）/)
    assert.match(text, /来自议程：ag_1/)
    assert.match(text, /- 拍板：lead/)

    const saved = JSON.parse(readFileSync(join(meetingDir(root, id), 'meta.json'), 'utf8'))
    assert.equal(saved.status, 'concluded')
    assert.equal(saved.decision.decidedBy, 'lead')
    assert.deepEqual(saved.decision.conflictsResolved, ['cf_1'])
    assert.deepEqual(saved.taskIds, ['task_1', 'task_2', 'task_3'])
    assert.equal(saved.tasks[0].fromAgendaId, 'ag_1')

    // 指向不存在的议程：直接拒，不写半截
    const meeting2 = governedMeeting(root, ['唯一议程'])
    resolveAgendaItem({ root, meetingId: meeting2.id, agendaId: 'ag_1', conclusion: '完了' })
    const badTask = await concludeMeeting({
      root,
      meetingId: meeting2.id,
      decision: '收工',
      decidedBy: 'lead',
      rationale: '没别的事',
      tasks: [{ title: '瞎指', fromAgendaId: 'ag_404' }],
    })
    assert.equal(badTask.ok, false)
    assert.equal(badTask.code, 'no_agenda')
    assert.equal(getMeeting({ root, meetingId: meeting2.id }).meeting.status, 'open')
  } finally {
    done()
  }
})

test('坏 meta.json 不抛：当没这场会处理，列表也照常', async () => {
  const { root, done } = freshRoot('corrupt')
  try {
    const meeting = governedMeeting(root, ['唯一议程'])
    const file = join(meetingDir(root, meeting.id), 'meta.json')
    writeFileSync(file, '{ 这不是 JSON', 'utf8')

    const got = getMeeting({ root, meetingId: meeting.id })
    assert.equal(got.ok, false)
    assert.match(got.error, /没有这场会/)
    assert.equal(readMinutes({ root, meetingId: meeting.id }).ok, false)
    assert.equal(resolveAgendaItem({ root, meetingId: meeting.id, agendaId: 'ag_1', conclusion: 'x' }).ok, false)
    assert.equal(castVote({ root, meetingId: meeting.id, agendaId: 'ag_1', agentId: 'a', choice: '赞成' }).ok, false)
    const blocked = await concludeMeeting({ root, meetingId: meeting.id, decision: 'x', decidedBy: 'lead', rationale: 'y' })
    assert.equal(blocked.ok, false)

    // 能解析但缺 id 的文件同样当坏文件
    const noId = join(meetingDir(root, 'mtg_20260101_abcdef'), 'meta.json')
    mkdirSync(join(meetingDir(root, 'mtg_20260101_abcdef')), { recursive: true })
    writeFileSync(noId, JSON.stringify({ topic: '没有 id 的残骸' }), 'utf8')
    assert.equal(getMeeting({ root, meetingId: 'mtg_20260101_abcdef' }).ok, false)

    const listed = listMeetings({ root })
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.meetings, [], '坏目录跳过，不影响整份列表')

    // 决议是脏对象（没 chosen）时当"还没定"，不猜也不补默认值
    const dirtyId = 'mtg_20260102_abcdef'
    mkdirSync(meetingDir(root, dirtyId), { recursive: true })
    writeFileSync(
      join(meetingDir(root, dirtyId), 'meta.json'),
      JSON.stringify({
        id: dirtyId,
        topic: '半截决议',
        participants: [],
        createdAt: '2026-01-02T00:00:00.000Z',
        status: 'concluded',
        decision: { decidedBy: 'lead', rationale: '只写了理由没写定了什么' },
      }),
      'utf8',
    )
    const dirty = getMeeting({ root, meetingId: dirtyId }).meeting
    assert.equal(dirty.decision, null)
    assert.equal(decisionRecordOf(dirty), null)
    assert.match(renderMinutes(dirty, []), /（还没定）/)

    // 坏文件不该留下 .tmp 残渣
    const files = readdirSync(meetingsRootOf(root)).flatMap((name) => {
      try {
        return readdirSync(join(meetingsRootOf(root), name)).map((f) => `${name}/${f}`)
      } catch {
        return []
      }
    })
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0)
  } finally {
    done()
  }
})

function meetingsRootOf(root) {
  return join(root, '.agentdeck', 'meetings')
}

test('工具层：open 带议程 → 派活 → 结论 → 投票 → 冲突 → 结会 一路走通', async () => {
  const { root, done } = freshRoot('tool')
  try {
    const board = fakeBoard()
    const tool = createMeetingTool({
      board,
      workspace: root,
      registry: [
        { id: 'r1', name: '小犀', capabilities: ['node', '写文档'] },
        { id: 'r2', name: '小鹿', capabilities: ['测试'] },
      ],
    })

    const opened = await callTool(tool, {
      action: 'open',
      topic: '工具层会议',
      participants: ['小犀:dsh'],
      agenda: [
        { title: '议程持久化' },
        { title: '投票语义' },
      ],
    })
    assert.match(opened, /会开起来了：工具层会议/)
    assert.match(opened, /议程：2 项/)
    assert.match(opened, /\[ag_1\] 议程持久化/)
    const meetingId = opened.match(/会议号：(\S+)/)[1]

    assert.match(await callTool(tool, { action: 'agenda-add', meetingId, agenda: ['额外一条'] }), /加了 1 项议程/)
    assert.match(await callTool(tool, { action: 'agenda', meetingId }), /议程 3 项/)

    const assigned = await callTool(tool, { action: 'agenda-assign', meetingId, agendaId: 'ag_1', capability: 'node' })
    assert.match(assigned, /owner：小犀（按能力 node 匹配）/)
    const miss = await callTool(tool, { action: 'agenda-assign', meetingId, agendaId: 'ag_3', capability: 'gpu' })
    assert.match(miss, /没人能接/)
    assert.match(miss, /不猜、不硬塞/)

    assert.match(await callTool(tool, { action: 'agenda-done', meetingId, agendaId: 'ag_1', conclusion: '先 tmp 再 rename' }), /结论记下了/)
    assert.match(await callTool(tool, { action: 'agenda-done', meetingId, agendaId: 'ag_2', conclusion: '一人一票' }), /还剩 1 项没结论/)
    assert.match(await callTool(tool, { action: 'agenda-done', meetingId, agendaId: 'ag_3', conclusion: '本周收工' }), /可以 conclude/)

    assert.match(await callTool(tool, { action: 'vote', meetingId, agendaId: 'ag_2', agentId: '小犀', choice: '赞成' }), /票记下了/)
    assert.match(await callTool(tool, { action: 'vote', meetingId, agendaId: 'ag_2', agentId: '小犀', choice: '反对' }), /改票记下了/)
    assert.match(await callTool(tool, { action: 'vote', meetingId, agendaId: 'ag_2', agentId: '小鹿', choice: '赞成' }), /共 2 票/)

    const raised = await callTool(tool, { action: 'conflict-raise', meetingId, agendaId: 'ag_2', between: ['小犀', '小鹿'], summary: '改票要不要通知' })
    assert.match(raised, /冲突登记了：cf_1/)
    assert.match(await callTool(tool, { action: 'conflict-resolve', meetingId, conflictId: 'cf_1', resolution: '纪要显示 revoted' }), /冲突了结了/)

    // 缺理由：工具层也要给一句人话，而不是抛
    const noWhy = await callTool(tool, { action: 'conclude', meetingId, decision: '收工', decidedBy: 'lead' })
    assert.match(noWhy, /为什么这么定/)

    const concluded = await callTool(tool, {
      action: 'conclude',
      meetingId,
      decision: '本周收工，按议程结论执行',
      decidedBy: 'lead',
      rationale: '三项议程都定了',
      conflictsResolved: ['cf_1'],
      tasks: [{ title: '写 release note', acceptance: '一句话', fromAgendaId: 'ag_3' }],
    })
    assert.match(concluded, /结会了：工具层会议/)
    assert.match(concluded, /决议：本周收工，按议程结论执行/)
    assert.match(concluded, /拍板：lead｜理由：三项议程都定了/)
    assert.match(concluded, /了结的冲突：cf_1/)
    assert.match(concluded, /来自议程 ag_3/)
    assert.equal(board.calls.length, 1)
    assert.equal(board.calls[0].payload.fromAgendaId, 'ag_3')

    // 裁决落盘就这四个字段（decision = {decidedBy, rationale, chosen, conflictsResolved}），不多不少
    const onDisk = JSON.parse(readFileSync(join(meetingDir(root, meetingId), 'meta.json'), 'utf8'))
    assert.deepEqual(onDisk.decision, {
      decidedBy: 'lead',
      rationale: '三项议程都定了',
      chosen: '本周收工，按议程结论执行',
      conflictsResolved: ['cf_1'],
    })

    assert.match(await callTool(tool, { action: 'show', meetingId }), /## 决议/)
    assert.match(await callTool(tool, { action: 'list' }), /议程 3 项/)
  } finally {
    done()
  }
})

test('老会议兼容：没给议程的会照旧能结（只有显式写了裁决字段才要求成对补齐）', async () => {
  const { root, done } = freshRoot('legacy')
  try {
    const { meeting: plain } = openMeeting({ root, topic: '老会议', participants: ['小犀'], now: CLOCK })
    assert.equal(isGoverned(plain), false)
    submitProposal({ root, meetingId: plain.id, from: '小犀', text: '都听你的', now: CLOCK })
    const res = await concludeMeeting({ root, meetingId: plain.id, decision: '照旧办', tasks: ['收尾'], now: CLOCK })
    assert.equal(res.ok, true, '老会议不能因为新规矩变红')
    assert.equal(res.decisionRecord, null)
    assert.equal(typeof res.meeting.decision, 'string', '老会议那句决议还是纯文本，形态不变')
    assert.equal(decisionText(res.meeting), '照旧办')
    assert.match(res.minutes, /## 决议/)
    assert.match(res.minutes, /照旧办/)
    assert.match(res.minutes, /## 拆出的任务（1 条）/)

    // 老会议一旦显式给了拍板人，就必须补理由
    const { meeting: half } = openMeeting({ root, topic: '老会议-半截', now: tickClock() })
    const noWhy = await concludeMeeting({ root, meetingId: half.id, decision: '定了', decidedBy: 'lead', now: CLOCK })
    assert.equal(noWhy.code, 'rationale_required')
    const full = await concludeMeeting({ root, meetingId: half.id, decision: '定了', decidedBy: 'lead', rationale: '没什么可争的', now: CLOCK })
    assert.equal(full.ok, true)
    assert.equal(full.decisionRecord.decidedBy, 'lead')
  } finally {
    done()
  }
})

test('addAgenda：追加不覆盖已有 id，结会后关闭', async () => {
  const { root, done } = freshRoot('addagenda')
  try {
    const meeting = governedMeeting(root, ['第一项'])
    assert.equal(addAgenda({ root, meetingId: meeting.id, agenda: [] }).ok, false)
    assert.equal(addAgenda({ root, meetingId: meeting.id, agenda: [{ title: '  ' }] }).ok, false)
    const added = addAgenda({ root, meetingId: meeting.id, agenda: ['第二项', { title: '第三项', owner: '小鹿' }], now: CLOCK })
    assert.equal(added.ok, true)
    assert.deepEqual(added.added.map((a) => a.id), ['ag_2', 'ag_3'])
    assert.equal(added.added[1].owner, '小鹿')
    const listed = getMeeting({ root, meetingId: meeting.id }).meeting
    assert.deepEqual(listed.agenda.map((a) => a.title), ['第一项', '第二项', '第三项'])

    for (const a of listed.agenda) resolveAgendaItem({ root, meetingId: meeting.id, agendaId: a.id, conclusion: `结论-${a.id}` })
    const doneMeeting = await concludeMeeting({
      root,
      meetingId: meeting.id,
      decision: '收工',
      decidedBy: 'lead',
      rationale: '三项都定了',
      now: CLOCK,
    })
    assert.equal(doneMeeting.ok, true)
    const late = addAgenda({ root, meetingId: meeting.id, agenda: ['结会后又想加'] })
    assert.equal(late.ok, false)
    assert.match(late.error, /已经结会/)
    assert.equal(existsSync(join(meetingDir(root, meeting.id), 'minutes.md')), true)
  } finally {
    done()
  }
})
