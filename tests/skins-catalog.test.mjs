/**
 * 付费 SKU 的完整性测试。
 *
 * 为什么要单独测这个：皮肤是**内容**，不是代码。代码测到"能读文件"就完了，
 * 但一套皮肤做坏了（少一个状态、占位符没填、clipPath id 撞车）在单测里看不出来，
 * 只有真渲染才会露。一套渲染不出来，货架上就是"花钱买了个空白"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listSkins, renderSprite, SKIN_STATES } from '../lib/pet/skins.js';
import { listCatalog } from '../lib/market/catalog.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKINS_DIR = join(REPO, 'assets', 'skins');

/** 允许全部付费皮肤的授权（只用于验证"能渲染"，不验证授权逻辑） */
const ALL_ACCESS = {
  ok: true,
  tier: 'studio',
  claims: { v: 1, id: 'test', tier: 'studio', sub: '', iat: 0, exp: 0, seats: 9, skins: ['*'] },
};

function env() {
  const root = mkdtempSync(join(tmpdir(), 'adsk-sku-'));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('货架：至少 4 套付费 SKU，价格按分存储、不重复', () => {
  const e = env();
  try {
    const catalog = listCatalog({ root: e.root });
    assert.equal(catalog.ok, true, catalog.reason);

    const paid = catalog.skins.filter((s) => s.price > 0);
    const free = catalog.skins.filter((s) => s.price === 0);
    assert.ok(paid.length >= 4, `付费 SKU 只有 ${paid.length} 套，收费撑不起来`);

    const seen = new Set();
    for (const skin of paid) {
      assert.ok(Number.isInteger(skin.price), `${skin.id} 的价格必须是整数分，实际 ${skin.price}`);
      assert.equal(skin.price % 100, 0, `${skin.id} 的价格不是整元，展示会很难看`);
      assert.equal(seen.has(skin.price), false, `两套皮肤同价（${skin.price} 分），定价没区分度`);
      seen.add(skin.price);
      assert.equal(skin.locked, true, `${skin.id} 没买之前必须锁着`);
      assert.match(skin.priceLabel, /^¥\d+$/, `${skin.id} 的价格标签格式不对：${skin.priceLabel}`);
    }
    assert.ok(free.length >= 3, '免费皮肤不能少于 3 套（不然免费版没得用）');
  } finally {
    e.done();
  }
});

test('每套付费皮肤：素材齐全、清单可读、字段自洽', () => {
  const paid = listSkins({}).skins.filter((s) => s.price > 0);
  assert.ok(paid.length >= 4, '付费皮肤少于 4 套');

  for (const skin of paid) {
    const dir = join(SKINS_DIR, skin.dir);
    const manifest = join(dir, 'skin.json');
    const sprite = join(dir, 'sprite.svg');
    assert.ok(existsSync(manifest), `${skin.id} 缺 skin.json`);
    assert.ok(existsSync(sprite), `${skin.id} 缺 sprite.svg`);

    const meta = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(meta.id, skin.id, `${skin.id} 的 skin.json 里 id 不一致`);
    assert.ok(Number.isInteger(meta.price) && meta.price > 0, `${skin.id} 的 price 必须是正整数元`);
    assert.equal(meta.license, 'premium', `${skin.id} 的 license 不是 premium`);
    assert.match(meta.author || '', /\S/, `${skin.id} 缺作者署名`);
    assert.match(meta.description || '', /\S/, `${skin.id} 缺描述（货架上会显示空白）`);

    const svg = readFileSync(sprite, 'utf8');
    assert.match(svg, /^<svg[\s>]/, `${skin.id} 的 sprite 不是 SVG`);
    // 模板占位符必须是约定那几个，多一个就会在渲染时被清空成空白
    const tokens = [...new Set([...svg.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)].map((m) => m[1]))];
    const allowed = new Set(['size', 'name', 'state', 'stateLabel', 'accent']);
    for (const token of tokens) {
      assert.ok(allowed.has(token), `${skin.id} 的 sprite 用了未知占位符 {{${token}}}`);
    }
    for (const need of ['size', 'state', 'stateLabel']) {
      assert.ok(tokens.includes(need), `${skin.id} 的 sprite 缺 {{${need}}}，渲染会错`);
    }
    // 5 个状态的钩子都得在，否则某个状态会显示成空白
    for (const state of SKIN_STATES) {
      assert.ok(svg.includes(`[data-state="${state}"] .s-${state}`),
        `${skin.id} 没有 ${state} 状态的显示规则`);
    }
  }
});

test('每套付费皮肤：5 个状态都渲染成真 SVG（不是占位图、不留占位符）', () => {
  const e = env();
  try {
    const paid = listSkins({}).skins.filter((s) => s.price > 0);
    for (const skin of paid) {
      for (const state of SKIN_STATES) {
        const svg = renderSprite({ skin: skin.id, state, size: 96, root: e.root, license: ALL_ACCESS });
        const where = `${skin.id}/${state}`;
        assert.match(svg, /^<svg[\s>]/, `${where} 渲染结果不是 SVG`);
        assert.equal(svg.includes('data-placeholder="true"'), false, `${where} 走了占位图（素材没读到？）`);
        assert.equal(/\{\{[a-zA-Z0-9_-]+\}\}/.test(svg), false, `${where} 还有没替换的占位符`);
        assert.ok(svg.includes(`data-skin="${skin.id}"`), `${where} 的 data-skin 不对`);
        assert.ok(svg.includes(`data-state="${state}"`), `${where} 的 data-state 不对`);
        assert.ok(svg.includes('width="96"'), `${where} 的 size 没生效`);
      }
    }
  } finally {
    e.done();
  }
});

test('多套皮肤同页渲染：内部 id 不能撞（否则互相把对方裁掉）', () => {
  const e = env();
  try {
    const ids = listSkins({}).skins.filter((s) => s.price > 0).map((s) => s.id);
    const seen = new Map();
    for (const id of ids) {
      const svg = renderSprite({ skin: id, state: 'idle', size: 96, root: e.root, license: ALL_ACCESS });
      const defined = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(defined.length > 0, `${id} 里一个 id 都没有（渐变/裁剪都没定义？）`);
      for (const one of defined) {
        assert.equal(seen.has(one), false, `id 冲突：${one} 同时出现在 ${seen.get(one)} 和 ${id}，同页会互相干扰`);
        seen.set(one, id);
      }
    }
  } finally {
    e.done();
  }
});

test('没买之前的提示必须是「需授权」，不能是「素材缺失」', () => {
  const e = env();
  try {
    const paid = listSkins({}).skins.filter((s) => s.price > 0);
    for (const skin of paid) {
      const svg = renderSprite({ skin: skin.id, state: 'idle', size: 96, root: e.root });
      const aria = (svg.match(/aria-label="([^"]+)"/) || [])[1] || '';
      assert.match(aria, /需授权/, `${skin.id} 未授权时的 aria-label 是「${aria}」——会被读成皮肤坏了`);
      assert.match(aria, new RegExp(`¥${skin.price}`), `${skin.id} 的提示里要带上价格`);
      // 视觉上也得说清楚
      assert.match(svg, /此皮肤需授权/, `${skin.id} 的占位图没有「此皮肤需授权」字样`);
    }
  } finally {
    e.done();
  }
});
