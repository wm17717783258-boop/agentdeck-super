/**
 * tests/selfcheck-pack-install.test.mjs —— 第 19 轮自检：干净机器安装 / 中文路径 / 升级
 *
 * 不看源码目录里"应该能跑"，而是：
 *   ① 真 npm pack 出交付包
 *   ② 解到带中文和空格的路径（真机最容易翻车的路径）
 *   ③ 用全新 DSH_HOME / 工作区，照宿主的方式起一次 MCP stdio 服务
 *   ④ 把包装到另一个目录（模拟升级），原工作区数据仍然读得到
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractTgz } from '../lib/untar.js';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packTo(dir) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['pack', '--pack-destination', dir, '--silent'], {
    cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 120000, shell: process.platform === 'win32',
  });
  const name = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const file = join(dir, name);
  return { status: r.status, file, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function runMcp(pkgDir, dshHome, work) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(pkgDir, 'bin', 'nexi.mjs'), 'mcp'], {
      cwd: pkgDir,
      env: { ...process.env, DSH_HOME: dshHome, NEXI_WORKSPACE: work },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buf = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出就算了 */ }
      resolvePromise(value);
    };
    const timer = setTimeout(() => done({ ok: false, reason: '15 秒没有回应', log: buf.slice(-400) }), 15000);

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          const names = (msg.result?.tools || []).map((x) => x.name);
          done({ ok: true, server: msg.result?.serverInfo, tools: names, log: buf.slice(-400) });
        }
      }
    });
    child.stderr.on('data', (d) => { buf += d.toString(); });
    child.on('error', (err) => done({ ok: false, reason: err.message }));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selfcheck', version: '1' } },
    })}\n`);
  });
}

test('交付包：真 npm pack → 中文+空格路径解包 → 全新 HOME 起 MCP 服务', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-pack-'));
  try {
    const packed = packTo(base);
    if (packed.status !== 0 || !existsSync(packed.file)) {
      t.skip(`本机 npm pack 不可用：${packed.err || packed.out}`.slice(0, 300));
      return;
    }

    // 故意用中文 + 空格 + 括号：真机最常见、也最容易在 shell/编码上翻车的路径
    const dest = join(base, '另一台电脑 的安装目录 (测试)');
    const un = extractTgz(packed.file, dest, { readFile: readFileSync });
    assert.equal(un.ok, true, un.reason);
    const pkgDir = join(dest, 'package');
    for (const rel of [
      'bin/nexi.mjs',
      'lib/index.js',
      'lib/pro-resolve.js',
      'lib/pet/persona.js',
      'lib/hosting/index.js',
      'tests/cli.test.mjs',
      'tests/fixtures/fake-agent.mjs',
      'tests/fixtures/fake-agent.cmd',
      'docs/操作手册.md',
      'docs/多设备协作测试方案.md',
      'docs/功能现状核对表.md',
      'LICENSE',
    ]) {
      assert.equal(existsSync(join(pkgDir, rel)), true, `交付包缺文件：${rel}`);
    }

    // 闭源商业层绝不能出现在公开包里 —— 这是拆分的底线，写进测试来守。
    for (const forbidden of ['pro', 'pro/billing', 'pro/market', 'pro/sync', 'pro/meeting']) {
      assert.equal(existsSync(join(pkgDir, forbidden)), false,
        `公开包里出现了闭源商业层：${forbidden}（打包白名单漏了排除）`);
    }

    const dshHome = join(base, '全新机器', 'dsh-home');
    const work = join(base, '全新机器', 'workspace');
    mkdirSync(dshHome, { recursive: true });
    mkdirSync(work, { recursive: true });

    const mcp = await runMcp(pkgDir, dshHome, work);
    assert.equal(mcp.ok, true, `解包后的服务起不来：${mcp.reason}\n${mcp.log}`);
    assert.ok((mcp.tools || []).length >= 20, `工具数量异常：${mcp.tools?.length}`);
    for (const name of ['deck_sync', 'deck_room', 'team_board', 'pet_visit']) {
      assert.ok(mcp.tools.includes(name), `工具清单缺 ${name}：${mcp.tools.join(',')}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('升级：换一个安装目录后，旧工作区的记忆仍然读得到', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-upgrade-'));
  try {
    const packed = packTo(base);
    if (packed.status !== 0 || !existsSync(packed.file)) {
      t.skip(`本机 npm pack 不可用：${packed.err || packed.out}`.slice(0, 300));
      return;
    }
    const oldDir = join(base, '旧版本');
    const newDir = join(base, '新版本');
    assert.equal(extractTgz(packed.file, oldDir, { readFile: readFileSync }).ok, true);
    const oldPkg = join(oldDir, 'package');

    const work = join(base, '工作区');
    mkdirSync(work, { recursive: true });
    const seed = spawnSync(process.execPath, ['-e', `
      const target = ${JSON.stringify(join(oldPkg, 'lib', 'twin', 'memory.js'))};
      import(require('node:url').pathToFileURL(target).href).then(async (m) => {
        const r = m.remember(${JSON.stringify(work)}, { content: '升级前写下的记忆', type: 'semantic' }, { now: () => 1700000000000 });
        if (!r || r.ok === false) { console.error(JSON.stringify(r)); process.exit(1); }
      });
    `], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(seed.status, 0, `旧版本写记忆失败：${seed.stderr}`);

    assert.equal(extractTgz(packed.file, newDir, { readFile: readFileSync }).ok, true);
    const newPkg = join(newDir, 'package');
    const read = spawnSync(process.execPath, ['-e', `
      const target = ${JSON.stringify(join(newPkg, 'lib', 'twin', 'memory.js'))};
      import(require('node:url').pathToFileURL(target).href).then(async (m) => {
        const r = m.readMemory(${JSON.stringify(work)});
        const hit = (r.memory.items || []).some((x) => String(x.text || '').includes('升级前写下的记忆'));
        console.log(JSON.stringify({ ok: r.ok, hit }));
        if (!hit) process.exit(1);
      });
    `], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(read.status, 0, `新版本读不到旧数据：${read.stderr}`);
    assert.equal(JSON.parse(String(read.stdout).trim().split(/\r?\n/).pop()).hit, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
