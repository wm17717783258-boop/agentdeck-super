#!/usr/bin/env node
/**
 * tools/dsh-fixture.mjs —— 真宿主验收用的临时 DSH 沙箱
 *
 * 目的：验收脚本不再依赖用户已经装过 web profile，也不污染 ~/.dsh。
 * 每次都：
 *   ① 在系统临时目录建一个独立 DSH_HOME
 *   ② 从官方 web 模板生成一个临时 profile
 *   ③ npm pack 当前仓库，再 dsh plugin add 进这个 profile
 *   ④ 返回 dsh 可执行文件、profile 名和带 DSH_HOME 的环境
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_PRESETS,
  buildSpawnInvocation,
  resolveCommand,
} from '../lib/engine/cli.js';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function resolveDsh(env = process.env) {
  const found = resolveCommand('dsh', {
    env,
    extraPaths: AGENT_PRESETS.dsh.detect.extraPaths,
  });
  if (!found) throw new Error('找不到 dsh：这台机器没装 DeepSeek Harness');
  return found;
}

export function runDsh(dsh, args, { env = process.env, timeout = 180000 } = {}) {
  const [exe, argv, spawnOpts] = buildSpawnInvocation(dsh, args, env);
  return spawnSync(exe, argv, {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    ...spawnOpts,
  });
}

function packCurrentPackage(dest) {
  mkdirSync(dest, { recursive: true });
  const npm = resolveCommand('npm', { env: process.env });
  if (!npm) throw new Error('找不到 npm，无法验证真实安装包');
  const [exe, argv, spawnOpts] = buildSpawnInvocation(
    npm,
    ['pack', '--pack-destination', dest, '--json'],
    process.env,
  );
  const r = spawnSync(exe, argv, {
    cwd: PKG,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    ...spawnOpts,
  });
  if (r.status !== 0) {
    throw new Error(`npm pack 失败：${String(r.stderr || r.stdout || '').slice(-500)}`);
  }
  let name = '';
  try {
    const parsed = JSON.parse(String(r.stdout || ''));
    name = String(parsed?.[0]?.filename || '');
  } catch {
    /* 下面再用目录扫描兜底 */
  }
  if (!name) {
    throw new Error(`npm pack 没返回文件名：${String(r.stdout || '').slice(-500)}`);
  }
  const file = join(dest, name);
  if (!existsSync(file)) throw new Error(`npm pack 产物不存在：${file}`);
  return file;
}

/**
 * 建一个隔离的 DSH profile，并把当前包真装进去。
 * 返回对象里的 cleanup() 只删自己创建的临时 HOME，不碰调用方传进来的目录。
 */
export function prepareDshProfile({ profile = 'nexi-accept', home = '' } = {}) {
  const ownedHome = !home;
  const dshHome = home || mkdtempSync(join(tmpdir(), 'nexi-dsh-fixture-'));
  const env = { ...process.env, DSH_HOME: dshHome };
  const dsh = resolveDsh(env);
  const profileDir = join(dshHome, 'profiles', profile);

  if (!existsSync(join(profileDir, 'package.json'))) {
    const created = runDsh(
      dsh,
      ['--profile', profile, '--from-default-profile', 'web', '--dump-config'],
      { env },
    );
    if (created.status !== 0 || !existsSync(join(profileDir, 'package.json'))) {
      throw new Error(`创建临时 DSH profile 失败：${String(created.stderr || created.stdout || '').slice(-600)}`);
    }
  }

  const tgz = packCurrentPackage(join(dshHome, '_package'));
  const installed = runDsh(dsh, ['plugin', '--profile', profile, 'add', tgz], { env });
  if (installed.status !== 0) {
    throw new Error(`把插件装进临时 DSH profile 失败：${String(installed.stderr || installed.stdout || '').slice(-800)}`);
  }

  const installedPkg = join(profileDir, 'node_modules', 'agentdeck-super', 'package.json');
  if (!existsSync(installedPkg)) {
    throw new Error(`装完以后找不到 ${installedPkg}`);
  }
  const version = JSON.parse(readFileSync(installedPkg, 'utf8')).version;

  return {
    dsh,
    home: dshHome,
    profile,
    profileDir,
    version,
    tgz,
    env,
    ownedHome,
    cleanup() {
      if (ownedHome) rmSync(dshHome, { recursive: true, force: true });
    },
  };
}

export function yamlPath(value) {
  return String(value).replace(/\\/g, '/');
}
