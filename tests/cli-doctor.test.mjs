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
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

/**
 * 回归：`npx -y agentdeck-super doctor` 曾经根本不是体检。
 *
 * bin 名 agentdeck-super 指向 install.mjs，所以 doctor 被当成"宿主 id"喂进
 * 安装流程 —— 用户以为在体检，实际又装了一遍，还附一条 unknown-host。
 * 这条是真踩过的坑，必须钉住。
 */
const INSTALL = path.join(ROOT, 'install.mjs');

function runInstaller(args) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'nexi-installer-cwd-'));
  const home = mkdtempSync(path.join(tmpdir(), 'nexi-installer-home-'));
  try {
    const res = spawnSync(process.execPath, [INSTALL, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, NEXI_WORKSPACE: cwd, NEXI_LICENSE_ROOT: home },
    });
    return { stdout: String(res.stdout || ''), status: res.status, cwd, home };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test('install.mjs doctor 必须转发成体检，不能变成又装一遍', () => {
  const r = runInstaller(['doctor']);
  assert.match(r.stdout, /^Nexi 自检 · v\d+/, 'doctor 没被转发到 nexi，输出不是体检');
  assert.ok(!r.stdout.includes('固定目录安装'), 'doctor 触发了安装流程，这就是那个坑');
  assert.ok(!r.stdout.includes('unknown-host'), 'unknown-host 说明 doctor 被当成宿主 id 了');
});

test('install.mjs --help 仍是安装器帮助（别被透传抢走）', () => {
  const r = runInstaller(['--help']);
  assert.ok(r.stdout.includes('Nexi 安装器'), '--help 应该讲安装器怎么用');
  assert.ok(!r.stdout.includes('Nexi 自检'), '--help 不该变成 doctor');
});

test('install 是动词：\`install --all\` 不能被当成宿主名', () => {
  const r = runInstaller(['install', '--dry-run', '--no-hosts']);
  assert.ok(r.stdout.includes('干跑完成'), 'install 应该被当成"装"，而不是宿主 id');
  assert.ok(!r.stdout.includes('unknown-host'), 'install 被当成宿主名了');
});

test('uninstall 必须转发给 nexi（文档里就是这么让用户卸的）', () => {
  // 不在真实环境跑卸载（那会动宿主配置），只钉住转发集合里有它。
  // 行为验证在 tools/ 的证据脚本里做。
  const src = readFileSync(INSTALL, 'utf8');
  const m = src.match(/const FORWARDED = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, '找不到转发集合');
  assert.ok(/'uninstall'/.test(m[1]), 'uninstall 没转发 → npx agentdeck-super uninstall --all 会报 unknown-host');
});

/**
 * 插件市场里 .mcp.json 写的是 `npx -y agentdeck-super mcp`——
 * 也就是先经过 install.mjs 再转发。如果这条链断在透传上，
 * 用户装完插件看到 MCP servers (1)，但工具一个都调不出来。
 * 已发布的 1.11.10 就是这样：install.mjs 不认识 mcp，把它当宿主名。
 */
test('install.mjs mcp 真能起协议服务（插件靠这一条活着）', async () => {
  const child = spawn(process.execPath, [INSTALL, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  const errs = [];
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => errs.push(d.toString()));

  const handshake = new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const text = out.join('');
      const line = text.split('\n').find((l) => l.trim().startsWith('{'));
      if (line) {
        try {
          const j = JSON.parse(line);
          if (j.id === 1 && j.result) {
            clearInterval(tick);
            resolve({ ok: true, info: j.result.serverInfo, proto: j.result.protocolVersion });
            return;
          }
        } catch { /* 还没收全 */ }
      }
      if (Date.now() - started > 20000) {
        clearInterval(tick);
        resolve({ ok: false, out: text.slice(0, 300), err: errs.join('').slice(0, 300) });
      }
    }, 120);
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })}\n`,
  );

  const r = await handshake;
  child.kill();
  assert.ok(r.ok, `mcp 没握手成功：${r.out || ''} ${r.err || ''}`);
  assert.equal(r.info?.name, 'nexi', '起的是别的东西');
  assert.ok(r.proto, '没返回协议版本');
});
