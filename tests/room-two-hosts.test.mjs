/**
 * 双机（双人）真实联调：真的起一个 relay 子进程，两台「机器」用真 HTTP 连进去。
 *
 * 这一层要证明的是产品最核心那句话：
 *   · 建房间的人要授权（房主付费）—— 服务器用公钥验签，本地改代码绕不过去；
 *   · **进房间的人不需要授权**（客人免费）—— 这才是传播机制；
 *   · 两边任务板真的合并、消息真的互通、断线重连真的能接着用。
 *
 * 不碰真实授权文件：临时工作区 + 临时密钥对（AGENTDECK_LICENSE_PUBKEY 只在本测试内生效）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBoard } from '../lib/engine/board.js';
import { encodeLicense, writeLicenseKey, currentLicense } from '../lib/license.js';
import { createRoomClient } from '../lib/room.js';

const here = dirname(fileURLToPath(import.meta.url));
const relayScript = join(here, '..', 'tools', 'relay-server.mjs');

/* ── 临时密钥对：整个测试期间把公钥喂给 relay 子进程 ───────────────────── */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const nowSec = Math.floor(Date.now() / 1000);

function issuePro(extra = {}) {
  return encodeLicense(
    { v: 1, id: 'lic_two_hosts', tier: 'pro', sub: '房主', iat: nowSec, exp: nowSec + 86400 * 30, seats: 8, skins: [], ...extra },
    privPem,
  );
}

/* ── 起真 relay ────────────────────────────────────────────────────────── */

function startRelay(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relayScript, '--port', '0', '--data', dataDir], {
      env: { ...process.env, AGENTDECK_LICENSE_PUBKEY: pubB64 },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`relay 10 秒没起来：${out}`));
    }, 10000);
    const onData = (buf) => {
      out += buf.toString('utf8');
      const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay 进程提前退出（code=${code}）：${out}`));
    });
  });
}

function makeHost(root) {
  const board = createBoard({ root });
  const team = board.createTeam({ name: '双机联调组', goal: '验证跨机协同' });
  return { root, board, teamId: team.id };
}

/* ── 主场景 ────────────────────────────────────────────────────────────── */

test('双机协同：房主付费建房间，客人零授权进房间，任务板双向合并', async () => {
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  const relayDir = mkdtempSync(join(tmpdir(), 'adsk-relay-'));
  const rootA = mkdtempSync(join(tmpdir(), 'adsk-hostA-'));
  const rootB = mkdtempSync(join(tmpdir(), 'adsk-hostB-'));
  let relay = null;
  try {
    process.env.AGENTDECK_LICENSE_PUBKEY = pubB64; // 只影响本进程的验签公钥

    // A 机器：有协作版授权
    const licKey = issuePro();
    assert.equal(writeLicenseKey(rootA, licKey).ok, true);
    const licA = currentLicense(rootA);
    assert.equal(licA.ok, true);
    assert.equal(licA.tier, 'pro');

    const hostA = makeHost(rootA);
    const hostB = makeHost(rootB);

    relay = await startRelay(relayDir);

    const roomA = createRoomClient({ relayUrl: relay.url, root: rootA, board: hostA.board, teamId: hostA.teamId, license: licA });
    const created = await roomA.createRoom({ name: '跨机对齐', member: { name: '房主' } });
    assert.equal(created.ok, true, created.reason);
    assert.match(String(created.inviteToken || ''), /\w{6,}/, '建房间必须给邀请码');
    assert.match(String(created.inviteUrl || ''), /^dsh:\/\/agentdeck\/join\?room=/, '给装了 DSH 的人：深链直达');
    assert.match(String(created.inviteWebUrl || ''), /^http:\/\/127\.0\.0\.1:\d+\/\?room=/, '给没装 DSH 的人：网页邀请链接');

    // 网页邀请链接是真人能打开的落地页（传播入口），不能是白屏
    const invitePageRes = await fetch(String(created.inviteWebUrl));
    assert.equal(invitePageRes.status, 200);
    const inviteHtml = await invitePageRes.text();
    for (const kw of ['跨机对齐', 'dsh plugin add agentdeck-super', '不需要买授权']) {
      assert.ok(inviteHtml.includes(kw), `邀请页缺「${kw}」`);
    }
    assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(inviteHtml), '邀请页不能引外链/CDN');

    // 首页自述（自建服务器的人第一眼看这里）
    const homeRes = await fetch(`${relay.url}/`);
    assert.equal(homeRes.status, 200);
    assert.ok((await homeRes.text()).includes('AgentDeck Relay'));

    // B 机器：完全免费（没有授权文件）
    const licB = currentLicense(rootB);
    assert.equal(licB.tier, 'free');
    const roomB = createRoomClient({ relayUrl: relay.url, root: rootB, board: hostB.board, teamId: hostB.teamId, license: licB });

    // 免费用户自己建房间 → 必须被挡住，且告诉人怎么升级
    const blocked = await roomB.createRoom({ name: '我也建一个' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.needUpgrade, true);
    assert.match(blocked.reason, /协作版|授权/);

    // 但凭邀请进房间 → 免费放行（传播机制在这里）
    const joined = await roomB.joinRoom({
      roomId: created.room.roomId,
      inviteToken: created.inviteToken,
      member: { name: '小王' },
    });
    assert.equal(joined.ok, true, joined.reason);
    assert.ok(joined.room?.seatId, '客人要有自己的席位');
    assert.ok(joined.members?.length >= 1, '进房间应该能看到已有成员');

    // ── 任务真的从 A 流到 B ────────────────────────────────────────────────
    const t1 = hostA.board.addTask(hostA.teamId, {
      title: '写接口文档',
      role: 'writer',
      acceptance: '有请求/响应示例',
    });
    const pushed = await roomA.publishLocalTasks();
    assert.equal(pushed.ok, true, pushed.reason);

    const pulledB = await roomB.pull({ waitSec: 5 });
    assert.equal(pulledB.ok, true, pulledB.reason);
    assert.ok(pulledB.fetched >= 1, 'B 应该拉到 A 推的任务事件');
    // 房间绑定「房主的小组」：两台机器从此看的是同一个小组 id，而不是各看各的
    const sharedTeam = String(joined.room?.teamId || '');
    assert.equal(sharedTeam, String(hostA.teamId), '房间里的小组 id 必须是房主那个');
    const bTasks = hostB.board.listTasks(sharedTeam, {});
    const mirrored = bTasks.find((t) => t.title === '写接口文档');
    assert.ok(mirrored, `B 的任务板上没有镜像任务（实际：${bTasks.map((t) => t.title).join('、') || '空'}）`);
    assert.equal(mirrored.context?.roomOrigin?.id, t1.id, '镜像任务要记住来源坐标，才认领得回去');

    // ── 认领回流：B 认领 → A 看到 ─────────────────────────────────────────
    const claimed = hostB.board.claimTask(sharedTeam, mirrored.id, '小王');
    assert.equal(claimed, true, 'B 应该能认领镜像任务');
    const ref = roomB.refFor(mirrored.id);
    assert.equal(ref.taskId, t1.id, '镜像任务的坐标要指回「房主那边的原任务 id」');
    assert.notEqual(ref.originSeat, joined.room.seatId, '坐标里写的是任务原产地席位，不是客人自己的席位');
    const claimPush = await roomB.push({
      kind: 'task/claim',
      payload: { taskId: ref.taskId, originSeat: ref.originSeat, memberName: '小王' },
    });
    assert.equal(claimPush.ok, true, claimPush.reason);

    const pulledA = await roomA.pull({ waitSec: 5 });
    assert.equal(pulledA.ok, true, pulledA.reason);
    assert.ok(pulledA.fetched >= 1, 'A 应该收到 B 的认领');
    const aTask = hostA.board.listTasks(hostA.teamId, {}).find((t) => t.id === t1.id);
    assert.equal(aTask?.status, 'running', `A 那边的任务应该变成进行中（实际 ${aTask?.status}）`);
    assert.match(String(aTask?.assignee || ''), /小王/);

    // ── 消息/便签双向 ─────────────────────────────────────────────────────
    const notePush = await roomB.push({ kind: 'chat', payload: { text: '我这边环境好了，开始写', memberName: '小王' } });
    assert.equal(notePush.ok, true, notePush.reason);
    const aSees = await roomA.pull({ waitSec: 5 });
    assert.equal(aSees.ok, true);

    // ── 断线重连：B 重新 resume 后还能接着推拉 ────────────────────────────
    const resumed = roomB.resume(created.room.roomId);
    assert.equal(resumed.ok, true, resumed.reason);
    const afterResume = await roomB.pull({ waitSec: 0 });
    assert.equal(afterResume.ok, true, afterResume.reason);

    // ── 关房间：A 关掉后 B 再拉会知道房间已关 ─────────────────────────────
    const closed = await roomA.closeRoom();
    assert.equal(closed.ok ?? true, true, closed.reason);
    const bAfterClose = await roomB.pull({ waitSec: 0 });
    assert.equal(bAfterClose.ok, true, bAfterClose.reason);
    assert.equal(bAfterClose.closed, true, '房间关了要如实告诉另一头');

    // 会话落盘：两台机器各自有房间记录，重启能续上
    assert.equal(existsSync(join(rootA, '.agentdeck', 'rooms', `${created.room.roomId}.json`)), true);
    assert.equal(existsSync(join(rootB, '.agentdeck', 'rooms', `${created.room.roomId}.json`)), true);
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    if (relay) {
      try {
        relay.child.kill();
      } catch { /* 已退 */ }
    }
    for (const d of [relayDir, rootA, rootB]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch { /* Windows 文件占用，忽略 */ }
    }
  }
});

test('回归：客人本机没有房主的小组时，拉下来的任务必须自己长出小组并真的落板', async () => {
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  const relayDir = mkdtempSync(join(tmpdir(), 'adsk-relay2-'));
  const rootA = mkdtempSync(join(tmpdir(), 'adsk-hA2-'));
  const rootB = mkdtempSync(join(tmpdir(), 'adsk-hB2-'));
  let relay = null;
  try {
    process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
    assert.equal(writeLicenseKey(rootA, issuePro()).ok, true);

    const hostA = makeHost(rootA);
    relay = await startRelay(relayDir);

    const roomA = createRoomClient({ relayUrl: relay.url, root: rootA, board: hostA.board, teamId: hostA.teamId, license: currentLicense(rootA) });
    const created = await roomA.createRoom({ name: '新人进组', member: { name: '房主' } });
    assert.equal(created.ok, true, created.reason);

    const task = hostA.board.addTask(hostA.teamId, { title: '房主派的活：对接口', role: 'worker' });
    assert.equal((await roomA.publishLocalTasks()).ok, true);

    // B 是一台全新机器：任务板上一张白纸，连小组都没有（线上真实踩到的场景）
    const boardB = createBoard({ root: rootB });
    assert.deepEqual(boardB.listTeams(), []);
    const roomB = createRoomClient({ relayUrl: relay.url, root: rootB, board: boardB, teamId: '', license: currentLicense(rootB) });

    const joined = await roomB.joinRoom({ roomId: created.room.roomId, inviteToken: created.inviteToken, member: { name: '新人' } });
    assert.equal(joined.ok, true, joined.reason);
    assert.equal(String(joined.room?.teamId || ''), String(hostA.teamId), 'relay 要把房主的小组 id 发给客人');

    // 复刻小组：这一步以前缺，导致远端任务无处可落，sync 数着「拉回来 1 条」板子却是空的
    const ensured = roomB.ensureRoomTeam();
    assert.equal(ensured.ok, true, ensured.reason);
    assert.equal(ensured.created, true);
    assert.equal(ensured.teamId, hostA.teamId);
    assert.ok(boardB.getTeam(hostA.teamId), '客人本机要有同一个 id 的小组');

    const pulled = await roomB.pull({ waitSec: 5 });
    assert.equal(pulled.ok, true, pulled.reason);
    assert.ok(pulled.fetched >= 1, 'B 应该拉到 A 推的任务事件');
    assert.ok(pulled.applied >= 1, `必须真的落到任务板上（fetched=${pulled.fetched} applied=${pulled.applied}）`);

    const mirrored = boardB.listTasks(hostA.teamId, {}).find((t) => t.context?.roomOrigin?.id === task.id);
    assert.ok(mirrored, `B 的任务板上没有镜像任务（实际：${boardB.listTasks(hostA.teamId, {}).map((t) => t.title).join('、') || '空'}）`);

    // 客人也能在这个「复刻出来的小组」里加自己的任务（线上那次的报错就在这里）
    const bTask = boardB.addTask(hostA.teamId, { title: '我这边的活：写脚本', role: 'worker' });
    assert.ok(bTask?.id, '客人应该能在复刻出来的小组里加任务');
    assert.equal((await roomB.publishLocalTasks()).ok, true);

    // A 回头同步，看得到 B 的活
    const roomA2 = createRoomClient({ relayUrl: relay.url, root: rootA, board: hostA.board, teamId: hostA.teamId, license: currentLicense(rootA) });
    assert.equal(roomA2.resume(created.room.roomId).ok, true, '房主这台机器要能接着用原来那个席位');
    const pulledA = await roomA2.pull({ waitSec: 5 });
    assert.equal(pulledA.ok, true, pulledA.reason);
    const onA = hostA.board.listTasks(hostA.teamId, {}).find((t) => String(t.title).includes('写脚本'));
    assert.ok(onA, `房主那边应该看到客人的任务（实际：${hostA.board.listTasks(hostA.teamId, {}).map((t) => t.title).join('、')}）`);
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    if (relay) {
      try {
        relay.child.kill();
      } catch { /* 已退 */ }
    }
    for (const d of [relayDir, rootA, rootB]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch { /* Windows 文件占用，忽略 */ }
    }
  }
});

test('relay 挂了：两台机器都不炸，只给人话', async () => {
  const rootA = mkdtempSync(join(tmpdir(), 'adsk-hostX-'));
  try {
    const hostA = makeHost(rootA);
    const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
    process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
    try {
      writeLicenseKey(rootA, issuePro());
      // 指向一个明确没人监听的端口
      const room = createRoomClient({
        relayUrl: 'http://127.0.0.1:1',
        root: rootA,
        board: hostA.board,
        teamId: hostA.teamId,
        license: currentLicense(rootA),
      });
      const created = await room.createRoom({ name: '连不上' });
      assert.equal(created.ok, false);
      assert.match(created.reason, /连不上 relay/);
      const pulled = await room.pull({ waitSec: 0 });
      assert.equal(pulled.ok, false);
      assert.match(pulled.reason, /还没有加入任何房间/);
    } finally {
      if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
      else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    }
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }
});
