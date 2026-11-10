/**
 * tests/offline-full.test.mjs —— 「不分网络」的全链路验收（不只是 MCP 握手）。
 *
 * offline.test.mjs 已经证明「拔网后 MCP 还能握手」。但那只是启动路径。
 * 用户真正会做的事是：装宿主、体检、卸载、看日志、更新自己。
 * 这些命令里只要有一个偷偷联网并卡住，用户就会觉得「这插件离不开网」。
 *
 * 这里用 no-network fixture 把 DNS / 非回环 socket / fetch 全部打挂，
 * 逐条跑这些命令，并且**加时间上限**：卡住也算失败（卡住比报错更像坏了）。
 *
 * 另一个容易忽略的点：代理环境变量。很多人机器上常年挂着
 * HTTP_PROXY=http://127.0.0.1:7890，代理关掉后变量还在。
 * 本地命令不该因为这个变慢或失败。
 *
 * 最后一类是「必须联网的那一条路」：更新自己。
 * 它允许失败，但必须**快速**失败，并且把离线方案说出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'nexi.mjs');
const NO_NET = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network.mjs')).href;

/** 跑一条 CLI，带硬超时。返回 { code, out, ms }。 */
function runCli(args, { env = {}, timeoutMs = 25000, offline = false } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...(offline ? ['--import', NO_NET] : []), CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${args.join(' ')} 卡住了（>${timeoutMs}ms）：${(out + err).slice(-400)}`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, out, err, ms: Date.now() - started });
    });
  });
}

function sandbox(tag) {
  const home = mkdtempSync(path.join(tmpdir(), `nexi-nonet-${tag}-`));
  const env = {
    DSH_HOME: path.join(home, 'dsh'),
    HOME: path.join(home, 'home'),
    USERPROFILE: path.join(home, 'home'),
    NEXI_WORKSPACE: path.join(home, 'ws'),
    NEXI_BOARD_ROOT: path.join(home, 'board'),
    NEXI_PET_ROOT: path.join(home, 'pet'),
    NEXI_LICENSE_ROOT: path.join(home, 'lic'),
    NEXI_ROOM_ROOT: path.join(home, 'room'),
  };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.NEXI_WORKSPACE, { recursive: true });
  return { home, env };
}

test('断网 + 装宿主：不联网也能写进任意配置', async () => {
  const { home, env } = sandbox('install');
  try {
    const cfg = path.join(home, 'mcp.json');
    writeFileSync(cfg, '{"mcpServers":{}}\n');
    const r = await runCli(['install', 'custom', cfg, '--shape', 'mcpServers'], { env, offline: true });
    assert.equal(r.code, 0, `断网装不上：${r.err || r.out}`);
    assert.match(readFileSync(cfg, 'utf8'), /nexi/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('断网 + 卸载：能装就能卸，全程不碰网络', async () => {
  const { home, env } = sandbox('uninstall');
  try {
    const cfg = path.join(home, 'mcp.json');
    const original = '{"mcpServers":{}}\n';
    writeFileSync(cfg, original);
    const a = await runCli(['install', 'custom', cfg, '--shape', 'mcpServers'], { env, offline: true });
    assert.equal(a.code, 0);
    const b = await runCli(['uninstall', 'custom', cfg, '--shape', 'mcpServers'], { env, offline: true });
    assert.equal(b.code, 0, `断网卸不掉：${b.err || b.out}`);
    assert.equal(readFileSync(cfg, 'utf8'), original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('断网 + 体检：doctor 不联网也不卡（>25s 算失败）', async () => {
  const { home, env } = sandbox('doctor');
  try {
    const r = await runCli(['doctor', '--quick', '--json'], { env, offline: true });
    // doctor 允许有 FAIL（这台机器可能一个宿主都没装），但不许崩、不许卡。
    assert.ok(r.ms < 25000, `doctor 跑了 ${r.ms}ms`);
    assert.ok(`${r.out}${r.err}`.trim().length > 0, 'doctor 没有任何输出');
    assert.ok(!/OFFLINE-TEST/.test(`${r.out}${r.err}`), 'doctor 在启动路径里联网了');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('断网 + 看日志：logs 不发请求', async () => {
  const { home, env } = sandbox('logs');
  try {
    const r = await runCli(['logs', '--tail', '5'], { env, offline: true });
    assert.equal(r.code, 0, `logs 失败：${r.err || r.out}`);
    assert.ok(!/OFFLINE-TEST/.test(`${r.out}${r.err}`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('坏代理：HTTP_PROXY 指向黑洞，本地命令照常（代理变量不该影响本地操作）', async () => {
  const { home, env } = sandbox('proxy');
  try {
    const cfg = path.join(home, 'mcp.json');
    writeFileSync(cfg, '{"mcpServers":{}}\n');
    const poisoned = {
      ...env,
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: 'http://127.0.0.1:1',
      http_proxy: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1',
      NO_PROXY: '',
    };
    const r = await runCli(['install', 'custom', cfg, '--shape', 'mcpServers'], { env: poisoned });
    assert.equal(r.code, 0, `坏代理下装不上：${r.err || r.out}`);
    assert.match(readFileSync(cfg, 'utf8'), /nexi/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('更新自己：没网时快速失败，并直接给出离线方案', async () => {
  const { home } = sandbox('update');
  try {
    const r = await runCli(['update', '--from-npm'], {
      env: { ...process.env, DSH_HOME: path.join(home, 'dsh'), NEXI_NET_TIMEOUT_MS: '800' },
      timeoutMs: 15000,
    });
    const text = `${r.out}${r.err}`;
    assert.ok(r.ms < 8000, `更新失败用了 ${r.ms}ms，太久了`);
    assert.ok(/超时|连不上|timeout|ENOTFOUND|EAI_AGAIN/i.test(text), `没有说清失败原因：${text.slice(0, 300)}`);
    assert.ok(/--bundle/.test(text), '没有告诉用户离线怎么装：--bundle <本地 .tgz>');
    assert.ok(/install/.test(text), '没有说明「装宿主不需要网络」');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
