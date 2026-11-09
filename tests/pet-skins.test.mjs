/**
 * tests/pet-skins.test.mjs —— 皮肤商店 / 授权判定 / SVG 渲染（lib/pet/skins.js）
 *
 * 全部本地、无网络：内置素材直接读包内 assets/skins，第三方皮肤写进 mkdtemp 临时工作区。
 * 授权码一律用手工构造的 claims 对象（形状与 lib/license.js 的 currentLicense() 一致），
 * 不涉及任何真实凭证。
 *
 * 跑法：node --test --test-concurrency=1 "tests/pet-*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BUILTIN_SKINS,
  SKIN_STATES,
  STATE_LABELS,
  activateSkin,
  assetsSkinsDir,
  checkSkinLicense,
  listSkins,
  localSkinsDir,
  renderSprite,
} from '../lib/pet/skins.js'
import { createProfileStore, defaultProfile } from '../lib/pet/profile.js'

/** 固定「现在」：本地时间 2026-11-01 09:00:00 */
const FIXED = new Date(2026, 10, 1, 9, 0, 0)

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentdeck-skins-${label}-`))
}

function newStore(root) {
  return createProfileStore({ root, now: () => FIXED })
}

/** 形如 currentLicense() 的合法授权：点名单套皮肤 */
function perSkinLicense(skins, { tier = 'pro', exp } = {}) {
  return {
    ok: true,
    tier,
    claims: {
      v: 1,
      id: 'lic_test_0001',
      tier,
      sub: '测试用户',
      iat: Math.floor(FIXED.getTime() / 1000) - 86400,
      exp: exp === undefined ? Math.floor(FIXED.getTime() / 1000) + 86400 : exp,
      seats: 1,
      skins,
    },
  }
}

/** 找到包内那套付费皮肤（premium-aurora） */
function auroraSkin() {
  const found = listSkins({}).skins.find((skin) => skin.id === 'premium-aurora')
  assert.ok(found, '包内应该带着付费示例皮肤 premium-aurora')
  return found
}

/** 极简 SVG 标签配平检查（测试里没有 XML 解析器，够用即可） */
function assertBalancedSvg(text) {
  const voidTags = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'stop', 'path', 'circle', 'ellipse', 'rect', 'line', 'polygon', 'polyline', 'use'])
  const clean = text.replace(/<!--[\s\S]*?-->/g, '')
  const stack = []
  const re = /<\s*(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g
  let m
  while ((m = re.exec(clean)) !== null) {
    const [, closing, name, attrs, selfClose] = m
    if (name === 'svg' && !closing) {
      stack.push(name)
      continue
    }
    if (closing) {
      const top = stack.pop()
      assert.equal(top, name, `标签没配平：期望 </${top}>，实际 </${name}>`)
      continue
    }
    if (selfClose || voidTags.has(name)) continue
    stack.push(name)
  }
  assert.deepEqual(stack, [], `标签没闭合：${stack.join(', ')}`)
}

test('BUILTIN_SKINS 是三套免费皮肤，字段符合契约', () => {
  assert.equal(BUILTIN_SKINS.length, 3)
  assert.deepEqual(BUILTIN_SKINS.map((s) => s.id), ['basic', 'nio', 'ink'])
  assert.deepEqual(BUILTIN_SKINS.map((s) => s.name), ['原味', '霓虹', '水墨'])
  for (const skin of BUILTIN_SKINS) {
    assert.equal(skin.price, 0)
    assert.equal(skin.premium, false)
    assert.equal(skin.builtin, true)
    assert.match(skin.file, /^[a-z]+\.svg$/)
    assert.equal(typeof skin.description, 'string')
  }
  assert.deepEqual([...SKIN_STATES], ['idle', 'working', 'meeting', 'visiting', 'sleeping'])
  assert.equal(STATE_LABELS.sleeping, '睡着了')
})

test('listSkins 列出内置三套 + 包内付费一套，素材都在', () => {
  const root = tempRoot('list')
  const { ok, skins, warnings, dirs, root: reported } = listSkins({ root })
  assert.equal(ok, true)
  assert.equal(reported, root)
  assert.equal(dirs.assets, assetsSkinsDir())
  assert.equal(dirs.local, localSkinsDir(root))

  const ids = skins.map((s) => s.id)
  assert.deepEqual(ids.slice(0, 3), ['basic', 'nio', 'ink'])
  assert.ok(ids.includes('premium-aurora'))

  const aurora = skins.find((s) => s.id === 'premium-aurora')
  assert.equal(aurora.premium, true)
  assert.equal(aurora.price, 18)
  assert.equal(aurora.source, 'package')
  assert.ok(fs.statSync(aurora.spritePath).isFile(), '付费皮肤素材应该在包里')

  for (const skin of skins) {
    assert.equal(typeof skin.spritePath, 'string')
    assert.ok(fs.statSync(skin.spritePath).isFile(), `${skin.id} 的素材文件应该存在`)
  }
  assert.deepEqual(warnings, [])
})

test('免费皮肤不需要任何授权就能激活，档案里记着 owned', () => {
  const root = tempRoot('free')
  const store = newStore(root)
  assert.equal(store.get().skins.active, 'basic')

  const verdict = checkSkinLicense({ skin: 'nio', license: undefined })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.allowed, true)
  assert.equal(verdict.source, 'free')
  assert.equal(verdict.price, 0)

  const applied = activateSkin(store, 'nio')
  assert.equal(applied.ok, true)
  assert.equal(applied.active, 'nio')
  assert.equal(applied.skin.id, 'nio')

  const profile = store.get()
  assert.equal(profile.skins.active, 'nio')
  assert.deepEqual(profile.skins.owned, ['basic', 'nio'])

  // 换回原味也一样
  const back = activateSkin(store, 'basic', null)
  assert.equal(back.ok, true)
  assert.equal(store.get().skins.active, 'basic')

  // 免费皮肤在授权码是坏的时候也照样能用
  const withBrokenLicense = checkSkinLicense({ skin: 'ink', license: { ok: false, tier: 'free', reason: '授权已过期' } })
  assert.equal(withBrokenLicense.allowed, true)
})

test('付费皮肤没授权：判定不许用，激活被拒且一个字节都不改档案', () => {
  const root = tempRoot('premium-deny')
  const store = newStore(root)
  assert.equal(fs.existsSync(store.file), false, '还没写过档案')
  const before = store.write(defaultProfile({ name: '测试', now: FIXED })).ok ? fs.readFileSync(store.file, 'utf8') : ''
  assert.ok(before.length > 0)
  const aurora = auroraSkin()

  const verdict = checkSkinLicense({ skin: aurora, license: undefined, now: FIXED })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.price, 18)
  assert.equal(verdict.reason, '这个皮肤需要授权：¥18')
  assert.match(verdict.detail, /授权/)

  const applied = activateSkin(store, 'premium-aurora')
  assert.equal(applied.ok, false)
  assert.equal(applied.reason, '这个皮肤需要授权：¥18')
  assert.equal(applied.price, 18)

  const after = fs.readFileSync(store.file, 'utf8')
  assert.equal(after, before, '拒绝授权时不能动档案')
  assert.equal(store.get().skins.active, 'basic')
})

test('currentLicense 形态的授权：点名单套 / 工作室档 / 过期 / ok:false', () => {
  const aurora = auroraSkin()
  const now = FIXED

  // 1) pro 档 + 授权里点名了这一套
  const named = checkSkinLicense({ skin: aurora, license: perSkinLicense(['premium-aurora']), now })
  assert.equal(named.allowed, true)
  assert.equal(named.source, 'license')
  assert.equal(named.tier, 'pro')

  // 2) studio 档自带付费皮肤全解锁
  const studio = checkSkinLicense({ skin: aurora, license: perSkinLicense([], { tier: 'studio' }), now })
  assert.equal(studio.allowed, true)
  assert.equal(studio.source, 'tier')
  assert.equal(studio.tier, 'studio')

  // 3) pro 档没点名 → 不许用
  const notNamed = checkSkinLicense({ skin: aurora, license: perSkinLicense([]), now })
  assert.equal(notNamed.allowed, false)
  assert.match(notNamed.detail, /pro/)

  // 4) 点名了但已过期（exp 是 Unix 秒）
  const expired = checkSkinLicense({
    skin: aurora,
    license: perSkinLicense(['premium-aurora'], { exp: Math.floor(FIXED.getTime() / 1000) - 3600 }),
    now,
  })
  assert.equal(expired.allowed, false)
  assert.match(expired.detail, /到期/)

  // 5) currentLicense 说授权本身无效
  const invalid = checkSkinLicense({ skin: aurora, license: { ok: false, tier: 'free', reason: '授权码不对', claims: null }, now })
  assert.equal(invalid.allowed, false)
  assert.match(invalid.detail, /授权码不对/)

  // 6) entitlements 显式给了 premiumSkins
  const ent = checkSkinLicense({
    skin: aurora,
    license: { ok: true, tier: 'pro', claims: { tier: 'pro', skins: [] }, entitlements: { premiumSkins: true } },
    now,
  })
  assert.equal(ent.allowed, true)
  assert.equal(ent.source, 'tier')
})

test('裸 claims 也认；授权码字符串不认（凭证只由 lib/license.js 解析）', () => {
  const aurora = auroraSkin()
  const bare = checkSkinLicense({
    skin: aurora,
    license: { tier: 'free', skins: ['premium-aurora'], exp: Math.floor(FIXED.getTime() / 1000) + 86400 },
    now: FIXED,
  })
  assert.equal(bare.allowed, true)
  assert.equal(bare.source, 'license')

  const wildcard = checkSkinLicense({ skin: aurora, license: { tier: 'pro', skins: ['premium-*'] }, now: FIXED })
  assert.equal(wildcard.allowed, true)

  const rawString = checkSkinLicense({ skin: aurora, license: 'AD-1234-5678-9012', now: FIXED })
  assert.equal(rawString.allowed, false)
  assert.match(rawString.detail, /currentLicense/)

  // 包内付费示例只有在授权到位之后才允许激活
  const root = tempRoot('premium-grant')
  const store = newStore(root)
  const applied = activateSkin(store, 'premium-aurora', perSkinLicense(['premium-aurora']))
  assert.equal(applied.ok, true)
  assert.equal(applied.active, 'premium-aurora')
  assert.deepEqual(store.get().skins.owned, ['basic', 'premium-aurora'])
})

test('activateSkin 的坏参数与不存在的皮肤：返回 ok:false，不抛异常', () => {
  assert.equal(activateSkin(null, 'basic').ok, false)
  assert.match(activateSkin(null, 'basic').reason, /createProfileStore/)

  const root = tempRoot('bad-args')
  const store = newStore(root)
  const missing = activateSkin(store, 'ghost-skin')
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /没有这个皮肤/)
  assert.ok(missing.available.includes('basic'))

  assert.equal(activateSkin(store, '../etc').ok, false)
  assert.equal(checkSkinLicense({}).ok, false)
  assert.equal(checkSkinLicense({ skin: 'nope' }).ok, false)
  assert.match(checkSkinLicense({ skin: 'nope' }).reason, /没有这个皮肤/)
})

test('renderSprite 渲染五种状态：token 全部填掉，中文标签正确', () => {
  for (const state of SKIN_STATES) {
    const svg = renderSprite({ skin: 'basic', state, size: 64 })
    assert.match(svg, /^<svg /)
    assert.match(svg, new RegExp(`data-state="${state}"`))
    assert.match(svg, new RegExp(`width="64"`))
    assert.ok(svg.includes(STATE_LABELS[state]), `${state} 应该渲染「${STATE_LABELS[state]}」`)
    assert.ok(!svg.includes('{{'), `${state} 不该残留模板 token`)
    assert.ok(!svg.includes('data-placeholder'))
    assertBalancedSvg(svg)
  }

  // 未知状态退回发呆；尺寸越界被夹住
  assert.match(renderSprite({ skin: 'nio', state: 'dancing' }), /data-state="idle"/)
  assert.match(renderSprite({ skin: 'nio', size: 10 }), /width="24"/)
  assert.match(renderSprite({ skin: 'nio', size: 9999 }), /width="512"/)
  assert.match(renderSprite({ skin: 'nio', size: 'abc' }), /width="96"/)
  assert.match(renderSprite({ skin: 'ink', size: 48.6 }), /width="49"/)

  // 换皮肤会换 data-skin 与 accent
  const ink = renderSprite({ skin: 'ink', state: 'working' })
  assert.match(ink, /data-skin="ink"/)
  assert.match(ink, /#9a3b2a/)
})

test('renderSprite 付费未授权给占位图 + 中文购买提示；授权后给真图', () => {
  const aurora = auroraSkin()

  const locked = renderSprite({ skin: aurora, state: 'idle', size: 96 })
  assert.match(locked, /data-placeholder="true"/)
  assert.match(locked, /data-state="idle"/)
  assert.ok(locked.includes('此皮肤需授权 ¥18'), '未授权要给中文购买提示')
  assert.ok(!locked.includes('{{'))
  assertBalancedSvg(locked)

  const unlocked = renderSprite({ skin: aurora, state: 'meeting', size: 96, license: perSkinLicense(['premium-aurora']), now: FIXED })
  assert.ok(!unlocked.includes('data-placeholder'), '授权到位应该渲染真素材')
  assert.match(unlocked, /data-skin="premium-aurora"/)
  assert.match(unlocked, /data-state="meeting"/)
  assert.ok(unlocked.includes('开会中'))
  assertBalancedSvg(unlocked)
})

test('renderSprite 用字符串 id 也能认出包内付费皮肤（不会被当成"没有这个皮肤"）', () => {
  // 页面通常先 listSkins 再逐张 renderSprite；但 hero 区只传了 pet.skin 这个字符串。
  // 如果 renderSprite 只查 BUILTIN_SKINS，付费皮肤就会被画成「素材缺失 / 没有这个皮肤」。
  const byId = renderSprite({ skin: 'premium-aurora', state: 'idle', size: 96 })
  assert.ok(!byId.includes('没有这个皮肤'), '包内付费皮肤必须认得出来')
  assert.ok(byId.includes('此皮肤需授权 ¥18'), '未授权时应该说"需授权"，而不是"不存在"')
  assert.match(byId, /data-placeholder="true"/)
  assertBalancedSvg(byId)

  const unlocked = renderSprite({ skin: 'premium-aurora', state: 'idle', size: 96, license: perSkinLicense(['premium-aurora']), now: FIXED })
  assert.ok(!unlocked.includes('data-placeholder'), '授权后字符串 id 也要渲染真素材')
  assert.match(unlocked, /data-skin="premium-aurora"/)
  assertBalancedSvg(unlocked)
})

test('renderSprite 素材缺失/皮肤不存在：返回占位 SVG，绝不抛、绝不返回空串', () => {
  const missing = renderSprite({ skin: { id: 'ghost', name: '缺', file: 'ghost.svg', dir: 'ghost', price: 0 }, state: 'working' })
  assert.match(missing, /^<svg /)
  assert.match(missing, /data-placeholder="true"/)
  assert.ok(missing.includes('桌宠素材缺失'))
  assertBalancedSvg(missing)

  const unknownId = renderSprite({ skin: 'no-such-skin' })
  assert.match(unknownId, /data-placeholder="true"/)
  assert.ok(unknownId.includes('没有这个皮肤'))

  const nothing = renderSprite()
  assert.match(nothing, /^<svg /)
  assert.match(nothing, /data-placeholder="true"/)
  assert.ok(nothing.includes('没有指定皮肤'))

  // 被放坏的素材（存在但不是 SVG）也要兜住
  const root = tempRoot('bad-sprite')
  const dir = path.join(localSkinsDir(root), 'junk')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify({ id: 'junk', name: '坏素材', price: 0, sprite: 'sprite.svg' }))
  fs.writeFileSync(path.join(dir, 'sprite.svg'), 'not an svg at all')
  const junk = listSkins({ root }).skins.find((s) => s.id === 'junk')
  assert.ok(junk, 'skin.json 合法就会列出来')
  const junkSvg = renderSprite({ skin: junk, state: 'idle' })
  assert.match(junkSvg, /data-placeholder="true"/)
  assert.ok(junkSvg.includes('不是一段 SVG'))
})

test('工作区第三方皮肤：发现、渲染、付费判定都跟着 root 走', () => {
  const root = tempRoot('local')
  const skinsDir = localSkinsDir(root)

  const freeDir = path.join(skinsDir, 'catto')
  fs.mkdirSync(freeDir, { recursive: true })
  fs.writeFileSync(path.join(freeDir, 'skin.json'), JSON.stringify({ id: 'catto', name: '自绘猫', price: 0, sprite: 'sprite.svg', accent: '#336699' }))
  const template = fs.existsSync(path.join(assetsSkinsDir(), 'basic', 'basic.svg'))
    ? fs.readFileSync(path.join(assetsSkinsDir(), 'basic', 'basic.svg'), 'utf8')
    : '<svg xmlns="http://www.w3.org/2000/svg" width="{{size}}" height="{{size}}" data-state="{{state}}"><text>{{stateLabel}}</text></svg>'
  fs.writeFileSync(path.join(freeDir, 'sprite.svg'), template)

  const paidDir = path.join(skinsDir, 'fancy')
  fs.mkdirSync(paidDir, { recursive: true })
  fs.writeFileSync(path.join(paidDir, 'skin.json'), JSON.stringify({ id: 'fancy', name: '贵皮', price: 30, license: 'premium', sprite: 'sprite.svg' }))
  fs.writeFileSync(path.join(paidDir, 'sprite.svg'), template)

  const listed = listSkins({ root })
  assert.deepEqual(listed.warnings, [])
  const catto = listed.skins.find((s) => s.id === 'catto')
  const fancy = listed.skins.find((s) => s.id === 'fancy')
  assert.ok(catto && fancy)
  assert.equal(catto.source, 'local')
  assert.equal(catto.premium, false)
  assert.equal(fancy.premium, true)
  assert.equal(fancy.price, 30)
  assert.equal(catto.spritePath, path.join(freeDir, 'sprite.svg'))

  const store = newStore(root)
  assert.equal(activateSkin(store, 'catto').ok, true)
  assert.equal(store.get().skins.active, 'catto')
  const denied = activateSkin(store, 'fancy')
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, '这个皮肤需要授权：¥30')

  const granted = activateSkin(store, 'fancy', { tier: 'free', skins: ['fancy'], exp: Math.floor(FIXED.getTime() / 1000) + 86400 })
  assert.equal(granted.ok, true)
  assert.equal(store.get().skins.active, 'fancy')

  const svg = renderSprite({
    skin: fancy,
    state: 'sleeping',
    size: 40,
    license: { tier: 'free', skins: ['fancy'], exp: Math.floor(FIXED.getTime() / 1000) + 86400 },
    now: FIXED,
  })
  assert.ok(!svg.includes('data-placeholder'))
  assert.match(svg, /width="40"/)
  assert.ok(svg.includes('睡着了'))
})

test('坏 skin.json 一律跳过并留 warning，不抛也不污染皮肤列表', () => {
  const root = tempRoot('broken')
  const skinsDir = localSkinsDir(root)
  const make = (name, content) => {
    const dir = path.join(skinsDir, name)
    fs.mkdirSync(dir, { recursive: true })
    if (content !== null) fs.writeFileSync(path.join(dir, 'skin.json'), content)
    return dir
  }
  make('bad-json', '{ 这不是 json ')
  make('evil', JSON.stringify({ id: 'evil', sprite: '../../etc/passwd' }))
  make('no-sprite', JSON.stringify({ id: 'nosprite', name: '空' }))
  make('missing-file', JSON.stringify({ id: 'ghostly', sprite: 'nope.svg' }))
  make('no-manifest', null)

  const listed = listSkins({ root })
  assert.equal(listed.ok, true)
  const ids = listed.skins.map((s) => s.id)
  for (const bad of ['evil', 'nosprite', 'ghostly']) {
    assert.ok(!ids.includes(bad), `${bad} 不该出现在列表里`)
  }
  assert.deepEqual(ids.slice(0, 3), ['basic', 'nio', 'ink'])
  assert.ok(listed.warnings.length >= 3, '每个坏皮肤都该留一条 warning')
  assert.ok(listed.warnings.some((w) => w.includes('skin.json 读不了')))
  assert.ok(listed.warnings.some((w) => w.includes('文件名不合法')))
  assert.ok(listed.warnings.some((w) => w.includes('素材文件不存在')))
})

test('内置皮肤素材是纯 SVG：带模板 token、按状态分组、单文件小于 20KB', () => {
  for (const skin of BUILTIN_SKINS) {
    const file = path.join(assetsSkinsDir(), skin.dir, skin.file)
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(Buffer.byteLength(text, 'utf8') < 20 * 1024, `${skin.id} 的 SVG 要小于 20KB`)
    assert.match(text, /<svg[\s>]/, `${skin.id} 应该是一段 SVG`)
    assert.match(text, /<\/svg>\s*$/)
    assert.ok(text.includes('{{size}}'), `${skin.id} 要支持尺寸注入`)
    assert.ok(text.includes('{{state}}'), `${skin.id} 要支持状态注入`)
    assert.ok(text.includes('{{stateLabel}}'), `${skin.id} 要支持中文状态标签`)
    for (const state of SKIN_STATES) {
      assert.ok(text.includes(`[data-state="${state}"]`), `${skin.id} 缺少 ${state} 状态分组`)
      assert.ok(text.includes(`s-${state}`), `${skin.id} 缺少 ${state} 状态图层`)
    }
    assert.ok(!/https?:\/\//.test(text.replace('http://www.w3.org/2000/svg', '')), `${skin.id} 不能引用外部资源`)
    assertBalancedSvg(text)
  }

  // 付费示例的 skin.json 声明与素材对得上
  const manifest = JSON.parse(fs.readFileSync(path.join(assetsSkinsDir(), 'premium-aurora', 'skin.json'), 'utf8'))
  assert.equal(manifest.id, 'premium-aurora')
  assert.equal(manifest.license, 'premium')
  assert.equal(manifest.sprite, 'sprite.svg')
  assert.equal(manifest.price, 18)
  assert.ok(fs.statSync(path.join(assetsSkinsDir(), 'premium-aurora', manifest.sprite)).isFile())
})

test('激活皮肤不会破坏档案其它字段，且换装后习惯/统计原样保留', () => {
  const root = tempRoot('keep')
  const store = newStore(root)
  const seeded = defaultProfile({ name: '小分', now: FIXED })
  seeded.stats.tasksDone = 7
  seeded.traits = { style: '简洁', pace: '稳' }
  seeded.habits = [{ id: 'habit_abcdef12', key: '22-24|worker|sql', label: '常在 22-24 点干活', confidence: 0.66, evidence: 5, updatedAt: FIXED.toISOString() }]
  assert.equal(store.write(seeded).ok, true)

  const applied = activateSkin(store, 'ink')
  assert.equal(applied.ok, true)
  const profile = store.get()
  assert.equal(profile.name, '小分')
  assert.equal(profile.stats.tasksDone, 7)
  assert.deepEqual(profile.traits, { style: '简洁', pace: '稳' })
  assert.equal(profile.habits.length, 1)
  assert.equal(profile.skins.active, 'ink')
  assert.deepEqual(profile.skins.owned, ['basic', 'ink'])
  assert.equal(profile.version, 1)
})
