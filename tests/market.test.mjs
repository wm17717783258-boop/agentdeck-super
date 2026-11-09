import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createMarket,
  createMarketStore,
  listCatalog,
  placeOrder,
  confirmPayment,
  buyNow,
  refundOrder,
  purchasedSkins,
  marketLicense,
  billingFromEnv,
  resolveBilling,
  resolveRefundBilling,
  billingHealth,
  splitCents,
  verifySplits,
  ledgerTotals,
  marketPaths,
} from '../lib/market/index.js'
import { listSkins, checkSkinLicense } from '../lib/pet/skins.js'

const SKIN = 'premium-aurora'
const FREE_SKIN = 'basic'
const FIXED = new Date(2026, 10, 5, 22, 10, 0)
const fixedNow = () => FIXED.getTime()

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adsk-market-'))
}

function makeStore(root) {
  return createMarketStore({ root, now: fixedNow })
}

/** 在工作区里放一套第三方皮肤（<root>/.agentdeck/pet/skins/<id>/skin.json） */
function makeLocalSkin(root, { id = 'studio-wood', name = '木刻', price = 6 } = {}) {
  const dir = path.join(root, '.agentdeck', 'pet', 'skins', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'skin.json'),
    JSON.stringify({ id, name, price, author: '测试作者', description: '工作区里的一套付费皮肤', sprite: 'sprite.svg' }),
    'utf8'
  )
  fs.writeFileSync(path.join(dir, 'sprite.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>', 'utf8')
  return id
}

/** 假支付渠道：只记调用次数，不联网；返回 paid:true / refunded:true 才算成功 */
function fakeBilling(result, refundResult) {
  const calls = []
  const refundCalls = []
  const billing = {
    id: 'fake',
    configured: true,
    charge: async (req) => {
      calls.push(req)
      if (typeof result === 'function') return result(req, calls.length)
      return result || { ok: true, paid: true, ref: `pay_${calls.length}` }
    },
    refund: async (req) => {
      refundCalls.push(req)
      if (typeof refundResult === 'function') return refundResult(req, refundCalls.length)
      return refundResult || { ok: true, refunded: true, ref: `refund_${refundCalls.length}` }
    },
  }
  return { billing, calls, refundCalls }
}

/** 临时改环境变量，测完还原（避免受本机真实配置影响） */
function withEnv(patch, fn) {
  const saved = {}
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key]
    if (patch[key] === undefined) delete process.env[key]
    else process.env[key] = patch[key]
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('目录：列举皮肤，价格一律整数分，owned 判定不自己实现', () => {
  const root = makeRoot()
  const catalog = listCatalog({ root, now: fixedNow })

  assert.equal(catalog.ok, true)
  assert.equal(catalog.currency, 'CNY')
  assert.ok(catalog.skins.length >= 4, `至少 4 套皮肤，实际 ${catalog.skins.length}`)

  const ids = catalog.skins.map((skin) => skin.id)
  assert.equal(new Set(ids).size, ids.length, '皮肤 id 不该重复')

  const free = catalog.skins.find((skin) => skin.id === FREE_SKIN)
  assert.equal(free.owned, true)
  assert.equal(free.price, 0)
  assert.equal(free.grant, 'free')

  const premium = catalog.skins.find((skin) => skin.id === SKIN)
  assert.equal(premium.price, 1800, '18 元必须存成 1800 分')
  assert.equal(Number.isInteger(premium.price), true)
  assert.equal(premium.priceLabel, '¥18')
  assert.equal(premium.owned, false)
  assert.equal(premium.locked, true)
  assert.equal(premium.freeTrial, false)
  assert.match(premium.preview.accent, /^#[0-9a-f]{6}$/i)
  assert.equal(premium.preview.states.length, 5, '预览要覆盖 5 个状态')

  // 判定必须和 skins.js 的裁判一致，不能是市场自己拍的
  const rawSkin = listSkins({ root }).skins.find((skin) => skin.id === SKIN)
  const verdict = checkSkinLicense({ skin: rawSkin, license: undefined, root, now: FIXED })
  assert.equal(premium.owned, verdict.allowed)
})

test('owned：工作室档位和单买 claims 都走 checkSkinLicense 同一个裁判', () => {
  const root = makeRoot()
  const studio = {
    ok: true,
    tier: 'studio',
    claims: { v: 1, id: 'lic_test', tier: 'studio', sub: '测试', iat: 0, exp: 9999999999, seats: 3, skins: [] },
    entitlements: { premiumSkins: true },
  }
  const byTier = listCatalog({ root, license: studio, now: fixedNow }).skins.find((skin) => skin.id === SKIN)
  assert.equal(byTier.owned, true)
  assert.equal(byTier.grant, 'tier')

  const single = {
    ok: true,
    tier: 'free',
    claims: { v: 1, id: 'lic_single', tier: 'free', sub: '', iat: 0, exp: 0, seats: 1, skins: [SKIN] },
    entitlements: { premiumSkins: false },
  }
  const byClaim = listCatalog({ root, license: single, now: fixedNow }).skins.find((skin) => skin.id === SKIN)
  assert.equal(byClaim.owned, true)
  assert.equal(byClaim.grant, 'license')

  const expired = {
    ok: false,
    tier: 'free',
    reason: '授权已过期',
    claims: { v: 1, id: 'lic_old', tier: 'studio', sub: '', iat: 0, exp: 1000, seats: 3, skins: [] },
    entitlements: { premiumSkins: true },
  }
  const byExpired = listCatalog({ root, license: expired, now: fixedNow }).skins.find((skin) => skin.id === SKIN)
  assert.equal(byExpired.owned, false, '过期授权不能继续解锁付费皮肤')
})

test('下单：金额整数分、订单落盘、免费和未知皮肤直接拒绝', () => {
  const root = makeRoot()
  const store = makeStore(root)

  const free = placeOrder({ store, skinId: FREE_SKIN, now: fixedNow })
  assert.equal(free.ok, false)
  assert.equal(free.code, 'free_skin')

  const unknown = placeOrder({ store, skinId: 'no-such-skin', now: fixedNow })
  assert.equal(unknown.ok, false)
  assert.match(unknown.reason, /市场里没有/)

  const placed = placeOrder({ store, skinId: SKIN, now: fixedNow })
  assert.equal(placed.ok, true)
  assert.equal(placed.amount, 1800)
  assert.equal(Number.isInteger(placed.amount), true)
  assert.equal(placed.currency, 'CNY')
  assert.equal(placed.payable, 1800)
  assert.equal(placed.reused, false)
  assert.match(placed.order.id, /^ord_[a-z0-9]{12}$/)
  assert.equal(placed.order.state, 'created')

  // 真的写进 <root>/market/orders.json 了
  const file = path.join(root, 'market', 'orders.json')
  assert.equal(fs.existsSync(file), true)
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(disk.v, 1)
  assert.equal(disk.orders.length, 1)
  assert.equal(disk.orders[0].amount, 1800)
  assert.equal(store.readOrders().doc.orders.length, 1)

  // 已经拥有就别再下单
  const studio = {
    ok: true,
    tier: 'studio',
    claims: { v: 1, id: 'lic_x', tier: 'studio', sub: '', iat: 0, exp: 9999999999, seats: 1, skins: [] },
    entitlements: { premiumSkins: true },
  }
  const owned = placeOrder({ store, skinId: SKIN, license: studio, now: fixedNow })
  assert.equal(owned.ok, false)
  assert.equal(owned.code, 'already_owned')
})

test('没配支付渠道：一律返回「环境未配」，绝不伪造支付成功', () => {
  const root = makeRoot()
  const store = makeStore(root)
  const { order } = placeOrder({ store, skinId: SKIN, now: fixedNow })

  return withEnv({ AGENTDECK_PAY_PROVIDER: undefined, AGENTDECK_PAY_URL: undefined }, async () => {
    // 1) 什么都没配
    const bare = await confirmPayment({ store, orderId: order.id, now: fixedNow })
    assert.equal(bare.ok, false)
    assert.equal(bare.reason, '环境未配')
    assert.equal(bare.code, 'billing_unconfigured')
    assert.equal(store.readOrders().doc.orders[0].state, 'created', '没配渠道不许把订单改成已支付')
    assert.equal(store.readLedger().doc.purchases.length, 0)
    assert.equal(purchasedSkins({ store }).skins.length, 0)

    // 2) 渠道显式标了未启用：当没配，而且不允许被调用
    const calls = []
    const disabled = {
      id: 'disabled',
      configured: false,
      charge: async () => {
        calls.push(1)
        return { ok: true, paid: true }
      },
    }
    const off = await confirmPayment({ store, orderId: order.id, billing: disabled, now: fixedNow })
    assert.equal(off.ok, false)
    assert.equal(off.reason, '环境未配')
    assert.equal(calls.length, 0, '未启用的渠道不该被调用')
    assert.equal(store.readOrders().doc.orders[0].state, 'created')

    // 3) 形状不对的渠道同样算没配
    assert.equal(resolveBilling({ id: 'no-charge' }).reason, '环境未配')
    assert.equal(resolveBilling(undefined).reason, '环境未配')

    // 4) 环境变量里只配了一半，也不算配
    assert.equal(billingFromEnv({}).ok, false)
    assert.equal(billingFromEnv({}).reason, '环境未配')
    assert.equal(billingFromEnv({ AGENTDECK_PAY_PROVIDER: 'afdian' }).ok, false)
    assert.equal(billingFromEnv({ AGENTDECK_PAY_URL: 'https://pay.example.com/x' }).ok, false)

    // 5) 配了真实地址但没注入 http：发不出去就如实说，不假装收到钱
    const envAdapter = billingFromEnv({
      AGENTDECK_PAY_PROVIDER: 'afdian',
      AGENTDECK_PAY_URL: 'https://pay.example.com/x',
      AGENTDECK_PAY_TOKEN: 'token_demo',
    }).adapter
    assert.equal(envAdapter.configured, true)
    const noHttp = await confirmPayment({ store, orderId: order.id, billing: envAdapter, now: fixedNow })
    assert.equal(noHttp.ok, false)
    assert.match(noHttp.reason, /没有注入 http 客户端/)
    assert.equal(store.readOrders().doc.orders[0].state, 'created')
  })
})

test('购买与退款分开判定：只配退款能退款，只配购买不能退款', async () => {
  const root = makeRoot()
  const store = makeStore(root)
  const refundOnly = billingFromEnv({
    AGENTDECK_PAY_PROVIDER: 'localpay',
    AGENTDECK_PAY_REFUND_URL: 'https://pay.example.test/refund',
  }).adapter
  const purchaseOnly = billingFromEnv({
    AGENTDECK_PAY_PROVIDER: 'localpay',
    AGENTDECK_PAY_URL: 'https://pay.example.test/pay',
  }).adapter

  assert.equal(refundOnly.purchaseConfigured, false)
  assert.equal(refundOnly.refundConfigured, true)
  assert.equal(resolveBilling(refundOnly).ok, false, '只配退款时不能拿来收款')
  assert.equal(resolveRefundBilling(refundOnly).ok, true, '只配退款时必须能退款')
  assert.equal(billingHealth(refundOnly).purchaseConfigured, false)
  assert.equal(billingHealth(refundOnly).refundConfigured, true)

  assert.equal(purchaseOnly.purchaseConfigured, true)
  assert.equal(purchaseOnly.refundConfigured, false)
  assert.equal(resolveBilling(purchaseOnly).ok, true, '只配购买时必须能收款')
  assert.equal(resolveRefundBilling(purchaseOnly).ok, false, '只配购买时不能伪造退款')

  const { order } = placeOrder({ store, skinId: SKIN, now: fixedNow })
  const buy = await confirmPayment({ store, orderId: order.id, billing: refundOnly, now: fixedNow })
  assert.equal(buy.ok, false)
  assert.equal(buy.code, 'billing_unconfigured')
  assert.equal(store.readOrders().doc.orders[0].state, 'created')

  const paid = await confirmPayment({
    store,
    orderId: order.id,
    billing: { id: 'paid', configured: true, charge: async () => ({ ok: true, paid: true, ref: 'pay_1' }) },
    now: fixedNow,
  })
  assert.equal(paid.ok, true)

  const calls = []
  const refunded = await refundOrder({
    store,
    orderId: order.id,
    billing: refundOnly,
    http: {
      post: async (url, body) => {
        calls.push({ url, body })
        return { ok: true, refunded: true, ref: `refund_${body.refundId}` }
      },
    },
    now: fixedNow,
  })
  assert.equal(refunded.ok, true)
  assert.equal(refunded.order.state, 'refunded')
  assert.deepEqual(calls.map((call) => call.url), ['https://pay.example.test/refund'])
})

test('确认支付：真收到钱才发放，重复确认幂等（不重复扣款、不重复记账）', async () => {
  const root = makeRoot()
  const store = makeStore(root)
  const { billing, calls } = fakeBilling()
  const { order } = placeOrder({ store, skinId: SKIN, now: fixedNow })

  const first = await confirmPayment({ store, orderId: order.id, billing, now: fixedNow })
  assert.equal(first.ok, true)
  assert.equal(first.order.state, 'delivered')
  assert.match(first.code, /^SKIN-PREMIUM-AURORA-[A-F0-9]{8}$/)
  assert.equal(first.split.creator, 1440)
  assert.equal(first.split.platform, 360)
  assert.equal(calls.length, 1)

  const ledger = store.readLedger().doc
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.purchases.length, 1)
  assert.equal(ledger.entries[0].amount, 1800)
  assert.equal(ledger.entries[0].creator.amount, 1440)
  assert.equal(ledger.entries[0].platform.amount, 360)

  const again = await confirmPayment({ store, orderId: order.id, billing, now: fixedNow })
  assert.equal(again.ok, true)
  assert.equal(again.already, true)
  assert.equal(again.code, first.code, '重试必须拿到同一个回执号')
  assert.equal(calls.length, 1, '第二次确认不许再扣款')
  assert.equal(store.readLedger().doc.entries.length, 1, '不许重复记账')
  assert.equal(store.readLedger().doc.purchases.length, 1)

  // 买完立刻算「拥有」，而且能拿到给 activateSkin 的授权
  const catalog = listCatalog({ store, now: fixedNow })
  const bought = catalog.skins.find((skin) => skin.id === SKIN)
  assert.equal(bought.owned, true)
  assert.equal(bought.grant, 'purchase')
  const lic = marketLicense({ store, now: fixedNow })
  assert.equal(lic.ok, true)
  assert.ok(lic.license.claims.skins.includes(SKIN))
  assert.ok(lic.purchased.includes(SKIN))

  // 下单幂等：工作区里的第三方付费皮肤，同一个 idempotencyKey 不会建第二张单
  const localId = makeLocalSkin(root)
  const localEntry = listCatalog({ store, now: fixedNow }).skins.find((skin) => skin.id === localId)
  assert.equal(localEntry.price, 600, '6 元 = 600 分')
  assert.equal(localEntry.source, 'local')
  assert.equal(localEntry.owned, false)
  const a = placeOrder({ store, skinId: localId, idempotencyKey: 'k1', now: fixedNow })
  const b = placeOrder({ store, skinId: localId, idempotencyKey: 'k1', now: fixedNow })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.reused, true)
  assert.equal(b.order.id, a.order.id)
  assert.equal(store.readOrders().doc.orders.length, 2, '一张已买 + 一张新单')
})

test('支付渠道说没收到钱：订单留在待支付，不发放、不记账', async () => {
  const root = makeRoot()
  const store = makeStore(root)

  const declined = fakeBilling({ ok: false, reason: '余额不足' })
  const first = placeOrder({ store, skinId: SKIN, now: fixedNow })
  const r1 = await confirmPayment({ store, orderId: first.order.id, billing: declined.billing, now: fixedNow })
  assert.equal(r1.ok, false)
  assert.equal(r1.reason, '余额不足')
  assert.equal(store.readOrders().doc.orders.find((o) => o.id === first.order.id).state, 'created')
  assert.equal(store.readLedger().doc.entries.length, 0)

  const broken = fakeBilling(() => {
    throw new Error('网关 502')
  })
  const r2 = await confirmPayment({ store, orderId: first.order.id, billing: broken.billing, now: fixedNow })
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /支付渠道报错/)
  assert.match(r2.reason, /网关 502/)

  // 返回 {ok:true} 但没写 paid:true：照样不算收到钱
  const vague = fakeBilling({ ok: true })
  const r3 = await confirmPayment({ store, orderId: first.order.id, billing: vague.billing, now: fixedNow })
  assert.equal(r3.ok, false)
  assert.match(r3.reason, /paid:true/)
  assert.equal(store.readOrders().doc.orders.find((o) => o.id === first.order.id).state, 'created')
})

test('半途崩溃恢复：钱付了但发放没走完，重试只补发放不再扣款', async () => {
  const root = makeRoot()
  const store = makeStore(root)
  const { billing, calls } = fakeBilling()
  const { order } = placeOrder({ store, skinId: SKIN, now: fixedNow })
  const paid = await confirmPayment({ store, orderId: order.id, billing, now: fixedNow })
  assert.equal(paid.ok, true)

  // 手工把现场改回「已付款未发放 + 空账本」，模拟发放前断电
  const doc = store.readOrders().doc
  const target = doc.orders.find((item) => item.id === order.id)
  target.state = 'paid'
  target.delivery = null
  store.writeOrders(doc)
  store.writeLedger({ v: 1, updatedAt: new Date(FIXED).toISOString(), entries: [], purchases: [] })

  const retry = await confirmPayment({ store, orderId: order.id, billing, now: fixedNow })
  assert.equal(retry.ok, true)
  assert.equal(retry.already, true)
  assert.equal(retry.order.state, 'delivered')
  assert.equal(calls.length, 1, '补发放不许再扣一次款')
  assert.equal(store.readLedger().doc.entries.length, 1)
  assert.equal(store.readLedger().doc.purchases.length, 1)
})

test('分账：全是整数分，两半相加恒等于总额（80/20）', () => {
  const cases = [1800, 1999, 999, 1, 12345]
  for (const amount of cases) {
    const split = splitCents(amount)
    assert.equal(split.ok, true)
    assert.equal(split.total, amount)
    assert.equal(Number.isInteger(split.creator), true)
    assert.equal(Number.isInteger(split.platform), true)
    assert.equal(split.creator + split.platform, amount, `${amount} 分不能差分`)
    assert.equal(split.currency, 'CNY')
    assert.equal(split.creatorBps, 8000)
    assert.equal(split.platformBps, 2000)
  }
  assert.equal(splitCents(1800).creator, 1440)
  assert.equal(splitCents(1800).platform, 360)
  assert.equal(splitCents(1999).creator, 1599)
  assert.equal(splitCents(1999).platform, 400)

  // 1..500 分逐个过一遍：整数、加起来刚好
  for (let amount = 1; amount <= 500; amount += 1) {
    const split = splitCents(amount)
    assert.equal(split.creator + split.platform, amount)
    assert.equal(Number.isInteger(split.creator) && Number.isInteger(split.platform), true)
  }

  // 拒绝浮点金额和非整数比例
  assert.equal(splitCents(18.5).ok, false)
  assert.equal(splitCents('1800').ok, false)
  assert.equal(splitCents(-100).ok, false)
  assert.equal(splitCents(NaN).ok, false)
  assert.equal(splitCents(1000, { creatorBps: 10001 }).ok, false)
  assert.equal(splitCents(1000, { creatorBps: 0 }).creator, 0)
  assert.equal(splitCents(1000, { creatorBps: 0 }).platform, 1000)
})

test('坏文件恢复：归档现场 + 恢复成空账本，市场照常开', () => {
  const root = makeRoot()
  const dir = path.join(root, 'market')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'orders.json'), '{ 这不是 JSON', 'utf8')
  fs.writeFileSync(path.join(dir, 'ledger.json'), '[]', 'utf8')

  const store = makeStore(root)
  const orders = store.readOrders()
  assert.equal(orders.ok, true, '读坏文件不能崩')
  assert.equal(orders.recovered, true)
  assert.deepEqual(orders.doc.orders, [])
  const parked = fs.readdirSync(dir).filter((name) => name.startsWith('orders.json.corrupt-'))
  assert.equal(parked.length, 1, '坏文件要留现场')
  assert.equal(fs.existsSync(path.join(dir, parked[0])), true)

  const ledger = store.readLedger()
  assert.equal(ledger.recovered, true, '顶层不是对象也要算坏文件')
  assert.deepEqual(ledger.doc.entries, [])
  assert.deepEqual(ledger.doc.purchases, [])

  // 恢复后能正常做生意
  const catalog = listCatalog({ root, now: fixedNow })
  assert.equal(catalog.ok, true)
  assert.equal(catalog.skins.find((skin) => skin.id === SKIN).owned, false)

  const placed = placeOrder({ store, skinId: SKIN, now: fixedNow })
  assert.equal(placed.ok, true)
  assert.equal(store.readOrders().doc.orders.length, 1)

  // 文件没了也不崩，就是空账本
  fs.rmSync(path.join(dir, 'orders.json'))
  assert.deepEqual(store.readOrders().doc.orders, [])
  assert.equal(store.readOrders().recovered, false)
})

test('原子写：连续写不撕裂、不留下 .tmp 临时文件', () => {
  const root = makeRoot()
  const store = makeStore(root)
  const dir = path.join(root, 'market')
  const file = path.join(dir, 'orders.json')

  for (let i = 0; i < 25; i += 1) {
    const placed = placeOrder({ store, skinId: SKIN, now: fixedNow })
    assert.equal(placed.ok, true)
    assert.equal(store.readOrders().doc.orders.length, i + 1)
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(disk.orders.length, i + 1, `第 ${i + 1} 次写必须能完整读回来`)
  }
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '不能留下 .tmp 临时文件')

  // 目标路径被占成目录（模拟磁盘异常）：写失败要如实返回 ok:false，不抛错、不留 .tmp
  fs.rmSync(file)
  fs.mkdirSync(file)
  const failed = store.writeOrders({ v: 1, updatedAt: new Date(FIXED).toISOString(), orders: [] })
  assert.equal(failed.ok, false, '写不进去要如实返回失败')
  assert.equal(typeof failed.reason, 'string')
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], '失败也不能留 .tmp')
  fs.rmdirSync(file)
  assert.equal(store.writeOrders({ v: 1, updatedAt: new Date(FIXED).toISOString(), orders: [] }).ok, true)
})

test('退款：渠道确认后才冲正分账、收回皮肤、重复退款拒绝', () => {
  const root = makeRoot()
  const store = makeStore(root)
  const { billing, refundCalls } = fakeBilling()
  const { order } = placeOrder({ store, skinId: SKIN, now: fixedNow })

  return (async () => {
    const paid = await confirmPayment({ store, orderId: order.id, billing, now: fixedNow })
    assert.equal(paid.ok, true)
    assert.equal(listCatalog({ store, now: fixedNow }).skins.find((skin) => skin.id === SKIN).owned, true)

    const refunded = await refundOrder({ store, billing, orderId: order.id, reason: '不想要了', now: fixedNow })
    assert.equal(refunded.ok, true)
    assert.equal(refunded.refunded, true)
    assert.equal(refunded.order.state, 'refunded')
    assert.equal(refunded.amount, 1800)
    assert.match(refunded.channel.ref, /^refund_/)
    assert.equal(refundCalls.length, 1, '退款必须真的发给渠道一次')
    assert.equal(refundCalls[0].refundId, `rfd_${order.id}`, '退款号必须由订单固定派生')
    assert.equal(refundCalls[0].paymentRef, paid.order.payment.ref, '退款要带原支付流水号')

    const again = await refundOrder({ store, billing, orderId: order.id, now: fixedNow })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'already_refunded')
    assert.equal(refundCalls.length, 1, '重复退款不许再请求渠道')

    // 皮肤收回、账本冲正
    assert.equal(listCatalog({ store, now: fixedNow }).skins.find((skin) => skin.id === SKIN).owned, false)
    assert.deepEqual(purchasedSkins({ store }).skins, [])
    const ledger = store.readLedger().doc
    assert.equal(ledger.entries.length, 2)
    assert.equal(ledger.entries[0].kind, 'sale')
    assert.equal(ledger.entries[1].kind, 'refund')
    const totals = ledgerTotals(ledger)
    assert.equal(totals.gross, 0)
    assert.equal(totals.creator, 0)
    assert.equal(totals.platform, 0)
    assert.equal(totals.refunded, 1800)
    assert.equal(verifySplits(ledger.entries).ok, true)

    // 没付款的订单不能退款
    const fresh = placeOrder({ store, skinId: SKIN, now: fixedNow })
    const notPaid = await refundOrder({ store, billing, orderId: fresh.order.id, now: fixedNow })
    assert.equal(notPaid.ok, false)
    assert.match(notPaid.reason, /还没支付/)
  })()
})

test('退款：没退款通道 / 渠道拒绝 / 没流水号 / 渠道宕机都不许改本地状态', () => {
  const root = makeRoot()
  const store = makeStore(root)
  const { billing: paidBilling } = fakeBilling()
  const { order } = placeOrder({ store, skinId: SKIN, now: fixedNow })

  return (async () => {
    const paid = await confirmPayment({ store, orderId: order.id, billing: paidBilling, now: fixedNow })
    assert.equal(paid.ok, true)

    const before = store.readOrders().doc.orders[0]
    const ledgerBefore = store.readLedger().doc
    assert.equal(listCatalog({ store, now: fixedNow }).skins.find((skin) => skin.id === SKIN).owned, true)

    // 1) 只给扣款函数：不算有退款通道
    const noRefund = await refundOrder({ store, orderId: order.id, billing: paidBilling.charge, now: fixedNow })
    assert.equal(noRefund.ok, false)
    assert.equal(noRefund.code, 'refund_unconfigured')
    assert.equal(store.readOrders().doc.orders[0].state, 'delivered')

    // 2) 显式未配置
    const off = { id: 'off', configured: false, charge: paidBilling.charge, refund: async () => ({ ok: true, refunded: true, ref: 'x' }) }
    const offRes = await refundOrder({ store, orderId: order.id, billing: off, now: fixedNow })
    assert.equal(offRes.code, 'refund_unconfigured')

    // 3) 渠道拒绝
    const decline = { id: 'decline', configured: true, refund: async () => ({ ok: false, reason: '渠道拒绝：已超过退款期' }) }
    const declineRes = await refundOrder({ store, orderId: order.id, billing: decline, now: fixedNow })
    assert.equal(declineRes.code, 'refund_failed')
    assert.match(declineRes.reason, /超过退款期/)

    // 4) 返回 refunded:true 但没有流水号 → 不算成功
    const noRef = { id: 'no-ref', configured: true, refund: async () => ({ ok: true, refunded: true }) }
    const noRefRes = await refundOrder({ store, orderId: order.id, billing: noRef, now: fixedNow })
    assert.equal(noRefRes.code, 'refund_failed')

    // 5) 渠道抛错
    const boom = { id: 'boom', configured: true, refund: async () => { throw new Error('网关 502') } }
    const boomRes = await refundOrder({ store, orderId: order.id, billing: boom, now: fixedNow })
    assert.equal(boomRes.code, 'refund_failed')
    assert.match(boomRes.reason, /502/)

    const after = store.readOrders().doc.orders[0]
    assert.equal(after.state, 'delivered')
    assert.equal(after.refund, before.refund)
    assert.deepEqual(store.readLedger().doc.entries, ledgerBefore.entries)
    assert.equal(listCatalog({ store, now: fixedNow }).skins.find((skin) => skin.id === SKIN).owned, true)
  })()
})

test('默认根跟着 $DSH_HOME 走，不硬编码盘符', () => {
  const temp = makeRoot()
  withEnv({ DSH_HOME: temp }, () => {
    const store = createMarketStore({ now: fixedNow })
    assert.equal(store.root, path.join(temp, 'agentdeck-super'))
    assert.equal(store.dir, path.join(temp, 'agentdeck-super', 'market'))
    const paths = marketPaths('')
    assert.equal(paths.ordersFile, path.join(temp, 'agentdeck-super', 'market', 'orders.json'))
    assert.equal(paths.ledgerFile, path.join(temp, 'agentdeck-super', 'market', 'ledger.json'))
  })

  const explicit = marketPaths(makeRoot())
  assert.equal(path.basename(explicit.ordersFile), 'orders.json')
  assert.equal(path.basename(explicit.ledgerFile), 'ledger.json')
  assert.equal(path.basename(explicit.dir), 'market')
})

test('门面 createMarket：没 root 直接拒绝，配好渠道能走完整条链路', async () => {
  const noRoot = createMarket({})
  assert.equal(noRoot.ok, false)
  assert.match(noRoot.reason, /root/)

  const root = makeRoot()
  const { billing, calls } = fakeBilling()
  const market = createMarket({ root, billing, now: fixedNow })

  assert.equal(market.ok, true)
  assert.equal(market.paths.ordersFile, path.join(root, 'market', 'orders.json'))
  assert.equal(market.catalog().skins.find((skin) => skin.id === SKIN).owned, false)

  const bought = await market.buy({ skinId: SKIN })
  assert.equal(bought.ok, true)
  assert.equal(bought.order.state, 'delivered')
  assert.equal(calls.length, 1)

  const lic = market.license()
  assert.equal(lic.ok, true)
  assert.ok(lic.license.claims.skins.includes(SKIN))

  const totals = market.totals()
  assert.equal(totals.gross, 1800)
  assert.equal(totals.creator, 1440)
  assert.equal(totals.platform, 360)

  const orders = market.orders()
  assert.equal(orders.ok, true)
  assert.equal(orders.counts.delivered, 1)

  // 已经买过的皮肤：门面直接说不用再买
  const bare = createMarket({ root, now: fixedNow })
  const refused = await bare.buy({ skinId: SKIN })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'already_owned')

  const other = createMarket({ root: makeRoot(), now: fixedNow })
  const unconfigured = await other.buy({ skinId: SKIN })
  assert.equal(unconfigured.ok, false)
  assert.equal(unconfigured.reason, '环境未配')
})
