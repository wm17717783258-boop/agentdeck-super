/**
 * 公网隧道模块测试：只相信“公网 /healthz 真的 200”，不相信子进程打印了 URL。
 * 用假 spawn/fetch 测状态机，不访问真实第三方隧道。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  detectTunnelProviders,
  normalizePublicUrl,
  startTunnel,
  verifyPublicHealth,
} from '../tools/nexi-tunnel.mjs';

function fakeChild(url, { exitAfter = false } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.emit('exit', 0); };
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(`${url}\n`));
    if (exitAfter) child.emit('exit', 0);
  });
  return child;
}

const detected = {
  cloudflared: { available: false, command: '' },
  localtunnel: { available: true, command: 'npx', via: 'npx' },
};

test('normalizePublicUrl：补 https，拒绝非 http(s)/凭据/查询串', () => {
  assert.equal(normalizePublicUrl('relay.example.com'), 'https://relay.example.com');
  assert.equal(normalizePublicUrl('https://relay.example.com/base/'), 'https://relay.example.com/base');
  assert.throws(() => normalizePublicUrl('ftp://relay.example.com'), /http/);
  assert.throws(() => normalizePublicUrl('https://u:p@relay.example.com'), /用户名/);
  assert.throws(() => normalizePublicUrl('https://relay.example.com/?x=1'), /查询参数/);
});

test('startTunnel：外部 publicUrl 直接采用，不启动子进程', async () => {
  const out = await startTunnel({ publicUrl: 'relay.example.com' });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'external');
  assert.equal(out.url, 'https://relay.example.com');
});

test('startTunnel：只有 URL 但 /healthz 不通 → 失败，不能当成功', async () => {
  const out = await startTunnel({
    provider: 'localtunnel',
    port: 8787,
    timeoutMs: 5000,
    detected,
    spawnImpl: () => fakeChild('https://fake.loca.lt', { exitAfter: true }),
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /启动失败|不可达/);
  assert.ok(Array.isArray(out.failures));
});

test('startTunnel：公网 /healthz 200 才成功，stop 清理子进程', async () => {
  let killed = false;
  const spawnImpl = (cmd) => {
    if (cmd === 'taskkill') {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit('exit', 0));
      return killer;
    }
    const child = fakeChild('https://fake.loca.lt');
    const oldKill = child.kill;
    child.kill = () => { killed = true; oldKill(); };
    return child;
  };
  const out = await startTunnel({
    provider: 'localtunnel',
    port: 8787,
    timeoutMs: 5000,
    detected,
    spawnImpl,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'localtunnel');
  assert.equal(out.url, 'https://fake.loca.lt');
  await out.stop();
  assert.equal(killed, true);
});

test('startTunnel：显式指定不可用的 provider 时不 spawn 空命令，给出可读原因', async () => {
  let spawned = 0;
  const out = await startTunnel({
    provider: 'cloudflared',
    port: 8787,
    timeoutMs: 5000,
    detected: {
      cloudflared: { available: false, command: '', note: '未找到 cloudflared；装法：winget install --id Cloudflare.cloudflared' },
      localtunnel: { available: true, command: 'npx' },
    },
    spawnImpl: () => { spawned += 1; throw new Error('不该被调用'); },
  });
  assert.equal(out.ok, false);
  assert.equal(spawned, 0);
  assert.match(out.reason, /没有可用的隧道 provider/);
  assert.match(out.reason, /winget install/);
});

test('detectTunnelProviders：available 与 command 必须一致，不能报可用却没命令', () => {
  const providers = detectTunnelProviders();
  for (const id of ['cloudflared', 'localtunnel']) {
    assert.equal(
      providers[id].available,
      Boolean(providers[id].command),
      `${id} 的 available 和 command 不一致`,
    );
  }
});

test('verifyPublicHealth：公开探活必须拿到 200', async () => {
  const ok = await verifyPublicHealth('https://relay.example.com', {
    timeoutMs: 3000,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(ok.ok, true);

  const bad = await verifyPublicHealth('https://relay.example.com', {
    timeoutMs: 3000,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /不可达/);
});
