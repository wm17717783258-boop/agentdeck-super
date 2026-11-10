/**
 * tests/device-anywhere.test.mjs —— 「不分电脑设备」。
 *
 * 这一条最容易被理解成「换台机器能装」，其实还包括：
 *   · 用户的家目录里有中文、空格、emoji（很常见，尤其 Windows）；
 *   · 配置文件是只读的 / 被别的程序占着（企业电脑、同步盘、安全软件）；
 *   · 系统根本没给 HOME（容器、CI、被裁剪的 Windows 账户）；
 *   · 状态目录放在另一个盘、另一台机器的挂载点。
 *
 * 前两条是「能不能用」，后两条是「坏的时候是不是说人话」。
 * 后者同样是成熟度：崩一串堆栈和说一句「只读，去改权限」是两种产品。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { adHocHost, installHost, uninstallHost } from '../lib/connect/hosts.js';
import { auditHost } from '../lib/connect/audit.js';

const NEXI = fileURLToPath(new URL('../bin/nexi.mjs', import.meta.url));
const LAUNCH = { command: process.execPath, args: [NEXI, 'mcp'], env: {} };

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [NEXI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout || ''}`, err: `${r.stderr || ''}` };
}

test('中文 · 空格 · emoji · 长路径：装、审、卸、还原全通', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-weird-'));
  const deep = path.join(root, '我的 配置 🚀 目录', 'a'.repeat(60));
  mkdirSync(deep, { recursive: true });
  const file = path.join(deep, 'mcp 配置.json');
  const original = '{\n  "mcpServers": {}\n}\n';
  writeFileSync(file, original);

  const host = adHocHost({ id: 'p', path: file, shape: 'mcpServers' });
  const inst = installHost('p', { host, path: file, launch: LAUNCH, force: true });
  assert.equal(inst.ok, true, `怪路径装不上：${inst.reason || (inst.warnings || []).join('；')}`);

  // 审计会报 unreachable，因为 LAUNCH 里的脚本是真实存在的 bin/nexi.mjs —— 这里应该 wired
  const a = auditHost(host, { file, currentLaunch: LAUNCH });
  assert.equal(a.state, 'wired', `怪路径审出 ${a.state}：${a.reason || ''}`);

  const un = uninstallHost('p', { host, path: file });
  assert.equal(un.ok, true);
  assert.equal(readFileSync(file, 'utf8'), original, '怪路径下卸载没还原');
  rmSync(root, { recursive: true, force: true });
});

test('只读文件：返回 permission-denied + 怎么办，不抛堆栈、不留半写文件', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-ro-'));
  const file = path.join(root, 'ro.json');
  const original = '{"mcpServers":{}}\n';
  writeFileSync(file, original);
  chmodSync(file, 0o444);
  try {
    const r = installHost('p', {
      host: adHocHost({ id: 'p', path: file, shape: 'mcpServers' }),
      path: file,
      launch: LAUNCH,
      force: true,
    });
    assert.equal(r.ok, false, '只读文件居然装成功了');
    assert.equal(r.reason, 'permission-denied');
    assert.match(String(r.message), /只读|占用/, '没说清为什么写不进去');
    assert.match(String(r.hint), /--dry-run|权限|--path/, '没告诉用户接下来能做什么');
    assert.equal(readFileSync(file, 'utf8'), original, '只读文件被改了');
    const strays = readdirSync(root).filter((n) => n.endsWith('.nexi.tmp'));
    assert.deepEqual(strays, [], `留下了半写临时文件：${strays.join(', ')}`);
  } finally {
    chmodSync(file, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});

test('只读的目标目录：失败也要说人话，不崩', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-ro-dir-'));
  const dir = path.join(root, 'locked');
  mkdirSync(dir);
  chmodSync(dir, 0o555);
  try {
    const file = path.join(dir, 'mcp.json');
    const r = installHost('p', {
      host: adHocHost({ id: 'p', path: file, shape: 'mcpServers' }),
      path: file,
      launch: LAUNCH,
      force: true,
    });
    // Windows 上目录的 0555 不阻止写入，所以这里两种结果都合法 ——
    // 关键是「要么成功，要么给结构化失败」，不许抛异常。
    if (r.ok) {
      assert.ok(readFileSync(file, 'utf8').includes('nexi'));
    } else {
      assert.ok(['permission-denied', 'write-failed'].includes(r.reason), `未知失败原因：${r.reason}`);
      assert.ok(String(r.hint || '').length > 0, '失败没有 hint');
    }
  } finally {
    chmodSync(dir, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

test('系统没给 HOME / USERPROFILE：命令不崩', () => {
  const env = { ...process.env };
  delete env.HOME;
  delete env.USERPROFILE;
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;
  // 只在 Windows 上真正删得掉，其他系统 os.homedir() 会读 /etc/passwd，同样不该崩
  const r = spawnSync(process.execPath, [NEXI, 'status'], { encoding: 'utf8', timeout: 30000, env });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(r.status === 0 || r.status === 1, `退出码异常：${r.status}`);
  assert.ok(!/Cannot read propert|TypeError|at Object\./.test(text), `崩了：\n${text.slice(0, 500)}`);
});

test('换一个盘 / 换一个状态目录：照常工作，不认旧路径', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-other-'));
  const env = {
    DSH_HOME: path.join(root, 'another-drive', 'dsh'),
    NEXI_WORKSPACE: path.join(root, 'ws'),
    NEXI_BOARD_ROOT: path.join(root, 'board'),
    NEXI_PET_ROOT: path.join(root, 'pet'),
    NEXI_LICENSE_ROOT: path.join(root, 'lic'),
    NEXI_ROOM_ROOT: path.join(root, 'room'),
  };
  mkdirSync(env.NEXI_WORKSPACE, { recursive: true });
  const st = cli(['status'], env);
  assert.ok(!/Cannot read propert|TypeError/.test(`${st.out}${st.err}`), '换盘后崩了');

  const cfg = path.join(root, 'mcp.json');
  writeFileSync(cfg, '{"mcpServers":{}}\n');
  const inst = cli(['install', 'custom', cfg, '--shape', 'mcpServers'], env);
  assert.equal(inst.code, 0, `换盘后装不上：${inst.err || inst.out}`);
  assert.match(readFileSync(cfg, 'utf8'), /nexi/);
  rmSync(root, { recursive: true, force: true });
});

test('--path 带尾斜杠 / 混用分隔符：仍指向同一个文件', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexi-sep-'));
  const file = path.join(root, 'mcp.json');
  writeFileSync(file, '{"mcpServers":{}}\n');
  const messy = process.platform === 'win32'
    ? `${root.replace(/\\/g, '/')}/mcp.json`
    : `${root}//mcp.json`;
  const r = cli(['install', 'custom', messy, '--shape', 'mcpServers']);
  assert.equal(r.code, 0, `混用分隔符装不上：${r.err || r.out}`);
  assert.match(readFileSync(file, 'utf8'), /nexi/);
  rmSync(root, { recursive: true, force: true });
});
