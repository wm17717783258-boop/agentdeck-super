/**
 * lib/installer.js —— 固定目录安装、原子更新、稳定启动器。
 *
 * 设计目标：
 *   · 用户只记一条命令：node install.mjs / npx ... setup
 *   · 宿主配置永远指向 <NexiHome>/bin/nexi.mjs，不随版本目录变化
 *   · 新版本先解到 staging，校验通过后才切 current.json
 *   · 旧版本保留，更新失败不影响已经能跑的版本
 *   · 卸载/更新失败时给出真实路径和下一步，不假装成功
 *
 * 目录（Windows 默认 %LOCALAPPDATA%\Nexi）：
 *   current.json                 当前版本指针
 *   versions/<version>-<hash>/   每个完整版本
 *   bin/nexi.mjs                 稳定启动器（宿主配置只认这个）
 *   history.json                 最近几次切换记录，方便回滚
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTgz } from './untar.js';
import { detectHosts, installHost, resolveNodeCommand } from './connect/hosts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..');
export const PACKAGE_NAME = 'agentdeck-super';
export const CURRENT_FILE = 'current.json';
export const HISTORY_FILE = 'history.json';
export const LAUNCHER_REL = join('bin', 'nexi.mjs');
const MAX_HISTORY = 20;

function env(name) {
  return String(process.env[name] || '').trim();
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
}

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomId()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, file);
  } catch {
    // Windows 上目标文件偶尔被编辑器/杀软短暂占用，退一步先删再重命名。
    try { rmSync(file, { force: true }); } catch { /* 交给 rename 报真实错误 */ }
    renameSync(tmp, file);
  }
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(file) {
  return sha256Buffer(readFileSync(file));
}

/**
 * 安装根目录。显式 --home 永远优先；其次是 NEXI_HOME；最后按系统给默认值。
 * 不把数据目录写进安装目录，升级不影响工作区/任务板/桌宠档案。
 */
export function defaultHome() {
  if (env('NEXI_HOME')) return resolve(env('NEXI_HOME'));
  // 稳定启动器会把自己的安装根写进 NEXI_INSTALL_HOME。自定义 --home 安装后，
  // version/update/rollback 必须继续认这个根，不能掉回系统默认目录。
  if (env('NEXI_INSTALL_HOME')) return resolve(env('NEXI_INSTALL_HOME'));
  if (process.platform === 'win32') {
    return join(env('LOCALAPPDATA') || join(homedir(), 'AppData', 'Local'), 'Nexi');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Nexi');
  }
  return join(env('XDG_DATA_HOME') || join(homedir(), '.local', 'share'), 'nexi');
}

/**
 * 说明：node 可执行文件的挑选逻辑（scoreNode / resolveNodeCommand）统一放在
 * lib/connect/hosts.js —— 那里是"写宿主配置"的最底层，`nexi install`、
 * `nexi doctor`、`nexi setup` 三条路都经过它，不会出现两处实现慢慢分叉。
 * 从 hosts.js 重新导出，保持老调用方（本文件的 stableLaunch）无需改动。
 */
export { resolveNodeCommand };

export function launcherPath(home = defaultHome()) {
  return join(home, LAUNCHER_REL);
}

export function currentMeta(home = defaultHome()) {
  return readJson(join(home, CURRENT_FILE), null);
}

export function stableLaunch(home = defaultHome()) {
  const node = resolveNodeCommand();
  const note = node.source === 'execPath'
    ? `Nexi 稳定启动器（${launcherPath(home)}）；升级只切 current.json。`
      + `注意：这里用的是当前解释器 ${node.command}——若它随宿主升级消失，`
      + `请把 command 改成 shell 里 "node" 的绝对路径，或设 NEXI_NODE 后重装。`
    : `Nexi 稳定启动器（${launcherPath(home)}）；node 来自 ${
      node.source === 'env' ? 'NEXI_NODE' : node.source === 'bare' ? 'PATH（裸命令）' : 'PATH'}`
      + `（${node.command}），升级只切 current.json。`;
  return {
    command: node.command,
    args: [launcherPath(home), 'mcp'],
    env: {},
    note,
    // 诊断用：不进宿主配置，只给 doctor / 证据文件看
    _node: { source: node.source, score: node.score, considered: node.considered },
  };
}

export function stableCliPath(home = defaultHome()) {
  return launcherPath(home);
}

function packageJson(root) {
  return readJson(join(root, 'package.json'), null);
}

function validatePackage(root, { expectName = PACKAGE_NAME } = {}) {
  const pkg = packageJson(root);
  if (!pkg) return { ok: false, reason: `不是 npm 包目录：缺少可读的 package.json（${root}）` };
  if (expectName && pkg.name !== expectName) {
    return { ok: false, reason: `包名不对：需要 ${expectName}，实际 ${pkg.name || '（空）'}` };
  }
  if (!String(pkg.version || '').trim()) return { ok: false, reason: 'package.json 缺少 version' };
  for (const rel of ['bin/nexi.mjs', 'lib/hub.js', 'lib/mcp/server.js', 'lib/version.js']) {
    if (!existsSync(join(root, rel))) return { ok: false, reason: `包缺关键文件：${rel}` };
  }
  return { ok: true, pkg };
}

function shouldSkip(rel) {
  const first = String(rel).split(/[\\/]/)[0];
  if ([
    'node_modules', '.git', '.tools', '.nexi-pair', '.agentdeck', 'work', 'outputs',
    '.env', '.npmrc', '.git-credentials', '.netrc',
  ].includes(first)) return true;
  if (/^(secret|credential)/i.test(first)) return true;
  if (/^verify-/.test(first) || /^\.tmp-/.test(first) || /^\.cache/.test(first)) return true;
  return false;
}

function copyPackage(sourceRoot, destRoot) {
  if (!existsSync(sourceRoot)) throw new Error(`源目录不存在：${sourceRoot}`);
  mkdirSync(destRoot, { recursive: true });
  for (const name of readdirSync(sourceRoot)) {
    if (shouldSkip(name)) continue;
    if (/\.tgz$|\.tar\.gz$|\.zip$/i.test(name)) continue;
    const src = join(sourceRoot, name);
    const dst = join(destRoot, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      cpSync(src, dst, {
        recursive: true,
        dereference: true,
        filter: (p) => {
          const rel = relative(sourceRoot, p);
          return rel === '' || !shouldSkip(rel);
        },
      });
    } else if (st.isFile()) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}

/** 给目录算一个稳定指纹；用于同一版本重复安装时复用目录，也用于回滚记录。 */
export function fingerprintDir(root) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).replace(/\\/g, '/');
      if (shouldSkip(rel)) continue;
      if (/\.tgz$|\.tar\.gz$|\.zip$/i.test(name) && dirname(rel) === '.') continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        hash.update(`D:${rel}\0`);
        walk(full);
      } else if (st.isFile()) {
        hash.update(`F:${rel}\0${st.size}\0`);
        hash.update(readFileSync(full));
        hash.update('\0');
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

function writeLauncher(home) {
  const file = launcherPath(home);
  mkdirSync(dirname(file), { recursive: true });
  const text = `#!/usr/bin/env node
/**
 * Nexi 稳定启动器。宿主配置只指向这个文件；升级时 current.json 原子切换。
 * 这个文件不随版本删除，所以宿主不需要在每次更新后重新配置路径。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const home = dirname(here);
const metaFile = join(home, 'current.json');
let meta;
try {
  meta = JSON.parse(readFileSync(metaFile, 'utf8'));
} catch (err) {
  process.stderr.write(\`Nexi 安装目录坏掉了：读不到 \${metaFile}（\${err.message}）。\\n\`);
  process.exit(1);
}
if (!meta || !meta.dir) {
  process.stderr.write(\`Nexi 安装目录缺少 current.json.dir：\${metaFile}\\n\`);
  process.exit(1);
}
const target = join(home, meta.dir, 'bin', 'nexi.mjs');
process.env.NEXI_INSTALL_HOME = home;
await import(pathToFileURL(target).href);
`;
  writeFileSync(file, text, 'utf8');
}

function historyPush(home, entry) {
  const file = join(home, HISTORY_FILE);
  const doc = readJson(file, { entries: [] });
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  entries.unshift(entry);
  writeJsonAtomic(file, { entries: entries.slice(0, MAX_HISTORY) });
}

function removeStaleStaging(home) {
  const dir = join(home, '.staging');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    try {
      const full = join(dir, name);
      if (Date.now() - statSync(full).mtimeMs > 6 * 60 * 60 * 1000) rmSync(full, { recursive: true, force: true });
    } catch {
      // 清理失败不影响这次安装；下一次再来。
    }
  }
}

async function downloadTo(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return { sha256: sha256Buffer(buf), bytes: buf.length };
}

function normalizeSha(value) {
  const s = String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(s) ? s : '';
}

function siblingExpectedSha(bundleFile) {
  try {
    const sums = join(dirname(bundleFile), 'SHA256SUMS.txt');
    if (!existsSync(sums)) return '';
    const name = basename(bundleFile);
    for (const line of readFileSync(sums, 'utf8').split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
      if (m && m[2].trim() === name) return m[1].toLowerCase();
    }
  } catch {
    // 校验文件坏了就当没提供，不能因为旁路文件阻断安装。
  }
  return '';
}

async function materializeBundle(bundle, workDir, { sha256 = '' } = {}) {
  let file = String(bundle || '').trim();
  let downloaded = false;
  if (!file) throw new Error('没有给 --bundle');
  if (/^https?:\/\//i.test(file)) {
    const target = join(workDir, `bundle-${randomId()}.tgz`);
    const dl = await downloadTo(file, target);
    file = target;
    downloaded = true;
  } else {
    file = resolve(file);
  }
  if (!existsSync(file)) throw new Error(`安装包不存在：${file}`);
  const actual = sha256File(file);
  const expected = normalizeSha(sha256) || siblingExpectedSha(file);
  if (expected && expected !== actual) {
    throw new Error(`安装包 SHA256 不匹配：期望 ${expected}，实际 ${actual}`);
  }
  const extractDir = join(workDir, `extract-${randomId()}`);
  const un = extractTgz(file, extractDir, { readFile: readFileSync });
  if (!un.ok) throw new Error(un.reason || '解包失败');
  const candidates = [
    join(extractDir, 'package'),
    extractDir,
  ];
  const root = candidates.find((p) => existsSync(join(p, 'package.json')));
  if (!root) throw new Error('安装包里找不到 package.json（npm pack 结构应为 package/）');
  return { root, file, sha256: actual, downloaded, extracted: extractDir };
}

/**
 * 把当前包（或 bundle）安装到固定目录。
 * @param {object} opts
 * @param {string} [opts.sourceRoot] 本地包目录；默认当前包根目录
 * @param {string} [opts.bundle] .tgz 路径或 URL
 * @param {string} [opts.home] 固定安装根目录
 * @param {string} [opts.sha256] 安装包 SHA256
 * @param {boolean} [opts.dryRun]
 * @param {boolean|string[]} [opts.hosts] false/'none' 不写宿主；数组只写指定宿主；其它写全部已探测宿主
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.keepLauncher]
 */
export async function setup(opts = {}) {
  const home = resolve(opts.home || defaultHome());
  const dryRun = opts.dryRun === true;
  const work = join(home, '.staging', randomId());
  let staged = '';
  let bundleInfo = null;
  let root = '';
  try {
    if (opts.bundle) {
      bundleInfo = await materializeBundle(opts.bundle, work, { sha256: opts.sha256 });
      root = bundleInfo.root;
    } else {
      root = resolve(opts.sourceRoot || PACKAGE_ROOT);
    }

    const valid = validatePackage(root, { expectName: opts.expectName || PACKAGE_NAME });
    if (!valid.ok) throw new Error(valid.reason);
    const pkg = valid.pkg;
    const fingerprint = fingerprintDir(root);
    // 统一存 POSIX 风格；Windows 的 path.join 也接受正斜杠，跨平台回滚时更稳。
    const dirName = `versions/${safeName(pkg.version)}-${fingerprint.slice(0, 12)}`;
    const finalRoot = join(home, dirName);
    const plan = {
      home,
      version: String(pkg.version),
      dir: dirName,
      packageRoot: finalRoot,
      fingerprint,
      bundle: bundleInfo ? { file: bundleInfo.file, sha256: bundleInfo.sha256, downloaded: bundleInfo.downloaded } : null,
      reused: existsSync(finalRoot),
      dryRun,
    };
    if (dryRun) return { ok: true, ...plan, hosts: [] };

    mkdirSync(work, { recursive: true });
    mkdirSync(join(home, 'bin'), { recursive: true });
    mkdirSync(join(home, 'versions'), { recursive: true });
    removeStaleStaging(home);

    if (!existsSync(finalRoot)) {
      staged = join(work, 'package');
      if (opts.bundle) {
        // materializeBundle 已经把 tgz 解到 work/extract-*；直接搬过去，
        // 不再复制一遍，既省时间也避免二次路径漂移。
        copyPackage(root, staged);
      } else {
        copyPackage(root, staged);
      }
      const check = validatePackage(staged, { expectName: opts.expectName || PACKAGE_NAME });
      if (!check.ok) throw new Error(`暂存目录校验失败：${check.reason}`);
      renameSync(staged, finalRoot);
      staged = '';
    }

    const previous = currentMeta(home);
    const meta = {
      v: 1,
      name: PACKAGE_NAME,
      version: plan.version,
      dir: dirName,
      fingerprint,
      installedAt: nowIso(),
      source: opts.bundle ? 'bundle' : 'source',
      bundleSha256: bundleInfo?.sha256 || undefined,
    };
    writeLauncher(home);
    writeJsonAtomic(join(home, CURRENT_FILE), meta);
    historyPush(home, {
      at: meta.installedAt,
      version: meta.version,
      dir: meta.dir,
      previous: previous?.version || null,
      action: opts.action || 'setup',
    });

    const hostResults = await installHostsForHome(home, {
      hosts: opts.hosts,
      force: opts.force !== false,
      dryRun: false,
    });
    const failures = hostResults.filter((r) => !r.ok && r.reason !== 'host-not-installed' && r.reason !== 'not-selected');
    return {
      ok: failures.length === 0,
      ...plan,
      packageRoot: finalRoot,
      current: meta,
      hosts: hostResults,
      failures,
    };
  } finally {
    try { if (staged && existsSync(staged)) rmSync(staged, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主错误 */ }
    try { if (existsSync(work)) rmSync(work, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}

/**
 * 写宿主配置。统一用稳定启动器，不把版本目录写进任何宿主配置。
 * hosts 可以是 false / 'none' / 字符串数组；不传 = 所有已探测且 installed 的宿主。
 */
export async function installHostsForHome(home, opts = {}) {
  if (opts.hosts === false || opts.hosts === 'none') return [];
  const detected = detectHosts();
  let ids;
  if (Array.isArray(opts.hosts)) ids = opts.hosts;
  else ids = detected.filter((h) => h.installed).map((h) => h.id);
  const launch = stableLaunch(home);
  const out = [];
  for (const id of ids) {
    const host = detected.find((h) => h.id === id);
    if (!host) {
      out.push({ id, ok: false, reason: 'unknown-host', skipped: true });
      continue;
    }
    if (!host.installed) {
      out.push({ id, label: host.label, ok: false, reason: 'host-not-installed', path: host.path, skipped: true });
      continue;
    }
    const r = installHost(id, { launch, force: opts.force !== false, dryRun: opts.dryRun === true });
    out.push({ id, label: host.label, ...r, skipped: false });
  }
  return out;
}

/**
 * 从 npm 拉最新版并安装。npm 404 时明确告诉用户“还没上架”，不拿当前源码冒充最新版。
 */
export async function updateFromNpm(opts = {}) {
  const name = opts.packageName || PACKAGE_NAME;
  const base = (opts.registry || 'https://registry.npmjs.org').replace(/\/$/, '');
  const res = await fetch(`${base}/${encodeURIComponent(name)}/latest`, { redirect: 'follow' });
  if (res.status === 404) {
    throw new Error(`npm 上还没有 ${name}（404）。还没上架时请用：nexi update --bundle <tgz 或 URL>`);
  }
  if (!res.ok) throw new Error(`npm 查询失败 HTTP ${res.status}`);
  const info = await res.json();
  const tarball = info?.dist?.tarball;
  if (!tarball) throw new Error('npm 返回里没有 dist.tarball');
  const home = resolve(opts.home || defaultHome());
  const work = join(home, '.staging', randomId());
  try {
    const file = join(work, `${name}-${safeName(info.version)}.tgz`);
    const dl = await downloadTo(tarball, file);
    const integrity = String(info?.dist?.integrity || '');
    if (integrity.startsWith('sha512-')) {
      const actual = `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
      if (actual !== integrity) throw new Error('npm tarball integrity 校验失败');
    }
    return await setup({
      ...opts,
      home,
      bundle: file,
      sha256: dl.sha256,
      action: 'update',
      expectedVersion: info.version,
    });
  } finally {
    try { if (existsSync(work)) rmSync(work, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}

/** 回滚到上一个版本（只切指针，不动宿主配置；宿主配置本来就是稳定启动器）。 */
export function rollback(home = defaultHome(), opts = {}) {
  const root = resolve(home);
  const doc = readJson(join(root, HISTORY_FILE), { entries: [] });
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const current = currentMeta(root);
  const target = entries.find((e) => e && e.dir && e.dir !== current?.dir)
    || entries.find((e) => e && e.dir);
  if (!target || !existsSync(join(root, target.dir, 'package.json'))) {
    return { ok: false, reason: '没有可回滚的上一版本', home: root };
  }
  const meta = {
    v: 1,
    name: PACKAGE_NAME,
    version: target.version,
    dir: target.dir,
    fingerprint: target.fingerprint || '',
    installedAt: nowIso(),
    source: 'rollback',
  };
  if (opts.dryRun) return { ok: true, dryRun: true, current: meta };
  writeLauncher(root);
  writeJsonAtomic(join(root, CURRENT_FILE), meta);
  historyPush(root, { at: meta.installedAt, version: meta.version, dir: meta.dir, previous: current?.version || null, action: 'rollback' });
  return { ok: true, current: meta, hostLaunch: stableLaunch(root) };
}

export default {
  PACKAGE_NAME,
  PACKAGE_ROOT,
  CURRENT_FILE,
  HISTORY_FILE,
  defaultHome,
  launcherPath,
  currentMeta,
  stableLaunch,
  resolveNodeCommand,
  stableCliPath,
  fingerprintDir,
  setup,
  installHostsForHome,
  updateFromNpm,
  rollback,
  sha256File,
};
