/**
 * tests/performance-scale.test.mjs —— R10：性能与规模。
 *
 * 这一轮不追极限数字，只钉三条"不能让用户感到肉"的下限：
 *
 *   ① 装完 30 家要在人的耐心之内（纯文件路径，不含第三方 CLI 启动）；
 *   ② 探测/生成配置这类**只读**操作必须便宜 —— 它被调用的次数比安装多得多；
 *   ③ 大配置文件（几 MB）不能卡死，内存也不能一次比一次涨。
 *
 * 阈值故意写得宽松（比实测慢 3–10 倍才算失败）：这是回归护栏，不是跑分。
 * 写死"必须 12ms"那种断言，换台慢机器就红，最后没人信它。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  HOSTS, adHocHost, detectHosts, installHost, kindFor, uninstallHost, clearPathCache,
} from '../lib/connect/hosts.js';
import { platformCtx } from '../lib/connect/platform.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'nexi.mjs');
const tmp = (tag) => mkdtempSync(path.join(tmpdir(), `nexi-perf-${tag}-`));

/** 一个"什么都装在本目录"的假机器：不碰真实家目录。 */
function fakeCtx(home) {
  const env = {
    ...process.env,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    HOME: home,
  };
  return platformCtx({ platform: process.platform === 'win32' ? 'win32' : (process.platform === 'darwin' ? 'darwin' : 'linux'), home, env });
}

function ms(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  const cost = Number(process.hrtime.bigint() - t0) / 1e6;
  return { value, cost };
}

/* ── ① 30 家全装 ─────────────────────────────────────────────────────────── */

test('30 家全装 + 全卸：纯文件路径在 6 秒内走完（不含第三方 CLI）', () => {
  const home = tmp('all30');
  mkdirSync(path.join(home, 'hosts'), { recursive: true });

  const plan = HOSTS.map((h) => {
    const file = path.join(home, 'hosts', `${h.id}.${kindFor(h, 'x.json') === 'toml' ? 'toml' : 'json'}`);
    const kind = kindFor(h, file);
    return {
      id: h.id,
      file,
      host: adHocHost({
        id: h.id,
        kind: kind === 'auto' ? 'json' : kind,
        shape: h.shape && String(h.shape).startsWith('yaml') ? h.shape : 'mcpServers',
        path: file,
      }),
    };
  });

  const install = ms(() => plan.map((p) => installHost(p.id, { host: p.host, path: p.file, via: 'file' })));
  const okCount = install.value.filter((r) => r.ok).length;
  assert.equal(okCount, HOSTS.length, `只有 ${okCount}/${HOSTS.length} 家装上了`);
  assert.ok(install.cost < 6000, `装 ${HOSTS.length} 家花了 ${install.cost.toFixed(0)}ms，太肉`);

  const uninstall = ms(() => plan.map((p) => uninstallHost(p.id, { host: p.host, path: p.file })));
  assert.ok(
    uninstall.value.every((r) => r.ok),
    '有宿主没卸干净',
  );
  assert.ok(uninstall.cost < 5000, `卸 ${HOSTS.length} 家花了 ${uninstall.cost.toFixed(0)}ms`);
});

/* ── ② 只读操作必须便宜 ──────────────────────────────────────────────────── */

test('detectHosts 跑 200 次在 3 秒内：它被调用得比安装频繁得多', () => {
  clearPathCache();
  const ctx = fakeCtx(tmp('detect'));
  detectHosts(ctx); // 预热 PATH 缓存
  const { value, cost } = ms(() => {
    let last = null;
    for (let i = 0; i < 200; i += 1) last = detectHosts(ctx);
    return last;
  });
  assert.equal(value.length, HOSTS.length);
  assert.ok(cost < 3000, `200 次探测花了 ${cost.toFixed(0)}ms（单次 ${(cost / 200).toFixed(1)}ms）`);
});

test('config --all 端到端在 8 秒内（含进程启动），且 30 家都给了配置', () => {
  const home = tmp('config-all');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'config', '--all', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NEXI_LOG: '0', DSH_HOME: home, NEXI_LOG_DIR: path.join(home, 'logs') },
  });
  const cost = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  const arr = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  assert.equal(arr.length, HOSTS.length);
  assert.ok(cost < 8000, `config --all 花了 ${cost}ms`);
});

test('CLI 冷启动在 5 秒内：每次敲 nexi 都是新进程，这个数字就是手感', () => {
  const home = tmp('cold');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'version', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NEXI_LOG: '0', DSH_HOME: home, NEXI_LOG_DIR: path.join(home, 'logs') },
  });
  const cost = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr.slice(0, 200));
  assert.ok(cost < 5000, `一次 version 花了 ${cost}ms`);
});

/* ── ③ 大文件与内存 ──────────────────────────────────────────────────────── */

test('2.4MB 的配置文件：装与卸都在 5 秒内，且内容没被改坏', () => {
  const home = tmp('big');
  const file = path.join(home, 'big.json');
  const servers = {};
  for (let i = 0; i < 20000; i += 1) servers[`s${i}`] = { command: 'node', args: ['x'], env: { A: 'b' } };
  writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
  const size = statSync(file).size;
  assert.ok(size > 2 * 1024 * 1024, `样本不够大：${size}`);

  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
  const ins = ms(() => installHost('custom', { host, path: file, force: true }));
  assert.equal(ins.value.ok, true, JSON.stringify(ins.value).slice(0, 200));
  assert.ok(ins.cost < 5000, `装 2.4MB 花了 ${ins.cost.toFixed(0)}ms`);

  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.keys(after.mcpServers).length, 20001, '原有 20000 条 + nexi 一条');
  assert.ok(after.mcpServers.nexi, 'nexi 没写进去');

  const un = ms(() => uninstallHost('custom', { host, path: file }));
  assert.equal(un.value.ok, true);
  assert.ok(un.cost < 5000, `卸 2.4MB 花了 ${un.cost.toFixed(0)}ms`);
  const back = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.keys(back.mcpServers).length, 20000, '卸载没回到原样');
  assert.equal(back.mcpServers.nexi, undefined);
});

test('连装 150 次不涨内存：每次装完不留引用（gc 后增长 < 80MB）', () => {
  const home = tmp('mem');
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 150; i += 1) {
    const file = path.join(home, `h${i}.json`);
    const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
    installHost('custom', { host, path: file, force: true });
  }
  // 没有 --expose-gc 时手动触发一次，尽量让数字可信
  if (typeof global.gc === 'function') global.gc();
  const grown = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  assert.ok(grown < 80, `装了 150 次涨了 ${grown.toFixed(1)}MB，可能有地方在攒东西`);
});
