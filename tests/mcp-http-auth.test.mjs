/**
 * MCP HTTP 鉴权回归：token 不能在 POST 上生效、GET 清单却裸奔。
 *
 * 这里故意走 lib/index.js 的真实路由，而不是直接测 createHttpMcp：
 * 宿主插件里的 /mcp、/v1/mcp、/adbp/mcp 别名和 GET 摘要都在那一层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

const TOKEN = 'test-token-31f0c4';

function makeCtx() {
  const state = { tools: [], routes: [], commands: [], warns: [] };
  const logger = {
    debug() {},
    info() {},
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

function makeReq({ method = 'POST', url = '/v1/mcp', headers = {}, body = '' } = {}) {
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

function makeRes() {
  const res = {
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

const headerOf = (res, name) => Object.entries(res.headers)
  .find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] || '';

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mcp-auth-'));
  const { ctx, state } = makeCtx();
  await apply(ctx, {
    workspace: root,
    boardRoot: root,
    licenseRoot: root,
    agents: [],
    mcp: { token: TOKEN },
  });
  const route = state.routes.find((r) => r.kind === 'prefix');
  assert.ok(route, '前缀路由必须挂上');

  const call = async (payload, { method = 'POST', url = '/v1/mcp', token = '', extraHeaders = {} } = {}) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = makeRes();
    await route.handler(makeReq({
      method,
      url,
      headers,
      body: payload == null ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }), res);
    return res;
  };
  return { root, call, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('MCP HTTP token：无 token / 错 token 都被 401，正确 token 才能 initialize', async () => {
  const { call, cleanup } = await boot();
  try {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'auth-test', version: '1' } },
    };
    const none = await call(init);
    assert.equal(none.statusCode, 401);
    assert.match(String(headerOf(none, 'www-authenticate')), /Bearer/i);
    assert.equal(JSON.parse(none.body).error.data.authRequired, true);

    const wrong = await call(init, { token: 'wrong-token' });
    assert.equal(wrong.statusCode, 401);

    const ok = await call(init, { token: TOKEN });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).result.serverInfo.name, 'nexi');
  } finally {
    cleanup();
  }
});

test('MCP HTTP token：GET 清单也鉴权，且不泄露 token', async () => {
  const { call, cleanup } = await boot();
  try {
    const none = await call(null, { method: 'GET', url: '/mcp' });
    assert.equal(none.statusCode, 401);

    const ok = await call(null, { method: 'GET', url: '/mcp', token: TOKEN });
    assert.equal(ok.statusCode, 200);
    const json = JSON.parse(ok.body);
    assert.equal(json.authRequired, true);
    assert.equal(json.httpEndpoint, '/mcp');
    assert.ok(Array.isArray(json.tools) && json.tools.length >= 20);
    assert.ok(!ok.body.includes(TOKEN), '摘要里绝不能回显 token');
  } finally {
    cleanup();
  }
});

test('MCP HTTP 别名：/adbp/mcp 与 OPTIONS 预检都能用', async () => {
  const { call, cleanup } = await boot();
  try {
    const init = { jsonrpc: '2.0', id: 2, method: 'ping' };
    const alias = await call(init, { url: '/adbp/mcp', token: TOKEN });
    assert.equal(alias.statusCode, 200);
    assert.equal(JSON.parse(alias.body).result !== undefined, true);

    const options = await call(null, { method: 'OPTIONS', url: '/adbp/mcp' });
    assert.equal(options.statusCode, 204);
  } finally {
    cleanup();
  }
});
