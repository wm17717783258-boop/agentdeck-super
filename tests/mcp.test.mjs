/**
 * MCP 网关真跑测试：起一个真子进程，走真 stdio，发真 JSON-RPC。
 * 不用假 transport —— 因为"能连上 Claude/Cursor"这件事，只有真进程 + 真报文能证明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_TOOL_ORDER } from '../lib/hub.js';
import { expectTools } from './_pro.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ENTRY = join(REPO, 'bin', 'nexi.mjs');

/** 起一个真 MCP 子进程，返回 { rpc, close, stderr } */
function startMcp() {
  const root = mkdtempSync(join(tmpdir(), 'nexi-mcp-'));
  const child = spawn(process.execPath, [ENTRY, 'mcp'], {
    cwd: REPO,
    env: {
      ...process.env,
      DSH_HOME: root,
      NEXI_WORKSPACE: join(root, 'ws'),
      NEXI_BOARD_ROOT: join(root, 'board'),
      NEXI_PET_ROOT: join(root, 'pet'),
      NEXI_LICENSE_ROOT: join(root, 'lic'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map();
  const transcripts = [];
  let stderr = '';
  let buf = '';
  let nextId = 1;
  let closed = false;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf('\n');
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        transcripts.push({ direction: 'server', raw: line, parseError: true });
        continue;
      }
      transcripts.push({ direction: 'server', msg });
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const rpc = (method, params) => new Promise((resolveP, rejectP) => {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    transcripts.push({ direction: 'client', msg });
    const timer = setTimeout(() => rejectP(new Error(`MCP 超时：${method}\nstderr=${stderr.slice(-800)}`)), 20000);
    pending.set(id, (reply) => { clearTimeout(timer); resolveP(reply); });
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  });

  const notify = (method, params) => {
    const msg = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
    transcripts.push({ direction: 'client', msg });
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  return {
    root,
    rpc,
    notify,
    transcripts,
    stderr: () => stderr,
    close: () => new Promise((resolveP) => {
      if (closed) return resolveP();
      closed = true;
      child.on('exit', () => resolveP());
      child.stdin.end();
      setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolveP(); }, 3000);
    }),
  };
}

async function handshake(client) {
  const init = await client.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'node-test', version: '1.0.0' },
  });
  client.notify('notifications/initialized');
  return init;
}

test('MCP：initialize 握手 → tools/list → 真调 team_board 建组加任务', async () => {
  const client = startMcp();
  try {
    const init = await handshake(client);
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'nexi');
    assert.ok(init.result.capabilities.tools, '必须声明 tools 能力');

    const list = await client.rpc('tools/list');
    const names = list.result.tools.map((t) => t.name);
    // 宿主能看到的工具面必须和 Hub 的权威清单逐一对齐——少一个、多一个都算契约破了。
    assert.deepEqual(names.slice().sort(), expectTools(HUB_TOOL_ORDER).slice().sort(), `tools/list 与 HUB_TOOL_ORDER 不一致（实际：${names.join(',')}）`);
    for (const must of expectTools(['team_board', 'agent_join', 'team_orchestrate', 'super_agent', 'deck_room', 'deck_license', 'pet_visit', 'pet_meeting', 'pet_skin', 'twin_remember', 'twin_recall', 'twin_brief', 'twin_forget', 'twin_habit', 'deck_meeting', 'deck_automation'])) {
      assert.ok(names.includes(must), `tools/list 缺 ${must}（实际：${names.join(',')}）`);
    }
    for (const t of list.result.tools) {
      assert.ok(t.inputSchema && t.inputSchema.type === 'object', `${t.name} 的 inputSchema 不合法`);
    }

    const created = await client.rpc('tools/call', { name: 'team_board', arguments: { action: 'create', name: 'MCP 验收组', goal: '证明网关真能干活' } });
    assert.equal(created.result.isError, undefined);
    const createdText = created.result.content.map((b) => b.text).join('\n');
    assert.match(createdText, /MCP 验收组/, '建组应回显组名');

    const added = await client.rpc('tools/call', {
      name: 'team_board',
      arguments: { action: 'add', title: 'MCP 写进来的第一条任务', acceptance: 'tools/call 返回 ok' },
    });
    const addedText = added.result.content.map((b) => b.text).join('\n');
    assert.match(addedText, /MCP 写进来的第一条任务/);

    const listed = await client.rpc('tools/call', { name: 'team_board', arguments: { action: 'list' } });
    const listedText = listed.result.content.map((b) => b.text).join('\n');
    assert.match(listedText, /MCP 写进来的第一条任务/, '任务板要真的落盘');
  } finally {
    await client.close();
  }
});

test('MCP：分身记忆经网关真写盘、真召回（对外 Agent 也能长记性）', async () => {
  const client = startMcp();
  try {
    await handshake(client);
    const call = async (name, args) => {
      const r = await client.rpc('tools/call', { name, arguments: args });
      assert.equal(r.result.isError, undefined, `${name} 不该报错`);
      return r.result.content.map((b) => b.text).join('\n');
    };

    const wrote = await call('twin_remember', { text: '甲方只认周一上午开会', type: 'preference', tags: ['甲方', '会议'] });
    assert.match(wrote, /已记住/);

    const recalled = await call('twin_recall', { query: '开会' });
    assert.match(recalled, /甲方只认周一上午开会/, '写进去的东西必须能召回');

    const brief = await call('twin_brief', {});
    assert.match(brief, /甲方只认周一上午开会/, '简报里要带上私有偏好');

    const habits = await call('twin_habit', { action: 'propose' });
    assert.match(habits, /候选|没有新候选/);
  } finally {
    await client.close();
  }
});

test('MCP：协议边界——ping 回空对象，未知方法 -32601，未知工具 -32602，坏 JSON -32700', async () => {
  const client = startMcp();
  try {
    await handshake(client);

    const pong = await client.rpc('ping');
    assert.deepEqual(pong.result, {});

    const unknownMethod = await client.rpc('nexi/不存在的方法');
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await client.rpc('tools/call', { name: '不存在的工具', arguments: {} });
    assert.equal(unknownTool.error.code, -32602);
    assert.ok(Array.isArray(unknownTool.error.data.known), '报错要带上已知工具清单');

    const noName = await client.rpc('tools/call', { arguments: {} });
    assert.equal(noName.error.code, -32602);
  } finally {
    await client.close();
  }
});

test('MCP：工具清单和 DSH 插件是同一批（防"网关另写一份逻辑"）', async () => {
  const client = startMcp();
  try {
    await handshake(client);
    const viaMcp = (await client.rpc('tools/list')).result.tools.map((t) => t.name).sort();

    const { createHub } = await import('../lib/hub.js');
    const root = mkdtempSync(join(tmpdir(), 'nexi-hub-'));
    const hub = await createHub({
      workspace: join(root, 'ws'),
      boardRoot: join(root, 'board'),
      petRoot: join(root, 'pet'),
      licenseRoot: join(root, 'lic'),
      onLog: () => {},
    });
    const viaHub = hub.list().map((t) => t.name).sort();
    assert.deepEqual(viaMcp, viaHub);
  } finally {
    await client.close();
  }
});

