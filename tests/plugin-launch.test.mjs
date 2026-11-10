/**
 * tests/plugin-launch.test.mjs —— 插件垫脚本「该用哪份代码」的判断。
 *
 * 为什么单独测：插件走 git、固定目录走 npm，两条分发路径一定会脱节。
 * 用户昨天 `--all` 装的是旧版，今天从市场装了新版插件 —— 垫脚本若无脑
 * 用本地那份，宿主跑的还是旧逻辑：面板写新、行为是旧，报错看起来像网络问题。
 *
 * 这里用 NEXI_PLUGIN_DRY（只报选择、不起进程）验三种状态：
 *   本地比插件旧 → 走 npm
 *   本地不比插件旧 → 用本地（离线可用）
 *   本地没有 → 走 npm
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCH = path.join(ROOT, 'plugins', 'nexi', 'launch.mjs');
const PLUGIN = JSON.parse(readFileSync(path.join(ROOT, 'plugins/nexi/.claude-plugin/plugin.json'), 'utf8'));

/** 造一个假的「固定安装目录」，只放 launch.mjs 会看的两样东西。 */
function fakeHome(version) {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-launch-'));
  const home = path.join(root, 'Nexi');
  mkdirSync(path.join(home, 'bin'), { recursive: true });
  writeFileSync(path.join(home, 'bin', 'nexi.mjs'), '// stub\n');
  if (version) {
    writeFileSync(path.join(home, 'current.json'), JSON.stringify({ v: 1, version, dir: `versions/${version}` }));
  }
  return { root, home };
}

function decide(parent) {
  const env = { ...process.env, NEXI_PLUGIN_DRY: '1' };
  // 传的是安装根的上层：win32 是 %LOCALAPPDATA%，其余是 XDG_DATA_HOME
  if (process.platform === 'win32') env.LOCALAPPDATA = parent;
  else env.XDG_DATA_HOME = parent;
  const r = spawnSync(process.execPath, [LAUNCH, 'mcp'], { encoding: 'utf8', env, timeout: 30000 });
  const m = /source=(local|npx)/.exec(String(r.stdout || ''));
  assert.ok(m, `没读到决定：${r.stdout}\n${r.stderr}`);
  return { source: m[1], out: String(r.stdout || '') };
}

test('本地比插件旧 → 改用 npm 取新版（别让宿主跑旧逻辑）',
  { skip: process.platform === 'darwin' && 'darwin 的安装根在 ~/Library，无法用环境变量隔离' }, () => {
    const { root, home } = fakeHome('1.0.0');
    try {
      const d = decide(root);
      assert.equal(d.source, 'npx', `本地 1.0.0 比插件 ${PLUGIN.version} 旧，仍用了本地`);
      assert.match(d.out, /local=1\.0\.0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('本地不比插件旧 → 直接用本地（离线也能起）',
  { skip: process.platform === 'darwin' && '同上' }, () => {
    const { root, home } = fakeHome('99.0.0');
    try {
      assert.equal(decide(root).source, 'local');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('版本相同 → 用本地（正常机器走的就是这条）',
  { skip: process.platform === 'darwin' && '同上' }, () => {
    const { root, home } = fakeHome(PLUGIN.version);
    try {
      assert.equal(decide(root).source, 'local');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('本地没装 → 回退 npm（新机器第一次能装上）',
  { skip: process.platform === 'darwin' && '同上' }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nexi-launch-empty-'));
    try {
      assert.equal(decide(root).source, 'npx');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('current.json 坏掉也不崩，仍给得出决定', () => {
  const { root, home } = fakeHome('');
  try {
    writeFileSync(path.join(home, 'current.json'), '{ 这不是 json');
    // 读不出本地版本时不许抛，退化成"用本地"（说不清就不拦）
    const d = decide(root);
    assert.ok(['local', 'npx'].includes(d.source));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
