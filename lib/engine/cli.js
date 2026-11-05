/**
 * lib/engine/cli.js —— 本机 CLI Agent 接入层（AgentDeck 接入层 · Part 1）
 *
 * 做什么：
 *   1) detectAgents()：查 PATH（Windows 还要按 PATHEXT 找 .cmd/.exe，并补几个
 *      npm -g / 桌面版内置 CLI 的目录），判断 claude / codex / dsh / gemini
 *      这些本机 CLI 到底有没有装，能装到的顺手读一下版本号。
 *   2) runAgent(spec, prompt, opts)：按各 CLI 的**成熟参数模板**起一次性进程，
 *      把 prompt 喂进去（优先 stdin，退而位置参数），再把它的 JSON / NDJSON /
 *      纯文本输出统一解析成 { rc, out, err, ms, meta }。
 *
 * 为什么要这么写：
 *   · 不拼 shell 字符串。Windows 的 cmd.exe 会吃掉引号、换行和部分中文转义，
 *     AgentDeck 线上验证过的做法是「参数数组 + stdin 喂 prompt + windowsHide」，
 *     这里直接移植，不重新发明。
 *   · 一律 windowsHide。插件跑在用户桌面会话里，弹黑框就是事故。
 *   · 超时/取消必须杀**进程树**。claude/codex/dsh 都会自己再拉 node 子进程，
 *     只 kill 父进程会留孤儿进程占住文件句柄和端口，下一次调用直接失败。
 *   · 输出解码按 UTF-8 严格解，失败回退 gb18030。国内 Windows 上 CLI 混着
 *     cmd.exe 的 OEM 代码页输出，硬解 UTF-8 会得到乱码而不是报错。
 *
 * 参数模板来源：D:\AgentDeck\service\server.py 的 AGENTS / _readonly_args /
 * run_cli / normalize_stdout / parse_usage（只读参考，那个项目不动）。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/** 读版本号最多等这么久：只读不跑模型，超时就当没读到，不能拖住入组。
 *  实测 `gemini --version` 要 7s（它启动时连带扫配置），5s 会漏，给到 10s。 */
const VERSION_TIMEOUT_MS = 10000;

/** 版本号缓存：面板会反复调 detectAgents，没必要每次都真起进程。 */
const VERSION_CACHE = new Map();
const VERSION_CACHE_TTL_MS = 10 * 60 * 1000;

/** 杀进程树后等它真的退出的时间。 */
const KILL_GRACE_MS = 3000;

function envPath(name, ...rest) {
  const base = process.env[name];
  return base ? path.join(base, ...rest) : '';
}

/**
 * 各 CLI 的参数模板 + 提示词投递方式。
 *
 * 字段说明（新增字段都是可选的，不破坏 CONTRACTS 里的 { cmd, args, detect }）：
 *   stdin       true = prompt 从 stdin 喂（不要位置参数）；false = prompt 当最后一个位置参数
 *   promptArg   走 stdin 时仍需要补的位置参数（codex/dsh 要一个 `-` 表示"从 stdin 读"）
 *   modelArg    指定模型时的开关；空数组说明这家不吃 --model
 *   sessionArg  复用会话的开关（只有 dsh 有）
 *   parse       stdout 解析器：claude-json / dsh-json / codex-text / text
 *   readonly    这家支持"只读运行"（claude 禁工具、codex sandbox read-only）；
 *               只是能力标记，真要只读得在 spec 里显式 readonly:true
 *   detect      探测用：命令名、版本参数、额外的搜索目录
 */
export const AGENT_PRESETS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    hint: 'Anthropic 官方',
    pkg: '@anthropic-ai/claude-code',
    cmd: 'claude',
    args: ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'json'],
    stdin: true,
    promptArg: '',
    modelArg: ['--model'],
    parse: 'claude-json',
    readonly: true,
    detect: { cmd: 'claude', versionArgs: ['--version'] },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    hint: 'OpenAI 官方',
    pkg: '@openai/codex',
    cmd: 'codex',
    args: ['exec', '--skip-git-repo-check', '--approve-for-me'],
    stdin: true,
    // codex exec 的位置参数 `-` 表示"任务从 stdin 读"
    promptArg: '-',
    modelArg: ['-m'],
    parse: 'codex-text',
    readonly: true,
    detect: { cmd: 'codex', versionArgs: ['--version'] },
  },
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness',
    hint: '宿主同源 CLI（headless + NDJSON 事件流）',
    cmd: 'dsh',
    args: ['headless', '--json'],
    stdin: true,
    promptArg: '-',
    modelArg: [],
    sessionArg: '--session-id',
    parse: 'dsh-json',
    readonly: false,
    detect: {
      cmd: 'dsh',
      versionArgs: ['--version'],
      // npm -g 的默认落点 + 桌面版内置 CLI 的旧布局，补进来免得 PATH 不全时漏认
      extraPaths: [
        path.join(os.homedir(), 'Apps', 'nodejs'),
        envPath('APPDATA', 'npm'),
        envPath('LOCALAPPDATA', 'Programs', 'nodejs'),
        envPath('PROGRAMFILES', 'nodejs'),
        envPath('LOCALAPPDATA', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin'),
        envPath('PROGRAMFILES', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin'),
      ].filter(Boolean),
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    hint: 'Google',
    pkg: '@google/gemini-cli',
    cmd: 'gemini',
    args: ['-p'],
    stdin: false,
    promptArg: null,
    modelArg: ['-m'],
    parse: 'text',
    readonly: false,
    detect: { cmd: 'gemini', versionArgs: ['--version'] },
  },
  custom: {
    id: 'custom',
    label: '自定义 CLI',
    hint: '任何命令行 Agent：给 cmd + args + prompt 投递方式即可',
    cmd: '',
    args: [],
    stdin: false,
    promptArg: null,
    modelArg: [],
    parse: 'text',
    readonly: false,
    detect: { cmd: '', versionArgs: ['--version'] },
  },
};

/** 可被 detectAgents 探测的模板（custom 是空壳，探测没意义）。 */
const DETECTABLE = ['claude', 'codex', 'dsh', 'gemini'];

// ── 命令解析 ───────────────────────────────────────────────

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 读环境变量，容忍大小写差异。
 *
 * 为什么需要：Windows 进程环境里的 key 常常是 `Path` / `Pathext`（不是全大写），
 * 而 `{ ...process.env }` 这种快照会把**原始大小写**带过来（runAgent 正是这么造 env 的）。
 * 直接写 `env.PATH` 会拿到 undefined，于是一边探测得到（直接读 process.env，大小写不敏感）、
 * 一边执行找不到——127 的另一半原因就在这里。
 */
function envValue(env, name) {
  if (!env) return '';
  return env[name] ?? env[name.toLowerCase()] ?? env[name[0] + name.slice(1).toLowerCase()] ?? '';
}

/**
 * 在 PATH（+ 额外目录）里找一个可执行文件，返回绝对路径或 null。
 *
 * 为什么不用 `which`/`where`：a) 多起一个进程纯属浪费；b) `where` 返回的第一条
 * 可能是没有可执行权限的 sh 脚本（本机 D:\ClaudeCode\claude 就是 bash 脚本，
 * Node 的 spawn 根本起不来），必须按 PATHEXT 优先挑 .cmd/.exe。
 */
export function resolveCommand(name, { env = process.env, extraPaths = [], cwd = process.cwd() } = {}) {
  if (!name) return null;
  const raw = String(name).trim();
  if (!raw) return null;

  const exts = IS_WIN
    ? String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [''];

  // 已经带扩展名（claude.cmd）就按原样找；否则按 PATHEXT 顺序补扩展名，最后才试原样
  // （无扩展名的 sh 脚本在 Windows 上 spawn 不起来，所以放在最后，仅作兜底）
  const hasExt = IS_WIN && exts.some((e) => raw.toLowerCase().endsWith(e));
  const suffixes = hasExt ? [''] : [...exts, ''];

  const tryFind = (base) => {
    for (const s of suffixes) if (isFile(base + s)) return base + s;
    return null;
  };

  // 带路径分隔符 / 盘符：当作相对或绝对路径处理，不查 PATH
  // 相对路径按 runAgent 的 cwd 解析（不是 process.cwd()），否则在别的目录调就会找错文件
  if (/[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) return tryFind(path.resolve(cwd, raw));

  const dirs = [...String(envValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean), ...extraPaths];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir) continue;
    const key = IS_WIN ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = tryFind(path.join(dir, raw));
    if (hit) return hit;
  }
  return null;
}

/**
 * 把 [cmd, args] 变成真正能 spawn 的 [exe, argv]。
 *
 * Windows 上 .cmd/.bat 不是可执行文件，必须经 cmd.exe 转一手；
 * 直接 spawn 会 EINVAL。这是 Node 文档里写明的限制。
 */
function wrapInvocation(cmd, args, env = process.env) {
  const list = Array.isArray(args) ? [...args] : [];
  if (IS_WIN && /\.(cmd|bat)$/i.test(String(cmd))) {
    const comspec = envValue(env, 'ComSpec') || process.env.ComSpec || 'cmd.exe';
    // /d 跳过 AutoRun，/s 让引号规则可预期，/c 执行完就退
    return [comspec, ['/d', '/s', '/c', cmd, ...list]];
  }
  return [cmd, list];
}

// ── 发现（detectAgents）────────────────────────────────────

/**
 * 读 CLI 的版本号：只跑 --version，不碰模型，不烧配额。
 * 任何异常/超时都返回 undefined——探测失败不能影响入组。
 */
function readVersion(cmd, args, { env = process.env, timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const [exe, argv] = wrapInvocation(cmd, args || ['--version'], env);
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(exe, argv, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return finish(undefined);
    }
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(undefined);
    }, Math.max(1000, Number(timeoutMs) || VERSION_TIMEOUT_MS));
    const collect = (buf) => {
      if (out.length > 4000) return;
      out += buf.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect); // 版本信息偶尔打 stderr，一起收
    child.on('error', () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line =
        String(out)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean) || '';
      finish(line ? line.slice(0, 120) : undefined);
    });
  });
}

/**
 * 探测本机装了哪些 CLI Agent。
 *
 * 返回顺序固定（claude/codex/dsh/gemini），方便前端稳定渲染。
 * 默认会读版本号；只读 --version，不会调用模型。
 */
export async function detectAgents({ env = process.env, withVersion = true, timeoutMs = VERSION_TIMEOUT_MS } = {}) {
    return Promise.all(
    DETECTABLE.map(async (id) => {
      const preset = AGENT_PRESETS[id];
      const detect = preset.detect || {};
      const found = resolveCommand(detect.cmd || preset.cmd, { env, extraPaths: detect.extraPaths });
      const item = { id, label: preset.label, available: Boolean(found), cmd: found || preset.cmd };
      if (found && withVersion) {
        const hit = VERSION_CACHE.get(found);
        let version = hit && Date.now() - hit.at < VERSION_CACHE_TTL_MS ? hit.version : undefined;
        if (!version) {
          version = await readVersion(found, detect.versionArgs || ['--version'], { env, timeoutMs });
          if (version) VERSION_CACHE.set(found, { version, at: Date.now() });
        }
        if (version) item.version = version;
      }
      return item;
    }),
  );
}

// ── 进程树清理 ─────────────────────────────────────────────

/**
 * 杀掉一个子进程**及其整棵进程树**。
 *
 * Windows 用 taskkill /T /F（node 的子进程不会自动陪葬）；
 * POSIX 靠 detached 建的进程组，先 SIGTERM 再补 SIGKILL。
 * 全程静默：taskkill 找不到进程会往 stderr 写东西，但那不是错误。
 */
export function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const pid = child.pid;
  if (!pid) return;
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 8000,
      });
    } catch {
      /* taskkill 不在就退化成 child.kill */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经退出了 */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* 忽略 */
    }
  }, 1500);
  timer.unref?.();
}

// ── 输出解码 ───────────────────────────────────────────────

/**
 * 字节流解码：优先严格 UTF-8，失败回退 gb18030（Node 全量 ICU 才支持）。
 * 为什么不用 buf.toString('utf8')：它会把坏字节替换成 U+FFFD，
 * 于是 GBK 输出变成一屏问号，用户以为是乱码 bug 而不是编码问题。
 */
function decodeBuffer(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    /* 不是 UTF-8，继续试 */
  }
  for (const enc of ['gb18030', 'gbk', 'big5']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {
      /* 换下一个 */
    }
  }
  return buf.toString('utf8');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 去掉 CLI 认不出来的模型名后缀（如 `[1m]`，中转侧的上下文标记）。 */
export function cleanModelName(m) {
  if (!m) return '';
  return String(m).trim().replace(/\[[0-9a-zA-Z_]+\]$/, '');
}

// ── 输出解析 ───────────────────────────────────────────────

function clampText(s) {
  return typeof s === 'string' ? s : s == null ? '' : String(s);
}

/**
 * Claude Code `--output-format json` 的解析。
 *
 * 真实踩过的坑（照 AgentDeck 的注释抄下来，避免再踩）：
 *   Claude Code 会在 stdout 最前面打一行自己的日志（`[claude-code:unrecognized_model] {...}`），
 *   所以不能假设"整段就是一个 JSON"，必须逐行从后往前找真正的 JSON 记录；
 *   报错时 result 可能不是字符串，必须先判 is_error 再取 result，
 *   否则原始 JSON 残片会被当成正文发进群里。
 */
function parseClaudeJson(raw) {
  const t = clampText(raw).trim();
  const lines = t.split(/\r?\n/);

  const fromObject = (data) => {
    const meta = {};
    const mu = data.modelUsage;
    if (mu && typeof mu === 'object' && !Array.isArray(mu)) {
      const model = Object.keys(mu)[0];
      if (model) {
        const row = mu[model] || {};
        meta.model = model;
        meta.usage = { in: num(row.inputTokens), out: num(row.outputTokens) };
        meta.cost = num(row.costUSD);
      }
    } else if (data.usage && typeof data.usage === 'object') {
      meta.usage = { in: num(data.usage.input_tokens), out: num(data.usage.output_tokens) };
      meta.cost = num(data.total_cost_usd);
    }
    if (data.model && !meta.model) meta.model = String(data.model);
    if (data.session_id) meta.sessionId = String(data.session_id);
    if (data.subtype) meta.subtype = String(data.subtype);
    return meta;
  };

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const meta = fromObject(data);
    if (data.is_error) {
      const detail = String(data.subtype || data.result || '').trim();
      return { text: `[CLI 报错] ${detail || '模型返回了错误结果'}`, ...meta };
    }
    if (typeof data.result === 'string') return { text: data.result, ...meta };
    // 既没有 result 也不是报错（例如 usage 明细行），继续往前找真正的结果行
  }

  // 兜底：整段一个 JSON（没有换行 / 只有一行日志时走这里）
  if (t.startsWith('{') && ('"result"' in t || '"is_error"' in t)) {
    try {
      const data = JSON.parse(t);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const meta = fromObject(data);
        if (data.is_error) {
          const detail = String(data.subtype || data.result || '').trim();
          return { text: `[CLI 报错] ${detail || '模型返回了错误结果'}`, ...meta };
        }
        if (typeof data.result === 'string') return { text: data.result, ...meta };
      }
    } catch {
      /* 不是完整 JSON，落回原文 */
    }
  }
  return { text: t };
}

/**
 * dsh `headless --json` 的解析：逐行 JSON 事件。
 * 事件类型（AgentDeck 线上实测）：session / status / final；
 * 正文只取最后一条 final.text，usage 由 status.usage 累加。
 */
function parseDshJson(raw) {
  const t = clampText(raw);
  let sessionId = '';
  let final = '';
  let model = '';
  let stopReason = '';
  let inTok = 0;
  let outTok = 0;

  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.type) {
      case 'session':
        sessionId = ev.sessionId || ev.session_id || sessionId;
        break;
      case 'status': {
        const u = ev.usage || {};
        inTok += num(u.inputTokens ?? u.input_tokens);
        outTok += num(u.outputTokens ?? u.output_tokens);
        if (u.model) model = String(u.model);
        break;
      }
      case 'final':
        if (typeof ev.text === 'string') final = ev.text;
        if (ev.model) model = String(ev.model);
        stopReason = ev.stopReason || ev.stop_reason || stopReason;
        break;
      case 'error':
        if (!final) final = String(ev.message || ev.text || '');
        break;
      default:
        break;
    }
  }

  const out = { text: final || t.trim() };
  if (sessionId) out.sessionId = sessionId;
  if (inTok || outTok) out.usage = { in: inTok, out: outTok };
  if (model) out.model = model;
  if (stopReason) out.stopReason = String(stopReason);
  return out;
}

/** codex exec：正文是纯文本，末尾自带 `tokens used\n12,547`；把这段元数据剥掉。 */
function parseCodexText(raw) {
  const t = clampText(raw);
  const m = t.match(/\n?\s*tokens used\s*\n?\s*([\d,]+)\s*$/i);
  if (!m) return { text: t.trim() };
  const outTok = num(m[1].replace(/,/g, ''));
  return { text: t.slice(0, m.index).trim(), usage: { in: null, out: outTok } };
}

function parseCliOutput(kind, raw) {
  switch (kind) {
    case 'claude-json':
      return parseClaudeJson(raw);
    case 'dsh-json':
      return parseDshJson(raw);
    case 'codex-text':
      return parseCodexText(raw);
    default:
      return { text: clampText(raw).trim() };
  }
}

// ── 只读模式 ───────────────────────────────────────────────

/**
 * 把参数改成"只读/不写文件"（移植 server.py 的 _readonly_args）。
 *
 * 为什么要：审查者、调研者这类角色只该看，不该动项目文件。
 *   · claude：禁掉 --permission-mode / --output-format，最后追加 `--tools ""`，
 *     让它只能把答案写 stdout（带 plan 模式时 Claude 会把方案写进自己的计划文件，
 *     最后只回一句"计划已写入…"，正文就丢了）。
 *   · codex：剔掉审批/沙箱开关，`-a never` 必须放在 exec **前面**（clap 的
 *     顶层参数，放 exec 后面直接退出码 2），最后补 `--sandbox read-only`。
 * 认不出是哪家就原样返回——宁可让它自己判断，也不要传错参数直接报错。
 */
function readonlyArgs(agentId, args) {
  const list = Array.isArray(args) ? [...args] : [];
  if (agentId === 'claude') {
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      if ((list[i] === '--permission-mode' || list[i] === '--output-format' || list[i] === '--tools') && i + 1 < list.length) {
        i += 1; // 连同值一起丢掉
        continue;
      }
      out.push(list[i]);
    }
    if (!out.includes('-p') && !out.includes('--print')) out.unshift('-p');
    return [...out, '--tools', ''];
  }
  if (agentId === 'codex') {
    const drop = new Set([
      '--approve-for-me',
      '--full-auto',
      '--yolo',
      '--dangerously-bypass-approvals-and-sandbox',
      '--sandbox',
      '-s',
      '--ask-for-approval',
      '-a',
      // 上面这些开关的取值
      'read-only',
      'workspace-write',
      'danger-full-access',
      'on-request',
      'never',
    ]);
    const out = list.filter((a) => !drop.has(a));
    const at = out.indexOf('exec');
    const withApproval = at >= 0 ? [...out.slice(0, at), '-a', 'never', ...out.slice(at)] : ['-a', 'never', ...out];
    return [...withApproval, '--sandbox', 'read-only'];
  }
  return list;
}

// ── 调用（runAgent）────────────────────────────────────────

/**
 * 起一个 CLI Agent，跑一条 prompt，等它结束。
 *
 * @param {object|string} spec
 *   - 字符串：AGENT_PRESETS 的 id（claude/codex/dsh/gemini）
 *   - 对象：{ id, cmd, args, cwd?, env?, timeoutMs?, transport:'cli',
 *             stdin?, promptArg?, model?, sessionId?, readonly? }
 * @param {string} prompt 完整指令
 * @param {object} opts { cwd, timeoutMs=0, signal, onChunk(kind,text), stdinText }
 * @returns {Promise<{rc:number, out:string, err:string, ms:number, meta:object}>}
 *   rc 约定：0 成功 / 124 超时 / 130 被取消 / 127 起不来 / 其它为 CLI 自己的退出码
 *
 * 失败不抛异常：CLI 跑挂了、超时了、被取消了，都通过 rc + err 表达，
 * 上层（toolbelt 的 agent_run）据此如实汇报"失败原因"，而不是整棵树炸掉。
 */
export async function runAgent(spec, prompt, opts = {}) {
  const startedAt = Date.now();
  const isNamed = typeof spec === 'string';
  if (isNamed && !AGENT_PRESETS[spec]) {
    throw new Error(`runAgent: 未知的 agent「${spec}」，可选：${Object.keys(AGENT_PRESETS).join(' / ')}`);
  }
  const base = isNamed ? AGENT_PRESETS[spec] : AGENT_PRESETS[spec?.id] || AGENT_PRESETS.custom;
  const preset = isNamed ? base : { ...base, ...(spec || {}) };
  if (preset.transport && preset.transport !== 'cli') {
    throw new Error(`runAgent 只负责本机 CLI；transport=${preset.transport} 请走 bridge.call()`);
  }
  if (!preset.cmd) throw new Error('runAgent: 缺少 cmd（自定义 CLI 必须给可执行文件名）');

  const agentId = preset.id || (isNamed ? spec : 'custom');
  const promptText = prompt == null ? '' : String(prompt);
  const cwd = opts.cwd || preset.cwd || process.cwd();
  const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? preset.timeoutMs ?? 0) || 0);
  const signal = opts.signal;

  // 子进程环境：统一 UTF-8，避免 Python/node 的 CLI 在中文 Windows 上输出 mojibake
  const env = { ...process.env, ...(preset.env || {}) };
  if (IS_WIN) {
    if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = 'utf-8';
    if (!env.PYTHONUTF8) env.PYTHONUTF8 = '1';
  }

  // 参数拼装顺序：基础模板 →（只读化）→ 模型 / 会话 → 提示词位置参数
  // readonly 在预设里只是"这家支持只读运行"的能力标记，是否真只读由调用方显式要求：
  // 团队里的 Agent 默认要能写文件，否则干不了活。
  const wantReadonly = !isNamed && spec?.readonly === true;
  let args = wantReadonly ? readonlyArgs(agentId, preset.args) : [...(preset.args || [])];
  if (preset.model && preset.modelArg?.length) args.push(...preset.modelArg, cleanModelName(preset.model));
  if (preset.sessionArg && preset.sessionId) args.push(preset.sessionArg, String(preset.sessionId));

  // 提示词投递：stdin 优先（避开 cmd.exe 的引号/换行/中文转义坑），否则位置参数
  const useStdin = Boolean(preset.stdin);
  if (useStdin) {
    if (preset.promptArg) args.push(preset.promptArg);
  } else {
    args.push(promptText);
  }
  const stdinText = opts.stdinText != null ? String(opts.stdinText) : useStdin ? promptText : undefined;

  // 裸命令名必须先解析成绝对路径再 spawn：Windows 的 spawn 不做 PATHEXT 展开，
  // 直接 spawn('claude') 一定 ENOENT；而 npm 全局装的 CLI 全是 .cmd 垫片，只有
  // 「绝对路径 + cmd.exe 转一手」才起得来（wrapInvocation 负责后半句）。
  // 探测走的是 resolveCommand，这里不补上就会出现"面板显示已安装、一跑就 127"的分裂。
  const resolved = resolveCommand(preset.cmd, {
    env,
    cwd,
    extraPaths: preset.detect?.extraPaths || preset.extraPaths || [],
  });
  if (!resolved) {
    return {
      rc: 127,
      out: '',
      err: `找不到可执行文件「${preset.cmd}」：这台机器没装，或者它不在 PATH 里`,
      ms: Date.now() - startedAt,
      meta: { agentId, cmd: preset.cmd },
    };
  }

  const [exe, argv] = wrapInvocation(resolved, args, env);
  const meta = { agentId, cmd: resolved };

  let child;
  try {
    child = spawn(exe, argv, {
      cwd,
      env,
      windowsHide: true,
      detached: !IS_WIN, // POSIX 下建进程组，取消时能整组带走
      stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      rc: 127,
      out: '',
      err: `无法启动 ${exe}：${err?.message || err}`,
      ms: Date.now() - startedAt,
      meta,
    };
  }

  const outChunks = [];
  const errChunks = [];
  // 流式解码器只服务 onChunk；最终文本用 decodeBuffer 单独解（避免解码器状态被消费两次）
  const streamOut = new TextDecoder('utf-8');
  const streamErr = new TextDecoder('utf-8');
  const emit = (kind, text) => {
    if (!text || typeof opts.onChunk !== 'function') return;
    try {
      opts.onChunk(kind, text);
    } catch {
      /* 回调自己炸了不能影响子进程 */
    }
  };

  child.stdout?.on('data', (buf) => {
    outChunks.push(buf);
    emit('out', streamOut.decode(buf, { stream: true }));
  });
  child.stderr?.on('data', (buf) => {
    errChunks.push(buf);
    emit('err', streamErr.decode(buf, { stream: true }));
  });

  if (child.stdin) {
    child.stdin.on('error', () => {
      /* 子进程提前退出会 EPIPE，忽略 */
    });
    try {
      child.stdin.end(stdinText ?? '', 'utf8');
    } catch {
      /* 忽略 */
    }
  }

  let timedOut = false;
  let cancelled = false;
  const stop = () => {
    killProcessTree(child);
  };
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs)
      : null;
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener?.('abort', onAbort, { once: true });
  }

  const closed = await new Promise((resolve) => {
    let settled = false;
    const done = (code, error) => {
      if (settled) return;
      settled = true;
      resolve({ code, error });
    };
    child.on('error', (error) => done(null, error));
    child.on('close', (code) => done(code, null));
  });

  if (timer) clearTimeout(timer);
  signal?.removeEventListener?.('abort', onAbort);

  // 给杀进程树留一点收尾时间，然后再兜一层，确保没有残留
  if ((timedOut || cancelled) && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, Math.min(200, KILL_GRACE_MS)));
  }

  const rawOut = decodeBuffer(Buffer.concat(outChunks));
  const rawErr = decodeBuffer(Buffer.concat(errChunks));
  const parsed = parseCliOutput(preset.parse, rawOut);

  let rc = closed.error ? 127 : closed.code == null ? -1 : closed.code;
  if (timedOut) rc = 124;
  else if (cancelled) rc = 130;

  const errParts = [];
  if (closed.error) errParts.push(`启动失败：${closed.error.message || closed.error}`);
  if (rawErr.trim()) errParts.push(rawErr.trimEnd());
  if (timedOut) errParts.push(`超时 ${timeoutMs}ms，已杀进程树`);
  if (cancelled) errParts.push('已取消（signal abort），已杀进程树');

  if (parsed.model) meta.model = parsed.model;
  if (parsed.usage) meta.usage = parsed.usage;
  if (parsed.cost != null) meta.cost = parsed.cost;
  if (parsed.sessionId) meta.sessionId = parsed.sessionId;
  if (parsed.stopReason) meta.stopReason = parsed.stopReason;
  if (parsed.subtype) meta.subtype = parsed.subtype;
  if (timedOut) meta.timedOut = true;
  if (cancelled) meta.cancelled = true;
  meta.exitCode = closed.code;
  meta.transport = 'cli';

  return {
    rc,
    out: parsed.text,
    err: errParts.join('\n'),
    ms: Date.now() - startedAt,
    meta,
  };
}

export default { AGENT_PRESETS, detectAgents, runAgent, resolveCommand, killProcessTree, cleanModelName };
