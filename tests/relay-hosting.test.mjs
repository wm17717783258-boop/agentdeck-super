/**
 * tests/relay-hosting.test.mjs —— 托管 API 真的挂进 relay 了吗（起真 HTTP 服务真发请求）
 *
 * 为什么单开一个：lib/hosting 的单测证明的是"账算得对"；这里证明的是"接线生效"——
 * relay 起真服务、真发 POST，看 /v1/activate 是不是真能换到令牌。
 * 和 tests/policy-wiring.test.mjs 同一个思路：不测引擎算得对，测它有没有接上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startRelayServer } from '../tools/relay-server.mjs';
import { encodeLicense } from '../lib/license.js';
import { generateKeyPairSync } from 'node:crypto';

/** 造一对临时签发密钥 + 一张真授权码（不碰卖家私钥）。 */
function makeIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const nowSec = Math.floor(Date.now() / 1000);
  const code = encodeLicense({
    v: 1,
    id: 'lic_test_hosting',
    tier: 'plus',
    sub: '测试客户',
    iat: nowSec,
    exp: nowSec + 86400,
    seats: 8,
    skins: [],
  }, privPem);
  return { pubB64, code };
}

async function withRelay(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adsk-relay-hosting-'));
  const { pubB64, code } = makeIssuer();
  let relay = null;
  try {
    relay = await startRelayServer({ port: 0, dataDir: dir, publicKeyB64Url: pubB64, quiet: true });
    await fn({ base: `http://127.0.0.1:${relay.port}`, code });
  } finally {
    try { await relay?.close(); } catch { /* 关不掉不影响测试结论 */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = async (url, body, token) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('GET /v1/plans：公开档位表，不鉴权', async () => {
  await withRelay(async ({ base }) => {
    const res = await fetch(`${base}/v1/plans`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.plans) && json.plans.length >= 4);
    assert.ok(json.plans.some((p) => p.id === 'plus'));
  });
});

test('POST /v1/activate：真授权码换到令牌（relay 自己的公钥验的签）', async () => {
  await withRelay(async ({ base, code }) => {
    const res = await post(`${base}/v1/activate`, { code, deviceId: 'dev_test_1' });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true);
    assert.match(res.json.token, /^hst_/);
    assert.equal(res.json.tier, 'plus');
    assert.ok(res.json.plan && res.json.plan.cloudRooms > 0, '协作版应有云房间额度');
  });
});

test('POST /v1/activate：假授权码被拒（402）', async () => {
  await withRelay(async ({ base }) => {
    const res = await post(`${base}/v1/activate`, { code: 'ADSK1.fake.fake', deviceId: 'dev_test_2' });
    assert.equal(res.status, 402, JSON.stringify(res.json));
    assert.equal(res.json.ok, false);
    assert.equal(res.json.token, undefined);
  });
});

test('用量与建房配额：真令牌走完整条链', async () => {
  await withRelay(async ({ base, code }) => {
    const act = await post(`${base}/v1/activate`, { code, deviceId: 'dev_test_3' });
    const token = act.json.token;

    const u0 = await post(`${base}/v1/usage`, {}, token);
    assert.equal(u0.status, 200);
    assert.equal(u0.json.used, 0);

    const u1 = await post(`${base}/v1/usage`, { tokens: 5 }, token);
    assert.equal(u1.json.used, 5);
    assert.equal(u1.json.quotaLeft, u1.json.limit - 5);

    const claim = await post(`${base}/v1/rooms/claim`, { roomId: 'room_x' }, token);
    assert.equal(claim.status, 200, JSON.stringify(claim.json));
    assert.equal(claim.json.used, 1);

    const rel = await post(`${base}/v1/rooms/release`, { roomId: 'room_x' }, token);
    assert.equal(rel.json.released, true);
  });
});

test('没令牌的 /v1/usage 返回 401', async () => {
  await withRelay(async ({ base }) => {
    const res = await post(`${base}/v1/usage`, {});
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
  });
});

test('托管路由不抢既有房间路由：POST /v1/rooms 仍归 relay 自己管', async () => {
  await withRelay(async ({ base }) => {
    // 不带授权码建房间 → relay 自己的授权校验应该拒（402），而不是被托管模块接管
    const res = await post(`${base}/v1/rooms`, { name: '测试房' });
    assert.equal(res.status, 402, `房间路由被抢了？拿到 ${res.status} ${JSON.stringify(res.json)}`);
  });
});
