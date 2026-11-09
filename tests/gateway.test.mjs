/**
 * 网关层验收（task-8）：OpenAPI 3.1 网关 + A2A Agent Card。
 *
 * 为什么单测要这么写：网关是「别的 Agent / 别的平台」进来的第一道门，
 * 一旦文档和真实工具表漂了，对方拿到的就是一份调不通的 openapi.json。
 * 所以这里既测纯函数（文档生成、意图解析、错误码），也测真挂载——
 * 起一个真 http 服务器 + 一个仿宿主 `register({kind,path,handler})` 的假 webServer，
 * 用真 fetch 走一遍「取文档 → 调工具 → 拿 A2A 任务卡」。
 *
 * 不联网、不碰真实端口（一律 listen(0)）、不写用户目录、不打印任何 token。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOpenApi,
  handleOpenApi,
  mountOpenApi,
} from '../lib/gateway/openapi.js';
import {
  buildAgentCard,
  handleA2A,
  mountA2A,
  parseToolIntent,
} from '../lib/gateway/a2a.js';
import { mountGateway } from '../lib/gateway/index.js';

/* ── 假工具表：形状跟 lib/hub.js 的 list() 一致（name/description/parameters）── */

function makeTools() {
  return [
    {
      name: 'deck_license',
      description: '查看/激活授权码',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'activate'] },
          key: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'team_board',
      description: '读写任务板\n支持 list/claim/done',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string' }, title: { type: 'string' } },
      },
    },
    {
      name: 'fs_read',
      description: '读一个文本文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ];
}

function makeHub(tools = makeTools()) {
  const calls = [];
  return {
    calls,
    list: () => tools.slice(),
    async call(name, args = {}) {
      calls.push({ name, args });
      if (!tools.some((tool) => tool.name === name)) {
        const err = new Error(`没有这个工具：${name}`);
        err.code = 'no_such_tool';
        throw err;
      }
      return [{ type: 'text', text: JSON.stringify({ tool: name, args }) }];
    },
  };
}

/* ── 仿宿主 webServer：真正的接口只有 register({kind,path,handler}) ───────── */

function makeFakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
}

/** 起一个真 http 服务器，dispatch 语义按宿主 webServer 的 exact/prefix 来。 */
async function startFakeHost(app) {
  const server = createServer((req, res) => {
    const url = String(req.url || '/').split('?')[0];
    const route = app.routes.find((r) => (r.kind === 'exact'
      ? url === r.path
      : url === r.path || url.startsWith(`${r.path}/`)));
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no route');
      return;
    }
    Promise.resolve(route.handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(err?.message || err));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

/* ════════════════════════════════════════════════════════════════════════
 * 一、OpenAPI 文档生成
 * ══════════════════════════════════════════════════════════════════════ */

test('buildOpenApi：严格 3.1.0，一工具一路径，requestBody 直接复用工具参数 schema', () => {
  const tools = makeTools();
  const doc = buildOpenApi({ tools, baseUrl: 'http://127.0.0.1:1234', title: '测试网关', version: '9.9.9' });

  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.title, '测试网关');
  assert.equal(doc.info.version, '9.9.9');
  assert.equal(doc.servers[0].url, 'http://127.0.0.1:1234');
  assert.equal(Object.keys(doc.paths).length, tools.length);
  assert.equal(doc['x-agentdeck-tool-count'], tools.length);

  for (const tool of tools) {
    const path = doc.paths[`/v1/tools/${tool.name}`];
    assert.ok(path, `缺少路径 ${tool.name}`);
    const op = path.post;
    assert.equal(op.operationId, `tool_${tool.name}`);
    assert.deepEqual(op.requestBody.content['application/json'].schema, tool.parameters);
    assert.equal(op.requestBody.required, true);
    assert.equal(op.responses['200'].content['application/json'].schema.required.includes('text'), true);
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
  }

  const scheme = doc.components.securitySchemes.bearerAuth;
  assert.equal(scheme.type, 'http');
  assert.equal(scheme.scheme, 'bearer');
});

test('buildOpenApi：工具清单换一批，路径跟着换（不硬编码工具名）', () => {
  const dynamic = Array.from({ length: 7 }, (_, i) => ({
    name: `dyn_tool_${i}`,
    description: `第 ${i} 个动态工具`,
    parameters: { type: 'object', properties: { n: { type: 'number' } } },
  }));
  const doc = buildOpenApi({ tools: dynamic, baseUrl: 'http://x' });
  assert.equal(Object.keys(doc.paths).length, 7);
  for (const tool of dynamic) assert.ok(doc.paths[`/v1/tools/${tool.name}`]);
  assert.equal(buildOpenApi({ tools: [], baseUrl: 'http://x' })['x-agentdeck-tool-count'], 0);
});

test('buildOpenApi：没有 parameters 的工具也给一份合法空对象 schema', () => {
  const doc = buildOpenApi({ tools: [{ name: 'bare_tool', description: '没有参数' }], baseUrl: 'http://x' });
  const schema = doc.paths['/v1/tools/bare_tool'].post.requestBody.content['application/json'].schema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.properties, {});
  assert.equal(schema.additionalProperties, false);
});

/* ════════════════════════════════════════════════════════════════════════
 * 二、handleOpenApi 纯函数
 * ══════════════════════════════════════════════════════════════════════ */

test('handleOpenApi：GET 文档能拿到全部工具路径', async () => {
  const hub = makeHub();
  const res = await handleOpenApi({ hub, baseUrl: 'http://127.0.0.1:1', req: { method: 'GET', url: '/v1/openapi.json' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.openapi, '3.1.0');
  assert.equal(Object.keys(res.body.paths).length, hub.list().length);
});

test('handleOpenApi：POST /v1/tools/<name> 真调 hub.call 并返回 {ok,text}', async () => {
  const hub = makeHub();
  const res = await handleOpenApi({
    hub,
    baseUrl: 'http://127.0.0.1:1',
    req: { method: 'POST', url: '/v1/tools/deck_license?x=1' },
    body: '{"action":"status"}',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.text, 'string');
  const parsed = JSON.parse(res.body.text);
  assert.deepEqual(parsed, { tool: 'deck_license', args: { action: 'status' } });
  assert.deepEqual(hub.calls, [{ name: 'deck_license', args: { action: 'status' } }]);
});

test('handleOpenApi：没有 body 时按空参数 {} 调', async () => {
  const hub = makeHub();
  const res = await handleOpenApi({ hub, req: { method: 'POST', url: '/v1/tools/team_board' } });
  assert.equal(res.status, 200);
  assert.deepEqual(hub.calls[0], { name: 'team_board', args: {} });
});

test('handleOpenApi：未知工具 → 404 + code unknown_tool + 列出已知工具', async () => {
  const hub = makeHub();
  const res = await handleOpenApi({ hub, req: { method: 'POST', url: '/v1/tools/nope_tool' }, body: '{}' });
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'unknown_tool');
  assert.deepEqual(res.body.known.sort(), makeTools().map((t) => t.name).sort());
  assert.equal(hub.calls.length, 0, '未知工具绝不能真的去执行');
});

test('handleOpenApi：请求体不是 JSON 或不是对象 → 400', async () => {
  const hub = makeHub();
  const badJson = await handleOpenApi({ hub, req: { method: 'POST', url: '/v1/tools/fs_read' }, body: '{oops' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, 'invalid_json');

  const arrayBody = await handleOpenApi({ hub, req: { method: 'POST', url: '/v1/tools/fs_read' }, body: '[1,2]' });
  assert.equal(arrayBody.status, 400);
  assert.equal(arrayBody.body.code, 'invalid_args');
});

test('handleOpenApi：方法不对 → 405 + Allow，不误执行', async () => {
  const hub = makeHub();
  const getTool = await handleOpenApi({ hub, req: { method: 'GET', url: '/v1/tools/fs_read' } });
  assert.equal(getTool.status, 405);
  assert.match(getTool.headers.Allow, /POST/);

  const postDoc = await handleOpenApi({ hub, req: { method: 'POST', url: '/v1/openapi.json' }, body: '{}' });
  assert.equal(postDoc.status, 405);
  assert.match(postDoc.headers.Allow, /GET/);
  assert.equal(hub.calls.length, 0);
});

test('handleOpenApi：OPTIONS 预检 204；未知路径 404 not_found', async () => {
  const hub = makeHub();
  const preflight = await handleOpenApi({ hub, req: { method: 'OPTIONS', url: '/v1/tools/fs_read' } });
  assert.equal(preflight.status, 204);

  const missing = await handleOpenApi({ hub, req: { method: 'GET', url: '/v1/nope' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'not_found');
  assert.ok(missing.body.knownPaths.length >= 1);
});

test('handleOpenApi：只有 tools 数组（没有 hub）时直接 execute，依然能用', async () => {
  const tools = [{
    name: 'echo_tool',
    description: '原样回显',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async (args) => `收到：${args.text}`,
  }];
  const res = await handleOpenApi({ tools, req: { method: 'POST', url: '/v1/tools/echo_tool' }, body: '{"text":"你好"}' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.text, '收到：你好');
});

/* ════════════════════════════════════════════════════════════════════════
 * 三、A2A Agent Card 与意图解析
 * ══════════════════════════════════════════════════════════════════════ */

test('buildAgentCard：skills 由工具列表生成，能力声明明确不支持流式', () => {
  const tools = makeTools();
  const card = buildAgentCard({
    name: '测试 Agent',
    description: '一句话',
    url: 'http://127.0.0.1:1234/v1/a2a',
    version: '2.0.0',
    tools,
  });
  assert.equal(card.name, '测试 Agent');
  assert.equal(card.description, '一句话');
  assert.equal(card.url, 'http://127.0.0.1:1234/v1/a2a');
  assert.equal(card.version, '2.0.0');
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.skills.length, tools.length);
  assert.deepEqual(card.skills.map((s) => s.id), tools.map((t) => t.name));
  for (const skill of card.skills) assert.equal(typeof skill.description, 'string');
});

test('parseToolIntent：tool: 前缀 / 纯工具名+JSON / 文本里出现工具名 三种写法都认', () => {
  const names = ['deck_license', 'team_board', 'fs_read'];

  assert.deepEqual(parseToolIntent('tool:deck_license {"action":"status"}', names), {
    ok: true,
    name: 'deck_license',
    args: { action: 'status' },
  });
  assert.deepEqual(parseToolIntent('fs_read {"path":"a.txt"}', names), {
    ok: true,
    name: 'fs_read',
    args: { path: 'a.txt' },
  });
  assert.deepEqual(parseToolIntent('帮我用 team_board 列一下任务', names), {
    ok: true,
    name: 'team_board',
    args: {},
  });
  assert.deepEqual(parseToolIntent('deck_license', names), { ok: true, name: 'deck_license', args: {} });
});

test('parseToolIntent：匹配不到工具 / 参数不是 JSON 都要如实报错', () => {
  const names = ['deck_license'];
  const noMatch = parseToolIntent('随便聊两句', names);
  assert.equal(noMatch.ok, false);
  assert.equal(noMatch.code, -32601);
  assert.equal(noMatch.reason, '没有匹配的工具');

  const badArgs = parseToolIntent('deck_license {oops}', names);
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.code, -32602);

  const notJsonArgs = parseToolIntent('deck_license status', names);
  assert.equal(notJsonArgs.ok, false);
  assert.equal(notJsonArgs.code, -32602);
});

/* ════════════════════════════════════════════════════════════════════════
 * 四、handleA2A 纯函数
 * ══════════════════════════════════════════════════════════════════════ */

test('handleA2A：GET agent-card.json 返回 skills 与工具表一致', async () => {
  const hub = makeHub();
  const res = await handleA2A({ hub, url: 'http://127.0.0.1:1/v1/a2a', req: { method: 'GET', url: '/v1/a2a/agent-card.json' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.skills.length, hub.list().length);
  assert.equal(res.body.capabilities.streaming, false);
});

test('handleA2A：message/send 调工具 → 完成态 task + artifacts 文本', async () => {
  const hub = makeHub();
  const res = await handleA2A({
    hub,
    req: { method: 'POST', url: '/v1/a2a/message' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'tool:deck_license {"action":"status"}' }] } },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.jsonrpc, '2.0');
  assert.equal(res.body.id, 'req-1');
  const { result } = res.body;
  assert.equal(result.kind, 'task');
  assert.match(result.id, /^task-/);
  assert.equal(result.status.state, 'completed');
  assert.equal(result.metadata.tool, 'deck_license');
  const text = result.artifacts[0].parts[0].text;
  assert.deepEqual(JSON.parse(text), { tool: 'deck_license', args: { action: 'status' } });
  assert.deepEqual(hub.calls, [{ name: 'deck_license', args: { action: 'status' } }]);
});

test('handleA2A：匹配不到工具 → JSON-RPC -32601「没有匹配的工具」', async () => {
  const hub = makeHub();
  const res = await handleA2A({
    hub,
    req: { method: 'POST', url: '/v1/a2a/message' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: '今天天气不错' }] } },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 7);
  assert.equal(res.body.error.code, -32601);
  assert.equal(res.body.error.message, '没有匹配的工具');
  assert.equal(hub.calls.length, 0);
});

test('handleA2A：非法 JSON → -32700；不支持的方法 → -32601；缺文本 → -32602；缺 jsonrpc → -32600', async () => {
  const hub = makeHub();
  const post = (body) => handleA2A({ hub, req: { method: 'POST', url: '/v1/a2a/message' }, body });

  assert.equal((await post('{oops')).body.error.code, -32700);
  assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream' }))).body.error.code, -32601);
  assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }))).body.error.code, -32602);
  assert.equal((await post(JSON.stringify({ id: 1, method: 'message/send' }))).body.error.code, -32600);
  assert.equal((await post('null')).body.error.code, -32600);
});

test('handleA2A：GET message 端点 405；未知路径 404', async () => {
  const hub = makeHub();
  const wrongMethod = await handleA2A({ hub, req: { method: 'GET', url: '/v1/a2a/message' } });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.Allow, /POST/);

  const missing = await handleA2A({ hub, req: { method: 'GET', url: '/v1/a2a/nope' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, -32601);
});

/* ════════════════════════════════════════════════════════════════════════
 * 五、真挂载：仿宿主 register + 真 http 服务器 + 真 fetch
 * ══════════════════════════════════════════════════════════════════════ */

test('mountOpenApi：按宿主的 register({kind,path,handler}) 挂两条路由并真的能调', async (t) => {
  const app = makeFakeWebServer();
  const hub = makeHub();
  const dispose = mountOpenApi(app, { hub });

  assert.deepEqual(app.routes.map((r) => `${r.kind} ${r.path}`).sort(), ['exact /v1/openapi.json', 'prefix /v1/tools']);

  const { server, base } = await startFakeHost(app);
  t.after(() => {
    dispose();
    server.close();
  });

  const docRes = await fetch(`${base}/v1/openapi.json`);
  assert.equal(docRes.status, 200);
  const doc = await docRes.json();
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(Object.keys(doc.paths).length, hub.list().length);

  const toolRes = await fetch(`${base}/v1/tools/fs_read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'README.md' }),
  });
  assert.equal(toolRes.status, 200);
  const toolBody = await toolRes.json();
  assert.equal(toolBody.ok, true);
  assert.deepEqual(JSON.parse(toolBody.text), { tool: 'fs_read', args: { path: 'README.md' } });

  const unknown = await fetch(`${base}/v1/tools/nope_tool`, { method: 'POST', body: '{}' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'unknown_tool');

  const preflight = await fetch(`${base}/v1/tools/fs_read`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
});

test('mountA2A：真挂载后 GET Agent Card、POST message/send 全通', async (t) => {
  const app = makeFakeWebServer();
  const hub = makeHub();
  const dispose = mountA2A(app, { hub, name: '本机 AgentDeck', url: 'http://127.0.0.1:0/v1/a2a' });
  assert.deepEqual(app.routes.map((r) => r.path).sort(), ['/v1/a2a/agent-card.json', '/v1/a2a/message']);

  const { server, base } = await startFakeHost(app);
  t.after(() => {
    dispose();
    server.close();
  });

  const cardRes = await fetch(`${base}/v1/a2a/agent-card.json`);
  assert.equal(cardRes.status, 200);
  const card = await cardRes.json();
  assert.equal(card.name, '本机 AgentDeck');
  assert.equal(card.skills.length, makeTools().length);

  const msgRes = await fetch(`${base}/v1/a2a/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'team_board {"action":"list"}' }] } },
    }),
  });
  assert.equal(msgRes.status, 200);
  const reply = await msgRes.json();
  assert.equal(reply.id, 42);
  assert.equal(reply.result.status.state, 'completed');
  assert.deepEqual(JSON.parse(reply.result.artifacts[0].parts[0].text), {
    tool: 'team_board',
    args: { action: 'list' },
  });

  const badJson = await fetch(`${base}/v1/a2a/message`, { method: 'POST', body: '{oops' });
  assert.equal(badJson.status, 200);
  assert.equal((await badJson.json()).error.code, -32700);
});

test('mountGateway：一次挂两套网关，卸载后路由真的消失', async (t) => {
  const app = makeFakeWebServer();
  const hub = makeHub();
  const dispose = mountGateway(app, { hub });
  assert.equal(app.routes.length, 4);

  const { server, base } = await startFakeHost(app);
  t.after(() => {
    dispose();
    server.close();
  });

  assert.equal((await fetch(`${base}/v1/openapi.json`)).status, 200);
  assert.equal((await fetch(`${base}/v1/a2a/agent-card.json`)).status, 200);

  dispose();
  assert.equal(app.routes.length, 0);
  const gone = await fetch(`${base}/v1/openapi.json`);
  assert.equal(gone.status, 404);
  dispose(); // 重复卸载必须安全
});

test('mountGateway：basePath 一起挂到 /adbp 下，路径与文档都对得上', async (t) => {
  const app = makeFakeWebServer();
  const hub = makeHub();
  const dispose = mountGateway(app, { hub, basePath: '/adbp', baseUrl: 'http://127.0.0.1:0/adbp' });
  t.after(() => {
    dispose();
    server?.close();
  });

  let server;
  try {
    const started = await startFakeHost(app);
    server = started.server;
    const { base } = started;

    assert.deepEqual(app.routes.map((r) => r.path).sort(), [
      '/adbp/v1/a2a/agent-card.json',
      '/adbp/v1/a2a/message',
      '/adbp/v1/openapi.json',
      '/adbp/v1/tools',
    ]);

    const doc = await (await fetch(`${base}/adbp/v1/openapi.json`)).json();
    assert.equal(doc.servers[0].url, 'http://127.0.0.1:0/adbp');

    const toolRes = await fetch(`${base}/adbp/v1/tools/deck_license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"action":"status"}',
    });
    assert.equal(toolRes.status, 200);
    assert.equal((await toolRes.json()).ok, true);

    const card = await (await fetch(`${base}/adbp/v1/a2a/agent-card.json`)).json();
    assert.equal(card.skills.length, makeTools().length);
  } finally {
    dispose();
  }
});

test('mount 边界：不是 webServer 的对象要给出人话错误，而不是挂一半', () => {
  assert.throws(() => mountOpenApi({}, {}), /webServer 的 register/);
  assert.throws(() => mountA2A(null, {}), /webServer 的 register/);
});

/* ════════════════════════════════════════════════════════════════════════
 * 六、跟真 hub 对一次账：文档里的路径必须正好是 hub.list() 那一批
 *    （这条是防「网关自己另写一份工具清单」的回归线，工具数量以后变了它照样绿）
 * ══════════════════════════════════════════════════════════════════════ */

test('真 hub：文档路径数 == hub.list() 工具数，Agent Card skills 同源', async () => {
  const { createHub } = await import('../lib/hub.js');
  const root = mkdtempSync(join(tmpdir(), 'adsk-gw-hub-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  let hub;
  try {
    hub = await createHub({
      workspace: join(root, 'ws'),
      boardRoot: join(root, 'board'),
      petRoot: join(root, 'pet'),
      licenseRoot: join(root, 'lic'),
      onLog: () => {},
    });
    const tools = hub.list();
    assert.ok(tools.length > 0, '真 hub 至少应该注册一个工具');
    for (const tool of tools) {
      assert.equal(typeof tool.name, 'string');
      assert.equal(typeof tool.parameters, 'object');
    }

    const doc = buildOpenApi({ tools, baseUrl: 'http://127.0.0.1:0' });
    assert.equal(Object.keys(doc.paths).length, tools.length);
    for (const tool of tools) assert.ok(doc.paths[`/v1/tools/${tool.name}`], `文档缺 ${tool.name}`);

    const card = buildAgentCard({ tools });
    assert.deepEqual(card.skills.map((s) => s.id), tools.map((t) => t.name));

    // 未知工具走真 hub 的清单 → 404，且 known 列表就是 hub.list() 那批（不去执行任何真工具）
    const unknown = await handleOpenApi({
      hub,
      req: { method: 'POST', url: '/v1/tools/__no_such_tool__' },
      body: '{}',
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'unknown_tool');
    assert.deepEqual(unknown.body.known.sort(), tools.map((t) => t.name).sort());
  } finally {
    if (hub) await hub.close();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
