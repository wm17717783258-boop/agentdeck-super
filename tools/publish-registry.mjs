#!/usr/bin/env node
/**
 * tools/publish-registry.mjs —— 把本插件发布到 **官方 MCP Registry**
 *
 * 为什么要这一步：你要的是"在 Agent 里搜一下就能装"。
 * 官方的 MCP Registry（registry.modelcontextprotocol.io）就是干这个的 ——
 * 支持它的客户端（Claude / Cursor / VS Code 等）能直接搜到并安装。
 *
 * 发布链条（缺一不可，顺序也不能换）：
 *   ① package.json 里加 mcpName  ← 已加（= server.json 的 name）
 *   ② server.json                ← 已写，官方 CLI 校验通过
 *   ③ **把包发到 npm**           ← 需要 npm 登录（本机没有 token）
 *   ④ mcp-publisher login github ← 需要你在浏览器里点一下授权
 *   ⑤ mcp-publisher publish
 *
 * 本脚本做的是：把 ①② 准备好、把 ③④⑤ 的真实命令打出来、并在能自动跑的地方自动跑。
 * 它**不会**假装发布成功 —— 该谁登录就让谁登录。
 *
 * 用法：
 *   node tools/publish-registry.mjs --check      # 只看现在卡在哪一步（默认）
 *   node tools/publish-registry.mjs --login      # 起 GitHub 设备码登录（要你在浏览器确认）
 *   node tools/publish-registry.mjs --publish    # 登录之后真发布
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PUB = join(REPO, '.tools', 'mcp-publisher.exe');
const SERVER_JSON = join(REPO, 'server.json');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: REPO, encoding: 'utf8', windowsHide: true, ...opts });

const steps = [];
const ok = (n, e = '') => steps.push(['✅', n, e]);
const no = (n, e = '') => steps.push(['❌', n, e]);
const wait = (n, e = '') => steps.push(['⏳', n, e]);

/* ── ① package.json 的 mcpName ─────────────────────────────────────── */
let pkg = null;
try { pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')); } catch (err) {
  no('package.json 读不出来', String(err.message));
}
const registryName = 'io.github.wm17717783258-boop/agentdeck-super';
if (pkg) {
  if (pkg.mcpName === registryName) ok('package.json 有 mcpName', pkg.mcpName);
  else no('package.json 的 mcpName 不对', `现在是 ${pkg.mcpName || '（没有）'}，应为 ${registryName}`);
}

/* ── ② server.json ────────────────────────────────────────────────── */
let server = null;
if (existsSync(SERVER_JSON)) {
  try {
    server = JSON.parse(readFileSync(SERVER_JSON, 'utf8'));
    if (server.name === registryName) ok('server.json 的 name 与 mcpName 一致', server.name);
    else no('server.json 的 name 与 mcpName 不一致', `${server.name} ≠ ${registryName}`);

    if (!existsSync(PUB)) {
      wait('mcp-publisher CLI 未安装', '从 https://github.com/modelcontextprotocol/registry/releases 下 mcp-publisher_windows_amd64.tar.gz，解出 exe 放到 .tools/');
    } else {
      const v = run(PUB, ['validate']);
      if (v.status === 0 && /valid/i.test(v.stdout)) ok('官方 CLI 校验 server.json 通过');
      else no('官方 CLI 校验没通过', String(v.stdout || v.stderr).slice(0, 200));
    }
  } catch (err) {
    no('server.json 不是合法 JSON', String(err.message));
  }
} else {
  no('没有 server.json', SERVER_JSON);
}

/* ── ③ npm 是否已登录 / 包是否已发布 ─────────────────────────────── */
const npmrc = join(process.env.USERPROFILE || '', '.npmrc');
const npmLoggedIn = existsSync(npmrc) && /_authToken/.test(readFileSync(npmrc, 'utf8'));
if (npmLoggedIn) {
  ok('npm 已登录（有 _authToken）');
  // 包发了没
  try {
    const r = run('npm', ['view', pkg.name, 'version']);
    if (r.status === 0 && String(r.stdout).trim()) ok(`npm 上已有 ${pkg.name}`, `最新版 ${String(r.stdout).trim()}`);
    else wait(`npm 上还没有 ${pkg.name}`, `发它：npm publish --access public`);
  } catch {
    wait('查不了 npm', '离线或 npm 不可用');
  }
} else {
  wait('npm 没登录', '先跑 npm login（要你的 npm 账号），再 npm publish --access public');
}

/* ── 报告 ─────────────────────────────────────────────────────────── */
console.log('');
console.log('MCP Registry 发布状态');
console.log('='.repeat(60));
for (const [mark, name, extra] of steps) {
  console.log(`  ${mark} ${name}${extra ? `\n      ${extra}` : ''}`);
}
console.log('');

/* ── 该谁做什么 ───────────────────────────────────────────────────── */
const blockedOnNpm = !npmLoggedIn;
const missingPub = !existsSync(PUB);

if (has('--login')) {
  if (missingPub) {
    console.log('先装 mcp-publisher CLI（见上面那条 ⏳）。');
    process.exitCode = 1;
  } else {
    console.log('下面会打印一个 GitHub 设备码，你需要在浏览器里确认授权：');
    console.log('');
    const r = run(PUB, ['login', 'github'], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
  }
} else if (has('--publish')) {
  if (blockedOnNpm) {
    console.log('还差 npm 那一步。发布顺序不能换：');
    console.log('  1) npm login                    （要你的 npm 账号）');
    console.log('  2) npm publish --access public  （把包发上去）');
    console.log('  3) node tools/publish-registry.mjs --login    （GitHub 授权）');
    console.log('  4) node tools/publish-registry.mjs --publish  （真发布）');
    process.exitCode = 1;
  } else {
    const r = run(PUB, ['publish'], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
  }
} else {
  console.log('要发布，按顺序做（前两步需要你自己的账号）：');
  console.log('');
  console.log('  ① npm login                     # 你的 npm 账号');
  console.log(`  ② npm publish --access public   # 把 ${pkg?.name || 'agentdeck-super'} 发到 npm`);
  console.log('  ③ node tools/publish-registry.mjs --login     # GitHub 设备码授权');
  console.log('  ④ node tools/publish-registry.mjs --publish   # 推到官方注册表');
  console.log('');
  console.log('发完之后，用户在支持 MCP Registry 的客户端里搜 "agentdeck-super" 就能装。');
  console.log('');
  console.log('⚠️ 诚实边界：注册表 verifies 的是"你拥有这个命名空间"（GitHub 账号），');
  console.log('   不校验包内容。所以能不能用，还是得靠它真跑起来 —— 那部分我们已经验过了。');
}

process.exitCode = process.exitCode ?? 0;
