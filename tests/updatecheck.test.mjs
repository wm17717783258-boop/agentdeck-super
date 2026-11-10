/**
 * tests/update-check.test.mjs —— 可选更新检查。
 *
 * 这一条测试的真正目的不是"能不能查新版"，而是**默认不联网**：
 * 一个悄悄连 npm 的插件，会把"不分网络"这条承诺当场作废。
 * 所以第一条测试是拿一个"被调用就炸"的 fetch 盯着，证明默认路径根本不碰它。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cacheFile, checkForUpdate, compareVersions, updateCheckEnabled } from '../lib/updatecheck.js';

const tmpEnv = (extra = {}) => ({
  NEXI_UPDATE_CACHE: join(mkdtempSync(join(tmpdir(), 'nexi-upd-')), 'cache.json'),
  ...extra,
});

test('默认关：不设 NEXI_UPDATE_CHECK 时，一次网络都不发', async () => {
  const before = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called += 1; throw new Error('不该联网'); };
  try {
    const r = await checkForUpdate({ current: '1.0.0', env: tmpEnv() });
    assert.equal(called, 0, '默认路径联网了');
    assert.equal(r.checked, false);
    assert.match(r.reason, /disabled/);
    assert.equal(updateCheckEnabled({}), false);
    assert.equal(updateCheckEnabled({ NEXI_UPDATE_CHECK: '0' }), false);
    assert.equal(updateCheckEnabled({ NEXI_UPDATE_CHECK: '1' }), true);
  } finally {
    globalThis.fetch = before;
  }
});

test('显式打开：查到新版就报 outdated，并写进 24 小时缓存', async () => {
  const before = globalThis.fetch;
  const env = tmpEnv({ NEXI_UPDATE_CHECK: '1' });
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return { ok: true, json: async () => ({ version: '9.9.9' }) };
  };
  try {
    const r = await checkForUpdate({ current: '1.11.18', env });
    assert.equal(r.checked, true);
    assert.equal(r.latest, '9.9.9');
    assert.equal(r.outdated, true);
    assert.equal(called, 1);

    const again = await checkForUpdate({ current: '1.11.18', env });
    assert.equal(again.fromCache, true, '第二次该走缓存');
    assert.equal(called, 1, '缓存期内又打了 registry');
    assert.equal(again.outdated, true);
    assert.equal(cacheFile(env).endsWith('cache.json'), true);
  } finally {
    globalThis.fetch = before;
  }
});

test('超时 / 断网都只是"没查到"，不抛、不阻塞', async () => {
  const before = globalThis.fetch;
  const env = tmpEnv({ NEXI_UPDATE_CHECK: '1' });
  globalThis.fetch = async (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  try {
    const r = await checkForUpdate({ current: '1.0.0', env, timeoutMs: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.checked, true);
    assert.match(r.error, /超时/);
  } finally {
    globalThis.fetch = before;
  }

  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const r = await checkForUpdate({ current: '1.0.0', env: tmpEnv({ NEXI_UPDATE_CHECK: '1' }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = before;
  }
});

test('HTTP 非 200 与缺字段都算没查到', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    const r = await checkForUpdate({ current: '1.0.0', env: tmpEnv({ NEXI_UPDATE_CHECK: '1' }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /503/);
  } finally {
    globalThis.fetch = before;
  }
});

test('compareVersions：数字比较，不是字符串比较', () => {
  assert.equal(compareVersions('1.11.18', '1.11.9'), 1, '1.11.18 应该比 1.11.9 新');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
});
