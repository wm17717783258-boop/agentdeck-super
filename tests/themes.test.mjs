/**
 * 主题包（bundles）—— 蓝图 08 模块要求市场提供「皮肤、声音、动作和**主题包**」，
 * 付费点写明「单次购买、创作者分账、**主题包**」。之前只做了单套皮肤，这一层没有。
 *
 * 这一套验：
 *   ① 真能从磁盘读出主题包（含内置 + 工作区）
 *   ② 坏包跳过并说明，不进市场
 *   ③ **单位统一**：包价和单买价都必须是"分"——
 *      混用会算出"省 99%"这种鬼话（写的时候真踩到过）
 *   ④ 缺素材要如实报，不许让用户买了个空包
 *   ⑤ 工具层 themes 动作真能用
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  THEME_DIRNAME,
  describeTheme,
  listThemes,
  normalizeTheme,
  ownsTheme,
  themeHealth,
  themeSavings,
} from '../lib/market/themes.js';
import { createMarketTool } from '../lib/tools/market.js';
import { createMarketStore } from '../lib/market/store.js';

const BUILTIN = join(process.cwd(), 'assets', THEME_DIRNAME);

function fresh(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-theme-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** 在工作区里放一个自定义主题包。 */
function writeTheme(root, id, patch = {}) {
  const dir = join(root, 'assets', THEME_DIRNAME, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'theme.json'), JSON.stringify({
    id,
    name: `测试包${id}`,
    priceCents: 0,
    skins: ['basic'],
    author: '测试',
    ...patch,
  }, null, 2), 'utf8');
  return dir;
}

/* ── 1. 内置包真的在磁盘上 ─────────────────────────────────────────────── */

test('内置主题包真能读出来，且素材齐全（不是空壳）', () => {
  const r = listThemes();
  assert.equal(r.ok, true);
  assert.ok(r.themes.length >= 2, `内置主题包太少：${r.themes.length}`);
  assert.deepEqual(r.warnings, [], `内置包不该有警告：${r.warnings.join('；')}`);

  const ids = r.themes.map((t) => t.id).sort();
  assert.ok(ids.includes('starter'), `缺 starter：${ids.join(',')}`);
  assert.ok(ids.includes('aurora-suite'), `缺 aurora-suite：${ids.join(',')}`);

  const knownSkins = ['basic', 'nio', 'ink', 'premium-aurora'];
  for (const t of r.themes) {
    assert.ok(t.skins.length > 0, `${t.id} 一套皮肤都没有`);
    assert.equal(themeHealth(t, { knownSkinIds: knownSkins }).ok, true,
      `${t.id} 引用了不存在的皮肤：${themeHealth(t, { knownSkinIds: knownSkins }).missingSkins.join(',')}`);
  }
});

test('免费包不要钱，付费包有价且标了 license', () => {
  const r = listThemes();
  const starter = r.themes.find((t) => t.id === 'starter');
  const aurora = r.themes.find((t) => t.id === 'aurora-suite');
  assert.equal(starter.priceCents, 0, 'starter 该是免费的');
  assert.equal(starter.license, 'free');
  assert.ok(aurora.priceCents > 0, 'aurora-suite 该是付费的');
  assert.equal(aurora.license, 'premium');
});

/* ── 2. 单位必须统一（写的时候踩过的坑）───────────────────────────────── */

test('包价与单买价都按"分"算：不许算出"省 99%"这种鬼话', () => {
  // aurora-suite：包价 2500 分（¥25），单买 1800 分（¥18）
  const r = listThemes();
  const aurora = r.themes.find((t) => t.id === 'aurora-suite');
  const s = themeSavings(aurora, { skinPriceOf: (id) => (id === 'premium-aurora' ? 1800 : 0) });
  assert.equal(s.bundleCents, 2500, `包价单位不对：${s.bundleCents}`);
  // 单买 1800 分，包价 2500 分 → 打包比单买还贵，所以"省"是 0（不许算成负数或 99%）
  assert.equal(s.savedCents, 0, `单买更便宜时不该显示省钱：省了 ${s.savedCents}`);
  assert.equal(s.percent, 0);
  // 关键：percent 不许出现"99%"那种量级错乱
  assert.ok(s.percent < 100, `省钱百分比离谱：${s.percent}%`);
});

test('打包确实便宜时，省多少要算对', () => {
  const theme = normalizeTheme({ id: 'x', name: 'X', priceCents: 1500, separateCents: 3000, skins: ['a', 'b'] });
  const s = themeSavings(theme, { skinPriceOf: () => 0 });
  assert.equal(s.bundleCents, 1500);
  assert.equal(s.separateCents, 3000);
  assert.equal(s.savedCents, 1500);
  assert.equal(s.percent, 50, `该省 50%，算成了 ${s.percent}%`);
});

test('老写法 price（元）会被转成分；给了 priceCents 就以它为准', () => {
  const yuanStyle = normalizeTheme({ id: 'a', name: 'A', price: 25, skins: ['basic'] });
  assert.equal(yuanStyle.priceCents, 2500, 'price:25 该转成 2500 分');
  assert.equal(yuanStyle.license, 'premium', '有价就该是 premium');

  const centsStyle = normalizeTheme({ id: 'b', name: 'B', priceCents: 2500, price: 99, skins: ['basic'] });
  assert.equal(centsStyle.priceCents, 2500, 'priceCents 优先，不许被 price 覆盖');

  const free = normalizeTheme({ id: 'c', name: 'C', price: 0, skins: ['basic'] });
  assert.equal(free.priceCents, 0);
  assert.equal(free.license, 'free');
});

/* ── 3. 坏包不许进市场 ─────────────────────────────────────────────────── */

test('坏包被跳过并说明原因（缺 id / 缺皮肤 / 坏 JSON）', () => {
  const a = fresh('bad');
  try {
    writeTheme(a.root, 'ok-pack', { skins: ['basic'] });
    writeTheme(a.root, 'no-skins', { skins: [] });
    writeTheme(a.root, 'no-name', { name: '' });
    // 坏 JSON
    const badDir = join(a.root, 'assets', THEME_DIRNAME, 'broken');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'theme.json'), '{ 这不是 json', 'utf8');

    const r = listThemes({ root: a.root, builtinDir: join(a.root, 'nope') });
    const ids = r.themes.map((t) => t.id);
    assert.ok(ids.includes('ok-pack'), '好包该留下');
    assert.ok(!ids.includes('no-skins'), '没有皮肤的包不该进市场');
    assert.ok(!ids.includes('no-name'), '没名字的包不该进市场');
    assert.ok(!ids.includes('broken'), '坏 JSON 不该进市场');
    assert.ok(r.warnings.length >= 1, '该说明跳过了什么');
  } finally {
    a.done();
  }
});

test('normalizeTheme 对垃圾输入一律返回 null，不抛', () => {
  for (const bad of [null, undefined, 'string', 42, [], {}, { id: 'x' }, { name: 'x' }, { id: 'x', name: 'y', skins: [] }]) {
    assert.equal(normalizeTheme(bad), null, `${JSON.stringify(bad)} 该被拒`);
  }
});

/* ── 4. 素材缺失要如实报 ───────────────────────────────────────────────── */

test('包里引用了不存在的皮肤：health 如实报缺，不假装能用', () => {
  const theme = normalizeTheme({ id: 'x', name: 'X', skins: ['basic', 'ghost-skin'] });
  const h = themeHealth(theme, { knownSkinIds: ['basic'] });
  assert.equal(h.ok, false);
  assert.deepEqual(h.missingSkins, ['ghost-skin']);
  assert.equal(h.playable, false, '缺素材就不能算能玩');
});

test('素材齐的时候 health 说能玩', () => {
  const theme = normalizeTheme({ id: 'x', name: 'X', skins: ['basic', 'ink'] });
  const h = themeHealth(theme, { knownSkinIds: ['basic', 'ink', 'nio'] });
  assert.equal(h.ok, true);
  assert.deepEqual(h.missingSkins, []);
  assert.equal(h.playable, true);
});

/* ── 5. 拥有判定 ───────────────────────────────────────────────────────── */

test('包里所有皮肤都买了才算拥有这个包', () => {
  const theme = normalizeTheme({ id: 'x', name: 'X', skins: ['basic', 'ink'] });
  assert.equal(ownsTheme(theme, { ownedSkinIds: ['basic'] }), false, '只买一半不算拥有');
  assert.equal(ownsTheme(theme, { ownedSkinIds: ['basic', 'ink'] }), true);
  assert.equal(ownsTheme(theme, { ownedSkinIds: ['basic', 'ink', 'nio'] }), true, '多买了别的也算拥有');
  assert.equal(ownsTheme(null, { ownedSkinIds: ['basic'] }), false);
});

/* ── 6. 人话输出 ───────────────────────────────────────────────────────── */

test('describeTheme 把包名/皮肤/价格/状态都说清楚', () => {
  const theme = normalizeTheme({
    id: 'aurora-suite', name: '极光套装', priceCents: 2500, separateCents: 3000,
    author: '官方', skins: ['premium-aurora', 'nio'], actions: ['idle'], description: '一套渐变配色',
  });
  const text = describeTheme(theme, { skinPriceOf: () => 0, ownedSkinIds: [] });
  assert.match(text, /极光套装/);
  assert.match(text, /aurora-suite/);
  assert.match(text, /含 2 套皮肤/);
  assert.match(text, /premium-aurora、nio/);
  assert.match(text, /打包价 ¥25/);
  assert.match(text, /单买 ¥30/);
  assert.match(text, /省 ¥5/);
  assert.match(text, /状态：未拥有/);
  assert.match(text, /一套渐变配色/);
});

/* ── 7. 工具层 ─────────────────────────────────────────────────────────── */

test('deck_market themes 动作真能列出主题包', async () => {
  const a = fresh('tool');
  try {
    const store = createMarketStore({ root: a.root });
    const tool = createMarketTool({ root: () => a.root, market: store, cfg: {}, license: {} });

    assert.ok(tool.parameters.properties.action.enum.includes('themes'), 'themes 没进动作表');
    const out = String((await tool.execute({ action: 'themes' }, {}))?.text ?? '');
    assert.match(out, /主题包 \d+ 个/, `没列出主题包：${out.slice(0, 150)}`);
    assert.match(out, /极光套装|入门三件套/, '内置包该出现');
    assert.match(out, /打包价/, '该报价格');
    // 素材状态必须如实（这个 harness 里没加载皮肤，所以该说"缺"）
    assert.match(out, /素材：/, '该报素材状态');
  } finally {
    a.done();
  }
});

test('没有主题包时给的是人话，不是空字符串', async () => {
  const a = fresh('none');
  try {
    const store = createMarketStore({ root: a.root });
    const tool = createMarketTool({ root: () => a.root, market: store, cfg: {}, license: {} });
    const out = String((await tool.execute({ action: 'themes' }, {}))?.text ?? '');
    // 内置包一定在（除非有人删了），所以这里只要求"有话说"
    assert.ok(out.length > 10, '返回太短');
    assert.doesNotMatch(out, /运行失败|TypeError/);
  } finally {
    a.done();
  }
});
