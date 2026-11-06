/**
 * MCP Streamable HTTP 验收（Lead 负责）：`POST /v1/mcp` 到底是不是一个真端点。
 *
 * 为什么要单独一条用例：stdio 端（`nexi mcp`）只能由宿主起子进程，
 * 支持 remote MCP 的宿主（Claude Desktop / Cursor …）填的是 **URL**。
 * 这条用例证明「同一个 URL 上真的能 initialize、列工具、调工具、拿到真数据」，
 * 也证明没实现的部分（SSE 推流、有状态会话）如实拒绝，而不是挂着不回。
 *
 * 全程假 ctx + 假 req/res，不联网、不起真服务器、不碰真实授权。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

const fakeDshHome = mkdtempSync(join(tmpdir(), 'adsk-mcphttp-dshhome-'));
process.env.DSH_HOME = fakeDshHome;
process.on('exit', () => {
  try { rmSync(fakeDshHome, { recursive: true, force: true }); } catch { /* 临时目录 */ }
});

function makeCtx() {
  const state = { tools: [], routes: [], commands: [], effects: [], warns: [], infos: [] };
  const logger = {
    debug() {},
    info: (m) => state.infos.push(String(m)),
    warn: (m) => state.warns.push(String(m)),
    error: (m) => state.warns.push(String(m)),
  };
  const ctx = {
    logger,
    get: () => null,
    emit: () => {},
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: { register(def) { state.tools.push(def); return () => {}; } },
  };
  ctx.inject = (services, cb) => {
    const scope = {
      ...ctx,
      webServer: { port: 0, register(route) { state.routes.push(route); return () => {}; } },
      commands: { register(cmd) { state.commands.push(cmd); return () => {}; } },
      effect: ctx.effect,
    };
    cb(scope);
  };
  return { ctx, state };
}

function makeReq({ method = 'POST', url = '/adbp/v1/mcp', headers = {}, body = '' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers,
    on(evt, fn) { listeners.set(evt, [...(listeners.get(evt) || []), fn]); return req; },
    destroy() {},
  };
  setImmediate(() => {
    if (body) for (const fn of listeners.get('data') || []) fn(Buffer.from(body, 'utf8'));
    for (const fn of listeners.get('end') || []) fn();
  });
  return req;
}

function makeRes() {  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    finished: false,
    writeHead(code, headers) { res.statusCode = code; Object.assign(res.headers, headers || {}); return res; },
    setHeader(k, v) { res.headers[String(k).toLowerCase()] = v; return res; },
    end(chunk) { if (chunk != null) res.body += String(chunk); res.finished = true; return res; },
  };
  return res;
}

/** 假 res 不折头部大小写，取出时统一按小写比。 */
const headerOf = (res, name) => Object.entries(res.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] || '';

async function boot(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mcphttp-'));
  const { ctx, state } = makeCtx();
  await apply(ctx, { workspace: root, boardRoot: root, licenseRoot: root, agents: [], ...overrides });
  const route = state.routes.find((r) => r.kind === 'prefix');
  assert.ok(route, '前缀路由（/adbp）必须挂上');
  const post = async (payload, { method = 'POST', url = '/adbp/v1/mcp' } = {}) => {
    const res = makeRes();
    await route.handler(makeReq({
      method,
      url,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }), res);
    return res;
  };
  return { root, state, post, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('POST /v1/mcp：initialize 回 nexi 与协议版本', async () => {
  const { post, cleanup } = await boot();
  try {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit', version: '1' } } });
    assert.equal(res.statusCode, 200);
    assert.match(String(headerOf(res, 'content-type')), /application\/json/);
    const json = JSON.parse(res.body);
    assert.equal(json.id, 1);
    assert.equal(json.result.serverInfo.name, 'nexi');
    assert.equal(json.result.protocolVersion, '2025-06-18');
    assert.equal(json.result.capabilities.tools.listChanged, false);
  } finally {
    cleanup();
  }
});

test('POST /v1/mcp：tools/list 与宿主注册的工具完全一致（18 个）', async () => {
  const { post, state, cleanup } = await boot();
  try {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const json = JSON.parse(res.body);
    const names = json.result.tools.map((t) => t.name);
    assert.equal(names.length, state.tools.length, 'HTTP 端点数必须等于宿主工具数');
    assert.equal(names.length, 18);
    for (const must of ['team_board', 'deck_meeting', 'deck_automation', 'pet_skin']) {
      assert.ok(names.includes(must), `少工具：${must}`);
    }
    // 每个工具都得带 inputSchema，否则客户端不认
    assert.ok(json.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  } finally {
    cleanup();
  }
});

test('POST /v1/mcp：tools/call 真调工具，落盘能在另一条通道查回来', async () => {
  const { post, cleanup } = await boot();
  try {
    const created = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'team_board', arguments: { action: 'create', name: 'HTTP 端到端', goal: '证明 HTTP 上真能建组' } },
    });
    const json = JSON.parse(created.body);
    assert.ok(json.result, `工具调用失败：${created.body}`);
    const text = json.result.content.map((b) => b.text || '').join('\n');
    // 注意：别用裸 /team_[0-9a-z]+/ —— "team_board" 会被当成 team_b
    const teamId = (text.match(/已创建小组\s*(team_[0-9a-z]+)/) || [])[1];
    assert.ok(teamId, `没拿到 teamId：${text}`);
    assert.equal(json.result.isError, undefined);

    // 换一条通道（同一个 handler，另一个请求）把刚建的组读回来：
    // 注意 action:'list' 列的是**任务**，看小组要用 action:'teams'
    const listed = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'team_board', arguments: { action: 'teams' } },
    });
    const listedText = JSON.parse(listed.body).result.content.map((b) => b.text || '').join('\n');
    assert.match(listedText, /HTTP 端到端/);
    assert.match(listedText, new RegExp(teamId));
  } finally {
    cleanup();
  }
});

test('POST /v1/mcp：只发通知（notifications/initialized）回 202 且无响应体', async () => {
  const { post, cleanup } = await boot();
  try {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    assert.equal(res.statusCode, 202);
    assert.equal(res.body, '');
  } finally {
    cleanup();
  }
});

test('POST /v1/mcp：批量报文回数组（逐条对应）', async () => {
  const { post, cleanup } = await boot();
  try {
    const res = await post([
      { jsonrpc: '2.0', id: 'a', method: 'ping', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list', params: {} },
    ]);
    const json = JSON.parse(res.body);
    assert.ok(Array.isArray(json));
    assert.equal(json.length, 2, '通知不该有响应');
    assert.equal(json[0].id, 'a');
    assert.equal(json[1].id, 'b');
  } finally {
    cleanup();
  }
});

test('POST /v1/mcp：错误按 JSON-RPC 报，不 500 不崩', async () => {
  const { post, cleanup } = await boot();
  try {
    const badJson = await post('{不是 JSON');
    assert.equal(badJson.statusCode, 400);
    assert.equal(JSON.parse(badJson.body).error.code, -32700);

    const noTool = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '不存在的工具', arguments: {} } });
    const noToolJson = JSON.parse(noTool.body);
    assert.equal(noToolJson.error.code, -32602);
    assert.match(noToolJson.error.message, /没有这个工具/);
    assert.ok(Array.isArray(noToolJson.error.data.known));

    const noMethod = await post({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: {} });
    assert.equal(JSON.parse(noMethod.body).error.code, -32601);
  } finally {
    cleanup();
  }
});

test('GET /v1/mcp：同一 URL 给接入清单，并如实写清 transport 与"没有 SSE"', async () => {
  const { post, cleanup } = await boot();
  try {
    const res = await post(null, { method: 'GET', url: '/adbp/v1/mcp' });
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.transport, 'stdio+streamable-http');
    assert.equal(json.httpEndpoint, '/adbp/v1/mcp');
    assert.equal(json.tools.length, 18);
    assert.equal(json.readOnly, false);
    assert.ok(json.httpNotes.join(' ').includes('没有 SSE'));
  } finally {
    cleanup();
  }
});

test('GET /v1/mcp（只读）：清单也只列读工具，并明写 readOnly', async () => {
  const { post, cleanup } = await boot({ mcp: { readOnly: true } });
  try {
    const res = await post(null, { method: 'GET', url: '/adbp/v1/mcp' });
    assert.equal(res.statusCode, 200, res.body);
    const json = JSON.parse(res.body);
    assert.equal(json.readOnly, true);
    assert.ok(json.tools.length > 0 && json.tools.length < 18, `工具数不对：${json.tools.length}`);
    assert.equal(json.tools.length, 14, '18 个工具减掉 4 个整体不可用的（编排/干活/开会/写记忆）');
    assert.ok(json.tools.includes('agent_passport'), '通行证在只读模式下还能 ver卡、看账本');
    assert.ok(!json.tools.includes('super_agent'));
    assert.ok(json.tools.includes('twin_recall'));
    assert.ok(json.httpNotes.join(' ').includes('只读模式'));

    // 清单说不能写，就真不能写（免得「清单骗人」）
    const add = await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'team_board', arguments: { action: 'add', title: '不该加' } } });
    assert.equal(JSON.parse(add.body).result.isError, true);
  } finally {
    cleanup();
  }
});

test('PUT/DELETE /v1/mcp：明确 405，别挂着长连接假装在推流', async () => {
  const { post, cleanup } = await boot();
  try {
    for (const method of ['PUT', 'DELETE']) {
      const res = await post(null, { method, url: '/adbp/v1/mcp' });
      assert.equal(res.statusCode, 405);
      // 头部大小写在假 res 里保持原样，这里按小写查
      const allow = headerOf(res, 'allow');
      assert.match(String(allow), /POST/);
      assert.match(JSON.parse(res.body).error.message, /只接受 POST/);
    }
  } finally {
    cleanup();
  }
});
