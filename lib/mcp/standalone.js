/**
 * 独立 MCP Streamable HTTP 服务。
 *
 * 用途：不依赖 DSH/Cordis 的 webServer，任何装了 Node 的电脑都能用
 *   nexi serve --port 8790
 * 起一个真正的远程 MCP 端点。支持远程 MCP 的宿主/Agent 填 URL 就能接入；
 * 需要跨网络时再接公网隧道或反代。
 *
 * 安全默认值：
 *   · 只绑 127.0.0.1 时可以不设 token；
 *   · 绑 0.0.0.0 或接公网时必须设 token（由 CLI 强制）；
 *   · /healthz 不鉴权，只暴露服务是否活着，方便隧道探活；
 *   · 其它路由一律 Bearer 鉴权。
 */

import { createServer } from 'node:http';
import { createHttpMcp, isMcpAuthorized } from './http.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'MCP-Protocol-Version, X-Nexi-Request-Id, WWW-Authenticate',
  };
}

function sendJson(res, status, body, extraHeaders = {}, { head = false } = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(head ? undefined : text);
}

function unauthorized(res) {
  sendJson(res, 401, {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32001,
      message: 'MCP HTTP 需要 Authorization: Bearer <token>。',
      data: { authRequired: true, scheme: 'Bearer' },
    },
  }, { 'WWW-Authenticate': 'Bearer realm="nexi-mcp"' });
}

/**
 * @param {{
 *   definitions: object[],
 *   host?: string,
 *   port?: number,
 *   token?: string,
 *   readOnly?: boolean,
 *   serverInfo?: object,
 *   log?: object,
 * }} opts
 */
export async function startMcpHttpServer(opts = {}) {
  const definitions = Array.isArray(opts.definitions) ? opts.definitions : [];
  if (!definitions.length) throw new Error('没有可暴露的 MCP 工具');
  const token = String(opts.token || '');
  const host = String(opts.host || '127.0.0.1');
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !token) {
    throw new Error('绑到非回环地址时必须设置 MCP token（Authorization: Bearer <token>）。');
  }
  const readOnly = opts.readOnly === true;
  const log = opts.log || console;
  const bridge = createHttpMcp({
    definitions,
    token,
    readOnly,
    serverInfo: opts.serverInfo,
    log,
  });
  const tools = definitions.map((def) => String(def?.name || '')).filter(Boolean);
  const aliases = new Set(['/mcp', '/v1/mcp', '/adbp/v1/mcp', '/adbp/mcp']);

  const server = createServer(async (req, res) => {
    const method = String(req?.method || 'GET').toUpperCase();
    let path = '/';
    try {
      path = new URL(String(req?.url || '/'), 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
    } catch {
      path = String(req?.url || '/');
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (path === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        service: 'nexi-mcp',
        transport: 'streamable-http',
        stateless: true,
        tools: tools.length,
        readOnly,
        authRequired: Boolean(token),
        endpoint: '/mcp',
      }, {}, { head: method === 'HEAD' });
      return;
    }

    if (path === '/') {
      sendJson(res, 200, {
        ok: true,
        service: 'nexi-mcp',
        endpoint: '/mcp',
        aliases: ['/mcp', '/v1/mcp', '/adbp/v1/mcp'],
        transport: 'streamable-http',
        stateless: true,
        authRequired: Boolean(token),
        readOnly,
      }, {}, { head: method === 'HEAD' });
      return;
    }

    if (aliases.has(path)) {
      if (!isMcpAuthorized(req, token)) {
        unauthorized(res);
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, {
          ok: true,
          name: 'nexi',
          transport: 'streamable-http',
          httpEndpoint: '/mcp',
          stateless: true,
          sse: false,
          authRequired: Boolean(token),
          readOnly,
          tools,
          notes: [
            'POST /mcp 是 MCP Streamable HTTP（JSON-RPC 2.0，无状态）。',
            'GET 只给接入清单；本服务不提供 SSE 推流。',
            token ? '请求必须带 Authorization: Bearer <token>。' : '当前未启用 token，仅应绑定本机回环地址。',
            readOnly ? '当前为只读模式，写动作会被拒绝。' : '当前允许写动作。',
          ],
        }, {}, { head: method === 'HEAD' });
        return;
      }
      await bridge.handle(req, res);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: 'not_found',
      path,
      hint: 'MCP 端点是 /mcp；健康检查是 /healthz',
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    host,
    url: `${origin}/mcp`,
    token,
    authRequired: Boolean(token),
    readOnly,
    tools: tools.slice(),
    bridge,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export default { startMcpHttpServer };
