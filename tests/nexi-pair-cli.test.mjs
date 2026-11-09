/**
 * 安装后的稳定配对入口回归。
 *
 * 用户装完后不该再被要求去 versions/<版本>/tools 里找脚本。
 * `nexi pair` 必须能从稳定启动器直接转到当前版本的配对脚本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXI = join(ROOT, 'bin', 'nexi.mjs');

// 版本号不能写死：每次 npm version 之后全量测试都会假红一次。
// 这里从 package.json 现取，断言的是「报的版本和包一致」，不是某个具体数字。
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

test('nexi pair：安装后的稳定命令能转到真机配对帮助', () => {
  const home = mkdtempSync(join(tmpdir(), 'nexi-pair-cli-'));
  try {
    const r = spawnSync(process.execPath, [NEXI, 'pair', 'help'], {
      cwd: ROOT,
      env: { ...process.env, NEXI_INSTALL_HOME: home },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /Nexi 灵犀 · 真机配对/);
    assert.match(r.stdout, /nexi pair host/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('NEXI_INSTALL_HOME：稳定启动器下的 version 不能掉回默认目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'nexi-install-home-'));
  try {
    const r = spawnSync(process.execPath, [NEXI, 'version'], {
      cwd: ROOT,
      env: { ...process.env, NEXI_HOME: '', NEXI_INSTALL_HOME: home },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const doc = JSON.parse(r.stdout.trim());
    assert.equal(doc.home, home);
    assert.equal(doc.packageVersion, PKG_VERSION);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
