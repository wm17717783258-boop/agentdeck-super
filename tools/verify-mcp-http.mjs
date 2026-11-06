// M4.5 真机证据：MCP Streamable HTTP —— 不装任何东西，用一个 URL 接管这台机器的 16 个工具。
//
//   node tools/verify-mcp-http.mjs
//
// 真进程、真网络、真宿主：
//   · 一个真 DSH 宿主（`dsh --profile web`）跑着已装进 profile 的那份插件
//   · 两个「HTTP 客户端」只用 fetch + JSON-RPC（等价于 Claude Desktop / Cursor 里填 URL 那种用法）
//     两条连接互不知道对方，却在同一台机器上共享同一份会议与任务板状态
// 结论只认 HTTP 响应体、盘上的文件和 CLI 的真实回显，不认"设计上应该"。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const OUT = join(PKG, 'docs', 'evidence', `mcp-http-${ver}.txt`);
const RAW = join(PKG, 'docs', 'evidence', `mcp-http-${ver}.jsonl`);
const ROOT = 'D:\\demo\\mcphttp';
const WORK = join(ROOT, 'work');
const BOARD = join(ROOT, 'board');
const LIC = join(ROOT, 'lic');

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transcript = [];
const checks = [];
const check = (name, ok, extra = '') => { checks.push([name, !!ok, extra]); };
const clip = (s, n = 400) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

const ENV = {
  ...process.env,
  NEXI_WORKSPACE: WORK,
  NEXI_BOARD_ROOT: BOARD,
  NEXI_PET_ROOT: WORK,
  NEXI_LICENSE_ROOT: LIC,
};

function cli(args) {
  const res = spawnSync(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), ...args], {
    env: ENV, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  return { code: res.status, out: String(res.stdout || '').trim(), err: String(res.stderr || '') };
}

/**
 * 一个「远程 MCP 客户端」：只做 POST /v1/mcp，别的什么都不会。
 * 这就是 Claude Desktop / Cursor 那边的真实用法——没有子进程、没有本地插件。
 */
function httpClient(base, tag) {
  const url = `${base}/adbp/v1/mcp`;
  let seq = 0;
  const record = (dir, line) => transcript.push({ tag, dir, line: clip(line, 4000) });
  const postRaw = async (body) => {
    record('out', body);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
    });
    const text = await res.text();
    record('in', `${res.status} ${res.headers.get('content-type') || ''} ${clip(text, 1200)}`);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 留 null，调用方断言会挂 */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  const post = (payload) => postRaw(JSON.stringify(payload));
  const rpc = async (method, params) => {
    const id = ++seq;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    if (!res.json) throw new Error(`${tag} ${method} 没拿到 JSON：${clip(res.text, 200)}`);
    return res.json;
  };
  const notify = (method, params) => post({ jsonrpc: '2.0', method, params });
  const callTool = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) return { text: `❌ ${res.error.message}`, raw: res };
    const content = res.result?.content || [];
    return { text: content.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n'), raw: res };
  };
  return { tag, url, post, postRaw, rpc, notify, callTool };
}

async function firstFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startHost() {
  const port = await firstFreePort();
  const overlay = join(ROOT, 'host.yml');
  writeFileSync(overlay, [
    '- id: agentdeck-super',
    '  config:',
    `    workspace: ${WORK}`,
    `    boardRoot: ${BOARD}`,
    `    petRoot: ${WORK}`,
    `    licenseRoot: ${LIC}`,
    '    automation:',
    '      enabled: false',
  ].join('\n') + '\n', 'utf8');
  const child = spawn('cmd.exe', ['/c', 'dsh', '--profile', 'web', '--patch', overlay, '--no-open', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (c) => { log += String(c); });
  child.stderr.on('data', (c) => { log += String(c); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`宿主 120 秒没起来：\n${log.slice(-600)}`);
    try { const res = await fetch(`${base}/deck`); if (res.ok) break; } catch { /* 还没监听 */ }
    await sleep(700);
  }
  return { base, child, port, log: () => log };
}

// ─────────────────────────────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
for (const d of [WORK, BOARD, LIC]) mkdirSync(d, { recursive: true });

// 期望的工具数不写死：以这台机器上 Hub 自己报的为准（加一个工具就要改一次脚本，是迟早会漏的那种债）
const EXPECTED_TOOLS = (() => {
  try {
    const res = spawnSync(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), 'status'], {
      env: ENV, encoding: 'utf8', windowsHide: true, timeout: 120000,
    });
    const n = JSON.parse(String(res.stdout || '{}')).tools;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch { return 0; }
})();

const profileDir = join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web');
const installedPkg = join(profileDir, 'node_modules', 'agentdeck-super', 'package.json');
const installedVer = existsSync(installedPkg) ? JSON.parse(readFileSync(installedPkg, 'utf8')).version : '(没装)';

say(`# M4.5 真机证据：MCP Streamable HTTP（一个 URL 接管 ${EXPECTED_TOOLS || '？（nexi status 没取到工具数）'} 个工具，不用装东西）（${ver}）`);
say(`# ${new Date().toISOString()}`);
say('');
say('## 0. 这次验的是哪份东西');
say('');
say(`- 仓库版本：\`${ver}\`（\`package.json\`）`);
say(`- 装进 \`web\` profile 的那份：\`${installedVer}\``);
say(`- 工作区（会议/任务板/桌宠都在这里）：\`${WORK}\``);
say(`- 授权根：\`${LIC}\`（不参与本次验证，只是别污染真机授权）`);
say('');

let host = null;
try {
  host = await startHost();
  const base = host.base;
  say('## 1. 宿主起来了，同一个 URL 既是网页也是 MCP 端点');
  say('');
  say(`- 宿主地址：\`http://127.0.0.1:${host.port}\`（真 \`dsh --profile web\` 进程，PID ${host.child.pid}）`);
  const deck = await fetch(`${base}/deck`);
  check('/deck 状态页仍然 200（加端点没弄坏原有页面）', deck.status === 200, `HTTP ${deck.status}`);

  const summaryRes = await fetch(`${base}/adbp/v1/mcp`);
  const summary = await summaryRes.json();
  check('GET /v1/mcp 报的是 stdio+streamable-http', summary.transport === 'stdio+streamable-http', String(summary.transport));
  check(`GET /v1/mcp 列出的工具数 = Hub 自己的 ${EXPECTED_TOOLS}`, (summary.tools || []).length === EXPECTED_TOOLS, String((summary.tools || []).length));
  say('');
  say('```json');
  say(JSON.stringify({ transport: summary.transport, httpEndpoint: summary.httpEndpoint, tools: summary.tools }, null, 2));
  say('```');
  say('');
  say(`- 清单里对客户端的说明：${(summary.httpNotes || []).join(' / ')}`);
  say('');

  // ── 2. 客户端 A：从零开始的一次真握手 ─────────────────────────────
  const clientA = httpClient(base, 'clientA');
  const initA = await clientA.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'Claude Desktop（模拟）', version: '1.0.0' },
  });
  const notifyA = await clientA.notify('notifications/initialized', {});
  check('客户端 A initialize 拿到 serverInfo=nexi', initA.result?.serverInfo?.name === 'nexi', clip(JSON.stringify(initA.result?.serverInfo)));
  check('客户端 A initialize 协商到 2025-06-18', initA.result?.protocolVersion === '2025-06-18', String(initA.result?.protocolVersion));
  check('通知（notifications/initialized）回 202 且无响应体', notifyA.status === 202 && notifyA.text === '', `HTTP ${notifyA.status} body=${clip(notifyA.text, 60)}`);
  check('响应头没有 Mcp-Session-Id（无状态，重启宿主不用重新配对）', !notifyA.headers.get('mcp-session-id'), String(notifyA.headers.get('mcp-session-id')));

  const listA = await clientA.rpc('tools/list', {});
  const toolsA = (listA.result?.tools || []).map((t) => t.name);
  check(`客户端 A tools/list 拿到 ${EXPECTED_TOOLS} 个工具（HTTP 与 stdio 同一份清单）`, toolsA.length === EXPECTED_TOOLS, String(toolsA.length));
  check('工具名与宿主完全一致（含 deck_meeting / pet_skin）', toolsA.includes('deck_meeting') && toolsA.includes('pet_skin'), toolsA.slice(0, 4).join(','));

  say('## 2. 客户端 A：只有 fetch + JSON-RPC，没有子进程、没有本地安装');
  say('');
  say('```');
  say(`initialize  → serverInfo=${initA.result?.serverInfo?.name} protocolVersion=${initA.result?.protocolVersion}`);
  say(`notified    → HTTP ${notifyA.status}（无响应体，符合规范）`);
  say(`tools/list  → ${toolsA.length} 个：${toolsA.join('、')}`);
  say('```');
  say('');

  // ── 3. 两个客户端协作：一场会 + 落到任务板 ─────────────────────────
  const clientB = httpClient(base, 'clientB');
  const initB = await clientB.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Cursor（模拟）', version: '1.0.0' } });
  await clientB.notify('notifications/initialized', {});
  check('客户端 B（另一条连接）也 initialize 成功', initB.result?.serverInfo?.name === 'nexi', String(initB.result?.protocolVersion));

  const created = await clientA.callTool('team_board', { action: 'create', name: 'HTTP 真机协作', goal: '两个远程客户端通过 HTTP 建组、开会、落任务' });
  const teamId = (created.text.match(/已创建小组\s*(team_[0-9a-z]+)/) || [])[1] || '';
  check('客户端 A 通过 HTTP 建起小组（有 teamId）', !!teamId, teamId);

  const opened = await clientA.callTool('deck_meeting', {
    action: 'open',
    topic: '远程 MCP 端点要不要默认开着',
    goal: '决定默认开关与安全边界',
    participants: ['Claude:claude-code', 'Cursor:cursor'],
  });
  const meetingId = (opened.text.match(/(mtg_\d+_[0-9a-z]+)/) || [])[1] || '';
  check('客户端 A 通过 HTTP 开起一场会（有会议号）', !!meetingId, meetingId);

  const sub1 = await clientA.callTool('deck_meeting', {
    action: 'submit', meetingId, from: 'Claude', vendor: 'claude-code', stance: '支持',
    text: '默认开着，但只监听 127.0.0.1——想对外就让人显式改配置，别默认暴露。',
  });
  const sub2 = await clientB.callTool('deck_meeting', {
    action: 'submit', meetingId, from: 'Cursor', vendor: 'cursor', stance: '补充',
    text: '补充：工具里写盘/起进程的那几个，得有个只读档位，不然远程接管等于把整台机器交出去。',
  });
  check('两个不同客户端各发一条言，都被收下',
    /记下了|已记下/.test(sub1.text) && /记下了|已记下/.test(sub2.text),
    `${clip(sub1.text, 60)} | ${clip(sub2.text, 60)}`);

  const concluded = await clientB.callTool('deck_meeting', {
    action: 'conclude', meetingId, teamId,
    decision: 'Streamable HTTP 默认只绑 127.0.0.1；对外暴露必须显式改配置，并给只读档位。',
    tasks: [{ title: '给 MCP HTTP 端点加只读档位', role: 'worker', acceptance: '配置 readOnly=true 时，写盘/起进程的工具直接拒绝并说明原因' }],
  });
  check('客户端 B 结会并把决议拆成任务', /纪要|任务/.test(concluded.text), clip(concluded.text, 120));

  // 独立通道复核：命令行（另一条完全不同的通道）读同一份盘
  const boardList = cli(['call', 'team_board', JSON.stringify({ action: 'list', teamId })]);
  check('任务板上真有这条任务（用 CLI 这条独立通道读回）', /只读档位/.test(boardList.out), clip(boardList.out, 160));
  const minutesFile = join(WORK, '.agentdeck', 'meetings', meetingId, 'minutes.md');
  const minutes = existsSync(minutesFile) ? readFileSync(minutesFile, 'utf8') : '';
  check('纪要在盘上，且两位客户端的原话逐字在', minutes.includes('只监听 127.0.0.1') && minutes.includes('只读档位'), existsSync(minutesFile) ? `${minutes.length} 字节` : '(没这个文件)');

  say('## 3. 两个远程客户端协作：建组 → 开会 → 结会落任务');
  say('');
  say('```');
  say(created.text.split('\n').slice(0, 2).join('\n'));
  say('---');
  say(opened.text.split('\n').slice(0, 2).join('\n'));
  say('---');
  say(clip(sub1.text, 160));
  say(clip(sub2.text, 160));
  say('---');
  say(clip(concluded.text, 400));
  say('```');
  say('');
  say(`- 纪要文件：\`${minutesFile}\``);
  say('');
  say('纪要里两位客户端的原话（逐字，不是二创）：');
  say('');
  say('```md');
  say(clip(minutes, 1200));
  say('```');
  say('');
  say('任务板（用 CLI 这条独立通道读回来）：');
  say('');
  say('```');
  say(clip(boardList.out, 800));
  say('```');
  say('');

  // ── 4. 该拒绝的都拒绝了 ────────────────────────────────────────────
  const badJson = await clientA.postRaw('{不是 JSON');
  check('坏 JSON → HTTP 400 + JSON-RPC -32700', badJson.status === 400 && badJson.json?.error?.code === -32700, `HTTP ${badJson.status} code=${badJson.json?.error?.code}`);

  const noTool = await clientA.rpc('tools/call', { name: '根本没有这个工具', arguments: {} });
  check('未知工具 → -32602 且列出已知工具', noTool.error?.code === -32602 && Array.isArray(noTool.error?.data?.known), `code=${noTool.error?.code} known=${(noTool.error?.data?.known || []).length}`);

  const noMethod = await clientA.rpc('resources/read', { uri: 'x' });
  check('未实现方法 → -32601', noMethod.error?.code === -32601, `code=${noMethod.error?.code}`);

  const put = await fetch(`${base}/adbp/v1/mcp`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('PUT → 405 且 Allow 里只有 POST（没有 SSE 就明说）', put.status === 405 && /POST/.test(String(put.headers.get('allow') || '')), `HTTP ${put.status} allow=${put.headers.get('allow')}`);

  const batch = await clientA.post([
    { jsonrpc: '2.0', id: 'x1', method: 'ping', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 'x2', method: 'tools/list', params: {} },
  ]);
  check('批量报文 → 回数组、通知不占位（2 条）', Array.isArray(batch.json) && batch.json.length === 2, `len=${Array.isArray(batch.json) ? batch.json.length : 'not-array'}`);

  say('## 4. 边界如实拒绝（不假装有 SSE、不假装有会话）');
  say('');
  say('| 请求 | 期望 | 实际 |');
  say('| --- | --- | --- |');
  say(`| 坏 JSON | 400 / -32700 | ${badJson.status} / ${badJson.json?.error?.code} |`);
  say(`| 未知工具 | -32602 + known 列表 | ${noTool.error?.code} / ${(noTool.error?.data?.known || []).length} 个已知 |`);
  say(`| 未实现方法 resources/read | -32601 | ${noMethod.error?.code} |`);
  say(`| PUT | 405 + Allow: POST | ${put.status} / ${put.headers.get('allow')} |`);
  say(`| 批量（含通知） | 200 + 2 条响应 | ${Array.isArray(batch.json) ? batch.json.length : '?'} 条 |`);
  say('');
} catch (err) {
  check('整个流程没抛异常', false, String(err?.message || err));
  say(`## ✖ 流程中断`);
  say('');
  say('```');
  say(String(err?.stack || err));
  say('```');
  say('');
} finally {
  // ── 5. 收摊 ─────────────────────────────────────────────────────
  if (host?.child?.pid) {
    spawnSync('taskkill', ['/PID', String(host.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  const passed = checks.filter(([, ok]) => ok).length;
  say('## 5. 断言');
  say('');
  say('| # | 断言 | 结果 | 证据 |');
  say('| --- | --- | --- | --- |');
  checks.forEach(([name, ok, extra], i) => {
    say(`| ${i + 1} | ${name} | ${ok ? '✅' : '❌'} | ${String(extra || '').replace(/\|/g, '\\|').slice(0, 120)} |`);
  });
  say('');
  say(`**${passed}/${checks.length} 条断言通过。**`);
  say('');
  say(passed === checks.length
    ? '结论：MCP Streamable HTTP 是真端点——两个只有 `fetch` 的「远程客户端」在这台机器上完成了一次真实协作（建组 → 开会 → 结会 → 任务落板 → 纪要落盘），全程没有装任何东西、没有起任何子进程；没实现的部分（SSE 推流、有状态会话）按规范如实拒绝。'
    : '结论：有断言没过，别把它当已完成。');
  say('');
  say('## 6. 收摊');
  say('');
  say(`- 宿主进程（PID ${host?.child?.pid ?? '?'}）已 taskkill /T /F`);
  say(`- 临时目录 \`${ROOT}\` 已删`);
  say(`- 原始帧：\`${RAW.replace(PKG + '\\', '')}\``);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
  writeFileSync(RAW, `${transcript.map((t) => JSON.stringify(t)).join('\n')}\n`, 'utf8');
  rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n[evidence] ${OUT}`);
  console.log(`[evidence] ${RAW}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}
