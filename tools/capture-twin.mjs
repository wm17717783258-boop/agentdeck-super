/**
 * M2 证据抓取：起一个真的 MCP stdio 服务（bin/nexi.mjs mcp），
 * 用 JSON-RPC 真实调 twin_* 工具，把每条收发原样落进证据目录。
 *
 * 用法：node tools/capture-twin.mjs
 * 环境：演示宿主目录默认使用系统临时目录，换机器可用 NEXI_DEMO_ROOT 指过去。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(REPO, 'docs', 'evidence');
// 文件名跟着 package.json 的版本走，免得证据和版本对不上（1.6.1 的时候就吃过这个亏）。
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const JSONL = join(OUT_DIR, `twin-mcp-session-${VERSION}.jsonl`);
const RAW = join(OUT_DIR, `raw-twin-mcp-${VERSION}.json`);

mkdirSync(OUT_DIR, { recursive: true });
// 演示宿主的数据目录：默认使用隔离的临时目录，避免把证据写进真实工作区。
const DEMO_ROOT = process.env.NEXI_DEMO_ROOT || mkdtempSync(join(tmpdir(), 'nexi-twin-'));
const ownedDemo = !process.env.NEXI_DEMO_ROOT;
const DEMO_WORK = join(DEMO_ROOT, 'work');
const DEMO_BOARD = join(DEMO_ROOT, 'board');

writeFileSync(JSONL, '');

const env = {
  ...process.env,
  NEXI_WORKSPACE: DEMO_WORK,
  NEXI_BOARD_ROOT: DEMO_BOARD,
  NEXI_PET_ROOT: DEMO_WORK,
  NEXI_LICENSE_ROOT: DEMO_BOARD,
};

const child = spawn(process.execPath, [join(REPO, 'bin', 'nexi.mjs'), 'mcp'], {
  cwd: REPO,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let buf = '';
const pending = new Map();
let nextId = 1;
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });

const send = (payload) => {
  appendFileSync(JSONL, `${JSON.stringify({ direction: 'client', ...payload })}\n`);
  child.stdin.write(`${JSON.stringify(payload)}\n`);
};

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
    } catch (err) {
      appendFileSync(JSONL, `${JSON.stringify({ direction: 'server', parseError: String(err), raw: line })}\n`);
      continue;
    }
    appendFileSync(JSONL, `${JSON.stringify({ direction: 'server', msg })}\n`);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const payload = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP 超时：${method}`));
    }, 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolvePromise(msg);
    });
    send(payload);
  });
}

const texts = (msg) => (msg.result?.content || []).map((b) => b.text).join('\n');
const record = { startedAt: new Date().toISOString(), steps: [] };

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'evidence-capture', version: '1.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  record.serverInfo = init.result?.serverInfo;
  record.protocolVersion = init.result?.protocolVersion;

  const list = await rpc('tools/list');
  record.tools = (list.result?.tools || []).map((t) => t.name);

  const call = async (label, name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const text = texts(res);
    record.steps.push({ label, name, args, text });
    console.log(`\n--- ${label} ---\n${text}`);
    return text;
  };

  await call(
    '外部 Agent 记住一条用户偏好',
    'twin_remember',
    { text: '王冕要求所有汇报先给结论，再给细节', type: 'preference', tags: ['汇报', '风格'] },
  );
  await call(
    '外部 Agent 记住一条项目事实',
    'twin_remember',
    { text: '演示项目用 pnpm，禁止 npm install', type: 'semantic', tags: ['构建', '演示'] },
  );
  await call('按关键词召回', 'twin_recall', { query: '汇报 结论' });
  await call('给外部 Agent 的简报', 'twin_brief', {});
  await call('习惯候选', 'twin_habit', { action: 'propose' });
  await call('记忆统计', 'twin_forget', { action: 'stats' });

  record.finishedAt = new Date().toISOString();
  record.stderr = stderr.slice(-2000);
  writeFileSync(RAW, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\n✓ 证据已写入 ${JSONL}`);
  console.log(`✓ 摘要已写入 ${RAW}`);
} catch (err) {
  console.error('抓取失败：', err.message);
  console.error(stderr.slice(-2000));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => {
    child.kill();
    if (ownedDemo) rmSync(DEMO_ROOT, { recursive: true, force: true });
  }, 300);
}



