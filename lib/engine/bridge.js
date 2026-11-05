/**
 * lib/engine/bridge.js —— 外部 Agent 接入层（AgentDeck 接入层 · Part 2）
 *
 * 做什么：把"别人的 Agent"统一成两个动作
 *   probe(manifest)        探活：还能不能用、能用哪些模型。入组前跑一次，8s 超时。
 *   call(manifest, prompt) 真跑一轮：拿回正文 + 用量 + 耗时。
 *
 * 支持五种 transport（KINDS）：
 *   acp-http  Agent Client Protocol（JSON-RPC 2.0 over HTTP + SSE）。
 *             桌面版 WorkBuddy / CodeBuddy 没有 CLI，但在本地开了 ACP Gateway，
 *             这条路让"没有命令行的 Agent"也能像 CLI 一样进组。
 *   openai    任何 OpenAI 兼容服务（Ollama / LM Studio / 各种中转站）。
 *   cdp       Chrome DevTools Protocol：给已经登录好的桌面 App 代打字。
 *             好处是不用 API Key、不用重登录；坏处是慢、且要人别抢鼠标。
 *   adbp      自研 AgentDeck Bridge Protocol 的**客户端侧**：
 *             只做"这个端点是不是 ADBP 服务"的探活 + 投递一条消息。
 *             ADBP v1 是「拉取式」协议（外部 Agent 轮询 /tasks 领活），
 *             没有同步问答路由，所以这里的 call 是**投递语义、不是问答语义**，
 *             返回值里 out 为空、meta.delivered=true，别指望拿回答。
 *   cli       本机命令行 Agent，转给 cli.js 的 runAgent，保持 call() 形状一致。
 *
 * 为什么失败也返回对象、不抛异常：
 *   上层（toolbelt 的 agent_run / 依赖链）靠 ok/rc 如实汇报"谁失败了、为什么"。
 *   抛异常会把整条依赖链炸掉，而产品承诺是"任何一个 Agent 挂了都不拖垮团队"。
 *
 * 为什么每个请求都自己算超时并区分错误类型：
 *   探活最常见的失败是"端口没开"和"服务没响应"，用户看不懂 `fetch failed`。
 *   这里统一翻成中文原因（连接被拒绝 / 超时 / HTTP 401…），面板上直接能读懂。
 */

import { runAgent, detectAgents, resolveCommand, AGENT_PRESETS } from './cli.js';

/** 契约里的五种 transport。 */
export const KINDS = ['acp-http', 'openai', 'cdp', 'adbp', 'cli'];

const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const DEFAULT_CALL_TIMEOUT_MS = 120000;

/** CDP 轮询节奏（和 AgentDeck 线上一致：2.5s 一次，避免把页面 DOM 拖死）。 */
const CDP_POLL_MS = 2500;
/** 页面上出现这些字样时说明还在生成，不能当成最终答案。 */
const CDP_THINKING = /正在思考|正在生成|Thinking|Stop generating|停止生成/i;
/** 桌面聊天页的输入框选择器（contenteditable 或 textarea 两种主流实现）。 */
const CDP_EDITOR_SEL = '[contenteditable="true"],[contenteditable=""],textarea';

// ── 小工具 ────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}：${String(body || '').slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = String(body || '');
  }
}

function joinUrl(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
}

/** 把超时和外部取消合到一个 AbortSignal 上（Node 20+ 有 AbortSignal.any）。 */
function withDeadline(timeoutMs, outerSignal) {
  const list = [];
  if (timeoutMs > 0) list.push(AbortSignal.timeout(timeoutMs));
  if (outerSignal) list.push(outerSignal);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

const NET_CODES = {
  ECONNREFUSED: '连接被拒绝：端口没开、或服务没启动',
  ECONNRESET: '连接被重置',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: 'DNS 暂时不可用',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
  UND_ERR_BODY_TIMEOUT: '读取响应超时',
};

/** 沿着 cause / AggregateError.errors 往下挖错误码（fetch 的失败是被包了好多层的）。 */
function errorCode(err, depth = 0) {
  if (!err || depth > 6) return '';
  if (typeof err === 'string') return '';
  const direct = err.code || err.errno;
  if (direct && typeof direct === 'string') return direct;
  const fromCause = errorCode(err.cause, depth + 1);
  if (fromCause) return fromCause;
  if (Array.isArray(err.errors) && err.errors.length) return errorCode(err.errors[0], depth + 1);
  return '';
}

/** 把各种原始错误翻成人能看懂的中文原因。 */
function describeError(err) {
  if (!err) return '未知错误';
  if (err instanceof HttpError) {
    // 鉴权失败是最常见的接入问题，单独给一句人话（别让用户去猜 401 是谁的问题）
    if (err.status === 401 || err.status === 403) {
      return `鉴权失败（HTTP ${err.status}）：apiKey / token 不对、或请求没带上`;
    }
    return err.message;
  }
  const name = err.name || '';
  if (name === 'TimeoutError' || name === 'AbortError' || /aborted/i.test(String(err.message))) {
    return '超时：端点没在限定时间内响应';
  }
  const code = errorCode(err);
  if (code && NET_CODES[code]) return `${NET_CODES[code]}（${code}）`;
  const msg = String(err.message || err);
  if (/fetch failed/i.test(msg)) return `网络请求失败${code ? `（${code}）` : ''}`;
  return msg.slice(0, 300);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(res.status, text);
  }
}

async function requestJson(url, init, { timeoutMs, signal } = {}) {
  const res = await fetch(url, { ...init, signal: withDeadline(timeoutMs, signal) });
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
  return readJson(res);
}

/** 按行读响应体（SSE 用）。Node 的 web ReadableStream 支持 for await。 */
async function readLines(res, onLine) {
  if (!res.body) {
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line);
    return;
  }
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).replace(/\r$/, '');
      buf = buf.slice(at + 1);
      if (line.trim()) onLine(line);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) onLine(buf);
}

function isEventStream(res) {
  return /text\/event-stream/i.test(res.headers.get('content-type') || '');
}

/** 读一段 SSE/JSON 混着的响应，把每条 JSON 消息交给 handler。 */
async function readMessages(res, handler) {
  if (isEventStream(res)) {
    await readLines(res, (line) => {
      const s = line.trim();
      if (!s.startsWith('data:')) return; // 注释行 / event: 行一律跳过
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        handler(JSON.parse(payload));
      } catch {
        /* 半个事件：忽略 */
      }
    });
    return;
  }
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('data:')) {
    for (const line of trimmed.split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        handler(JSON.parse(payload));
      } catch {
        /* 忽略 */
      }
    }
    return;
  }
  try {
    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) data.forEach(handler);
    else handler(data);
  } catch {
    throw new HttpError(res.status, trimmed);
  }
}

// ── ACP（JSON-RPC over HTTP + SSE）─────────────────────────

/** 允许 manifest.url 填网关根 / `/api/v1` / `/api/v1/acp` 三种形态。 */
function acpBase(url) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base) return '';
  if (/\/api\/v1\/acp$/i.test(base)) return base;
  if (/\/api\/v1$/i.test(base)) return `${base}/acp`;
  return `${base}/api/v1/acp`;
}

function acpHeaders(conn) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'acp-connection-id': conn.connectionId,
  };
  if (conn.sessionToken) headers.authorization = `Bearer ${conn.sessionToken}`;
  return headers;
}

/** 建立 ACP 连接：拿 connectionId + sessionToken。 */
async function acpConnect(base, opts) {
  const data = await requestJson(
    joinUrl(base, '/connect'),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    opts,
  );
  if (!data || !data.connectionId) throw new Error(`connect 没有返回 connectionId：${JSON.stringify(data).slice(0, 200)}`);
  return { connectionId: String(data.connectionId), sessionToken: String(data.sessionToken || '') };
}

/**
 * 发一条 JSON-RPC 请求，边收边处理 SSE 通知。
 * 返回 { result, texts, updates, error }：
 *   result  = 与 id 匹配的 result 对象
 *   texts   = agent_message_chunk 拼起来的正文片段
 */
async function acpRpc(base, conn, payload, { timeoutMs, signal, onChunk } = {}) {
  const res = await fetch(joinUrl(base, ''), {
    method: 'POST',
    headers: acpHeaders(conn),
    body: JSON.stringify(payload),
    signal: withDeadline(timeoutMs, signal),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));

  let result = null;
  let errorMsg = '';
  const texts = [];
  const updates = [];

  await readMessages(res, (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.error) {
      errorMsg = String(msg.error.message || msg.error || '').slice(0, 400);
      return;
    }
    if (msg.id === payload.id && msg.result) {
      result = msg.result || {};
      return;
    }
    const params = msg.params || {};
    const update = params.update || {};
    updates.push(msg);
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const content = update.content || {};
      if (content.type === 'text' && content.text) {
        texts.push(content.text);
        if (typeof onChunk === 'function') onChunk(content.text);
      }
    } else if (kind === 'tool_call' && typeof onChunk === 'function') {
      onChunk(`\n[工具] ${update.title || update.kind || ''}\n`);
    }
  });

  if (errorMsg) throw new Error(errorMsg);
  return { result, texts, updates };
}

async function probeAcp(manifest, opts) {
  const base = acpBase(manifest.url);
  if (!base) throw new Error('acp-http 需要 url');
  const conn = await acpConnect(base, opts);
  return { ok: true, kind: 'acp-http', meta: { connectionId: conn.connectionId } };
}

async function callAcp(manifest, prompt, opts) {
  const base = acpBase(manifest.url);
  if (!base) throw new Error('acp-http 需要 url');
  const rpcOpts = { timeoutMs: opts.timeoutMs, signal: opts.signal };

  const conn = await acpConnect(base, rpcOpts);
  await acpRpc(
    base,
    conn,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      },
    },
    rpcOpts,
  );

  const newSession = await acpRpc(
    base,
    conn,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: opts.cwd || process.cwd(), mcpServers: [] },
    },
    rpcOpts,
  );
  let sessionId = newSession.result?.sessionId || '';
  if (!sessionId) {
    // 有的实现把 sessionId 塞在 update 里
    for (const u of newSession.updates) {
      const sid = u.params?.sessionId;
      if (sid) {
        sessionId = String(sid);
        break;
      }
    }
  }
  if (!sessionId) throw new Error('session/new 没有返回 sessionId');

  let usage;
  let model;
  const done = await acpRpc(
    base,
    conn,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: String(prompt) }] },
    },
    {
      ...rpcOpts,
      onChunk: opts.onChunk,
    },
  );

  // usage 藏在 update 的 _meta 里（CodeBuddy 系）
  for (const u of done.updates) {
    const meta = u.params?.update?._meta || {};
    if (meta['codebuddy.ai/requestModelName'] || meta['codebuddy.ai/requestModelId']) {
      model = String(meta['codebuddy.ai/requestModelName'] || meta['codebuddy.ai/requestModelId']);
    }
    const uu = meta['codebuddy.ai/usage'];
    if (uu) {
      const tin = Number(uu.input_tokens ?? uu.prompt_tokens ?? 0) || 0;
      const tout = Number(uu.output_tokens ?? uu.completion_tokens ?? 0) || 0;
      usage = { in: (usage?.in || 0) + tin, out: (usage?.out || 0) + tout };
    }
  }

  return {
    out: done.texts.join(''),
    meta: {
      sessionId,
      connectionId: conn.connectionId,
      stopReason: done.result?.stopReason || '',
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
    },
  };
}

// ── OpenAI 兼容 ───────────────────────────────────────────

/** baseUrl 可能带 /v1 也可能不带，两种都试。 */
function openaiBases(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return [];
  return /\/v\d+$/i.test(base) ? [base] : [base, `${base}/v1`];
}

function openaiHeaders(manifest) {
  const headers = { 'content-type': 'application/json' };
  if (manifest.apiKey) headers.authorization = `Bearer ${manifest.apiKey}`;
  return headers;
}

async function probeOpenai(manifest, opts) {
  const bases = openaiBases(manifest.baseUrl);
  if (!bases.length) throw new Error('openai 需要 baseUrl');
  let lastErr;
  for (const base of bases) {
    try {
      const data = await requestJson(joinUrl(base, '/models'), { headers: openaiHeaders(manifest) }, opts);
      const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const models = rows.map((m) => (typeof m === 'string' ? m : m?.id || m?.name)).filter(Boolean);
      return { ok: true, kind: 'openai', models, meta: { baseUrl: base } };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('');
  }
  return content == null ? '' : String(content);
}

async function callOpenai(manifest, prompt, opts) {
  const bases = openaiBases(manifest.baseUrl);
  if (!bases.length) throw new Error('openai 需要 baseUrl');
  const body = {
    model: manifest.model || 'default',
    messages: [
      { role: 'system', content: manifest.system || '你是团队里的一名成员，请用中文给出完整、可直接使用的答复。' },
      { role: 'user', content: String(prompt) },
    ],
    stream: false,
  };
  if (manifest.temperature != null) body.temperature = manifest.temperature;
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;

  let lastErr;
  for (const base of bases) {
    let res;
    try {
      res = await fetch(joinUrl(base, '/chat/completions'), {
        method: 'POST',
        headers: openaiHeaders(manifest),
        body: JSON.stringify(body),
        signal: withDeadline(opts.timeoutMs, opts.signal),
      });
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (!res.ok) {
      lastErr = new HttpError(res.status, await res.text().catch(() => ''));
      continue;
    }
    // 少数服务无视 stream:false，照样回 SSE —— 一并吃下
    if (isEventStream(res)) {
      let text = '';
      let usage;
      await readLines(res, (line) => {
        const s = line.trim();
        if (!s.startsWith('data:')) return;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          return;
        }
        const delta = event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.text;
        if (delta) {
          const piece = contentToText(delta);
          text += piece;
          if (typeof opts.onChunk === 'function') opts.onChunk(piece);
        }
        if (event?.usage) usage = event.usage;
      });
      return {
        out: text,
        meta: {
          baseUrl: base,
          ...(usage ? { usage: { in: Number(usage.prompt_tokens) || 0, out: Number(usage.completion_tokens) || 0 } } : {}),
        },
      };
    }
    const data = await readJson(res);
    const choice = data?.choices?.[0];
    const text = contentToText(choice?.message?.content ?? choice?.text);
    const usage = data?.usage
      ? {
          in: Number(data.usage.prompt_tokens ?? data.usage.input_tokens) || 0,
          out: Number(data.usage.completion_tokens ?? data.usage.output_tokens) || 0,
        }
      : undefined;
    return {
      out: text,
      meta: {
        baseUrl: base,
        model: data?.model || manifest.model,
        ...(usage ? { usage } : {}),
        ...(choice?.finish_reason ? { stopReason: String(choice.finish_reason) } : {}),
      },
    };
  }
  throw lastErr || new Error('openai 调用失败');
}

// ── CDP（给桌面 App 代打字）────────────────────────────────

function cdpBase(manifest) {
  const port = Number(manifest.port);
  if (!port) throw new Error('cdp 需要 port');
  return `http://127.0.0.1:${port}`;
}

async function cdpJson(manifest, path, opts) {
  return requestJson(`${cdpBase(manifest)}${path}`, { method: 'GET' }, opts);
}

async function probeCdp(manifest, opts) {
  const version = await cdpJson(manifest, '/json/version', opts);
  if (!version?.Browser) throw new Error('/json/version 没有 Browser 字段：这不是 Chrome 调试端口');
  const targets = await cdpJson(manifest, '/json/list', opts);
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t?.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('调试端口里没有可操作的页面（pages=0）');
  const hint = String(manifest.app || 'chatgpt').toLowerCase();
  const picked = pages.find((p) => `${p.title} ${p.url}`.toLowerCase().includes(hint)) || pages[0];
  return {
    ok: true,
    kind: 'cdp',
    meta: { browser: String(version.Browser), page: picked.title || picked.url, pages: pages.length },
  };
}

/** 极简 CDP 客户端：只实现 command(id 匹配) + 事件监听。 */
function cdpClient(ws) {
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg?.id == null) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`CDP ${slot.method} 失败：${JSON.stringify(msg.error).slice(0, 200)}`));
    else slot.resolve(msg.result);
  });
  const close = (err) => {
    for (const [, slot] of pending) slot.reject(err || new Error('CDP 连接已关闭'));
    pending.clear();
  };
  ws.addEventListener?.('close', () => close());
  ws.addEventListener?.('error', () => close());

  return {
    send(method, params = {}) {
      seq += 1;
      const id = seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          reject(err);
        }
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

function openWebSocket(url, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    const Ctor = WebSocketImpl || globalThis.WebSocket;
    if (!Ctor) return reject(new Error('当前运行环境没有 WebSocket 客户端'));
    let ws;
    try {
      ws = new Ctor(url);
    } catch (err) {
      return reject(err);
    }
    let settled = false;
    const onOpen = () => {
      if (settled) return;
      settled = true;
      resolve(ws);
    };
    const onError = (ev) => {
      if (settled) return;
      settled = true;
      reject(new Error(`WebSocket 连接失败：${ev?.message || url}`));
    };
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    } else {
      ws.onopen = onOpen;
      ws.onerror = onError;
    }
  });
}

/** 在页面里把文字塞进输入框（兼容 contenteditable 和 React 受控 textarea）。 */
function cdpTypeExpression(text) {
  const literal = JSON.stringify(String(text));
  return `(() => {
    const sel = ${JSON.stringify(CDP_EDITOR_SEL)};
    const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    });
    if (!nodes.length) return 'NO_EDITOR';
    const el = nodes[nodes.length - 1];
    el.focus();
    const text = ${literal};
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const ok = document.execCommand('insertText', false, text);
      if (!ok) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return 'OK';
  })()`;
}

async function callCdp(manifest, prompt, opts) {
  const hint = String(manifest.app || 'chatgpt').toLowerCase();
  const targets = await cdpJson(manifest, '/json/list', { timeoutMs: opts.timeoutMs, signal: opts.signal });
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t?.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('调试端口里没有可操作的页面');
  const page = pages.find((p) => `${p.title} ${p.url}`.toLowerCase().includes(hint)) || pages[0];

  const ws = await openWebSocket(page.webSocketDebuggerUrl, opts.WebSocket);
  const client = cdpClient(ws);
  const evaluate = async (expression, timeoutMs) => {
    const res = await withRpcTimeout(client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }), timeoutMs);
    if (res?.exceptionDetails) {
      throw new Error(`页面脚本异常：${res.exceptionDetails.text || res.exceptionDetails.exception?.description || ''}`.slice(0, 300));
    }
    return res?.result?.value;
  };

  try {
    const baseline = String((await evaluate('document.body ? document.body.innerText : ""', 15000)) || '');
    const typed = await evaluate(cdpTypeExpression(prompt), 15000);
    if (typed === 'NO_EDITOR') throw new Error('页面里找不到输入框（可能没登录 / 页面不是聊天页）');

    // 回车发送：rawKeyDown → char → keyUp，三步齐全才可靠（少了 char 有的 App 不认）
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await client.send('Input.dispatchKeyEvent', { type: 'char', ...key, text: '\r', unmodifiedText: '\r' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });

    const deadline = Date.now() + (opts.timeoutMs || DEFAULT_CALL_TIMEOUT_MS);
    const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : CDP_POLL_MS;
    let stable = 0;
    let last = '';
    let answer = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const text = String((await evaluate('document.body ? document.body.innerText : ""', 15000)) || '');
      const thinking = CDP_THINKING.test(text);
      if (text.length > baseline.length && !thinking) {
        stable = text === last ? stable + 1 : 0;
        last = text;
        if (stable >= 1) {
          // 页面把新内容追加在末尾时，只取新增部分；整页重渲染（无共同前缀）就退回尾部
          answer = text.startsWith(baseline) ? text.slice(baseline.length).trim() : text.slice(-2500);
          break;
        }
      } else {
        stable = 0;
        last = text;
      }
    }
    if (!answer) throw new Error(`等了 ${Math.round((opts.timeoutMs || DEFAULT_CALL_TIMEOUT_MS) / 1000)}s 页面没有给出答复（可能还在生成或输入没生效）`);
    return { out: answer, meta: { page: page.title || page.url, transport: 'cdp' } };
  } finally {
    client.close();
  }
}

function withRpcTimeout(promise, timeoutMs) {
  if (!timeoutMs) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`页面脚本 ${timeoutMs}ms 未返回`)), timeoutMs);
      t.unref?.();
    }),
  ]);
}

// ── ADBP（自研桥 · 客户端侧）───────────────────────────────

/** hello 换来的 token 缓存：同一个端点不用每次重新握手。 */
const ADBP_TOKENS = new Map();

/** ADBP 端点填错（最常见：把别的服务地址当 ADBP）时给一句能照做的中文原因。 */
const NOT_ADBP_HINT = '确认对方装了 agentdeck-super 并开启了 ingress';

/**
 * 拉对端 manifest，顺便验"这到底是不是 ADBP 端点"。
 *
 * 用户最常犯的错就是把普通 HTTP 服务地址填进 ADBP 工位：
 * 对方回 404 / 回一段 HTML / 回别的协议 JSON。这三种都要翻成人话，
 * 不能把原始 body 直接抛给用户（`HTTP 404：{"error":"not found"}` 谁都看不懂）。
 */
async function adbpManifest(base, opts) {
  let data;
  try {
    data = await requestJson(joinUrl(base, '/adbp/v1/manifest'), { method: 'GET' }, opts);
  } catch (err) {
    if (err instanceof HttpError) {
      throw new Error(`这个地址不是 ADBP 端点（HTTP ${err.status}）：${NOT_ADBP_HINT}`);
    }
    throw err;
  }
  if (String(data?.protocol) !== 'adbp') {
    const got = data?.protocol == null ? '没有 protocol 字段' : `protocol=${data.protocol}`;
    throw new Error(`这个地址不是 ADBP 端点（${got}）：${NOT_ADBP_HINT}`);
  }
  return data;
}

async function adbpHello(manifest, opts) {
  const base = String(manifest.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('adbp 需要 url');
  const cached = ADBP_TOKENS.get(base);
  if (cached && cached.exp > Date.now()) return cached;
  // 握手前先看 manifest：地址填错时在这里就给出"不是 ADBP 端点"，而不是等 hello 回一段莫名其妙的 JSON
  await adbpManifest(base, opts);
  let data;
  try {
    data = await requestJson(
      joinUrl(base, '/adbp/v1/hello'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: manifest.name || manifest.id || 'agentdeck-super',
          kind: manifest.memberKind || 'adbp',
          capabilities: manifest.capabilities || ['chat'],
        }),
      },
      opts,
    );
  } catch (err) {
    if (err instanceof HttpError) {
      throw new Error(
        `ADBP 握手失败（HTTP ${err.status}）：对端可能是旧版本（没有 /adbp/v1/hello），或这个地址不是 ADBP 端点——${NOT_ADBP_HINT}`,
      );
    }
    throw err;
  }
  if (!data?.token) throw new Error(`hello 没有返回 token：${JSON.stringify(data).slice(0, 200)}`);
  const entry = {
    token: String(data.token),
    teamId: data.teamId || '',
    memberId: data.memberId || '',
    exp: Date.now() + 10 * 60 * 1000,
  };
  ADBP_TOKENS.set(base, entry);
  return entry;
}

async function probeAdbp(manifest, opts) {
  const base = String(manifest.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('adbp 需要 url');
  const data = await adbpManifest(base, opts);
  return { ok: true, kind: 'adbp', meta: { version: data.version || '', name: data.name || '' } };
}

async function callAdbp(manifest, prompt, opts) {
  const base = String(manifest.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('adbp 需要 url');
  const session = await adbpHello(manifest, opts);
  const data = await requestJson(
    joinUrl(base, '/adbp/v1/chat'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ memberId: session.memberId || manifest.memberId || '', text: String(prompt) }),
    },
    opts,
  );
  if (data?.ok === false) throw new Error(data.error || 'chat 投递失败');
  return {
    // ADBP v1 没有同步问答：这里只代表"消息已经投递到对方的队列"，不代表对方答完了
    out: '',
    meta: {
      delivered: true,
      teamId: session.teamId,
      memberId: session.memberId || manifest.memberId || '',
      note: 'ADBP 是拉取式协议：消息已投递，对方下次轮询 /adbp/v1/tasks 时会看到',
    },
  };
}

// ── CLI ──────────────────────────────────────────────────

async function probeCli(manifest, opts) {
  const cmd = manifest.cmd || AGENT_PRESETS[manifest.agent || manifest.id]?.cmd;
  if (!cmd) throw new Error('cli 需要 cmd（或已知的 agent id）');
  const found = resolveCommand(cmd, { env: manifest.env || process.env });
  if (!found) throw new Error(`命令不在 PATH 里：${cmd}`);
  const detected = await detectAgents({ env: manifest.env || process.env, timeoutMs: opts?.timeoutMs });
  const hit = detected.find((d) => d.cmd === found || d.id === (manifest.agent || manifest.id));
  return { ok: true, kind: 'cli', meta: { cmd: found, ...(hit?.version ? { version: hit.version } : {}) } };
}

async function callCli(manifest, prompt, opts) {
  const res = await runAgent(manifest, prompt, opts);
  return {
    out: res.out,
    meta: { ...res.meta, err: res.err, rc: res.rc },
  };
}

// ── 对外入口 ──────────────────────────────────────────────

const PROBES = {
  'acp-http': probeAcp,
  openai: probeOpenai,
  cdp: probeCdp,
  adbp: probeAdbp,
  cli: probeCli,
};

const CALLS = {
  'acp-http': callAcp,
  openai: callOpenai,
  cdp: callCdp,
  adbp: callAdbp,
  cli: callCli,
};

function kindOf(manifest) {
  return String(manifest?.kind || manifest?.transport || '').toLowerCase();
}

/**
 * 探活一个外部 Agent。
 * @returns {Promise<{ok:boolean, kind:string, models?:string[], error?:string, meta?:object}>}
 *   ok=true 说明"现在能调"，models 是 openai 类端点能看到的模型（别家通常没有）。
 */
export async function probe(manifest, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, signal } = {}) {
  const startedAt = Date.now();
  const kind = kindOf(manifest);
  const handler = PROBES[kind];
  if (!handler) {
    return { ok: false, kind: kind || 'unknown', error: `未知的 transport：${kind || '(空)'}，支持 ${KINDS.join(' / ')}` };
  }
  try {
    const res = await handler(manifest || {}, { timeoutMs, signal });
    return { ...res, kind, ms: Date.now() - startedAt };
  } catch (err) {
    const error = describeError(err);
    // error 和 reason 是同一个东西的两个名字：面板/日志用 error，调用方脚本习惯用 reason
    return { ok: false, kind, error, reason: error, ms: Date.now() - startedAt };
  }
}

/**
 * 真正跑一轮。
 * @returns {Promise<{ok:boolean, out:string, ms:number, meta:object, err?:string}>}
 *   · 成功：ok=true，out 是正文
 *   · 失败：ok=false，err 是中文原因，meta.error 同样带一份（方便面板直接显示）
 *   · 取消/超时：ok=false，meta.cancelled / meta.timedOut 标出来
 */
export async function call(manifest, prompt, opts = {}) {
  const startedAt = Date.now();
  const kind = kindOf(manifest);
  const handler = CALLS[kind];
  if (!handler) {
    const error = `未知的 transport：${kind || '(空)'}，支持 ${KINDS.join(' / ')}`;
    return { ok: false, out: '', err: error, ms: 0, meta: { kind: kind || 'unknown', error } };
  }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_CALL_TIMEOUT_MS;
  const runOpts = { ...opts, timeoutMs };
  try {
    const res = await handler(manifest || {}, String(prompt ?? ''), runOpts);
    return {
      ok: true,
      out: String(res.out ?? ''),
      ms: Date.now() - startedAt,
      meta: { kind, transport: kind, ...(res.meta || {}) },
    };
  } catch (err) {
    const cancelled = Boolean(opts.signal?.aborted);
    const timedOut = err?.name === 'TimeoutError' || /超时/.test(String(err?.message || ''));
    const error = describeError(err);
    return {
      ok: false,
      out: '',
      err: error,
      ms: Date.now() - startedAt,
      meta: {
        kind,
        transport: kind,
        error,
        ...(cancelled ? { cancelled: true } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      },
    };
  }
}

export default { KINDS, probe, call };
