/**
 * tests/pair-tooling.test.mjs —— 真机配对脚本的端到端验证
 *
 * nexi-pair 是给"我在两台设备上真跑"用的，所以这里要验的是**完整链路**：
 *   起 host（起中继 + 发码 + 建房间）→ 拿它打印的邀请 → 另起一个进程跑 guest →
 *   两边都 check 得到对方的报到。
 *
 * 这就是"两台设备"的最小可信复现：两个独立进程、走真实网络地址。
 * 真机时只需把 guest 那条命令拿到另一台设备上跑。
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

/** 起一个进程，收集输出，支持"等某个模式出现"。 */
function launch(args, { cwd = PKG, env = {} } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const state = { out: '', err: '', child };
  child.stdout.on('data', (d) => { state.out += d.toString(); });
  child.stderr.on('data', (d) => { state.err += d.toString(); });
  return state;
}

/** 轮询直到 output 里出现 pattern，或超时。 */
async function waitFor(getText, pattern, { timeoutMs = 25000, every = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = getText();
    const m = typeof pattern === 'string' ? (text.includes(pattern) ? text : null) : pattern.exec(text);
    if (m) return m;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

test('host → guest → check 全链路走通（两个独立进程，走真实网络地址）', { timeout: 120000 }, async () => {
  // 两个独立状态根：host 与 guest 不共享授权、房间会话或任务板。
  // 这才是「两台设备」的可信模拟；共享一个目录会把跨机问题掩盖掉。
  const hostDir = mkdtempSync(join(tmpdir(), 'nexi-pair-host-'));
  const guestDir = mkdtempSync(join(tmpdir(), 'nexi-pair-guest-'));
  const hostEnv = { NEXI_PAIR_DIR: hostDir };
  const guestEnv = { NEXI_PAIR_DIR: guestDir };
  // --port 0 由系统分配空闲端口，避免并行测试撞固定端口段。
  // 同时显式开到企业版 12 席，验证多设备测试参数不是只写在帮助里。
  const host = launch([PAIR, 'host', '--port', '0', '--tier', 'business', '--seats', '12'], { env: hostEnv });
  let guest = null;

  try {
    // 1) host 应该起中继、建房间，并打印可转发的邀请
    const inviteMatch = await waitFor(
      () => host.out,
      /(dsh:\/\/agentdeck\/join\?[^\s'"]+|https?:\/\/[\d.]+:\d+\/\?room=[^\s'"]+)/,
    );
    assert.ok(inviteMatch, `host 没打印出邀请链接。输出：\n${host.out}\n${host.err}`);
    const invite = inviteMatch[0];
    assert.ok(invite.length > 20, `邀请链接太短：${invite}`);

    assert.ok(host.out.includes('中继已就绪'), 'host 应该报告中继就绪');
    assert.match(host.out, /测试授权：企业版 \/ 12 席/, 'host 应该打印本次测试授权的真实席位');
    assert.match(host.out, /席位：12（房主 1 席，可加入 11 台客人设备）/, '邀请块应该写清可加入的设备数');
    // 房间建成的标志是"打印了可转发的文本块"，不是房间名（房间名只在内部用）
    assert.ok(host.out.includes('把下面这一行发到第二台设备'), 'host 应该给出可转发的说明块');
    // 块里那行必须是**对面能直接跑**的：npx 全命令，不是源码路径
    assert.match(host.out, /npx -y agentdeck-super@latest pair guest --invite "/,
      '转发的命令要能在干净设备上跑；写 node tools/… 对面没有源码');
    /*
     * 邀请里不许是回环地址：中继用 127.0.0.1 建房，relay 生成的网页邀请就带 127.0.0.1。
     * 对面拿到它会连自己的回环 —— 永远连不上，而且报错长得像"房间不存在"。
     * 同机双实例恰好能通，所以这条以前一直没被发现。
     */
    if (!/中继已就绪：http:\/\/127\.0\.0\.1/.test(host.out)) {
      assert.ok(!invite.includes('127.0.0.1'),
        `邀请链接必须是对面能连到的地址，不能是回环：${invite}`);
    }
    /*
     * 这一句必须等，不能立即断言：说明块和「房间已建好」是**两次** console.log，
     * 也就是两次 write。全量回归时 CPU 挤，第二段可能晚几十毫秒才到 —— 立即断言
     * 会偶发红（真机全量跑就红过一次）。等它出现，断言一点没放松。
     */
    const roomReady = await waitFor(() => host.out, '房间已建好', { timeoutMs: 15000 });
    assert.ok(roomReady, `host 应该明确说房间建好了。输出：\n${host.out}`);

    // 2) 中继真的可达（用 host 打印的地址从外面请求一次）
    const readyMatch = /中继已就绪：[^\r\n]*?:(\d{2,5})/.exec(host.out);
    assert.ok(readyMatch, 'host 应该打印中继就绪后的真实端口');
    const relayUrl = `http://127.0.0.1:${readyMatch[1]}`;
    const probe = await fetch(`${relayUrl}/v1/plans`, { signal: AbortSignal.timeout(8000) });
    assert.equal(probe.status, 200, `中继 ${relayUrl} 不可达`);

    // 3) 起 guest（模拟第二台设备），把邀请喂给它
    // dsh:// 链接本身不含地址，显式给 --relay 才是独立设备真实用法。
    guest = launch([PAIR, 'guest', '--invite', invite, '--relay', relayUrl, '--name', '乙机-财务'], { env: guestEnv });
    // 现在的输出是"进房并同步成功"（比起初的"已就位"更准确：它真的做了 sync）
    const guestOk = await waitFor(() => guest.out, /进房并同步成功|进房成功/, { timeoutMs: 30000 });
    assert.ok(guestOk, `guest 没成功进房。输出：\n${guest.out}\n${guest.err}`);
    assert.ok(!/没成功/.test(guest.out), `guest 报进房失败：${guest.out}`);
    // 同理：进房成功的下一行是另一次 write，等它到齐再断言（不放松，只去掉竞态）。
    assert.ok(await waitFor(() => guest.out, /设备席位名：乙机-财务/, { timeoutMs: 10000 }),
      `guest 应打印真正占席的设备名。输出：\n${guest.out}`);
    assert.ok(await waitFor(() => guest.out, /已占用 1 席（乙机-财务）/, { timeoutMs: 10000 }),
      `成功输出应说明谁占了哪一席。输出：\n${guest.out}`);

    // 4) host 侧 check：应该能看到客人的报到
    const hostCheck = launch([PAIR, 'check'], { env: hostEnv });
    // 房主侧 check：中继可达 + 能看到房间里有 2 名成员（房主 + 客人）
    const hostSaw = await waitFor(() => hostCheck.out, /连得上/, { timeoutMs: 30000 });
    assert.ok(hostSaw, `host 侧 check 没跑出结论。输出：\n${hostCheck.out}`);
    assert.ok(hostCheck.out.includes('连得上'), 'check 应该报告中继可达');
    const hostSawName = await waitFor(() => hostCheck.out, /乙机-财务/, { timeoutMs: 30000 });
    assert.ok(hostSawName, `房主侧 check 应能看到客人的席位名。输出：\n${hostCheck.out}`);
    hostCheck.child.kill();

    // 5) guest 侧 check：也应该能拿到房间状态
    const guestCheck = launch([PAIR, 'check'], { env: guestEnv });
    const guestSaw = await waitFor(() => guestCheck.out, /房间状态|最近事件/, { timeoutMs: 30000 });
    assert.ok(guestSaw, `guest 侧 check 输出不完整：\n${guestCheck.out}`);
    guestCheck.child.kill();
  } finally {
    try { guest?.child.kill(); } catch { /* 可能已退出 */ }
    try { host.child.kill(); } catch { /* 同上 */ }
    await new Promise((r) => setTimeout(r, 500));
    try { guest?.child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    try { host.child.kill('SIGKILL'); } catch { /* 同上 */ }
    await new Promise((r) => setTimeout(r, 250));
    for (const dir of [hostDir, guestDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 文件占用，留给系统临时目录清理 */ }
    }
  }
});

test('guest 不带邀请时给出用法，不是崩', async () => {
  const r = launch([PAIR, 'guest']);
  await waitFor(() => r.out, /用法|invite/, { timeoutMs: 30000 });
  assert.match(r.out, /--invite/, '应该提示要带 --invite');
  assert.match(r.out, /dsh:\/\/agentdeck\/join/, '应该给出邀请链接的样子');
  r.child.kill();
});

test('不带角色参数时打印帮助（不静默什么都不做）', async () => {
  const r = launch([PAIR]);
  // 这个文件被 import 时会连带拉起 hub/license/tunnel 一堆模块，
  // 全量回归时机器挤，8 秒偶尔不够（实测红过两次，单跑永远绿）。
  // 放宽的是等待时间，不是断言。
  await waitFor(() => r.out, /真机配对/, { timeoutMs: 30000 });
  assert.match(r.out, /host/, '帮助里应该有 host');
  assert.match(r.out, /guest/, '帮助里应该有 guest');
  assert.match(r.out, /check/, '帮助里应该有 check');
  assert.match(r.out, /members/, '帮助里应该有 members');
  r.child.kill();
});

test('check 在从没配对过时如实说明，不假装有数据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexi-pair-empty-'));
  try {
    const r = launch([PAIR, 'check'], { env: { NEXI_PAIR_DIR: dir } });
    await waitFor(() => r.out, /本机没记过|先跑一次/, { timeoutMs: 30000 });
    assert.match(r.out, /本机没记过|先跑一次/, '应该提示先跑 host 或 guest');
    r.child.kill();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});
