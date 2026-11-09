/**
 * tests/pet-meeting.test.mjs —— 桌宠主持的站会（lib/pet/meeting.js）
 *
 * 全部本地、无网络：任务板用 createBoard({ root: null }) 的纯内存模式，
 * 模型通道用手写脚本替代，时钟注入固定值。
 *
 * 跑法：node --test --test-concurrency=1 "tests/pet-*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBoard } from '../lib/engine/board.js'
import { buildMinutes, createMeeting, extractConclusion } from '../lib/pet/meeting.js'

/** 固定「现在」：本地时间 2026-11-01 09:00:00 */
const FIXED = new Date(2026, 10, 1, 9, 0, 0)

const PARTICIPANTS = [
  { memberId: 'mem_a', name: '阿甲', role: 'worker', personaHint: '喜欢先把事情拆小，说话简短' },
  { memberId: 'mem_b', name: '阿乙', role: 'tester', personaHint: '关注边界条件和回归测试' },
]

function freshTeam({ withMembers = false } = {}) {
  const board = createBoard({ root: null, now: () => FIXED.getTime() })
  const team = board.createTeam({
    name: '测试队',
    goal: '把登录改造开完会',
    members: withMembers ? [{ name: '甲一号', kind: 'worker' }, { name: '乙一号', kind: 'tester' }] : [],
  })
  return { board, teamId: team.id }
}

/** 按提示词里的身份分流：开场 / 发言 / 收敛 */
function roleOf(system) {
  const text = String(system || '')
  if (text.startsWith('你是团队会议的主持人')) return 'opening'
  if (text.startsWith('你是会议主持人')) return 'converge'
  if (text.startsWith('你是「')) return 'speech'
  return 'other'
}

/**
 * 造一个假模型：script 决定每种提问返回什么。
 * @param {(ctx:{role:string, system:string, user:string, calls:object[]}) => any} script
 */
function fakeChat(script) {
  const calls = []
  const chat = async (req) => {
    const system = String(req.system || '')
    const user = (req.messages && req.messages[0] && req.messages[0].content) || ''
    calls.push({ system, user })
    return script({ role: roleOf(system), system, user, calls })
  }
  chat.calls = calls
  return chat
}

function standardChat(conclusionText) {
  return fakeChat(({ role, system }) => {
    if (role === 'opening') return '各位好，今天把登录改造的边界定下来。'
    if (role === 'speech') {
      const match = system.match(/你是「([^」]+)」/)
      const name = match ? match[1] : '某人'
      return `${name}：我建议先把登录页拆出来，接口改动押后。`
    }
    return conclusionText
  })
}

const GOOD_JSON = JSON.stringify({
  summary: '先拆登录页再改接口',
  decisions: ['本周先做登录页拆分', '接口改造下周排'],
  tasks: [
    { title: '拆登录页组件', role: 'worker', acceptance: '组件能独立渲染', dependsOn: [] },
    { title: '补登录单测', role: 'tester', acceptance: '覆盖率至少 80%', dependsOn: [1] },
    { title: '改登录接口', role: 'worker', acceptance: '联调通过', dependsOn: ['拆登录页组件'] },
  ],
})

test('完整一局：开场 → 两轮发言 → 严格 JSON → 任务落板 → 中文纪要', async () => {
  const { board, teamId } = freshTeam()
  const chat = standardChat(GOOD_JSON)
  const { ok, runMeeting } = createMeeting({ board, chat, now: () => FIXED })
  assert.equal(ok, true)
  assert.equal(typeof runMeeting, 'function')

  const result = await runMeeting({ teamId, topic: '登录改造', participants: PARTICIPANTS, rounds: 2 })

  assert.equal(result.ok, true)
  assert.match(result.meetingId, /^meet_[0-9a-f]{8}$/)
  assert.equal(result.tasks.length, 3)
  assert.deepEqual(
    result.tasks.map((task) => task.title),
    ['拆登录页组件', '补登录单测', '改登录接口'],
  )
  assert.deepEqual(result.tasks[0].dependsOn, [])
  assert.deepEqual(result.tasks[1].dependsOn, [result.tasks[0].id])
  assert.deepEqual(result.tasks[2].dependsOn, [result.tasks[0].id], '按标题写的依赖也应该解析成任务 id')
  assert.equal(result.tasks[2].role, 'worker')
  assert.equal(result.tasks[1].acceptance, '覆盖率至少 80%')
  assert.equal(result.tasks[0].context.meetingId, result.meetingId)
  assert.equal(result.tasks[0].context.topic, '登录改造')
  assert.equal(result.tasks[0].context.from, 'pet_meeting')

  // 任务真的在板子上，且都是 pending
  const onBoard = board.listTasks(teamId)
  assert.equal(onBoard.length, 3)
  assert.ok(onBoard.every((task) => task.status === 'pending'))
  assert.deepEqual(board.stats(teamId), { total: 3, done: 0, failed: 0, running: 0, pending: 3 })

  // 事件里留下了会议记录
  const meetingEvents = board.listEvents(teamId).filter((evt) => evt.kind === 'pet/meeting')
  assert.equal(meetingEvents.length, 1)
  assert.equal(meetingEvents[0].meetingId, result.meetingId)
  assert.deepEqual(meetingEvents[0].tasks, result.tasks.map((task) => task.id))

  // 纪要：摘要 / 逐轮 / 决议 / 任务都要有
  assert.match(result.minutes, /^# 登录改造/)
  assert.match(result.minutes, /## 一句话总结/)
  assert.match(result.minutes, /先拆登录页再改接口/)
  assert.match(result.minutes, /## 第 1 轮/)
  assert.match(result.minutes, /## 第 2 轮/)
  assert.match(result.minutes, /- \*\*阿甲（worker）\*\*：/)
  assert.match(result.minutes, /## 最终决议/)
  assert.match(result.minutes, /1\. 本周先做登录页拆分/)
  assert.match(result.minutes, /## 产出任务/)
  assert.ok(result.minutes.includes(`\`${result.tasks[0].id}\` 拆登录页组件`))
  assert.match(result.minutes, /依赖 `task_[0-9a-f]{10}`/)

  // 发言轮数与人数对得上，personaHint 注进了发言提示词
  const speeches = result.transcript.filter((entry) => entry.phase === 'speech')
  assert.equal(speeches.length, 4)
  assert.deepEqual(speeches.map((entry) => entry.round), [1, 1, 2, 2])
  assert.deepEqual(speeches.map((entry) => entry.speaker.name), ['阿甲', '阿乙', '阿甲', '阿乙'])
  assert.equal(result.transcript[0].phase, 'opening')
  assert.equal(result.transcript[0].speaker.name, '桌宠主持')

  const speechCalls = chat.calls.filter((call) => roleOf(call.system) === 'speech')
  assert.equal(speechCalls.length, 4)
  assert.ok(speechCalls.some((call) => call.system.includes('喜欢先把事情拆小')))
  assert.ok(speechCalls.some((call) => call.system.includes('关注边界条件')))
  assert.ok(speechCalls.every((call) => call.system.includes('登录改造')))
  // 第一轮之后的发言能看到当前纪要
  assert.ok(speechCalls[speechCalls.length - 1].system.includes('当前纪要'))
  assert.equal(chat.calls.length, 6, '开场 1 次 + 发言 4 次 + 收敛 1 次')
})

test('收敛结论写成 ```json 围栏、或夹在解释文字里，都能抽出来', async () => {
  const { board, teamId } = freshTeam()

  const fenced = `好的，这是最终结论：\n\n\`\`\`json\n${GOOD_JSON}\n\`\`\`\n\n以上。`
  const first = await createMeeting({ board, chat: standardChat(fenced), now: () => FIXED }).runMeeting({
    teamId,
    topic: '围栏解析',
    participants: PARTICIPANTS,
    rounds: 1,
  })
  assert.equal(first.ok, true)
  assert.equal(first.tasks.length, 3)

  const prose = `主持人口述如下 {"summary":"一句话","decisions":["只做一件事"],"tasks":[{"title":"写文档","role":"worker","acceptance":"放 docs","dependsOn":[]}]} 就这些`
  const second = await createMeeting({ board, chat: standardChat(prose), now: () => FIXED }).runMeeting({
    teamId,
    topic: '括号扫描',
    participants: PARTICIPANTS,
    rounds: 1,
  })
  assert.equal(second.ok, true)
  assert.equal(second.tasks.length, 1)
  assert.equal(second.tasks[0].title, '写文档')
  assert.match(second.minutes, /一句话/)
})

test('模型胡说八道：如实失败，一个任务都不写进板子', async () => {
  const { board, teamId } = freshTeam()
  const chat = standardChat('我觉得大家说得都挺好，这个事我们回头再聊，先吃饭吧。')
  const result = await createMeeting({ board, chat, now: () => FIXED }).runMeeting({
    teamId,
    topic: '空手而归',
    participants: PARTICIPANTS,
    rounds: 1,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, '模型没有给出可用的会议结论')
  assert.match(result.meetingId, /^meet_/)
  assert.equal(board.listTasks(teamId).length, 0)
  assert.equal(board.listEvents(teamId).filter((evt) => evt.kind === 'pet/meeting').length, 0)

  // JSON 能解析但不是会议结论，同样不算数
  const notAConclusion = await createMeeting({ board, chat: standardChat('{"note":"随便聊聊"}'), now: () => FIXED }).runMeeting({
    teamId,
    topic: '假 JSON',
    participants: PARTICIPANTS,
    rounds: 1,
  })
  assert.equal(notAConclusion.ok, false)
  assert.equal(board.listTasks(teamId).length, 0)
})

test('某位参与者发言失败不影响整场会，纪要里如实标注', async () => {
  const { board, teamId } = freshTeam()
  const chat = fakeChat(({ role, system }) => {
    if (role === 'opening') return '开场。'
    if (role === 'speech') {
      if (system.includes('阿乙')) throw new Error('模型超时')
      return '阿甲：先拆页面。'
    }
    return GOOD_JSON
  })
  const result = await createMeeting({ board, chat, now: () => FIXED }).runMeeting({
    teamId,
    topic: '有人掉线',
    participants: PARTICIPANTS,
    rounds: 1,
  })
  assert.equal(result.ok, true)
  const failed = result.transcript.filter((entry) => entry.phase === 'speech' && !entry.ok)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].speaker.name, '阿乙')
  assert.match(failed[0].text, /这轮没说话/)
  assert.match(result.minutes, /（发言失败）/)
  assert.equal(result.tasks.length, 3)
})

test('轮次与任务数都有上下夹子：rounds 最多 5、tasks 最多 20', async () => {
  const { board, teamId } = freshTeam()
  const manyTasks = JSON.stringify({
    summary: '任务很多',
    decisions: ['先把活拆细'],
    tasks: Array.from({ length: 25 }, (_, i) => ({ title: `任务 ${i + 1}`, role: 'worker', acceptance: '', dependsOn: [] })),
  })
  const chat = standardChat(manyTasks)
  const result = await createMeeting({ board, chat, now: () => FIXED }).runMeeting({
    teamId,
    topic: '夹子',
    participants: [PARTICIPANTS[0]],
    rounds: 9,
    maxTasks: 99,
  })
  assert.equal(result.ok, true)
  assert.equal(result.tasks.length, 20, '任务数夹到 20')
  assert.equal(result.transcript.filter((entry) => entry.phase === 'speech').length, 5, '轮次夹到 5')
  assert.match(result.minutes, /- 轮次：5 轮/)

  // 下限：maxTasks 0 也要给 1 个任务、rounds 0 也要开 1 轮
  const { board: board2, teamId: teamId2 } = freshTeam()
  const small = await createMeeting({ board: board2, chat: standardChat(manyTasks), now: () => FIXED }).runMeeting({
    teamId: teamId2,
    topic: '下限',
    participants: [PARTICIPANTS[0]],
    rounds: 0,
    maxTasks: 0,
  })
  assert.equal(small.ok, true)
  assert.equal(small.tasks.length, 1)
  assert.equal(small.transcript.filter((entry) => entry.phase === 'speech').length, 1)
})

test('依赖只指向更早的任务：自依赖/未知 id/未来序号一律丢掉，绝不造环', async () => {
  const { board, teamId } = freshTeam()
  const cyclic = JSON.stringify({
    summary: '依赖要干净',
    decisions: ['按顺序做'],
    tasks: [
      { title: '第一步', role: 'worker', dependsOn: [] },
      { title: '第二步', role: 'worker', dependsOn: [2, '第一步'] },
      { title: '第三步', role: 'worker', dependsOn: ['1', 'task_不存在', '9'] },
    ],
  })
  const result = await createMeeting({ board, chat: standardChat(cyclic), now: () => FIXED }).runMeeting({
    teamId,
    topic: '依赖',
    participants: [PARTICIPANTS[0]],
    rounds: 1,
  })
  assert.equal(result.ok, true)
  const [first, second, third] = result.tasks
  assert.deepEqual(second.dependsOn, [first.id], '自依赖被丢掉，标题依赖被解析')
  assert.deepEqual(third.dependsOn, [first.id], '未知 id 被丢掉，#1 保留（string "1" 也算序号）')
  for (const task of result.tasks) {
    assert.ok(task.dependsOn.every((dep) => typeof dep === 'string' && dep.startsWith('task_')))
  }
})

test('没有模型 / 没有任务板 / 没议题 / 没队伍 / 没参与人：全部 ok:false 不抛', async () => {
  const { board, teamId } = freshTeam()
  const chat = standardChat(GOOD_JSON)
  const noChat = await createMeeting({ board }).runMeeting({ teamId, topic: 'x', participants: PARTICIPANTS })
  assert.equal(noChat.ok, false)
  assert.match(noChat.reason, /模型通道/)

  const noBoard = await createMeeting({ board: null, chat }).runMeeting({ teamId, topic: 'x' })
  assert.equal(noBoard.ok, false)
  assert.match(noBoard.reason, /任务板/)

  const noTopic = await createMeeting({ board, chat }).runMeeting({ teamId, topic: '   ', participants: PARTICIPANTS })
  assert.equal(noTopic.ok, false)
  assert.match(noTopic.reason, /议题/)

  const noTeam = await createMeeting({ board, chat }).runMeeting({ teamId: 'team_nope', topic: 'x', participants: PARTICIPANTS })
  assert.equal(noTeam.ok, false)
  assert.match(noTeam.reason, /没有这个队/)

  const { board: emptyBoard, teamId: emptyTeam } = freshTeam({ withMembers: false })
  const noPeople = await createMeeting({ board: emptyBoard, chat }).runMeeting({ teamId: emptyTeam, topic: 'x', participants: [] })
  assert.equal(noPeople.ok, false)
  assert.match(noPeople.reason, /参与人/)

  // 什么都不给：拿到的是个仍能调用、只会如实报错的对象
  const bare = createMeeting()
  assert.equal(bare.ok, true)
  const bareResult = await bare.runMeeting({ teamId: 'team_x', topic: 'x' })
  assert.equal(bareResult.ok, false)
  assert.match(bareResult.reason, /任务板/)
})

test('没给 participants 就用队伍成员；信号取消就立刻收手', async () => {
  const { board, teamId } = freshTeam({ withMembers: true })
  const chat = standardChat(GOOD_JSON)
  const result = await createMeeting({ board, chat, now: () => FIXED }).runMeeting({ teamId, topic: '用成员名', rounds: 1 })
  assert.equal(result.ok, true)
  const speechCalls = chat.calls.filter((call) => roleOf(call.system) === 'speech')
  assert.equal(speechCalls.length, 2)
  assert.ok(speechCalls.some((call) => call.system.includes('甲一号')))
  assert.ok(speechCalls.some((call) => call.system.includes('乙一号')))

  const { board: board2, teamId: teamId2 } = freshTeam()
  const chat2 = standardChat(GOOD_JSON)
  const aborted = await createMeeting({ board: board2, chat: chat2, now: () => FIXED }).runMeeting({
    teamId: teamId2,
    topic: '取消',
    participants: PARTICIPANTS,
    rounds: 2,
    signal: { aborted: true },
  })
  assert.equal(aborted.ok, false)
  assert.equal(aborted.reason, '会议已取消')
  assert.equal(chat2.calls.length, 1, '取消后不再向模型提问')
  assert.equal(board2.listTasks(teamId2).length, 0)
})

test('只有决议没任务：照样算成功，纪要如实写“这次没有拆出任务”', async () => {
  const { board, teamId } = freshTeam()
  const onlyDecisions = JSON.stringify({ summary: '结论只要一个', decisions: ['就用方案 A'], tasks: [] })
  const result = await createMeeting({ board, chat: standardChat(onlyDecisions), now: () => FIXED }).runMeeting({
    teamId,
    topic: '只决议',
    participants: PARTICIPANTS,
    rounds: 1,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.tasks, [])
  assert.equal(board.listTasks(teamId).length, 0)
  assert.match(result.minutes, /（这次没有拆出任务）/)
})

test('extractConclusion：严格 JSON / 围栏 / 括号扫描 / 中文键 / 垃圾输入', () => {
  const strict = extractConclusion(GOOD_JSON)
  assert.equal(strict.summary, '先拆登录页再改接口')
  assert.equal(strict.decisions.length, 2)
  assert.equal(strict.tasks.length, 3)
  assert.deepEqual(strict.tasks[1].dependsOn, [1])

  const fenced = extractConclusion(`前言\n\`\`\`json\n{"summary":"S","decisions":["D"]}\n\`\`\`\n后记`)
  assert.equal(fenced.summary, 'S')
  assert.deepEqual(fenced.decisions, ['D'])
  assert.deepEqual(fenced.tasks, [])

  const prose = extractConclusion('我们决定：{"summary":"夹在中间","tasks":[{"title":"T"}]} 结束')
  assert.equal(prose.summary, '夹在中间')
  assert.equal(prose.tasks[0].title, 'T')
  assert.equal(prose.tasks[0].role, 'worker', '缺字段给默认角色')

  const chinese = extractConclusion('{"摘要":"中文键","决议":["甲","乙"],"任务":[{"标题":"做甲","角色":"tester"}]}')
  assert.equal(chinese.summary, '中文键')
  assert.deepEqual(chinese.decisions, ['甲', '乙'])
  assert.equal(chinese.tasks[0].title, '做甲')
  assert.equal(chinese.tasks[0].role, 'tester')

  assert.equal(extractConclusion(''), null)
  assert.equal(extractConclusion(null), null)
  assert.equal(extractConclusion('{"a":1}'), null)
  assert.equal(extractConclusion('[1,2,3]'), null)

  const titleOnly = extractConclusion('拆成两个任务：{"tasks":[{"title":"只有标题"}]}')
  assert.equal(titleOnly.summary, '')
  assert.deepEqual(titleOnly.decisions, [])
  assert.equal(titleOnly.tasks[0].title, '只有标题')

  // 字符串里的花括号不能把扫描带偏
  const tricky = extractConclusion('{"summary":"含 } 和 { 的文本","tasks":[]}')
  assert.equal(tricky.summary, '含 } 和 { 的文本')
})

test('buildMinutes 直接调用也能出干净的中文 Markdown', () => {
  const minutes = buildMinutes({
    meetingId: 'meet_test0001',
    topic: '直接拼纪要',
    startedAt: FIXED.toISOString(),
    hostName: '桌宠主持',
    people: [{ name: '阿甲', role: 'worker' }],
    rounds: 1,
    transcript: [
      { phase: 'opening', round: 0, speaker: { name: '桌宠主持', role: 'host' }, text: '开场白', ok: true },
      { phase: 'speech', round: 1, speaker: { name: '阿甲', role: 'worker' }, text: '我说一句', ok: true },
    ],
    conclusion: { summary: '总结一句', decisions: ['决议一'], tasks: [] },
    created: [],
  })
  assert.match(minutes, /^# 直接拼纪要/)
  assert.match(minutes, /会议号：`meet_test0001`/)
  assert.match(minutes, /## 开场/)
  assert.match(minutes, /开场白/)
  assert.match(minutes, /- \*\*阿甲（worker）\*\*：我说一句/)
  assert.match(minutes, /1\. 决议一/)
  assert.match(minutes, /（这次没有拆出任务）/)
  assert.ok(!minutes.includes('undefined'))
})
