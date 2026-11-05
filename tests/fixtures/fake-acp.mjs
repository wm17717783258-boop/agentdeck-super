/**
 * tests/fixtures/fake-acp.mjs —— 假的 ACP Gateway（JSON-RPC over HTTP + SSE）。
 *
 * 为什么：acp-http 是"没有 CLI 的桌面 Agent"唯一的接入方式，协议细节还特别容易错
 * （connect 换 token、每个请求都要 acp-connection-id 头、正文藏在 SSE 的
 *  sessionUpdate=agent_message_chunk 里、usage 埋在 _meta）。这些用假网关固化成测试，
 * 以后改 bridge.js 就能立刻知道有没有破坏契约。
 *
 * 用法：
 *   const gw = await startAcp({ plainJson: false });
 *   gw.url / gw.requests / gw.close()
 */

import { createServer } from 'node:http';

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const CHUNKS = ['ACP ', '假回答：', '中文正常。'];

export function startAcp(opts = {}) {
  const connectionId = opts.connectionId || 'conn-fake-1';
  const sessionToken = opts.sessionToken || 'tok-fake-1';
  const requests = [];
  let counter = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });

    if (req.method === 'POST' && url.pathname === '/api/v1/acp/connect') {
      sendJson(res, { connectionId, sessionToken });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/acp') {
      // 鉴权头必须齐：少一个就 401，和真实网关一致
      if (req.headers['acp-connection-id'] !== connectionId || !String(req.headers.authorization || '').includes(sessionToken)) {
        sendJson(res, { error: 'unauthorized' }, 401);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        sendJson(res, { error: 'bad json' }, 400);
        return;
      }
      const id = msg.id ?? ++counter;

      if (msg.method === 'initialize') {
        sendJson(res, { jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } });
        return;
      }
      if (msg.method === 'session/new') {
        sendJson(res, { jsonrpc: '2.0', id, result: { sessionId: 'acp-sess-1' } });
        return;
      }
      if (msg.method === 'session/prompt') {
        const updates = CHUNKS.map((text) => ({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'acp-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
        }));
        // usage / 模型名藏在最后一条 update 的 _meta 里（CodeBuddy 系就这么给）
        updates.push({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'acp-sess-1',
            update: {
              sessionUpdate: 'session_info_update',
              _meta: {
                'codebuddy.ai/requestModelName': 'fake-acp-model',
                'codebuddy.ai/usage': { input_tokens: 13, output_tokens: 17 },
              },
            },
          },
        });
        const result = { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } };

        if (opts.plainJson) {
          // 有的网关不吐 SSE，直接把几条消息一次性 JSON 回来
          sendJson(res, [...updates, result]);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const item of updates) res.write(`data: ${JSON.stringify(item)}\n\n`);
        res.write(`data: ${JSON.stringify(result)}\n\n`);
        res.end();
        return;
      }

      sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法 ${msg.method}` } });
      return;
    }

    sendJson(res, { error: 'not found' }, 404);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
