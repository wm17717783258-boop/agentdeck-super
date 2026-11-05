/**
 * tests/pet-visit.test.mjs —— 串门（lib/pet/visit.js）
 *
 * 全程本地：临时工作区 + 内存任务板 + 假 http，绝不联网、绝不起服务。
 * 时钟统一注入 FIXED（2026-11-01 09:00:00），token 的有效期判断才可复现。
 *
 * 跑法：node --test --test-concurrency=1 "tests/pet-*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'

import { createBoard } from '../lib/engine/board.js'
import { createProfileStore } from '../lib/pet/profile.js'
import { createPetLayer, petTools, PET_TOOL_NAMES } from '../lib/pet/index.js'
import {
  DEFAULT_TTL_MS,
  VISIT_LOG_FILE,
  VISIT_SECRET_FILE,
  acceptInvite,
  createVisitHost,
  makeInvite,
  makeNote,
  profileCard,
  readInviteToken,
  readVisitLog,
  receiveNote,
} from '../lib/pet/visit.js'

const FIXED = new Date(2026, 10, 1, 9, 0, 0)
const FIXED_MS = FIXED.getTime()
const DAY = 24 * 60 * 60 * 1000

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentdeck-visit-${label}-`))
}

function newStore(root) {
  return createProfileStore({ root, now: () => FIXED })
}

/** 有习惯、有能力、还埋了一份「不能出门」的隐私数据 */
function richStore(root, name = '阿甲') {
  const store = newStore(root)
  store.update((draft) => {
    draft.name = name
    draft.skins = { owned: ['basic', 'nio'], active: 'nio' }
    draft.habits = [
      { id: 'hab_doc', key: 'tag:文档', label: '爱写文档', confidence: 0.8, evidence: 6, updatedAt: FIXED.toISOString() },
      { id: 'hab_test', key: 'tag:测试', label: '爱跑测试', confidence: 0.9, evidence: 9, updatedAt: FIXED.toISOString() },
      { id: 'hab_qa', key: 'role:tester', label: '当测试员', confidence: 0.5, evidence: 4, updatedAt: FIXED.toISOString() },
      { id: 'hab_coffee', key: 'tag:咖啡', label: '爱喝咖啡', confidence: 0.3, evidence: 3, updatedAt: FIXED.toISOString() },
    ]
    draft.persona = { tone: '简洁', language: 'zh', note: '内部备注：机密项目代号 苍鹭' }
    draft.traits = {}
    draft.stats = { tasks: 12, meetings: 2 }
    draft.signals = {
      '09-11|worker|D:/secret/project': {
        count: 7,
        firstAt: FIXED_MS,
        lastAt: FIXED_MS,
        types: ['task/complete'],
        bucket: '09-11',
        role: 'worker',
        tags: ['D:/secret/project', '机密'],
      },
    }
    return draft
  })
  return store
}

function secretOf(root) {
  return fs.readFileSync(path.join(root, '.agentdeck', 'pet', VISIT_SECRET_FILE), 'utf8').trim()
}

function payloadOf(token) {
  const [body] = String(token).split('.')
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
}

function signSecret(secret, body) {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

/** 用本机密钥手搓一张 token：用来测坏 scope / 坏版本 / 篡改 */
function forgeToken(root, payload, { secret } = {}) {
  const key = secret || secretOf(root)
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${signSecret(key, body)}`
}

/** 改 payload 但保留旧签名 */
function tamperToken(token, mutate) {
  const [body, sig] = String(token).split('.')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  const next = mutate(payload) || payload
  const nextBody = Buffer.from(JSON.stringify(next)).toString('base64url')
  return `${nextBody}.${sig}`
}

function freshTeam() {
  const board = createBoard({ root: null, now: () => FIXED_MS })
  const team = board.createTeam({ name: '串门测试队', goal: '接住便签' })
  return { board, teamId: team.id }
}

test('makeInvite：token / url / exp 都对，密钥与串门记录落在 .agentdeck/pet 下', () => {
  const root = tempRoot('invite')
  const store = richStore(root)
  const invite = makeInvite({ profile: store, ttlMs: 2 * 60 * 60 * 1000, now: () => FIXED })

  assert.equal(invite.ok, true)
  assert.equal(invite.url, `dsh://agentdeck/visit?t=${invite.token}`)
  assert.equal(invite.token.split('.').length, 2)
  assert.equal(invite.exp, new Date(FIXED_MS + 2 * 60 * 60 * 1000).toISOString())
  assert.equal(invite.scope, 'visit')
  assert.match(invite.id, /^visit_[0-9a-f]{10}$/)

  // 名片：只有名字、皮肤、三条习惯、能力，没有原始数据
  assert.equal(invite.card.name, '阿甲')
  assert.equal(invite.card.petSkin, 'nio')
  assert.deepEqual(
    invite.card.habitsTop3.map((habit) => habit.label),
    ['爱跑测试', '爱写文档', '当测试员'],
    '按置信度取前三',
  )
  assert.deepEqual(invite.card.capabilities, ['爱写文档', '爱跑测试', '当测试员', '爱喝咖啡'])
  assert.deepEqual(Object.keys(invite.card).sort(), ['capabilities', 'habitsTop3', 'name', 'petSkin'])

  // 密钥：64 位 hex，落在 .agentdeck/pet/visit-secret，不出现在 token 里
  const secretFile = path.join(root, '.agentdeck', 'pet', VISIT_SECRET_FILE)
  assert.equal(fs.existsSync(secretFile), true)
  assert.match(fs.readFileSync(secretFile, 'utf8').trim(), /^[0-9a-f]{64}$/)
  assert.equal(invite.ephemeralSecret, false)
  assert.ok(!invite.token.includes(secretOf(root)))
  assert.ok(!invite.url.includes(secretOf(root)))

  // 串门记录：一行 invite
  const log = readVisitLog({ root })
  assert.equal(log.ok, true)
  assert.equal(log.path, path.join(root, '.agentdeck', 'pet', VISIT_LOG_FILE))
  assert.equal(log.entries.length, 1)
  assert.equal(log.entries[0].event, 'invite')
  assert.equal(log.entries[0].visitId, invite.id)
  assert.equal(log.entries[0].guest, '阿甲')
})

test('隐私边界：token 里只有名片，signals / persona / stats 一个都不出门', () => {
  const root = tempRoot('privacy')
  const store = richStore(root)
  const invite = makeInvite({ profile: store, now: () => FIXED })
  const payload = payloadOf(invite.token)

  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'from', 'iat', 'id', 'kind', 'scope', 'sid', 'v'])
  const dumped = JSON.stringify(payload)
  for (const secretish of ['D:/secret/project', '机密', '苍鹭', 'signals', 'persona', 'stats', 'traits', 'seen', 'days']) {
    assert.ok(!dumped.includes(secretish), `token 里不该出现 ${secretish}`)
  }
  const card = profileCard(store)
  assert.equal(card.ok, true)
  assert.deepEqual(Object.keys(card.card).sort(), ['capabilities', 'habitsTop3', 'name', 'petSkin'])
})

test('ttl 与 scope：默认一天、太短拉到 1 分钟、太长夹到 30 天、范围只认 visit / work', () => {
  const root = tempRoot('ttl')
  const store = richStore(root)

  const byDefault = makeInvite({ profile: store, now: () => FIXED })
  assert.equal(byDefault.expMs, FIXED_MS + DEFAULT_TTL_MS)

  const zero = makeInvite({ profile: store, ttlMs: 0, now: () => FIXED })
  assert.equal(zero.expMs, FIXED_MS + DEFAULT_TTL_MS, '0 走默认一天')

  const tooShort = makeInvite({ profile: store, ttlMs: 10, now: () => FIXED })
  assert.equal(tooShort.expMs, FIXED_MS + 60 * 1000, '最少 1 分钟')

  const tooLong = makeInvite({ profile: store, ttlMs: 999 * DAY, now: () => FIXED })
  assert.equal(tooLong.expMs, FIXED_MS + 30 * DAY, '最多 30 天')

  const work = makeInvite({ profile: store, scope: 'work', now: () => FIXED })
  assert.equal(work.ok, true)
  assert.equal(work.scope, 'work')
  assert.equal(payloadOf(work.token).scope, 'work')

  const party = makeInvite({ profile: store, scope: 'party', now: () => FIXED })
  assert.equal(party.ok, false)
  assert.match(party.reason, /串门范围/)
})

test('acceptInvite（本机）：签名验得过、只回名片、不碰档案、记一条 accept', () => {
  const root = tempRoot('accept-local')
  const store = richStore(root)
  const before = fs.readFileSync(store.file, 'utf8')
  const invite = makeInvite({ profile: store, now: () => FIXED })
  const guest = richStore(tempRoot('accept-guest'), '阿乙')

  const accepted = acceptInvite({ token: invite.token, profile: guest, root, now: () => FIXED })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.verified, true)
  assert.match(accepted.verifyNote, /本机签发/)
  assert.equal(accepted.hostCard.name, '阿甲')
  assert.equal(accepted.myCard.name, '阿乙')
  assert.equal(accepted.scope, 'visit')
  assert.equal(accepted.handshake, 'manual', '没注 http 就只回名片')
  assert.equal(accepted.logged, true)

  // 串门是只读社交：主人档案一个字节都没动
  assert.equal(fs.readFileSync(store.file, 'utf8'), before)

  const log = readVisitLog({ root })
  assert.deepEqual(log.entries.map((entry) => entry.event), ['invite', 'accept'])
  assert.equal(log.entries[1].verified, true)

  // 范围不匹配：明确拒绝
  const mismatch = acceptInvite({ token: invite.token, profile: guest, root, now: () => FIXED, expectedScope: 'work' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'scope_mismatch')
  assert.match(mismatch.reason, /visit/)
})

test('过期邀请：拒收并说明，不写 accept 记录', () => {
  const root = tempRoot('expired')
  const store = richStore(root)
  const invite = makeInvite({ profile: store, ttlMs: 60 * 1000, now: () => FIXED })
  const guest = richStore(tempRoot('expired-guest'), '阿乙')

  const late = new Date(FIXED_MS + 2 * 60 * 1000)
  const rejected = acceptInvite({ token: invite.token, profile: guest, root, now: () => late })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'expired')
  assert.match(rejected.reason, /已经过期/)
  assert.deepEqual(readVisitLog({ root }).entries.map((entry) => entry.event), ['invite'])

  // 卡在有效期最后一毫秒仍然算有效
  const justInTime = new Date(FIXED_MS + 60 * 1000 - 1)
  assert.equal(acceptInvite({ token: invite.token, profile: guest, root, now: () => justInTime }).ok, true)
})

test('篡改过的邀请函：签名对不上就拒，坏 scope / 坏版本 / 缺名片也各自有话说', () => {
  const root = tempRoot('tamper')
  const store = richStore(root)
  const invite = makeInvite({ profile: store, now: () => FIXED })

  const edited = tamperToken(invite.token, (payload) => {
    payload.scope = 'work'
    payload.exp = FIXED_MS + 10 * DAY
    return payload
  })
  const tampered = readInviteToken(edited, { now: () => FIXED, root })
  assert.equal(tampered.ok, false)
  assert.equal(tampered.code, 'bad_signature')
  assert.match(tampered.reason, /签名/)

  const basePayload = {
    v: 1,
    kind: 'invite',
    id: 'visit_x',
    from: { name: '阿甲', petSkin: 'basic', habitsTop3: [], capabilities: [] },
    scope: 'visit',
    iat: FIXED_MS,
    exp: FIXED_MS + DAY,
    sid: payloadOf(invite.token).sid,
  }
  const badScope = readInviteToken(forgeToken(root, { ...basePayload, scope: 'party' }), { now: () => FIXED, root })
  assert.equal(badScope.ok, false)
  assert.equal(badScope.code, 'bad_scope')

  const badVersion = readInviteToken(forgeToken(root, { ...basePayload, v: 2 }), { now: () => FIXED, root })
  assert.equal(badVersion.ok, false)
  assert.equal(badVersion.code, 'bad_version')

  const badKind = readInviteToken(forgeToken(root, { ...basePayload, kind: 'note' }), { now: () => FIXED, root })
  assert.equal(badKind.ok, false)
  assert.equal(badKind.code, 'bad_kind')

  const noCard = readInviteToken(forgeToken(root, { ...basePayload, from: {} }), { now: () => FIXED, root })
  assert.equal(noCard.ok, false)
  assert.equal(noCard.code, 'no_card')

  const noExp = readInviteToken(forgeToken(root, { ...basePayload, exp: 'soon' }), { now: () => FIXED, root })
  assert.equal(noExp.ok, false)
  assert.equal(noExp.code, 'no_exp')

  for (const junk of ['', 'abc', 'a.b', '!!!.???', null, 42]) {
    const bad = readInviteToken(junk, { now: () => FIXED, root })
    assert.equal(bad.ok, false)
    assert.equal(typeof bad.reason, 'string')
  }
})

test('跨机器的邀请：验不了签就如实说 verified:false，但仍然收得下（提示本地校验）', () => {
  const hostRoot = tempRoot('cross-host')
  const guestRoot = tempRoot('cross-guest')
  const host = richStore(hostRoot, '阿甲')
  const guest = richStore(guestRoot, '阿乙')

  const invite = makeInvite({ profile: host, now: () => FIXED })
  const accepted = acceptInvite({ token: invite.token, profile: guest, root: guestRoot, now: () => FIXED })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.verified, false)
  assert.match(accepted.verifyNote, /跨机器/)
  assert.equal(accepted.hostCard.name, '阿甲')
  assert.equal(accepted.myCard.name, '阿乙')
  // 两边各自留了自己的记录
  assert.deepEqual(readVisitLog({ root: hostRoot }).entries.map((entry) => entry.event), ['invite'])
  assert.deepEqual(readVisitLog({ root: guestRoot }).entries.map((entry) => entry.event), ['accept'])
})

test('握手：带 reply 的邀请会走注入的 http；成功换回名片，失败也不把整次串门搞砸', () => {
  const root = tempRoot('http')
  const store = richStore(root)
  const guest = richStore(tempRoot('http-guest'), '阿乙')
  const invite = makeInvite({ profile: store, reply: 'http://127.0.0.1:59999/exchange', now: () => FIXED })
  assert.equal(payloadOf(invite.token).reply, 'http://127.0.0.1:59999/exchange')

  const sent = []
  const okHttp = { post: (url, body) => { sent.push({ url, body }); return { ok: true, card: { name: '阿甲的回礼', petSkin: 'ink' } } } }
  const exchanged = acceptInvite({ token: invite.token, profile: guest, http: okHttp, root, now: () => FIXED })
  assert.equal(exchanged.ok, true)
  assert.equal(exchanged.handshake, 'exchange')
  assert.equal(exchanged.hostCard.name, '阿甲的回礼')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'http://127.0.0.1:59999/exchange')
  assert.equal(sent[0].body.token, invite.token)
  assert.equal(sent[0].body.card.name, '阿乙')

  const broken = acceptInvite({
    token: invite.token,
    profile: guest,
    root,
    now: () => FIXED,
    http: { post: () => { throw new Error('对方没开机') } },
  })
  assert.equal(broken.ok, true, '握手失败不等于串门失败')
  assert.equal(broken.handshake, 'failed')
  assert.match(broken.handshakeError, /没开机/)

  const refusal = acceptInvite({
    token: invite.token,
    profile: guest,
    root,
    now: () => FIXED,
    http: { post: () => ({ ok: false, reason: '名片不收' }) },
  })
  assert.equal(refusal.handshake, 'failed')
  assert.equal(refusal.handshakeError, '名片不收')

  // 非 http(s) 的 reply 直接丢掉，不会变成 http 调用
  const noReply = makeInvite({ profile: store, reply: 'file:///etc/passwd', now: () => FIXED })
  assert.equal(payloadOf(noReply.token).reply, undefined)
})

test('makeNote + receiveNote：求助落任务、礼物记事件，坏便签一律 ok:false', () => {
  const root = tempRoot('note')
  const store = richStore(root)
  const { board, teamId } = freshTeam()

  const ask = makeNote({
    profile: store,
    kind: 'ask',
    payload: { title: '帮忙看一眼登录报错', role: 'tester', acceptance: '能复现并给出结论', note: '只有周末有空' },
    now: () => FIXED,
    to: '阿乙',
  })
  assert.equal(ask.ok, true)
  assert.equal(ask.note.kind, 'ask')
  assert.match(ask.note.id, /^note_[0-9a-f]{10}$/)
  assert.equal(ask.note.from.name, '阿甲')
  assert.equal(ask.note.to, '阿乙')
  assert.equal(ask.note.at, FIXED.toISOString())

  const receivedAsk = receiveNote({ note: ask.note, board, teamId, root, now: () => FIXED })
  assert.equal(receivedAsk.ok, true)
  assert.equal(receivedAsk.kind, 'ask')
  assert.match(receivedAsk.taskId, /^task_[0-9a-f]{10}$/)
  const tasks = board.listTasks(teamId)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].title, '帮忙看一眼登录报错')
  assert.equal(tasks[0].role, 'tester')
  assert.equal(tasks[0].acceptance, '能复现并给出结论')
  assert.equal(tasks[0].context.from, 'pet_visit')
  assert.equal(tasks[0].context.noteId, ask.note.id)
  assert.equal(tasks[0].context.guest, '阿甲')
  assert.equal(tasks[0].context.ask, '只有周末有空')

  const gift = makeNote({ profile: store, kind: 'gift', payload: { skin: 'nio', message: '这个皮肤挺好看' }, now: () => FIXED })
  assert.equal(gift.ok, true)
  const receivedGift = receiveNote({ note: gift.note, board, teamId, root, now: () => FIXED })
  assert.equal(receivedGift.ok, true)
  assert.equal(receivedGift.kind, 'gift')
  const gifts = board.listEvents(teamId).filter((evt) => evt.kind === 'visit/gift')
  assert.equal(gifts.length, 1)
  assert.equal(gifts[0].noteId, gift.note.id)
  assert.equal(gifts[0].gift.skin, 'nio')
  assert.match(gifts[0].text, /阿甲的礼物/)
  assert.equal(board.listTasks(teamId).length, 1, '礼物不往任务板上塞活')

  // 记录：note-out ×2、note-in ×2
  assert.deepEqual(readVisitLog({ root }).entries.map((entry) => entry.event), ['note-out', 'note-in', 'note-out', 'note-in'])

  // 坏参数
  assert.equal(makeNote({ profile: store, kind: 'spam', payload: {}, now: () => FIXED }).ok, false)
  assert.match(makeNote({ profile: store, kind: 'ask', payload: {}, now: () => FIXED }).reason, /标题/)
  assert.match(makeNote({ profile: store, kind: 'gift', payload: {}, now: () => FIXED }).reason, /皮肤|一句话/)
  assert.match(makeNote({ profile: store, kind: 'gift', payload: 'text' }).reason, /内容/)
  assert.match(makeNote({ profile: null, kind: 'gift', payload: { message: 'x' } }).reason, /档案/)

  assert.match(receiveNote({ note: { kind: 'spam', payload: {} }, board, teamId }).reason, /类型/)
  assert.match(receiveNote({ note: { kind: 'ask', payload: {} }, board, teamId }).reason, /标题/)
  assert.match(receiveNote({ note: { kind: 'ask', payload: { title: 'x' } }, board, teamId: '' }).reason, /teamId/)
  assert.match(receiveNote({ note: ask.note, board: null, teamId }).reason, /任务板/)
  assert.match(receiveNote({ note: null, board, teamId }).reason, /便签/)
  assert.match(receiveNote({ note: { v: 9, kind: 'ask', payload: { title: 'x' } }, board, teamId }).reason, /版本/)
})

test('receiveNote 写不进任务板就如实失败，不假装成功', () => {
  const brokenAdd = { addTask: () => { throw new Error('盘满了') }, appendEvent: () => null }
  const ask = makeNote({ profile: richStore(tempRoot('broken-src')), kind: 'ask', payload: { title: '活' }, now: () => FIXED })
  const askResult = receiveNote({ note: ask.note, board: brokenAdd, teamId: 'team_x', now: () => FIXED })
  assert.equal(askResult.ok, false)
  assert.match(askResult.reason, /盘满了/)

  const gift = makeNote({ profile: richStore(tempRoot('broken-src2')), kind: 'gift', payload: { message: '喝杯咖啡' }, now: () => FIXED })
  const giftResult = receiveNote({ note: gift.note, board: brokenAdd, teamId: 'team_x', now: () => FIXED })
  assert.equal(giftResult.ok, false)
  assert.match(giftResult.reason, /礼物/)
})

test('createVisitHost：档案/任务板/时钟绑好，方法都能直接用', () => {
  const root = tempRoot('host')
  const store = richStore(root)
  const { board, teamId } = freshTeam()
  const host = createVisitHost({ profile: store, board, root, now: () => FIXED })
  assert.equal(host.ok, true)
  assert.equal(host.root, root)
  assert.equal(host.card().card.name, '阿甲')

  const invite = host.makeInvite({ scope: 'work', ttlMs: 60000 })
  assert.equal(invite.ok, true)
  assert.equal(invite.scope, 'work')
  assert.equal(invite.expMs, FIXED_MS + 60000)

  const guest = richStore(tempRoot('host-guest'), '阿乙')
  const accepted = host.acceptInvite({ token: invite.token, profile: guest })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.myCard.name, '阿乙')

  const note = host.makeNote({ kind: 'ask', payload: { title: '搭把手' } })
  assert.equal(note.ok, true)
  const received = host.receiveNote({ note: note.note, teamId })
  assert.equal(received.ok, true)
  assert.equal(received.taskId, board.listTasks(teamId)[0].id)

  const log = host.readLog()
  assert.deepEqual(log.entries.map((entry) => entry.event), ['invite', 'accept', 'note-out', 'note-in'])

  assert.equal(createVisitHost({ profile: null }).ok, false)
  assert.match(createVisitHost({ profile: null }).reason, /档案/)
})

test('没有工作区路径也能串门（密钥退化为进程内临时），只是记录不落盘', () => {
  const profile = richStore(tempRoot('noroot'))
  const invite = makeInvite({ profile: { ...profile.get() }, now: () => FIXED })
  assert.equal(invite.ok, true)
  assert.equal(invite.secretPath, null)
  assert.equal(invite.ephemeralSecret, true)
  assert.equal(invite.logged, false)

  const accepted = acceptInvite({ token: invite.token, profile: { ...profile.get() }, now: () => FIXED })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.logged, false)

  assert.deepEqual(readVisitLog({ root: null }), { ok: false, reason: '需要工作区路径', entries: [] })
  assert.deepEqual(readVisitLog({ root: tempRoot('empty-log') }).entries, [])
})

// ── 总装（lib/pet/index.js）──────────────────────────────────────────────
// 桌宠层是四块的拼装，它错的话上面每个模块再绿也没用，所以冒烟测就在这儿。

test('createPetLayer：四块按同一个 root / 时钟拼好，工具描述符一并给出', () => {
  const root = tempRoot('layer')
  const { board, teamId } = freshTeam()
  const layer = createPetLayer({ root, board, now: () => FIXED })

  assert.equal(layer.ok, true)
  assert.equal(layer.root, root)
  assert.equal(typeof layer.profile.update, 'function')
  assert.equal(layer.meeting.ok, true)
  assert.equal(layer.visit.ok, true)
  assert.deepEqual(Object.keys(layer.states).sort(), ['idle', 'meeting', 'sleeping', 'visiting', 'working'])
  assert.equal(layer.card().card.name, '桌宠', '默认档案就叫桌宠')
  assert.equal(typeof layer.summarize(), 'object')
  assert.equal(layer.skins.list().skins.length, 4, '3 套内置 + 1 套包内付费')
  assert.match(layer.skins.render({ state: 'sleeping', size: 64 }), /<svg/)
  assert.equal(layer.tools().length, 3)
  assert.equal(PET_TOOL_NAMES.length, 3)

  // 换皮肤真的落盘；付费皮肤没授权就明确拒绝
  assert.equal(layer.skins.activate('nio').ok, true)
  assert.equal(layer.profile.get().skins.active, 'nio')
  assert.equal(layer.skins.activate('premium-aurora').ok, false)

  // 缺 root 是硬伤（其余都能降级）
  const bare = createPetLayer({})
  assert.equal(bare.ok, false)
  assert.match(bare.reason, /root/)
  assert.equal(typeof board.listTasks(teamId), 'object')
})

test('petTools：固定三个工具，execute 永不抛错、永远返回中文 { text }', async () => {
  const root = tempRoot('tools')
  richStore(root)
  const { board, teamId } = freshTeam()
  const tools = petTools({ root, board, now: () => FIXED })

  assert.deepEqual(tools.map((tool) => tool.name), PET_TOOL_NAMES)
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    for (const junk of [undefined, null, {}, 'x', { action: '不存在的动作' }]) {
      const out = await tool.execute(junk) // 不抛就算过
      assert.equal(typeof out.text, 'string')
      assert.ok(out.text.startsWith('【'), `工具 ${tool.name} 的输出要有前缀`)
      assert.match(out.text, /[\u4e00-\u9fa5]/)
    }
    const withExec = await tool.execute({}, { logger: { warn() {} }, signal: undefined })
    assert.equal(typeof withExec.text, 'string')
  }
})

test('petTools：pet_visit 走完 invite → card → gift → receive 的整条路', async () => {
  const root = tempRoot('tool-visit')
  richStore(root)
  const { board, teamId } = freshTeam()
  const tool = petTools({ root, board, now: () => FIXED }).find((item) => item.name === 'pet_visit')

  const card = await tool.execute({ action: 'card' })
  assert.match(card.text, /我的名片/)
  assert.match(card.text, /阿甲/)

  const invite = await tool.execute({ action: 'invite', scope: 'work', ttlHours: 2 })
  assert.match(invite.text, /dsh:\/\/agentdeck\/visit\?t=/)
  assert.match(invite.text, /可以派活/)

  const token = invite.text.match(/dsh:\/\/agentdeck\/visit\?t=(\S+)/)[1]
  const accepted = await tool.execute({ action: 'accept', token })
  assert.match(accepted.text, /阿甲/)
  assert.match(accepted.text, /签名/)

  const gift = await tool.execute({ action: 'gift', message: '喝杯咖啡' })
  assert.match(gift.text, /```json/)
  const giftNote = JSON.parse(gift.text.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(giftNote.kind, 'gift')

  const receivedGift = await tool.execute({ action: 'receive', note: giftNote })
  assert.match(receivedGift.text, /礼物/)
  assert.equal(board.listEvents(teamId).filter((evt) => evt.kind === 'visit/gift').length, 1)

  const ask = await tool.execute({ action: 'ask', title: '帮忙看眼报错', acceptance: '能复现', role: 'tester' })
  const askNote = JSON.parse(ask.text.match(/```json\n([\s\S]*?)\n```/)[1])
  const receivedAsk = await tool.execute({ action: 'receive', note: askNote })
  assert.match(receivedAsk.text, /task_/)
  assert.equal(board.listTasks(teamId)[0].title, '帮忙看眼报错')

  // 便签是 JSON 字符串也认；没有队时要人话提示而不是崩
  const viaString = await tool.execute({ action: 'receive', note: JSON.stringify(askNote) })
  assert.match(viaString.text, /task_/)
  const noTeam = petTools({ root, board: createBoard({ root: null }), now: () => FIXED }).find((item) => item.name === 'pet_visit')
  assert.match((await noTeam.execute({ action: 'receive', note: askNote })).text, /还没有队/)

  const log = await tool.execute({ action: 'log' })
  assert.match(log.text, /串门记录/)
  assert.match(log.text, /invite/)
})

test('petTools：pet_meeting 没模型就如实说，有模型能把任务落板', async () => {
  const root = tempRoot('tool-meeting')
  const { board, teamId } = freshTeam()
  const noChat = petTools({ root, board, now: () => FIXED }).find((item) => item.name === 'pet_meeting')
  const refused = await noChat.execute({ topic: '要不要重构' })
  assert.match(refused.text, /模型/)
  assert.equal(board.listTasks(teamId).length, 0)

  const conclusion = '```json\n' + JSON.stringify({
    summary: '重构登录页',
    decisions: ['先拆组件'],
    tasks: [{ title: '拆登录页组件', role: 'worker', acceptance: '能独立渲染', dependsOn: [] }],
  }) + '\n```'
  const chat = async () => ({ content: conclusion })
  const tool = petTools({ root, board, chat, now: () => FIXED }).find((item) => item.name === 'pet_meeting')
  const ran = await tool.execute({
    topic: '重构登录页',
    teamId,
    rounds: 1,
    maxTasks: 3,
    participants: [{ name: '阿甲', role: 'worker', personaHint: '爱写文档' }],
  })
  assert.match(ran.text, /会议结束/)
  assert.match(ran.text, /拆登录页组件/)
  assert.equal(board.listTasks(teamId).length, 1)
  assert.equal(board.listTasks(teamId)[0].context.from, 'pet_meeting')
})

test('petTools：pet_skin 列皮肤 / 换装 / 五状态 / 出图，付费皮肤明确报价', async () => {
  const root = tempRoot('tool-skin')
  richStore(root)
  const tool = petTools({ root, now: () => FIXED }).find((item) => item.name === 'pet_skin')

  const listed = await tool.execute({ action: 'list' })
  assert.match(listed.text, /原味/)
  assert.match(listed.text, /极光/)
  assert.match(listed.text, /免费/)

  assert.match((await tool.execute({ action: 'activate', id: 'basic' })).text, /已经换上/)
  const denied = await tool.execute({ action: 'activate', id: 'premium-aurora' })
  assert.match(denied.text, /没换成/)
  assert.match(denied.text, /¥18/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.agentdeck', 'pet', 'profile.json'), 'utf8')).skins.active, 'basic')

  const states = await tool.execute({ action: 'states' })
  assert.match(states.text, /发呆中/)
  assert.match(states.text, /睡着了/)

  const rendered = await tool.execute({ action: 'render', id: '霓虹', state: 'working', size: 48 })
  assert.match(rendered.text, /<svg/)
  assert.match((await tool.execute({ action: 'render', id: '没这套' })).text, /没有这套皮肤/)
})
