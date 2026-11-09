/**
 * relay 公网 origin 回归：反代/隧道把外部域名交给 relay 后，
 * 生成的邀请链接必须用这个 origin，不能把 127.0.0.1:port 发给客人。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startRelayServer } from '../tools/relay-server.mjs';
import { encodeLicense } from '../lib/license.js';

async function withRelay(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adsk-relay-public-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const code = encodeLicense({
    v: 1,
    id: 'lic_public_url_test',
    tier: 'plus',
    sub: '公网 origin 测试',
    iat: nowSec,
    exp: nowSec + 86400,
    seats: 8,
    skins: [],
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const relay = await startRelayServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    publicKeyB64Url: pubB64,
    publicUrl: 'https://relay.example.com/base',
    quiet: true,
  });
  try {
    await fn({ relay, code });
  } finally {
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('relay publicUrl：/healthz 回显，建房邀请用公网 origin', async () => {
  await withRelay(async ({ relay, code }) => {
    const health = await fetch(`${relay.url}/healthz`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.publicUrl, 'https://relay.example.com/base');

    const created = await fetch(`${relay.url}/v1/rooms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${code}`,
      },
      body: JSON.stringify({ name: '公网邀请测试', teamId: 'team_public' }),
    });
    assert.equal(created.status, 201);
    const room = await created.json();
    assert.match(room.inviteWebUrl, /^https:\/\/relay\.example\.com\/base\/\?room=/);
    assert.ok(room.inviteWebUrl.includes(`t=${room.inviteToken}`));
  });
});

test('relay publicUrl：拒绝带查询串/凭据的非法地址', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsk-relay-public-bad-'));
  try {
    await assert.rejects(
      () => startRelayServer({ port: 0, dataDir: dir, publicUrl: 'https://user:pass@example.com/?x=1' }),
      /publicUrl/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
