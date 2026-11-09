/**
 * 独立 MCP Streamable HTTP 服务验收。
 *
 * 这条路线不依赖 DSH/Cordis：`nexi serve` 起一个真正的 HTTP 端点，
 * 任意支持远程 MCP 的客户端填 URL 就能接。测试必须证明：
 * initialize / tools/list / tools/call 都是真的，写动作真的落盘，
 * token 和 readOnly 都不是只写在帮助文本里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { startMcpHttpServer } from '../lib/mcp/standalone.js';

async function boot({ token = '', readOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mcp-standalone-'));
  const hub = await createHub({
    workspace: root,
    boardRoot: root,
    licenseRoot: root,
    config: { automation: { enabled: false } },
    onLog: () => {},
  });
  const server = await startMcpHttpServer({
    definitions: hub.list(),
    host: '127.0.0.1',
    port: 0,
    token,
    readOnly,
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  return {
    root,
    hub,
    server,
    async close() {
      await server.close();
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function rpc(server, payload, { token = '', method = 'POST', path = '/mcp' } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${server.origin}${path}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 保留 text 给断言 */ }
  return { res, text, json };
}

test('standalone：/healthz 公开，initialize 与 tools/list 走真 HTTP', async () => {
  const b = await boot();
  try {
    const health = await fetch(`${b.server.origin}/healthz`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.service, 'nexi-mcp');
    assert.equal(healthJson.authRequired, false);

    const init = await rpc(b.server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'standalone-test', version: '1' } },
    });
    assert.equal(init.res.status, 200);
    assert.equal(init.json.result.serverInfo.name, 'nexi');

    const listed = await rpc(b.server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(listed.res.status, 200);
    const names = listed.json.result.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), b.hub.list().map((t) => t.name).sort());
    assert.ok(names.includes('team_board') && names.includes('deck_sync'));
  } finally {
    await b.close();
  }
});

test('standalone：tools/call 写动作真的落到同一个 Hub 状态里', async () => {
  const b = await boot();
  try {
    const created = await rpc(b.server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'team_board', arguments: { action: 'create', name: 'HTTP 独立服务', goal: '证明跨传输共享状态' } },
    });
    assert.equal(created.res.status, 200);
    assert.ok(created.json.result, created.text);
    const text = created.json.result.content.map((x) => x.text || '').join('\n');
    const teamId = (text.match(/已创建小组\s*(team_[0-9a-z]+)/) || [])[1];
    assert.ok(teamId, `没拿到 teamId：${text}`);

    const seen = await b.hub.call('team_board', { action: 'teams' });
    const seenText = seen.map((x) => x.text || '').join('\n');
    assert.ok(seenText.includes(teamId), `HTTP 写完后 Hub 没看到 ${teamId}：${seenText}`);
  } finally {
    await b.close();
  }
});

test('standalone：token 鉴权覆盖 POST 和 GET，/healthz 仍可探活', async () => {
  const b = await boot({ token: 'standalone-secret' });
  try {
    const health = await fetch(`${b.server.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).authRequired, true);

    const init = {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'no-token', version: '1' } },
    };
    const denied = await rpc(b.server, init);
    assert.equal(denied.res.status, 401);

    const allowed = await rpc(b.server, init, { token: 'standalone-secret' });
    assert.equal(allowed.res.status, 200);

    const noSummary = await rpc(b.server, null, { method: 'GET' });
    assert.equal(noSummary.res.status, 401);
    const summary = await rpc(b.server, null, { method: 'GET', token: 'standalone-secret' });
    assert.equal(summary.res.status, 200);
    assert.equal(summary.json.authRequired, true);
  } finally {
    await b.close();
  }
});

test('standalone：readOnly 真的拒写，不只隐藏清单', async () => {
  const b = await boot({ readOnly: true });
  try {
    const listed = await rpc(b.server, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const names = listed.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('team_board'));
    assert.ok(!names.includes('super_agent'));
    assert.ok(!names.includes('team_orchestrate'));

    const blocked = await rpc(b.server, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'team_board', arguments: { action: 'create', name: '不该建出来' } },
    });
    assert.equal(blocked.res.status, 200);
    assert.equal(blocked.json.result.isError, true);
    assert.match(blocked.json.result.content[0].text, /只读模式/);
  } finally {
    await b.close();
  }
});

test('standalone：非回环地址没有 token 时直接拒绝启动', async () => {
  await assert.rejects(
    () => startMcpHttpServer({
      definitions: [{ name: 'x', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }],
      host: '0.0.0.0',
      port: 0,
      token: '',
    }),
    /必须设置 MCP token/,
  );
});
