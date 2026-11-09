/**
 * tests/cli-doctor.test.mjs —— `nexi doctor` 的两副面孔。
 *
 * 为什么值得单独测：这个命令是**用户遇到问题唯一会跑的东西**。
 * 它以前直接吐 JSON，人看完不知道该干什么；现在默认吐人话，
 * 但 `--json` 必须保持老结构 —— 有脚本按它解析，文案改动不能打断它们。
 *
 * 所以这里锁四件事：
 *   1. 默认输出是给人看的：三段 + 一句结论 + 一段可直接复制的报告
 *   2. `--json` 仍是机器可读，且 checks 的名字没变（老契约）
 *   3. `--quick` 不跑功能自检（没装宿主的环境也能秒回）
 *   4. 体检没有副作用：跑完当前目录不许多出 market/ 之类的文件
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEXI = path.join(ROOT, 'bin', 'nexi.mjs');

/** 在一个空临时目录里跑 doctor，避免读到本仓库的 workspace。 */
function run(args = [], extraEnv = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'nexi-doctor-cwd-'));
  const home = mkdtempSync(path.join(tmpdir(), 'nexi-doctor-home-'));
  try {
    const res = spawnSync(process.execPath, [NEXI, 'doctor', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, NEXI_WORKSPACE: cwd, NEXI_LICENSE_ROOT: home, ...extraEnv },
    });
    return { ...res, cwd, home };
  } finally {
    // 调用方还要看 cwd 快照，所以不能在这里删；由各用例 finally 收
  }
}

test('默认输出是人话：三段 + 结论 + 可直接复制的报告', () => {
  const r = run();
  const out = String(r.stdout || '');
  try {
    assert.match(out, /^Nexi 自检 · v\d+\.\d+\.\d+/, '第一行应该是标题，不是花括号');
    assert.ok(out.includes('① 运行环境'), '缺第一段');
    assert.ok(out.includes('② 接进宿主了吗'), '缺第二段');
    assert.ok(out.includes('③ 真能干活吗'), '缺第三段');
    assert.match(out, /结论：/, '必须有一句人能读的结论');
    assert.ok(out.includes('把下面这段复制给我'), '用户不会描述问题，这句是给他抄的');
    assert.match(out, /│ 结论 (PASS|FAIL)/, '报告块里要有结论');
    // 关键：默认不许吐 JSON —— 那正是"看不懂"的根源
    assert.throws(() => JSON.parse(out), '默认输出不该能被 JSON.parse');
  } finally {
    rmSync(r.cwd, { recursive: true, force: true });
    rmSync(r.home, { recursive: true, force: true });
  }
});

test('--json 仍可解析，且 checks 名字是老契约', () => {
  const r = run(['--json']);
  const out = String(r.stdout || '');
  try {
    const j = JSON.parse(out);
    assert.equal(typeof j.ok, 'boolean');
    assert.deepEqual(j.checks.map((c) => c.name), ['node', 'nexi', 'hub', 'hosts', 'launch']);
    const hosts = j.checks.find((c) => c.name === 'hosts');
    assert.ok(Array.isArray(hosts.hosts) && hosts.hosts.length > 0);
    // registered 是新增字段，老消费者忽略它也不会坏
    assert.equal(typeof hosts.hosts[0].registered, 'boolean');
  } finally {
    rmSync(r.cwd, { recursive: true, force: true });
    rmSync(r.home, { recursive: true, force: true });
  }
});

test('--quick 不跑功能自检，仍然给结论', () => {
  const r = run(['--quick']);
  const out = String(r.stdout || '');
  try {
    assert.ok(!out.includes('③ 真能干活吗'), '--quick 不该跑功能段');
    assert.match(out, /结论：/);
    assert.ok(out.includes('（--quick 跳过）'), '报告里要说明为什么没有功能项');
  } finally {
    rmSync(r.cwd, { recursive: true, force: true });
    rmSync(r.home, { recursive: true, force: true });
  }
});

test('体检没有副作用：当前目录不会多出 market / 账本', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'nexi-doctor-pure-'));
  const home = mkdtempSync(path.join(tmpdir(), 'nexi-doctor-pure-home-'));
  try {
    const before = readdirSync(cwd).sort();
    spawnSync(process.execPath, [NEXI, 'doctor'], {
      cwd,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, NEXI_WORKSPACE: cwd, NEXI_LICENSE_ROOT: home },
    });
    const after = readdirSync(cwd).sort();
    assert.deepEqual(after, before, 'doctor 在用户目录里留下了文件');
    // 功能自检必须真的在临时目录里做，连 market 目录都不该出现在 home 里
    assert.ok(!after.includes('market'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('功能自检真的开出了单（不是"跳过"糊过去）', () => {
  const r = run();
  const out = String(r.stdout || '');
  try {
    // 环境里没有宿主时结论可能是 FAIL，但功能段本身必须真跑过
    assert.match(out, /货架\s+\d+ 套皮肤（付费 \d+ 套）/, '货架没报出数量');
    assert.match(out, /开单\s+ord_[A-Za-z0-9_-]+/, '没真开出订单');
    assert.match(out, /皮肤图\s+\d+\/\d+ 帧画得出来/, '皮肤渲染没报数');
  } finally {
    rmSync(r.cwd, { recursive: true, force: true });
    rmSync(r.home, { recursive: true, force: true });
  }
});
