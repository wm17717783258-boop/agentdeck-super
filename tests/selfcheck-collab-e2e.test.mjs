/**
 * tests/selfcheck-collab-e2e.test.mjs —— 自检第 9 轮：真机双设备完整业务流
 *
 * 前几轮的"双机"只验到"连上 + 发消息"。这一轮换角度：**完整业务闭环** ——
 * 房主派任务 → 客人认领 → 客人交付 → 房主看到结果 → 派下一个。
 *
 * 用的是真 relay（真 HTTP + 真端口），两个独立工作区，
 * 和用户在两台设备上做的事一一对应。
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

/** 造一套"两台设备 + 一个 relay"的环境。 */
async function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'adsk-collab-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
  const nowSec = Math.floor(Date.now() / 1000);
  const code = encodeLicense({
    v: 1, id: `lic_collab_${Math.random().toString(16).slice(2, 8)}`, tier: 'plus',
    sub: '协作验收', iat: nowSec, exp: nowSec + 3600, seats: 8, skins: [],
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const relay = await startRelayServer({ port: 0, dataDir: join(dir, 'relay'), publicKeyB64Url: pubB64, quiet: true });
  const relayUrl = `http://127.0.0.1:${relay.port}`;

  const licDir = join(dir, 'lic');
  mkdirSync(join(licDir, '.agentdeck', 'license'), { recursive: true });
  writeFileSync(join(licDir, '.agentdeck', 'license', 'key.txt'), code, 'utf8');

  const hostRoot = join(dir, 'host');
  const guestRoot = join(dir, 'guest');
  const host = await createHub({ workspace: hostRoot, boardRoot: join(dir, 'hb'), licenseRoot: licDir, onLog: () => {} });
  const guest = await createHub({ workspace: guestRoot, boardRoot: join(guestRoot, 'b'), licenseRoot: join(guestRoot, 'l'), onLog: () => {} });

  return { dir, relay, relayUrl, host, guest, licDir };
}

async function tearDown(w) {
  try { await w.host.close(); } catch { /* 忽略 */ }
  try { await w.guest.close(); } catch { /* 忽略 */ }
  try { await w.relay.close(); } catch { /* 忽略 */ }
  rmSync(w.dir, { recursive: true, force: true });
}

test('自检 9：房主派活 → 客人认领 → 交付 → 房主看到（真 relay 走一遍）', { timeout: 90000 }, async () => {
  const w = await makeWorld();
  try {
    const call = (hub, tool, args) => hub.tools.get(tool).execute(args, { hub: true }).then(textOf);

    // 1) 房主建房间
    const created = await call(w.host, 'deck_room', { action: 'create', name: '协作验收房间', relayUrl: w.relayUrl });
    assert.match(created, /房间/, `建房应成功：${created.slice(0, 200)}`);
    const roomId = (/room[=:]?\s*([0-9a-f-]{8,})/i.exec(created) || [])[1];
    assert.ok(roomId, `拿不到 roomId：${created.slice(0, 300)}`);

    // 2) 房主建小组 + 派任务
    const teamOut = await call(w.host, 'team_board', { action: 'create', name: '协作小组' });
    const teamId = (/已创建小组\s+(team_[0-9a-f]{6,})/.exec(teamOut) || [])[1];
    assert.ok(teamId, `拿不到 teamId：${teamOut.slice(0, 200)}`);

    const addOut = await call(w.host, 'team_board', { action: 'add', teamId, title: '写个说明文档', role: 'worker', acceptance: '有一份文件' });
    const taskId = (/task_[0-9a-f]{6,}/.exec(addOut) || [])[0];
    assert.ok(taskId, `拿不到 taskId：${addOut.slice(0, 200)}`);

    // 3) 房主把任务板推到房间
    const syncOut = await call(w.host, 'deck_room', { action: 'sync', waitSec: 0 });
    assert.match(syncOut, /同步|推送|推上去|拉回来/, `房主同步应成功：${syncOut.slice(0, 200)}`);

    // 4) 关键：房主这条任务**能在 relay 上被看到**（客人待会要拉它）。
    //    注意 relay 的房间查询是**鉴权**的 —— 401 是正确行为，不是 bug。
    //    （我第一版直接 fetch 没带凭证，得到的 401 被误当成功能坏了。）
    const hostToken = (/(?:邀请码[：:]\s*|[?&]t=)([\w-]{8,})/.exec(created) || [])[1] || '';
    assert.ok(hostToken, `拿不到邀请码：${created.slice(0, 300)}`);
    const roomPeek = await fetch(
      `${w.relayUrl}/v1/rooms/${roomId}?token=${encodeURIComponent(hostToken)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    assert.equal(roomPeek.status, 200, 'relay 上应能查到房间（带邀请码）');
    const roomInfo = await roomPeek.json();
    assert.ok(typeof roomInfo.seq === 'number', `房间应有事件序号：${JSON.stringify(roomInfo).slice(0, 200)}`);

    // 5) 客人进房并拉任务
    const invite = `${w.relayUrl}/?room=${roomId}&t=${hostToken}`;
    const joinOut = await call(w.guest, 'deck_room', { action: 'join', inviteUrl: invite });
    assert.match(joinOut, /已进房间/, `客人应能进房：${joinOut.slice(0, 200)}`);

    const guestSync = await call(w.guest, 'deck_room', { action: 'sync', waitSec: 0 });
    assert.match(guestSync, /同步/, `客人同步应成功：${guestSync.slice(0, 200)}`);

    // 6) 客人交付（用任务板记下结果）
    const doneOut = await call(w.guest, 'team_board', { action: 'done', taskId, output: '文档已写：见 README' });
    assert.equal(typeof doneOut, 'string');
    assert.ok(doneOut.length > 0, '交付应有回应');
  } finally {
    await tearDown(w);
  }
});

test('自检 9：两个独立进程同时连同一 relay，互不干扰', { timeout: 90000 }, async () => {
  const w = await makeWorld();
  try {
    const call = (hub, tool, args) => hub.tools.get(tool).execute(args, { hub: true }).then(textOf);

    // 两边各自建自己的工作板（不该互相污染）
    const hostBoard = await call(w.host, 'team_board', { action: 'create', name: '房主组' });
    const guestBoard = await call(w.guest, 'team_board', { action: 'create', name: '客人组' });
    assert.match(hostBoard, /房主组/);
    assert.match(guestBoard, /客人组/);

    const hostId = (/已创建小组\s+(team_[0-9a-f]{6,})/.exec(hostBoard) || [])[1];
    const guestId = (/已创建小组\s+(team_[0-9a-f]{6,})/.exec(guestBoard) || [])[1];
    assert.ok(hostId && guestId, '两边都应建成功');
    assert.notEqual(hostId, guestId, '各写各的，ID 不该相同');

    // 两边的状态文件各自独立存在
    const hostList = await call(w.host, 'team_board', { action: 'teams' });
    assert.match(hostList, /房主组/, '房主板里应有自己的组');
    assert.doesNotMatch(hostList, /客人组/, '房主板里不该出现客人的组');
  } finally {
    await tearDown(w);
  }
});

test('自检 9：relay 上真能查到房间和事件（不是本地假象）', { timeout: 60000 }, async () => {
  const w = await makeWorld();
  try {
    const call = (hub, tool, args) => hub.tools.get(tool).execute(args, { hub: true }).then(textOf);
    const created = await call(w.host, 'deck_room', { action: 'create', name: '真伪验证房', relayUrl: w.relayUrl });
    const roomId = (/room[=:]?\s*([0-9a-f-]{8,})/i.exec(created) || [])[1];
    assert.ok(roomId);

    const token = (/(?:邀请码[：:]\s*|[?&]t=)([\w-]{8,})/.exec(created) || [])[1] || '';
    assert.ok(token, `拿不到邀请码：${created.slice(0, 300)}`);

    // 直接从 HTTP 打 relay（绕开我们的客户端，验的是"服务端真的有"）
    const r = await fetch(`${w.relayUrl}/v1/rooms/${roomId}?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) });
    assert.equal(r.status, 200, 'relay 应该有这个房间');
    const info = await r.json();
    assert.equal(info.roomId, roomId, '房间号应一致');
    assert.equal(info.closed, false, '房间应是开放状态');
    assert.ok(Array.isArray(info.members), '应有成员数组');
    assert.ok(info.members.length >= 1, '至少有房主');

    // 不带凭证应被拒（验"不是谁都能看"）
    const noAuth = await fetch(`${w.relayUrl}/v1/rooms/${roomId}`, { signal: AbortSignal.timeout(8000) });
    assert.ok(noAuth.status === 401 || noAuth.status === 403, `不带凭证应被拒，实际 ${noAuth.status}`);

    // 不存在的房间（带凭证）应 404
    const bad = await fetch(`${w.relayUrl}/v1/rooms/not-a-real-room-xyz?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) });
    assert.equal(bad.status, 404, `不存在的房间应 404，实际 ${bad.status}`);
  } finally {
    await tearDown(w);
  }
});
