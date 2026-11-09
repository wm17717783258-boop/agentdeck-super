/**
 * tests/pair-realrun.test.mjs —— 真机配对的**完整真实链路**（含修复后的回归）
 *
 * 这个文件和 pair-tooling.test.mjs 的分工：
 *   pair-tooling   验"脚本本身能跑、能给出引导"
 *   这个文件       验"两台设备真的连上了、真的同步了、房主真的看到了客人"
 *
 * 它复现的是我在真机上手动跑出来的流程（host 一个终端、guest 另一个终端），
 * 所以跑通它 ≈ 真机跑通。唯一差别是两台在同一条物理机器上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const PAIR = join(PKG, 'tools', 'nexi-pair.mjs');

function launch(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: PKG,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const s = { out: '', err: '', child };
  child.stdout.on('data', (d) => { s.out += d.toString(); });
  child.stderr.on('data', (d) => { s.err += d.toString(); });
  return s;
}

function runOnce(args, extraEnv = {}, timeoutMs = 90000) {
  const s = launch(args, extraEnv);
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

async function waitFor(getText, pattern, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = getText();
    const m = typeof pattern === 'string' ? (text.includes(pattern) ? text : null) : pattern.exec(text);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/*
 * 每条用例都用**自己的**状态目录，不复用 <项目>/.nexi-pair。
 *
 * 为什么必须隔离（踩过）：两条用例共写同一个 .nexi-pair 时，单跑全过，
 * 全量（--test-concurrency=1 串行 99 个文件）跑到这里就挂 —— 前序文件残留的
 * 子进程还占着目录句柄，Windows 上 rmSync 删不掉（旧代码静默吞异常），
 * 新 host 于是卡在「中继已就绪」之后，永远走不到「房间已建好」。
 * 症状看着像网络问题，实际是状态目录被污染。
 *
 * 隔离掉以后，用例验的还是同一件事（落盘 / 同步 / 房主能看到客人），
 * 只是不再共享一块随时可能被踩的公共目录。
 */
function tmpPairDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('真机链路：host 建房 → guest 用链接进房并同步 → 房主能看到客人', { timeout: 150000 }, async () => {
  const hostDir = tmpPairDir('nexi-pair-host-');
  const guestDir = tmpPairDir('nexi-pair-guest-');
  // 端口 0 = 系统分配空闲端口。固定端口段会和其他测试/残留 relay 撞车。
  const host = launch([PAIR, 'host', '--port', '0'], { NEXI_PAIR_DIR: hostDir });
  let guest = null;

  try {
    // 1) host 起来并给出邀请
    const inv = await waitFor(() => host.out, /(dsh:\/\/agentdeck\/join\?[^\s'"]+|https?:\/\/[\d.]+:\d+\/\?room=[^\s'"]+)/, 40000);
    assert.ok(inv, `host 没给出邀请。输出：\n${host.out}\n${host.err}`);
    const invite = inv[0];

    const relayM = /中继已就绪：(https?:\/\/[^\s]+)/.exec(host.out);
    assert.ok(relayM, 'host 应打印中继地址');
    const relayUrl = relayM[1];

    // 2) 中继真可达
    const probe = await fetch(`${relayUrl}/v1/plans`, { signal: AbortSignal.timeout(8000) });
    assert.equal(probe.status, 200, `中继不可达：${relayUrl}`);

    // 3) guest 进房 —— 关键：必须**真的成功**，不能出现"没配 relay"或"进房失败"
    guest = launch([PAIR, 'guest', '--invite', invite], { NEXI_PAIR_DIR: guestDir });
    const done = await waitFor(() => guest.out, /进房并同步成功|没成功/, 60000);
    assert.ok(done, `guest 没有给出结论。输出：\n${guest.out}\n${guest.err}`);
    assert.match(guest.out, /进房并同步成功/, `guest 失败了：\n${guest.out}`);
    // 明确断言这两个曾经的 bug 不再出现
    assert.doesNotMatch(guest.out, /没有配置 relay 地址/, '不该再说"没配 relay"（地址就在链接里）');
    assert.doesNotMatch(guest.out, /不认识的动作/, '不该再用不存在的动作名');

    // 4) 房主侧 check：能看到客人，且中继可达
    const hostCheck = launch([PAIR, 'check'], { NEXI_PAIR_DIR: hostDir });
    const saw = await waitFor(() => hostCheck.out, /连得上/, 40000);
    assert.ok(saw, `host 侧 check 没跑出结论：\n${hostCheck.out}`);
    assert.match(hostCheck.out, /连得上/, `中继应可达：\n${hostCheck.out}`);
    hostCheck.child.kill();
  } finally {
    for (const p of [guest?.child, host.child]) {
      try { p?.kill(); } catch { /* 已退出 */ }
    }
    await new Promise((r) => setTimeout(r, 400));
    for (const p of [guest?.child, host.child]) {
      try { p?.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
});

test('真机链路：配对状态落盘（check 能读到上次的中继与邀请）', { timeout: 150000 }, async () => {
  const dir = tmpPairDir('nexi-pair-state-');
  const host = launch([PAIR, 'host', '--port', '0'], { NEXI_PAIR_DIR: dir });
  try {
    // 状态落盘跟"房间建好"是同一步：写不进去的话，host 自己也走不到下一步。
    const ok = await waitFor(() => host.out, /房间已建好/, 40000);
    assert.ok(ok, `host 没建成房间：\n${host.out}\n${host.err}`);

    const stateFile = join(dir, 'state.json');
    assert.ok(existsSync(stateFile), '应该落下 state.json');
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(st.role, 'host');
    assert.ok(String(st.relayUrl).startsWith('http://'), 'state 里应有中继地址');
    assert.ok(String(st.invite).includes('room='), 'state 里应有邀请');
  } finally {
    try { host.child.kill(); } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 300));
    try { host.child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
});

test('真机链路：跨机任务 新增→认领→完成 双向往返（两套独立状态）', { timeout: 240000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexi-pair-task-'));
  const hostDir = join(root, 'host');
  const guestDir = join(root, 'guest');
  const host = launch([PAIR, 'host', '--port', '0'], { NEXI_PAIR_DIR: hostDir });
  let hostExited = false;
  host.child.on('close', () => { hostExited = true; });

  try {
    const inv = await waitFor(
      () => host.out,
      /(https?:\/\/[\d.]+:\d+\/\?room=[^\s'"]+|dsh:\/\/agentdeck\/join\?[^\s'"]+)/,
      50000,
    );
    assert.ok(inv, `host 没给出邀请。输出：\n${host.out}\n${host.err}`);
    const invite = inv[0];

    const guestJoin = await runOnce([PAIR, 'guest', '--invite', invite], { NEXI_PAIR_DIR: guestDir });
    assert.match(guestJoin.out, /进房并同步成功/, `guest 进房失败：\n${guestJoin.out}\n${guestJoin.err}`);
    assert.equal(hostExited, false, 'host/relay 进程不该在 guest 进房后退出');

    const added = await runOnce(
      [PAIR, 'task', 'add', '--title', '跨机验收任务', '--acceptance', '乙机能看到、认领并完成'],
      { NEXI_PAIR_DIR: hostDir },
    );
    assert.match(added.out, /已添加任务\s+task_[\w-]+/, `host 加任务失败：\n${added.out}\n${added.err}`);
    const hostTaskId = /已添加任务\s+(task_[\w-]+)/.exec(added.out)[1];

    const hostSync1 = await runOnce([PAIR, 'sync'], { NEXI_PAIR_DIR: hostDir });
    assert.match(hostSync1.out, /已同步房间/, `host 首次同步失败：\n${hostSync1.out}\n${hostSync1.err}`);

    const guestSync1 = await runOnce([PAIR, 'sync'], { NEXI_PAIR_DIR: guestDir });
    assert.match(guestSync1.out, /跨机验收任务/, `guest 没拉到任务：\n${guestSync1.out}\n${guestSync1.err}`);

    const guestList1 = await runOnce([PAIR, 'task', 'list'], { NEXI_PAIR_DIR: guestDir });
    const mirrored = /(r_[\w-]+)\s+\[pending\]\s+跨机验收任务/.exec(guestList1.out);
    assert.ok(mirrored, `guest 本机没有镜像任务 id：\n${guestList1.out}\n${guestList1.err}`);
    const guestTaskId = mirrored[1];

    const claimed = await runOnce([PAIR, 'task', 'claim', '--id', guestTaskId], { NEXI_PAIR_DIR: guestDir });
    assert.match(claimed.out, /已领取任务/, `guest 认领失败：\n${claimed.out}\n${claimed.err}`);
    const guestSync2 = await runOnce([PAIR, 'sync'], { NEXI_PAIR_DIR: guestDir });
    assert.match(guestSync2.out, /推上去\s+[1-9]\d*\s+条/, `guest 没把认领状态推上去：\n${guestSync2.out}\n${guestSync2.err}`);

    const hostSync2 = await runOnce([PAIR, 'sync'], { NEXI_PAIR_DIR: hostDir });
    const hostList2 = await runOnce([PAIR, 'task', 'list'], { NEXI_PAIR_DIR: hostDir });
    assert.match(hostList2.out, new RegExp(`\\[running\\][^\\n]*跨机验收任务`), `host 没看到认领状态：\n${hostSync2.out}\n${hostList2.out}\n${hostList2.err}`);

    const done = await runOnce(
      [PAIR, 'task', 'done', '--id', guestTaskId, '--output', '乙机已完成并回传'],
      { NEXI_PAIR_DIR: guestDir },
    );
    assert.match(done.out, /已标记完成/, `guest 标记完成失败：\n${done.out}\n${done.err}`);
    const guestSync3 = await runOnce([PAIR, 'sync'], { NEXI_PAIR_DIR: guestDir });
    assert.match(guestSync3.out, /推上去\s+[1-9]\d*\s+条/, `guest 没把完成状态推上去：\n${guestSync3.out}\n${guestSync3.err}`);

    const hostSync3 = await runOnce([PAIR, 'sync'], { NEXI_PAIR_DIR: hostDir });
    const hostList3 = await runOnce([PAIR, 'task', 'list'], { NEXI_PAIR_DIR: hostDir });
    assert.match(hostList3.out, new RegExp(`✓\\s+${hostTaskId}\\s+\\[done\\][^\\n]*跨机验收任务`), `host 没看到完成状态：\n${hostSync3.out}\n${hostList3.out}\n${hostList3.err}`);
  } finally {
    try { host.child.kill(); } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 500));
    try { host.child.kill('SIGKILL'); } catch { /* 已退出 */ }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* Windows 上 relay 句柄可能还没放干净 */ }
  }
});
