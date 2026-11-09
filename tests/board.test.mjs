/**
 * tests/board.test.mjs —— 任务板契约测试（node --test，不烧任何模型配额）
 *
 * 覆盖 CONTRACTS §2.1 的全部方法 + 三条真正危险的语义：
 *  1) 依赖门：未满足依赖的任务永远不会被 nextTaskFor / waitForTask 交出去；
 *  2) 抢占原子性：两个「进程」（两个 board 实例指向同一 root）不会认领到同一个任务；
 *  3) 落盘/重载：新实例能读到旧实例的状态，坏文件不会让板子丢状态或崩掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBoard, TASK_STATUS } from '../lib/engine/board.js'

/** 每个测试一个独立状态目录，互不干扰；用 tmpdir 免得污染 DSH_HOME。 */
function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentdeck-board-${label}-`))
  return dir
}

function newBoard(root, extra = {}) {
  return createBoard({ root, pollIntervalMs: 5, lockWaitMs: 2000, ...extra })
}

test('建队 / 取队 / 列队：Team 形状符合契约', () => {
  const board = newBoard(tempRoot('team'))
  const team = board.createTeam({ name: '交付小组', goal: '做出一个插件' })
  assert.equal(typeof team.id, 'string')
  assert.equal(team.name, '交付小组')
  assert.equal(team.goal, '做出一个插件')
  assert.deepEqual(team.members, [])
  assert.ok(team.createdAt)

  assert.deepEqual(board.getTeam(team.id), team)
  assert.equal(board.getTeam('team_missing'), null)
  assert.equal(board.listTeams().length, 1)
})

test('建队时可带入成员：Member 形状正确且可从 listMembers 读到', () => {
  const board = newBoard(tempRoot('member'))
  const team = board.createTeam({ name: 't', goal: 'g', members: [{ id: 'm1', name: 'claude', kind: 'cli' }] })
  const members = board.listMembers(team.id)
  assert.equal(members.length, 1)
  assert.equal(members[0].id, 'm1')
  assert.equal(members[0].name, 'claude')
  assert.equal(members[0].kind, 'cli')
  assert.ok(members[0].joinedAt)

  const added = board.addMember(team.id, { name: 'codex', kind: 'cli', manifest: { cmd: 'codex' } })
  assert.equal(board.listMembers(team.id).length, 2)
  assert.deepEqual(added.manifest, { cmd: 'codex' })
  assert.equal(board.getTeam(team.id).members.length, 2)
})

test('addTask：默认 pending、依赖与验收字段原样保留', () => {
  const board = newBoard(tempRoot('task'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const task = board.addTask(team.id, {
    title: '写 README',
    role: 'scribe',
    acceptance: ['有中文说明', '有安装步骤'],
    dependsOn: [],
  })
  assert.equal(task.status, TASK_STATUS.PENDING)
  assert.equal(task.title, '写 README')
  assert.equal(task.role, 'scribe')
  assert.deepEqual(task.acceptance, ['有中文说明', '有安装步骤'])
  assert.deepEqual(task.dependsOn, [])
  assert.equal(task.assignee, null)
  assert.equal(board.listTasks(team.id).length, 1)
})

test('listTasks 支持 status / assignee 过滤', () => {
  const board = newBoard(tempRoot('filter'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const a = board.addTask(team.id, { title: 'A', role: 'worker', assignee: 'm1' })
  board.addTask(team.id, { title: 'B', role: 'worker' })
  board.claimTask(team.id, a.id, 'm1')

  assert.equal(board.listTasks(team.id).length, 2)
  assert.deepEqual(board.listTasks(team.id, { status: 'running' }).map((t) => t.id), [a.id])
  assert.deepEqual(board.listTasks(team.id, { assignee: 'm1' }).map((t) => t.id), [a.id])
  assert.equal(board.listTasks(team.id, { status: 'done' }).length, 0)
})

test('claimTask 抢占式：第二次认领必须失败', () => {
  const board = newBoard(tempRoot('claim'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const task = board.addTask(team.id, { title: 'A', role: 'worker' })

  assert.equal(board.claimTask(team.id, task.id, 'm1'), true)
  assert.equal(board.claimTask(team.id, task.id, 'm2'), false)
  assert.equal(board.claimTask(team.id, 'task_ghost', 'm1'), false)

  const claimed = board.listTasks(team.id)[0]
  assert.equal(claimed.status, TASK_STATUS.RUNNING)
  assert.equal(claimed.assignee, 'm1')
})

test('依赖门：依赖未完成时 nextTaskFor 不交任务，完成后立刻可领', () => {
  const board = newBoard(tempRoot('deps'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const first = board.addTask(team.id, { title: '设计', role: 'architect' })
  const second = board.addTask(team.id, { title: '实现', role: 'worker', dependsOn: [first.id] })

  assert.equal(board.nextTaskFor(team.id, 'm1').id, first.id)
  board.claimTask(team.id, first.id, 'm1')
  assert.equal(board.nextTaskFor(team.id, 'm2'), null, 'first 还在跑，second 的依赖没满足')

  board.completeTask(team.id, first.id, { ok: true, output: '设计稿' })
  assert.equal(board.nextTaskFor(team.id, 'm2').id, second.id)
})

test('依赖失败：上游 failed 不算满足，下游不会被派出去', () => {
  const board = newBoard(tempRoot('depsfail'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const first = board.addTask(team.id, { title: '设计', role: 'architect' })
  board.addTask(team.id, { title: '实现', role: 'worker', dependsOn: [first.id] })

  board.claimTask(team.id, first.id, 'm1')
  board.failTask(team.id, first.id, '需求不清晰')
  assert.equal(board.nextTaskFor(team.id, 'm2'), null)
  assert.equal(board.listTasks(team.id)[0].note, '需求不清晰')
})

test('指派优先：指派给别人的任务不会被抢，指派给自己的排最前', () => {
  const board = newBoard(tempRoot('assign'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  board.addTask(team.id, { title: '公共活', role: 'worker' })
  const mine = board.addTask(team.id, { title: '我的活', role: 'worker', assignee: 'm1' })
  const others = board.addTask(team.id, { title: '别人的活', role: 'worker', assignee: 'm2' })

  assert.equal(board.nextTaskFor(team.id, 'm1').id, mine.id)
  assert.equal(board.nextTaskFor(team.id, 'm2').id, others.id)
  const m3 = board.nextTaskFor(team.id, 'm3')
  assert.equal(m3.title, '公共活')
})

test('completeTask：ok=false 记为 failed，ok=true 记 done 并保留 output', () => {
  const board = newBoard(tempRoot('complete'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const a = board.addTask(team.id, { title: 'A', role: 'worker' })
  const b = board.addTask(team.id, { title: 'B', role: 'worker' })

  board.claimTask(team.id, a.id, 'm1')
  const done = board.completeTask(team.id, a.id, { ok: true, output: '产物路径 D:/out', note: '自检通过' })
  assert.equal(done.status, TASK_STATUS.DONE)
  assert.equal(done.output, '产物路径 D:/out')
  assert.equal(done.note, '自检通过')
  assert.ok(done.finishedAt)

  board.claimTask(team.id, b.id, 'm1')
  const failed = board.completeTask(team.id, b.id, { ok: false, output: '崩了' })
  assert.equal(failed.status, TASK_STATUS.FAILED)
  assert.equal(failed.output, '崩了')
})

test('stats：total/done/failed/running/pending 之和等于总数', () => {
  const board = newBoard(tempRoot('stats'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const ids = ['A', 'B', 'C', 'D'].map((title) => board.addTask(team.id, { title, role: 'worker' }))
  board.claimTask(team.id, ids[0].id, 'm1')
  board.completeTask(team.id, ids[0].id, { ok: true, output: 'ok' })
  board.claimTask(team.id, ids[1].id, 'm1')
  board.completeTask(team.id, ids[1].id, { ok: false, output: 'bad' })
  board.claimTask(team.id, ids[2].id, 'm1')

  assert.deepEqual(board.stats(team.id), { total: 4, done: 1, failed: 1, running: 1, pending: 1 })
  const sum = Object.entries(board.stats(team.id))
    .filter(([key]) => key !== 'total')
    .reduce((acc, [, value]) => acc + value, 0)
  assert.equal(sum, 4)
})

test('appendEvent / listEvents：seq 单调递增，sinceSeq 增量拉取', () => {
  const board = newBoard(tempRoot('events'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const task = board.addTask(team.id, { title: 'A', role: 'worker' })
  board.claimTask(team.id, task.id, 'm1')
  board.appendEvent(team.id, { kind: 'chat', text: '收到，开始干', from: 'm1' })

  const all = board.listEvents(team.id)
  assert.ok(all.length >= 4, `建队/加任务/认领/聊天都应留痕，实际 ${all.length} 条`)
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(all[i].seq > all[i - 1].seq, 'seq 必须严格递增')
  }
  assert.equal(all.at(-1).kind, 'chat')
  assert.equal(all.at(-1).from, 'm1')

  const since = board.listEvents(team.id, all[1].seq)
  assert.ok(since.every((evt) => evt.seq > all[1].seq))
  assert.equal(board.listEvents(team.id, all.at(-1).seq).length, 0)
})

test('waitForTask：没活时按超时返回 null，不会永久挂住', async () => {
  const board = newBoard(tempRoot('wait-timeout'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const startedAt = Date.now()
  const task = await board.waitForTask(team.id, 'm1', { timeoutMs: 120 })
  const elapsed = Date.now() - startedAt
  assert.equal(task, null)
  assert.ok(elapsed >= 100, `至少要等满超时，实际 ${elapsed}ms`)
  assert.ok(elapsed < 3000, `不能远超超时，实际 ${elapsed}ms`)
})

test('waitForTask：等待期间有新任务立刻醒来并认领（长轮询语义）', async () => {
  const board = newBoard(tempRoot('wait-wake'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const pending = board.waitForTask(team.id, 'm1', { timeoutMs: 3000 })
  setTimeout(() => board.addTask(team.id, { title: '后来的活', role: 'worker' }), 40)

  const task = await pending
  assert.ok(task, '应该在超时前拿到任务')
  assert.equal(task.title, '后来的活')
  assert.equal(task.status, TASK_STATUS.RUNNING, '长轮询交出的任务必须已认领，否则两个外部 Agent 会撞车')
  assert.equal(task.assignee, 'm1')
})

test('waitForTask 并发：两个成员抢同一批任务，不会拿到同一个', async () => {
  const board = newBoard(tempRoot('wait-race'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  board.addTask(team.id, { title: '只有一个', role: 'worker' })

  const [a, b] = await Promise.all([
    board.waitForTask(team.id, 'm1', { timeoutMs: 300 }),
    board.waitForTask(team.id, 'm2', { timeoutMs: 300 }),
  ])
  const got = [a, b].filter(Boolean)
  assert.equal(got.length, 1, '同一个任务只能被一个成员拿到')
})

test('跨实例落盘：新 board 能读到旧 board 的状态（同一 root）', () => {
  const root = tempRoot('persist')
  const first = newBoard(root)
  const team = first.createTeam({ name: 't', goal: 'g' })
  const task = first.addTask(team.id, { title: 'A', role: 'worker' })
  first.claimTask(team.id, task.id, 'm1')
  first.flush()

  const second = newBoard(root)
  assert.equal(second.getTeam(team.id).name, 't')
  assert.equal(second.listTasks(team.id)[0].status, TASK_STATUS.RUNNING)
  assert.equal(second.location().storage, 'file')

  // 一个实例压缩状态后，另一个实例（读到新指纹）也必须看得到
  const third = newBoard(root)
  third.completeTask(team.id, task.id, { ok: true, output: 'ok' })
  assert.equal(second.listTasks(team.id)[0].status, TASK_STATUS.DONE)
})

test('跨实例抢占：两个 board 指向同一 root，同一任务只能被一个抢到', () => {
  const root = tempRoot('atomic')
  const a = newBoard(root)
  const b = newBoard(root)
  const team = a.createTeam({ name: 't', goal: 'g' })
  const task = a.addTask(team.id, { title: '唯一任务', role: 'worker' })

  const results = [a.claimTask(team.id, task.id, 'ma'), b.claimTask(team.id, task.id, 'mb')]
  assert.equal(results.filter(Boolean).length, 1, `只能有一次抢占成功，实际 ${JSON.stringify(results)}`)
})

test('坏文件不会崩：state.json 被写坏时保留内存态并记 warn', () => {
  const root = tempRoot('corrupt')
  const board = newBoard(root)
  const team = board.createTeam({ name: 't', goal: 'g' })
  fs.writeFileSync(path.join(root, 'state.json'), '{ 这不是 JSON', 'utf8')

  const fresh = newBoard(root)
  assert.equal(fresh.getTeam(team.id), null, '解析失败时应退化为空状态而不是抛错')
  assert.ok(fresh.warnings().length >= 1, '解析失败必须留下 warn 痕迹')
  assert.doesNotThrow(() => fresh.createTeam({ name: 't2', goal: 'g2' }))
})

test('过期锁会被接管：残留 .lock 不会让写入永久卡住', () => {
  const root = tempRoot('stale-lock')
  const lock = path.join(root, '.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999 }), 'utf8')
  // 把 mtime 往前拨，模拟「持有者已崩溃十几秒」
  const old = (Date.now() - 60_000) / 1000
  fs.utimesSync(lock, old, old)

  const board = newBoard(root)
  const startedAt = Date.now()
  const team = board.createTeam({ name: 't', goal: 'g' })
  const elapsed = Date.now() - startedAt
  assert.ok(team.id, '过期的锁必须被回收，写入要继续')
  assert.ok(elapsed < 1500, `不该等满锁超时，实际 ${elapsed}ms`)
  assert.equal(fs.existsSync(lock), false, '写完必须释放锁')
  for (const line of board.warnings()) assert.doesNotMatch(line, /等待超过/, `不该出现抢锁超时：${line}`)
})

test('root=null 时纯内存：不写文件也能完成一次编排', async () => {
  const board = createBoard({ root: null, pollIntervalMs: 5 })
  const team = board.createTeam({ name: 't', goal: 'g' })
  board.addTask(team.id, { title: 'A', role: 'worker' })
  const task = await board.waitForTask(team.id, 'm1', { timeoutMs: 100 })
  assert.equal(task.title, 'A')
  assert.equal(board.location().storage, 'memory')
  assert.equal(board.location().file, null)
})

test('外部拿到的对象是快照：改它不会污染真相源', () => {
  const board = newBoard(tempRoot('snapshot'))
  const team = board.createTeam({ name: 't', goal: 'g' })
  const task = board.addTask(team.id, { title: 'A', role: 'worker' })
  task.title = '被篡改'
  team.goal = '被篡改'
  assert.equal(board.listTasks(team.id)[0].title, 'A')
  assert.equal(board.getTeam(team.id).goal, 'g')
})

test('同步形状的 storage 把手优先于文件', () => {
  const memory = { data: null }
  const storage = {
    loadSync: () => memory.data,
    saveSync: (value) => {
      memory.data = JSON.parse(JSON.stringify(value))
    },
  }
  const board = createBoard({ storage, root: null })
  const team = board.createTeam({ name: '宿主存储', goal: 'g' })
  assert.equal(board.location().storage, 'host')
  assert.ok(memory.data, '应该把状态交给 storage.saveSync')
  const reopened = createBoard({ storage, root: null })
  assert.equal(reopened.getTeam(team.id).name, '宿主存储')
})

test('异步 storage 会被识别并降级，而不是静默失效', () => {
  const board = createBoard({ storage: { load: async () => null, save: async () => {} }, root: tempRoot('async-storage') })
  assert.equal(board.location().storage, 'file')
  assert.ok(board.warnings().some((line) => line.includes('同步形状')))
})
