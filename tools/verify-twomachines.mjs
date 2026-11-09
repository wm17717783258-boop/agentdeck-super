/**
 * tools/verify-twomachines.mjs —— **两台电脑开箱测试**的完整演练
 *
 * 这个脚本回答一个问题：用户把 tgz 拷到两台电脑、各装一遍之后，
 * 到底能不能真的协作。
 *
 * 做法：在同一台物理机上起**两个完全独立的"电脑"**：
 *   · 各自一个目录当"那台电脑"（解包 → 装 → 起服务）
 *   · 各自一个 DSH_HOME、各自的工作区、各自的身份
 *   · 通过一个真实的 relay 服务器（绑局域网 IP）对接
 * 然后把"用户会说的那几句话"全跑一遍。
 *
 * 验的东西（这是用户真会做的事）：
 *   1. 甲机：建房间
 *   2. 乙机：凭邀请进房间       ← 跨机
 *   3. 两台互相发消息、互相收   ← 跨机双向
 *   4. 甲机派任务，乙机能领     ← 跨机协作
 *   5. relay 重启，房间还在     ← 持久化
 *   6. 串门（不需要服务器那条路）：邀请 → 验签 → 加密便签 → 解密落任务
 *
 * 用法：node tools/verify-twomachines.mjs
 * 证据：docs/evidence/twomachines-1.10.0.txt
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
// 自己解包，不调外部 tar：Windows 上 tar 走系统代码页，中文路径直接打不开（真机抓到的）
import { extractTgz } from '../lib/untar.js';
import { generateKeyPairSync } from 'node:crypto';
import { encodeLicense } from '../lib/license.js';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensurePackage } from './pack-helper.mjs';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const OUT = join(REPO, 'docs', 'evidence', `twomachines-${VERSION}.txt`);
/*
 * 包从哪来：现打（见 tools/pack-helper.mjs）。
 * 原来赌仓库根有个 tgz —— 开发机上没有，于是"两台电脑开箱测试"永远 0 通过，
 * 而那两条失败跟两台电脑一点关系都没有，纯粹是文件不存在。
 * 这就是最坏的一类验收：结论看着很严重，原因却是脚本自己的假设。
 */
const packed = ensurePackage(process.env.NEXI_VERIFY_TGZ);
if (!packed.ok) {
  console.log('打不出安装包：', packed.reason);
  process.exit(1);
}
const TGZ = packed.tgz;

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => lines.push(t);

function lanAddress() {
  if (process.env.NEXI_RELAY_HOST) {
    return { address: process.env.NEXI_RELAY_HOST, iface: 'NEXI_RELAY_HOST', virtual: false };
  }
  const cands = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || String(i.address).startsWith('127.')) continue;
      const virtual = /vmnet|vbox|wsl|docker|hyper-v|virtual|meta|tun|tap|tailscale|zerotier/i.test(name);
      cands.push({ address: i.address, iface: name, virtual });
    }
  }
  cands.sort((a, b) => Number(a.virtual) - Number(b.virtual) || a.address.localeCompare(b.address));
  return cands[0] || { address: '127.0.0.1', iface: 'loopback', virtual: true };
}

/**
 * 造一对**临时**签发密钥，并签一张协作版授权码。
 *
 * 为什么不用 tools/license-cli.mjs：
 *   1) 它读用户家目录的 issuer-private.pem，从没发过码的机器上根本没有 ——
 *      验收脚本不该要求用户先手工 init 才能跑（这条就是真机抓到的失败原因）。
 *   2) 更重要的：控制台的临时密钥不该写进用户家目录，任何一次测试运行
 *      都不该动用户的真实签发材料。
 *
 * 返回的公钥要挂到 AGENTDECK_LICENSE_PUBKEY，两台机器和 relay 才认这张码。
 */
function makeTestIssuer() {
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const nowSec = Math.floor(Date.now() / 1000);
    const code = encodeLicense({
      v: 1,
      id: `lic_twomachine_${Math.random().toString(16).slice(2, 10)}`,
      tier: 'plus',
      sub: '两台电脑测试',
      iat: nowSec,
      exp: nowSec + 30 * 86400,
      seats: 8,
      skins: [],
    }, privPem);
    return { ok: true, code, pubB64, pubShort: `${pubB64.slice(0, 12)}…` };
  } catch (err) {
    return { ok: false, reason: `${err?.name || 'Error'}: ${err?.message || err}` };
  }
}

/** 在一个"电脑目录"里跑一段脚本，环境完全隔离。 */
function onMachine(label, machineDir, script) {
  const body = String(script)
    .split('__ROOM__').join(pathToFileURL(join(machineDir, 'package', 'lib', 'room.js')).href)
    .split('__LIC__').join(pathToFileURL(join(machineDir, 'package', 'lib', 'license.js')).href)
    .split('__VISIT__').join(pathToFileURL(join(machineDir, 'package', 'lib', 'pet', 'visit.js')).href);
  const file = join(machineDir, `.run-${label}-${Date.now().toString(36)}.mjs`);
  writeFileSync(file, body, 'utf8');
  const r = spawnSync(process.execPath, [file], {
    cwd: machineDir,
    env: {
      ...process.env,
      DSH_HOME: join(machineDir, 'home'),
      NEXI_WORK: join(machineDir, 'work'),
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  if (r.status !== 0) {
    bad(`${label} 退出码 ${r.status}`, String(r.stderr || '').trim().split('\n').slice(0, 2).join(' | ').slice(0, 300));
  }
  return String(r.stdout || '');
}

function parse(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const tail = text.slice(i + marker.length);
  const end = tail.indexOf('\n@@END@@');
  try { return JSON.parse(end >= 0 ? tail.slice(0, end) : tail); } catch { return null; }
}

/** 装一台"电脑"：解包 + 建 home/work。 */
function provision(label, base) {
  const dir = join(base, label);
  mkdirSync(dir, { recursive: true });
  // 纯 JS 解包：不依赖外部 tar，中文路径也不会打不开（Windows 上 tar 走系统代码页）
  const untar = extractTgz(TGZ, dir, { readFile: readFileSync });
  if (!untar.ok) return { ok: false, reason: `解包失败：${untar.reason}` };
  if (!untar.files.length && !untar.dirs.length) {
    return { ok: false, reason: '解包成功但里面是空的（tgz 打错了？）' };
  }
  mkdirSync(join(dir, 'home'), { recursive: true });
  mkdirSync(join(dir, 'work'), { recursive: true });
  return { ok: true, dir };
}

async function startRelay(port, host, dataDir) {
  // 公钥显式传过去（不靠隐式环境继承）：relay 只认这把测试钥匙签的码，
  // 这样"发码 → 验签 → 建房"整条链在这个测试里自洽，不依赖用户机器的真实签发材料。
  const child = spawn(process.execPath, [join(REPO, 'tools', 'relay-server.mjs'), '--port', String(port), '--host', host, '--data', dataDir], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...(process.env.AGENTDECK_LICENSE_PUBKEY ? { AGENTDECK_LICENSE_PUBKEY: process.env.AGENTDECK_LICENSE_PUBKEY } : {}) },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  let url = '';
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const m = out.match(/http:\/\/[\d.]+:(\d{2,5})/);
    if (m && Number(m[1]) > 0) { url = m[0]; break; }
  }
  return { child, url };
}

async function main() {
  const lan = lanAddress();
  const host = lan.address;
  const port = 19000 + Math.floor(Math.random() * 800);
  say('两台电脑开箱测试（真实安装 → 真实协作）');
  say('='.repeat(66));
  say(`时间：${new Date().toISOString()}`);
  say(`局域网地址：${host}（${lan.iface}；relay 绑它，两台都通过这个地址连）`);
  if (lan.virtual) {
    say('!! 这台机器只找到虚拟/回环地址：本测试只证明本机网络栈，不代表第二台物理机可达。');
    say('!! 真机验收必须让 nexi-pair 选到 192.168.x.x / 10.x.x.x 的真实 WiFi/网线网卡。');
  }
  say('');
  say('做的事：起两个完全独立的目录当"两台电脑"，各自解包、各自身份，');
  say('        然后跑用户真的会说的话（建房间/进房/发消息/派活）。');
  say('');

  const base = mkdtempSync(join(tmpdir(), 'twomachine-'));
  const relayDir = join(base, 'relay-data');
  mkdirSync(relayDir, { recursive: true });

  /* ── 装两台"电脑" ─────────────────────────────────────────────── */
  say('【第 1 步】两台电脑各装一遍（解包 → 有独立身份）');
  const pcA = provision('PC-A', base);
  const pcB = provision('PC-B', base);
  chk(pcA.ok, '甲机装好', pcA.reason || '');
  chk(pcB.ok, '乙机装好', pcB.reason || '');
  if (!pcA.ok || !pcB.ok) { finish(); return; }

  chk(existsSync(join(pcA.dir, 'package', 'bin', 'nexi.mjs')), '甲机上有 nexi 命令');
  chk(existsSync(join(pcB.dir, 'package', 'bin', 'nexi.mjs')), '乙机上有 nexi 命令');
  say('');

  /* ── 给"房主"发一张授权码（跨机房间是付费能力）────────────────── */
  say('【第 2 步】给甲机一张协作版授权码（跨机房间是付费能力）');
  // 测试自己造一对临时签发密钥，**不碰用户的真私钥**（~/.agentdeck-issuer 里的那把）。
  // 为什么必须这样：验收要能在任何一台机器上直接跑（包括从没发过码的机器），
  // 而且绝不该因为跑个测试就往用户家目录里写签发密钥。
  // 临时公钥通过 AGENTDECK_LICENSE_PUBKEY 传给两台机器，relay 也用同一把验签。
  const issuer = makeTestIssuer();
  chk(Boolean(issuer.ok), '生成测试用签发密钥', issuer.ok ? `公钥 ${issuer.pubShort}` : issuer.reason);
  const licKey = issuer.ok ? issuer.code : '';
  chk(Boolean(licKey), '签出协作版授权码', licKey ? `${licKey.length} 字符` : '');
  if (licKey) {
    mkdirSync(join(pcA.dir, 'work', '.agentdeck', 'license'), { recursive: true });
    writeFileSync(join(pcA.dir, 'work', '.agentdeck', 'license', 'key.txt'), licKey, 'utf8');
  }
  // 测试公钥挂到进程环境，后面起 relay 时带上（relay 只认这把钥匙签的码）
  if (issuer.ok) process.env.AGENTDECK_LICENSE_PUBKEY = issuer.pubB64;
  say('');

  /* ── 起 relay ─────────────────────────────────────────────────── */
  say(`【第 3 步】起 relay（${host}:${port}）`);
  const relay = await startRelay(port, host, relayDir);
  chk(Boolean(relay.url), 'relay 起来', relay.url || '');
  const relayUrl = relay.url.replace(/127\.0\.0\.1|0\.0\.0\.0/, host);
  let healthOk = false;
  try {
    const r = await fetch(`${relayUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
    healthOk = r.ok;
  } catch { healthOk = false; }
  chk(healthOk, `两台都能连到 relay`, relayUrl);
  say('');

  let roomId = '';
  let inviteToken = '';

  /* ── 甲机建房间 ───────────────────────────────────────────────── */
  if (healthOk) {
    say('【第 4 步】甲机：建一个跨机房间（用户会说「用 deck_room 建个房间」）');
    const out = onMachine('A-create', pcA.dir, `
      import { createRoomClient } from '__ROOM__';
      import { currentLicense } from '__LIC__';
      import { writeFileSync } from 'node:fs';
      const work = process.env.NEXI_WORK;
      const lic = currentLicense(work);
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '甲机', license: lic });
      const made = await c.createRoom({ name: '两台电脑测试房间', member: { name: '甲机' } });
      if (made.ok) writeFileSync(work + '/room.json', JSON.stringify(made, null, 2));
      process.stdout.write('@@R@@' + JSON.stringify({
        ok: made.ok, reason: made.reason || null,
        roomId: made.room?.roomId || null,
        inviteUrl: made.inviteUrl || made.room?.inviteUrl || null,
      }) + '\\n@@END@@');
    `);
    const r = parse(out, '@R@@');
    chk(r?.ok === true, '甲机建房间成功', r?.reason || '');
    roomId = r?.roomId || '';
    inviteToken = (String(r?.inviteUrl || '').match(/[?&]t=([^&]+)/) || [])[1] || '';
    if (roomId) say(`     房间号：${roomId}`);
    chk(Boolean(inviteToken), '拿到了邀请令牌（发给乙机就能进）');
    say('');
  }

  /* ── 乙机进房间 ───────────────────────────────────────────────── */
  if (roomId && inviteToken) {
    say('【第 5 步】乙机：凭邀请进房间（用户会说「用 deck_room 进这个房间」）');
    const out = onMachine('B-join', pcB.dir, `
      import { createRoomClient } from '__ROOM__';
      import { writeFileSync } from 'node:fs';
      const work = process.env.NEXI_WORK;
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '乙机' });
      const joined = await c.joinRoom({ roomId: ${JSON.stringify(roomId)}, inviteToken: ${JSON.stringify(inviteToken)}, member: { name: '乙机' } });
      if (joined.ok) writeFileSync(work + '/joined.json', JSON.stringify(joined, null, 2));
      process.stdout.write('@@J@@' + JSON.stringify({
        ok: joined.ok, reason: joined.reason || null,
        roomId: joined.roomId || joined.room?.roomId || null,
        members: Array.isArray(joined.members) ? joined.members.length : null,
      }) + '\\n@@END@@');
    `);
    const j = parse(out, '@J@@');
    chk(j?.ok === true, '乙机从另一台电脑进房成功', j?.reason || '');
    chk(j?.roomId === roomId, '两台看到同一个房间', String(j?.roomId));
    say('');

    /* ── 双向消息 ─────────────────────────────────────────────── */
    say('【第 6 步】两台互相发消息、互相收（跨机双向）');
    const sendA = onMachine('A-push', pcA.dir, `
      import { createRoomClient } from '__ROOM__';
      import { currentLicense } from '__LIC__';
      const work = process.env.NEXI_WORK;
      const lic = currentLicense(work);
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '甲机', license: lic });
      c.resume(${JSON.stringify(roomId)});
      const p = await c.push([{ kind: 'chat', text: '甲机说：报表发你了' }]);
      process.stdout.write('@@PA@@' + JSON.stringify({ ok: p?.ok !== false, seq: p?.seq ?? null }) + '\\n@@END@@');
    `);
    chk(parse(sendA, '@PA@@')?.ok === true, '甲机把消息推上去');

    const pullB = onMachine('B-pull', pcB.dir, `
      import { createRoomClient } from '__ROOM__';
      const work = process.env.NEXI_WORK;
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '乙机' });
      c.resume(${JSON.stringify(roomId)});
      const got = await c.pull({ waitSec: 0 });
      process.stdout.write('@@PB@@' + JSON.stringify({ ok: got?.ok !== false, fetched: got?.fetched ?? 0, seq: got?.seq ?? null }) + '\\n@@END@@');
    `);
    const pb = parse(pullB, '@PB@@');
    chk((pb?.fetched ?? 0) >= 1, '乙机真拉到甲机的消息', `fetched=${pb?.fetched}`);

    const sendB = onMachine('B-push', pcB.dir, `
      import { createRoomClient } from '__ROOM__';
      const work = process.env.NEXI_WORK;
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '乙机' });
      c.resume(${JSON.stringify(roomId)});
      const p = await c.push([{ kind: 'chat', text: '乙机说：收到，我看看' }]);
      process.stdout.write('@@QB@@' + JSON.stringify({ ok: p?.ok !== false }) + '\\n@@END@@');
    `);
    chk(parse(sendB, '@QB@@')?.ok === true, '乙机也能往上推（双向）');

    const pullA = onMachine('A-pull', pcA.dir, `
      import { createRoomClient } from '__ROOM__';
      import { currentLicense } from '__LIC__';
      const work = process.env.NEXI_WORK;
      const lic = currentLicense(work);
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '甲机', license: lic });
      c.resume(${JSON.stringify(roomId)});
      const got = await c.pull({ waitSec: 0 });
      process.stdout.write('@@QA@@' + JSON.stringify({ ok: got?.ok !== false, fetched: got?.fetched ?? 0 }) + '\\n@@END@@');
    `);
    chk((parse(pullA, '@QA@@')?.fetched ?? 0) >= 1, '甲机也拉到乙机的回复（双向都通）');
    say('');

    /* ── relay 重启后还在 ─────────────────────────────────────── */
    say('【第 7 步】relay 重启 → 房间和消息都还在');
    try { relay.child.kill(); } catch { /* 已退 */ }
    await new Promise((r) => setTimeout(r, 1200));
    const relay2 = await startRelay(port, host, relayDir);
    chk(Boolean(relay2.url), 'relay 重启成功', relay2.url || '');
    if (!relay2.url) {
      chk(false, 'relay 重启进程输出', String(relay2.child?.output || relay2.output || '').slice(0, 300));
      relay2.child?.kill?.();
    }
    if (relay2.url) {
      const url2 = relay2.url.replace(/127\.0\.0\.1|0\.0\.0\.0/, host);
      const after = onMachine('B-after', pcB.dir, `
        import { createRoomClient } from '__ROOM__';
        const work = process.env.NEXI_WORK;
        const c = createRoomClient({ relayUrl: ${JSON.stringify(url2)}, root: work, name: '乙机' });
        c.resume(${JSON.stringify(roomId)});
        const got = await c.pull({ waitSec: 0 });
        process.stdout.write('@@AB@@' + JSON.stringify({ ok: got?.ok !== false, fetched: got?.fetched ?? 0 }) + '\\n@@END@@');
      `);
      const ab = parse(after, '@AB@@');
      chk(ab?.ok === true, '重启后乙机还能连上（换服务器只改一个地址）');
      chk((ab?.fetched ?? 0) >= 1, '重启前的消息还在（持久化）', `fetched=${ab?.fetched}`);
    }
    try { relay2.child.kill(); } catch { /* 已退 */ }
    say('');
  }

  try { relay.child.kill(); } catch { /* 已退 */ }

  /* ── 串门：不需要服务器那条路 ─────────────────────────────────── */
  say('【第 8 步】串门（这条路**不需要任何服务器**，只靠人传一条链接）');
  const invOut = onMachine('A-invite', pcA.dir, `
    import { makeInvite } from '__VISIT__';
    import { writeFileSync } from 'node:fs';
    const work = process.env.NEXI_WORK;
    const invite = makeInvite({ profile: { name: '王冕', pet: '小犀', skills: ['写代码'], bio: '' }, root: work, scope: 'visit', ttlMs: 3600000 });
    if (invite.ok) writeFileSync(work + '/invite.json', JSON.stringify(invite, null, 2));
    process.stdout.write('@@I@@' + JSON.stringify({ ok: invite.ok, token: invite.token || null, box: invite.box || null }) + '\\n@@END@@');
  `);
  const inv = parse(invOut, '@I@@');
  chk(inv?.ok === true, '甲机出了邀请函（发给乙机）');
  if (inv?.token) {
    const accOut = onMachine('B-accept', pcB.dir, `
      import { acceptInvite } from '__VISIT__';
      const work = process.env.NEXI_WORK;
      const acc = acceptInvite({ token: ${JSON.stringify(inv.token)}, profile: { name: '李工', pet: '阿墨', skills: ['数据'], bio: '' }, root: work, http: { post: async () => ({ ok: true, status: 200 }) } });
      process.stdout.write('@@A@@' + JSON.stringify({
        ok: acc.ok, from: acc.hostCard?.name || null, kid: acc.kid || null, box: acc.box || null,
      }) + '\\n@@END@@');
    `);
    const acc = parse(accOut, '@A@@');
    chk(acc?.ok === true, '乙机验签收下（跨机验得过）', String(acc?.from));
    chk(Boolean(acc?.kid), '看到了对方的身份指纹', String(acc?.kid));

    // 乙机发一张加密便签给甲机，甲机真解开并落任务
    if (acc?.box) {
      const noteOut = onMachine('B-note', pcB.dir, `
        import { makeNote } from '__VISIT__';
        import { writeFileSync } from 'node:fs';
        const work = process.env.NEXI_WORK;
        const note = makeNote({
          profile: { name: '李工', pet: '阿墨', skills: ['数据'], bio: '' },
          kind: 'ask', root: work, to: '王冕',
          payload: { title: '帮我看下这张报表', acceptance: '口径能对上', role: 'worker', recipientBox: ${JSON.stringify(acc.box)} },
        });
        writeFileSync(work + '/note.json', JSON.stringify(note, null, 2));
        const wire = JSON.stringify(note.note);
        process.stdout.write('@@N@@' + JSON.stringify({
          ok: note.ok, encrypted: note.encrypted === true,
          leaked: wire.includes('帮我看下这张报表'),
        }) + '\\n@@END@@');
      `);
      const n = parse(noteOut, '@N@@');
      chk(n?.ok === true, '乙机造了一张便签');
      chk(n?.encrypted === true, '便签**真加密**了');
      chk(n?.leaked === false, '明文标题没出现在传输内容里');

      const recvOut = onMachine('A-recv', pcA.dir, `
        import { receiveNote } from '__VISIT__';
        import { readFileSync } from 'node:fs';
        const work = process.env.NEXI_WORK;
        const wrapped = JSON.parse(readFileSync(${JSON.stringify(join(pcB.dir, 'work', 'note.json'))}, 'utf8'));
        const note = wrapped.note || wrapped;
        const calls = [];
        const board = {
          listTeams: () => [{ id: 'team_x' }],
          addTask: (t, p) => { calls.push(p); return { id: 'task_from_b' }; },
        };
        const got = receiveNote({ note, board, teamId: 'team_x', root: work });
        process.stdout.write('@@RN@@' + JSON.stringify({
          ok: got.ok, reason: got.reason || null, decrypted: got.decrypted === true,
          taskTitle: calls[0]?.title || null,
        }) + '\\n@@END@@');
      `);
      const rn = parse(recvOut, '@RN@@');
      chk(rn?.ok === true, '甲机解开了这张**跨机加密便签**', rn?.reason || '');
      chk(rn?.decrypted === true, '确认是解密来的（不是明文）');
      chk(rn?.taskTitle === '帮我看下这张报表', '解密后内容正确、真落成任务', String(rn?.taskTitle));
    }
  }
  say('');

  finish();

  function finish() {
    say('='.repeat(66));
    say(`结论：${pass} 项通过，${fail} 项失败`);
    say('');
    say('这就是"两台电脑上要测的东西"。边界照写：');
    say('  · 在一台物理机上用两个完全独立的目录/身份模拟两台电脑；');
    say('  · relay 走局域网真实地址（真过网卡）。真拿两台电脑，只改 relay 地址。');
    say('  · 跨机房间要协作版授权码（免费版只有本地房间）。');
    say('  · relay 自己是 HTTP；公网要 HTTPS（nexi relay --tls-cert/--tls-key）。');

    const text = `${lines.join('\n')}\n`;
    mkdirSync(join(REPO, 'docs', 'evidence'), { recursive: true });
    writeFileSync(OUT, text, 'utf8');
    process.stdout.write(text);
    process.stdout.write(`\n证据已写入：${OUT}\n`);
    if (fail > 0) process.exitCode = 1;
    try { rmSync(base, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}

main().catch((err) => {
  process.stderr.write(`脚本自己崩了：${err?.stack || err}\n`);
  process.exitCode = 1;
});
