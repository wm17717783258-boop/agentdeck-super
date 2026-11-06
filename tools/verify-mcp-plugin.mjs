/**
 * 插件测试方式演示 1：**真 MCP 协议对话**（stdio JSON-RPC）
 *
 * 这就是别的 Agent（Claude Code / Codex / Cursor…）拿到插件之后做的事：
 * 起一个子进程 → 走 JSON-RPC → initialize → tools/list → tools/call。
 *
 * 和后端 HTTP 那套的区别：那条路是我们自己的宿主；
 * 这条路是**任何装了插件的 Agent** 都会走的路，必须单独验。
 *
 * 用法：node tools/verify-mcp-plugin.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const OUT = join(REPO, 'docs', 'evidence', 'mcp-plugin-1.10.0.txt');

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => lines.push(t);

/** 起真的 MCP server 子进程（就是宿主会起的那条命令）。 */
function startServer(env = {}) {
  const child = spawn(process.execPath, [join(REPO, 'bin', 'nexi.mjs'), 'mcp'], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  const pending = new Map();
  const raw = [];
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      raw.push(line);
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((done, reject) => {
    id += 1;
    const myId = id;
    const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 30000);
    pending.set(myId, (m) => { clearTimeout(timer); done(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return { child, rpc, notify, raw, stop: () => { try { child.kill(); } catch { /* 已退 */ } } };
}

async function main() {
  say('插件测试方式 1：真 MCP 协议对话（别的 Agent 拿到插件后就是这么用的）');
  say('='.repeat(68));
  say(`时间：${new Date().toISOString()}`);
  say('做法：起真子进程 `node bin/nexi.mjs mcp`，走 stdio 的 JSON-RPC 2.0：');
  say('      initialize → tools/list → tools/call；协议版本、工具数、真调用都验。');
  say('');

  const root = mkdtempSync(join(tmpdir(), 'nexi-mcp-plugin-'));
  mkdirSync(join(root, 'work'), { recursive: true });
  const srv = startServer({
    NEXI_WORKSPACE: join(root, 'work'),
    NEXI_BOARD_ROOT: join(root, 'board'),
    NEXI_LICENSE_ROOT: join(root, 'lic'),
  });

  try {
    /* ── 1. 握手 ─────────────────────────────────────────────────── */
    say('【第 1 步】握手（initialize）');
    const init = await srv.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: '插件测试客户端', version: '1.0.0' },
    });
    chk(init?.result?.protocolVersion === '2025-06-18', '协议版本协商成功',
      String(init?.result?.protocolVersion));
    chk(Boolean(init?.result?.serverInfo?.name), '服务端自报名字',
      String(init?.result?.serverInfo?.name));
    say(`     serverInfo：${JSON.stringify(init?.result?.serverInfo)}`);
    srv.notify('notifications/initialized', {});
    say('');

    /* ── 2. 工具清单 ─────────────────────────────────────────────── */
    say('【第 2 步】工具清单（tools/list）');
    const list = await srv.rpc('tools/list', {});
    const tools = list?.result?.tools || [];
    chk(tools.length >= 21, '工具清单拿得到', `${tools.length} 个`);
    const names = tools.map((t) => t.name);
    for (const must of ['team_board', 'super_agent', 'deck_team', 'deck_policy', 'deck_audit', 'pet_skin', 'twin_remember']) {
      chk(names.includes(must), `清单里有 ${must}`);
    }
    // 每个工具都必须是合法 MCP 工具形状（宿主靠这个渲染给模型）
    const badShape = tools.filter((t) => !t.name || !t.description || !t.inputSchema);
    chk(badShape.length === 0, '每个工具都有 name/description/inputSchema',
      badShape.length ? `不合格：${badShape.map((t) => t.name).join(',')}` : '');
    const noEnum = tools.filter((t) => t.inputSchema?.properties?.action && !t.inputSchema.properties.action.enum);
    chk(noEnum.length === 0, '带 action 的工具都把枚举广告出来了',
      noEnum.length ? `缺枚举：${noEnum.map((t) => t.name).join(',')}` : '');
    say('');

    /* ── 3. 真调用几个（覆盖读/写/加密/审计）─────────────────────── */
    say('【第 3 步】真调用（tools/call）—— 挑典型的几个动作');
    const call = async (name, args) => {
      const r = await srv.rpc('tools/call', { name, arguments: args });
      const c = r?.result?.content || [];
      return { text: c.map((x) => x.text || '').join('\n'), isError: Boolean(r?.result?.isError), raw: r };
    };

    const cat = await call('deck_market', { action: 'catalog' });
    chk(!cat.isError && /货架|套/.test(cat.text), '读动作：deck_market catalog', cat.text.split('\n')[0].slice(0, 70));

    const created = await call('team_board', { action: 'create', name: 'MCP 测试组' });
    chk(!created.isError && /team_/.test(created.text), '写动作：team_board create', created.text.split('\n')[0].slice(0, 80));

    const w = await call('twin_remember', { text: 'MCP 协议测试记的一条' });
    chk(!w.isError && /已记住|已合并/.test(w.text), '分身记忆：twin_remember', w.text.split('\n')[0].slice(0, 70));
    const r = await call('twin_recall', { any: true, limit: 3 });
    chk(/MCP 协议测试记的一条/.test(r.text), '召回读得回来（写→读闭环）');

    const inv = await call('pet_visit', { action: 'invite', ttlHours: 1 });
    chk(!inv.isError && /dsh:\/\//.test(inv.text), '串门邀请函生成', inv.text.split('\n').slice(0, 2).join(' ').slice(0, 80));

    const memo = await call('twin_brief', {});
    chk(!memo.isError && memo.text.length > 10, '今日简报有内容');

    // 错误路径：不认识的工具必须给协议级错误，不是静默
    const bogus = await srv.rpc('tools/call', { name: 'no_such_tool_xyz', arguments: {} });
    chk(Boolean(bogus?.error), '调不存在的工具 → 返回 JSON-RPC error（不是静默）',
      String(bogus?.error?.code ?? ''));
    const badMethod = await srv.rpc('no/such/method', {});
    chk(badMethod?.error?.code === -32601, '不认识的方法 → -32601',
      String(badMethod?.error?.code));
    say('');

    /* ── 4. 只读模式：换个开关，写动作必须被拒 ──────────────────── */
    say('【第 4 步】只读模式（NEXI_MCP_READONLY=1）——同一个插件、同一个命令');
    const ro = startServer({
      NEXI_WORKSPACE: join(root, 'work2'),
      NEXI_BOARD_ROOT: join(root, 'board2'),
      NEXI_LICENSE_ROOT: join(root, 'lic'),
      NEXI_MCP_READONLY: '1',
    });
    try {
      await ro.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ro', version: '1' } });
      ro.notify('notifications/initialized', {});
      const roList = await ro.rpc('tools/list', {});
      const roTools = roList?.result?.tools || [];
      chk(roTools.length < tools.length, '只读模式工具更少', `只读 ${roTools.length} / 完整 ${tools.length}`);
      chk(!roTools.some((t) => t.name === 'super_agent'), 'super_agent 在只读模式下消失');

      const roCall = (name, args) => ro.rpc('tools/call', { name, arguments: args });
      const roWrite = await roCall('team_board', { action: 'create', name: '不该建出来' });
      chk(Boolean(roWrite?.result?.isError), '只读模式下写动作返回 isError');
      const roRead = await roCall('team_board', { action: 'list' });
      chk(!roRead?.result?.isError, '只读模式下读动作照常可用');
    } finally {
      ro.stop();
    }
    say('');

    /* ── 5. 干净退出 ─────────────────────────────────────────────── */
    say('【第 5 步】进程行为');
    chk(srv.raw.length > 0, 'stdout 里全都是 JSON-RPC 帧（不会混进日志）');
    const nonJson = srv.raw.filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
    chk(nonJson.length === 0, 'stdout 没有非 JSON 杂质', nonJson.length ? nonJson[0].slice(0, 60) : '');
    say('');

    say('='.repeat(68));
    say(`结论：${pass} 项通过，${fail} 项失败`);
    say('');
    say('这就是"插件怎么测"的第一层：**跟别的 Agent 走完全同一条协议**。');
    say('不需要装 Claude Code / Cursor 也能测——它们在底下做的就是把这段 JSON-RPC 走一遍。');
  } finally {
    srv.stop();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }

  const text = `${lines.join('\n')}\n`;
  mkdirSync(join(REPO, 'docs', 'evidence'), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  process.stdout.write(text);
  process.stdout.write(`\n证据已写入：${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`脚本自己崩了：${err?.stack || err}\n`);
  process.exitCode = 1;
});
