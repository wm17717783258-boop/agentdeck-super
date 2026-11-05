/**
 * engine/toolbelt.js —— 超级 Agent 的工具带
 *
 * 契约（docs/CONTRACTS.md 2.6，签名不得改）：
 *   TOOLS / schemas(pick?) / invoke(name,args,ctx) / makeCtx({root,signal,log})
 *
 * 设计原则：
 *   1) 每个工具都**真干活**，不是占位。模型只看得见 description，所以中文说明里
 *      必须写清"什么时候该用我"，否则它就会拿 shell 去干 fs_read 的活。
 *   2) 所有文件操作先 realpath 再比对 ctx.root，防止 `../../`、软链接、Windows
 *      盘符跳转把宿主文件写坏；路径越界一律拒绝并给出人话。
 *   3) shell 是唯一能造成不可逆破坏的工具：默认 60s 超时、输出截到 200KB、
 *      高危命令必须显式 confirm:true 才放行（宁可让模型多问一句，也不能替用户删库）。
 *   4) 任何异常都不许抛给宿主 —— invoke 统一兜成 { ok:false, content:'人话错误' }。
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const MAX_OUTPUT_BYTES = 200 * 1024; // 契约：shell 输出截断 200KB
const DEFAULT_SHELL_TIMEOUT = 60_000;
const MAX_READ_BYTES = 400 * 1024;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv']);

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 按字节截断（不是按字符，避免中文被切一半导致乱码）。 */
export function clip(text, maxBytes = MAX_OUTPUT_BYTES) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  return `${buf.toString('utf8').replace(/\uFFFD+$/g, '')}\n…（输出过长，已截断到 ${(maxBytes / 1024).toFixed(0)}KB）`;
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function shortError(err) {
  const name = err?.name || 'Error';
  const msg = String(err?.message || err || '未知错误');
  if (err?.code === 'ENOENT') return '文件或目录不存在';
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return '没有权限访问（可能被杀毒/系统保护占用）';
  if (err?.code === 'EISDIR') return '这是一个目录，不是文件';
  if (err?.code === 'ENOTDIR') return '路径中有一段不是目录';
  return `${name}: ${msg}`.slice(0, 300);
}

function ok(content) {
  return { ok: true, content: String(content) };
}

function fail(content) {
  return { ok: false, content: String(content) };
}

/** 统一的 ctx 构造：root 一律绝对化，log 一律变成可选函数，其余依赖原样透传。 */
export function makeCtx(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const rawLog = o.log;
  let log;
  if (typeof rawLog === 'function') log = (...a) => rawLog(...a);
  else if (rawLog && typeof rawLog === 'object') log = (text) => (rawLog.info || rawLog.log || (() => {}))(`[toolbelt] ${text}`);
  else log = () => {};
  const root = path.resolve(String(o.root || process.cwd()));
  return {
    ...o,
    root,
    signal: o.signal,
    log,
    board: o.board || null,
    teamId: o.teamId || '',
  };
}

// ---------------------------------------------------------------------------
// 路径沙箱：所有文件工具的唯一入口
// ---------------------------------------------------------------------------

/**
 * 把用户给的路径解析成 root 内的绝对路径。
 * 已存在的路径走 realpath（能穿透软链接）；不存在的路径取"最近的已存在祖先"做
 * realpath，再把剩余段拼回去 —— 这样"新建文件"也能被校验，而不是等到写完才发现越界。
 */
export async function resolveInside(root, input, { allowOutside = false } = {}) {
  const rootAbs = path.resolve(String(root || process.cwd()));
  const raw = String(input ?? '').trim();
  const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootAbs, raw || '.');

  const realRoot = await realpathOr(rootAbs);
  const probe = await nearestExisting(target);
  const realProbe = await realpathOr(probe);
  const tail = path.relative(probe, target);
  const realTarget = tail ? path.join(realProbe, tail) : realProbe;

  if (!allowOutside && !isInside(realRoot, realTarget)) {
    throw Object.assign(new Error(`路径越界：${raw || '.'} 不在工作区 ${rootAbs} 内（工具只允许操作工作区文件）`), {
      code: 'OUTSIDE_ROOT',
    });
  }
  return target;
}

function isInside(root, target) {
  const a = IS_WIN ? root.toLowerCase() : root;
  const b = IS_WIN ? target.toLowerCase() : target;
  if (a === b) return true;
  const withSep = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(withSep);
}

async function realpathOr(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

async function nearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      await fs.stat(cur);
      return cur;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return cur;
      cur = up;
    }
  }
}

async function readTextFile(file, maxBytes = MAX_READ_BYTES) {
  const st = await fs.stat(file);
  if (st.isDirectory()) throw Object.assign(new Error('这是一个目录'), { code: 'EISDIR' });
  if (st.size > maxBytes) {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      await fh.read(buf, 0, maxBytes, 0);
      return { text: buf.toString('utf8'), truncated: true, size: st.size };
    } finally {
      await fh.close();
    }
  }
  return { text: await fs.readFile(file, 'utf8'), truncated: false, size: st.size };
}

/** 原子写：先写同目录临时文件再 rename，避免模型中途失败留下半截文件。 */
async function writeAtomic(file, content) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function withLineNumbers(text, startLine = 1) {
  return String(text)
    .split(/\r?\n/)
    .map((line, i) => `${String(startLine + i).padStart(5)}| ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// glob / 遍历
// ---------------------------------------------------------------------------

/** 迷你 glob → 正则：支持 ** / * / ?，够用且零依赖（不引 minimatch）。 */
export function globToRegExp(pattern) {
  const p = String(pattern || '*').replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '^';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` 可以匹配零层目录（这是 glob 的惯例，很多手写实现会漏）
        if (p[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  out += '$';
  return new RegExp(out, IS_WIN ? 'i' : '');
}

async function* walkFiles(dir, { signal, maxFiles = 5000, followRoot = true } = {}) {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    if (signal?.aborted) return;
    const cur = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (signal?.aborted) return;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        seen += 1;
        if (seen > maxFiles) return;
        yield full;
      }
    }
    if (!followRoot) return;
  }
}

// ---------------------------------------------------------------------------
// shell 安全：高危命令识别
// ---------------------------------------------------------------------------

/**
 * 高危命令清单。命中就必须显式 confirm:true。
 * 判断用"归一化后的字符串"（小写、压缩空白、去掉引号）来匹配，
 * 因为 `rm  -rf`、`RM -RF`、`rm "-rf"` 都是同一个意思。
 */
const DANGEROUS = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/, why: '递归/强制删除文件（rm -rf）' },
  { re: /\brmdir\b[^\n]*\/s/i, why: '递归删目录（rmdir /s）' },
  { re: /\b(?:del|erase)\b[^\n]*\/[fsq]/i, why: '强制/递归删除（del /f /s /q）' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, why: '格式化文件系统' },
  { re: /\bdd\b[^\n]*\bif=/i, why: '裸写磁盘（dd）' },
  { re: /\b(shutdown|reboot|poweroff|halt|stop-computer|restart-computer)\b/i, why: '关机/重启' },
  { re: /\bdiskpart\b/i, why: '磁盘分区工具' },
  { re: /\breg\s+delete\b/i, why: '删除注册表项' },
  { re: /\btaskkill\b[^\n]*\/f/i, why: '强制结束进程' },
  { re: /\bgit\s+push\b[^\n]*(--force\b(?!-with-lease)|\s-f\b)/i, why: '强制推送（可能覆盖远端历史）' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'git reset --hard（丢弃本地改动）' },
  { re: /\bgit\s+clean\b[^\n]*-[a-z]*[fd]/i, why: 'git clean -fd（删除未跟踪文件）' },
  { re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell|node|python)/i, why: '下载后直接执行远程脚本' },
  { re: /\biwr\b[^\n]*\|\s*iex/i, why: '下载后直接执行远程脚本（Invoke-Expression）' },
  { re: /\bremove-item\b[^\n]*-recurse[^\n]*-force/i, why: '递归强制删除（Remove-Item -Recurse -Force）' },
  { re: /\bsudo\b/i, why: '提权执行' },
  { re: /:\s*\(\s*\)\s*\{/, why: 'fork 炸弹' },
  { re: /\bchmod\s+-r\s+777\s+\//i, why: '把根目录权限改成 777' },
  { re: /\bnpm\s+publish\b|\bnpm\s+unpublish\b/i, why: '发布/撤回 npm 包' },
];

/** 返回 { dangerous, why }；纯函数，方便测试和日志复核。 */
export function inspectCommand(command) {
  const s = String(command ?? '').toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim();
  for (const d of DANGEROUS) {
    if (d.re.test(s)) return { dangerous: true, why: d.why, matched: s.match(d.re)?.[0] || d.why };
  }
  return { dangerous: false, why: '' };
}

function spawnShell(command, { cwd, timeoutMs, env, signal, stdinText, maxBytes }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = IS_WIN
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
            cwd,
            env: { ...process.env, ...(env || {}) },
            windowsHide: true,
            // 两点必须一起改，否则带引号的命令（node -e "..." 这种最常见的写法）在 Windows 上必挂：
            // 1) windowsVerbatimArguments：默认的 Node 参数转义会把命令里的 " 变成 \"，cmd.exe 不认；
            // 2) 外层再包一层引号：cmd /s 的规则是"首字符是引号就去掉首尾引号"，
            //    不包的话它会把命令中间的一个引号当结尾，命令直接被腰斩。
            windowsVerbatimArguments: true,
            stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          })
        : spawn('/bin/sh', ['-c', command], {
            cwd,
            env: { ...process.env, ...(env || {}) },
            stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          });
    } catch (err) {
      resolve({ rc: 127, out: '', err: `启动 shell 失败：${shortError(err)}`, ms: 0, timedOut: false });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let finished = false;

    const killTree = () => {
      try {
        if (IS_WIN && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { /* 进程可能已经退出 */ }
      try {
        child.kill('SIGKILL');
      } catch { /* 忽略 */ }
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, timeoutMs)
      : null;

    const onAbort = () => {
      timedOut = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const collect = (chunks, chunk, which) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const used = which === 'out' ? outBytes : errBytes;
      if (used >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - used;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      if (buf.length > room) truncated = true;
      chunks.push(slice);
      if (which === 'out') outBytes += slice.length;
      else errBytes += slice.length;
    };

    child.stdout?.on('data', (c) => collect(outChunks, c, 'out'));
    child.stderr?.on('data', (c) => collect(errChunks, c, 'err'));
    if (stdinText != null && child.stdin) {
      try {
        child.stdin.end(stdinText);
      } catch { /* 忽略 */ }
    }

    const done = (rc, extraErr) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve({
        rc: timedOut ? 124 : rc,
        out: Buffer.concat(outChunks).toString('utf8'),
        err: extraErr ?? Buffer.concat(errChunks).toString('utf8'),
        ms: Date.now() - started,
        timedOut,
        truncated,
      });
    };

    child.on('error', (e) => done(127, `无法执行命令：${shortError(e)}`));
    child.on('close', (code) => done(code == null ? 1 : code));
  });
}

// ---------------------------------------------------------------------------
// 网页抓取 → 干净文本
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', times: '×', divide: '÷', deg: '°', euro: '€', pound: '£', yen: '¥',
};

/**
 * HTML → 干净文本。
 * 为什么要自己写：引 cheerio/jsdom 会破坏"零第三方依赖"，而不洗一遍的话，
 * 模型会拿到整页 <script> 和内联样式，白白烧 token 还读不懂正文。
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\s*\/?>/gi, '\n');
  s = s.replace(/<(li|\/td|\/th)\b[^>]*>/gi, (m) => (m.toLowerCase().startsWith('<li') ? '\n- ' : '\t'));
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, name) => {
    const key = name.toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[key] ?? m;
  });
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

async function fetchText(url, { fetchImpl, headers, timeoutMs = 20_000, signal, maxChars = 60_000, method = 'GET', body } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('当前运行时没有 fetch');
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('只支持 http/https 网址');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`超时 ${timeoutMs}ms`)), Math.max(1, timeoutMs));
  const onAbort = () => ctrl.abort(signal?.reason || new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await f(url, {
      method,
      body,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; agentdeck-super/1.3; +https://github.com/)',
        accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
        ...(headers || {}),
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const ctype = String(res.headers?.get?.('content-type') || '');
    const raw = await res.text();
    const isHtml = /html|xml/i.test(ctype) || /^\s*<(!doctype|html)/i.test(raw);
    const text = isHtml ? htmlToText(raw) : raw;
    return {
      status: res.status,
      ok: res.ok,
      contentType: ctype,
      isHtml,
      text,
      truncated: text.length > maxChars,
      body: text.length > maxChars ? `${text.slice(0, maxChars)}\n…（正文过长，已截断到 ${maxChars} 字）` : text,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// 任务板 / 成员 辅助
// ---------------------------------------------------------------------------

function boardOf(ctx) {
  const board = ctx?.board;
  if (!board || typeof board.addTask !== 'function') {
    throw Object.assign(new Error('任务板不可用（宿主没有注入 board 服务）'), { code: 'NO_BOARD' });
  }
  if (!ctx.teamId) throw Object.assign(new Error('还没有加入任何小组（ctx.teamId 为空）'), { code: 'NO_TEAM' });
  return board;
}

function fmtTask(t) {
  if (!t) return '(空任务)';
  const deps = Array.isArray(t.dependsOn) && t.dependsOn.length ? t.dependsOn.join(',') : '-';
  const acc = t.acceptance ? ` · 验收=${String(t.acceptance).slice(0, 80)}` : '';
  const who = t.assignee ? ` · 负责=${t.assignee}` : '';
  return `- [${t.id}] (${t.status || 'pending'}) ${t.title} · 角色=${t.role || '-'} · 依赖=${deps}${who}${acc}`;
}

function membersOf(ctx) {
  const reg = ctx?.registry;
  const list = typeof reg?.list === 'function' ? reg.list() : Array.isArray(reg) ? reg : Array.isArray(reg?.agents) ? reg.agents : [];
  return Array.isArray(list) ? list : [];
}

function findMember(ctx, key) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  const pool = membersOf(ctx);
  const hit = pool.find((m) => [m?.id, m?.name, m?.label, m?.agentId].filter(Boolean).some((v) => String(v) === k || String(v).toLowerCase() === k.toLowerCase()));
  if (hit) return hit;
  // 任务板成员也算（ADBP 接进来的外部 Agent 只存在于 board）
  const boardMembers = typeof ctx?.board?.listMembers === 'function' && ctx.teamId ? safeCallSync(() => ctx.board.listMembers(ctx.teamId)) : [];
  return (boardMembers || []).find((m) => [m?.id, m?.name].filter(Boolean).some((v) => String(v) === k)) || null;
}

function safeCallSync(fn) {
  try {
    const out = fn();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const S = {
  str: (description, extra = {}) => ({ type: 'string', description, ...extra }),
  num: (description, extra = {}) => ({ type: 'number', description, ...extra }),
  bool: (description) => ({ type: 'boolean', description }),
  arr: (description, items = { type: 'string' }) => ({ type: 'array', description, items }),
};

const COMMON_PATH = S.str('相对工作区根目录的路径（也接受绝对路径，但必须落在工作区内）。不填默认工作区根目录。');

export const TOOLS = {
  fs_list: {
    description: '列出目录内容（名称/类型/大小）。当你需要先摸清项目结构、确认某个目录里有什么文件时用它，比 shell ls 更安全、输出更规整。',
    schema: {
      type: 'object',
      properties: { path: COMMON_PATH, depth: S.num('递归深度，默认 1（只看一层）；最大 4。'), limit: S.num('最多返回多少条，默认 200。') },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const dir = await resolveInside(ctx.root, args.path || '.');
      const depth = Math.min(4, Math.max(1, Number(args.depth) || 1));
      const limit = Math.min(1000, Math.max(1, Number(args.limit) || 200));
      const rows = [];
      const walk = async (cur, level) => {
        if (rows.length >= limit) return;
        let entries;
        try {
          entries = await fs.readdir(cur, { withFileTypes: true });
        } catch (err) {
          rows.push(`${path.relative(ctx.root, cur) || '.'}/  ← 读不了：${shortError(err)}`);
          return;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const ent of entries) {
          if (rows.length >= limit) return;
          const full = path.join(cur, ent.name);
          const rel = path.relative(ctx.root, full) || ent.name;
          if (ent.isDirectory()) {
            rows.push(`${rel}/`);
            if (level < depth && !SKIP_DIRS.has(ent.name)) await walk(full, level + 1);
          } else {
            let size = 0;
            try {
              size = (await fs.stat(full)).size;
            } catch { /* 忽略：可能刚好被删除 */ }
            rows.push(`${rel}  (${humanBytes(size)})`);
          }
        }
      };
      await walk(dir, 1);
      const head = `目录：${path.relative(ctx.root, dir) || '.'}（深度 ${depth}）`;
      return ok(`${head}\n${rows.length ? rows.join('\n') : '（空目录）'}${rows.length >= limit ? `\n…（已达上限 ${limit} 条，请用 fs_glob 精确定位）` : ''}`);
    },
  },

  fs_read: {
    description: '读取一个文本文件的全部或部分内容（带行号）。当你需要看代码、配置、日志正文时用它；大文件请用 offset/limit 分段读，不要一次拉整份。',
    schema: {
      type: 'object',
      properties: {
        path: S.str('要读的文件路径（相对工作区）。'),
        offset: S.num('从第几行开始（1 起，默认 1）。'),
        limit: S.num('最多读多少行，默认 400，上限 4000。'),
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.path) return fail('缺少 path：fs_read 需要知道读哪个文件。');
      const file = await resolveInside(ctx.root, args.path);
      const { text, truncated, size } = await readTextFile(file);
      const all = text.split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(4000, Math.max(1, Number(args.limit) || 400));
      const slice = all.slice(offset - 1, offset - 1 + limit);
      const rel = path.relative(ctx.root, file);
      const head = `文件：${rel}（共 ${all.length} 行，${humanBytes(size)}${truncated ? '，已按 400KB 截断' : ''}）`;
      const more = offset - 1 + slice.length < all.length ? `\n…（还有内容，继续读请用 offset=${offset + slice.length}）` : '';
      return ok(`${head}\n${withLineNumbers(slice.join('\n'), offset)}${more}`);
    },
  },

  fs_write: {
    description: '写入/覆盖一个文本文件（自动建目录，原子写）。当你要生成或整体替换一个文件时用它；只改一小段请优先用 fs_patch，避免覆盖掉别人刚写的改动。',
    schema: {
      type: 'object',
      properties: {
        path: S.str('要写的文件路径（相对工作区）。'),
        content: S.str('文件完整内容。'),
        append: S.bool('true 表示追加到文件末尾，而不是覆盖。'),
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.path) return fail('缺少 path：fs_write 需要知道写哪个文件。');
      if (typeof args.content !== 'string') return fail('缺少 content：content 必须是字符串（要写进去的正文）。');
      const file = await resolveInside(ctx.root, args.path);
      const before = existsSync(file) ? (await fs.stat(file)).size : 0;
      if (args.append) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, args.content, 'utf8');
      } else {
        await writeAtomic(file, args.content);
      }
      const rel = path.relative(ctx.root, file);
      const after = Buffer.byteLength(args.content, 'utf8');
      return ok(`已${args.append ? '追加' : '写入'} ${rel}：${args.append ? `新增 ${humanBytes(after)}` : `${humanBytes(before)} → ${humanBytes(after)}`}`);
    },
  },

  fs_patch: {
    description: '对文件做精确文本替换（把 old 换成 new）。当你只想改动文件里的某一段（改 bug、换配置、补字段）时用它，比整文件重写安全得多。old 必须在文件里出现且唯一，否则会拒绝执行。',
    schema: {
      type: 'object',
      properties: {
        path: S.str('要修改的文件路径（相对工作区）。'),
        old: S.str('被替换的原文，必须和文件里的内容逐字一致（含缩进）。'),
        new: S.str('替换后的新文本。'),
        all: S.bool('true 表示替换所有匹配（默认只允许唯一匹配）。'),
      },
      required: ['path', 'old', 'new'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.path) return fail('缺少 path：fs_patch 需要知道改哪个文件。');
      if (typeof args.old !== 'string' || args.old === '') return fail('缺少 old：需要提供要被替换的原文（不能为空）。');
      if (typeof args.new !== 'string') return fail('缺少 new：需要提供替换后的文本（可以是空字符串表示删除）。');
      const file = await resolveInside(ctx.root, args.path);
      const { text } = await readTextFile(file);
      const count = countOccurrences(text, args.old);
      if (count === 0) return fail(`没找到要替换的原文（文件：${path.relative(ctx.root, file)}）。请先用 fs_read 确认原文逐字一致（含缩进/换行）。`);
      if (count > 1 && !args.all) return fail(`原文出现了 ${count} 次，无法确定改哪一处。请补充更多上下文让它唯一，或传 all:true 全部替换。`);
      const next = args.all ? text.split(args.old).join(args.new) : text.replace(args.old, args.new);
      await writeAtomic(file, next);
      return ok(`已修改 ${path.relative(ctx.root, file)}：替换 ${args.all ? count : 1} 处，文件 ${humanBytes(Buffer.byteLength(text, 'utf8'))} → ${humanBytes(Buffer.byteLength(next, 'utf8'))}`);
    },
  },

  fs_glob: {
    description: '按通配符（** / * / ?）查找文件路径。当你知道文件名大概长什么样、但不知道在哪个目录时用它（比如 **/*.test.mjs）。要搜索文件内容请用 fs_grep。',
    schema: {
      type: 'object',
      properties: {
        pattern: S.str('通配符，例如 "src/**/*.js"、"**/*.md"。'),
        path: S.str('从哪个子目录开始找，默认工作区根目录。'),
        limit: S.num('最多返回多少条，默认 200。'),
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.pattern) return fail('缺少 pattern：例如 "**/*.js"。');
      const base = await resolveInside(ctx.root, args.path || '.');
      const re = globToRegExp(args.pattern);
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 200));
      const hits = [];
      for await (const file of walkFiles(base, { signal: ctx.signal })) {
        const rel = path.relative(ctx.root, file).replace(/\\/g, '/');
        if (re.test(rel) || re.test(path.relative(base, file).replace(/\\/g, '/'))) hits.push(rel);
        if (hits.length >= limit) break;
      }
      hits.sort();
      return ok(hits.length ? `匹配 "${args.pattern}" 的文件（${hits.length} 个）：\n${hits.join('\n')}` : `没有匹配 "${args.pattern}" 的文件（起始目录 ${path.relative(ctx.root, base) || '.'}）。`);
    },
  },

  fs_grep: {
    description: '在工作区文件内容里按正则搜索，返回命中的文件名:行号:内容。当你要找"某个函数在哪定义""哪里引用了这个变量"时用它，别用 shell 的 grep/findstr（跨平台且已自带忽略规则）。',
    schema: {
      type: 'object',
      properties: {
        pattern: S.str('正则表达式（JS 语法），例如 "createBrain\\(" 或 "TODO|FIXME"。'),
        path: S.str('在哪个目录或文件里搜，默认工作区根目录。'),
        include: S.str('只搜匹配这个通配符的文件，例如 "*.js"。'),
        ignoreCase: S.bool('是否忽略大小写，默认 false。'),
        limit: S.num('最多命中多少条，默认 80。'),
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.pattern) return fail('缺少 pattern：fs_grep 需要正则表达式。');
      let re;
      try {
        re = new RegExp(args.pattern, args.ignoreCase ? 'i' : '');
      } catch (err) {
        return fail(`正则写错了：${shortError(err)}`);
      }
      const base = await resolveInside(ctx.root, args.path || '.');
      const includeRe = args.include ? globToRegExp(args.include.includes('/') ? args.include : `**/${args.include}`) : null;
      const limit = Math.min(1000, Math.max(1, Number(args.limit) || 80));
      const files = [];
      const st = await fs.stat(base).catch(() => null);
      if (st?.isFile()) files.push(base);
      else for await (const f of walkFiles(base, { signal: ctx.signal })) files.push(f);

      const hits = [];
      for (const file of files) {
        if (ctx.signal?.aborted) break;
        const rel = path.relative(ctx.root, file).replace(/\\/g, '/');
        if (includeRe && !includeRe.test(rel)) continue;
        let info;
        try {
          const size = (await fs.stat(file)).size;
          if (size > MAX_GREP_FILE_BYTES) continue;
          const buf = await fs.readFile(file);
          if (buf.subarray(0, 8192).includes(0)) continue; // 二进制文件跳过
          info = buf.toString('utf8');
        } catch {
          continue;
        }
        const lines = info.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          re.lastIndex = 0;
          if (!re.test(lines[i])) continue;
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          if (hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
      }
      return ok(hits.length ? `命中 ${hits.length} 条：\n${hits.join('\n')}` : `没有命中 "${args.pattern}"。`);
    },
  },

  shell: {
    description: '在工作区里执行一条 shell 命令（Windows 用 cmd，其它用 /bin/sh），返回退出码和输出。当你要跑测试、装依赖、用 git、执行构建时用它。默认 60 秒超时、输出截断 200KB；rm -rf、git push --force 这类高危命令需要显式传 confirm:true 才会执行。',
    schema: {
      type: 'object',
      properties: {
        command: S.str('要执行的命令，例如 "npm test" 或 "git status --short"。'),
        cwd: S.str('在哪个目录执行（相对工作区），默认工作区根目录。'),
        timeoutMs: S.num('超时毫秒数，默认 60000，上限 600000。'),
        confirm: S.bool('高危命令必须显式传 true 才执行。'),
        stdin: S.str('需要喂给命令的标准输入文本（可选）。'),
        env: { type: 'object', description: '额外环境变量（可选）。', additionalProperties: { type: 'string' } },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const command = String(args.command || '').trim();
      if (!command) return fail('缺少 command：shell 需要一条要执行的命令。');
      const risk = inspectCommand(command);
      if (risk.dangerous && args.confirm !== true) {
        return fail(`已拦截高危命令（${risk.why}）。如果确实要执行，请重新调用并传 confirm:true，并在结论里说明为什么必须这么做。`);
      }
      const cwd = await resolveInside(ctx.root, args.cwd || '.');
      const timeoutMs = Math.min(600_000, Math.max(1000, Number(args.timeoutMs) || DEFAULT_SHELL_TIMEOUT));
      const res = await spawnShell(command, {
        cwd,
        timeoutMs,
        env: args.env,
        signal: ctx.signal,
        stdinText: typeof args.stdin === 'string' ? args.stdin : undefined,
        maxBytes: MAX_OUTPUT_BYTES,
      });
      const out = clip(res.out, MAX_OUTPUT_BYTES);
      const err = clip(res.err, MAX_OUTPUT_BYTES);
      const head = `$ ${command}\n目录：${path.relative(ctx.root, cwd) || '.'} · 退出码=${res.rc} · 耗时=${res.ms}ms${res.timedOut ? ' · 已超时杀进程' : ''}${res.truncated ? ' · 输出已截断' : ''}`;
      const body = [out && `--- stdout ---\n${out}`, err && `--- stderr ---\n${err}`].filter(Boolean).join('\n');
      const content = `${head}\n${body || '(没有任何输出)'}`;
      return res.rc === 0 ? ok(content) : fail(content);
    },
  },

  web_fetch: {
    description: '抓取一个 http(s) 网页并转成干净正文（自动去掉脚本/样式/标签）。当你要查在线文档、读别人的 README、核实网页信息时用它；只想调接口拿 JSON 请用 http_request。',
    schema: {
      type: 'object',
      properties: {
        url: S.str('完整网址，必须以 http:// 或 https:// 开头。'),
        maxChars: S.num('最多返回多少字，默认 60000。'),
        timeoutMs: S.num('超时毫秒数，默认 20000。'),
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.url) return fail('缺少 url：web_fetch 需要完整网址。');
      const res = await fetchText(args.url, {
        fetchImpl: ctx.fetch,
        signal: ctx.signal,
        timeoutMs: Number(args.timeoutMs) || 20_000,
        maxChars: Math.min(200_000, Math.max(1000, Number(args.maxChars) || 60_000)),
      });
      const head = `网址：${args.url}\n状态：${res.status}${res.ok ? '' : '（请求失败）'} · 类型：${res.contentType || '未知'}`;
      return res.ok ? ok(`${head}\n\n${res.body || '(正文为空)'}`) : fail(`${head}\n\n${clip(res.body, 2000)}`);
    },
  },

  http_request: {
    description: '发起一次 HTTP 请求（GET/POST/PUT/PATCH/DELETE），返回状态码、响应头和响应体。当你要调真实接口、验证服务是否活着、提交表单/JSON 时用它；拿人看的网页请用 web_fetch。',
    schema: {
      type: 'object',
      properties: {
        url: S.str('完整网址。'),
        method: S.str('HTTP 方法，默认 GET。', { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }),
        headers: { type: 'object', description: '请求头（可选）。', additionalProperties: { type: 'string' } },
        body: S.str('请求体（POST/PUT/PATCH 用）。'),
        timeoutMs: S.num('超时毫秒数，默认 20000。'),
        maxChars: S.num('响应体最多返回多少字，默认 40000。'),
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.url) return fail('缺少 url：http_request 需要完整网址。');
      const method = String(args.method || 'GET').toUpperCase();
      const headers = { ...(args.headers || {}) };
      if (args.body && !headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
      const res = await fetchText(args.url, {
        fetchImpl: ctx.fetch,
        signal: ctx.signal,
        timeoutMs: Number(args.timeoutMs) || 20_000,
        maxChars: Math.min(200_000, Math.max(500, Number(args.maxChars) || 40_000)),
        method,
        body: ['GET', 'HEAD'].includes(method) ? undefined : args.body,
        headers,
      });
      const head = `${method} ${args.url}\n状态：${res.status} · 类型：${res.contentType || '未知'}`;
      return res.ok ? ok(`${head}\n\n${res.body || '(响应体为空)'}`) : fail(`${head}\n\n${res.body.slice(0, 4000)}`);
    },
  },

  board_add: {
    description: '往小组任务板加一条任务（可指定角色、验收标准、依赖、负责人）。当你要把大目标拆成可执行、可验收的子任务时用它；加完记得用 agent_run 派人去做。',
    schema: {
      type: 'object',
      properties: {
        title: S.str('任务标题，一句话说清要交付什么。'),
        role: S.str('建议角色：lead / architect / critic / worker / tester / scribe（不填按 worker）。'),
        acceptance: S.str('验收标准：怎样才算做完（要能被检查）。'),
        dependsOn: S.arr('依赖的任务 id 列表（这些任务完成后本任务才算就绪）。'),
        assignee: S.str('指派给某个成员（可选，不填就等人认领）。'),
        note: S.str('补充说明（可选）。'),
      },
      required: ['title'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.title) return fail('缺少 title：任务必须有个说清交付物的标题。');
      const board = boardOf(ctx);
      const task = board.addTask(ctx.teamId, {
        title: String(args.title),
        role: String(args.role || 'worker'),
        acceptance: args.acceptance ? String(args.acceptance) : '',
        dependsOn: Array.isArray(args.dependsOn) ? args.dependsOn.map(String) : [],
        assignee: args.assignee ? String(args.assignee) : undefined,
        note: args.note ? String(args.note) : undefined,
      });
      board.appendEvent?.(ctx.teamId, { kind: 'task_add', text: `新任务 ${task?.id || ''}：${args.title}`, taskId: task?.id });
      return ok(`已加入任务板：\n${fmtTask(task)}\n提示：用 agent_run 派人做，或用 board_list 看全局。`);
    },
  },

  board_list: {
    description: '查看小组任务板和统计（可按状态/负责人过滤）。当你要知道"还剩什么没做、谁在做什么、整体进度"时用它；这是任务板唯一真相源。',
    schema: {
      type: 'object',
      properties: {
        status: S.str('过滤状态：pending / running / done / failed。'),
        assignee: S.str('过滤负责人（成员 id 或名字）。'),
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const board = boardOf(ctx);
      const filter = {};
      if (args.status) filter.status = String(args.status);
      if (args.assignee) filter.assignee = String(args.assignee);
      const tasks = board.listTasks(ctx.teamId, filter) || [];
      const stats = typeof board.stats === 'function' ? board.stats(ctx.teamId) : null;
      const team = typeof board.getTeam === 'function' ? board.getTeam(ctx.teamId) : null;
      const head = team ? `小组：${team.name}（${team.id}）· 目标：${team.goal || '-'}` : `小组：${ctx.teamId || '(未绑定)'}`;
      const statLine = stats ? `\n统计：总 ${stats.total} · 完成 ${stats.done} · 失败 ${stats.failed} · 进行中 ${stats.running} · 待办 ${stats.pending}` : '';
      const body = tasks.length ? `\n${tasks.map(fmtTask).join('\n')}` : '\n（当前过滤条件下没有任务）';
      return ok(`${head}${statLine}${body}`);
    },
  },

  board_done: {
    description: '把一条任务标记为完成或失败（写入结果/原因）。当你做完了某个任务、或者确认它做不下去时用它，让任务板状态和真实进度一致。',
    schema: {
      type: 'object',
      properties: {
        taskId: S.str('任务 id。'),
        ok: S.bool('true=完成，false=失败（默认 true）。'),
        output: S.str('结果摘要（做了什么、产物在哪）。'),
        note: S.str('补充说明（失败原因等）。'),
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.taskId) return fail('缺少 taskId：要更新哪一条任务？');
      const board = boardOf(ctx);
      const okFlag = args.ok !== false;
      const output = args.output ? String(args.output) : '';
      let task;
      if (okFlag) {
        if (typeof board.completeTask !== 'function') return fail('任务板没有提供 completeTask。');
        task = board.completeTask(ctx.teamId, String(args.taskId), { ok: true, output, note: args.note ? String(args.note) : undefined });
      } else {
        if (typeof board.failTask !== 'function') return fail('任务板没有提供 failTask。');
        task = board.failTask(ctx.teamId, String(args.taskId), args.note ? String(args.note) : output || '未说明原因');
      }
      board.appendEvent?.(ctx.teamId, { kind: okFlag ? 'task_done' : 'task_failed', text: `任务 ${args.taskId} ${okFlag ? '完成' : '失败'}`, taskId: args.taskId });
      return ok(`已更新任务 ${args.taskId}：${okFlag ? '完成' : '失败'}\n${fmtTask(task)}`);
    },
  },

  agent_run: {
    description: '把一件具体的活派给小组里的某个成员（本机 CLI Agent 或外部 Agent），等它返回结果。当你知道谁合适、要把任务并行分发出去时用它；成员列表不确定就先 agent_join 看一遍。',
    schema: {
      type: 'object',
      properties: {
        member: S.str('成员 id 或名字（来自成员列表 / 任务板）。'),
        prompt: S.str('要交给它的完整指令：背景、目标、交付物、验收标准。'),
        cwd: S.str('在哪个目录干活（相对工作区，默认工作区根）。'),
        timeoutMs: S.num('超时毫秒数，默认 300000。'),
        expect: S.str('期望产出（可选），会一并写进指令，方便成员对齐。'),
      },
      required: ['member', 'prompt'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (!args.member) return fail('缺少 member：要派给谁？');
      if (!args.prompt) return fail('缺少 prompt：派活必须写清要它做什么。');
      const runner = ctx.dispatch || ctx.runAgent;
      if (typeof runner !== 'function') return fail('当前宿主没有注入派活能力（ctx.dispatch / ctx.runAgent），只能在本机自己干。');
      const member = findMember(ctx, args.member);
      if (!member) {
        const names = membersOf(ctx).map((m) => m.id || m.name).filter(Boolean);
        return fail(`没找到成员「${args.member}」。现有成员：${names.length ? names.join('、') : '（空，先让 Agent 入组）'}`);
      }
      const cwd = await resolveInside(ctx.root, args.cwd || '.');
      const timeoutMs = Math.min(3_600_000, Math.max(1000, Number(args.timeoutMs) || 300_000));
      const prompt = args.expect ? `${args.prompt}\n\n【期望产出】${args.expect}` : String(args.prompt);
      const started = Date.now();
      const res = await runner(member, prompt, { cwd, timeoutMs, signal: ctx.signal });
      const ms = res?.ms ?? Date.now() - started;
      const rc = res?.rc ?? (res?.ok === false ? 1 : 0);
      const out = String(res?.out ?? res?.output ?? res?.content ?? '').trim();
      const err = String(res?.err ?? res?.error ?? '').trim();
      const memberName = member.name || member.id;
      const head = `成员 ${memberName} 执行完毕：${rc === 0 ? '成功' : `失败(rc=${rc})`} · ${ms}ms`;
      const body = [out && `--- 输出 ---\n${clip(out, 30_000)}`, err && `--- 错误 ---\n${clip(err, 4000)}`].filter(Boolean).join('\n');
      try {
        ctx.board?.appendEvent?.(ctx.teamId, { kind: 'agent_run', text: `${memberName} ${rc === 0 ? '完成' : '失败'}：${out.slice(0, 300)}`, member: member.id || memberName });
      } catch { /* 事件写失败不影响派活结果 */ }
      return rc === 0 ? ok(`${head}\n${body || '(没有输出)'}`) : fail(`${head}\n${body || '(没有输出)'}`);
    },
  },

  ask_user: {
    description: '向用户提一个问题并等回答（会写进小组事件流，宿主面板上能看到）。当你缺关键信息、或要做有风险的决定必须用户点头时才用它，不要拿它确认显而易见的事。',
    schema: {
      type: 'object',
      properties: {
        question: S.str('要问用户的问题，尽量一句话说清、给出可选项。'),
        options: S.arr('候选答案（可选，用户可直接点选）。'),
        timeoutMs: S.num('最多等多少毫秒，默认 120000。'),
      },
      required: ['question'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const question = String(args.question || '').trim();
      if (!question) return fail('缺少 question：ask_user 需要问题。');
      const options = Array.isArray(args.options) ? args.options.map(String) : [];
      const evt = { kind: 'ask_user', text: question, options, ts: Date.now() };
      try {
        ctx.board?.appendEvent?.(ctx.teamId, evt);
      } catch { /* 事件流不可用也要能问 */ }
      ctx.log?.(`问用户：${question}`);

      const ask = ctx.ask || ctx.askUser;
      if (typeof ask !== 'function') {
        return ok(`已把问题写进事件流，等待用户回答：\n「${question}」${options.length ? `\n可选项：${options.join(' / ')}` : ''}\n（当前宿主没有提供交互通道，不会阻塞在这里；请把问题一并告诉用户。）`);
      }
      const timeoutMs = Math.min(3_600_000, Math.max(1000, Number(args.timeoutMs) || 120_000));
      let timer = null;
      try {
        const answer = await Promise.race([
          Promise.resolve(ask({ question, options, timeoutMs, teamId: ctx.teamId })),
          // unref 很关键：用户秒回之后，这个计时器不该继续把进程顶到超时才退出
          new Promise((r) => {
            timer = setTimeout(() => r(null), timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (answer == null || answer === '') return ok(`用户暂时没有回答（已等待 ${Math.round(timeoutMs / 1000)}s）。问题：「${question}」\n建议：先在不确定的地方按最稳妥的默认值推进，并在结论里标注这个悬而未决的点。`);
        const text = typeof answer === 'string' ? answer : String(answer?.text ?? answer?.answer ?? JSON.stringify(answer));
        try {
          ctx.board?.appendEvent?.(ctx.teamId, { kind: 'ask_reply', text, ts: Date.now() });
        } catch { /* 忽略 */ }
        return ok(`用户回答：${text}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  },
};

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 生成 OpenAI tools 格式的 schema 列表。
 * pick: 可选的工具名数组；不传 = 全部 14 个；传字符串数组之外的非法名会被忽略。
 */
export function schemas(pick) {
  const names = Array.isArray(pick) && pick.length ? pick : Object.keys(TOOLS);
  return names
    .filter((n) => TOOLS[n])
    .map((n) => ({
      type: 'function',
      function: {
        name: n,
        description: TOOLS[n].description,
        parameters: TOOLS[n].schema || { type: 'object', properties: {} },
      },
    }));
}

/** 给 system prompt 用的工具清单（模型看不到 schema 时至少知道有哪些工具）。 */
export function toolCatalog(pick) {
  const names = Array.isArray(pick) && pick.length ? pick : Object.keys(TOOLS);
  return names
    .filter((n) => TOOLS[n])
    .map((n) => `- ${n}：${TOOLS[n].description}`)
    .join('\n');
}

/**
 * 执行工具。args 允许直接传 JSON 字符串（模型走文本协议时常见）。
 * 永远返回 { ok, content }，异常一律转成人话，绝不把宿主炸掉。
 */
export async function invoke(name, args, ctx) {
  const toolName = String(name || '').trim();
  const tool = TOOLS[toolName];
  if (!tool) {
    return fail(`没有名为 "${toolName}" 的工具。可用工具：${Object.keys(TOOLS).join('、')}`);
  }
  let parsedArgs = args;
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      return fail(`工具 ${toolName} 的参数不是合法 JSON：${args.slice(0, 200)}`);
    }
  }
  if (parsedArgs == null) parsedArgs = {};
  if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    return fail(`工具 ${toolName} 的参数必须是对象（收到 ${Array.isArray(parsedArgs) ? '数组' : typeof parsedArgs}）。`);
  }
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : makeCtx({});
  try {
    const res = await tool.run(parsedArgs, safeCtx);
    if (typeof res === 'string') return ok(res);
    if (res && typeof res === 'object') return { ok: res.ok !== false, content: String(res.content ?? res.error ?? res.message ?? '（无输出）') };
    return ok(String(res ?? '（无输出）'));
  } catch (err) {
    const hint = err?.code === 'OUTSIDE_ROOT' ? '（安全策略：工具只能操作工作区内的路径）' : '';
    return fail(`工具 ${toolName} 执行失败：${shortError(err)}${hint}`);
  }
}

/** 工具名清单（给上层做白名单/调试用）。 */
export const TOOL_NAMES = Object.keys(TOOLS);

/** 模块信息：报告里要显示"工具带里有几个真家伙"。 */
export const TOOLBELT_INFO = {
  names: TOOL_NAMES,
  count: TOOL_NAMES.length,
  platform: process.platform,
};

export default { TOOLS, TOOL_NAMES, schemas, toolCatalog, invoke, makeCtx, resolveInside, inspectCommand, htmlToText, globToRegExp, clip };
