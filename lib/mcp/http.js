// SPDX-License-Identifier: Apache-2.0
// 这个目录是 MCP 适配层，按 LICENSING.md 用 Apache-2.0：任何宿主都能零成本接入，不必开源自己的代码。
/**
 * lib/mcp/http.js —— MCP Streamable HTTP 传输（同一份 handle()，不另写语义）
 *
 * 为什么要有它：stdio 只能由宿主自己起子进程（`nexi mcp`），也就是说
 * 「谁的机器上装着 nexi 谁能用」。Streamable HTTP 让**已经跑着的这个宿主**
 * 直接对外开一个 MCP 端点：Claude Desktop / Cursor 这类支持 remote MCP 的宿主，
 * 填一个 URL 就能接管这台机器上的 16 个工具，不用再装一遍。
 *
 * 说清楚边界（别让客户端以为我们有 SSE 推送）：
 *   · POST  → 单条或批量 JSON-RPC，响应 `application/json`（这是 Streamable HTTP 的核心）
 *   · GET   → 405 + `Allow: POST`（规范允许：没有 SSE 流就明确拒绝，而不是挂着不回）
 *   · DELETE→ 405（无状态，没有会话可删）
 *   · 不发 `Mcp-Session-Id`：无状态部署，重启宿主不掉线，也不需要粘性会话
 */
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 1024 * 1024;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'MCP-Protocol-Version, X-Nexi-Request-Id',
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(text);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > limit) {
        done(reject, new Error(`请求体超过 ${limit} 字节`));
        req.destroy?.();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => done(reject, err));
  });
}

/**
 * @param {{definitions: object[], serverInfo?: object, log?: object, readOnly?: boolean}} opts
 *   definitions：宿主里**真的注册成功**的那些工具定义（顺序即 tools/list 的顺序）
 *   readOnly：只读模式（mcp.readOnly=true 时由宿主配置传进来），写动作一律拒
 */
export function createHttpMcp({ definitions, serverInfo, log = console, readOnly = false } = {}) {
  const byName = new Map();
  for (const def of Array.isArray(definitions) ? definitions : []) {
    if (def && def.name) byName.set(def.name, def);
  }

  // hub 适配器：engine 只需要 list() 和 call()，别为了 HTTP 再造一个 Hub
  const hub = {
    list: () => Array.from(byName.values()),
    call: async (name, args) => {
      const def = byName.get(name);
      if (!def) {
        const err = new Error(`没有这个工具：${name}`);
        err.code = 'no_such_tool';
        err.known = Array.from(byName.keys());
        throw err;
      }
      const out = await def.execute(args || {}, {});
      if (out === undefined || out === null) return [{ type: 'text', text: '（这个工具没有输出）' }];
      if (typeof out === 'string') return [{ type: 'text', text: out }];
      if (Array.isArray(out)) {
        return out.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b));
      }
      return [{ type: 'text', text: JSON.stringify(out) }];
    },
  };

  let engine = null;
  let queue = Promise.resolve();

  const engineOf = async () => {
    if (!engine) {
      const mod = await import('./server.js');
      engine = mod.createMcpEngine({ hub, log, serverInfo: serverInfo || mod.SERVER_INFO, readOnly });
    }
    return engine;
  };

  /** 串行处理：工具会写盘/起进程，并发跑同一份任务板会让结果不可复现。 */
  const handleMessage = async (msg) => {
    const eng = await engineOf();
    let reply;
    queue = queue.then(async () => { reply = await eng.handle(msg); }).catch((err) => {
      log.warn?.(`[mcp-http] 报文处理失败：${err?.message || err}`);
      reply = { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: `内部错误：${err?.message || String(err)}` } };
    });
    await queue;
    return reply;
  };

  async function handle(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const requestId = randomUUID().slice(0, 8);

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (method !== 'POST') {
      // 没有 SSE 就明说，别挂着长连接让客户端以为在等推送
      sendJson(res, 405, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `这个 MCP 端点只接受 POST（当前 ${method}）：无状态 Streamable HTTP，不提供 SSE 推流。`,
          data: { transport: 'streamable-http', stateless: true, allow: ['POST', 'OPTIONS'] },
        },
      }, { Allow: 'POST, OPTIONS' });
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: String(err?.message || err) } });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw || 'null');
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '报文不是合法 JSON' } });
      return;
    }
    if (parsed === null || parsed === undefined) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '空报文：POST 里得有一条 JSON-RPC 消息' } });
      return;
    }

    const batch = Array.isArray(parsed);
    const messages = batch ? parsed : [parsed];
    if (!messages.length) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '空数组：批量里至少得有一条消息' } });
      return;
    }

    const replies = [];
    for (const msg of messages) {
      const reply = await handleMessage(msg);
      if (reply) replies.push(reply);
    }

    // 全是通知（比如 notifications/initialized）：规范要求 202 且无响应体
    if (!replies.length) {
      res.writeHead(202, { ...corsHeaders(), 'X-Nexi-Request-Id': requestId });
      res.end();
      return;
    }
    sendJson(res, 200, batch ? replies : replies[0], { 'X-Nexi-Request-Id': requestId });
  }

  return {
    handle,
    hub,
    get toolCount() { return byName.size; },
    /** 测试与 /v1/mcp 摘要用：不触发 engine 加载 */
    tools: () => Array.from(byName.keys()),
  };
}

export default createHttpMcp;
