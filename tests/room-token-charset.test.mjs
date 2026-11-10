/**
 * tests/room-token-charset.test.mjs —— 邀请令牌的字符集必须完整支持
 *
 * 真机抓到的 bug：从链接里抠 token 用的正则是 `[\w-]`，但 relay 发的 token 是
 * **base64url**（含 `-` 和 `_`）。`\w` 不含 `-`，于是 token 被截断，
 * 报"邀请已失效或不是这个房间的邀请"——链接明明是对的。
 *
 * 这个文件把字符集钉死：带 `-` 和 `_` 的 token 必须原样透传。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { createHub } from '../lib/hub.js';
import { startRelayServer } from '../tools/relay-server.mjs';
import { encodeLicense } from '../lib/license.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

// 房间会话存"机级"目录：测试一律用临时 DSH_HOME，别碰开发机真实数据。
process.env.DSH_HOME ||= mkdtempSync(join(tmpdir(), 'nexi-room-home-'));

/** 起真 relay + 真房间；返回邀请、relay 地址和真实的 inviteToken。 */
async function makeRoom() {
  const dir = mkdtempSync(join(tmpdir(), 'adsk-tokchars-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
  const nowSec = Math.floor(Date.now() / 1000);
  const code = encodeLicense({
    v: 1, id: `lic_tok_${Math.random().toString(16).slice(2, 8)}`, tier: 'plus',
    sub: 'tok', iat: nowSec, exp: nowSec + 3600, seats: 8, skins: [],
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const relay = await startRelayServer({ port: 0, dataDir: join(dir, 'relay'), publicKeyB64Url: pubB64, quiet: true });
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const licDir = join(dir, 'lic');
  mkdirSync(join(licDir, '.agentdeck', 'license'), { recursive: true });
  writeFileSync(join(licDir, '.agentdeck', 'license', 'key.txt'), code, 'utf8');

  const hubA = await createHub({ workspace: join(dir, 'a'), boardRoot: join(dir, 'ab'), licenseRoot: licDir, onLog: () => {} });
  const out = textOf(await hubA.tools.get('deck_room').execute(
    { action: 'create', name: 'token 字符集测试', relayUrl },
    { hub: true },
  ));
  await hubA.close();

  // 从 relay 侧直接拿真实 token，避免被我们自己的正则误导
  const info = textOf(await (async () => {
    const h = await createHub({ workspace: join(dir, 'a2'), boardRoot: join(dir, 'ab'), licenseRoot: licDir, onLog: () => {} });
    const r = textOf(await h.tools.get('deck_room').execute({ action: 'info', relayUrl }, { hub: true }));
    await h.close();
    return r;
  })());

  return { dir, relay, relayUrl, createOut: out, infoOut: info };
}

test('relay 发的邀请令牌含 base64url 字符（- 和 _），必须能被完整解析', { timeout: 60000 }, async () => {
  const { dir, relay, relayUrl, createOut } = await makeRoom();
  try {
    // 从建房间输出里取邀请链接里的 token
    const m = /[?&]t=([^\s&"']+)/.exec(createOut);
    assert.ok(m, `建房间输出里没有 t= 参数：${createOut.slice(0, 300)}`);
    const token = m[1];

    // relay 用的是随机 base64url，长度通常 >= 20
    assert.ok(token.length >= 16, `token 太短，可能被截断了：${token}`);

    // 关键：把这条链接原样喂给另一个 hub 的 join，必须能解析出**完整** token
    const dirB = join(dir, 'guest');
    const hubB = await createHub({ workspace: dirB, boardRoot: join(dir, 'bb'), licenseRoot: join(dir, 'bl'), onLog: () => {} });
    try {
      const inviteUrl = `${relayUrl}/?room=${(/[?&]room=([^\s&"']+)/.exec(createOut) || [])[1]}&t=${token}`;
      const joinOut = textOf(await hubB.tools.get('deck_room').execute({ action: 'join', inviteUrl }, { hub: true }));
      assert.doesNotMatch(joinOut, /邀请已失效|不是这个房间的邀请/, `token 被截断了：\n链接=${inviteUrl}\n输出=${joinOut.slice(0, 200)}`);
      assert.match(joinOut, /已进房间/, `进房应成功：${joinOut.slice(0, 200)}`);
    } finally {
      await hubB.close();
    }
  } finally {
    try { await relay.close(); } catch { /* 忽略 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('手写的含 - 和 _ 的 token 也能原样透传（不依赖 relay 随机性）', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-toklit-'));
  try {
    const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
    try {
      // 用一个含 - 和 _ 的 token 去 join（房间不存在，但报错不该是"格式不对/截断"）
      const tok = 'AbC-dEf_GhI-jKl_MnO';
      const out = textOf(await hub.tools.get('deck_room').execute(
        { action: 'join', inviteUrl: `http://127.0.0.1:1/?room=test-room&t=${tok}` },
        { hub: true },
      ));
      // 连不上是预期的（端口 1 没人听），但绝不能是"缺邀请码"这类**解析**失败
      assert.doesNotMatch(out, /需要房间号和邀请码/, `token 没被解析出来：${out.slice(0, 200)}`);
      assert.match(out, /连不上|失败|fetch/i, `应该是网络错误：${out.slice(0, 200)}`);
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
