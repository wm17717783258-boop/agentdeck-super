/**
 * tests/cli.test.mjs —— 本机 CLI Agent 接入（lib/engine/cli.js）的单测。
 *
 * 全部对着 tests/fixtures/fake-agent.mjs 跑：不碰真实 claude / codex / dsh / gemini，
 * 不烧额度、不等模型。验的是接入层的四件真事：
 *   1. 命令能不能在本机找到（PATH + PATHEXT + .cmd 垫片）
 *   2. 参数模板拼出来的到底是哪串（含只读化改写）
 *   3. 输出怎么解析（claude JSON / dsh NDJSON / codex 文本 / GBK 兜底）
 *   4. 出事了怎么收场（超时 = 124、取消 = 130、起不来 = 127，且进程树真的被杀）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_PRESETS, runAgent, resolveCommand, detectAgents, cleanModelName } from '../lib/engine/cli.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE = path.join(FIX, 'fake-agent.mjs');
const FAKE_CMD = path.join(FIX, 'fake-agent.cmd');
const NODE = process.execPath;
const IS_WIN = process.platform === 'win32';

const nodeSpec = (args, extra = {}) => ({ id: 'custom', cmd: NODE, args: [FAKE, ...args], ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程是否还活着（Windows 用 tasklist 查；查不到就是死了）。 */
function alive(pid) {
  const res = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return String(res.stdout || '').includes(String(pid));
}

test('resolveCommand：PATH + PATHEXT 能找到 .cmd 垫片，找不到就返回 null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentdeck-cli-'));
  try {
    writeFileSync(path.join(dir, 'fake-claude.cmd'), '@echo off\r\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const found = resolveCommand('fake-claude', { env, extraPaths: [dir] });
    assert.equal(found, path.join(dir, 'fake-claude.cmd'));
    assert.equal(resolveCommand('missing-agent-xyz', { env, extraPaths: [dir] }), null);
    assert.equal(resolveCommand('', { env }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectAgents：四个内置模板都在（withVersion=false，不 spawn 任何进程）', async () => {
  const list = await detectAgents({ withVersion: false });
  assert.ok(Array.isArray(list));
  assert.deepEqual(list.map((a) => a.id).sort(), ['claude', 'codex', 'dsh', 'gemini']);
  for (const item of list) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
    assert.equal(typeof item.available, 'boolean');
    assert.ok(item.cmd === null || typeof item.cmd === 'string');
  }
});

test('runAgent：普通 echo，中文原样回来（node 直起）', async () => {
  const res = await runAgent(nodeSpec(['--mode', 'echo', '--tag', 'n1']), '你好');
  assert.equal(res.rc, 0);
  assert.equal(res.out.trim(), 'FAKE[n1] 收到:你好');
  assert.equal(res.meta.agentId, 'custom');
  assert.ok(res.ms >= 0);
});

test('runAgent：Windows .cmd 垫片也能起（cmd.exe 包装路径）', { skip: !IS_WIN && '仅 Windows 需要垫片' }, async () => {
  const res = await runAgent({ id: 'custom', cmd: FAKE_CMD, args: ['--mode', 'echo', '--tag', 'shim'] }, '来自cmd');
  assert.equal(res.rc, 0);
  assert.equal(res.out.trim(), 'FAKE[shim] 收到:来自cmd');
});

test('runAgent：stdin 型 CLI 把 prompt 走标准输入', async () => {
  const res = await runAgent(nodeSpec(['--mode', 'echo', '--tag', 'stdin'], { stdin: true }), '来自stdin的指令');
  assert.equal(res.rc, 0);
  assert.equal(res.out.trim(), 'FAKE[stdin] 收到:来自stdin的指令');
});

test('runAgent：claude JSON 解析（前面混一行日志也要认）', async () => {
  const res = await runAgent({ id: 'claude', cmd: NODE, args: [FAKE, '--mode', 'claude'], parse: 'claude-json' }, '你好');
  assert.equal(res.rc, 0);
  assert.equal(res.out, 'FAKE[p] 收到:你好');
  assert.equal(res.meta.model, 'fake-claude-4');
  assert.deepEqual(res.meta.usage, { in: 11, out: 22 });
  assert.equal(res.meta.cost, 0.007);
  assert.equal(res.meta.sessionId, 'sess-fake-1');
});

test('runAgent：dsh NDJSON 解析（usage 累加、正文取 final）', async () => {
  const res = await runAgent({ id: 'dsh', cmd: NODE, args: [FAKE, '--mode', 'dsh'], parse: 'dsh-json' }, '你好');
  assert.equal(res.rc, 0);
  assert.equal(res.out, 'FAKE[p] 收到:你好');
  assert.deepEqual(res.meta.usage, { in: 7, out: 3 });
  assert.equal(res.meta.model, 'dsh-chat');
  assert.equal(res.meta.sessionId, 'dsh-sess-1');
  assert.equal(res.meta.stopReason, 'end_turn');
});

test('runAgent：codex 纯文本解析（剥掉 tokens used）', async () => {
  const res = await runAgent({ id: 'codex', cmd: NODE, args: [FAKE, '--mode', 'codex'], parse: 'codex-text' }, '你好');
  assert.equal(res.rc, 0);
  assert.equal(res.out, 'FAKE[p] 收到:你好');
  assert.equal(res.meta.usage.out, 12547);
});

test('runAgent：claude 只读化改写参数（禁输出格式、收掉工具）', { skip: !IS_WIN && '用 .cmd 垫片验改写' }, async () => {
  const res = await runAgent(
    { id: 'claude', cmd: FAKE_CMD, args: ['--mode', 'argv', '--output-format', 'json'], readonly: true },
    '你好',
  );
  assert.equal(res.rc, 0);
  const argv = JSON.parse(res.out.trim());
  assert.ok(argv.includes('-p'), `应补 -p：${JSON.stringify(argv)}`);
  assert.ok(argv.includes('--tools'), `应补 --tools：${JSON.stringify(argv)}`);
  assert.ok(!argv.includes('--output-format'), `应剔掉 --output-format：${JSON.stringify(argv)}`);
  assert.ok(!argv.includes('json'), `--output-format 的值也应剔掉：${JSON.stringify(argv)}`);
});

test('runAgent：GBK 输出兜底解码成中文', async () => {
  const res = await runAgent(nodeSpec(['--mode', 'gbk']), '');
  assert.equal(res.rc, 0);
  assert.equal(res.out, '中文');
});

test('runAgent：stderr 与退出码如实上报（rc=3）', async () => {
  const res = await runAgent(nodeSpec(['--mode', 'stderr']), '');
  assert.equal(res.rc, 3);
  assert.match(res.err, /中文报错/);
  assert.equal(res.meta.exitCode, 3);
});

test('runAgent：超时 → rc=124 且不磨蹭', async () => {
  const startedAt = Date.now();
  const res = await runAgent(nodeSpec(['--mode', 'sleep', '--sleep', '8000']), '', { timeoutMs: 500 });
  const cost = Date.now() - startedAt;
  assert.equal(res.rc, 124);
  assert.equal(res.meta.timedOut, true);
  assert.match(res.err, /超时/);
  assert.ok(cost < 6000, `超时后应立刻返回，实际 ${cost}ms`);
});

test('runAgent：signal 取消 → rc=130', async () => {
  const ctrl = new AbortController();
  const pending = runAgent(nodeSpec(['--mode', 'sleep', '--sleep', '8000']), '', { signal: ctrl.signal, timeoutMs: 20000 });
  setTimeout(() => ctrl.abort(), 200);
  const res = await pending;
  assert.equal(res.rc, 130);
  assert.equal(res.meta.cancelled, true);
  assert.match(res.err, /取消/);
});

test('runAgent：超时会把整棵进程树杀掉（含孙进程）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentdeck-tree-'));
  const pidfile = path.join(dir, 'grandchild.pid');
  try {
    const res = await runAgent(nodeSpec(['--mode', 'tree', '--pidfile', pidfile]), '', { timeoutMs: 800 });
    assert.equal(res.rc, 124);
    assert.ok(existsSync(pidfile), '孙进程应已写出 pidfile');
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    assert.ok(pid > 0);
    // 杀树是异步的系统动作，给最多 5 秒观察窗口
    let dead = false;
    for (let i = 0; i < 25; i += 1) {
      await sleep(200);
      if (!alive(pid)) {
        dead = true;
        break;
      }
    }
    if (!dead) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    assert.ok(dead, `孙进程 ${pid} 还活着 —— 进程树没杀干净`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgent：命令起不来 → rc=127，不抛异常', async () => {
  const res = await runAgent({ id: 'custom', cmd: 'definitely-not-an-agent-xyz', args: [] }, '你好');
  assert.equal(res.rc, 127);
  assert.ok(res.err.length > 0);
  // 报错要是人话，不能把 spawn 的 ENOENT 原文甩给用户
  assert.match(res.err, /找不到可执行文件|没装|PATH/);
  assert.doesNotMatch(res.err, /ENOENT/);
});

// 这条是 P0 回归：裸名 claude 走 PATH 里的 .cmd 垫片（npm 全局安装的真实形态）。
// 之前 runAgent 直接把 preset.cmd（'claude'）丢给 spawn，Windows 不做 PATHEXT 展开 →
// 必然 ENOENT → rc:127；而 detectAgents 走 resolveCommand 又能探测到，于是"面板显示
// 已安装、一跑就失败"。四家 CLI 全是 .cmd 垫片，所以这是主路径而不是边角。
test('runAgent：四家裸名（claude/codex/dsh/gemini）只靠 PATH 里的 .cmd 垫片就能跑通', async () => {
  // 垫片目录放在 fixtures 下（纯 ASCII 路径），避免 %~dp0 展开出中文路径被 cmd.exe 解错
  const dir = mkdtempSync(path.join(FIX, 'shim-'));
  const modes = { claude: 'claude', codex: 'codex', dsh: 'dsh', gemini: 'echo' };
  const prevPath = process.env.PATH;
  try {
    for (const [id, mode] of Object.entries(modes)) {
      // 垫片在 fixtures 的子目录里，fake-agent.mjs 在上一级，所以是 %~dp0..\
      writeFileSync(path.join(dir, `${id}.cmd`), `@echo off\r\nnode "%~dp0..\\fake-agent.mjs" --mode ${mode} %*\r\n`);
    }
    // 真机形态：PATH 里只有 .cmd 垫片，没有任何同名可执行文件
    process.env.PATH = `${dir}${path.delimiter}${prevPath || ''}`;

    for (const id of Object.keys(modes)) {
      const res = await runAgent(id, '你好'); // 注意：spec 是裸字符串，走 AGENT_PRESETS
      assert.equal(res.rc, 0, `${id} 没跑起来：${res.err}`);
      assert.match(res.out, /FAKE\[/, `${id} 的输出不对：${res.out}`);
      assert.match(res.meta.cmd, new RegExp(`${id}\\.cmd$`, 'i'), 'meta.cmd 应该是解析后的绝对路径');
    }
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgent：裸名但 PATH 里没有 → rc=127，报错是人话', async () => {
  const dir = mkdtempSync(path.join(FIX, 'shim-'));
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = dir; // 空目录：谁也找不到
    const res = await runAgent('claude', '你好');
    assert.equal(res.rc, 127);
    assert.match(res.err, /找不到可执行文件「claude」/);
    assert.match(res.err, /PATH/);
    assert.doesNotMatch(res.err, /ENOENT/);
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgent：onChunk 能收到流式片段', async () => {
  const pieces = [];
  const res = await runAgent(nodeSpec(['--mode', 'chunk']), '', {
    onChunk: (kind, text) => pieces.push([kind, text]),
  });
  assert.equal(res.rc, 0);
  const all = pieces.map(([, t]) => t).join('');
  assert.match(all, /第一段/);
  assert.match(all, /第三段/);
  assert.equal(res.out.trim(), '第一段第二段第三段');
});

test('runAgent：未知的 agent id / 非 cli transport 直接抛错（编程错误，该早暴露）', async () => {
  await assert.rejects(() => runAgent('nope-agent', 'x'), /未知的 agent/);
  await assert.rejects(() => runAgent({ id: 'x', transport: 'acp-http', cmd: 'node' }, 'x'), /bridge\.call/);
});

test('cleanModelName：去掉中转侧加上的上下文标记', () => {
  assert.equal(cleanModelName('claude-sonnet-4[1m]'), 'claude-sonnet-4');
  assert.equal(cleanModelName('  gpt-4o  '), 'gpt-4o');
  assert.equal(cleanModelName(''), '');
  assert.equal(cleanModelName(null), '');
});

test('AGENT_PRESETS：模板结构完整（id/cmd/parse/detect 都在）', () => {
  for (const id of ['claude', 'codex', 'dsh', 'gemini', 'custom']) {
    const p = AGENT_PRESETS[id];
    assert.ok(p, `缺模板 ${id}`);
    assert.equal(p.id, id);
    assert.equal(typeof p.args, 'object');
    assert.equal(typeof p.parse, 'string');
    assert.ok(p.detect && typeof p.detect.cmd === 'string');
  }
});
