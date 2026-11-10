/**
 * tests/pair-agent-visible.test.mjs —— 配对之后，**这台设备的 Agent 也得在屋里**
 *
 * 真机踩到的坑（比"连不上"更气人）：
 *   `pair guest` 明明打印「进房并同步成功，成员 2 人」，
 *   用户切回自己的项目问 Agent「房间里有谁」，Agent 答：
 *   「还没有配置 relay 地址，跨机房间连不出去」。
 *
 * 根因：配对把房间会话写进了 `.nexi-pair/`，而 Agent 的房间会话按**项目工作区**存。
 * 于是"命令行配好了"和"Agent 用得上"是两套状态，中间没有任何桥。
 *
 * 修法：房间会话与小组板都挪到**机级**目录（一台设备一个席位，跟机器走不跟项目走），
 * 配对直接写那里。这个文件就盯这条链：
 *   配对 → 换一个毫不相干的目录 → Agent 路径能看见房间和人 → 能看见同一个小组。
 *
 * 隔离靠 DSH_HOME（宿主自己也认这个变量），两台"设备"各一份机级根。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const PAIR = join(PKG, 'tools', 'nexi-pair.mjs');
const NEXI = join(PKG, 'bin', 'nexi.mjs');

// 本文件自己造两台"设备"的机级根，绝不碰开发机真实 ~/.dsh。
// （配对子进程继承 process.env，所以设一次就够；每个用例再用独立目录覆盖。）
const SAFE_HOME = mkdtempSync(join(tmpdir(), 'nexi-agentvis-safe-'));
process.env.DSH_HOME ||= SAFE_HOME;

function launch(args, { cwd = PKG, env = {} } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const s = { out: '', err: '', child };
  child.stdout.on('data', (d) => { s.out += d.toString(); });
  child.stderr.on('data', (d) => { s.err += d.toString(); });
  return s;
}

function runOnce(args, { cwd = PKG, env = {} } = {}, timeoutMs = 90000) {
  const s = launch(args, { cwd, env });
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try { s.child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ code: 124, out: s.out, err: s.err });
    }, timeoutMs);
    s.child.on('close', (code) => finish({ code, out: s.out, err: s.err }));
    s.child.on('error', (err) => finish({ code: 1, out: s.out, err: `${s.err}\n${err.message}` }));
  });
}

async function waitFor(getText, pattern, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = pattern.exec(getText());
    if (m) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Agent 路径：真的走 hub 的 call 入口（和宿主里调工具是同一条路），而不是模拟。 */
function callTool(home, tool, args, cwd) {
  return runOnce([NEXI, 'call', tool, JSON.stringify(args)], {
    cwd,
    env: { DSH_HOME: home, AGENTDECK_RELAY_URL: '' },
  }, 60000);
}

test('配对完成后，换一个不相干的目录，Agent 也能看见房间和同一个小组', { timeout: 200000 }, async () => {
  const homeA = mkdtempSync(join(tmpdir(), 'nexi-dev-a-'));
  const homeB = mkdtempSync(join(tmpdir(), 'nexi-dev-b-'));
  const pairA = mkdtempSync(join(tmpdir(), 'nexi-pairs-a-'));
  const pairB = mkdtempSync(join(tmpdir(), 'nexi-pairs-b-'));
  const projA = mkdtempSync(join(tmpdir(), 'nexi-proj-a-'));
  const projB = mkdtempSync(join(tmpdir(), 'nexi-proj-b-'));

  const host = launch([PAIR, 'host', '--port', '0'], {
    // NEXI_PAIR_HOME = 这台"设备"的家目录（等价宿主的 DSH_HOME），
    // NEXI_PAIR_DIR  = 配对自己的状态。两个都给，才是"两台独立设备"。
    env: { DSH_HOME: homeA, NEXI_PAIR_HOME: homeA, NEXI_PAIR_DIR: pairA },
  });
  let guest = null;

  try {
    // 1) 甲机开房
    const inv = await waitFor(() => host.out, /(dsh:\/\/agentdeck\/join\?[^\s'"]+|https?:\/\/[\d.]+:\d+\/\?room=[^\s'"]+)/, 60000);
    assert.ok(inv, `host 没给出邀请：\n${host.out}\n${host.err}`);
    const invite = inv[0];
    const teamM = /跨机小组已建好：(team_[a-z0-9]+)/.exec(host.out);
    assert.ok(teamM, `host 应打印跨机小组 id：\n${host.out}`);
    const teamId = teamM[1];

    // 2) 乙机进房
    guest = launch([PAIR, 'guest', '--invite', invite, '--name', '乙机'], {
      env: { DSH_HOME: homeB, NEXI_PAIR_HOME: homeB, NEXI_PAIR_DIR: pairB },
    });
    const joined = await waitFor(() => guest.out, /进房并同步成功|没成功/, 90000);
    assert.ok(joined, `guest 没给出结论：\n${guest.out}\n${guest.err}`);
    assert.match(guest.out, /进房并同步成功/, `guest 没成功：\n${guest.out}`);

    // 3) 关键一步：乙机**换到自己的项目目录**，用 Agent 路径问"房间里有谁"
    //    这里不设任何 relay 环境变量、不碰配对目录 —— 全靠机级状态。
    const info = await callTool(homeB, 'deck_room', { action: 'info' }, projB);
    assert.doesNotMatch(
      `${info.out}${info.err}`,
      /没有配置 relay 地址/,
      `配对完了 Agent 还说没配 relay —— 机级状态没接上：\n${info.out}`,
    );
    assert.match(info.out, /房间信息/, `Agent 没认出房间：\n${info.out}\n${info.err}`);
    assert.match(info.out, /成员 2 人/, `Agent 看到的人数不对：\n${info.out}`);
    assert.match(info.out, /乙机/, '成员表里应有这台设备的名字');

    // 4) 同一个小组也要在：不然"能看房间但板子是空的"，等于没打通
    const teams = await callTool(homeB, 'team_board', { action: 'teams' }, projB);
    assert.ok(
      teams.out.includes(teamId),
      `Agent 的小组列表里没有 ${teamId}：\n${teams.out}\n${teams.err}`,
    );

    // 5) 甲机同样能看见（房主侧也走机级状态）
    const infoA = await callTool(homeA, 'deck_room', { action: 'info' }, projA);
    assert.match(infoA.out, /成员 2 人/, `甲机 Agent 看到的房间不对：\n${infoA.out}`);

    // 6) 自查入口也要报这件事：用户跑 `pair check` 就知道 Agent 认不认这间屋
    const check = await runOnce([PAIR, 'check'], {
      env: { DSH_HOME: homeB, NEXI_PAIR_HOME: homeB, NEXI_PAIR_DIR: pairB },
    });
    assert.match(check.out, /Agent 那边：已进房/, `check 没报出 Agent 侧状态：\n${check.out}`);
  } finally {
    try { guest?.child.kill('SIGTERM'); } catch { /* 已退出 */ }
    try { host.child.kill('SIGTERM'); } catch { /* 已退出 */ }
    for (const dir of [homeA, homeB, pairA, pairB, projA, projB]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时留着也无害 */ }
    }
  }
});
