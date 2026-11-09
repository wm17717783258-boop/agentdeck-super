/**
 * tests/fixtures/fake-openai.mjs —— 假的 OpenAI 兼容服务（本地随机端口）。
 *
 * 为什么：openai 这条 transport 要验"探活能不能列模型、调用能不能拿正文、
 * 服务不理 stream:false 时能不能吃下 SSE、401 能不能翻译成人话"。
 * 全部对着本地假服务跑，不联网、不烧额度。
 *
 * 用法：
 *   const srv = await startOpenai({ sse: true });
 *   srv.url / srv.port / srv.requests / srv.close()
 */

import { createServer } from 'node:http';

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function startOpenai(opts = {}) {
  const model = opts.model || 'fake-gpt';
  const reply = opts.reply || '这是假 OpenAI 服务的回答：中文正常。';
  const requests = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });

    if (opts.requireKey && !String(req.headers.authorization || '').includes(opts.requireKey)) {
      sendJson(res, { error: { message: 'invalid api key' } }, 401);
      return;
    }

    // 探活：列模型（故意用 data 数组，和 /v1/models 一致）
    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      sendJson(res, { object: 'list', data: [{ id: model }, { id: `${model}-mini` }] });
      return;
    }

    // 调用：补全
    if (url.pathname.endsWith('/chat/completions')) {
      const parsed = body ? JSON.parse(body) : {};
      if (opts.sse) {
        // 有些中转服务无视 stream:false，照样吐 SSE —— 接入层必须能吃
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const piece of ['假的', '流式', '回答']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 6 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      sendJson(res, {
        id: 'chatcmpl-fake',
        model: parsed.model || model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      });
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
