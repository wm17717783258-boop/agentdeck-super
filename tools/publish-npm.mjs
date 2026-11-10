#!/usr/bin/env node
/**
 * 一条命令把插件发到 npm（拿掉 git 依赖，Windows 上也能跑）
 *
 * 用法：
 *   node tools/publish-npm.mjs                       # 干跑：体检 + 打包 + 打印要执行的命令
 *   node tools/publish-npm.mjs --publish             # 真的发（需要 NPM_TOKEN 环境变量）
 *   node tools/publish-npm.mjs --publish --otp 123456
 *
 * NPM_TOKEN 从哪来：npmjs.com → Access Tokens → Generate New Token (Granular, Read and Publish)
 *   然后 $env:NPM_TOKEN = 'npm_xxx'（PowerShell 当前会话生效）
 *
 * 发完之后上架到 DSH 插件市场只需要一行：
 *   dsh plugin add agentdeck-super
 * 市场会自己跑 `dsh plugin add` 校验，所以本脚本先自己跑一遍同样的检查。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shouldPublish = args.includes('--publish');
const otpIdx = args.indexOf('--otp');
const otp = otpIdx > -1 ? args[otpIdx + 1] : '';

const NODE = process.execPath;
const NPX = join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js');

function npm(cmdArgs, opts = {}) {
  // npm 就在 Node 旁边；找不到就用 npx 兜底
  if (existsSync(NPX)) return execFileSync(NODE, [NPX, ...cmdArgs], { cwd: root, encoding: 'utf8', stdio: opts.stdio || 'pipe', env: process.env });
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', cmdArgs, { cwd: root, encoding: 'utf8', stdio: opts.stdio || 'pipe', env: process.env });
}

const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => console.log(`  ✗ ${msg}`);

// ── 1. 体检 ────────────────────────────────────────────────────────────────

log('\n[1/5] 体检 package.json 与插件契约');
const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) {
  bad('找不到 package.json');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const problems = [];

if (!pkg.name || !pkg.version) problems.push('缺少 name / version');
if (pkg.type !== 'module') problems.push('type 必须是 module（ESM）');
if (!pkg.main) problems.push('缺少 main');
if (!pkg.dsh?.bundle?.patch) problems.push('缺少 dsh.bundle.patch（市场要求 dsh.bundle）');
if (!existsSync(join(root, 'cordis.patch.yml'))) problems.push('缺少 cordis.patch.yml');
// 前端面板是可选的：本插件用宿主托管的 HTML 状态页，没有 React 客户端。
// 但只要声明了 dsh.client，就必须配套 exports["./client"] 和 platform:"web"，否则宿主加载会炸。
if (pkg.dsh?.client) {
  if (!pkg.exports?.['./client']) problems.push('声明了 dsh.client 却缺少 exports["./client"]');
  if (pkg.dsh.client.platform !== 'web') problems.push('声明了 dsh.client 但 platform 不是 web');
}
const rel = pkg.dsh?.compatibility?.dshReleases;
if (!rel || typeof rel !== 'object' || Object.keys(rel).length === 0) {
  problems.push('缺少 dsh.compatibility.dshReleases（对象，形如 {"0.2.1-rc.5":"compatible"}）');
}
if (!pkg.license) problems.push('缺少 license 字段（要开源上架，填 MIT）');
if (pkg.private) problems.push('private:true 会导致发不出去');
if (!existsSync(join(root, 'LICENSE'))) problems.push('仓库根目录缺 LICENSE 文件（开源上架必须有）');
else if (!(pkg.files || []).includes('LICENSE')) problems.push('files 里缺 LICENSE（npm 默认会带，但显式写更稳）');
// 仓库地址：要么没有，要么是真实地址。占位符发上去比没有更糟（用户点进去 404）。
const repoUrl = String((pkg.repository && (pkg.repository.url || pkg.repository)) || '');
const PLACEHOLDER = /example\.com|wangmian\/agentdeck-super|your-name|YOUR_GITHUB/i;
if (repoUrl && PLACEHOLDER.test(repoUrl)) {
  problems.push(`repository 还是占位地址（${repoUrl}）：先建真仓库再跑 tools/set-repo.mjs <你的仓库地址>`);
}
if (pkg.homepage && PLACEHOLDER.test(String(pkg.homepage))) problems.push(`homepage 还是占位地址（${pkg.homepage}）`);
if (pkg.bugs && PLACEHOLDER.test(String(pkg.bugs.url || pkg.bugs))) problems.push('bugs 还是占位地址');
for (const need of ['tools', 'assets']) {
  if (!(pkg.files || []).includes(need)) problems.push(`files 里缺 ${need}（tools=自建中继/发码，assets=图标与皮肤）`);
}

if (problems.length) {
  for (const p of problems) bad(p);
  log('\n先修完上面的问题再发。');
  process.exit(1);
}
ok(`包名 ${pkg.name}@${pkg.version}`);
ok(`插件契约齐全（ESM / dsh.bundle / ${pkg.dsh?.client ? 'client / ' : ''}compatibility）`);

// icon 大小
const iconCandidates = ['assets/logo.png', 'icon.png', 'assets/icon.png'];
for (const rel of iconCandidates) {
  const p = join(root, rel);
  if (existsSync(p)) {
    const size = statSync(p).size;
    if (size > 256 * 1024) bad(`${rel} 有 ${(size / 1024).toFixed(0)} KiB，超过 256 KiB 上限（市场会拒）`);
    else ok(`图标 ${rel} ${(size / 1024).toFixed(0)} KiB`);
  }
}

// ── 2. 名字占用 ────────────────────────────────────────────────────────────

log('\n[2/5] 检查 npm 上这个名字有没有被占');
const name = String(pkg.name).replace(/^@[^/]+\//, '');
try {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, { method: 'GET' });
  if (res.status === 404) ok(`${pkg.name} 还没人用，可以发`);
  else if (res.status === 200) {
    const info = await res.json();
    const versions = Object.keys(info.versions || {});
    ok(`${pkg.name} 已存在（${versions.length} 个版本），这次会作为新版本发布`);
    const latest = info['dist-tags']?.latest;
    if (latest === pkg.version) {
      bad(`版本 ${pkg.version} 已经发过一次了，先把 version 往上加一格`);
      process.exit(1);
    }
    const maint = Object.keys(info.maintainers || {});
    log(`    维护者：${maint.join(', ') || '（未知）'} —— 如果不是你，说明名字被别家占了`);
  }
} catch (err) {
  bad(`查不到 registry（${err.message}）—— 网络问题，可以加 --offline 跳过这一步重试`);
}

// ── 3. 测试 ────────────────────────────────────────────────────────────────

log('\n[3/5] 跑全量测试（串行，避免 spawn 用例假超时）');
try {
  const out = execFileSync(NODE, ['--test', '--test-concurrency=1', 'tests/*.test.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // 两种汇总格式都要认：裸 `node --test` 出 TAP（`# pass 1399`），
  // 项目入口 tools/test-summary.mjs 出 spec（`ℹ pass 1399`）。
  // 以前只认后者，所以这里长期显示 `pass ?` —— 发布体检时看不到真实用例数。
  const stat = (name) => (out.match(new RegExp(`(?:ℹ|#) ${name} (\\d+)`)) || [])[1];
  const pass = stat('pass');
  const fail = stat('fail');
  if (Number(fail) > 0) throw new Error(`有 ${fail} 条用例失败`);
  if (pass === undefined) throw new Error('没解析到用例数 —— 测试输出格式变了，先修这个再发（别让体检显示 pass ?）');
  ok(`核心用例通过（pass ${pass}，fail ${fail ?? 0}）—— 不含 pro/ 商业层，那一层由 npm test 覆盖`);
} catch (err) {
  bad('测试没过，先修测试再发');
  console.log(String(err.stdout || '').split('\n').slice(-25).join('\n'));
  process.exit(1);
}

// ── 4. 打包 ────────────────────────────────────────────────────────────────

log('\n[4/5] npm pack（看清哪 些文件真的进了 tarball）');
let packOut = '';
try {
  packOut = npm(['pack', '--dry-run', '--json']);
  const info = JSON.parse(packOut)[0];
  const files = info.files || [];
  const totalKb = (info.size || 0) / 1024;
  ok(`共 ${files.length} 个文件，约 ${totalKb.toFixed(0)} KiB`);
  const must = [
    'lib/index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE',
    'tools/relay-server.mjs', 'tools/license-cli.mjs', 'assets/logo.png',
  ];
  for (const m of must) {
    if (files.some((f) => f.path === m)) ok(`包含 ${m}`);
    else bad(`缺少 ${m}（检查 files 字段）`);
  }
  // 包里允许出现的测试文件：只有让用户装完能跑 `npm run smoke` 的那几个，多一个都算 files 漏了排除。
  const ALLOWED_TESTS = ['tests/e2e-local.mjs', 'tests/fixtures/fake-agent.mjs', 'tests/fixtures/fake-agent.cmd'];
  const tests = files.filter((f) => f.path.startsWith('tests/'));
  const stray = tests.filter((f) => !ALLOWED_TESTS.includes(f.path));
  if (stray.length > 0) {
    bad(`包里有 ${stray.length} 个不该进包的测试文件（items：${stray.slice(0, 3).map((f) => f.path).join(', ')}…）—— 检查 files 字段`);
  } else if (tests.length > 0) {
    log(`    （tests/ 只有 ${tests.length} 个文件：冒烟入口 + 它要的假 Agent，这是故意留的）`);
  }
} catch (err) {
  bad('npm pack 失败');
  console.log(String(err.stdout || err.message || '').slice(-1500));
  process.exit(1);
}

// ── 5. 发布 ────────────────────────────────────────────────────────────────

log('\n[5/5] 发布');
const token = process.env.NPM_TOKEN || '';
if (!shouldPublish) {
  log('\n干跑结束。真发的时候执行：');
  log(`  $env:NPM_TOKEN = 'npm_你的令牌'`);
  log(`  node tools/publish-npm.mjs --publish`);
  log('\n发完上架 DSH 市场（一行，市场会自动校验）：');
  log(`  dsh plugin add ${pkg.name}`);
  process.exit(0);
}
if (!token) {
  bad('没有 NPM_TOKEN 环境变量，发不了');
  process.exit(1);
}
// npm 认 `--//registry.npmjs.org/:_authToken=xxx`；直接拼参数最稳
const publishArgs = ['publish', '--access', 'public', ...(otp ? ['--otp', otp] : []), `--//registry.npmjs.org/:_authToken=${token}`];
try {
  const out = npm(publishArgs, { stdio: 'inherit' });
  if (out) console.log(out);
  ok(`已发布 ${pkg.name}@${pkg.version}`);
  log('\n接下来（都很快）：');
  log(`  1) 自测：dsh plugin add ${pkg.name}`);
  log('  2) 上架市场：给 awesome-dsh-plugin 提 PR（内部市场文案里有现成稿）');
  log('  3) 通知用户：README 顶部换成 npm 版本徽章 + 一句"一行装好"');
} catch (err) {
  bad('发布失败');
  console.log(String(err.stdout || err.message || '').slice(-2000));
  if (/EOTP/.test(String(err.stdout || err.message))) log('\n需要一次性验证码：加 --otp 123456 再跑一次');
  if (/E401|EAUTH/.test(String(err.stdout || err.message))) log('\n令牌不对或没权限：重新生成 Granular Token，勾 Read and Publish');
  process.exit(1);
}
