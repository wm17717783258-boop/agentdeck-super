/**
 * tests/hosting.test.mjs —— 托管层：激活 / 令牌 / 配额 / 用量 / 房间账本 / API
 *
 * 每个用例一个临时 root、固定时钟、零网络。
 * 验签器由测试注入（不依赖真卖家私钥）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HOSTING_PLANS,
  normalizePlan,
  planOf,
  safeDeviceId,
  loadState,
  saveState,
  dayKey,
  activate,
  resolveToken,
  revokeToken,
  usageOf,
  recordUsage,
  checkQuota,
  claimRoom,
  releaseRoom,
  bearerOf,
  createHostingApi,
} from '../lib/hosting/index.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'adsk-hosting-'));
}

const FIXED = Date.parse('2026-11-07T06:30:00.000Z');
/** 假装验鉴器：只认 "good-plus" / "good-studio" / "good-biz"，其余无效。 */
function fakeVerify(code) {
  if (code === 'good-plus') return { ok: true, tier: 'plus' };
  if (code === 'good-studio') return { ok: true, tier: 'studio' };
  if (code === 'good-biz') return { ok: true, tier: 'business' };
  if (code === 'legacy-pro') return { ok: true, tier: 'pro' };
  return { ok: false, reason: '签名对不上' };
}

test('档位归一：未知/老名字都落到可用档位', () => {
  assert.equal(normalizePlan('plus'), 'plus');
  assert.equal(normalizePlan('pro'), 'plus', '老档位名 pro 要映射到 plus');
  assert.equal(normalizePlan('PRO'), 'plus');
  assert.equal(normalizePlan('不存在'), 'free');
  assert.equal(normalizePlan(''), 'free');
  assert.equal(normalizePlan(null), 'free');
});

test('safeDeviceId：挡住路径穿越和奇怪字符', () => {
  assert.equal(safeDeviceId('dev_abc-123.x'), 'dev_abc-123.x');
  assert.equal(safeDeviceId('../../etc/passwd'), '');
  assert.equal(safeDeviceId('a/b'), '');
  assert.equal(safeDeviceId('a\\b'), '');
  assert.equal(safeDeviceId('a:b'), '');
  assert.equal(safeDeviceId('中文'), '');
  assert.equal(safeDeviceId(''), '');
});

test('激活：好码换到令牌，档位正确，落盘可读回', () => {
  const root = tmpRoot();
  try {
    const res = activate({ root, code: 'good-plus', deviceId: 'dev_a', verify: fakeVerify, now: FIXED });
    assert.equal(res.ok, true, res.reason);
    assert.match(res.token, /^hst_/);
    assert.equal(res.tier, 'plus');
    assert.equal(res.plan.cloudRooms, HOSTING_PLANS.plus.cloudRooms);

    const loaded = loadState({ root });
    assert.equal(loaded.ok, true);
    assert.ok(loaded.state.tokens[res.token], '令牌应该落盘');
    assert.equal(loaded.state.tokens[res.token].deviceId, 'dev_a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('激活：坏码被拒（402），且不留令牌', () => {
  const root = tmpRoot();
  try {
    const res = activate({ root, code: 'bad-code', deviceId: 'dev_a', verify: fakeVerify, now: FIXED });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad_license');
    assert.equal(res.status, 402);
    assert.equal(Object.keys(loadState({ root }).state.tokens).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('激活：deviceId 不合法 → 400', () => {
  const root = tmpRoot();
  try {
    const res = activate({ root, code: 'good-plus', deviceId: '../evil', verify: fakeVerify, now: FIXED });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad_device');
    assert.equal(res.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('激活：没有验签器时如实失败（自己搭 relay 忘了注入）', () => {
  const root = tmpRoot();
  try {
    const res = activate({ root, code: 'good-plus', deviceId: 'dev_a', now: FIXED });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'no_verifier');
    assert.equal(res.status, 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('验签器抛错 → 500，不把异常冒出去', () => {
  const root = tmpRoot();
  try {
    const res = activate({
      root, code: 'good-plus', deviceId: 'dev_a', now: FIXED,
      verify: () => { throw new Error('boom'); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'verify_error');
    assert.equal(res.status, 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveToken：认不出 / 过期 / 吊销 三种情况分别给对状态码', () => {
  const root = tmpRoot();
  try {
    assert.equal(resolveToken({ root, token: 'hst_不存在' }).status, 401);
    assert.equal(resolveToken({ root, token: '' }).status, 401);

    const { token } = activate({ root, code: 'good-plus', deviceId: 'dev_a', verify: fakeVerify, now: FIXED });
    assert.equal(resolveToken({ root, token, now: FIXED }).ok, true);

    // 过期：把时钟拨到 31 天后
    const later = FIXED + 31 * 24 * 3600 * 1000;
    const expired = resolveToken({ root, token, now: later });
    assert.equal(expired.ok, false);
    assert.equal(expired.code, 'expired');
    assert.equal(expired.status, 403);

    // 吊销
    const rev = revokeToken({ root, token, now: FIXED });
    assert.equal(rev.ok, true);
    const after = resolveToken({ root, token, now: FIXED });
    assert.equal(after.ok, false);
    assert.equal(after.code, 'revoked');
    assert.equal(after.status, 403);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('用量：同一天累加，跨天自动归零', () => {
  const root = tmpRoot();
  try {
    const { token } = activate({ root, code: 'good-plus', deviceId: 'dev_a', verify: fakeVerify, now: FIXED });
    assert.equal(usageOf(resolveToken({ root, token, now: FIXED }).entry, FIXED).toolCalls, 0);

    recordUsage({ root, token, cost: 3, now: FIXED });
    recordUsage({ root, token, cost: 2, now: FIXED });
    const entry = resolveToken({ root, token, now: FIXED }).entry;
    assert.equal(usageOf(entry, FIXED).toolCalls, 5, '同一天应该累加到 5');

    // 跨天：读出来是 0（不需要定时器），再记一次也只算新的这天
    const tomorrow = FIXED + 24 * 3600 * 1000;
    assert.equal(usageOf(entry, tomorrow).toolCalls, 0, '跨天应归零');
    recordUsage({ root, token, cost: 1, now: tomorrow });
    const e2 = resolveToken({ root, token, now: tomorrow }).entry;
    assert.equal(usageOf(e2, tomorrow).toolCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('配额：免费档没有云房间；付费档按上限拦', () => {
  const root = tmpRoot();
  try {
    const free = activate({ root, code: 'good-x', deviceId: 'dev_f', verify: () => ({ ok: true, tier: 'free' }), now: FIXED });
    const q0 = checkQuota({ root, token: free.token, kind: 'rooms', now: FIXED });
    assert.equal(q0.allowed, false);
    assert.equal(q0.code, 'plan_no_cloud_rooms');

    const plus = activate({ root, code: 'good-plus', deviceId: 'dev_p', verify: fakeVerify, now: FIXED });
    const limit = HOSTING_PLANS.plus.cloudRooms;
    for (let i = 0; i < limit; i += 1) {
      const r = claimRoom({ root, token: plus.token, roomId: `room_${i}`, now: FIXED });
      assert.equal(r.ok, true, `第 ${i + 1} 个房间应该能建：${r.reason}`);
    }
    const over = claimRoom({ root, token: plus.token, roomId: 'room_over', now: FIXED });
    assert.equal(over.ok, false);
    assert.equal(over.code, 'room_limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('房间释放：关房后额度还回来', () => {
  const root = tmpRoot();
  try {
    const { token } = activate({ root, code: 'good-plus', deviceId: 'dev_a', verify: fakeVerify, now: FIXED });
    const limit = HOSTING_PLANS.plus.cloudRooms;
    for (let i = 0; i < limit; i += 1) claimRoom({ root, token, roomId: `room_${i}`, now: FIXED });
    assert.equal(claimRoom({ root, token, roomId: 'x', now: FIXED }).ok, false);

    const rel = releaseRoom({ root, token, roomId: 'room_0' });
    assert.equal(rel.ok, true);
    assert.equal(rel.released, true);
    assert.equal(claimRoom({ root, token, roomId: 'x', now: FIXED }).ok, true, '释放后应该能再建');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('企业版：额度很大但仍是有限值；工具调用上限才是 Infinity', () => {
  const root = tmpRoot();
  try {
    const { token } = activate({ root, code: 'good-biz', deviceId: 'dev_b', verify: fakeVerify, now: FIXED });
    const q = checkQuota({ root, token, kind: 'rooms', now: FIXED });
    assert.equal(q.allowed, true);
    // 云房间是 200 间（有限、可数、要记进账本），不是 Infinity
    assert.equal(q.limit, HOSTING_PLANS.business.cloudRooms);
    assert.equal(q.used, 0);
    // 工具调用才是"不限"
    const calls = checkQuota({ root, token, kind: 'toolCalls', cost: 999999, now: FIXED });
    assert.equal(calls.allowed, true);
    assert.equal(calls.unlimited, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('企业版：200 间云房间用满后照样拦（不是"写着很大就当无限"）', () => {
  const root = tmpRoot();
  try {
    const { token } = activate({ root, code: 'good-biz', deviceId: 'dev_b', verify: fakeVerify, now: FIXED });
    const limit = HOSTING_PLANS.business.cloudRooms;
    for (let i = 0; i < limit; i += 1) {
      const r = claimRoom({ root, token, roomId: `r${i}`, now: FIXED });
      assert.equal(r.ok, true, `第 ${i + 1} 间应该能建：${r.reason}`);
    }
    const over = claimRoom({ root, token, roomId: 'r_over', now: FIXED });
    assert.equal(over.ok, false);
    assert.equal(over.code, 'room_limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('计量失败一律放行（内部原则：不许拿计量故障拦人）', () => {
  const root = tmpRoot();
  try {
    const res = recordUsage({ root, token: '不存在的' });
    assert.equal(res.ok, false);
    assert.equal(res.counted, false);
    // 关键：不抛错，调用方拿到的是"没记上"，不是异常
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('坏状态文件：恢复成空状态，不崩，原文件不动', () => {
  const root = tmpRoot();
  try {
    saveState({ root, state: { v: 1, tokens: {} } });
    const file = join(root, 'hosting', 'hosting.json');
    assert.ok(existsSync(file));
    writeFileSync(file, '{ 这不是 JSON', 'utf8');

    const loaded = loadState({ root });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.recovered, true);
    // 令牌表现在是 null-prototype（防 __proto__ 冒充令牌），空表用原型 + 键集判断
    assert.equal(Object.getPrototypeOf(loaded.state.tokens), null);
    assert.deepEqual(Object.keys(loaded.state.tokens), []);
    // 原文件应保持原样，方便人工救
    assert.equal(readFileSync(file, 'utf8'), '{ 这不是 JSON');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bearerOf：认得各种大小写的 Authorization', () => {
  assert.equal(bearerOf({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(bearerOf({ Authorization: 'bearer abc' }), 'abc');
  assert.equal(bearerOf({ Authorization: 'Token abc' }), '');
  assert.equal(bearerOf({}), '');
  assert.equal(bearerOf(null), '');
});

test('API：非托管路由返回 null（交给下一个 handler）', () => {
  const root = tmpRoot();
  try {
    const api = createHostingApi({ root, verify: fakeVerify, now: () => FIXED });
    assert.equal(api('GET', '/adbp/v1/manifest'), null);
    assert.equal(api('POST', '/v1/rooms'), null);
    assert.equal(api('GET', '/'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('API：完整走一遍 激活 → 用量 → 建房 → 关房', () => {
  const root = tmpRoot();
  try {
    const api = createHostingApi({ root, verify: fakeVerify, now: () => FIXED });

    const plans = api('GET', '/v1/plans');
    assert.equal(plans.status, 200);
    assert.ok(Array.isArray(plans.json.plans));
    assert.equal(plans.json.plans.length, Object.keys(HOSTING_PLANS).length);

    const act = api('POST', '/v1/activate', { code: 'good-plus', deviceId: 'dev_api' });
    assert.equal(act.status, 200, JSON.stringify(act.json));
    const token = act.json.token;
    assert.ok(token);
    assert.equal(act.json.tier, 'plus');

    const usage = api('POST', '/v1/usage', {}, { Authorization: `Bearer ${token}` });
    assert.equal(usage.status, 200);
    assert.equal(usage.json.used, 0);

    const rec = api('POST', '/v1/usage', { tokens: 7 }, { Authorization: `Bearer ${token}` });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.used, 7);
    assert.equal(rec.json.quotaLeft, HOSTING_PLANS.plus.toolCallsPerDay - 7);

    const claim = api('POST', '/v1/rooms/claim', { roomId: 'r1' }, { Authorization: `Bearer ${token}` });
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    assert.equal(claim.json.used, 1);

    const rel = api('POST', '/v1/rooms/release', { roomId: 'r1' }, { Authorization: `Bearer ${token}` });
    assert.equal(rel.status, 200);
    assert.equal(rel.json.released, true);

    const noAuth = api('POST', '/v1/usage', {});
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('API：坏码激活返回 402，且不带 token', () => {
  const root = tmpRoot();
  try {
    const api = createHostingApi({ root, verify: fakeVerify, now: () => FIXED });
    const res = api('POST', '/v1/activate', { code: 'nope', deviceId: 'dev_x' });
    assert.equal(res.status, 402);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.token, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('API：路径带尾斜杠也认（运维手抖不该 404）', () => {
  const root = tmpRoot();
  try {
    const api = createHostingApi({ root, verify: fakeVerify, now: () => FIXED });
    const res = api('GET', '/v1/plans/');
    assert.equal(res.status, 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dayKey：UTC 切天，跨时区口径一致', () => {
  assert.equal(dayKey(Date.parse('2026-11-07T00:00:00.000Z')), '2026-11-07');
  assert.equal(dayKey(Date.parse('2026-11-07T23:59:59.000Z')), '2026-11-07');
  assert.equal(dayKey(Date.parse('2026-11-08T00:00:00.000Z')), '2026-11-08');
});
