/**
 * 公网配对回归：邀请 origin 必须是外面能访问的地址，
 * 而且 host --public-url 真的要先探活再建房间。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicInvite } from '../tools/nexi-pair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const PAIR = join(PKG, 'tools', 'nexi-pair.mjs');

function launch(args, env = {}) {
  const child = spawn(process.execPath, [PAIR, ...args], {
    cwd: PKG,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const state = { out: '', err: '', child };
  child.stdout.on('data', (d) => { state.out += d.toString(); });
  child.stderr.on('data', (d) => { state.err += d.toString(); });
  return state;
}

async function waitFor(getText, pattern, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = getText();
    const match = typeof pattern === 'string' ? (text.includes(pattern) ? text : null) : pattern.exec(text);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

test('publicInvite：只换 origin，保留 room/t；深链也认', () => {
  assert.equal(
    publicInvite('http://127.0.0.1:8787/?room=room-1&t=tok_2', 'https://relay.example.com/base'),
    'https://relay.example.com/base/?room=room-1&t=tok_2',
  );
  assert.equal(
    publicInvite('dsh://agentdeck/join?room=room-1&t=tok_2', 'https://relay.example.com'),
    'https://relay.example.com/?room=room-1&t=tok_2',
  );
  assert.equal(publicInvite('not-a-url', ''), 'not-a-url');
});

test('host --public-url：先探活，再用公网 origin 发邀请；独立 guest 真能进房', { timeout: 180000 }, async () => {
  const hostDir = mkdtempSync(join(tmpdir(), 'adsk-pair-host-'));
  const guestDir = mkdtempSync(join(tmpdir(), 'adsk-pair-guest-'));
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const host = launch(['host', '--port', String(port), '--public-url', publicUrl], { NEXI_PAIR_DIR: hostDir });
  let guest = null;

  try {
    const ready = await waitFor(() => host.out, /复制下面整段发给成员设备/);
    assert.ok(ready, `host 没打印邀请块：\n${host.out}\n${host.err}`);
    assert.match(host.out, /公网探活通过/);

    const inviteMatch = /邀请链接：(https?:\/\/[^\s]+)/.exec(host.out);
    assert.ok(inviteMatch, `host 没打印公网邀请：\n${host.out}`);
    const invite = inviteMatch[1];
    assert.ok(invite.startsWith(`${publicUrl}/?room=`), `邀请没换公网 origin：${invite}`);

    guest = launch(['guest', '--invite', invite], { NEXI_PAIR_DIR: guestDir });
    const joined = await waitFor(() => guest.out, /进房并同步成功|进房成功/, 40000);
    assert.ok(joined, `guest 没进房：\n${guest.out}\n${guest.err}`);
    assert.ok(!/没成功/.test(guest.out), guest.out);
  } finally {
    try { guest?.child.kill(); } catch { /* 已经退出 */ }
    try { host.child.kill(); } catch { /* 已经退出 */ }
    await new Promise((r) => setTimeout(r, 300));
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(guestDir, { recursive: true, force: true });
  }
});
