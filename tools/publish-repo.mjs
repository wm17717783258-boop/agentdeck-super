#!/usr/bin/env node
/**
 * tools/publish-repo.mjs — 把「开源的那部分」推到 GitHub（不需要本机装 git）
 *
 * 为什么要有这个脚本：这台机器上没装 git / gh，而公开仓库又必须真的存在
 * （package.json 的 repository、市场条目、README 徽章都指向它）。
 * 所以这里直接用 GitHub 的 Git Data API 一次性建树 + 提交，等价于
 * `git init && git add -A && git commit && git push`，但不依赖任何本地 git。
 *
 * 用法：
 *   node tools/publish-repo.mjs                          # 干跑：只打印会传哪些文件、跳过哪些
 *   node tools/publish-repo.mjs --push                   # 真建仓库并推（要 GITHUB_TOKEN）
 *   node tools/publish-repo.mjs --push --repo agentdeck-super --private false
 *   node tools/publish-repo.mjs --push --no-create --public  # 顺手把仓库转公开（不可逆）
 *
 * 令牌从哪来（二选一）：
 *   A. 经典令牌：GitHub → Settings → Developer settings → Personal access tokens (classic)
 *      → Generate new token → 勾 `repo`（能建仓库 + 推送）→ $env:GITHUB_TOKEN = 'ghp_xxx'
 *   B. 细粒度令牌：先手动在网页建一个空仓库，再建令牌（Repository access 选该仓库，
 *      Permissions → Contents: Read and write）→ $env:GITHUB_TOKEN = 'github_pat_xxx'
 *      这时加 --no-create 跳过建仓库这一步。
 *
 * 只发开源部分：`.gitignore` 里的东西（node_modules / *.tgz / .agentdeck / tmp …）
 * 以及任何看起来像密钥的文件一律不发；发之前会把清单打出来让人过一眼。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, def = false) => (args.includes(name) ? true : def);
const opt = (name, def = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const push = flag('--push');
const noCreate = flag('--no-create');
const makePublic = flag('--public');
const repoName = opt('--repo', 'agentdeck-super');
const isPrivate = opt('--private', 'false') === 'true';
const branch = opt('--branch', 'main');
const tokenFile = join(root, '.secrets', 'gh.token');
const token =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');

const log = (s = '') => console.log(s);
const ok = (s) => console.log(`  ✓ ${s}`);
const warn = (s) => console.log(`  ! ${s}`);
const bad = (s) => {
  console.error(`  ✗ ${s}`);
  process.exit(1);
};

/** 永远不发的东西（除了 .gitignore，再补几类明显不该公开的） */
const HARD_SKIP = [
  '.git', 'node_modules', 'tmp', '.secrets', '.agentdeck', '.agentdeck-issuer', '.relay-data',
  '.env', '.env.local', '.DS_Store', 'Thumbs.db', 'desktop.ini',
  // 内部资料：定价、变现、竞品、发布操作手册 —— 开源仓库里不发（npm 包也不带）
  'internal', 'coverage', '.nyc_output',
];

/** 兜底的敏感文件名后缀：就算不小心放进来也不发 */
const SECRET_PATTERNS = [
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /secret/i, /credential/i, /^\.npmrc$/i, /^\.git-credentials$/i,
];

/** 读 .gitignore，取其字面量规则（够用即可：本仓库只用了目录名/后缀/单文件名） */
function readIgnore(rootDir) {
  const rules = [];
  let raw = '';
  try {
    raw = readFileSync(join(rootDir, '.gitignore'), 'utf8');
  } catch {
    return rules;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    rules.push(t.replace(/\/$/, ''));
  }
  return rules;
}

/** 判断某个相对路径是否被忽略（目录名、后缀、文件名三种规则都支持） */
export function isIgnored(relPath, rules) {
  const parts = relPath.split('/');
  for (const r of rules) {
    if (r.startsWith('*.')) {
      if (relPath.endsWith(r.slice(1))) return true;
      continue;
    }
    if (parts.includes(r)) return true;
  }
  return false;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (HARD_SKIP.includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

const rules = readIgnore(root);
const all = walk(root);
const skipped = [];
const files = [];
for (const full of all) {
  const rel = relative(root, full).split(sep).join('/');
  if (isIgnored(rel, rules)) {
    skipped.push(rel);
    continue;
  }
  if (SECRET_PATTERNS.some((re) => re.test(rel))) {
    skipped.push(`${rel}（疑似密钥）`);
    continue;
  }
  files.push({ rel, full });
}
files.sort((a, b) => a.rel.localeCompare(b.rel));

log(`\n[1/3] 清理仓库根：${root}`);
log(`  会公开的文件：${files.length} 个`);
for (const f of files) log(`    + ${f.rel}`);
if (skipped.length) {
  log(`  已跳过：${skipped.length} 个（.gitignore / 疑似密钥）`);
  for (const s of skipped.slice(0, 40)) log(`    - ${s}`);
  if (skipped.length > 40) log(`    … 另有 ${skipped.length - 40} 个`);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const desc = `DSH plugin · super agent + any-agent team + cross-machine rooms (${pkg.name}@${pkg.version})`;

log('\n[2/3] 仓库信息');
log(`  名字：${repoName}`);
log(`  可见性：${isPrivate ? '私有' : '公开'}`);
log(`  默认分支：${branch}`);
log(`  描述：${desc}`);
log(`  令牌：${token ? `已提供（${token.slice(0, 4)}…${token.slice(-4)}，${token.length} 字符）` : '未提供'}`);

if (!push) {
  log('\n[3/3] 干跑结束，什么都没发。');
  log('  真推的时候：');
  log(`    $env:GITHUB_TOKEN = 'ghp_你的令牌'`);
  log(`    node tools/publish-repo.mjs --push --repo ${repoName}`);
  log('  已经有空仓库（不想让脚本建仓库）就加 --no-create。');
  process.exit(0);
}

if (!token) bad('没有 GITHUB_TOKEN / GH_TOKEN，推不了（干跑不用令牌）');

const API = 'https://api.github.com';
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agentdeck-super-publish-repo',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

log('\n[3/3] 推送');

// 3.1 我是谁
const me = await api('GET', '/user');
if (me.status !== 200) {
  bad(`令牌无效或没权限（HTTP ${me.status}）：${JSON.stringify(me.json).slice(0, 300)}`);
}
const owner = me.json && me.json.login;
if (!owner) bad('读不到 GitHub 用户名');
ok(`令牌属于 ${owner}`);

// 3.2 建仓库（已存在就复用，不覆盖）
let exists = false;
if (noCreate) {
  const probe = await api('GET', `/repos/${owner}/${repoName}`);
  exists = probe.status === 200;
  if (!exists) bad(`--no-create 但 ${owner}/${repoName} 不存在（HTTP ${probe.status}）`);
  ok(`复用已有仓库 ${owner}/${repoName}`);
} else {
  const created = await api('POST', '/user/repos', {
    name: repoName,
    description: desc,
    private: isPrivate,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  });
  if (created.status === 201) {
    ok(`新建仓库 https://github.com/${owner}/${repoName}`);
  } else if (created.status === 422) {
    exists = true;
    warn(`仓库已存在，改为更新它：${owner}/${repoName}`);
  } else {
    bad(`建仓库失败（HTTP ${created.status}）：${JSON.stringify(created.json).slice(0, 300)}`);
  }
}

// 3.3 已经是同一个仓库就拿到它的 HEAD 作为父提交（让历史连续，不 force push）
let parents = [];
let baseTree = null;
let isEmpty = false;
if (exists) {
  const ref = await api('GET', `/repos/${owner}/${repoName}/git/ref/heads/${branch}`);
  if (ref.status === 200) {
    const commitSha = ref.json.object.sha;
    parents = [commitSha];
    const commit = await api('GET', `/repos/${owner}/${repoName}/git/commits/${commitSha}`);
    baseTree = (commit.json && commit.json.tree && commit.json.tree.sha) || null;
    ok(`已有历史：HEAD ${commitSha.slice(0, 7)}`);
  } else {
    isEmpty = true;
    warn('仓库是空的（没有任何分支）');
  }
}

// 3.3b 空仓库不允许直接建树（GitHub 会回 409 "Git Repository is empty"），
// 先用 Contents API 落一个占位提交把分支生出来，再在上面建我们的树。
if (isEmpty) {
  const probe = await api('GET', `/repos/${owner}/${repoName}`);
  const defaultBranch = (probe.json && probe.json.default_branch) || branch;
  const boot = await api('PUT', `/repos/${owner}/${repoName}/contents/.bootstrap`, {
    message: 'chore: bootstrap repository',
    content: Buffer.from(`bootstrap for ${pkg.name}@${pkg.version}\n`).toString('base64'),
  });
  if (boot.status !== 201 && boot.status !== 200) {
    bad(`初始化空仓库失败（HTTP ${boot.status}）：${JSON.stringify(boot.json).slice(0, 300)}`);
  }
  const bootSha = boot.json.commit.sha;
  parents = [bootSha];
  const bootCommit = await api('GET', `/repos/${owner}/${repoName}/git/commits/${bootSha}`);
  baseTree = (bootCommit.json && bootCommit.json.tree && bootCommit.json.tree.sha) || null;
  if (defaultBranch !== branch) {
    warn(`默认分支是 ${defaultBranch}，提交推到它上面（不是 ${branch}）`);
    branch = defaultBranch;
  }
  ok(`已初始化仓库（占位提交 ${bootSha.slice(0, 7)}，随后会被这次提交覆盖历史内容）`);
}

// 3.3c base_tree 是「合并」语义：远端有、本地没有的文件不会自动消失，必须显式写
// sha:null 才删得掉。不加这一步，早就挪进 internal/ 的商业文档会永远躺在公开仓库里。
const removed = [];
if (baseTree) {
  const listing = await api('GET', `/repos/${owner}/${repoName}/git/trees/${baseTree}?recursive=1`);
  const remotePaths = ((listing.json && listing.json.tree) || [])
    .filter((e) => e.type === 'blob' || e.type === 'commit')
    .map((e) => e.path);
  const localPaths = new Set(files.map((f) => f.rel));
  for (const p of remotePaths) if (!localPaths.has(p)) removed.push(p);
  if (removed.length) {
    warn(`远端有 ${removed.length} 个文件本地已经没有，这次一并删掉：`);
    for (const p of removed.slice(0, 30)) log(`    - ${p}`);
    if (removed.length > 30) log(`    … 另有 ${removed.length - 30} 个`);
  }
}

// 3.4 一次建树（inline content，不用逐个 blob 往返）
const tree = files.map((f) => ({
  path: f.rel,
  mode: '100644',
  type: 'blob',
  content: readFileSync(f.full, 'utf8'),
}));
for (const p of removed) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
const treeRes = await api('POST', `/repos/${owner}/${repoName}/git/trees`, {
  ...(baseTree ? { base_tree: baseTree } : {}),
  tree,
});
if (treeRes.status !== 201) {
  bad(`建树失败（HTTP ${treeRes.status}）：${JSON.stringify(treeRes.json).slice(0, 300)}`);
}
ok(`树已建好（${files.length} 个文件）`);

const msg = `chore: publish open-source part (${pkg.name}@${pkg.version}, ${files.length} files)\n\n由 tools/publish-repo.mjs 通过 GitHub Git Data API 直接提交（本机无 git）。`;
const commitRes = await api('POST', `/repos/${owner}/${repoName}/git/commits`, {
  message: msg,
  tree: treeRes.json.sha,
  parents,
});
if (commitRes.status !== 201) {
  bad(`提交失败（HTTP ${commitRes.status}）：${JSON.stringify(commitRes.json).slice(0, 300)}`);
}
const newCommit = commitRes.json.sha;
ok(`提交 ${newCommit.slice(0, 7)}`);

const refRes = await api(
  parents.length ? 'PATCH' : 'POST',
  parents.length
    ? `/repos/${owner}/${repoName}/git/refs/heads/${branch}`
    : `/repos/${owner}/${repoName}/git/refs`,
  parents.length
    ? { sha: newCommit, force: false }
    : { ref: `refs/heads/${branch}`, sha: newCommit },
);
if (refRes.status !== 200 && refRes.status !== 201) {
  bad(`更新分支失败（HTTP ${refRes.status}）：${JSON.stringify(refRes.json).slice(0, 300)}`);
}
ok(`分支 ${branch} → ${newCommit.slice(0, 7)}`);

// 3.6 可见性 / 描述：只在明确要求时才改（转公开不可逆，绝不能顺手做）
if (makePublic) {
  const patch = await api('PATCH', `/repos/${owner}/${repoName}`, { private: false, description: desc });
  if (patch.status === 200) {
    ok(`仓库已设为公开：${patch.json.html_url}`);
  } else {
    warn(`改可见性失败（HTTP ${patch.status}）：${JSON.stringify(patch.json).slice(0, 200)}`);
  }
} else {
  warn('可见性没动（要转公开加 --public；这步不可逆，所以不默认做）');
}

log(`\n仓库地址：https://github.com/${owner}/${repoName}`);
log('下一步（把地址写进 package.json / 市场条目）：');
log(`  node tools/set-repo.mjs https://github.com/${owner}/${repoName}`);
