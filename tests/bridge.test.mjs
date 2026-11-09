/**
 * tests/bridge.test.mjs —— 外部 Agent 接入（lib/engine/bridge.js）的单测。
 *
 * 五种 transport 各验一遍"探活 + 调用"，全部对着本地假服务 / 假 WebSocket：
 *   · openai   → tests/fixtures/fake-openai.mjs（含 SSE 兜底、401 翻译）
 *   · acp-http → tests/fixtures/fake-acp.mjs（含纯 JSON 网关变体）
 *   · cdp      → tests/fixtures/fake-cdp.mjs + 注入假 WebSocket（Node 没有 WS 服务端）
 *   · adbp     → 本文件内联的假 ADBP 端点（验投递语义 + token 缓存）
 *   · cli      → tests/fixtures/fake-agent.mjs
 *
 * 共同要守住的两条：探活失败/调用失败都返回结构化结果，不 throw；
 * 端口没开时给的是中文人话，不是 "fetch failed"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KINDS, probe, call } from '../lib/engine/bridge.js';
import { startOpenai } from './fixtures/fake-openai.mjs';
import { startAcp } from './fixtures/fake-acp.mjs';
import { startCdp } from './fixtures/fake-cdp.mjs';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE = path.join(FIX, 'fake-agent.mjs');

/** 拿一个"刚关掉"的端口：用来验连接被拒绝的翻译。 */
async function closedPort() {
  const srv = createServer((_req, res) => res.end('x'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** 假 WebSocket：按 CDP 协议答话，模拟"桌面聊天页里代打字"。 */
class FakeSocket {
  constructor(url, opts = {}) {
    this.url = url;
    this.opts = opts;
    this.typed = false;
    this.entered = false;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    queueMicrotask(() => this.emit('open', { type: 'open' }));
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type, ev) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(ev);
  }

  reply(id, result) {
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id, result }) }));
  }

  pageText() {
    const base = '假聊天页：历史消息';
    if (this.opts.stillThinking) return `${base}\n正在思考…`;
    if (this.typed && this.entered) return `${base}\n\n${this.opts.answer || '新回答：活干完了。'}`;
    return base;
  }

  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.method === 'Runtime.evaluate') {
      const expr = String(msg.params?.expression || '');
      if (expr.startsWith('document.body')) return this.reply(msg.id, { result: { value: this.pageText() } });
      this.typed = true;
      return this.reply(msg.id, { result: { value: this.opts.noEditor ? 'NO_EDITOR' : 'OK' } });
    }
    if (msg.method === 'Input.dispatchKeyEvent') {
      this.entered = true;
      return this.reply(msg.id, {});
    }
    return this.reply(msg.id, {});
  }

  close() {
    this.closed = true;
    this.emit('close', { type: 'close' });
  }
}

/** 假 ADBP 端点：只要 protocol=adbp、hello 给 token、chat 收投递。 */
async function startAdbpEndpoint() {
  const state = { hello: 0, chats: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (code, obj) => {
      const text = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (url.pathname === '/adbp/v1/manifest') {
      return json(200, { protocol: 'adbp', version: '1', name: '远程工位', capabilities: ['tasks', 'result'] });
    }
    if (url.pathname === '/adbp/v1/hello' && req.method === 'POST') {
      state.hello += 1;
      return json(200, { ok: true, teamId: 'team-remote', memberId: 'm-remote-1', token: 'tok-remote' });
    }
    if (req.headers.authorization !== 'Bearer tok-remote') return json(401, { ok: false, error: 'unauthorized' });
    if (url.pathname === '/adbp/v1/chat' && req.method === 'POST') {
      state.chats.push(JSON.parse(body || '{}'));
      return json(200, { ok: true });
    }
    return json(404, { ok: false, error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('KINDS：契约里的五种 transport，一个不多一个不少', () => {
  assert.deepEqual(KINDS, ['acp-http', 'openai', 'cdp', 'adbp', 'cli']);
});

test('未知 transport：probe / call 都给结构化失败，不抛', async () => {
  const p = await probe({ id: 'x', kind: 'grpc', url: 'http://127.0.0.1:1' });
  assert.equal(p.ok, false);
  assert.match(p.error, /未知的 transport/);
  const c = await call({ id: 'x', kind: 'grpc' }, '你好');
  assert.equal(c.ok, false);
  assert.equal(c.out, '');
  assert.match(c.err, /未知的 transport/);
});

// ── openai ────────────────────────────────────────────────

test('openai：探活能列模型，调用能拿正文和用量', async () => {
  const srv = await startOpenai({ reply: '喂，我到了。' });
  try {
    const manifest = { id: 'gpt-remote', kind: 'openai', baseUrl: srv.url, model: 'fake-gpt' };
    const p = await probe(manifest);
    assert.equal(p.ok, true, `探活失败：${p.error}`);
    assert.equal(p.kind, 'openai');
    assert.deepEqual(p.models, ['fake-gpt', 'fake-gpt-mini']);
    assert.equal(p.meta.baseUrl, srv.url);

    const c = await call(manifest, '报个到');
    assert.equal(c.ok, true, `调用失败：${c.err}`);
    assert.equal(c.out, '喂，我到了。');
    assert.deepEqual(c.meta.usage, { in: 5, out: 6 });
    assert.equal(c.meta.stopReason, 'stop');
    // 请求里带上了系统提示和用户消息（说明是按 OpenAI 协议调的，不是瞎拼）
    const sent = JSON.parse(srv.requests.find((r) => r.path.endsWith('/chat/completions')).body);
    assert.equal(sent.messages[1].content, '报个到');
    assert.equal(sent.stream, false);
  } finally {
    await srv.close();
  }
});

test('openai：baseUrl 已带 /v1 时不重复拼 /v1（中转服务最常见的写法）', async () => {
  const srv = await startOpenai({ reply: '带 v1 也能通。' });
  try {
    const manifest = { id: 'v1', kind: 'openai', baseUrl: `${srv.url}/v1/`, model: 'fake-gpt' };
    const p = await probe(manifest);
    assert.equal(p.ok, true, `探活失败：${p.error}`);
    assert.equal(p.meta.baseUrl, `${srv.url}/v1`);
    const c = await call(manifest, '你好');
    assert.equal(c.ok, true, `调用失败：${c.err}`);
    assert.equal(c.out, '带 v1 也能通。');
    // 命中 /v1/models 和 /v1/chat/completions，没有拼出 /v1/v1
    assert.ok(srv.requests.every((r) => !r.path.includes('/v1/v1')), srv.requests.map((r) => r.path).join(','));
  } finally {
    await srv.close();
  }
});

test('openai：服务无视 stream:false 照样吐 SSE 时也能吃下', async () => {
  const srv = await startOpenai({ sse: true });
  try {
    const c = await call({ id: 'sse', kind: 'openai', baseUrl: srv.url }, '随便说说');
    assert.equal(c.ok, true);
    assert.equal(c.out, '假的流式回答');
    assert.deepEqual(c.meta.usage, { in: 5, out: 6 });
  } finally {
    await srv.close();
  }
});

test('openai：401 翻译成人话（鉴权失败），并同时给 error/reason 两个字段', async () => {
  const srv = await startOpenai({ requireKey: 'right-key' });
  try {
    const manifest = { id: 'bad-key', kind: 'openai', baseUrl: srv.url, apiKey: 'wrong-key' };
    const p = await probe(manifest);
    assert.equal(p.ok, false);
    assert.match(p.error, /鉴权失败|401/);
    assert.equal(p.reason, p.error, 'reason 和 error 应保持一致（面板读 error，脚本读 reason）');
    const c = await call(manifest, '你好');
    assert.equal(c.ok, false);
    assert.match(c.err, /鉴权失败|401/);
  } finally {
    await srv.close();
  }
});

test('openai：缺 baseUrl 直接说缺什么', async () => {
  const p = await probe({ id: 'x', kind: 'openai' });
  assert.equal(p.ok, false);
  assert.match(p.error, /需要 baseUrl/);
});

// ── acp-http ──────────────────────────────────────────────

test('acp-http：探活拿到 connectionId', async () => {
  const srv = await startAcp();
  try {
    const p = await probe({ id: 'codebuddy', kind: 'acp-http', url: srv.url });
    assert.equal(p.ok, true);
    assert.equal(p.kind, 'acp-http');
    assert.equal(p.meta.connectionId, 'conn-fake-1');
  } finally {
    await srv.close();
  }
});

test('acp-http：调用走 initialize → session/new → session/prompt，聚合正文/模型/用量', async () => {
  const srv = await startAcp();
  try {
    const c = await call({ id: 'codebuddy', kind: 'acp-http', url: srv.url }, '帮我看个问题');
    assert.equal(c.ok, true);
    assert.equal(c.out, 'ACP 假回答：中文正常。');
    assert.equal(c.meta.model, 'fake-acp-model');
    assert.deepEqual(c.meta.usage, { in: 13, out: 17 });
    assert.equal(c.meta.sessionId, 'acp-sess-1');
    assert.equal(c.meta.stopReason, 'end_turn');
    const methods = srv.requests.filter((r) => r.path === '/api/v1/acp').map((r) => JSON.parse(r.body).method);
    assert.deepEqual(methods.slice(0, 3), ['initialize', 'session/new', 'session/prompt']);
  } finally {
    await srv.close();
  }
});

test('acp-http：不吐 SSE、只回纯 JSON 数组的网关也能吃', async () => {
  const srv = await startAcp({ plainJson: true });
  try {
    const c = await call({ id: 'plain', kind: 'acp-http', url: srv.url }, '你好');
    assert.equal(c.ok, true);
    assert.equal(c.out, 'ACP 假回答：中文正常。');
  } finally {
    await srv.close();
  }
});

test('acp-http：端口没开时给中文原因（ECONNREFUSED 要挖出来）', async () => {
  const port = await closedPort();
  const p = await probe({ id: 'dead', kind: 'acp-http', url: `http://127.0.0.1:${port}` }, { timeoutMs: 3000 });
  assert.equal(p.ok, false);
  assert.match(p.error, /连接被拒绝|ECONNREFUSED/);
});

// ── cdp ───────────────────────────────────────────────────

test('cdp：探活认得出这是调试端口（/json/version + /json/list）', async () => {
  const srv = await startCdp();
  try {
    const p = await probe({ id: 'chatgpt', kind: 'cdp', port: srv.port, app: 'ChatGPT' });
    assert.equal(p.ok, true);
    assert.equal(p.kind, 'cdp');
    assert.match(p.meta.browser, /Chrome/);
    assert.equal(p.meta.page, 'ChatGPT');
  } finally {
    await srv.close();
  }
});

test('cdp：调用时把 prompt 打进输入框、回车、等页面长出新内容', async () => {
  const srv = await startCdp();
  try {
    const c = await call(
      { id: 'chatgpt', kind: 'cdp', port: srv.port, app: 'ChatGPT' },
      '帮我把这段翻成英文',
      { WebSocket: class extends FakeSocket {}, pollMs: 40, timeoutMs: 5000 },
    );
    assert.equal(c.ok, true);
    assert.equal(c.out, '新回答：活干完了。');
    assert.equal(c.meta.page, 'ChatGPT');
  } finally {
    await srv.close();
  }
});

test('cdp：页面找不到输入框时明确说找不到', async () => {
  const srv = await startCdp();
  try {
    const c = await call(
      { id: 'chatgpt', kind: 'cdp', port: srv.port },
      '你好',
      { WebSocket: class extends FakeSocket { constructor(url) { super(url, { noEditor: true }); } }, pollMs: 30, timeoutMs: 3000 },
    );
    assert.equal(c.ok, false);
    assert.match(c.err, /找不到输入框/);
  } finally {
    await srv.close();
  }
});

test('cdp：页面一直"正在思考"就超时收场，不无限等', async () => {
  const srv = await startCdp();
  try {
    const c = await call(
      { id: 'chatgpt', kind: 'cdp', port: srv.port },
      '你好',
      { WebSocket: class extends FakeSocket { constructor(url) { super(url, { stillThinking: true }); } }, pollMs: 30, timeoutMs: 500 },
    );
    assert.equal(c.ok, false);
    assert.match(c.err, /没有给出答复|超时/);
    assert.ok(c.ms >= 400, `应该等满 timeout 再收场，实际 ${c.ms}ms`);
  } finally {
    await srv.close();
  }
});

test('cdp：没给 port 直接说缺 port', async () => {
  const p = await probe({ id: 'x', kind: 'cdp' });
  assert.equal(p.ok, false);
  assert.match(p.error, /需要 port/);
});

// ── adbp ──────────────────────────────────────────────────

test('adbp：探活认协议，调用是投递语义（不是问答语义）', async () => {
  const srv = await startAdbpEndpoint();
  try {
    const manifest = { id: 'remote-seat', kind: 'adbp', url: srv.url };
    const p = await probe(manifest);
    assert.equal(p.ok, true);
    assert.equal(p.kind, 'adbp');

    const c = await call(manifest, '手上那件事做完了吗？');
    assert.equal(c.ok, true);
    assert.equal(c.out, '', 'ADBP 是拉取式协议，同步调用不该假装有答复');
    assert.equal(c.meta.delivered, true);
    assert.equal(c.meta.teamId, 'team-remote');
    assert.equal(c.meta.memberId, 'm-remote-1');
    assert.match(c.meta.note, /拉取式协议/);

    // 第二次调用复用 hello 换来的 token，不再重复握手
    const c2 = await call(manifest, '再补一句');
    assert.equal(c2.ok, true);
    assert.equal(srv.state.hello, 1);
    assert.equal(srv.state.chats.length, 2);
  } finally {
    await srv.close();
  }
});

test('adbp：不是 ADBP 端点时明说 protocol 不对', async () => {
  const server = createServer((_req, res) => {
    const body = JSON.stringify({ protocol: 'mcp', version: '2024-11-05' });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const p = await probe({ id: 'x', kind: 'adbp', url });
    assert.equal(p.ok, false);
    assert.match(p.error, /这个地址不是 ADBP 端点/);
    assert.match(p.error, /agentdeck-super/);
    assert.doesNotMatch(p.error, /"error":"not found"/, '不许把原始 404 body 当错误正文抛给用户');
    // 调用侧同样翻译（先握手，失败在这里就拦住了）
    const c = await call({ id: 'x', kind: 'adbp', url }, '你好');
    assert.equal(c.ok, false);
    assert.match(c.err, /ADBP 握手失败|这个地址不是 ADBP 端点/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// 用户填错地址的四种真实形态（404 / 405 / 200 回 HTML / 200 回别家 JSON），
// 每一种都必须翻成同一句人话，且带上 HTTP 状态码——绝不把原始 body 甩出去。
test('adbp：404 / 405 / 非 JSON / 缺 protocol 都归到"这个地址不是 ADBP 端点"', async () => {
  const cases = [
    { name: '404', status: 404, ctype: 'application/json', body: '{"error":"not found"}', expect: /HTTP 404/ },
    { name: '405', status: 405, ctype: 'text/plain', body: 'Method Not Allowed', expect: /HTTP 405/ },
    { name: '200-html', status: 200, ctype: 'text/html', body: '<!doctype html><h1>首页</h1>', expect: /HTTP 200/ },
    { name: '200-no-protocol', status: 200, ctype: 'application/json', body: '{"ok":true}', expect: /没有 protocol 字段/ },
  ];
  for (const c of cases) {
    const server = createServer((_req, res) => {
      res.writeHead(c.status, { 'content-type': c.ctype, 'content-length': Buffer.byteLength(c.body) });
      res.end(c.body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const p = await probe({ id: c.name, kind: 'adbp', url });
      assert.equal(p.ok, false, `${c.name} 不该探活成功`);
      assert.match(p.error, /这个地址不是 ADBP 端点/, `${c.name}：${p.error}`);
      assert.match(p.error, c.expect, `${c.name}：${p.error}`);
      assert.match(p.error, /agentdeck-super/, `${c.name}：缺了"该怎么办"的提示`);

      const cl = await call({ id: c.name, kind: 'adbp', url }, '你好');
      assert.equal(cl.ok, false, `${c.name} 不该调用成功`);
      assert.match(cl.err, /这个地址不是 ADBP 端点/, `${c.name} call：${cl.err}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});

// ── cli ───────────────────────────────────────────────────

test('cli：探活不认得的命令就报"不在 PATH 里"', async () => {
  const p = await probe({ id: 'ghost', kind: 'cli', cmd: 'nope-agent-xyz' });
  assert.equal(p.ok, false);
  assert.match(p.error, /PATH/);
});

test('cli：调用直接落到 runAgent 上（这里用假 CLI 验通路）', async () => {
  const c = await call(
    { id: 'cli-fake', kind: 'cli', cmd: process.execPath, args: [FAKE, '--mode', 'echo', '--tag', 'br'] },
    '你好',
  );
  assert.equal(c.ok, true);
  assert.equal(c.out.trim(), 'FAKE[br] 收到:你好');
  assert.equal(c.meta.rc, 0);
});
