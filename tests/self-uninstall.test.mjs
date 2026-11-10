/**
 * tests/self-uninstall.test.mjs —— `nexi uninstall --self` 的三段式删除。
 *
 * 为什么值得单独测：
 *   这是唯一一个**会删用户目录**的功能。写错一个判断就是从"卸载插件"变成"删掉家目录"。
 *   所以这里既测"该删的删掉"，也测"不该碰的一个都没碰"。
 *
 * 拆开测三段：
 *   ① planSelfRemoval —— 只算，不动手；安全边界在这里拦；
 *   ② removeSelf（不在目标目录里跑）—— 当场删 + 立刻回读；
 *   ③ 清理进程本身 —— 用真实子进程跑，验证"父进程退出后真能删掉并写日志"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLEANUP_CODE, describePlan, dirSize, planSelfRemoval, removeSelf, unsafeReason,
} from '../lib/selfremove.js';

function fakeTree(base, name, files = { 'bin/x.txt': 'hello' }) {
  const root = join(base, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test('安全边界：家目录、盘根、名字不对的目录一律不删', () => {
  assert.match(unsafeReason(homedir()), /家目录/);
  assert.match(unsafeReason(join(homedir(), '..')), /上级目录/);
  const root = process.platform === 'win32' ? 'C:\\' : '/';
  assert.match(unsafeReason(root), /盘根/);
  assert.match(unsafeReason(join(tmpdir(), 'Documents')), /不敢删/);
  assert.equal(unsafeReason(join(tmpdir(), 'Nexi')), null);
  assert.equal(unsafeReason(join(tmpdir(), 'agentdeck-super')), null);
  assert.match(unsafeReason('relative/nexi'), /绝对路径/);
});

test('计划：只列存在的目录；--keep-state 时状态目录变成"留"', () => {
  const base = mkdtempSync(join(tmpdir(), 'nexi-selfplan-'));
  const install = fakeTree(base, 'Nexi', { 'bin/nexi.mjs': 'x'.repeat(32), 'current.json': '{}' });
  const state = fakeTree(base, 'agentdeck-super', { 'state.json': '{}', 'logs/a.log': 'x' });

  const plan = planSelfRemoval({ installHome: install, stateRoot: state });
  assert.equal(plan.targets.length, 2);
  assert.deepEqual(plan.targets.map((t) => t.kind).sort(), ['install', 'state']);
  assert.ok(plan.targets.every((t) => t.bytes > 0), '大小没算出来');

  const keep = planSelfRemoval({ installHome: install, stateRoot: state, keepState: true });
  assert.equal(keep.targets.length, 1);
  assert.equal(keep.targets[0].kind, 'install');
  assert.ok(keep.skipped.some((s) => /keep-state/.test(s.reason)));

  // 不存在的路径不进计划（没有"删了个寂寞"的条目）
  const missing = planSelfRemoval({ installHome: join(base, 'Nexi-not-here'), stateRoot: state });
  assert.equal(missing.targets.length, 1);
  assert.match(describePlan(missing), /agentdeck-super/);
});

test('不在目标目录里跑：当场删掉并回读确认，家目录里别的东西不受影响', () => {
  const base = mkdtempSync(join(tmpdir(), 'nexi-selfdel-'));
  const install = fakeTree(base, 'Nexi');
  const state = fakeTree(base, 'agentdeck-super');
  const bystander = fakeTree(base, 'my-project', { 'a.txt': 'keep me' });

  const plan = planSelfRemoval({ installHome: install, stateRoot: state });
  const r = removeSelf({ plan, selfRoot: join(base, 'somewhere-else') });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.deferred.length, 0, '不该有延后删除');
  assert.equal(existsSync(install), false);
  assert.equal(existsSync(state), false);
  assert.equal(r.removed.length, 2);
  assert.ok(existsSync(bystander), '误伤了同级的别的目录');
});

test('在目标目录里跑：改目录交给清理进程，版本目录与状态目录当场清掉', () => {
  const base = mkdtempSync(join(tmpdir(), 'nexi-selfdefer-'));
  const install = fakeTree(base, 'Nexi');
  const state = fakeTree(base, 'agentdeck-super');
  const insideInstall = join(install, 'versions', '1.11.18');

  const plan = planSelfRemoval({ installHome: install, stateRoot: state });
  const r = removeSelf({ plan, selfRoot: insideInstall, spawnCleanup: false });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.deferred, [install], '安装目录必须延后删（进程正踩在里面）');
  assert.equal(existsSync(install), true, '这时还不该删掉');
  assert.equal(existsSync(state), false, '状态目录不在安装目录里，应当场删掉');
  assert.ok(r.payloadFile && existsSync(r.payloadFile), '没留下清理任务的 payload');

  const payload = JSON.parse(readFileSync(r.payloadFile, 'utf8'));
  assert.deepEqual(payload.targets, [install]);
  assert.equal(payload.log, r.log);
});

test('清理进程：父进程已退出时立刻删，日志里留下"真的没了"的证据', () => {
  const base = mkdtempSync(join(tmpdir(), 'nexi-cleanup-'));
  const install = fakeTree(base, 'Nexi', { 'bin/nexi.mjs': 'x'.repeat(64), 'versions/1/a.txt': 'y' });
  const log = join(base, 'cleanup.log');
  const payload = join(base, 'payload.json');
  // parent 用一个必然不存在的 pid：模拟"父进程已经退了"
  writeFileSync(payload, JSON.stringify({ parent: 999_999, waitMs: 50, log, targets: [install] }));

  const r = spawnSync(process.execPath, ['-e', CLEANUP_CODE, payload], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);

  assert.equal(existsSync(install), false, '清理进程没把目录删掉');
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const done = lines.find((l) => l.phase === 'done');
  assert.ok(done, '没写 done 日志');
  assert.deepEqual(done.results, [{ path: install, gone: true }]);
});

test('dirSize 递归算得对（删之前先量一下要删多少）', () => {
  const base = mkdtempSync(join(tmpdir(), 'nexi-size-'));
  const root = fakeTree(base, 'Nexi', { 'a.txt': 'x'.repeat(100), 'deep/b.txt': 'y'.repeat(50) });
  assert.equal(dirSize(root), 150);
  assert.equal(dirSize(join(base, 'nope')), 0);
});
