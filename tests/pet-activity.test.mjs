/**
 * tests/pet-activity.test.mjs —— 宿主活动 → 桌宠习惯（lib/pet/activity.js）
 *
 * 这里验的是「数字分身真能学到习惯」这条链：
 *   宿主 emit(type, data) → petEventOf 翻译 → profile.observe 落盘 → summarize 长出习惯。
 * 全程本地临时目录，时钟注入固定值，每个用例自己造档案，互不影响。
 *
 * 跑法：node --test --test-concurrency=1 "tests/pet-*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createProfileStore, observe, summarize } from '../lib/pet/profile.js'
import { petEventOf, observeActivity, tagsOf, HOST_MAP } from '../lib/pet/activity.js'

const FIXED = new Date(2026, 10, 5, 22, 10, 0)

function newStore(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentdeck-activity-${label}-`))
  return createProfileStore({ root, now: () => FIXED })
}

test('tagsOf：从标题里抽出能代表"在干什么"的标签，丢掉废话词', () => {
  assert.deepEqual(tagsOf('修 sql 注入，补 test'), ['sql', '注入', 'test'])
  assert.deepEqual(tagsOf('把登录页拆成组件'), ['把登录页拆成组件'], '一整串中文不硬切')
  assert.deepEqual(tagsOf(''), [])
  assert.deepEqual(tagsOf('一个 任务 需要 完成'), [])
  assert.equal(tagsOf('a b c d e f g h i j').length <= 4, true, '最多 4 个标签')
})

test('petEventOf：宿主事件只翻语义对得上的，其余返回 null', () => {
  const added = petEventOf('task_add', { teamId: 't1', taskId: 'k1', title: '修 sql', role: 'worker' })
  assert.equal(added.type, 'task_added')
  assert.equal(added.role, 'worker')
  assert.deepEqual(added.tags, ['sql'])
  assert.equal(added.id, 'task_added:t1:k1')

  assert.equal(petEventOf('task_done', { teamId: 't1', taskId: 'k1' }).type, 'task_done')
  assert.equal(petEventOf('task_assign', { teamId: 't1', taskId: 'k1' }).type, 'task_claimed')
  assert.equal(petEventOf('pet_meeting', { teamId: 't1', topic: '发布计划' }).type, 'chat')
  assert.equal(petEventOf('team_create', { teamId: 't1' }).type, 'session_start')

  // 跟习惯无关的一律不认（免得学歪）
  assert.equal(petEventOf('log', { text: 'x' }), null)
  assert.equal(petEventOf('super_step', {}), null)
  assert.equal(petEventOf('agents_detected', { agents: [] }), null)
  assert.equal(petEventOf('', {}), null)
  for (const mapped of Object.values(HOST_MAP)) {
    assert.match(mapped, /^(task_done|task_claimed|task_added|chat|session_start)$/)
  }
})

test('observeActivity：连做三次同类活，习惯自己长出来（不用人喂数据）', () => {
  const store = newStore('habit')
  const sink = { store, observe }

  for (const taskId of ['k1', 'k2', 'k3']) {
    const out = observeActivity(sink, 'task_done', { teamId: 't1', taskId, title: '修 sql test' })
    assert.equal(out.ok, true, out.reason)
  }
  assert.equal(store.get().stats.tasksDone, 3)

  const summary = summarize(store)
  assert.equal(summary.ok, true)
  assert.equal(summary.stats.tasksDone, 3)
  assert.equal(summary.topHabits.length, 1, '三次同类 → 一条习惯')
  assert.match(summary.topHabits[0].label, /完成任务/)
  assert.match(summary.topHabits[0].label, /sql/)
  assert.match(summary.personaHint, /数字分身/)

  // 幂等：同一个 taskId 再来一遍不再计数
  const again = observeActivity(sink, 'task_done', { teamId: 't1', taskId: 'k1', title: '修 sql test' })
  assert.equal(again.ok, true)
  assert.equal(again.skipped, true, '同一条事件重复喂应当跳过')
  assert.equal(store.get().stats.tasksDone, 3)
})

test('observeActivity：加任务记到 tasksAdded，开会记成聊天，画像里能看见', () => {
  const store = newStore('added')
  const sink = { store, observe }

  assert.equal(observeActivity(sink, 'task_add', { teamId: 't1', taskId: 'a1', title: '写 sql 迁移', role: 'worker' }).ok, true)
  assert.equal(observeActivity(sink, 'task_add', { teamId: 't1', taskId: 'a2', title: '补 test 用例', role: 'tester' }).ok, true)
  assert.equal(observeActivity(sink, 'pet_meeting', { teamId: 't1', topic: '发布前评审', meetingId: 'm1' }).ok, true)

  const profile = store.get()
  assert.equal(profile.stats.tasksAdded, 2)
  assert.equal(profile.stats.chats, 1)
  assert.match(summarize(store).personaHint, /拆出 2 个/)
})

test('observeActivity：任务板上补详情（done 事件只带 taskId 也不瞎猜）', () => {
  const store = newStore('detail')
  const board = {
    listTasks: (teamId) => (teamId === 't1'
      ? [{ id: 'k9', title: '接支付回调', role: 'tester' }]
      : []),
  }
  const sink = { store, observe, board }

  const out = observeActivity(sink, 'task_done', { teamId: 't1', taskId: 'k9' })
  assert.equal(out.ok, true)
  assert.equal(out.event.role, 'tester', '角色从任务板上捞回来')
  assert.deepEqual(out.event.tags, ['接支付回调'])
  assert.equal(store.get().stats.tasksDone, 1)
})

test('observeActivity：档案没就绪就如实返回 ok:false，绝不抛错', () => {
  assert.equal(observeActivity(null, 'log', { text: 'x' }).ok, true, '跟习惯无关的事件先跳过')
  const noSink = observeActivity(null, 'task_done', { teamId: 't1', taskId: 'x' })
  assert.equal(noSink.ok, false, '认了但没档案 → 如实说没记住')
  const noStore = observeActivity({ observe }, 'task_done', { teamId: 't1', taskId: 'x' })
  assert.equal(noStore.ok, false)
  assert.match(noStore.reason, /桌宠档案没就绪/)

  const bad = observeActivity({ store: {}, observe: () => { throw new Error('盘满了') } }, 'task_done', { teamId: 't1', taskId: 'y' })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /盘满了/)
})
