/**
 * 固定目录安装器回归。
 *
 * 重点不是“文件复制成功”，而是：
 *   · 宿主配置永远指向 <home>/bin/nexi.mjs，升级不改变这一行
 *   · 新版本先 staging 校验，再切 current.json
 *   · 坏包不会把当前能跑的版本弄没
 *   · 旧版本保留，rollback 能切回来
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  setup,
  currentMeta,
  launcherPath,
  stableLaunch,
  rollback,
  resolveNodeCommand,
} from '../lib/installer.js';
import { installHost, findAllOnPath } from '../lib/connect/hosts.js';

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `nexi-installer-${label}-`));
}

function writePackage(root, version) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lib', 'mcp'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'agentdeck-super',
    version,
    type: 'module',
    bin: { nexi: 'bin/nexi.mjs' },
  }, null, 2));
  writeFileSync(join(root, 'bin', 'nexi.mjs'), `
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
console.log(JSON.stringify({ version: pkg.version, argv: process.argv.slice(2) }));
`);
  writeFileSync(join(root, 'lib', 'hub.js'), 'export const hub = true;\n');
  writeFileSync(join(root, 'lib', 'mcp', 'server.js'), 'export const server = true;\n');
  writeFileSync(join(root, 'lib', 'version.js'), 'export const version = true;\n');
}

function run(file, args = []) {
  return spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
}

test('固定目录：装出 current.json + 稳定启动器，启动器能跑真实版本', async () => {
  const base = tempDir('basic');
  const src = join(base, 'source');
  const home = join(base, 'home');
  try {
    writePackage(src, '1.0.0');
    const res = await setup({ sourceRoot: src, home, hosts: 'none' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.version, '1.0.0');
    assert.equal(existsSync(join(home, 'current.json')), true);
    assert.equal(existsSync(launcherPath(home)), true);
    assert.equal(currentMeta(home).version, '1.0.0');

    const runLauncher = run(launcherPath(home), ['probe']);
    assert.equal(runLauncher.status, 0, runLauncher.stderr);
    const out = JSON.parse(String(runLauncher.stdout).trim());
    assert.equal(out.version, '1.0.0');
    assert.deepEqual(out.argv, ['probe']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('升级：同一 home 换版本只切指针，稳定启动器路径不变', async () => {
  const base = tempDir('upgrade');
  const src = join(base, 'source');
  const home = join(base, 'home');
  try {
    writePackage(src, '1.0.0');
    const first = await setup({ sourceRoot: src, home, hosts: 'none' });
    assert.equal(first.ok, true);
    const launcher = launcherPath(home);
    const launch = stableLaunch(home);
    const config = join(base, 'cursor.json');
    installHost('cursor', { path: config, force: true, launch });
    const before = JSON.parse(readFileSync(config, 'utf8'));
    assert.equal(before.mcpServers.nexi.args[0], launcher);

    writePackage(src, '1.0.1');
    const second = await setup({ sourceRoot: src, home, hosts: 'none' });
    assert.equal(second.ok, true);
    assert.equal(currentMeta(home).version, '1.0.1');
    assert.equal(existsSync(launcher), true, '稳定启动器不能在升级时被换掉');

    const after = JSON.parse(readFileSync(config, 'utf8'));
    assert.equal(after.mcpServers.nexi.args[0], launcher, '宿主配置不能指向版本目录');
    assert.equal(run(launcher, ['probe']).status, 0);
    assert.match(String(run(launcher, ['probe']).stdout), /1\.0\.1/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('坏包：不切 current，不破坏当前可运行版本', async () => {
  const base = tempDir('bad');
  const src = join(base, 'source');
  const home = join(base, 'home');
  try {
    writePackage(src, '1.0.0');
    assert.equal((await setup({ sourceRoot: src, home, hosts: 'none' })).ok, true);

    const bad = join(base, 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'package.json'), JSON.stringify({
      name: 'agentdeck-super',
      version: '9.9.9',
    }));
    await assert.rejects(
      () => setup({ sourceRoot: bad, home, hosts: 'none' }),
      /关键文件/,
    );
    assert.equal(currentMeta(home).version, '1.0.0');
    const r = run(launcherPath(home), ['probe']);
    assert.equal(r.status, 0);
    assert.match(String(r.stdout), /1\.0\.0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('rollback：切回上一版，宿主稳定启动器不变', async () => {
  const base = tempDir('rollback');
  const src = join(base, 'source');
  const home = join(base, 'home');
  try {
    writePackage(src, '1.0.0');
    assert.equal((await setup({ sourceRoot: src, home, hosts: 'none' })).ok, true);
    writePackage(src, '1.0.1');
    assert.equal((await setup({ sourceRoot: src, home, hosts: 'none' })).ok, true);

    const r = rollback(home);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(currentMeta(home).version, '1.0.0');
    const runLauncher = run(launcherPath(home), ['probe']);
    assert.equal(runLauncher.status, 0);
    assert.match(String(runLauncher.stdout), /1\.0\.0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('dry-run：只给计划，不创建 home / current / 启动器', async () => {
  const base = tempDir('dry');
  const src = join(base, 'source');
  const home = join(base, 'home');
  try {
    writePackage(src, '1.0.0');
    const r = await setup({ sourceRoot: src, home, hosts: 'none', dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(existsSync(home), false, 'dry-run 不该创建 home');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * 回归：写进宿主配置的 node 不能是"会随宿主升级消失的私有 node"。
 *
 * 这是真机上抓到的坑：PATH 上排第一的 node 是
 *   <home>\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
 * 目录名里带版本号，WorkBuddy 一升级旧目录就被删，所有宿主静默起不来。
 * 修法：在 PATH 上找**所有** node，按"稳定性评分"挑最稳的；私有/版本化
 * 的路径扣分，系统级安装点加分。
 *
 * 这个测试要"会真变红"：如果 resolveNodeCommand 又退回 process.execPath，
 * 且 execPath 恰好是版本化私有 node，下面的断言就会失败。
 */
test('写进宿主配置的 node 优先选稳定路径，不选版本化私有 node', () => {
  const r = resolveNodeCommand();
  assert.ok(r.command, '必须给出一个 node 命令');
  assert.ok(['env', 'path', 'execPath', 'bare'].includes(r.source));

  // 选中的路径里不应该出现 "versions/<semver>" 这种目录名（宿主升级即消失）
  assert.doesNotMatch(
    String(r.command).replace(/\\/g, '/'),
    /\/versions?\/\d+\.\d+\.\d+/,
    `不应把版本化私有 node 写进宿主配置，实际选中：${r.command}`,
  );
});

test('NEXI_NODE 显式指定时优先于自动选择', () => {
  const prev = process.env.NEXI_NODE;
  try {
    // 用当前 execPath 当"显式指定"的样本（它必然存在）
    process.env.NEXI_NODE = process.execPath;
    const r = resolveNodeCommand();
    assert.equal(r.source, 'env');
    assert.equal(r.command, process.execPath);
  } finally {
    if (prev === undefined) delete process.env.NEXI_NODE;
    else process.env.NEXI_NODE = prev;
  }
});

test('findAllOnPath 返回多个候选且不重复（不提前 return）', () => {
  const all = findAllOnPath(['node']);
  assert.ok(Array.isArray(all));
  assert.equal(all.length, new Set(all).size, '候选不应有重复');
});

test('stableLaunch 的 note 说明 node 来源，且 _node 带诊断信息', () => {
  const base = tempDir('nodelaunch');
  try {
    const home = join(base, 'home');
    const launch = stableLaunch(home);
    assert.match(launch.note, /node 来自|当前解释器/);
    assert.ok(launch._node && typeof launch._node.source === 'string');
    // 稳定启动器仍指向 <home>/bin/nexi.mjs，升级只切 current.json
    assert.equal(launch.args[0], launcherPath(home));
    assert.equal(launch.args[1], 'mcp');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
