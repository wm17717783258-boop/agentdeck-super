/**
 * tests/fixtures/fake-cdp.mjs —— 假的 Chrome 调试端口（只做 HTTP 两段：/json/version、/json/list）。
 *
 * 为什么只有 HTTP：CDP 真正的下指令走 WebSocket，而 Node 没有内置的 WS **服务端**
 * （只有客户端）。所以这里只假 HTTP 发现阶段，WS 那一层在测试里用一个假
 * WebSocket 类注入（bridge.call 支持 opts.WebSocket），一样是纯本地、无依赖。
 *
 * 用法：
 *   const cdp = await startCdp({ app: 'ChatGPT' });
 *   cdp.port / cdp.close()
 */

import { createServer } from 'node:http';

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function startCdp(opts = {}) {
  const requests = [];
  const pages = opts.pages || [
    { id: 'page-chat', type: 'page', title: opts.app || 'ChatGPT', url: 'https://chat.example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1/fake-chat' },
    { id: 'page-blank', type: 'page', title: 'New Tab', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1/fake-blank' },
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/json/version') {
      sendJson(res, { Browser: opts.browser || 'Chrome/999.0.0.0', 'Protocol-Version': '1.3' });
      return;
    }
    if (url.pathname === '/json/list') {
      sendJson(res, pages);
      return;
    }
    sendJson(res, { error: 'not found' }, 404);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
