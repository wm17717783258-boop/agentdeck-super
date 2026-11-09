// M4 真机证据：三个独立 Agent 进程开一场会并产出任务；到点的定时任务受审批与全局停止约束。
//
//   node tools/verify-m4.mjs
//
// 全部是真进程：
//   · 三个 `nexi mcp` 各自一条独立 stdio JSON-RPC 连接（Claude / Codex / DSH 各一条，互不知道对方）
//   · 一个真 DSH 宿主（`dsh --profile web`）跑着已装进 profile 的那份插件，巡检 3 秒一拍
// 结论只认盘上的文件与命令行的真实回显，不认"设计上应该"。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildSpawnInvocation } from '../lib/engine/cli.js';
import { prepareDshProfile } from './dsh-fixture.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const OUT = join(PKG, 'docs', 'evidence', `m4-${ver}.txt`);
const RAW = join(PKG, 'docs', 'evidence', `m4-mcp-${ver}.jsonl`);
const ROOT = mkdtempSync(join(tmpdir(), 'nexi-m4-'));
const WORK = join(ROOT, 'work');
const BOARD = join(ROOT, 'board');
const LIC = join(ROOT, 'lic');
const AUTODIR = join(WORK, '.agentdeck', 'automation');

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transcript = [];
const checks = [];
const check = (name, ok, extra = '') => { checks.push([name, !!ok, extra]); };

const ENV = {
  ...process.env,
  NEXI_WORKSPACE: WORK,
  NEXI_BOARD_ROOT: BOARD,
  NEXI_PET_ROOT: WORK,
  NEXI_LICENSE_ROOT: LIC,
};
let fixture = null;

function cli(args) {
  const res = spawnSync(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), ...args], {
    env: ENV, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  return { code: res.status, out: String(res.stdout || '').trim(), err: String(res.stderr || '') };
}

/** 一条独立的 MCP 连接：真实进程 + 真实 stdio JSON-RPC。 */
function mcpClient(tag) {
  const child = spawn(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), 'mcp'], {
    env: ENV, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const waiters = new Map();
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    transcript.push({ tag, dir: 'in', line });
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  });
  child.stderr.on('data', (c) => { transcript.push({ tag, dir: 'err', line: String(c).trim() }); });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`${tag} 等 ${method} 超时`)), 45000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    transcript.push({ tag, dir: 'out', line: payload });
    child.stdin.write(`${payload}\n`);
  });
  const notify = (method, params) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    transcript.push({ tag, dir: 'out', line: payload });
    child.stdin.write(`${payload}\n`);
  };
  return { tag, child, rpc, notify, kill: () => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) };
}

async function handshake(client, who) {
  const init = await client.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: who, version: '1.0.0' },
  });
  client.notify('notifications/initialized', {});
  return init;
}

async function callTool(client, name, args) {
  const res = await client.rpc('tools/call', { name, arguments: args });
  if (res.error) return { text: `❌ JSON-RPC 错误：${res.error.message}`, raw: res };
  const content = res.result?.content || [];
  const text = content.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n');
  return { text, raw: res };
}

function autoState() {
  const file = join(AUTODIR, 'state.json');
  if (!existsSync(file)) return { jobs: [], approvals: [], runs: [], stopped: null };
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { jobs: [], approvals: [], runs: [], stopped: null }; }
}
const runsOf = (state, title) => (state.runs || []).filter((r) => String(r.jobTitle || '').includes(title));

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
    '      enabled: true',
    '      tickMs: 3000',
  ].join('\n') + '\n', 'utf8');
  const [exe, argv, spawnOpts] = buildSpawnInvocation(
    fixture.dsh,
    ['--profile', fixture.profile, '--patch', overlay, '--no-open', '--port', String(port)],
    fixture.env,
  );
  const child = spawn(exe, argv, {
    env: fixture.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...spawnOpts,
  });
  let log = '';
  child.stdout.on('data', (c) => { log += String(c); });
  child.stderr.on('data', (c) => { log += String(c); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`宿主 120 秒没起来：\n${log.slice(-500)}`);
    try { const res = await fetch(`${base}/deck`); if (res.ok) break; } catch { /* 还没监听 */ }
    await sleep(700);
  }
  return { base, child, port, log: () => log };
}

async function until(fn, ms, every = 1000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(every);
  }
}

// ─────────────────────────────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
for (const d of [WORK, BOARD, LIC]) mkdirSync(d, { recursive: true });

fixture = prepareDshProfile();
ENV.DSH_HOME = fixture.home;
const installedPkg = join(fixture.profileDir, 'node_modules', 'agentdeck-super', 'package.json');

say(`# M4 真机证据：三个 Agent 开会产出任务 + 定时任务真的到点执行（${ver}）`);
say(`# ${new Date().toISOString()}`);
say('');
say('## 0. 这次验的是哪份东西');
say('');
say(`- 仓库版本：\`${ver}\`（\`package.json\`）`);
say(`- 装进临时 profile \`${fixture.profile}\` 的那份：\`${existsSync(installedPkg) ? JSON.parse(readFileSync(installedPkg, 'utf8')).version : '(没装)'}\``);
say(`- 工作区（会/自动化/任务板都在这里）：\`${WORK}\``);
say(`- 授权根：\`${LIC}\`（不参与本次验证，只是别污染真机授权）`);
say('');

// 1. 建一个小组：所有任务都落在这一个组里
const created = cli(['call', 'team_board', JSON.stringify({ action: 'create', name: 'M4 真机会议', goal: '三个不同厂商的 Agent 开一场会，把决议拆成任务' })]);
const teamId = (created.out.match(/已创建小组\s*(team_[0-9a-z]+)/) || [])[1] || '';
check('小组建起来了（有 teamId）', !!teamId, teamId);
say('## 1. 建组');
say('');
say('```');
say(created.out.split('\n').slice(0, 2).join('\n'));
say('```');
say('');

// 2. 三条独立 MCP 连接
const agents = [
  { tag: 'claude-code', who: 'Claude Code', vendor: 'claude-code', stance: '支持', text: '会议纪要要落盘成文件，别只存在内存里——出了事得能回看谁说了什么。' },
  { tag: 'codex', who: 'Codex', vendor: 'codex', stance: '补充', text: '结会时直接把活拆成带验收标准的任务，别留一堆"待办"让人再手工搬一遍。' },
  { tag: 'dsh', who: 'DSH', vendor: 'dsh', stance: '反对', text: '反对让模型替人改写意见；不同厂商的 Agent 原话必须原样留着，否则纪要就是二创。' },
];
const clients = agents.map((a) => mcpClient(a.tag));
const initOk = [];
for (let i = 0; i < clients.length; i++) {
  const init = await handshake(clients[i], agents[i].who);
  initOk.push(init.result?.serverInfo?.name === 'nexi');
}
check('三条独立 MCP 进程都 initialize 成功（serverInfo=nexi）', initOk.every(Boolean), JSON.stringify(initOk));

const toolsList = await clients[0].rpc('tools/list', {});
const toolNames = (toolsList.result?.tools || []).map((t) => t.name);
const hubToolCount = (() => {
  try {
    const r = cli(['status']);
    const n = JSON.parse(String(r.out || '{}')).tools;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
})();
check(
  '工具面与 Hub 一致，且含 deck_meeting / deck_automation',
  toolNames.length >= 20
    && (!hubToolCount || toolNames.length === hubToolCount)
    && toolNames.includes('deck_meeting')
    && toolNames.includes('deck_automation'),
  `${toolNames.length} 个 / Hub ${hubToolCount || '?'} 个`,
);

const opened = await callTool(clients[0], 'deck_meeting', {
  action: 'open',
  topic: '纪要该由谁写、任务该怎么落地',
  goal: '定下纪要规则，并把后续三件事落进任务板',
  participants: agents.map((a) => `${a.who}:${a.vendor}`),
});
const meetingId = (opened.text.match(/会议号：(\S+)/) || [])[1] || '';
check('会议开起来了（有会议号）', !!meetingId, meetingId);

const submits = [];
for (let i = 0; i < agents.length; i++) {
  const r = await callTool(clients[i], 'deck_meeting', {
    action: 'submit',
    meetingId,
    from: agents[i].who,
    vendor: agents[i].vendor,
    stance: agents[i].stance,
    text: agents[i].text,
  });
  submits.push(r.text);
}
const counts = submits.map((s) => Number((s.match(/第 (\d+) 条/) || [])[1] || 0));
check('三条独立连接各自发言成功，序号 1/2/3', counts.join(',') === '1,2,3', counts.join(','));

const tasks = [
  { title: '把会议纪要落成文件并加"原文未改写"声明', role: 'worker', acceptance: '纪要文件里逐条保留发言原文，页脚声明未改写' },
  { title: '结会时自动拆任务并把验收标准写进任务', role: 'worker', acceptance: '任务板里出现带 acceptance 的任务，来源标 meeting' },
  { title: '补一条越权/注入测试，证明不可信内容驱动不了外部动作', role: 'tester', acceptance: '新增测试文件，跑出"拦住"的断言' },
];
const concluded = await callTool(clients[2], 'deck_meeting', {
  action: 'conclude',
  meetingId,
  decision: '纪要落文件且发言原文不改写；结会即拆任务进任务板，每条带验收标准；先补越权测试再谈对外发布。',
  tasks,
  teamId: teamId || undefined,
});
const minutesFile = (concluded.text.match(/纪要：(.*)/) || [])[1]?.trim() || '';
check('结会成功并给出纪要路径', !!minutesFile, minutesFile);
check('结会声明任务已进任务板（真写）', /已写进任务板/.test(concluded.text), concluded.text.split('\n').find((l) => l.includes('任务：')) || '');

// 3. 纪要原文回读
let minutesText = '';
if (minutesFile && existsSync(minutesFile)) minutesText = readFileSync(minutesFile, 'utf8');
const verbatim = agents.every((a) => minutesText.includes(a.text));
check('纪要里三条发言逐字存在（没被模型改写）', verbatim);
check('纪要页脚声明"原文保留、不改写"', /不改写/.test(minutesText));

// 4. 任务板真去查（另一条独立 CLI 进程读同一块板）
const boardList = cli(['call', 'team_board', JSON.stringify({ action: 'list', teamId })]);
const taskHits = tasks.filter((t) => boardList.out.includes(t.title)).length;
check('任务板查得到这 3 条任务', taskHits === 3, `${taskHits}/3`);

say('## 2. 三个独立 Agent 进程，一场会');
say('');
say('| 连接 | 进程 | initialize | 发言序号 |');
say('| --- | --- | --- | --- |');
for (let i = 0; i < agents.length; i++) say(`| \`${agents[i].tag}\` | PID ${clients[i].child.pid} | ${initOk[i] ? '✅' : '❌'} | 第 ${counts[i]} 条 |`);
say('');
say(`会议号：\`${meetingId}\`；工具面：${toolNames.length} 个（Hub ${hubToolCount || '?'} 个；含 deck_meeting / deck_automation）。`);
say('');
say('### 结会回显（原样）');
say('');
say('```');
say(concluded.text);
say('```');
say('');
say('### 纪要帧（前 24 行）');
say('');
say('```');
say(minutesText.split('\n').slice(0, 24).join('\n'));
say('```');
say('');
say('### 任务板回显（独立进程）');
say('');
say('```');
say(boardList.out.split('\n').slice(0, 24).join('\n'));
say('```');
say('');

// 5. 真宿主 + 到点的定时任务
say('## 3. 真宿主里，到点的定时任务');
say('');
const host = await startHost();
say(`- 宿主：\`${host.base}\`（PID ${host.child.pid}，\`--profile ${fixture.profile}\`，巡检 3 秒一拍）`);

const addApproval = cli(['call', 'deck_automation', JSON.stringify({
  action: 'add', title: 'M4-A 要审批的活', kind: 'task', teamId, needsApproval: true,
  at: new Date(Date.now() + 7000).toISOString(), acceptance: '人点头之后任务板上才出现这条',
})]);
const jobA = (addApproval.out.match(/编号：(\S+)/) || [])[1] || '';
say(`- 加了一条"要审批"的任务（${jobA}），7 秒后到点`);

const approval = await until(() => {
  const s = autoState();
  return (s.approvals || []).find((a) => a.status === 'pending' && String(a.title).includes('M4-A'));
}, 60000, 1500);
check('到点只进审批队列（没偷偷执行）', !!approval, approval?.id || '');
const runsBefore = runsOf(autoState(), 'M4-A').length;
check('审批前一次都没执行', runsBefore === 0, `runs=${runsBefore}`);

const stopRes = cli(['stop', 'M4 演练：全局停止']);
const stopped = autoState().stopped;
check('`nexi stop` 把停止标志落到盘上（跨进程生效）', !!stopped && String(stopped.reason || '').includes('M4 演练'), JSON.stringify(stopped || null));

const addDirect = cli(['call', 'deck_automation', JSON.stringify({
  action: 'add', title: 'M4-B 到点就该动', kind: 'task', teamId,
  at: new Date(Date.now() + 5000).toISOString(), acceptance: '恢复之后任务板上出现这条',
})]);
const jobB = (addDirect.out.match(/编号：(\S+)/) || [])[1] || '';
say(`- 停止期间又加了一条"到点就该动"的（${jobB}），5 秒后到点`);
await sleep(20000);
const runsDuringStop = runsOf(autoState(), 'M4-B').length;
check('全局停止期间到点也不动（20 秒内 0 次执行）', runsDuringStop === 0, `runs=${runsDuringStop}`);

cli(['resume']);
say('- `nexi resume` 之后等它自己到点跑');
const ranB = await until(() => runsOf(autoState(), 'M4-B').length > 0, 60000, 2000);
check('恢复后下一拍就真跑（宿主巡检读的是同一份盘上状态）', !!ranB, ranB ? JSON.stringify(ranB).slice(0, 160) : '');

const approvedRes = cli(['approve', approval?.id || '']);
check('审批放行后真执行了那一条', runsOf(autoState(), 'M4-A').length > 0, approvedRes.out.split('\n')[0] || '');
const boardAfter = cli(['call', 'team_board', JSON.stringify({ action: 'list', teamId })]);
check('执行结果是任务板上的真任务（不是日志里的一句话）', boardAfter.out.includes('M4-B 到点就该动') && boardAfter.out.includes('M4-A 要审批的活'));

say('');
say('### 自动化状态（\`.agentdeck/automation/state.json\` 真读）');
say('');
const finalState = autoState();
say('```json');
say(JSON.stringify({
  stopped: finalState.stopped,
  jobs: (finalState.jobs || []).map((j) => ({ id: j.id, title: j.title, needsApproval: !!j.needsApproval, nextAt: j.nextAt })),
  approvals: (finalState.approvals || []).map((a) => ({ id: a.id, title: a.title, status: a.status })),
  runs: (finalState.runs || []).map((r) => ({ at: r.at, jobTitle: r.jobTitle, ok: r.ok, by: r.by })),
}, null, 2));
say('```');
say('');
say('### 停止/恢复/审批的命令行回显');
say('');
say('```');
say(`$ nexi stop  → ${stopRes.out}`);
say(`$ nexi resume → (见上，退出码 0)`);
say(`$ nexi approve ${approval?.id || ''} → ${approvedRes.out}`);
say('```');
say('');

// 6. 断言表
const bad = checks.filter(([, ok]) => !ok);
say('## 4. 断言');
say('');
for (const [name, ok, extra] of checks) say(`- ${ok ? '✅' : '❌'} ${name}${extra ? `（${extra}）` : ''}`);
say('');
say('## 5. 收摊');
say('');
say(`- 演示目录 \`${ROOT}\` 整棵删掉（会议纪要、任务板、自动化状态、授权根都在里面）。`);
say(`- 原始 JSON-RPC 逐行记录留在 \`docs/evidence/${RAW.split('\\').pop()}\`（${transcript.length} 行），可以自己数。`);
say(`- 宿主 PID ${host.child.pid} 连子进程一起结束；没有碰任何正在用的 profile 授权。`);
say('');
say(bad.length
  ? `**结论：${checks.length} 项断言里 ${bad.length} 项没过，不算通过。**`
  : `**结论：${checks.length} 项断言全过——三个独立厂商的 Agent 进程真开了一场会，纪要逐字留档，决议真拆成了任务板上的任务；真宿主里的定时任务到点只进审批队列，全局停止期间一条不动，恢复后自己跑，审批放行后真把活干了。**`);

spawnSync('taskkill', ['/PID', String(host.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
for (const c of clients) c.kill();
await sleep(500);
rmSync(ROOT, { recursive: true, force: true });
fixture?.cleanup();
writeFileSync(RAW, transcript.map((t) => `[${t.tag}][${t.dir}] ${t.line}`).join('\n') + '\n', 'utf8');
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`[written] ${OUT}`);
console.log(`[written] ${RAW}`);
process.exitCode = bad.length ? 1 : 0;
