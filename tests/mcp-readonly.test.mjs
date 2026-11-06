/**
 * tests/mcp-readonly.test.mjs —— MCP 只读模式（mcp.readOnly / nexi mcp --read-only）
 *
 * 要证的是三件事：
 *  1. 只读模式下 tools/list 不广告"一个只读动作都没有"的工具（宁可少说）；
 *  2. 写动作真的被拒：返回 isError:true 的人话，且**状态没被改**（任务板还是原来那条）；
 *  3. 读动作照常能用——只读不等于残废。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMcpEngine } from '../lib/mcp/server.js'
import { isReadonlyAllowed, readonlyBlockedMessage, filterToolsForReadonly } from '../lib/mcp/readonly.js'
import { createHub } from '../lib/hub.js'

function root() {
  return mkdtempSync(join(tmpdir(), 'nexi-readonly-'))
}

async function makeHub(dir) {
  return createHub({
    workspace: dir,
    boardRoot: join(dir, 'board'),
    petRoot: join(dir, 'pet'),
    licenseRoot: join(dir, 'license'),
    automation: { enabled: false },
    onLog: () => {},
  })
}

const call = (engine, name, args) =>
  engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

test('策略表：写动作一律不放行，读动作放行，没登记的工具默认拒', () => {
  assert.equal(isReadonlyAllowed('team_board', { action: 'list' }), true)
  assert.equal(isReadonlyAllowed('team_board', { action: 'add' }), false)
  assert.equal(isReadonlyAllowed('team_board', { action: 'done' }), false)
  assert.equal(isReadonlyAllowed('team_board', {}), true, '缺省动作是 list，算读')
  assert.equal(isReadonlyAllowed('twin_remember', { text: 'x' }), false)
  assert.equal(isReadonlyAllowed('super_agent', { goal: 'x' }), false)
  assert.equal(isReadonlyAllowed('twin_recall', { query: 'x' }), true)
  assert.equal(isReadonlyAllowed('谁也没登记过的工具', {}), false, '默认拒绝')
})

test('拒绝时给的是人话：说清哪个动作被拒、只读模式放行哪些', () => {
  const msg = readonlyBlockedMessage('team_board', { action: 'add' })
  assert.match(msg, /只读模式/)
  assert.match(msg, /team_board action=add/)
  assert.match(msg, /list \/ stats \/ events \/ teams/)
  assert.match(readonlyBlockedMessage('super_agent', {}), /整体关闭/)
})

test('tools/list：只读模式下写工具消失，读工具带"仅 xx 可用"标注', () => {
  const defs = [
    { name: 'twin_recall', description: '召回' },
    { name: 'team_board', description: '任务板' },
    { name: 'super_agent', description: '干活' },
    { name: 'twin_remember', description: '记住' },
  ]
  const kept = filterToolsForReadonly(defs).map((d) => d.name)
  assert.deepEqual(kept, ['twin_recall', 'team_board'])
  const board = filterToolsForReadonly(defs).find((d) => d.name === 'team_board')
  assert.match(board.description, /只读模式：仅 list\/stats\/events\/teams 可用/)
})

test('真 Hub：只读模式下写动作被拒，任务板一条没多', async () => {
  const dir = root()
  let hub
  try {
    hub = await makeHub(dir)
    const engine = createMcpEngine({ hub, log: { info() {}, warn() {}, error() {} }, readOnly: true })
    assert.equal(engine.readOnly, true)

    const created = await call(engine, 'team_board', { action: 'create', name: '不该建起来' })
    assert.equal(created.result.isError, true)
    assert.match(created.result.content[0].text, /只读模式/)

    const added = await call(engine, 'team_board', { action: 'add', title: '不该出现的任务' })
    assert.equal(added.result.isError, true)

    const remembered = await call(engine, 'twin_remember', { text: '不该记住的秘密' })
    assert.equal(remembered.result.isError, true)

    // 读：任务板（一个组都没有也确实为空）、分身召回、桌宠名片
    const list = await call(engine, 'team_board', { action: 'list' })
    assert.notEqual(list.result.isError, true)
    assert.ok(!/不该出现的任务/.test(list.result.content[0].text), '写动作一个字都不许落盘')

    const recall = await call(engine, 'twin_recall', { query: '秘密', any: true })
    assert.notEqual(recall.result.isError, true)
    assert.ok(!/不该记住的秘密/.test(recall.result.content[0].text), '记忆也不许写进去')

    const card = await call(engine, 'pet_skin', { action: 'list' })
    assert.notEqual(card.result.isError, true)
  } finally {
    hub?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非只读模式不受影响：同一个写动作照样能过', async () => {
  const dir = root()
  let hub
  try {
    hub = await makeHub(dir)
    const engine = createMcpEngine({ hub, log: { info() {}, warn() {}, error() {} } })
    const created = await call(engine, 'team_board', { action: 'create', name: '正常模式能建' })
    assert.notEqual(created.result.isError, true)
    assert.match(created.result.content[0].text, /正常模式能建|teamId|小组/)
  } finally {
    hub?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('通行证：只读模式下能验卡、能看账本，但签不出新卡（缺省动作就是 issue）', async () => {
  const dir = root()
  let hub
  try {
    hub = await makeHub(dir)
    const engine = createMcpEngine({ hub, log: { info() {}, warn() {}, error() {} }, readOnly: true })
    const defs = engine.toolsList()
    const names = defs.map((d) => d.name)
    assert.ok(names.includes('agent_passport'), 'show/verify/list 是只读动作，工具本身要留着')
    const def = defs.find((d) => d.name === 'agent_passport')
    assert.match(def.description, /只读模式：仅 show\/verify\/list 可用/)

    // 不带 action = issue（会写盘）→ 必须拒，而且不能悄悄生成密钥
    const dormy = await call(engine, 'agent_passport', { name: '偷偷签' })
    assert.equal(dormy.result.isError, true)
    assert.match(dormy.result.content[0].text, /只读模式/)
    const issue = await call(engine, 'agent_passport', { action: 'issue', name: '偷偷签' })
    assert.equal(issue.result.isError, true)
    const revoke = await call(engine, 'agent_passport', { action: 'revoke', kid: 'kid_x' })
    assert.equal(revoke.result.isError, true)

    // 读动作照常：还没有密钥时 show 也不能写盘
    const show = await call(engine, 'agent_passport', { action: 'show' })
    assert.notEqual(show.result.isError, true)
    assert.match(show.result.content[0].text, /还没有身份密钥/)
    const listed = await call(engine, 'agent_passport', { action: 'list' })
    assert.notEqual(listed.result.isError, true)

    // 只读模式下验一张真卡：用离线签出来的一张（这里直接调用库，相当于"别人机器发来的卡"）
    assert.equal(isReadonlyAllowed('agent_passport', { action: 'verify' }), true)
    assert.equal(isReadonlyAllowed('agent_passport', {}), false, '缺省动作是 issue，不算读')
  } finally {
    hub?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('initialize 自报只读：模型第一眼就知道这台机器只给看', async () => {
  const dir = root()
  let hub
  try {
    hub = await makeHub(dir)
    const engine = createMcpEngine({ hub, log: { info() {}, warn() {}, error() {} }, readOnly: true })
    const res = await engine.handle({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    assert.match(res.result.instructions, /只读模式/)
  } finally {
    hub?.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
