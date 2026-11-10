/**
 * lib/diagnostics.js —— 一键导出"现场"，给排障用。
 *
 * 为什么需要：用户报问题时，最有用的不是截图，而是版本、宿主清单、日志、
 * 配置长什么样。让用户挨个 copy 是不现实的，所以做成一条命令。
 *
 * **红线：绝不导出密钥与配置原文。**
 * 配置文件里可能有 API key、token、内网地址。所以这里只导：
 *   - 结构（有哪些 key、nexi 这一项在不在、字段名是什么）
 *   - 长度（token 只记长度，不记内容）
 *   - 路径（家目录缩成 ~，用户名不出去）
 * 原文一概不导出。宁可少给信息，也不让诊断包变成泄密包。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { HOSTS, BUILTIN_HOSTS, HOST_REGISTRY_PROBLEMS, detectHosts, shapeKeyOf } from './connect/hosts.js';
import { listBackups } from './connect/backup.js';
import { lockState } from './connect/lock.js';
import { stateRoot } from './selfremove.js';
import { logsDir, readTail } from './log.js';

const SECRET_RE = /token|secret|key|passw|credential|sha256|api[-_]?key/i;

/** 把家目录换成 ~，用户名不出门。 */
export function redactPath(p, home = homedir()) {
  if (!p) return p || '';
  const s = String(p);
  return home && s.startsWith(home) ? `~${s.slice(home.length)}` : s;
}

/**
 * 只描述结构，不搬运值。
 * 返回值可以直接 JSON.stringify —— 里面全是类型名、键名、长度。
 */
export function shapeOfConfig(file, { home = homedir() } = {}) {
  if (!existsSync(file)) return { exists: false };
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { exists: true, readable: false, error: err.code || String(err.message) };
  }

  const out = {
    exists: true,
    readable: true,
    path: redactPath(file, home),
    bytes: Buffer.byteLength(raw),
    lines: raw ? raw.split('\n').length : 0,
    format: null,
    topKeys: [],
    nexi: { present: false },
  };

  const trimmed = raw.trim();
  if (!trimmed) {
    out.format = 'empty';
    return out;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    out.format = 'json';
    try {
      const data = JSON.parse(trimmed);
      out.topKeys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort() : [];
      // 找 nexi 在哪一层，字段名是什么（不取值）
      for (const k of out.topKeys) {
        const v = data[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const inner = v.nexi;
          if (inner !== undefined) {
            out.nexi = {
              present: true,
              where: k,
              fields: inner && typeof inner === 'object' ? Object.keys(inner).sort() : [typeof inner],
            };
          } else if (v.servers && v.servers.nexi !== undefined) {
            out.nexi = { present: true, where: `${k}.servers`, fields: Object.keys(v.servers.nexi || {}).sort() };
          }
        }
        if (Array.isArray(v)) {
          const hit = v.find((x) => x && typeof x === 'object' && (x.name === 'nexi' || x.id === 'nexi'));
          if (hit) out.nexi = { present: true, where: `${k}[列表]`, fields: Object.keys(hit).sort() };
        }
      }
    } catch (err) {
      out.format = 'json (解析失败)';
      out.parseError = String(err.message).slice(0, 160);
      if (/token|key|secret/i.test(raw)) out.note = '文件里有疑似密钥字段，未做任何解析';
    }
    return out;
  }

  // YAML / TOML：按行看，只认「有哪几个顶层键」和「有没有 nexi」
  out.format = /^\s*\[/m.test(raw) ? 'toml' : 'yaml';
  const top = new Set();
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z_][\w.-]*)\s*[:=]/.exec(line);
    if (m) top.add(m[1]);
  }
  out.topKeys = [...top].sort();
  const nexiLine = raw.split('\n').find((l) =>
    /^\s*nexi\s*:\s*$/.test(l)                     // YAML 块状键：`  nexi:`
    || /^\s*\[mcp_servers\.nexi\]\s*$/.test(l)      // TOML 表头
    || /^\s*-\s*name\s*:\s*["']?nexi["']?\s*$/.test(l) // Continue 列表项
    || /^\s*name\s*:\s*["']?nexi["']?\s*$/.test(l),
  );
  out.nexi = { present: Boolean(nexiLine) };
  return out;
}

/** 状态目录只列文件名与大小，不读内容（里面可能有授权信息）。 */
function stateInventory(root) {
  if (!existsSync(root)) return { exists: false, path: redactPath(root) };
  const items = [];
  try {
    for (const name of readdirSync(root)) {
      const full = join(root, name);
      let size = 0;
      let dir = false;
      try {
        const st = statSync(full);
        size = st.size;
        dir = st.isDirectory();
      } catch { /* 读不到就跳过 */ }
      items.push({ name: basename(name), dir, bytes: size });
    }
  } catch (err) {
    return { exists: true, path: redactPath(root), error: err.code || String(err.message) };
  }
  // 不列 hosts.d 里每个文件的内容，只列数量
  return { exists: true, path: redactPath(root), items };
}

/**
 * 打包一次诊断现场。
 * 返回 `{ dir, files, note }` —— 调用方负责把 dir 打印给用户。
 */
export function buildDiagnostics(opts = {}) {
  const {
    version = 'unknown',
    doctorText = '',
    outDir,
    home = homedir(),
    now = new Date(),
  } = opts;

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const root = opts.root || join(outDir || process.cwd(), `nexi-diag-${stamp}`);
  mkdirSync(root, { recursive: true });

  const files = [];
  const write = (name, text) => {
    const full = join(root, name);
    writeFileSync(full, text, 'utf8');
    files.push(name);
    return full;
  };

  // ① 元信息
  write('meta.json', `${JSON.stringify({
    nexi: version,
    at: now.toISOString(),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    cwd: redactPath(process.cwd(), home),
    home: redactPath(home, home),
    argv0: redactPath(process.argv[1] || '', home),
  }, null, 2)}\n`);

  // ② 体检输出（用户看到的原文）
  write('doctor.txt', doctorText || '(没有体检输出)\n');

  // ③ 宿主清单（路径缩成 ~）
  const detected = detectHosts();
  write('hosts.json', `${JSON.stringify({
    builtin: BUILTIN_HOSTS.length,
    total: HOSTS.length,
    registryProblems: HOST_REGISTRY_PROBLEMS,
    hosts: detected.map((h) => ({
      id: h.id,
      label: h.label,
      kind: h.kind,
      shape: (() => { try { return shapeKeyOf(h.id); } catch { return null; } })(),
      installed: h.installed === true,
      path: redactPath(h.path, home),
      wired: h.wired === true,
    })),
  }, null, 2)}\n`);

  // ④ 配置结构（不导原文）
  const configShapes = {};
  for (const h of detected) {
    if (!h.installed || !h.path) continue;
    configShapes[h.id] = shapeOfConfig(h.path, { home });
  }
  write('config-shapes.json', `${JSON.stringify({
    note: '只记录结构（有哪些键、nexi 在不在、多大），不含任何配置内容；密钥永远不会出现在这里。',
    configs: configShapes,
  }, null, 2)}\n`);

  // ⑤ 备份清单（只列时间与大小）
  const backups = {};
  for (const h of detected) {
    if (!h.installed || !h.path) continue;
    const list = listBackups(h.path);
    if (!list.length) continue;
    backups[h.id] = list.map((b) => ({ at: b.at, why: b.why, bytes: b.size }));
  }
  write('backups.json', `${JSON.stringify({
    note: '每个配置文件留最近几份，可用 nexi restore <host> --last 回滚',
    backups,
  }, null, 2)}\n`);

  // ⑥ 锁与状态目录
  const locks = {};
  for (const h of detected) {
    if (!h.installed || !h.path) continue;
    const st = lockState(h.path);
    if (st.locked) locks[h.id] = st;
  }
  write('locks.json', `${JSON.stringify({ note: '有人正在写某个配置时会出现在这里', locks }, null, 2)}\n`);

  write('state.json', `${JSON.stringify(stateInventory(stateRoot()), null, 2)}\n`);

  // ⑦ 日志尾部
  let logText = '';
  try {
    const tail = readTail({ lines: 300 });
    logText = (tail.entries || []).map((e) => JSON.stringify(e)).join('\n');
  } catch (err) {
    logText = `(读日志失败：${err.message})`;
  }
  write('logs.tail.txt', `${logText || '(还没有日志)'}\n`);

  // ⑧ 给人看的说明
  write('README.txt', [
    'Nexi 诊断包',
    '',
    '这个目录是给排障用的，可以整个打包发出去。里面**没有**：',
    '  · 任何 API key / token / 密码（配置文件只导结构，不导内容）',
    '  · 你的完整家目录路径（都缩成了 ~）',
    '  · 任务内容、对话内容、代码',
    '',
    '里面有：',
    '  meta.json         版本、Node、系统、时间',
    '  doctor.txt        nexi doctor 的原始输出',
    '  hosts.json        接了哪些宿主、配置落在哪',
    '  config-shapes.json  每个配置的键结构（不含值）',
    '  backups.json      有哪些备份可回滚',
    '  locks.json        有没有进程正在写',
    '  state.json        状态目录里有哪几个文件（不读内容）',
    '  logs.tail.txt     最近 300 行运行日志',
    '',
    '发之前可以自己过一眼 —— 每个文件都是纯文本。',
    '',
  ].join('\n'));

  return {
    ok: true,
    dir: root,
    files,
    bytes: files.reduce((n, f) => {
      try { return n + statSync(join(root, f)).size; } catch { return n; }
    }, 0),
    logDir: (() => { try { return logsDir(); } catch { return null; } })(),
  };
}

export default { buildDiagnostics, shapeOfConfig, redactPath };
