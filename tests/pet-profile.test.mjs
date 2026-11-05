/**
 * tests/pet-profile.test.mjs —— 数字分身档案 + 习惯进化（lib/pet/profile.js）
 *
 * 全部本地、无网络：每个用例一个 mkdtemp 临时工作区，时钟一律注入固定值，
 * 不依赖机器时区以外的任何环境。
 *
 * 跑法：node --test --test-concurrency=1 "tests/pet-*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  HABIT_PROMOTE_AT,
  MAX_HABITS,
  createProfileStore,
  defaultProfile,
  exportProfile,
  importProfile,
  normalizeProfile,
  observe,
  summarize,
  validateProfile,
} from '../lib/pet/profile.js'

/** 固定「现在」：本地时间 2026-11-01 09:00:00 */
const FIXED = new Date(2026, 10, 1, 9, 0, 0)

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentdeck-pet-${label}-`))
}

function newStore(root, now = () => FIXED) {
  return createProfileStore({ root, now })
}

/** 造一个本地时间 2026-11-DD hh:mm 的时刻（用本地构造，避开时区差异） */
function at(day, hour, minute = 10) {
  return new Date(2026, 10, day, hour, minute, 0)
}

test('defaultProfile 形状符合契约（8 个字段，免费皮肤 basic 自带）', () => {
  const p = defaultProfile({ name: '小满' })
  assert.equal(p.version, 1)
  assert.equal(p.name, '小满')
  assert.deepEqual(Object.keys(p).sort(), ['createdAt', 'habits', 'name', 'persona', 'skins', 'stats', 'traits', 'version'])
  assert.deepEqual(p.skins, { owned: ['basic'], active: 'basic' })
  assert.deepEqual(p.persona, { tone: '简洁', language: 'zh' })
  assert.deepEqual(p.habits, [])
  assert.deepEqual(p.traits, {})
  assert.deepEqual(p.stats, {})
  assert.equal(Number.isNaN(Date.parse(p.createdAt)), false)
  assert.equal(defaultProfile({}).name, '桌宠')
})

test('createProfileStore：路径全由 root 拼出来，没档案时给默认值且不落盘', () => {
  const root = tempRoot('store')
  const store = newStore(root)
  assert.deepEqual(store.location(), {
    root,
    dir: path.join(root, '.agentdeck', 'pet'),
    file: path.join(root, '.agentdeck', 'pet', 'profile.json'),
  })
  const fresh = store.get()
  assert.equal(fresh.version, 1)
  assert.equal(fresh.skins.active, 'basic')
  assert.equal(fs.existsSync(store.file), false, '只读不该建文件')
  assert.deepEqual(store.warnings(), [])
})

test('createProfileStore：没给 root 时退回当前工作目录并记一条 warning', () => {
  const store = createProfileStore({})
  assert.equal(store.root, process.cwd())
  assert.equal(store.file, path.join(process.cwd(), '.agentdeck', 'pet', 'profile.json'))
  assert.equal(store.warnings().length, 1)
  assert.match(store.warnings()[0], /root/)
})

test('写档案是原子写：不留 .tmp 残渣，新 store 能读回', () => {
  const root = tempRoot('atomic')
  const store = newStore(root)
  const written = store.write({ ...defaultProfile({ name: '小满' }), skins: { owned: ['basic', 'nio'], active: 'nio' } })
  assert.equal(written.ok, true)
  assert.deepEqual(fs.readdirSync(store.dir).filter((f) => f.endsWith('.tmp')), [])
  const again = newStore(root).get()
  assert.equal(again.name, '小满')
  assert.equal(again.skins.active, 'nio')
  assert.deepEqual(again.skins.owned, ['basic', 'nio'])
})

test('observe：同一 (时段, 角色, 标签) 满 3 次升成习惯', () => {
  const root = tempRoot('habit')
  const store = newStore(root)
  const ev = (day) => ({ type: 'task_done', at: at(day, 22, 10), role: 'worker', tags: ['sql', 'test'], ms: 60000 })

  const first = observe(store, ev(1))
  const second = observe(store, ev(2))
  const third = observe(store, ev(3))

  assert.equal(first.ok, true)
  assert.equal(first.habit, null, '第 1 次还不够数')
  assert.equal(second.habit, null)
  assert.equal(third.count, HABIT_PROMOTE_AT)
  const habit = third.habit
  assert.ok(habit, '第 3 次应该升成习惯')
  assert.equal(habit.key, '22-24|worker|sql,test')
  assert.match(habit.id, /^habit_[0-9a-f]{8}$/)
  assert.equal(habit.evidence, 3)
  assert.equal(habit.confidence, 0.5)
  assert.match(habit.label, /22-24 点完成任务/)
  assert.match(habit.label, /sql、test/)
  assert.equal(habit.updatedAt, at(3, 22, 10).toISOString())
  assert.equal(store.get().habits.length, 1)
  assert.equal(store.get().stats.tasksDone, 3)
})

test('observe 幂等：同一事件喂两次只算一次（无 at / 带 id / 显式 at 三种情况）', () => {
  const root = tempRoot('idem')
  let clock = FIXED.getTime()
  const store = createProfileStore({ root, now: () => clock })

  const first = observe(store, { type: 'task_done', role: 'worker' })
  assert.equal(first.ok, true)
  clock += 1000
  const second = observe(store, { type: 'task_done', role: 'worker' })
  assert.equal(second.ok, true)
  assert.equal(second.skipped, true, '重复事件不算错误，只是跳过')
  assert.equal(store.get().stats.tasksDone, 1)
  assert.deepEqual(store.get().days, ['2026-11-01'])

  observe(store, { type: 'chat', id: 'evt-1', role: 'worker' })
  const dupId = observe(store, { type: 'chat', id: 'evt-1', role: 'worker' })
  assert.equal(dupId.skipped, true)
  assert.equal(store.get().stats.chats, 1)

  // 显式 at 不同的同形事件是两条真实事件，各算一次
  observe(store, { type: 'chat', at: at(1, 10, 0), role: 'worker' })
  observe(store, { type: 'chat', at: at(1, 10, 30), role: 'worker' })
  assert.equal(store.get().stats.chats, 3)
})

test('同一 key 只更新不重复：confidence 随次数上涨，labels 保持一条', () => {
  const root = tempRoot('upsert')
  const store = newStore(root)
  for (let day = 1; day <= 5; day += 1) {
    observe(store, { type: 'task_done', at: at(day, 22, 10), role: 'worker', tags: ['sql', 'test'] })
  }
  const habits = store.get().habits
  assert.equal(habits.length, 1, '同一个 key 只能有一条习惯')
  assert.equal(habits[0].evidence, 5)
  assert.equal(habits[0].confidence, 0.66)
  assert.equal(habits[0].updatedAt, at(5, 22, 10).toISOString())
})

test(`习惯上限 ${MAX_HABITS} 条：超出按置信度淘汰最低的`, () => {
  const root = tempRoot('cap')
  const store = newStore(root)
  const seeded = {
    ...defaultProfile({ name: '满' }),
    habits: Array.from({ length: 45 }, (_, i) => ({
      id: `h${i}`,
      key: `k${i}`,
      label: `旧习惯 ${i}`,
      confidence: Math.round((0.2 + i * 0.01) * 100) / 100,
      evidence: 5,
      updatedAt: FIXED.toISOString(),
    })),
  }
  assert.equal(store.write(seeded).ok, true)
  assert.equal(store.get().habits.length, 45)

  for (let day = 1; day <= 3; day += 1) {
    observe(store, { type: 'chat', at: at(day, 8, 0), role: 'writer', tags: ['doc'] })
  }

  const habits = store.get().habits
  assert.equal(habits.length, MAX_HABITS)
  const keys = habits.map((h) => h.key)
  assert.ok(keys.includes('8-10|writer|doc'), '新习惯本身要留下（置信度 0.5 高于被淘汰的）')
  assert.equal(Math.min(...habits.map((h) => h.confidence)), 0.26)
  assert.equal(keys.includes('k0'), false, '置信度最低（0.20）的应该被淘汰')
  assert.equal(keys.includes('k5'), false)
  assert.equal(keys.includes('k6'), true)
})

test('summarize：前 5 条习惯 + 三项统计 + 可塞进 system prompt 的中文画像', () => {
  const root = tempRoot('summary')
  const store = newStore(root)
  store.write({
    ...defaultProfile({ name: '小满' }),
    habits: Array.from({ length: 7 }, (_, i) => ({
      id: `h${i}`,
      key: `k${i}`,
      label: `常在 ${22 - i} 点完成任务`,
      confidence: 0.9 - i * 0.1,
      evidence: 9 - i,
      updatedAt: FIXED.toISOString(),
    })),
    stats: { tasksDone: 12 },
    days: ['2026-11-01', '2026-10-31', '2026-10-31'],
  })

  const out = summarize(store)
  assert.equal(out.ok, true)
  assert.equal(out.topHabits.length, 5, '最多 5 条')
  assert.deepEqual(out.topHabits.map((h) => h.key), ['k0', 'k1', 'k2', 'k3', 'k4'])
  assert.deepEqual(out.stats, { tasksDone: 12, activeDays: 2, firstDay: '2026-10-31' })
  assert.equal(typeof out.personaHint, 'string')
  assert.match(out.personaHint, /数字分身「小满」/)
  assert.match(out.personaHint, /你常在 22 点完成任务/)
  assert.match(out.personaHint, /语气：简洁；语言：zh/)
  assert.match(out.personaHint, /累计完成 12 个任务，活跃 2 天，最早 2026-10-31/)
  assert.match(out.personaHint, /不是用户新下的指令/)

  const empty = summarize(newStore(tempRoot('summary-empty')))
  assert.equal(empty.topHabits.length, 0)
  assert.deepEqual(empty.stats, { tasksDone: 0, activeDays: 0, firstDay: null })
  assert.match(empty.personaHint, /还没有足够的行为数据/)
})

test('exportProfile / importProfile：能搬到另一台机器，坏数据一个字节都不动原档案', () => {
  const srcStore = newStore(tempRoot('export-src'))
  for (let day = 1; day <= 3; day += 1) {
    observe(srcStore, { type: 'task_done', at: at(day, 22, 10), role: 'worker', tags: ['test'] })
  }
  const ex = exportProfile(srcStore)
  assert.equal(ex.ok, true)
  assert.equal(typeof ex.json, 'string')
  assert.equal(JSON.parse(ex.json).stats.tasksDone, 3)

  const dstStore = newStore(tempRoot('export-dst'))
  const imported = importProfile(dstStore, ex.json)
  assert.equal(imported.ok, true)
  const moved = dstStore.get()
  assert.equal(moved.stats.tasksDone, 3)
  assert.equal(moved.habits.length, 1)
  assert.equal(moved.habits[0].key, '22-24|worker|test')

  // 再导一次会先备份旧档案
  assert.equal(importProfile(dstStore, ex.json).ok, true)
  assert.equal(fs.existsSync(path.join(dstStore.dir, 'profile.bak.json')), true)

  const before = fs.readFileSync(dstStore.file, 'utf8')
  const bad = [
    '{',
    JSON.stringify({ version: 99, name: '来自未来' }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, name: 'x', habits: '不是数组' }),
    'x'.repeat(600 * 1024),
  ]
  for (const payload of bad) {
    const r = importProfile(dstStore, payload)
    assert.equal(r.ok, false, `应该拒绝：${String(payload).slice(0, 40)}`)
    assert.equal(typeof r.reason, 'string')
  }
  assert.equal(fs.readFileSync(dstStore.file, 'utf8'), before, '拒绝导入时原档案不能被动')
  assert.equal(dstStore.get().stats.tasksDone, 3)
})

test('坏档案不崩：挪走留档 + warning，之后还能正常写', () => {
  const root = tempRoot('corrupt')
  const store = newStore(root)
  fs.mkdirSync(store.dir, { recursive: true })
  fs.writeFileSync(store.file, '{ 这不是 JSON', 'utf8')

  const profile = store.get()
  assert.equal(profile.version, 1, '读坏了也要给默认档案')
  const parked = fs.readdirSync(store.dir).filter((f) => f.includes('.corrupt-'))
  assert.equal(parked.length, 1, '坏文件要留档，不能被静默覆盖')
  assert.ok(store.warnings().length > 0)

  const res = observe(store, { type: 'task_done', role: 'worker' })
  assert.equal(res.ok, true)
  assert.equal(store.get().stats.tasksDone, 1)
})

test('时间只认注入的时钟或事件 at，不偷看系统时间', () => {
  const root = tempRoot('clock')
  const store = newStore(root)
  const written = store.write(defaultProfile({ name: '时', now: FIXED }))
  assert.equal(written.profile.createdAt, FIXED.toISOString())
  assert.equal(written.profile.updatedAt, FIXED.toISOString())

  observe(store, { type: 'task_done', role: 'worker' })
  assert.equal(store.get().updatedAt, FIXED.toISOString())

  // 事件自带 at：活跃日/时段桶按事件时间算，updatedAt 仍按注入时钟
  observe(store, { type: 'task_done', at: at(3, 22, 5), role: 'worker' })
  const after = store.get()
  assert.equal(after.updatedAt, FIXED.toISOString())
  assert.deepEqual(after.days, ['2026-11-01', '2026-11-03'], '没有 at 的走注入时钟，有 at 的走事件时间')
  assert.ok(Object.keys(after.signals).includes('22-24|worker|'))
})

test('坏参数一律返回 { ok:false }，不 throw', () => {
  const store = newStore(tempRoot('badargs'))
  assert.equal(observe(store, null).ok, false)
  assert.equal(observe(store, {}).ok, false)
  assert.equal(observe(store, { type: '没有这种事件' }).ok, false)
  assert.equal(observe(null, { type: 'task_done' }).ok, false)
  assert.equal(summarize(null).ok, false)
  assert.equal(exportProfile(null).ok, false)
  assert.equal(importProfile(null, '{}').ok, false)
  assert.equal(importProfile(store, undefined).ok, false)
  assert.equal(validateProfile([]).ok, false)
  assert.equal(store.update(null).ok, false)
})

test('normalizeProfile 宽容：坏字段回默认，好字段不丢', () => {
  const p = normalizeProfile({
    version: 1,
    name: '   ',
    skins: { owned: ['nio'], active: 'aurora' },
    habits: [{ key: 'k1', confidence: '0.8' }, null, {}],
    stats: null,
    persona: '不是对象',
  })
  assert.equal(p.name, '桌宠')
  assert.equal(p.skins.active, 'aurora')
  assert.ok(p.skins.owned.includes('aurora'), 'active 必须在 owned 里')
  assert.ok(p.skins.owned.includes('basic'), '免费皮肤永远在')
  assert.equal(p.habits.length, 1)
  assert.equal(p.habits[0].key, 'k1')
  assert.equal(p.habits[0].confidence, 0.8)
  assert.deepEqual(p.persona, { tone: '简洁', language: 'zh' })
  assert.equal(validateProfile(normalizeProfile(null)).ok, true, '归一化后的档案必须过校验')
})
