// M4.5 真机证据：MCP 只读模式（mcp.readOnly）——把本机 Hub 借给别人时，只能读、不能改。
//
//   node tools/verify-readonly.mjs
//
// 证的是什么（都是真进程）：
//   · 宿主 A：`mcp.readOnly: true`。tools/list 里写工具消失；写动作真被拒（isError）；读动作照常；盘上没多出任何东西。
//   · 宿主 B：默认配置（对照组）。同一个写动作能过，任务板真多一条 —— 证明差别来自开关，不是本来就不行。
//   · CLI：`nexi mcp --read-only`（stdio 那条路）同样拒写。
// 结论只认 HTTP 响应体 + 盘上文件 + CLI 回显。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const OUT = join(PKG, 'docs', 'evidence', `readonly-${ver}.txt`);
const ROOT = 'D:\\demo\\readonly';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, extra = '') => { checks.push([name, !!ok, extra]); };
const clip = (s, n = 600) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

function mcpClient(base) {
  const url = `${base}/adbp/v1/mcp`;
  let seq = 0;
  const post = async (payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 留 null */ }
    return { status: res.status, text, json };
  };
  const rpc = async (method, params) => {
    const res = await post({ jsonrpc: '2.0', id: ++seq, method, params });
    if (!res.json) throw new Error(`${method} 没拿到 JSON：${clip(res.text, 200)}`);
    return res.json;
  };
  const callTool = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) return { text: `❌ ${res.error.message}`, isError: true, raw: res };
    const content = res.result?.content || [];
    return {
      text: content.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n'),
      isError: res.result?.isError === true,
      raw: res,
    };
  };
  return { url, rpc, callTool };
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

/** 起一个真宿主；readOnly=true 时把 mcp.readOnly 写进 overlay。 */
async function startHost(tag, { readOnly }) {
  const base = join(ROOT, tag);
  const work = join(base, 'work');
  const board = join(base, 'board');
  const lic = join(base, 'lic');
  for (const d of [work, board, lic]) mkdirSync(d, { recursive: true });
  const overlay = join(base, 'host.yml');
  writeFileSync(overlay, [
    '- id: agentdeck-super',
    '  config:',
    `    workspace: ${work}`,
    `    boardRoot: ${board}`,
    `    petRoot: ${work}`,
    `    licenseRoot: ${lic}`,
    '    automation:',
    '      enabled: false',
    '    mcp:',
    `      readOnly: ${readOnly ? 'true' : 'false'}`,
  ].join('\n') + '\n', 'utf8');
  const port = await firstFreePort();
  const child = spawn('cmd.exe', ['/c', 'dsh', '--profile', 'web', '--patch', overlay, '--no-open', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (c) => { log += String(c); });
  child.stderr.on('data', (c) => { log += String(c); });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`宿主 ${tag} 120 秒没起来：\n${log.slice(-600)}`);
    try { const res = await fetch(`${url}/deck`); if (res.ok) break; } catch { /* 还没监听 */ }
    await sleep(700);
  }
  return { tag, base: url, port, child, log: () => log, work, board };
}

const profileDir = join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web');
const installedPkg = join(profileDir, 'node_modules', 'agentdeck-super', 'package.json');
const installedVer = existsSync(installedPkg) ? JSON.parse(readFileSync(installedPkg, 'utf8')).version : '(没装)';

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

say(`# M4.5 真机证据：MCP 只读模式（mcp.readOnly，只给看不给改）（${ver}）`);
say(`# ${new Date().toISOString()}`);
say('');
say('## 0. 这次验的是哪份东西');
say('');
say(`- 仓库版本：\`${ver}\`（\`package.json\`）`);
say(`- 装进 \`web\` profile 的那份：\`${installedVer}\``);
say(`- 临时目录（不碰真机数据）：\`${ROOT}\``);
say('');

const hosts = [];
try {
  // ── A. 只读宿主 ─────────────────────────────────────────────
  const a = await startHost('ro', { readOnly: true });
  hosts.push(a.child);
  const ca = mcpClient(a.base);
  const initA = await ca.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: '只读客户端', version: '1.0.0' } });
  const summaryA = await (await fetch(`${a.base}/adbp/v1/mcp`)).json();
  const listA = await ca.rpc('tools/list', {});
  const toolsA = (listA.result?.tools || []).map((t) => t.name);

  say('## 1. 宿主 A：`mcp.readOnly: true`');
  say('');
  say(`- 宿主地址：\`${a.base}\`（真 \`dsh --profile web\`，PID ${a.child.pid}）`);
  say(`- initialize 里的自述：${initA.result?.instructions}`);
  say(`- GET /v1/mcp：readOnly=\`${summaryA.readOnly}\`，清单里 ${(summaryA.tools || []).length} 个工具`);
  say(`- tools/list：${toolsA.length} 个 —— ${toolsA.join('、')}`);
  say('');
  check('initialize 自报只读模式', /只读模式/.test(String(initA.result?.instructions)), clip(initA.result?.instructions, 80));
  check('GET /v1/mcp 的 readOnly 字段为 true', summaryA.readOnly === true, String(summaryA.readOnly));
  check('清单页工具数和 tools/list 一致（网页上看到的=真能调的）', (summaryA.tools || []).length === toolsA.length, `${(summaryA.tools || []).length} vs ${toolsA.length}`);
  check('tools/list 不再广告 super_agent', !toolsA.includes('super_agent'), toolsA.join(','));
  check('tools/list 不再广告 twin_remember', !toolsA.includes('twin_remember'), toolsA.join(','));
  check('tools/list 仍然给 twin_recall（只读≠残废）', toolsA.includes('twin_recall'), toolsA.join(','));
  const boardDef = (listA.result?.tools || []).find((t) => t.name === 'team_board');
  check('team_board 描述里标明只剩哪些动作', /只读模式：仅 .*list/.test(String(boardDef?.description)), clip(boardDef?.description, 120));

  say('## 2. 宿主 A：写动作真被拒，且盘上没多东西');
  say('');
  const createA = await ca.callTool('team_board', { action: 'create', name: '不该建起来的小组' });
  const addA = await ca.callTool('team_board', { action: 'add', title: '不该出现的任务' });
  const rememberA = await ca.callTool('twin_remember', { text: '不该记住的秘密', type: 'fact' });
  const meetingA = await ca.callTool('deck_meeting', { action: 'open', topic: '不该开的会' });
  const listAfter = await ca.callTool('team_board', { action: 'list' });
  const recallA = await ca.callTool('twin_recall', { query: '秘密', any: true });
  say('```');
  say(`create   → isError=${createA.isError}  ${clip(createA.text, 120)}`);
  say(`add      → isError=${addA.isError}  ${clip(addA.text, 120)}`);
  say(`remember → isError=${rememberA.isError}  ${clip(rememberA.text, 120)}`);
  say(`meeting  → isError=${meetingA.isError}  ${clip(meetingA.text, 120)}`);
  say(`list     → isError=${listAfter.isError}  ${clip(listAfter.text, 120)}`);
  say(`recall   → isError=${recallA.isError}  ${clip(recallA.text, 120)}`);
  say('```');
  say('');
  check('写动作 create 被拒（isError）', createA.isError === true, clip(createA.text, 80));
  check('写动作 add 被拒（isError）', addA.isError === true, clip(addA.text, 80));
  check('写动作 twin_remember 被拒', rememberA.isError === true, clip(rememberA.text, 80));
  check('写动作 deck_meeting open 被拒', meetingA.isError === true, clip(meetingA.text, 80));
  check('读动作 team_board list 照常返回', listAfter.isError === false, clip(listAfter.text, 80));
  check('读动作 twin_recall 照常返回', recallA.isError === false, clip(recallA.text, 80));
  check('任务板里没有那条"不该出现的任务"', !/不该出现的任务/.test(listAfter.text), clip(listAfter.text, 120));
  check('记忆里没有那条"不该记住的秘密"', !/不该记住的秘密/.test(recallA.text), clip(recallA.text, 120));
  const boardFile = join(a.board, 'board.json');
  const boardText = existsSync(boardFile) ? readFileSync(boardFile, 'utf8') : '';
  check('盘上 board.json 里也没有那条任务', !/不该出现的任务/.test(boardText), existsSync(boardFile) ? `${boardText.length} 字节` : 'board.json 不存在（连组都没建）');

  say('## 3. 对照组：同一台机器、默认配置的宿主（证明差别来自开关）');
  say('');
  const b = await startHost('rw', { readOnly: false });
  hosts.push(b.child);
  const cb = mcpClient(b.base);
  await cb.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: '普通客户端', version: '1.0.0' } });
  const summaryB = await (await fetch(`${b.base}/adbp/v1/mcp`)).json();
  const listB = await cb.rpc('tools/list', {});
  const toolsB = (listB.result?.tools || []).map((t) => t.name);
  const createB = await cb.callTool('team_board', { action: 'create', name: '普通模式能建' });
  const addB = await cb.callTool('team_board', { action: 'add', title: '普通模式能加的任务' });
  const listB2 = await cb.callTool('team_board', { action: 'list' });
  say(`- 宿主 B：\`${b.base}\`（PID ${b.child.pid}），tools/list ${toolsB.length} 个，readOnly=\`${summaryB.readOnly}\``);
  say('```');
  say(`create → isError=${createB.isError}  ${clip(createB.text, 120)}`);
  say(`add    → isError=${addB.isError}  ${clip(addB.text, 120)}`);
  say(`list   → ${clip(listB2.text, 200)}`);
  say('```');
  say('');
  // 工具总数不写死：加一个工具就要改一次验收脚本，那是迟早会漏的债。
  // 这里只钉住两条跟版本无关的事实：① 完整模式 = Hub 全部工具（不是残的）；② 只读模式正好少了 4 个。
  check(
    '对照组 tools/list 就是 Hub 全部工具（比只读组多 4 个整体不可用的）',
    toolsB.length - toolsA.length === 4,
    `只读 ${toolsA.length} / 完整 ${toolsB.length}`,
  );
  check('对照组工具数 >= 21（少了说明有工具没挂上）', toolsB.length >= 21, String(toolsB.length));
  check('对照组 readOnly=false', summaryB.readOnly === false, String(summaryB.readOnly));
  check('对照组 create 成功（不是工具坏了）', createB.isError === false, clip(createB.text, 80));
  check('对照组 add 成功且任务板上能看到', addB.isError === false && /普通模式能加的任务/.test(listB2.text), clip(listB2.text, 100));

  // ── 4. CLI：stdio 那条路也认只读 ─────────────────────────────
  say('## 4. CLI（stdio）：`nexi mcp --read-only`');
  say('');
  const env = { ...process.env, NEXI_WORKSPACE: join(ROOT, 'cli', 'work'), NEXI_BOARD_ROOT: join(ROOT, 'cli', 'board') };
  mkdirSync(env.NEXI_WORKSPACE, { recursive: true });
  mkdirSync(env.NEXI_BOARD_ROOT, { recursive: true });
  const script = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'team_board', arguments: { action: 'add', title: 'CLI 不该加的' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'team_board', arguments: { action: 'list' } } }),
  ].join('\n') + '\n';
  const cliRun = spawnSync(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), 'mcp', '--read-only'], {
    env, encoding: 'utf8', input: script, timeout: 120000, windowsHide: true,
  });
  const replies = String(cliRun.stdout || '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId = (n) => replies.find((r) => r.id === n);
  const cliTools = (byId(2)?.result?.tools || []).map((t) => t.name);
  const cliAdd = byId(3)?.result;
  const cliList = byId(4)?.result;
  say(`- 回包 ${replies.length} 条；tools/list ${cliTools.length} 个；add isError=${cliAdd?.isError === true}`);
  say('```');
  say(clip(cliAdd?.content?.[0]?.text, 200));
  say('```');
  say('');
  check(
    'CLI 只读：tools/list 比完整模式少 4 个（整体不可用的被摘掉）',
    cliTools.length > 0 && cliTools.length === toolsB.length - 4,
    `CLI 只读 ${cliTools.length} / 完整 ${toolsB.length}`,
  );
  check('CLI 只读：add 返回 isError', cliAdd?.isError === true, clip(cliAdd?.content?.[0]?.text, 80));
  check('CLI 只读：list 正常返回', cliList?.isError !== true, clip(cliList?.content?.[0]?.text, 80));
  check('CLI 只读：板上没有"CLI 不该加的"', !/CLI 不该加的/.test(String(cliList?.content?.[0]?.text || '')), clip(cliList?.content?.[0]?.text, 100));
} finally {
  for (const child of hosts) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' }); } catch { /* 已经退出 */ }
  }
}

const pass = checks.filter(([, ok]) => ok).length;
const fail = checks.length - pass;
say('## 结论');
say('');
for (const [name, ok, extra] of checks) say(`- ${ok ? '✔' : '✘'} ${name}${extra ? `　（${extra}）` : ''}`);
say('');
say(`**${pass} 过 / ${fail} 失败**（共 ${checks.length} 条断言）`);
if (fail) {
  say('');
  say('失败项就是没做到的：别改文案，改代码再跑一遍。');
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
say('');
say(`证据已写入：${OUT}`);
process.exitCode = fail ? 1 : 0;
