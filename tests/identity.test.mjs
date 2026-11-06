/**
 * tests/identity.test.mjs —— Agent 通行证 v1（Ed25519 能力卡）的回归
 *
 * 这几条必须锁死，否则"护照"就退化成一张谁都能改的 JSON：
 *  - 签出来的卡在**另一个进程/另一台机器**上不装任何东西就能验通（公钥随卡走）
 *  - 改一个字符就验不过（payload 被改 / 签名被改 / kid 被改 各一条）
 *  - 过期卡不通过，且错误码说得清是过期而不是"签名错"
 *  - kid 与公钥必须自洽；指定 kid 时只认那个签发者
 *  - 能力清单是真的能用来收窄权限（required 缺一项就不通过）
 *  - 没有身份密钥时 show 不写盘（只读模式下不能偷偷生成密钥）
 *  - 吊销只动本地账本，卡本身仍然验得过（这条是诚实边界，不是 bug）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'

import {
  identityPaths,
  identitySummary,
  issuePassport,
  kidOfPublicKey,
  readPassports,
  revokePassport,
  verifyPassport,
  encodePassport,
  ensureIdentity,
  DEFAULT_TTL_DAYS,
} from '../lib/identity.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'nexi-identity-'))
}

test('签一张卡：落盘、可验、能力清单原样带回', () => {
  const root = tempRoot()
  try {
    const res = issuePassport(root, {
      name: '小犀',
      agent: 'dsh',
      host: 'codex',
      capabilities: ['team_board', 'pet_visit'],
      tier: 'studio',
      seats: 30,
    })
    assert.equal(res.ok, true, res.reason)
    assert.match(res.card, /^NEXP1\.[\w-]+\.[\w-]+$/)
    assert.match(res.kid, /^kid_[A-Za-z0-9_-]{16}$/)

    const check = verifyPassport(res.card)
    assert.equal(check.ok, true, check.reason)
    assert.equal(check.claims.name, '小犀')
    assert.deepEqual(check.claims.capabilities, ['team_board', 'pet_visit'])
    assert.equal(check.claims.tier, 'studio')
    assert.equal(check.kid, res.kid)

    // 账本里真的有一张，且文件在机级目录
    const store = readPassports(root)
    assert.equal(store.cards.length, 1)
    assert.equal(store.cards[0].card, res.card)
    const paths = identityPaths(root)
    assert.equal(existsSync(paths.keyPem), true)
    assert.equal(existsSync(paths.store), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('公钥随卡走：换一个进程、不共享任何密钥目录也能验通', () => {
  const signerRoot = tempRoot()
  const verifierRoot = tempRoot()
  try {
    const res = issuePassport(signerRoot, { name: '小鹿', capabilities: ['pet_visit'] })
    // 验方机器上连身份密钥都没有，验签也不该需要它
    const summary = identitySummary(verifierRoot, { create: false })
    assert.equal(summary.missing, true, '验方本来就没有密钥')
    const check = verifyPassport(res.card)
    assert.equal(check.ok, true, check.reason)
    // 验完之后也不该因为"验过卡"就在验方生成密钥
    assert.equal(existsSync(identityPaths(verifierRoot).keyPem), false, '验卡不许写盘生成密钥')
  } finally {
    rmSync(signerRoot, { recursive: true, force: true })
    rmSync(verifierRoot, { recursive: true, force: true })
  }
})

test('改卡就验不过：payload / 签名 / kid 各一条', () => {
  const root = tempRoot()
  try {
    const res = issuePassport(root, { name: '小犀', capabilities: ['team_board'] })
    const [prefix, payload, sig] = res.card.split('.')

    // ① 改 payload（把名字改成别人）
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims.name = '冒充者'
    const forged = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`
    const badPayload = verifyPassport(forged)
    assert.equal(badPayload.ok, false)
    assert.equal(badPayload.code, 'bad_signature', '改内容必须落在签名上')

    // ② 改签名
    const flipped = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'BB' : 'AA')
    const badSig = verifyPassport(`${prefix}.${payload}.${flipped}`)
    assert.equal(badSig.ok, false)
    assert.ok(['bad_signature', 'payload'].includes(badSig.code), badSig.code)

    // ③ 只改 kid（签名里签着 kid，所以也对不上）
    const claims2 = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims2.kid = 'kid_0000000000000000'
    const forgedKid = `${prefix}.${Buffer.from(JSON.stringify(claims2)).toString('base64url')}.${sig}`
    const badKid = verifyPassport(forgedKid)
    assert.equal(badKid.ok, false)
    assert.equal(badKid.code, 'kid_mismatch', 'kid 与公钥不自洽要先被拦下')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('kid 是公钥的指纹：换一对密钥，kid 必变；自签的卡也只能证明"某个密钥签的"', () => {
  const root = tempRoot()
  try {
    const mine = ensureIdentity(root)
    assert.equal(mine.ok, true)
    // 攻击者自己造一对密钥，签一张写着自己名字的卡：验签会通过（这是离线凭证的天花板），
    // 但只要指定 kid，就立刻被拒——这就是"第一次记住 kid"的用法。
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pubDer = publicKey.export({ format: 'der', type: 'spki' })
    const attackerKid = kidOfPublicKey(pubDer)
    assert.notEqual(attackerKid, mine.kid)
    const card = encodePassport({
      kid: attackerKid,
      pub: pubDer.toString('base64url'),
      name: '我是小犀',
      capabilities: ['team_board'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: 'psp_attacker',
    }, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())

    assert.equal(verifyPassport(card).ok, true, '自洽的卡本身验得过')
    const pinned = verifyPassport(card, { kid: mine.kid })
    assert.equal(pinned.ok, false)
    assert.equal(pinned.code, 'kid_mismatch')
    assert.match(pinned.reason, /不是 .* 签发的/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('过期与未生效：错误码要分得清', () => {
  const root = tempRoot()
  try {
    const id = ensureIdentity(root)
    const nowSec = Math.floor(Date.now() / 1000)
    const expired = encodePassport({
      kid: id.kid,
      pub: id.publicKeyB64Url,
      name: '旧卡',
      capabilities: [],
      iat: nowSec - 86400 * 10,
      exp: nowSec - 60,
      nonce: 'psp_expired',
    }, id.privateKeyPem)
    const res1 = verifyPassport(expired)
    assert.equal(res1.ok, false)
    assert.equal(res1.code, 'expired')

    const future = encodePassport({
      kid: id.kid,
      pub: id.publicKeyB64Url,
      name: '未来卡',
      capabilities: [],
      iat: nowSec + 86400,
      exp: nowSec + 86400 * 2,
      nonce: 'psp_future',
    }, id.privateKeyPem)
    assert.equal(verifyPassport(future).code, 'not_yet')

    // 允许一点时钟偏移：刚好过期 10 秒，skew 30 秒内算通过
    const justExpired = encodePassport({
      kid: id.kid,
      pub: id.publicKeyB64Url,
      name: '刚过期',
      capabilities: [],
      iat: nowSec - 100,
      exp: nowSec - 10,
      nonce: 'psp_skew',
    }, id.privateKeyPem)
    assert.equal(verifyPassport(justExpired).code, 'expired')
    assert.equal(verifyPassport(justExpired, { skewSec: 30 }).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('required 能力缺一项就不通过：能力清单能真的用来收窄权限', () => {
  const root = tempRoot()
  try {
    const res = issuePassport(root, { name: '小犀', capabilities: ['team_board', 'pet_visit'] })
    const ok = verifyPassport(res.card, { requiredCapabilities: ['team_board'] })
    assert.equal(ok.ok, true, ok.reason)
    const missing = verifyPassport(res.card, { requiredCapabilities: ['team_board', 'deck_license'] })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'missing_capability')
    assert.match(missing.reason, /deck_license/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('格式不对的输入一律人话拒绝，不 throw', () => {
  assert.equal(verifyPassport('').code, 'empty')
  assert.equal(verifyPassport('hello').code, 'format')
  assert.equal(verifyPassport('ADSK1.aaa.bbb').code, 'format')
  assert.equal(verifyPassport('NEXP1.@@@.@@@').code, 'payload')
  assert.equal(verifyPassport(null).code, 'empty')
  assert.equal(verifyPassport({}).code, 'empty')
  // 别的产品的授权码不会被误当成通行证
  assert.equal(verifyPassport('ADSK1.eyJ2IjoxfQ.c2ln').ok, false)
})

test('没有密钥时 show 不写盘；第一次 issue 才生成（且私钥不进账本）', () => {
  const root = tempRoot()
  try {
    const before = identitySummary(root, { create: false })
    assert.equal(before.missing, true)
    assert.equal(before.passports, 0)
    assert.equal(existsSync(identityPaths(root).keyPem), false, 'show 不许生成密钥')

    const res = issuePassport(root, { name: '小犀', capabilities: ['team_board'] })
    assert.equal(res.ok, true)
    assert.equal(res.created, true, '第一次签发时生成')
    const after = identitySummary(root, { create: false })
    assert.equal(after.ok, true)
    assert.equal(after.passports, 1)

    const store = readFileSync(identityPaths(root).store, 'utf8')
    assert.ok(!store.includes('PRIVATE KEY'), '账本里绝不能出现私钥')
    assert.ok(store.includes('NEXP1.'), '账本里存着卡本体')
    const key = readFileSync(identityPaths(root).keyPem, 'utf8')
    assert.match(key, /BEGIN PRIVATE KEY/)

    // 第二次签发复用同一身份（kid 不变）
    const res2 = issuePassport(root, { name: '小犀 2 号', capabilities: [] })
    assert.equal(res2.kid, res.kid)
    assert.equal(res2.created, false)
    assert.equal(readPassports(root).cards.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('吊销只动本地账本：卡仍然验得过（诚实边界）', () => {
  const root = tempRoot()
  try {
    const res = issuePassport(root, { name: '小犀', capabilities: ['team_board'] })
    const out = revokePassport(root, res.kid)
    assert.equal(out.ok, true, out.reason)
    assert.equal(out.revoked, 1)
    const store = readPassports(root)
    assert.ok(store.cards[0].revokedAt, '账本上有吊销时间')
    // 离线凭证没有吊销中心：卡本身还是验得过，文案里必须这么说
    assert.equal(verifyPassport(res.card).ok, true)

    const again = revokePassport(root, res.kid)
    assert.equal(again.ok, false, '已经吊销过的不重复计入')
    const unknown = revokePassport(root, 'kid_does_not_exist')
    assert.equal(unknown.ok, false)
    assert.match(unknown.reason, /没有/)
    const empty = revokePassport(root, '')
    assert.equal(empty.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('默认有效期是 30 天，且能被 ttlDays 收窄/放宽（上限 365）', () => {
  const root = tempRoot()
  try {
    const res = issuePassport(root, { name: '小犀', capabilities: [] })
    const days = Math.round((res.claims.exp - res.claims.iat) / 86400)
    assert.equal(days, DEFAULT_TTL_DAYS)

    const short = issuePassport(root, { name: '临时', ttlDays: 1 })
    assert.equal(short.claims.exp - short.claims.iat, 86400)

    const long = issuePassport(root, { name: '长期', ttlDays: 9999 })
    assert.equal(Math.round((long.claims.exp - long.claims.iat) / 86400), 365, '上限 365 天')

    // 0 / 空 = 没填，走默认（不把"填了 0"理解成"立刻过期"，那会签出一张废卡）
    const zero = issuePassport(root, { name: '零', ttlDays: 0 })
    assert.equal(Math.round((zero.claims.exp - zero.claims.iat) / 86400), DEFAULT_TTL_DAYS)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('账本坏了当空处理，不当故障（用户手改文件不该让功能崩）', () => {
  const root = tempRoot()
  try {
    const res = issuePassport(root, { name: '小犀', capabilities: [] })
    assert.equal(res.ok, true)
    writeFileSync(identityPaths(root).store, '{ 这不是 json', 'utf8')
    assert.deepEqual(readPassports(root), { v: 1, cards: [] })
    // 还能继续签发（文件会被重写成合法 JSON）
    const res2 = issuePassport(root, { name: '小犀', capabilities: [] })
    assert.equal(res2.ok, true)
    assert.equal(readPassports(root).cards.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
