// SPDX-License-Identifier: Apache-2.0
// 8 个宿主的适配定义，按 LICENSING.md 用 Apache-2.0：宿主厂商零成本接进来。
/**
 * 宿主接入（Nexi Connect）：探测 8 个常见 Agent 宿主，把 `nexi mcp` 注册进去。
 *
 * 硬要求（写进 docs/NEXI-FINAL-PLAN.md 第 5 节）：
 *   - 先探测再动手，没装就报告"未安装"，绝不新建一个假配置骗自己。
 *   - 动手前先备份（*.nexi-backup-<时间戳>），合并而不是覆盖用户已有的 mcpServers。
 *   - 幂等：重复安装只更新自己那一项；卸载精确回滚，不留垃圾。
 *   - --dry-run 只打印差异，不落盘。
 *
 * 配置格式分两类：
 *   json  —— { "mcpServers": { "nexi": { command, args, env } } }
 *   toml  —— Codex 的 config.toml，用带哨兵注释的块写入（[mcp_servers.nexi]）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（lib/connect → ../..） */
export const REPO_ROOT = resolve(HERE, '..', '..');
export const NEXI_ENTRY = join(REPO_ROOT, 'bin', 'nexi.mjs');

const SENTINEL_START = '# >>> nexi (managed by nexi install, 删这段即完全移除) >>>';
const SENTINEL_END = '# <<< nexi <<<';

function envPath(name, fallback) {
  const v = process.env[name];
  return v ? v : fallback;
}

/**
 * 宿主清单。paths() 返回该宿主可能存在的候选路径（多版本/多厂商时都给）。
 * tier：A = MCP stdio 正式支持；B = 需要 HTTP；exp = 实验性（格式还没稳定）。
 */
export const HOSTS = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    tier: 'A',
    kind: 'json',
    docs: 'https://modelcontextprotocol.io/',
    paths: () => [
      join(envPath('APPDATA', join(homedir(), 'AppData', 'Roaming')), 'Claude', 'claude_desktop_config.json'),
    ],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    tier: 'A',
    kind: 'json',
    paths: () => [join(homedir(), '.claude.json')],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    tier: 'A',
    kind: 'json',
    paths: () => [join(homedir(), '.cursor', 'mcp.json')],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    tier: 'A',
    kind: 'json',
    paths: () => [join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')],
  },
  {
    id: 'codex',
    label: 'Codex',
    tier: 'A',
    kind: 'toml',
    paths: () => [join(homedir(), '.codex', 'config.toml')],
  },
  {
    id: 'cline',
    label: 'Cline (VS Code)',
    tier: 'A',
    kind: 'json',
    paths: () => [
      join(envPath('APPDATA', join(homedir(), 'AppData', 'Roaming')), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    ],
  },
  {
    id: 'continue',
    label: 'Continue',
    tier: 'exp',
    kind: 'json',
    paths: () => [join(homedir(), '.continue', 'config.json')],
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    tier: 'A',
    kind: 'json',
    paths: () => [join(homedir(), '.gemini', 'settings.json')],
  },
];

export function findHost(id) {
  return HOSTS.find((h) => h.id === id) || null;
}

/**
 * 宿主 CLI 的常见落点（只用来判断"这台机器装没装这个宿主"）。
 *
 * 为什么需要它：有些宿主（比如 Gemini CLI）配置文件是**第一次用才创建**的，
 * 但 CLI 明明已经在 PATH 上。只按"配置文件存不存在"判断，会把装好的宿主
 * 误报成「未安装」——那等于自己少认证一个宿主，还很难被发现。
 *
 * 判断规则（保守，宁可不报）：配置文件在 **或者** CLI 能起来 → 算装了。
 * 真调用那一步仍然由 verify.js 的 probe 去问宿主自己，这里只负责"该不该去问"。
 */
const CLI_CANDIDATES = {
  'claude-code': ['claude'],
  codex: ['codex'],
  'gemini-cli': ['gemini'],
};

/** 在 PATH 上找可执行文件（Windows 还要看 .cmd/.exe/.ps1 垫片）。 */
export function findOnPath(names = []) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((s) => s.toLowerCase())
    : [''];
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      // 先看原样（Linux/macOS 无扩展名），再看 Windows 各扩展名
      const bare = join(dir, name);
      if (existsSync(bare)) return bare;
      for (const ext of exts) {
        if (!ext) continue;
        const withExt = join(dir, `${name}${ext}`);
        if (existsSync(withExt)) return withExt;
      }
    }
  }
  return null;
}

/** 探测：只报事实（配置文件在不在 / CLI 在不在），**不创建任何文件**。 */
export function detectHosts() {
  return HOSTS.map((h) => {
    const candidates = h.paths();
    const hit = candidates.find((p) => existsSync(p)) || null;
    // 配置文件不在时，再看看 CLI 在不在（装好但还没首次运行的宿主）
    const cli = hit ? null : findOnPath(CLI_CANDIDATES[h.id] || []);
    const installed = Boolean(hit || cli);
    return {
      id: h.id,
      label: h.label,
      tier: h.tier,
      kind: h.kind,
      installed,
      path: hit || candidates[0],
      candidates,
      // 给人看的依据：是"配置文件在"还是"只找到 CLI"。别把两者混为一谈。
      detectedBy: hit ? 'config' : (cli ? 'cli' : 'none'),
      cliPath: cli || null,
      configExists: Boolean(hit),
    };
  });
}

/** 本机跑 `nexi mcp` 的启动命令。用绝对路径 + 当前 node，装到别处也能起。 */
export function launchCommand() {
  return { command: process.execPath, args: [NEXI_ENTRY, 'mcp'], env: {} };
}

function entryFor(launch) {
  return { command: launch.command, args: launch.args, env: launch.env || {} };
}

function readJson(file, warnings) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(`${file} 顶层不是对象，拒绝改写`);
      return null;
    }
    return value;
  } catch (err) {
    warnings.push(`${file} 不是合法 JSON（${err.message}），拒绝改写`);
    return null;
  }
}

function backup(file, stamp) {
  const target = `${file}.nexi-backup-${stamp}`;
  copyFileSync(file, target);
  return target;
}

function writeAtomic(file, text) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}.nexi.tmp`);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/** 计算 json 类宿主的「安装后内容」，不落盘。 */
function planJson(host, file, { launch, force }) {
  const warnings = [];
  const data = readJson(file, warnings);
  if (data === null) return { ok: false, warnings };

  const servers = data.mcpServers && typeof data.mcpServers === 'object' ? { ...data.mcpServers } : {};
  const before = servers.nexi ? JSON.stringify(servers.nexi) : null;
  const entry = entryFor(launch);
  const after = JSON.stringify(entry);

  // 已存在但不是我们写的（用户手工配了同名 server）→ 默认不动
  if (before && before !== after && !force) {
    warnings.push('mcpServers.nexi 已存在且不是当前启动命令；加 --force 才会覆盖');
    return { ok: false, warnings, unchanged: false };
  }

  servers.nexi = entry;
  const next = { ...data, mcpServers: servers };
  return {
    ok: true,
    warnings,
    unchanged: before === after,
    text: `${JSON.stringify(next, null, 2)}\n`,
    path: file,
  };
}

/** Codex 的 TOML：用哨兵块包裹，卸载时精确删除。 */
function planToml(file, { launch, force }) {
  const warnings = [];
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const block = [
    SENTINEL_START,
    '[mcp_servers.nexi]',
    `command = ${JSON.stringify(launch.command)}`,
    `args = ${JSON.stringify(launch.args)}`,
    SENTINEL_END,
    '',
  ].join('\n');

  const start = existing.indexOf(SENTINEL_START);
  const end = existing.indexOf(SENTINEL_END);
  const blockText = block.trimEnd();
  let text;
  if (start !== -1 && end !== -1 && end > start) {
    // 重装：重建一份确定性文本（前缀 + 块 + 后缀），保证第二次调用判定为"无变化"
    const prefix = existing.slice(0, start).replace(/\s+$/, '');
    const suffix = existing.slice(end + SENTINEL_END.length).replace(/^\s+/, '').replace(/\s+$/, '');
    const parts = [prefix, blockText, suffix].filter((p) => p !== '');
    text = `${parts.join('\n\n')}\n`;
  } else {
    if (/^\s*\[mcp_servers\.nexi\]\s*$/m.test(existing) && !force) {
      warnings.push('config.toml 已有 [mcp_servers.nexi]（不是 nexi 写的）；加 --force 才追加同名表');
      return { ok: false, warnings };
    }
    const prefix = existing.replace(/\s+$/, '');
    text = `${prefix ? `${prefix}\n\n` : ''}${blockText}\n`;
  }

  return {
    ok: true,
    warnings,
    unchanged: text === existing,
    text,
    path: file,
  };
}

function removeFromJson(file) {
  const warnings = [];
  if (!existsSync(file)) return { ok: true, warnings, changed: false };
  const data = readJson(file, warnings);
  if (data === null) return { ok: false, warnings, changed: false };
  if (!data.mcpServers || !data.mcpServers.nexi) return { ok: true, warnings, changed: false, text: undefined };
  const servers = { ...data.mcpServers };
  delete servers.nexi;
  return { ok: true, warnings, changed: true, text: `${JSON.stringify({ ...data, mcpServers: servers }, null, 2)}\n` };
}

function removeFromToml(file) {
  if (!existsSync(file)) return { ok: true, warnings: [], changed: false };
  const existing = readFileSync(file, 'utf8');
  const start = existing.indexOf(SENTINEL_START);
  const end = existing.indexOf(SENTINEL_END);
  if (start === -1 || end === -1 || end < start) return { ok: true, warnings: [], changed: false };
  const text = (existing.slice(0, start) + existing.slice(end + SENTINEL_END.length)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  return { ok: true, warnings: [], changed: true, text };
}

/**
 * 安装到某个宿主。
 * @param {string} id 宿主 id
 * @param {{dryRun?: boolean, force?: boolean, stamp?: string, launch?: object}} opts
 */
export function installHost(id, opts = {}) {
  const host = findHost(id);
  if (!host) return { ok: false, reason: `不认识宿主：${id}`, known: HOSTS.map((h) => h.id) };
  const launch = opts.launch || launchCommand();
  const detected = detectHosts().find((h) => h.id === id);
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');

  // 没装就报未安装，不创建假配置；但调用方显式给了 --path（高级用法）就按他指的文件来
  if (!opts.path && !detected.installed && !opts.force) {
    return { ok: false, reason: 'host-not-installed', path: detected.path, hint: '宿主未安装；确认路径后可用 --force 指定目标文件' };
  }
  const file = opts.path || detected.path;

  const plan = host.kind === 'toml' ? planToml(file, { launch, force: opts.force }) : planJson(host, file, { launch, force: opts.force });
  if (!plan.ok) return { ok: false, reason: 'config-conflict', warnings: plan.warnings, path: file };
  if (plan.unchanged) return { ok: true, changed: false, path: file, warnings: plan.warnings };

  if (opts.dryRun) {
    return { ok: true, dryRun: true, changed: true, path: file, preview: plan.text, warnings: plan.warnings };
  }

  const backupPath = existsSync(file) ? backup(file, stamp) : null;
  writeAtomic(file, plan.text);
  return { ok: true, changed: true, path: file, backup: backupPath, warnings: plan.warnings };
}

/** 从某个宿主编配置里移除 nexi（精确回滚）。 */
export function uninstallHost(id, opts = {}) {
  const host = findHost(id);
  if (!host) return { ok: false, reason: `不认识宿主：${id}` };
  const detected = detectHosts().find((h) => h.id === id);
  const file = opts.path || detected.path;
  if (!existsSync(file)) return { ok: true, changed: false, path: file };
  const res = host.kind === 'toml' ? removeFromToml(file) : removeFromJson(file);
  if (!res.ok) return { ok: false, reason: 'config-broken', warnings: res.warnings, path: file };
  if (!res.changed) return { ok: true, changed: false, path: file };
  if (opts.dryRun) return { ok: true, dryRun: true, changed: true, path: file, preview: res.text };
  const backupPath = backup(file, opts.stamp || new Date().toISOString().replace(/[:.]/g, '-'));
  writeAtomic(file, res.text);
  return { ok: true, changed: true, path: file, backup: backupPath };
}

/** 一键装到所有「已安装」的宿主（幂等）。 */
export function installAll(opts = {}) {
  const results = [];
  for (const host of detectHosts()) {
    if (!host.installed) {
      results.push({ id: host.id, label: host.label, ok: false, reason: 'host-not-installed', path: host.path });
      continue;
    }
    results.push({ id: host.id, label: host.label, ...installHost(host.id, opts) });
  }
  return results;
}

/** 给测试用：临时目录里造一个假宿主配置 */
export function __tmpConfigPath(name = 'config.json') {
  return join(tmpdir(), `nexi-connect-${process.pid}-${Date.now()}`, name);
}

export default { HOSTS, detectHosts, installHost, uninstallHost, installAll, launchCommand };
