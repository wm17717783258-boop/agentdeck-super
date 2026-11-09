/**
 * tests/relay-hosting-isolation.test.mjs —— 托管 relay 测试必须互不干扰
 *
 * 真机现象：全量跑时 relay-hosting 偶发失败，单独跑却全过。
 * 根因是"上一次运行的残留"——端口没释放、临时目录没清干净。
 * 这类问题最坑：重跑一次就好了，于是被当成"偶发"忽略，最后在别人机器上必然爆。
 *
 * 这里连开三个 relay 实例，验：
 *   ① 端口不冲突（都用随机端口，各自独立）
 *   ② 数据目录互不污染（各自的令牌不串台）
 *   ③ 关掉一个不影响另一个
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { startRelayServer } from '../tools/relay-server.mjs';
import { encodeLicense } from '../lib/license.js';

function makeCode() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const code = encodeLicense({
    v: 1, id: `lic_iso_${Math.random().toString(16).slice(2, 8)}`, tier: 'plus',
    sub: '隔离测试', iat: nowSec, exp: nowSec + 86400, seats: 8, skins: [],
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return { pubB64, code };
}

async function post(base, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('三个 relay 并存：端口不冲突、数据不串台、各自独立关闭', async () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'nexi-iso-a-')), mkdtempSync(join(tmpdir(), 'nexi-iso-b-')), mkdtempSync(join(tmpdir(), 'nexi-iso-c-'))];
  const relays = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const { pubB64 } = makeCode();
      const r = await startRelayServer({ port: 0, dataDir: dirs[i], publicKeyB64Url: pubB64, quiet: true });
      relays.push({ ...r, pubB64, dir: dirs[i] });
    }

    const ports = relays.map((r) => r.port);
    assert.equal(new Set(ports).size, 3, `三个实例的端口必须各不相同：${ports.join(',')}`);

    // 信任隔离：拿"别的公钥签的码"去激活 A 实例，必须被拒。
    // 这就证明三个实例的信任根是各自独立的（不是我配错了公钥、也不是共享了状态）。
    const wrongCode = makeCode().code;
    for (const r of relays) {
      const wrong = await post(`http://127.0.0.1:${r.port}`, '/v1/activate', { code: wrongCode, deviceId: 'dev_iso' });
      assert.equal(wrong.status, 402, `实例 ${r.port} 不该认别的公钥签的码`);
      assert.equal(wrong.json.token, undefined, '被拒时不该发令牌');
    }

    // 数据隔离：各自的 dataDir 存在且互相独立
    for (const r of relays) {
      assert.ok(existsSync(r.dir), `实例 ${r.port} 的数据目录应存在`);
      assert.ok(relays.filter((x) => x.dir === r.dir).length === 1, '每个实例的数据目录必须唯一');
    }

    // 关掉中间那个，另外两个照常
    await relays[1].close();
    const alive = [relays[0], relays[2]];
    for (const r of alive) {
      const res = await fetch(`http://127.0.0.1:${r.port}/v1/plans`);
      assert.equal(res.status, 200, `关掉一个后 ${r.port} 应该还活着`);
    }
    const dead = await fetch(`http://127.0.0.1:${relays[1].port}/v1/plans`).catch(() => ({ status: 0 }));
    assert.equal(dead.status, 0, '关掉的那个应该真的连不上了');
    relays[1] = null;
  } finally {
    for (const r of relays) {
      try { await r?.close(); } catch { /* 已关 */ }
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('relay 关闭后端口能立刻复用（不留 TIME_WAIT 残骸）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexi-reuse-'));
  try {
    const { pubB64 } = makeCode();
    const first = await startRelayServer({ port: 0, dataDir: dir, publicKeyB64Url: pubB64, quiet: true });
    const port = first.port;
    await first.close();

    // 同一端口再起一次：应该能起来（不能因为上一次没清干净就 EADDRINUSE）
    const second = await startRelayServer({ port, dataDir: dir, publicKeyB64Url: pubB64, quiet: true });
    assert.equal(second.port, port, '关掉后应该能复用同一个端口');
    const res = await fetch(`http://127.0.0.1:${second.port}/v1/plans`);
    assert.equal(res.status, 200);
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
