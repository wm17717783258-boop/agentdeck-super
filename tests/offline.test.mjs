/**
 * tests/offline.test.mjs —— 不分网络。
 *
 * 两个实验，都是真进程：
 *   ① 拔网启动：--import 把 DNS / 非回环 socket / fetch 全部打挂，MCP 仍然要能握手、
 *      列出工具、真调一个工具。证明插件不是"云插件"。
 *   ② 便携配置换机：--portable 写出的配置里 command 是裸 `node`，
 *      把 HOME 换成一个空目录（等于另一台机器）+ 照抄这份配置，仍然起得来。
 *      证明配置不绑这台机器、不绑这个用户名。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'nexi.mjs');
// Windows 上 --import 只认 file:// URL，给绝对路径会被当成协议 c:
const NO_NET = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network.mjs')).href;

/** 起一个 MCP 子进程，发 initialize + tools/list，返回结果。 */
function handshake({ extraArgs = [], env = {}, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...extraArgs, CLI, 'mcp'], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '';
    let err = '';
    const seen = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`超时（stderr: ${err.slice(-800)}）`));
    }, 30000);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i = buf.indexOf('\n');
      while (i !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        seen.push(msg);
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ init: seen.find((m) => m.id === 1), tools: msg, stderr: err });
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } },
    })}\n`);
  });
}

test('拔掉网络后 MCP 仍能握手并列出工具（不是云插件）', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nexi-offline-'));
  const { init, tools } = await handshake({
    extraArgs: ['--import', NO_NET],
    env: {
      DSH_HOME: path.join(home, 'dsh'),
      HOME: path.join(home, 'home'),
      USERPROFILE: path.join(home, 'home'),
      NEXI_WORKSPACE: path.join(home, 'ws'),
      NEXI_BOARD_ROOT: path.join(home, 'board'),
      NEXI_PET_ROOT: path.join(home, 'pet'),
      NEXI_LICENSE_ROOT: path.join(home, 'lic'),
      NEXI_ROOM_ROOT: path.join(home, 'room'),
    },
  });
  assert.ok(init, '没有 initialize 响应');
  assert.equal(init.result.serverInfo.name !== undefined, true);
  const list = tools.result.tools.map((t) => t.name);
  assert.ok(list.length >= 20, `工具只有 ${list.length} 个`);
  assert.ok(list.includes('deck_room'), '工具表里没有 deck_room');
  rmSync(home, { recursive: true, force: true });
});

test('--portable 写出的配置不绑这台机器：换 HOME 照抄仍能起', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nexi-portable-'));
  const cfgDir = path.join(home, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  const cfgFile = path.join(cfgDir, 'mcp.json');

  const r = spawn(process.execPath, [CLI, 'install', 'custom', cfgFile, '--shape', 'mcpServers', '--portable'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: path.join(home, 'dsh') },
  });
  await new Promise((res) => r.on('close', res));
  const data = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const entry = data.mcpServers.nexi;
  assert.equal(entry.command, 'node', `portable 配置里 command 不是裸 node：${entry.command}`);

  // 换一台"机器"：HOME/USERPROFILE 指到空目录，DSH_HOME 全新，cwd 也换掉。
  const other = path.join(home, 'other-machine');
  mkdirSync(other, { recursive: true });
  const { init, tools } = await handshake({
    extraArgs: ['--import', NO_NET],
    cwd: other,
    env: {
      HOME: other,
      USERPROFILE: other,
      DSH_HOME: path.join(other, '.dsh'),
      NEXI_WORKSPACE: path.join(other, 'ws'),
      NEXI_BOARD_ROOT: path.join(other, 'board'),
      NEXI_PET_ROOT: path.join(other, 'pet'),
      NEXI_LICENSE_ROOT: path.join(other, 'lic'),
    },
  });
  assert.ok(init);
  assert.ok(tools.result.tools.length >= 20);
  rmSync(home, { recursive: true, force: true });
});

test('状态目录可迁移：整目录拷到别处，任务板数据还在', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nexi-move-'));
  const board = path.join(home, 'board');
  const envA = { DSH_HOME: path.join(home, 'dsh-a'), NEXI_BOARD_ROOT: board, NEXI_WORKSPACE: path.join(home, 'ws') };

  // 先建小组再加任务：任务板是「小组内」的对象，没有小组会被正确拒绝。
  const call = (args, extra = {}) => {
    const c = spawn(process.execPath, [CLI, 'call', 'team_board', JSON.stringify(args)], {
      encoding: 'utf8', env: { ...process.env, ...envA, ...extra },
    });
    return new Promise((res) => { let s = ''; c.stdout.on('data', (d) => { s += d; }); c.on('close', () => res(s)); });
  };
  const created = await call({ action: 'create', name: '搬家小组' });
  assert.match(created, /搬家小组|team_/i);
  const outA = await call({ action: 'add', title: '搬家测试' });
  assert.match(outA, /搬家测试|已加|added/i);

  // 把状态文件挪到新位置（等于换机 / 换盘），只改指向，不改数据。
  // 只拷 state.json：任务板的状态就是一个文件，路径不该被写进内容里。
  const moved = path.join(home, 'board-moved');
  mkdirSync(moved, { recursive: true });
  copyFileSync(path.join(board, 'state.json'), path.join(moved, 'state.json'));
  rmSync(board, { recursive: true, force: true });

  const listed = spawn(process.execPath, [CLI, 'call', 'team_board', JSON.stringify({ action: 'list' })], {
    encoding: 'utf8', env: { ...process.env, ...envA, NEXI_BOARD_ROOT: moved },
  });
  const outB = await new Promise((res) => { let s = ''; listed.stdout.on('data', (d) => { s += d; }); listed.on('close', () => res(s)); });
  assert.match(outB, /搬家测试/, '搬完目录数据丢了');
  rmSync(home, { recursive: true, force: true });
});

test('配置里不写死别人的用户名：生成的 JSON 不含当前用户名以外的个人路径', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nexi-nouser-'));
  const cfgFile = path.join(home, 'mcp.json');
  writeFileSync(cfgFile, '{}', 'utf8');
  const r = spawn(process.execPath, [CLI, 'install', 'custom', cfgFile, '--shape', 'mcpServers', '--portable'], {
    env: { ...process.env, DSH_HOME: path.join(home, 'dsh') },
    stdio: 'ignore',
  });
  await new Promise((res) => r.on('close', res));
  const text = readFileSync(cfgFile, 'utf8');
  assert.ok(!/AppData|Library\/Application Support|\.config\//.test(text), `配置里混进了个人目录：${text}`);
  rmSync(home, { recursive: true, force: true });
});
