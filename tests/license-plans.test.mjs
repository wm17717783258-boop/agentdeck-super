/**
 * 授权工具的价格表输出：四档、真价格、不编收款链接。
 *
 * 为什么要单独测：价格表是"收钱"这条线上唯一用户能看见的东西，
 * 写错一个字就是虚假宣传——档位少一档、价格写错、链接假的，都算产品缺陷。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as api from '../lib/license.js';
import { createLicenseTool } from '../lib/tools/license.js';

function fresh(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-plans-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** 用真授权模块 + 临时授权目录造一个 deck_license 工具 */
function makeTool(root, cfg = {}) {
  const tool = createLicenseTool({ license: api, licenseRoot: () => root, cfg });
  assert.ok(tool && typeof tool.execute === 'function', 'deck_license 工具没造出来');
  return tool;
}

async function plans(root, cfg) {
  const tool = makeTool(root, cfg);
  const value = await tool.execute({ action: 'plans' });
  assert.ok(value && typeof value.text === 'string', 'plans 必须返回 {text}');
  return value.text;
}

test('价格表四档全在，价格与 TIERS 完全一致', async () => {
  const { root, done } = fresh('rows');
  try {
    const text = await plans(root);
    assert.match(text, /四档价格/);
    for (const row of api.PRICE_TABLE) {
      assert.ok(text.includes(row.name), `价格表缺档位：${row.name}`);
      assert.ok(text.includes(row.price), `价格表缺价格：${row.price}`);
    }
    // 四行都带序号，顺序与 PRICE_TABLE 一致
    const order = api.PRICE_TABLE.map((row) => text.indexOf(row.name));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), '档位顺序乱了');
    assert.equal(api.PRICE_TABLE.length, 4);
  } finally {
    done();
  }
});

test('没配收款页：明说没有，不编域名', async () => {
  const { root, done } = fresh('nourl');
  try {
    const text = await plans(root);
    assert.match(text, /还没挂在线收款页/);
    assert.doesNotMatch(text, /https?:\/\//, '没配 purchaseUrl 就不许出现任何网址');
  } finally {
    done();
  }
});

test('配了 purchaseUrl：价格表里给出真实收款页', async () => {
  const { root, done } = fresh('url');
  try {
    const text = await plans(root, { purchaseUrl: 'https://example.com/pricing' });
    assert.match(text, /https:\/\/example\.com\/pricing/);
    assert.doesNotMatch(text, /还没挂在线收款页/);
  } finally {
    done();
  }
});

test('工作室版价格与年付写清楚（含加席价），企业版写"起"', async () => {
  const { root, done } = fresh('price');
  try {
    const text = await plans(root);
    assert.match(text, /¥99\/月（年付 ¥999，含 3 席，加席 ¥20\/席·月）/);
    assert.match(text, /¥29\/月（年付 ¥288）/);
    assert.match(text, /企业版 — ¥30000 起/);
  } finally {
    done();
  }
});
