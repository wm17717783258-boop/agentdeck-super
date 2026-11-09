import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard } from '../lib/engine/board.js';
import { createRoomClient } from '../lib/room.js';
import { encodeLicense, entitlements, verifyLicense } from '../lib/license.js';
import { startRelayServer } from '../tools/relay-server.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const nowSec = Math.floor(Date.now() / 1000);

function issueLic(tier, extra = {}) {
  return encodeLicense({
    v: 1,
    id: `lic_${tier}_test`,
    tier,
    sub: '房主',
    iat: nowSec,
    exp: nowSec + 86400 * 30,
    ...extra,
  }, privPem);
}

function makeLicense(tier, extra = {}) {
  const key = issueLic(tier, extra);
  const v = verifyLicense(key, { publicKeyB64Url: pubB64 });
  assert.equal(v.ok, true, v.reason);
  return { ...v, key, entitlements: entitlements(tier) };
}

/** 起一套「relay + 两台机器（各自 board/root）」的环境 */
async function setup() {
  const relayDir = mkdtempSync(join(tmpdir(), 'adsk-relay-'));
  const rootA = mkdtempSync(join(tmpdir(), 'adsk-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'adsk-b-'));
  const relay = await startRelayServer({ port: 0, dataDir: relayDir, publicKeyB64Url: pubB64 });
  const boardA = createBoard({ root: rootA });
  const boardB = createBoard({ root: rootB });
  const teamA = boardA.createTeam({ name: '房主的组', goal: '一起把活干完' });
  const teamB = boardB.createTeam({ name: '客人的组', goal: '接活' });
  const teamAId = teamA.id || teamA.teamId || teamA;
  const teamBId = teamB.id || teamB.teamId || teamB;
  return {
    relay,
    rootA,
    rootB,
    boardA,
    boardB,
    teamAId,
    teamBId,
    cleanup: async () => {
      await relay.close();
      for (const d of [relayDir, rootA, rootB]) rmSync(d, { recursive: true, force: true });
    },
  };
}

test('建房间要授权：免费档在客户端就被挡住，说清楚要升级', async () => {
  const env = await setup();
  try {
    const client = createRoomClient({ relayUrl: env.relay.url, root: env.rootA, board: env.boardA, teamId: env.teamAId, license: makeLicense('free') });
    const r = await client.createRoom({ name: '不该建起来' });
    assert.equal(r.ok, false);
    assert.equal(r.needUpgrade, true);
    assert.match(r.reason, /协作版/);
  } finally {
    await env.cleanup();
  }
});

test('relay 服务端也挡：无效授权码建不了房（本地改代码绕不过）', async () => {
  const env = await setup();
  try {
    const res = await fetch(`${env.relay.url}/v1/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ADSK1.fake.sig' },
      body: JSON.stringify({ name: 'x' }),
    });
    const data = await res.json();
    assert.equal(res.status, 402);
    assert.equal(data.code, 'license_required');
    assert.ok(data.error.length > 4);
  } finally {
    await env.cleanup();
  }
});

test('端到端：房主建房 → 客人凭邀请进房 → 任务跨机流转（含幂等）', async () => {
  const env = await setup();
  let owner;
  let guest;
  try {
    owner = createRoomClient({
      relayUrl: env.relay.url,
      root: env.rootA,
      board: env.boardA,
      teamId: env.teamAId,
      license: makeLicense('pro'),
    });
    const created = await owner.createRoom({ name: '联调房间' });
    assert.equal(created.ok, true, created.reason);
    assert.match(created.inviteUrl, /^dsh:\/\/agentdeck\/join\?room=[\w-]+&t=[\w-]+$/);

    // 客人在「另一台机器」上凭邀请进房（不需要授权码）
    guest = createRoomClient({ relayUrl: env.relay.url, root: env.rootB, board: env.boardB, teamId: env.teamBId, license: makeLicense('free') });
    const joined = await guest.joinRoom({ inviteUrl: created.inviteUrl, member: { name: '客人' } });
    assert.equal(joined.ok, true, joined.reason);
    assert.equal(joined.members.length, 2, '房间里应该有两个席位');

    // 房主在本机板子上加一个任务并推上去
    const localTask = env.boardA.addTask(env.teamAId, { title: '写一个登录页', role: 'worker', acceptance: '能登录' });
    const pushed = await owner.publishLocalTasks();
    assert.equal(pushed.ok, true, pushed.reason);
    assert.ok(pushed.accepted >= 1);

    // 客人拉取 → 自己的板子上出现这个任务（id 带来源前缀）
    const pulled = await guest.pull();
    assert.equal(pulled.ok, true, pulled.reason);
    assert.ok(pulled.applied >= 1, `应该物化至少一个任务，实际 ${JSON.stringify(pulled)}`);
    // 房间绑定房主的小组：客人拉下来的任务落在同一个小组 id 上
    const sharedTeam = String(joined.room?.teamId || env.teamAId);
    assert.equal(sharedTeam, String(env.teamAId), 'relay 要把房主的小组 id 下发给客人');
    const guestTasks = env.boardB.listTasks(sharedTeam, {});
    assert.equal(guestTasks.length, 1);
    assert.equal(guestTasks[0].title, '写一个登录页');
    assert.match(guestTasks[0].id, /^r_[a-z0-9]{1,6}_/);

    // 幂等：再拉一次不产生重复任务
    const again = await guest.pull();
    assert.equal(again.ok, true);
    assert.equal(env.boardB.listTasks(sharedTeam, {}).length, 1, '重复拉取不能长出重复任务');

    // 客人认领并完成 → 推回房主（用 refFor 取「房间坐标」，跨机 id 才不会错位）
    const guestTask = env.boardB.listTasks(sharedTeam, {})[0];
    assert.equal(env.boardB.claimTask(sharedTeam, guestTask.id, '客人'), true);
    const claimRef = guest.refFor(guestTask.id);
    assert.equal(claimRef.originSeat, owner.session().seatId, '远端任务的来源席位应该是房主');
    assert.equal(
      (await guest.push([{ kind: 'task/claim', payload: { ...claimRef, memberName: '客人' } }])).ok,
      true,
    );
    const donePush = await guest.push([
      { kind: 'task/done', payload: { ...claimRef, summary: '登录页已上线', memberName: '客人' } },
    ]);
    assert.equal(donePush.ok, true);

    const ownerPull = await owner.pull();
    assert.equal(ownerPull.ok, true);
    assert.equal(env.boardA.listTasks(env.teamAId, { status: 'done' }).length, 1, '房主那边应该看到这个任务已完成');
    const ownerTask = env.boardA.listTasks(env.teamAId, {}).find((t) => t.id === localTask.id);
    assert.equal(ownerTask.status, 'done');
    assert.equal(ownerTask.assignee, '客人');
  } finally {
    await env.cleanup();
  }
});

/** 从本地 id `r_<seat6>_<remoteId>` 里把远端 id 取回来 */
function localRemoteId(id) {
  const parts = String(id).split('_');
  return parts.slice(2).join('_');
}

test('邀请码错了进不去；房间满了进不去；令牌错了拉不到', async () => {
  const env = await setup();
  try {
    const owner = createRoomClient({ relayUrl: env.relay.url, root: env.rootA, board: env.boardA, teamId: env.teamAId, license: makeLicense('pro') });
    const created = await owner.createRoom({ name: '小房间' });
    assert.equal(created.ok, true);

    const bad = createRoomClient({ relayUrl: env.relay.url, root: env.rootB, board: env.boardB, teamId: env.teamBId, license: null });
    const r1 = await bad.joinRoom({ roomId: created.room.roomId, inviteToken: 'not-the-token' });
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /邀请/);

    const r2 = await bad.joinRoom({ roomId: 'no-such-room', inviteToken: 'x' });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /不存在/);

    const r3 = await bad.joinRoom({ inviteUrl: 'garbage' });
    assert.equal(r3.ok, false);
    assert.match(r3.reason, /邀请信息不完整/);

    const res = await fetch(`${env.relay.url}/v1/rooms/${created.room.roomId}/events?since=0&token=wrong`);
    assert.equal(res.status, 401);
  } finally {
    await env.cleanup();
  }
});

test('房间满员按档位席位算（pro=8：房主 + 7 个客人）', async () => {
  const env = await setup();
  try {
    const owner = createRoomClient({ relayUrl: env.relay.url, root: env.rootA, board: env.boardA, teamId: env.teamAId, license: makeLicense('pro') });
    const created = await owner.createRoom({ name: '席位测试' });
    assert.equal(created.ok, true);
    assert.equal(created.seats, entitlements('pro').maxSeats);

    // 直接打接口塞满，省得建 7 个 board
    const joined = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`${env.relay.url}/v1/rooms/${created.room.roomId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteToken: created.inviteToken, member: { name: `客人${i}` } }),
      });
      assert.equal(res.status, 201, `第 ${i + 1} 个客人应该能进`);
      joined.push(await res.json());
    }
    const overflow = await fetch(`${env.relay.url}/v1/rooms/${created.room.roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: created.inviteToken, member: { name: '第9个' } }),
    });
    assert.equal(overflow.status, 409);
    assert.equal((await overflow.json()).code, 'room_full');

    // 有人离开就腾出席位
    const victim = joined[0];
    const leave = await fetch(`${env.relay.url}/v1/rooms/${created.room.roomId}/leave`, {
      method: 'POST',
      headers: { authorization: `Bearer ${victim.syncToken}` },
    });
    assert.equal(leave.status, 200);
    const retry = await fetch(`${env.relay.url}/v1/rooms/${created.room.roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: created.inviteToken, member: { name: '补位' } }),
    });
    assert.equal(retry.status, 201);
  } finally {
    await env.cleanup();
  }
});

test('房间席位按授权 claims.seats 精确执行（企业版 12 席，不是按 200 席放行）', async () => {
  const env = await setup();
  try {
    const owner = createRoomClient({
      relayUrl: env.relay.url,
      root: env.rootA,
      board: env.boardA,
      teamId: env.teamAId,
      license: makeLicense('business', { seats: 12 }),
    });
    const created = await owner.createRoom({ name: '12 席测试' });
    assert.equal(created.ok, true, created.reason);
    assert.equal(created.seats, 12);

    for (let i = 0; i < 11; i += 1) {
      const res = await fetch(`${env.relay.url}/v1/rooms/${created.room.roomId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteToken: created.inviteToken, member: { name: `设备${i + 2}` } }),
      });
      assert.equal(res.status, 201, `第 ${i + 1} 台客人设备应该能进`);
    }
    const overflow = await fetch(`${env.relay.url}/v1/rooms/${created.room.roomId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken: created.inviteToken, member: { name: '第13席' } }),
    });
    assert.equal(overflow.status, 409);
    assert.equal((await overflow.json()).code, 'room_full');
  } finally {
    await env.cleanup();
  }
});

test('relay 挂了/地址错：本地照常干活，只返回 ok:false', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-off-'));
  try {
    const board = createBoard({ root });
    const team = board.createTeam({ name: '离线组' });
    const teamId = team.id || team.teamId || team;
    const client = createRoomClient({ relayUrl: 'http://127.0.0.1:1', root, board, teamId, license: makeLicense('pro') });
    const r = await client.createRoom({ name: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /连不上 relay/);
    // 本地任务板不受影响
    const t = board.addTask(teamId, { title: '离线也能加任务' });
    assert.ok(t.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('会话能落盘并恢复（重启后接着同步）', async () => {
  const env = await setup();
  try {
    const owner = createRoomClient({ relayUrl: env.relay.url, root: env.rootA, board: env.boardA, teamId: env.teamAId, license: makeLicense('pro') });
    const created = await owner.createRoom({ name: '持久化房间' });
    assert.equal(created.ok, true);

    const revived = createRoomClient({ relayUrl: env.relay.url, root: env.rootA, board: env.boardA, teamId: env.teamAId, license: makeLicense('pro') });
    const r = revived.resume(created.room.roomId);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.room.seatId, created.room.seatId);
    const pull = await revived.pull();
    assert.equal(pull.ok, true, pull.reason);
  } finally {
    await env.cleanup();
  }
});
