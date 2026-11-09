#!/usr/bin/env node
/**
 * tools/go-live.mjs —— 一条命令走完发布（你登录 npm 之后跑这个）
 *
 * 它按顺序做四件事，每步都验证，任一步失败就停下并说清原因：
 *   ① 检查 npm 登录状态
 *   ② npm publish --access public        （把包发上 npm）
 *   ③ mcp-publisher login github          （要你在浏览器点一次授权）
 *   ④ mcp-publisher publish               （推到官方 MCP Registry）
 *   ⑤ 验证：搜得到、装得上
 *
 * 用法：
 *   node tools/go-live.mjs              # 从第①步开始，能自动的自动做
 *   node tools/go-live.mjs --check      # 只看状态，什么都不做
 *   node tools/go-live.mjs --skip-login # 已经登录过 registry，跳过第③步
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PUB = join(REPO, '.tools', 'mcp-publisher.exe');
const REGISTRY_NAME = 'io.github.wm17717783258-boop/agentdeck-super';
const PKG_NAME = 'agentdeck-super';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const step = (n, t) => console.log(`\n【第 ${n} 步】${t}`);
const good = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const info = (m) => console.log(`     ${m}`);

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, {
  cwd: REPO, encoding: 'utf8', windowsHide: true, ...opts,
});

console.log('');
console.log('Nexi 灵犀 —— 发布到 npm + 官方 MCP Registry');
console.log('='.repeat(62));

/* ── ① npm 登录 ───────────────────────────────────────────────────── */
step(1, 'npm 登录状态');
const npmrc = join(process.env.USERPROFILE || '', '.npmrc');
const hasToken = existsSync(npmrc) && /_authToken/.test(readFileSync(npmrc, 'utf8'));
let who = '';
if (hasToken) {
  const w = run('npm', ['whoami']);
  who = String(w.stdout || '').trim();
  if (who) good(`已登录：${who}`);
  else {
    bad('有 .npmrc 但 whoami 失败（token 可能过期）');
    info('重新登录：npm login');
    process.exitCode = 1;
    process.exit();
  }
} else {
  bad('还没登录 npm');
  info('去做这一步（两分钟）：');
  info('  ① 打开 https://www.npmjs.com/signup');
  info('  ② 点「Sign up with GitHub」用你的 GitHub 登录（你的 GitHub 是 Google 邮箱，一样能用）');
  info('  ③ 去邮箱点验证链接');
  info('  ④ 回来在终端跑：npm login     （会打开浏览器让你点授权）');
  info('');
  info('登录完之后再跑一次：node tools/go-live.mjs');
  process.exitCode = 1;
  process.exit();
}

if (has('--check')) {
  console.log('\n（--check：只看状态，不动任何东西）');
  process.exitCode = 0;
  process.exit();
}

/* ── ② npm publish ────────────────────────────────────────────────── */
step(2, '把包发到 npm');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
let already = '';
{
  const v = run('npm', ['view', PKG_NAME, 'version']);
  already = String(v.stdout || '').trim();
}
if (already === pkg.version) {
  good(`npm 上已经有 ${PKG_NAME}@${pkg.version}（跳过发布）`);
} else {
  info(`发 ${PKG_NAME}@${pkg.version} …`);
  const pub = run('npm', ['publish', '--access', 'public'], { stdio: 'inherit' });
  if (pub.status !== 0) {
    bad('npm publish 失败 —— 看上面的报错');
    info('常见原因：没登录 / 包名被占 / 版本号已存在');
    process.exitCode = 1;
    process.exit();
  }
  good('已发到 npm');
}

/* ── ③ 登录 MCP Registry ──────────────────────────────────────────── */
step(3, '登录官方 MCP Registry（要你在浏览器点授权）');
if (has('--skip-login')) {
  good('（--skip-login：跳过）');
} else {
  if (!existsSync(PUB)) {
    bad('没有 mcp-publisher CLI');
    info('去 https://github.com/modelcontextprotocol/registry/releases 下');
    info('mcp-publisher_windows_amd64.tar.gz，解出 exe 放到 .tools/');
    process.exitCode = 1;
    process.exit();
  }
  info('下面会打印一个 GitHub 设备码，你需要在浏览器里输入并授权：');
  console.log('');
  const login = run(PUB, ['login', 'github'], { stdio: 'inherit' });
  console.log('');
  if (login.status !== 0) {
    bad('登录失败');
    process.exitCode = 1;
    process.exit();
  }
  good('已登录 registry');
}

/* ── ④ 校验 + 发布 ────────────────────────────────────────────────── */
step(4, '校验 server.json 并发布到 registry');
const val = run(PUB, ['validate']);
if (val.status !== 0 || !/valid/i.test(String(val.stdout || ''))) {
  bad('server.json 校验没过');
  info(String(val.stdout || val.stderr || '').slice(0, 300));
  process.exitCode = 1;
  process.exit();
}
good('server.json 校验通过');

const pub2 = run(PUB, ['publish'], { stdio: 'inherit' });
if (pub2.status !== 0) {
  bad('发布失败 —— 看上面的报错');
  info('常见原因：没登录 / mcpName 与 registry name 不一致 / 该版本已发布过');
  process.exitCode = 1;
  process.exit();
}
good('已发布到官方 MCP Registry');

/* ── ⑤ 验证 ───────────────────────────────────────────────────────── */
step(5, '验证：陌生人能不能搜到、能不能装');
console.log('');

const searchUrl = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(REGISTRY_NAME)}`;
const check = run(process.execPath, ['-e', `
  fetch(${JSON.stringify(searchUrl)})
    .then((r) => r.json())
    .then((j) => {
      const list = Array.isArray(j.servers) ? j.servers : [];
      const hit = list.find((s) => s?.server?.name === ${JSON.stringify(REGISTRY_NAME)});
      if (hit) {
        console.log('FOUND ' + hit.server.name + ' v' + hit.server.version);
      } else {
        console.log('NOTFOUND 共 ' + list.length + ' 条结果');
      }
    })
    .catch((e) => console.log('ERROR ' + e.message));
`]);
const out = String(check.stdout || '').trim();
if (out.startsWith('FOUND')) {
  good(`registry 上搜得到：${out.slice(6)}`);
} else if (out.startsWith('NOTFOUND')) {
  bad(`registry 上还没搜到（${out.slice(9)}）`);
  info('刚发布可能要等一分钟才索引到，稍后再查：');
  info(`  curl "${searchUrl}"`);
} else {
  info(`查询没成功：${out}`);
}

console.log('');
console.log('='.repeat(62));
console.log('做完了。现在用户可以：');
console.log('');
console.log('  · 在支持 MCP Registry 的客户端里搜 "agentdeck-super" 直接装');
console.log(`  · 或者 npx ${PKG_NAME}` + '（npm 上已可装）');
console.log(`  · 或者从 GitHub Release 下载：`);
console.log('      https://github.com/wm17717783258-boop/agentdeck-super/releases/tag/v1.10.0');
console.log('');
process.exitCode = 0;
