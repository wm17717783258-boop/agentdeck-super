/**
 * tests/room-last-relay.test.mjs —— 进房之后，后续调用要能自己找回中继地址
 *
 * 真机踩到的坑（第三次才修对）：
 *   1) guest 用网页链接进房 —— 成功
 *   2) 紧接着 sync 报到 —— 报"还没有配置 relay 地址"
 *   因为 sync 是**下一次工具调用**，上一次的 relayOverride 已经清空了。
 *
 * 修法：进房成功时把 relay 地址记进 last.json，后续调用读回来。
 * 这个文件就盯这条链：join → 写 last.json → sync 自动沿用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { startRelayServer } from '../tools/relay-server.mjs';
import { encodeLicense } from '../lib/license.js';
import { generateKeyPairSync } from 'node:crypto';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

// 房间会话现在存"机级"目录（一台设备一个席位）。测试绝不能碰真实的 ~/.dsh，
// 否则跑一遍单测就把开发机自己的房间记录改掉了。
process.env.DSH_HOME ||= mkdtempSync(join(tmpdir(), 'nexi-room-home-'));

/** 起一个真 relay + 真房间，返回 host 端的邀请与地址。 */
async function makeRoom() {
  const dir = mkdtempSync(join(tmpdir(), 'adsk-lastrelay-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  // 关键：签码用的是临时密钥，必须让插件也用这把公钥验签，
  // 否则授权码会被当成"无效"、档位回落免费版（真机踩过这个坑）
  process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
  const nowSec = Math.floor(Date.now() / 1000);
  const code = encodeLicense({
    v: 1, id: `lic_last_${Math.random().toString(16).slice(2, 8)}`, tier: 'plus',
    sub: 'last-relay', iat: nowSec, exp: nowSec + 3600, seats: 8, skins: [],
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const relay = await startRelayServer({ port: 0, dataDir: join(dir, 'relay'), publicKeyB64Url: pubB64, quiet: true });
  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const licDir = join(dir, 'lic');

  // host 侧：建房间拿邀请
  const hostHub = await createHub({ workspace: join(dir, 'host'), boardRoot: join(dir, 'hb'), licenseRoot: licDir, onLog: () => {} });
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(licDir, '.agentdeck', 'license'), { recursive: true });
  writeFileSync(join(licDir, '.agentdeck', 'license', 'key.txt'), code, 'utf8');

  const createOut = textOf(await hostHub.tools.get('deck_room').execute(
    { action: 'create', name: 'last-relay 房间', relayUrl },
    { hub: true },
  ));
  await hostHub.close();

  const roomId = (/room[=:]?\s*([0-9a-f-]{8,})/i.exec(createOut) || [])[1] || '';
  const token = (/(?:t=|邀请码[：:]\s*)([\w-]{8,})/.exec(createOut) || [])[1] || '';
  return { dir, relay, relayUrl, invite: `${relayUrl}/?room=${roomId}&t=${token}`, roomId, token };
}

test('进房成功后 last.json 里记下了 relayUrl，且 sync 能自动沿用', { timeout: 60000 }, async () => {
  const { dir, relay, relayUrl, invite } = await makeRoom();
  let guestHub = null;
  try {
    assert.ok(invite.includes('room='), `邀请没拼对：${invite}`);

    const guestRoot = join(dir, 'guest');
    // roomRoot 显式指到本用例目录：默认是机级目录，这里要断言落盘位置就必须钉住
    guestHub = await createHub({ workspace: guestRoot, boardRoot: join(dir, 'gb'), roomRoot: guestRoot, licenseRoot: join(dir, 'gl'), onLog: () => {} });

    // 1) 进房（链接里带地址）
    const joinOut = textOf(await guestHub.tools.get('deck_room').execute({ action: 'join', inviteUrl: invite }, { hub: true }));
    assert.match(joinOut, /已进房间/, `进房失败：${joinOut.slice(0, 200)}`);

    // 2) last.json 必须记下 relayUrl
    const lastFile = join(guestRoot, '.agentdeck', 'rooms', 'last.json');
    assert.ok(existsSync(lastFile), `没写 last.json：${lastFile}`);
    const last = JSON.parse(readFileSync(lastFile, 'utf8'));
    assert.equal(String(last.relayUrl || ''), relayUrl, `last.json 里的 relayUrl 不对：${JSON.stringify(last)}`);

    // 3) 关键：sync **不带** relayUrl，也应该成功（从 last.json 读回）
    const syncOut = textOf(await guestHub.tools.get('deck_room').execute({ action: 'sync', waitSec: 0 }, { hub: true }));
    assert.doesNotMatch(syncOut, /没有配置 relay|还没有配置 relay/, `sync 没找回中继：${syncOut.slice(0, 200)}`);
    assert.match(syncOut, /同步|任务|圈/, `sync 应给出正常结果：${syncOut.slice(0, 200)}`);
  } finally {
    try { await guestHub?.close(); } catch { /* 忽略 */ }
    try { await relay.close(); } catch { /* 忽略 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('显式 relayUrl 优先，且会覆盖 last.json 里记的', { timeout: 60000 }, async () => {
  const { dir, relay, relayUrl, invite } = await makeRoom();
  let guestHub = null;
  try {
    const guestRoot = join(dir, 'guest2');
    guestHub = await createHub({ workspace: guestRoot, boardRoot: join(dir, 'gb2'), roomRoot: guestRoot, licenseRoot: join(dir, 'gl2'), onLog: () => {} });

    const joinOut = textOf(await guestHub.tools.get('deck_room').execute(
      { action: 'join', inviteUrl: invite, relayUrl },
      { hub: true },
    ));
    assert.match(joinOut, /已进房间/, `进房失败：${joinOut.slice(0, 200)}`);

    const last = JSON.parse(readFileSync(join(guestRoot, '.agentdeck', 'rooms', 'last.json'), 'utf8'));
    assert.equal(last.relayUrl, relayUrl);
  } finally {
    try { await guestHub?.close(); } catch { /* 忽略 */ }
    try { await relay.close(); } catch { /* 忽略 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
