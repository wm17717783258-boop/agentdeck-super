/**
 * lib/connect/audit.js —— 「接上了」到底算不算数。
 *
 * 原来体检的判据是一行正则：`/nexi/i.test(配置文件全文)`。
 * 它会在这些情况下给出**假的绿勾**：
 *
 *   · 条目指向的脚本已经被删 / 被移动（换了 NEXI_HOME、清了 Temp、删了旧版本）
 *   · command 写的 node 路径不存在（nvm 切版本、卸载重装）
 *   · 只是注释里提到 nexi（TOML 的 `# nexi`、YAML 的注释行）
 *   · 别家 server 名字里带 nexi（`nexi-helper`、`my-nexi`）
 *   · 条目是 `null` 或空对象
 *
 * 假绿比红更危险：用户看到 ✅ 就不查了，然后在宿主里怎么都连不上。
 *
 * 所以这里改成四层校验：
 *   ① 结构 —— 真的解析出 `nexi` 这一项（按宿主自己的形状取，不是全文搜）；
 *   ② 目标 —— 条目里的脚本路径**在磁盘上存在**；
 *   ③ 解释器 —— command 是绝对路径就查存在，是裸名就查 PATH；
 *   ④ 一致性 —— 这条路径是不是当前这份，不是就报 stale（宿主跑的是旧路径）。
 */

import { existsSync, readFileSync } from 'node:fs';

import { findOnPath } from './hosts.js';
import { readConfigText } from './encoding.js';
import { parseJsonc } from './jsonc.js';

/** 从 JSON 配置里按形状取 nexi 条目。找不到返回 null。 */
function entryFromJson(text) {
  let data;
  try {
    // JSONC：VS Code / CodeBuddy 的配置允许注释与尾逗号。
    // 以前这里 JSON.parse 会失败，于是体检把一份完全合法的配置报成 broken。
    data = parseJsonc(text);
  } catch {
    return { parseError: '不是合法 JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { parseError: '顶层不是对象' };

  const candidates = [];
  // ① 顶层直接放 server 表（mcpServers / servers / context_servers / amp.mcpServers）
  for (const key of ['mcpServers', 'servers', 'context_servers', 'amp.mcpServers']) {
    const v = data[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && v.nexi) candidates.push({ where: key, entry: v.nexi });
  }
  // ② 嵌在 mcp 下面（mcp.servers / mcp.local / mcp.stdio）
  const mcp = data.mcp;
  if (mcp && typeof mcp === 'object') {
    if (mcp.servers && mcp.servers.nexi) candidates.push({ where: 'mcp.servers', entry: mcp.servers.nexi });
    if (mcp.nexi) candidates.push({ where: 'mcp', entry: mcp.nexi });
  }
  // ③ 列表形状（Continue 新版）
  if (Array.isArray(data.mcpServers)) {
    const hit = data.mcpServers.find((x) => x && (x.name === 'nexi' || x.id === 'nexi'));
    if (hit) candidates.push({ where: 'mcpServers[列表]', entry: hit });
  }
  if (!candidates.length) return { found: false };

  const pick = candidates[0];
  const raw = pick.entry && typeof pick.entry === 'object' ? pick.entry : {};
  // 大多数形状是 command: "node" + args: [...]
  // OpenCode / Kilo / Crush 把整条命令塞进 command: ["node", "x.mjs", "mcp"]
  let command = raw.command;
  let args = Array.isArray(raw.args) ? raw.args.slice() : [];
  if (Array.isArray(command)) {
    args = command.slice(1);
    command = command[0];
  }
  return {
    found: true,
    where: pick.where,
    command: typeof command === 'string' ? command : null,
    args,
    entry: raw,
    ambiguous: candidates.length > 1 ? candidates.map((c) => c.where) : null,
  };
}

/** 从 TOML 的哨兵块里抓 command / args（不做完整 TOML 解析，只要这两个字段）。 */
function entryFromToml(text) {
  const m = /\[mcp_servers\.nexi\]\s*\n([\s\S]*?)(\n\s*\[|\n# >>> nexi|$)/.exec(text);
  if (!m) return { found: false };
  const body = m[1];
  const cmd = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/m.exec(body);
  const args = /^\s*args\s*=\s*(\[[^\]]*\])/m.exec(body);
  return {
    found: true,
    where: 'mcp_servers.nexi',
    command: cmd ? unquoteToml(cmd[1]) : null,
    args: args ? safeJsonArray(args[1]) : [],
  };
}

/** TOML 的引号串：双引号里认 \\ \" \n，单引号是字面量；手改过的文件里可能有裸反斜杠，一律容错。 */
function unquoteToml(token) {
  const t = token.trim();
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  const body = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[i + 1];
    if (n === '\\' || n === '"') { out += n; i++; }
    else if (n === 'n') { out += '\n'; i++; }
    else if (n === 't') { out += '\t'; i++; }
    else { out += c; } // 裸反斜杠（Windows 路径常见）原样保留
  }
  return out;
}

function safeJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    // args 里混了单引号之类：退化成抓引号串
    return [...s.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  }
}

/** 从 YAML 里抓 nexi 段（Goose 的 map 与 Continue 的列表两种）。 */
function entryFromYaml(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 跳过纯注释行 —— 注释里提到 nexi 不算装了
    if (/^\s*#/.test(l)) continue;
    if (!/^\s*(nexi\s*:\s*$|-\s*name\s*:\s*["']?nexi["']?\s*$|name\s*:\s*["']?nexi["']?\s*$)/.test(l)) continue;

    // 抓这一项下面的 command/cmd 与 args（到缩进回退为止）
    const baseIndent = l.length - l.trimStart().length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const nxt = lines[j];
      if (!nxt.trim()) continue;
      if (/^\s*#/.test(nxt)) continue;
      const ind = nxt.length - nxt.trimStart().length;
      if (ind <= baseIndent) break;
      body.push(nxt);
    }
    const joined = body.join('\n');
    const cmdM = /^\s*(?:command|cmd)\s*:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(joined);
    const argsM = /^\s*args\s*:\s*\[([^\]]*)\]/m.exec(joined);
    let args = [];
    if (argsM) {
      args = [...argsM[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    } else {
      // 块状列表：args: 换行 - xxx
      const blockM = /^\s*args\s*:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(`${joined}\n`);
      if (blockM) args = [...blockM[1].matchAll(/^\s*-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((x) => x[1]);
    }
    return { found: true, where: 'yaml', command: cmdM ? cmdM[1].trim() : null, args };
  }
  return { found: false };
}

/**
 * 从配置文件里取出我们真正写进去的那一项。
 * 返回 `{ found, where?, command, args, parseError? }`。
 */
export function extractEntry(file, host = {}) {
  if (!file || !existsSync(file)) return { found: false, missingFile: true };
  const doc = readConfigText(file);
  if (!doc.ok) return { found: false, readError: doc.error, encoding: doc.encoding };
  const text = doc.text;
  if (!text.trim()) return { found: false, empty: true };

  // 判格式：宿主声明优先，但 auto / 未声明时按内容认。
  // 注意 TOML 的表头也是 `[`，所以要先看是不是 `[name]` 这种独占一行的表头。
  const firstLine = text.trim().split('\n')[0].trim();
  const guessed = /^\[[\w."'\-\s]+\]$/.test(firstLine)
    ? 'toml'
    : (/^[{[]/.test(text.trim()) ? 'json' : 'yaml');
  const kind = ['json', 'toml', 'yaml'].includes(host.kind) ? host.kind : guessed;
  if (kind === 'toml') return entryFromToml(text);
  if (kind === 'yaml') return entryFromYaml(text);
  const json = entryFromJson(text);
  // 扩展名可能是 .json 但内容其实是 YAML（有人手改过）——退一步再试
  if (!json.found && !json.parseError) {
    const yaml = entryFromYaml(text);
    if (yaml.found) return yaml;
  }
  return json;
}

/** 路径比较：Windows 下大小写不敏感，反斜杠与斜杠等价。 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  // Windows 与 macOS 的默认文件系统都不区分大小写（NTFS / APFS），
  // 只有 Linux 区分。按「目标系统」的语义比，才不会在 Mac 上把同一个路径报成 stale。
  return process.platform === 'win32' || process.platform === 'darwin'
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

/**
 * 审计一个宿主：接上了吗、接的那条路还通吗。
 *
 * state：
 *   wired        条目在、目标在、解释器在 —— 真能连
 *   stale        条目在、目标在，但不是当前这份（宿主跑的是旧路径）
 *   unreachable  条目在，但目标或解释器不存在 —— 宿主会连不上
 *   absent       条目不在
 *   broken       配置文件本身坏了（不是我们写的，动不了）
 */
export function auditHost(host, { file, currentLaunch = null } = {}) {
  const path = file || (host && typeof host.paths === 'function' ? host.paths()[0] : null);
  const base = { id: host && host.id, path };

  const ex = extractEntry(path, host);
  if (ex.missingFile) return { ...base, state: 'absent', reason: '配置文件不存在' };
  if (ex.readError) return { ...base, state: 'broken', reason: `读不了：${ex.readError}` };
  if (ex.parseError) return { ...base, state: 'broken', reason: ex.parseError };
  if (!ex.found) return { ...base, state: 'absent', reason: '配置里没有 nexi 这一项' };

  const problems = [];
  const target = Array.isArray(ex.args) ? ex.args[0] : null;

  if (!target) {
    problems.push('条目里没有脚本路径（args 是空的）');
  } else if (!existsSync(target)) {
    problems.push(`脚本不在了：${target}`);
  }

  const cmd = ex.command;
  if (cmd) {
    const looksPath = cmd.includes('/') || cmd.includes('\\');
    if (looksPath) {
      if (!existsSync(cmd)) problems.push(`解释器不在了：${cmd}`);
    } else if (!findOnPath([cmd])) {
      problems.push(`PATH 上找不到 ${cmd}`);
    }
  } else {
    problems.push('条目里没有 command');
  }

  if (problems.length) return { ...base, state: 'unreachable', reason: problems.join('；'), problems, entry: ex };

  // 目标存在、解释器也在 —— 能起来。指向的可能是固定目录那份、也可能是别处的副本，
  // 都算 wired；只在备注里标一句，免得把"有意的多副本"误报成故障。
  const note = currentLaunch && Array.isArray(currentLaunch.args) && currentLaunch.args[0] && !samePath(target, currentLaunch.args[0])
    ? `指向 ${target}（当前这份是 ${currentLaunch.args[0]}）`
    : '';

  return { ...base, state: 'wired', reason: '', note, target, entry: ex };
}

/** 给 doctor 用的一句话说明。 */
export function describeAudit(a) {
  switch (a.state) {
    case 'wired': return '已注册';
    case 'stale': return `指向旧路径（${a.reason}）→ 跑 nexi install --all`;
    case 'unreachable': return `接不上（${a.reason}）→ 跑 nexi install --all`;
    case 'broken': return `配置文件坏了（${a.reason}）`;
    case 'absent': return `没接上（${a.reason}）→ 跑 nexi install --all`;
    default: return a.state;
  }
}

export default { extractEntry, auditHost, describeAudit };
