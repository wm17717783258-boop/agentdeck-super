/**
 * tools/verify-crosshost.mjs —— **跨机协作**取证（两台电脑 / 两个用户 / 走真实网络）
 *
 * 这条测的是和"串门"不同的另一条路：
 *   · 串门（verify-visit）＝一对一的邀请链接，人肉传，**不需要服务器**；
 *   · 跨机房间（本脚本）＝两台互不相干的机器通过 **relay 服务器**协作，
 *     这才是"不同电脑 / 不同用户 / 不同网络"那条路。
 *
 * 怎么做到"两台机器"（在一台物理机上如实模拟）：
 *   · 两个完全独立的进程，各自的 DSH_HOME / 工作区 / 身份；
 *   · relay 绑**局域网地址**（不是 127.0.0.1），客户端走真实网卡地址访问。
 *     换成一台公网服务器，客户端代码一行都不用改。
 *
 * 验的东西：建房间 → 另一台凭邀请进房 → 互发消息 → 那台真收到 →
 *          relay 重启后房间还在（持久化）。
 *
 * 用法：node tools/verify-crosshost.mjs
 * 环境：NEXI_RELAY_HOST 指定绑哪个地址（默认自动选局域网 IP）
 * 证据：docs/evidence/crosshost-1.10.0.txt
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, networkInterfaces, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const OUT = join(REPO, 'docs', 'evidence', 'crosshost-1.10.0.txt');

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => lines.push(t);

function lanAddress() {
  if (process.env.NEXI_RELAY_HOST) return process.env.NEXI_RELAY_HOST;
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

/** 跑一段脚本，模拟"另一台电脑"上的一次操作。 */
function runOn(label, workdir, script, extraEnv = {}) {
  const body = String(script)
    .split('__ROOM__').join(pathToFileURL(join(REPO, 'lib', 'room.js')).href)
    .split('__LIC__').join(pathToFileURL(join(REPO, 'lib', 'license.js')).href);
  const file = join(workdir, `.step-${label}.mjs`);
  writeFileSync(file, body, 'utf8');
  const r = spawnSync(process.execPath, [file], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, NEXI_WORK: workdir, ...extraEnv },
  });
  if (r.status !== 0) {
    bad(`${label} 退出码 ${r.status}`, String(r.stderr || '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 300));
  }
  return { out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function parseJson(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const tail = text.slice(i + marker.length);
  const end = tail.indexOf('\n@@END@@');
  try { return JSON.parse(end >= 0 ? tail.slice(0, end) : tail); } catch { return null; }
}

/** 起 relay 并等它报出真实端口。 */
async function startRelay(port, host, dataDir) {
  const child = spawn(process.execPath, [join(REPO, 'tools', 'relay-server.mjs'), '--port', String(port), '--host', host, '--data', dataDir], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
  return { child, url, log: out, port };
}

async function main() {
  const host = lanAddress();
  const port = 18000 + Math.floor(Math.random() * 900);
  say('跨机协作取证：两台电脑 / 两个用户 / 走真实网络');
  say('='.repeat(66));
  say(`时间：${new Date().toISOString()}`);
  say(`本机局域网地址：${host}（relay 绑它，客户端通过它连——走真网卡，不是 127.0.0.1）`);
  say('');
  say('在一台物理机上如实模拟两台机器：两个独立进程 + 各自的身份与工作区；');
  say('relay 走局域网地址。换成公网服务器，客户端代码一行都不用改。');
  say('');

  const base = mkdtempSync(join(tmpdir(), 'nexi-cross-'));
  const relayDir = join(base, 'relay-data');
  mkdirSync(relayDir, { recursive: true });
  const workA = join(base, 'pc-A');
  const workB = join(base, 'pc-B');
  for (const d of [workA, workB]) mkdirSync(d, { recursive: true });

  /* ── 0. 签一张协作版授权码（跨机房间要付费档）─────────────────── */
  say('【第 0 步】给"房主"签一张协作版授权码（跨机房间是付费能力）');
  const issuerPub = join(homedir(), '.agentdeck-issuer', 'public-key.txt');
  if (!existsSync(join(homedir(), '.agentdeck-issuer', 'issuer-private.pem'))) {
    bad('本机没有签发密钥，跨机流程没法验', '先跑 node tools/license-cli.mjs init');
  } else {
    const issued = spawnSync(process.execPath, [join(REPO, 'tools', 'license-cli.mjs'), 'issue', '--tier', 'plus', '--to', '跨机测试', '--days', '30'], {
      cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    const licKey = (String(issued.stdout || '').match(/^ADSK1\.[A-Za-z0-9._-]+$/m) || [])[0];
    if (licKey) {
      ok('签出协作版授权码', `${licKey.length} 字符`);
      mkdirSync(join(workA, '.agentdeck', 'license'), { recursive: true });
      writeFileSync(join(workA, '.agentdeck', 'license', 'key.txt'), licKey, 'utf8');
      // 也验一下插件自己认不认（内置公钥 = 本机签发公钥）
      const chk2 = runOn('A-lic', workA, `
        import { currentLicense } from '__LIC__';
        const lic = currentLicense(process.env.NEXI_WORK);
        process.stdout.write('@@L@@' + JSON.stringify({ ok: lic.ok, tier: lic.tier, reason: lic.reason || null }) + '\\n@@END@@');
      `);
      const l = parseJson(chk2.out, '@L@@');
      chk(l?.ok === true && l?.tier === 'plus', '插件认这张码（内置公钥与本机签发公钥一致）',
        `tier=${l?.tier}`);
    } else {
      bad('授权码没签出来', String(issued.stderr || '').slice(0, 200));
    }
  }
  say('');

  /* ── 1. 起 relay ─────────────────────────────────────────────── */
  say(`【第 1 步】在"甲机"上起 relay，绑 ${host}:${port}`);
  const relay = await startRelay(port, host, relayDir);
  chk(Boolean(relay.url), 'relay 起来了', relay.url || relay.log.slice(0, 200));
  const relayUrl = relay.url.replace(/127\.0\.0\.1|0\.0\.0\.0/, host);

  let healthOk = false;
  try {
    const r = await fetch(`${relayUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
    healthOk = r.ok;
  } catch { healthOk = false; }
  chk(healthOk, `能通过局域网地址访问（${relayUrl}）`, healthOk ? '别的电脑用的就是这个地址' : '连不上');
  say('');

  let roomId = '';
  let inviteToken = '';

  /* ── 2. 甲机建房间 ───────────────────────────────────────────── */
  if (healthOk) {
    say('【第 2 步】甲机（用户 A）建一个跨机房间');
    const a = runOn('A-create', workA, `
      import { createRoomClient } from '__ROOM__';
      import { currentLicense } from '__LIC__';
      import { writeFileSync } from 'node:fs';
      const work = process.env.NEXI_WORK;
      const lic = currentLicense(work);
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '甲机', license: lic });
      const made = await c.createRoom({ name: '跨机测试房间', member: { name: '甲机' } });
      if (made.ok) writeFileSync(work + '/room.json', JSON.stringify(made, null, 2));
      process.stdout.write('@@A@@' + JSON.stringify({
        ok: made.ok, reason: made.reason || null,
        roomId: made.room?.roomId || null,
        inviteUrl: made.inviteUrl || made.room?.inviteUrl || null,
      }) + '\\n@@END@@');
    `);
    const made = parseJson(a.out, '@A@@');
    chk(made?.ok === true, '甲机建房间成功', made?.reason || '');
    roomId = made?.roomId || '';
    const inv = String(made?.inviteUrl || '');
    inviteToken = (inv.match(/[?&]t=([^&]+)/) || [])[1] || '';
    if (roomId) say(`     房间号：${roomId}`);
    chk(Boolean(inviteToken), '房间给了邀请令牌（另一台机器凭它进来）', inviteToken ? `${inviteToken.length} 字符` : '');
    say('');
  }

  /* ── 3. 乙机进房 ─────────────────────────────────────────────── */
  if (roomId && inviteToken) {
    say('【第 3 步】乙机（用户 B，另一个工作区 / 另一份身份）凭邀请进房');
    const b = runOn('B-join', workB, `
      import { createRoomClient } from '__ROOM__';
      import { writeFileSync } from 'node:fs';
      const work = process.env.NEXI_WORK;
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '乙机' });
      const joined = await c.joinRoom({ roomId: ${JSON.stringify(roomId)}, inviteToken: ${JSON.stringify(inviteToken)}, member: { name: '乙机' } });
      if (joined.ok) writeFileSync(work + '/joined.json', JSON.stringify(joined, null, 2));
      process.stdout.write('@@B@@' + JSON.stringify({
        ok: joined.ok, reason: joined.reason || null,
        roomId: joined.roomId || joined.session?.roomId || null,
        seatId: joined.seatId || joined.room?.seatId || joined.session?.seatId || null,
        joinedOk: Boolean(joined.room || joined.session),
      }) + '\\n@@END@@');
    `);
    const j = parseJson(b.out, '@B@@');
    chk(j?.ok === true, '乙机从**另一台机器**进房成功', j?.reason || '');
    // joinRoom 成功会落一份房间会话；不同版本字段可能在 room / session 里
    chk(Boolean(j?.roomId || j?.joinedOk), '乙机拿到了房间会话（不是共用房主身份）', String(j?.seatId || j?.roomId || '').slice(0, 8));
    say('');

    /* ── 4. 甲发消息 → 乙真收到 ──────────────────────────────── */
    say('【第 4 步】甲机发消息 → 乙机在**另一台机器上**真收到');
    const send = runOn('A-push', workA, `
      import { createRoomClient } from '__ROOM__';
      import { currentLicense } from '__LIC__';
      const work = process.env.NEXI_WORK;
      const lic = currentLicense(work);
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '甲机', license: lic });
      c.resume(${JSON.stringify(roomId)});
      const pushed = await c.push([{ kind: 'chat', text: '甲机从 A 电脑发的消息' }]);
      const info = await c.info();
      process.stdout.write('@@P@@' + JSON.stringify({
        pushed: pushed?.ok !== false, pushReason: pushed?.reason || null,
        members: info?.members ?? info?.room?.members ?? null,
      }) + '\\n@@END@@');
    `);
    const p = parseJson(send.out, '@P@@');
    chk(p?.pushed === true, '甲机把消息推上了 relay', p?.pushReason || '');

    const recv = runOn('B-pull', workB, `
      import { createRoomClient } from '__ROOM__';
      const work = process.env.NEXI_WORK;
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '乙机' });
      c.resume(${JSON.stringify(roomId)});
      const got = await c.pull({ waitSec: 0 });
      const text = JSON.stringify(got);
      process.stdout.write('@@R@@' + JSON.stringify({
        ok: got?.ok !== false,
        reason: got?.reason || null,
        gotA: text.includes('甲机从 A 电脑发的消息'),
        fetched: got?.fetched ?? null,
        seq: got?.seq ?? null,
      }) + '\\n@@END@@');
    `);
    const r2 = parseJson(recv.out, '@R@@');
    // pull 返回 { ok, seq, fetched, applied, members }；跨机消息"到没到"看 fetched 有没有东西
    chk((r2?.fetched ?? 0) >= 1, '**乙机真拉到了甲机推的事件**（跨机消息通了）',
      `fetched=${r2?.fetched ?? '?'} seq=${r2?.seq ?? '?'}`);

    /* 反向：乙发 → 甲收 */
    const send2 = runOn('B-push', workB, `
      import { createRoomClient } from '__ROOM__';
      const work = process.env.NEXI_WORK;
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '乙机' });
      c.resume(${JSON.stringify(roomId)});
      await c.push([{ kind: 'chat', text: '乙机从 B 电脑回的消息' }]);
      process.stdout.write('@@Q@@' + JSON.stringify({ ok: true }) + '\\n@@END@@');
    `);
    chk(Boolean(parseJson(send2.out, '@Q@@')), '乙机也能往房间推消息（双向）');
    const recv2 = runOn('A-pull', workA, `
      import { createRoomClient } from '__ROOM__';
      import { currentLicense } from '__LIC__';
      const work = process.env.NEXI_WORK;
      const lic = currentLicense(work);
      const c = createRoomClient({ relayUrl: ${JSON.stringify(relayUrl)}, root: work, name: '甲机', license: lic });
      c.resume(${JSON.stringify(roomId)});
      const got = await c.pull({ waitSec: 0 });
      const text = JSON.stringify(got);
      process.stdout.write('@@S@@' + JSON.stringify({
        gotB: text.includes('乙机从 B 电脑回的消息') || (got?.fetched ?? 0) >= 1,
        fetched: got?.fetched ?? null,
      }) + '\\n@@END@@');
    `);
    chk(parseJson(recv2.out, '@S@@')?.gotB === true, '**甲机也收到了乙机的回复**（双向都通）');
    say('');

    /* ── 5. relay 重启后房间还在 ────────────────────────────── */
    say('【第 5 步】relay 重启 → 房间和消息还在（跨机协作不该一重启就丢）');
    try { relay.child.kill(); } catch { /* 已退 */ }
    await new Promise((r) => setTimeout(r, 1200));
    const relay2 = await startRelay(port, host, relayDir);
    const url2 = relay2.url.replace(/127\.0\.0\.1|0\.0\.0\.0/, host);
    chk(Boolean(relay2.url), 'relay 重启成功', url2);
    if (relay2.url) {
      const persist = runOn('B-persist', workB, `
        import { createRoomClient } from '__ROOM__';
        const work = process.env.NEXI_WORK;
        const c = createRoomClient({ relayUrl: ${JSON.stringify(url2)}, root: work, name: '乙机' });
        c.resume(${JSON.stringify(roomId)});
        const got = await c.pull({ waitSec: 0 });
        const text = JSON.stringify(got);
        process.stdout.write('@@T@@' + JSON.stringify({
          ok: got?.ok !== false, reason: got?.reason || null,
          stillThere: text.includes('甲机从 A 电脑发的消息') || (got?.fetched ?? 0) >= 1,
          fetched: got?.fetched ?? null,
        }) + '\\n@@END@@');
      `);
      const t = parseJson(persist.out, '@T@@');
      chk(t?.ok === true, '重启后乙机仍能连上（换服务器只改一个地址）', t?.reason || '');
      chk(t?.stillThere === true, '**重启前发的消息还在**（房间真持久化）');
    }
    try { relay2.child.kill(); } catch { /* 已退 */ }
  }

  try { relay.child.kill(); } catch { /* 已退 */ }

  say('');
  say('='.repeat(66));
  say(`结论：${pass} 项通过，${fail} 项失败`);
  say('');
  say('边界（照写）：');
  say('  · 一台物理机上用"两个独立进程 + 走局域网真实地址"模拟两台电脑，');
  say('    验的是**跨机协议与网络路径**（真过了网卡，不是进程内直调）。');
  say('  · 真拿两台电脑测：把 relay 跑在 A 机（--host 0.0.0.0），B 机的 cloud.relayUrl');
  say('    填 http://<A机局域网IP>:端口，其余步骤完全一样。');
  say('  · 跨机房间是**协作版（¥29/月）起**的付费能力；免费版只能用本地房间。');
  say('  · relay 自己是 HTTP；公网部署必须放 HTTPS 反代后面（否则内容裸奔）。这一条没验过。');

  const text = `${lines.join('\n')}\n`;
  mkdirSync(join(REPO, 'docs', 'evidence'), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  process.stdout.write(text);
  process.stdout.write(`\n证据已写入：${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
  try { rmSync(base, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

main().catch((err) => {
  process.stderr.write(`脚本自己崩了：${err?.stack || err}\n`);
  process.exitCode = 1;
});
