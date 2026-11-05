/**
 * engine/llm.js —— 超级 Agent 的大脑（三模式 + 文本工具协议）
 *
 * 契约（docs/CONTRACTS.md 2.5，签名不得改）：
 *   createBrain({ host, cfg }) => { mode, chat(...), models() }
 *
 * 为什么要三条腿：
 *   · host —— 用户装的 DSH 自己就配了模型，零配置直接能跑，这是默认最优路径；
 *   · api  —— 用户想用自己的 OpenAI 兼容中转/自建推理，直连最快；
 *   · cli  —— 前两条都不可用（离线、key 过期、宿主没暴露 llm 服务）时，
 *             借本机已登录的 claude / codex / dsh 一次性回答，至少别让 Agent 变哑巴。
 *
 * 关键设计：对外只有一个 chat()，输入输出形状统一。宿主/中转/CLI 的返回结构
 * 差异（OpenAI choices、AI SDK toolCalls、Anthropic content blocks、纯字符串…）
 * 全部在 normalizeCompletion 里抹平；模型不支持 tools 时，降级为
 * `<<<TOOL{json}TOOL>>>` 文本协议——这是所有纯文本模型都能用的最小公约数。
 */

import { spawn } from 'node:child_process';

/** 文本工具协议：模型不支持 function calling 时，用它把工具调用写在正文里。 */
export const TOOL_PROTOCOL = '<<<TOOL{json}TOOL>>>';

/** 给模型的协议说明（走文本协议时必须追加进 system，否则模型不知道这个约定）。 */
export const TOOL_PROTOCOL_PROMPT = [
  '你现在不能直接调用工具，只能用文本表达工具调用。规则如下：',
  '1) 需要调用工具时，单独输出一行：<<<TOOL{"name":"工具名","args":{...}}TOOL>>>',
  '   一次可以输出多行，每个工具一行；json 必须是严格 JSON（不要注释、不要尾逗号）。',
  '2) 工具结果会以 "【工具结果】工具名 -> ..." 的形式发回给你，然后你继续。',
  '3) 不需要再调用工具、可以给用户最终答复时，就正常输出正文，不要再写 TOOL 标记。',
  '4) 绝对不要编造工具结果；没有调用过的工具，就说你没调用。',
].join('\n');

const DEFAULT_API_TIMEOUT_MS = 120_000;
const DEFAULT_CLI_TIMEOUT_MS = 180_000;
/** 401/429 这类"可能是瞬时/可恢复"的状态，重试一次（任务书要求）。 */
const RETRY_STATUS = new Set([401, 402, 408, 409, 425, 429, 500, 502, 503, 504]);

/** 大脑里的错误统一带 code/status，方便上层决定要不要降级。 */
export class BrainError extends Error {
  constructor(message, { code = 'brain_error', status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/**
 * 归一 usage：不同供应商字段名完全不一样（prompt_tokens / inputTokens / in …）。
 * 统一成契约要求的 { in, out }，能拿到总额就带上 total，估出来的标 estimated。
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return { in: 0, out: 0 };
  const inTok = num(raw.in ?? raw.input ?? raw.prompt ?? raw.prompt_tokens ?? raw.promptTokens ?? raw.inputTokens ?? raw.input_tokens);
  const outTok = num(raw.out ?? raw.output ?? raw.completion ?? raw.completion_tokens ?? raw.completionTokens ?? raw.outputTokens ?? raw.output_tokens);
  const usage = { in: inTok, out: outTok };
  const total = num(raw.total ?? raw.total_tokens ?? raw.totalTokens ?? inTok + outTok);
  if (total) usage.total = total;
  if (raw.cost != null && Number.isFinite(Number(raw.cost))) usage.cost = Number(raw.cost);
  if (raw.estimated) usage.estimated = true;
  return usage;
}

/** 按字符粗估 token（中文约 1 字 1 token，英文约 4 字符 1 token）。只在 CLI 模式兜底用。 */
function estimateUsage(text) {
  const s = String(text || '');
  if (!s) return { in: 0, out: 0, estimated: true };
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  const rest = s.length - cjk;
  return { in: 0, out: Math.max(1, cjk + Math.ceil(rest / 4)), estimated: true };
}

/**
 * 从模型输出里抠 JSON —— 移植自 AgentDeck（D:\AgentDeck\service\server.py 的
 * extract_json，约 L7589）的实践，并扩展为对象/数组都支持：
 *   ① 先看 ```json ... ``` 围栏；② 再全文找第一个能配平的 { } 或 [ ]。
 * 为什么不能直接 JSON.parse：模型经常在 JSON 前后加"好的，方案如下"、
 * 或者把数组包在围栏里，硬解析一半概率失败，而这一步失败会让整个计划废掉。
 */
export function extractJson(text, { prefer = 'any' } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;

  const fenced = [];
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(raw))) fenced.push(m[1]);

  const candidates = [...fenced, raw];
  for (const chunk of candidates) {
    const direct = tryParse(chunk.trim());
    if (direct !== null) return direct;
    for (const cand of balancedCandidates(chunk)) {
      const val = tryParse(cand);
      if (val !== null) return val;
    }
  }
  return null;

  function tryParse(s) {
    if (!s) return null;
    if (s[0] !== '{' && s[0] !== '[') return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function* balancedCandidates(s) {
    const opens = prefer === 'object' ? ['{'] : prefer === 'array' ? ['['] : ['{', '['];
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (!opens.includes(ch)) continue;
      const close = ch === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < s.length; j += 1) {
        const c = s[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === ch) depth += 1;
        else if (c === close) {
          depth -= 1;
          if (depth === 0) {
            yield s.slice(i, j + 1);
            break;
          }
        }
      }
    }
  }
}

/**
 * 解析文本工具协议：`<<<TOOL{"name":"fs_read","args":{"path":"a"}}TOOL>>>`
 * 返回 { content（去掉标记后的正文）, toolCalls:[{name,args}] }。
 * 模型偶尔会写成 {"tool":..} / {"name":..,"arguments":..} / 干脆只写 {...}，
 * 这里都认；实在解析不出来就把原文留在 content 里，绝不吞掉模型的话。
 */
export function parseToolProtocol(text) {
  const raw = String(text ?? '');
  const toolCalls = [];
  const re = /<<<\s*TOOL\s*([\s\S]*?)\s*TOOL\s*>>>/g;
  let m;
  let stripped = raw;
  while ((m = re.exec(raw))) {
    const body = m[1].trim();
    const obj = extractJson(body, { prefer: 'object' });
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const name = String(obj.name ?? obj.tool ?? obj.tool_name ?? obj.function?.name ?? '').trim();
      const argsRaw = obj.args ?? obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {};
      if (name) toolCalls.push({ name, args: normalizeArgs(argsRaw) });
    }
  }
  if (toolCalls.length) {
    stripped = raw.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return { content: stripped, toolCalls };
}

function normalizeArgs(args) {
  if (args == null) return {};
  if (typeof args === 'string') {
    const parsed = extractJson(args, { prefer: 'object' });
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  if (typeof args === 'object' && !Array.isArray(args)) return args;
  return {};
}

function normalizeToolCall(call, idx = 0) {
  if (!call || typeof call !== 'object') return null;
  const fn = call.function || call.tool || {};
  const name = String(call.name ?? call.toolName ?? call.tool_name ?? fn.name ?? '').trim();
  const args = normalizeArgs(call.args ?? call.arguments ?? call.input ?? call.parameters ?? fn.arguments ?? fn.input ?? {});
  if (!name) return null;
  return { name, args, id: String(call.id ?? call.callId ?? call.toolCallId ?? `call_${idx}`) };
}

/**
 * 把宿主 / 中转 / CLI / AI SDK / Anthropic 各种返回形状抹平成契约形状。
 * 这是整个模块最脏也最值钱的一段：少一种形状，就会在某个宿主版本上直接崩。
 */
export function normalizeCompletion(raw, { model = '' } = {}) {
  if (raw == null) return { content: '', toolCalls: [], usage: { in: 0, out: 0 }, model };
  if (typeof raw === 'string') {
    const parsed = parseToolProtocol(raw);
    return { content: parsed.content, toolCalls: parsed.toolCalls, usage: estimateUsage(raw), model };
  }
  if (typeof raw !== 'object') return { content: String(raw), toolCalls: [], usage: { in: 0, out: 0 }, model };

  // ① 已经是契约形状（host 适配层直接返回）——最省事的一条。
  // 注意：必须排除带 text 字段的 AI SDK 形状，否则 { text:'答', toolCalls:[…] } 会被
  // 误判成"契约形状但正文为空"，把模型的正文整段丢掉（测试就是这么抓出来的）。
  if (
    Array.isArray(raw.toolCalls) &&
    (typeof raw.content === 'string' || raw.content == null) &&
    !('text' in raw) &&
    !('choices' in raw)
  ) {
    return {
      content: String(raw.content ?? ''),
      toolCalls: raw.toolCalls.map(normalizeToolCall).filter(Boolean),
      usage: normalizeUsage(raw.usage),
      model: String(raw.model || model || ''),
    };
  }

  // ② OpenAI 兼容（/chat/completions，含流式聚合后的形状）
  const choice = raw.choices?.[0];
  if (choice) {
    const msg = choice.message || choice.delta || {};
    const content = msg.content ?? choice.text ?? '';
    const calls = msg.tool_calls ?? msg.function_call ?? [];
    // function_call（老式单函数）不是数组，补成数组
    const list = Array.isArray(calls) ? calls : [calls];
    return {
      content: typeof content === 'string' ? content : flattenBlocks(content),
      toolCalls: list.map(normalizeToolCall).filter(Boolean),
      usage: normalizeUsage(raw.usage),
      model: String(raw.model || model || ''),
    };
  }

  // ③ AI SDK / DSH 可能的直出形状：{ text, toolCalls:[{toolName,args}] }
  if ('text' in raw || 'toolCalls' in raw || 'tool_calls' in raw) {
    const content = String(raw.text ?? raw.content ?? '');
    const calls = raw.toolCalls ?? raw.tool_calls ?? [];
    const callList = Array.isArray(calls) ? calls : [calls];
    return {
      content,
      toolCalls: callList.map(normalizeToolCall).filter(Boolean),
      usage: normalizeUsage(raw.usage ?? raw.tokens),
      model: String(raw.model || raw.modelId || model || ''),
    };
  }

  // ④ Anthropic 风格 content blocks：{ content:[{type:'text'},{type:'tool_use'}] }
  if (Array.isArray(raw.content)) {
    const blocks = raw.content;
    return {
      content: blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n').trim(),
      toolCalls: blocks
        .filter((b) => b?.type === 'tool_use')
        .map((b) => normalizeToolCall({ name: b.name, args: b.input, id: b.id }))
        .filter(Boolean),
      usage: normalizeUsage(raw.usage),
      model: String(raw.model || model || ''),
    };
  }

  // ⑤ 兜底：{ content: '...' } 或干脆啥都没有
  const content = String(raw.content ?? '');
  const parsed = content.includes('<<<TOOL') ? parseToolProtocol(content) : null;
  return {
    content: parsed ? parsed.content : content,
    toolCalls: parsed ? parsed.toolCalls : [],
    usage: normalizeUsage(raw.usage),
    model: String(raw.model || model || ''),
  };
}

function flattenBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return String(blocks ?? '');
  return blocks
    .map((b) => (typeof b === 'string' ? b : b?.text ?? b?.content ?? ''))
    .join('')
    .trim();
}

/** 统一消息格式：只保留 role/content，工具结果作为 role:'tool' 的文本喂回去。 */
function toOpenAIMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .filter((m) => m && m.role)
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : flattenBlocks(m.content);
      const out = { role: String(m.role), content };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
      return out;
    });
}

/** tools 同时接受 toolbelt.schemas() 的 OpenAI 形状和 {name,description,schema} 简写。 */
function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .map((t) => {
      if (!t) return null;
      if (t.type === 'function' && t.function) return t;
      const name = t.name || t.function?.name;
      const description = t.description || t.function?.description || '';
      const parameters = t.parameters || t.schema || t.function?.parameters || { type: 'object', properties: {} };
      if (!name) return null;
      return { type: 'function', function: { name, description, parameters } };
    })
    .filter(Boolean);
}

/** 把消息压成 CLI 模式要的一整段 prompt（CLI 只吃文本，没有多轮协议）。 */
export function messagesToPrompt(messages, { system } = {}) {
  const names = { system: '系统', user: '用户', assistant: '助手', tool: '工具结果' };
  const parts = [];
  if (system) parts.push(`【系统指令】\n${system}`);
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m?.role) continue;
    const text = typeof m.content === 'string' ? m.content : flattenBlocks(m.content);
    if (!text) continue;
    parts.push(`【${names[m.role] || m.role}】\n${text}`);
  }
  parts.push('【要求】只输出最终答复正文。');
  return parts.join('\n\n');
}

/** SSE 容错解析：把 `data: {...}` 行聚合成 OpenAI 非流式形状。 */
export function parseSse(text) {
  const raw = String(text ?? '');
  const chunks = [];
  const toolCalls = [];
  const seen = new Map();
  let role = 'assistant';
  let usage = null;
  let model = '';
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith(':') || !t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue; // 半截 JSON 直接跳过，SSE 里很常见（代理截断）
    }
    model = obj.model || model;
    if (obj.usage) usage = obj.usage;
    const choice = obj.choices?.[0];
    if (!choice) {
      // 有些中转把整段 completion 塞在 data 里
      if (obj.message || obj.content) chunks.push(obj);
      continue;
    }
    const delta = choice.delta || choice.message || {};
    role = delta.role || role;
    const c = delta.content;
    if (typeof c === 'string') chunks.push(c);
    else if (Array.isArray(c)) chunks.push(flattenBlocks(c));
    for (const [i, tc] of (delta.tool_calls || []).entries()) {
      const key = tc.index ?? tc.id ?? i;
      const prev = seen.get(key) || { id: tc.id, function: { name: '', arguments: '' } };
      if (tc.id) prev.id = tc.id;
      if (tc.function?.name) prev.function.name = (prev.function.name || '') + tc.function.name;
      if (tc.function?.arguments) prev.function.arguments = (prev.function.arguments || '') + tc.function.arguments;
      seen.set(key, prev);
      if (!toolCalls.includes(prev)) toolCalls.push(prev);
    }
  }
  const content = chunks.join('');
  const wrote = toolCalls.length > 0;
  if (!content && !wrote) return null;
  return {
    id: 'sse',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role, content, tool_calls: toolCalls.length ? toolCalls : undefined } }],
    usage: usage || undefined,
  };
}

function joinApiUrl(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (!b) return '';
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v\d+[a-z]*$/i.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`超时 ${ms}ms`)), Math.max(1, ms));
  const onAbort = () => ctrl.abort(signal.reason || new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
    },
  };
}

/** CLI 一次性回答的默认预设（真用起来时 cli.js 若在，会优先走它的 AGENT_PRESETS）。 */
const CLI_PRESETS = {
  claude: { cmd: 'claude', args: ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'json'] },
  codex: { cmd: 'codex', args: ['exec', '--skip-git-repo-check'] },
  dsh: { cmd: 'dsh', args: ['headless', '--json'] },
  gemini: { cmd: 'gemini', args: ['-p'] },
  qwen: { cmd: 'qwen', args: ['-p'] },
};

/** 从 CLI 的 stdout 里尽量抽出正文（claude --output-format json / dsh --json 会包一层）。 */
export function normalizeCliOutput(out) {
  const text = String(out ?? '').trim();
  if (!text) return '';
  if (text.startsWith('{') || text.startsWith('[')) {
    const obj = extractJson(text, { prefer: 'object' });
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const pick = obj.result ?? obj.text ?? obj.output ?? obj.response ?? obj.content ?? obj.answer;
      if (typeof pick === 'string' && pick.trim()) return pick.trim();
      // dsh headless 可能给 { messages:[...] } 这类，抓最后一条 assistant 文本
      const msgs = obj.messages || obj.events;
      if (Array.isArray(msgs)) {
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          const m = msgs[i];
          const t = m?.text ?? m?.content ?? m?.message;
          if (typeof t === 'string' && t.trim()) return t.trim();
        }
      }
    }
  }
  return text;
}

function spawnOnce({ cmd, args, prompt, cwd, timeoutMs, signal, env }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, [...(args || []), prompt], {
        cwd,
        env: { ...process.env, ...(env || {}) },
        windowsHide: true, // Windows 上不弹黑框
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new BrainError(`启动 ${cmd} 失败：${err.message}`, { code: 'cli_spawn' }));
      return;
    }
    const out = [];
    const err = [];
    let killed = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          killed = true;
          try {
            child.kill('SIGKILL');
          } catch { /* 忽略：进程可能已退出 */ }
        }, Math.max(1, timeoutMs))
      : null;
    const onAbort = () => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch { /* 忽略 */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', (b) => out.push(b));
    child.stderr?.on('data', (b) => err.push(b));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      reject(new BrainError(`${cmd} 无法执行：${e.message}`, { code: 'cli_spawn' }));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve({
        rc: killed ? 124 : code ?? 0,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8'),
        timedOut: killed,
      });
    });
  });
}

/**
 * 创建大脑。
 * @param {object} opts
 * @param {object} [opts.host] 宿主注入的 llm 句柄（有 .chat 即可；返回形状由 normalizeCompletion 兜）
 * @param {object} [opts.cfg]  { mode, baseUrl, apiKey, model, cliAgent, models, fetch, runCli,
 *                               timeoutMs, retryDelayMs, stream, headers, maxTokens, temperature }
 */
export function createBrain({ host, cfg = {} } = {}) {
  const config = { ...(cfg || {}) };
  const fetchImpl = typeof config.fetch === 'function' ? config.fetch : globalThis.fetch?.bind(globalThis);
  const modeChain = resolveChain({ host, cfg: config });
  const primary = modeChain[0];
  const apiUrl = joinApiUrl(config.baseUrl);
  const defaultModel = String(config.model || '');
  let cachedModels = null;
  let lastError = null;

  function hostUsable() {
    return Boolean(host && (typeof host.chat === 'function' || typeof host.complete === 'function' || typeof host.generate === 'function' || typeof host === 'function'));
  }

  async function callHost(req, { signal } = {}) {
    if (!hostUsable()) throw new BrainError('宿主没有可用的 llm 句柄', { code: 'host_missing' });
    const payload = {
      messages: toOpenAIMessages(req.messages),
      tools: toOpenAITools(req.tools),
      temperature: req.temperature ?? config.temperature,
      maxTokens: req.maxTokens ?? config.maxTokens,
      model: req.model || defaultModel || undefined,
      signal,
    };
    if (!payload.tools) delete payload.tools;
    if (payload.temperature == null) delete payload.temperature;
    if (payload.maxTokens == null) delete payload.maxTokens;
    if (!payload.model) delete payload.model;

    const fn = host.chat || host.complete || host.generate || host;
    const out = typeof fn === 'function' ? await fn.call(host, payload) : null;
    // 宿主可能给流式：聚合一下
    if (out && typeof out[Symbol.asyncIterator] === 'function') {
      const parts = [];
      let meta = {};
      for await (const chunk of out) {
        if (typeof chunk === 'string') parts.push(chunk);
        else if (chunk && typeof chunk === 'object') {
          const norm = normalizeCompletion(chunk, { model: defaultModel });
          if (norm.content) parts.push(norm.content);
          if (chunk.usage) meta = { ...meta, usage: chunk.usage };
          if (chunk.model) meta = { ...meta, model: chunk.model };
        }
        if (signal?.aborted) break;
      }
      return normalizeCompletion({ content: parts.join(''), ...meta }, { model: defaultModel });
    }
    return normalizeCompletion(out, { model: defaultModel });
  }

  async function apiCall(req, { signal, allowTools = true } = {}) {
    if (!apiUrl) throw new BrainError('没有配置 baseUrl，无法直连模型', { code: 'api_not_configured' });
    if (!fetchImpl) throw new BrainError('运行环境没有 fetch', { code: 'no_fetch' });
    const model = String(req.model || defaultModel || '');
    if (!model) throw new BrainError('没有配置 model', { code: 'no_model' });
    const tools = allowTools ? toOpenAITools(req.tools) : undefined;
    const body = {
      model,
      messages: toOpenAIMessages(req.messages),
      stream: Boolean(config.stream),
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = config.toolChoice || 'auto';
    }
    const temperature = req.temperature ?? config.temperature;
    const maxTokens = req.maxTokens ?? config.maxTokens;
    if (temperature != null) body.temperature = temperature;
    if (maxTokens != null) body.max_tokens = maxTokens;

    const headers = {
      'content-type': 'application/json',
      ...(config.headers || {}),
    };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

    const timeoutMs = config.timeoutMs || DEFAULT_API_TIMEOUT_MS;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const guard = withTimeout(signal, timeoutMs);
      try {
        const res = await fetchImpl(apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: guard.signal,
        });
        if (!res.ok) {
          const errText = await safeText(res);
          const retryable = RETRY_STATUS.has(res.status);
          const err = new BrainError(`模型接口 ${res.status}：${errText.slice(0, 300)}`, {
            code: 'api_status',
            status: res.status,
            retryable,
          });
          err.body = errText;
          if (retryable && attempt === 0) {
            lastErr = err;
            await sleep(config.retryDelayMs ?? 400);
            continue;
          }
          throw err;
        }
        const ctype = res.headers?.get?.('content-type') || '';
        const text = await safeText(res);
        if (ctype.includes('event-stream') || /^\s*data:/.test(text)) {
          const sse = parseSse(text);
          if (sse) return normalizeCompletion(sse, { model });
          throw new BrainError('模型返回了空的 SSE 流', { code: 'api_empty_stream', retryable: true });
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          const json2 = extractJson(text, { prefer: 'object' });
          if (!json2) throw new BrainError(`模型返回的不是 JSON：${text.slice(0, 200)}`, { code: 'api_bad_json' });
          json = json2;
        }
        return normalizeCompletion(json, { model });
      } catch (err) {
        const e = err instanceof BrainError ? err : new BrainError(`${err?.name || 'Error'}：${err?.message || err}`, { code: 'api_network', retryable: true });
        if (attempt === 0 && (e.retryable || e.code === 'api_bad_json')) {
          lastErr = e;
          await sleep(config.retryDelayMs ?? 400);
          continue;
        }
        throw e;
      } finally {
        guard.done();
      }
    }
    throw lastErr || new BrainError('模型接口调用失败', { code: 'api_failed' });
  }

  async function cliCall(req, { signal } = {}) {
    const agentId = String(config.cliAgent || 'claude');
    const prompt = messagesToPrompt(req.messages, { system: req.system });
    const cwd = config.cwd || process.cwd();
    const timeoutMs = config.cliTimeoutMs || DEFAULT_CLI_TIMEOUT_MS;

    // ① 优先用队友 cli.js 的成熟实现（它能处理中文编码、进程树、usage 解析）
    if (typeof config.runCli === 'function') {
      const res = await config.runCli({ agent: agentId, prompt, cwd, timeoutMs, signal });
      return normalizeCompletion({ content: normalizeCliOutput(res?.out ?? res?.stdout ?? res) , usage: res?.usage }, { model: `cli:${agentId}` });
    }
    try {
      const mod = await import('./cli.js');
      if (mod && typeof mod.runAgent === 'function') {
        const res = await mod.runAgent(agentId, prompt, { cwd, timeoutMs, signal });
        return normalizeCompletion({ content: normalizeCliOutput(res?.out ?? ''), usage: res?.meta?.usage }, { model: `cli:${agentId}` });
      }
    } catch { /* cli.js 还没就位：走下面的内置最小实现，别把大脑拖死 */ }

    const preset = CLI_PRESETS[agentId] || { cmd: agentId, args: [] };
    const res = await spawnOnce({ cmd: preset.cmd, args: preset.args, prompt, cwd, timeoutMs, signal });
    if (res.rc !== 0) {
      throw new BrainError(
        `本机 CLI（${agentId}）调用失败 rc=${res.rc}：${(res.err || res.out || '').slice(0, 300)}`,
        { code: 'cli_failed', status: res.rc },
      );
    }
    const text = normalizeCliOutput(res.out);
    if (!text) throw new BrainError(`本机 CLI（${agentId}）没有返回内容`, { code: 'cli_empty' });
    return normalizeCompletion({ content: text, usage: estimateUsage(text) }, { model: `cli:${agentId}` });
  }

  /**
   * 统一入口。
   * 先走主通道，失败就按 host → api → cli 顺序降级；
   * 每次降级都记到 brain.lastError / brain.trace 里，方便工具层如实汇报
   * "这次是借了谁的嘴回答的"。
   */
  async function chat({ messages, tools, temperature, maxTokens, model, system, signal } = {}) {
    const sysMsg = system ? [{ role: 'system', content: system }] : [];
    const req = {
      // system 单独放着：host/api 要拼成首条 system 消息，cli 要压进 prompt
      messages: [...sysMsg, ...(messages || [])],
      tools,
      temperature,
      maxTokens,
      model,
      system,
    };
    const errors = [];
    for (const mode of modeChain) {
      try {
        let result;
        if (mode === 'host') {
          try {
            result = await callHost(req, { signal });
          } catch (err) {
            // 宿主模型不认 tools 时，去掉工具、改用文本协议再问一次
            if (!/tool|function/i.test(String(err?.message || ''))) throw err;
            result = await callHost(
              { ...req, messages: [{ role: 'system', content: TOOL_PROTOCOL_PROMPT }, ...req.messages], tools: undefined },
              { signal },
            );
          }
        } else if (mode === 'api') {
          try {
            result = await apiCall(req, { signal, allowTools: true });
          } catch (err) {
            // 有的模型/中转不认 tools：去掉 tools 再问一次，靠文本协议兜底
            const noTools = err?.status === 400 || /tool|function/i.test(String(err?.message || ''));
            if (!noTools) throw err;
            result = await apiCall(
              { ...req, messages: [{ role: 'system', content: TOOL_PROTOCOL_PROMPT }, ...req.messages], tools: undefined },
              { signal, allowTools: false },
            );
          }
        } else {
          result = await cliCall(
            { ...req, system: [req.system, tools?.length ? TOOL_PROTOCOL_PROMPT : ''].filter(Boolean).join('\n\n') },
            { signal },
          );
        }

        // 文本协议兜底：无论哪条通道，正文里出现了 TOOL 标记就解析成 toolCalls
        if ((!result.toolCalls || !result.toolCalls.length) && String(result.content || '').includes('<<<TOOL')) {
          const parsed = parseToolProtocol(result.content);
          result = { ...result, content: parsed.content, toolCalls: parsed.toolCalls };
        }
        return { ...result, mode };
      } catch (err) {
        const e = err instanceof BrainError ? err : new BrainError(String(err?.message || err), { code: 'unknown' });
        errors.push(`${mode}: ${e.message}`);
        lastError = e;
        if (signal?.aborted) break; // 用户主动取消就不要再换通道了
      }
    }
    const detail = errors.length ? `（${errors.join(' / ')}）` : '';
    throw new BrainError(`所有模型通道都不可用${detail}`, { code: 'all_modes_failed', retryable: false });
  }

  function models() {
    if (cachedModels) return cachedModels.slice();
    const out = new Set();
    if (Array.isArray(config.models)) config.models.forEach((m) => out.add(String(m)));
    if (defaultModel) out.add(defaultModel);
    if (primary === 'host' && host) {
      const list = safeCall(host, ['models', 'listModels', 'availableModels']);
      if (Array.isArray(list)) list.forEach((m) => out.add(String(m?.id ?? m?.name ?? m)));
    }
    if (primary === 'cli') out.add(String(config.cliAgent || 'claude'));
    cachedModels = [...out].filter(Boolean);
    return cachedModels.slice();
  }

  return {
    mode: primary,
    modes: modeChain.slice(),
    chat,
    models,
    // 公开一点只读信息，工具层写报告时要用
    get lastError() {
      return lastError;
    },
    url: apiUrl,
    describe() {
      const where = primary === 'host' ? '宿主模型' : primary === 'api' ? `直连 ${apiUrl || '(未配置)'}` : `本机 CLI ${config.cliAgent || 'claude'}`;
      return `${where}（降级链：${modeChain.join(' → ')}）`;
    },
  };
}

function safeCall(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  for (const n of names) {
    if (typeof obj[n] === 'function') {
      try {
        return obj[n]();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 决定"这台机器上到底能走哪几条腿"。
 * cfg.mode 显式指定就把它排第一，但**仍然保留**其余可用通道做降级——
 * 用户配了 api 结果中转挂了时，用宿主模型顶上，体验远好过一次报错。
 */
export function resolveChain({ host, cfg = {} } = {}) {
  const usable = new Set();
  if (host && (typeof host.chat === 'function' || typeof host.complete === 'function' || typeof host.generate === 'function' || typeof host === 'function')) usable.add('host');
  if (cfg.baseUrl && cfg.model) usable.add('api');
  usable.add('cli'); // 本机 CLI 永远算"最后一条腿"，能不能跑由调用时决定
  const wanted = String(cfg.mode || '').toLowerCase();
  const order = ['host', 'api', 'cli'];
  if (wanted && order.includes(wanted)) {
    return [wanted, ...order.filter((m) => m !== wanted && usable.has(m))];
  }
  return order.filter((m) => usable.has(m));
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export default { createBrain, normalizeCompletion, normalizeUsage, extractJson, parseToolProtocol, parseSse, resolveChain, messagesToPrompt, TOOL_PROTOCOL, TOOL_PROTOCOL_PROMPT };
