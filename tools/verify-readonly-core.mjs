#!/usr/bin/env node
/**
 * tools/verify-readonly-core.mjs —— 只读模式验收（**不依赖 dsh 宿主**）
 *
 * 为什么要单独有这个：
 *   原本的 verify-readonly.mjs 要起真 `dsh --profile web` 宿主，验证"只读模式下
 *   宿主里也拦得住"。那条路在没装 dsh 的机器上跑不了（超时 120 秒就白等）。
 *   但只读模式的**核心承诺**是可以在本机独立验证的：
 *     · tools/list 里写工具直接不出现
 *     · tools/call 真拒（返回 isError），不是只把按钮置灰
 *     · 任务板文件一个字节都不多
 *   这三条用 lib/mcp 的引擎 + 真工具带就能验，不需要宿主。
 *
 * 边界（照写）：这里验的是「服务端拦截」。宿主的 UI 是否也置灰那是另一件事，
 * 由 verify-readonly.mjs 在装了 dsh 的机器上补验。
 *
 * 用法：node tools/verify-readonly-core.mjs [--record]
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHub } from '../lib/hub.js';
import { createMcpEngine } from '../lib/mcp/server.js';
import { READONLY_ALLOWED, isReadonlyAllowed, readonlyToolNames } from '../lib/mcp/readonly.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
const RECORD = process.argv.includes('--record') || true;

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); console.log(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); console.log(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => { lines.push(t); console.log(t); };

/** 统计一个目录里所有文件的字节数（用来证明"没多写一个字"）。 */
function treeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  try {
    walk(dir);
  } catch {
    // 目录被并发删掉之类：当作 0，不影响结论
  }
  return total;
}

/**
 * 发一条 JSON-RPC 给引擎，拿回结果。
 * 注意：engine.handle() 收的是**单条报文**（不是数组），和我们原先想的不一样——
 * 这是真机跑出来的（返回 0 个工具就是因为它把数组当成了非法报文）。
 */
async function rpc(engine, method, params, id = 1) {
  const frame = await engine.handle({ jsonrpc: '2.0', id, method, params });
  return frame || { error: { message: '（通知类报文无响应）' } };
}

async function main() {
  say('只读模式验收（核心承诺，不依赖 dsh 宿主）');
  say('='.repeat(66));
  say(`时间：${new Date().toISOString()}`);
  say('');

  const root = mkdtempSync(join(tmpdir(), 'nexi-readonly-core-'));
  const boardRoot = join(root, 'board');
  let hub = null;

  try {
    hub = await createHub({ workspace: root, boardRoot, onLog: () => {} });
    const allNames = hub.list().map((t) => t.name);
    const roNames = readonlyToolNames(hub.list());

    say('【第 1 步】工具表：写工具是不是真的不出现');
    chk(allNames.length >= 20, '完整模式有工具', `${allNames.length} 个`);
    chk(roNames.length < allNames.length, '只读模式下工具更少', `只读 ${roNames.length} / 完整 ${allNames.length}`);
    chk(!roNames.includes('super_agent'), 'super_agent 在只读模式下不出现');
    chk(!roNames.includes('twin_remember'), 'twin_remember 在只读模式下不出现');
    chk(roNames.includes('twin_recall'), '只读≠残废：twin_recall 保留');
    chk(roNames.includes('team_board'), 'team_board 保留（但要限定动作）');
    say('');

    say('【第 2 步】动作级判定：同一个工具，读放行、写拒绝');
    chk(isReadonlyAllowed('team_board', { action: 'list' }) === true, 'team_board list 放行');
    chk(isReadonlyAllowed('team_board', { action: 'add' }) === false, 'team_board add 拒绝');
    chk(isReadonlyAllowed('team_board', { action: 'create' }) === false, 'team_board create 拒绝');
    chk(isReadonlyAllowed('super_agent', {}) === false, 'super_agent 整体不可用');
    // 关键：不带 action 时按"工具自己的缺省动作"判，不能一律当读
    chk(isReadonlyAllowed('agent_passport', {}) === false, 'agent_passport 不带 action（缺省 issue）必须拒');
    chk(isReadonlyAllowed('agent_passport', { action: 'verify' }) === true, 'agent_passport verify 放行');
    say('');

    say('【第 3 步】真 MCP 协议：tools/call 是不是真被拦（不是只有 UI 置灰）');
    const engine = createMcpEngine({ hub, readOnly: true, log: { info() {}, warn() {}, error() {} } });

    const list = await rpc(engine, 'tools/list', {}, 1);
    const listed = (list?.result?.tools || []).map((t) => t.name);
    chk(listed.length === roNames.length, 'tools/list 列出的就是只读允许的那些', `${listed.length} 个`);
    chk(!listed.includes('super_agent'), 'tools/list 不广告 super_agent');

    // 写动作：必须 isError
    const writeCall = await rpc(engine, 'tools/call', { name: 'team_board', arguments: { action: 'add', title: '只读测试不该写进去' } }, 2);
    const writeErr = Boolean(writeCall?.result?.isError);
    chk(writeErr, '写动作返回 isError', JSON.stringify(writeCall?.result?.content?.[0]?.text || '').slice(0, 90));

    // 整体不可用的工具：也必须拒
    const bannedCall = await rpc(engine, 'tools/call', { name: 'super_agent', arguments: { goal: '随便干点啥' } }, 3);
    chk(Boolean(bannedCall?.result?.isError), '整体关闭的工具调用被拒');

    // 读动作：必须照常能用
    const readCall = await rpc(engine, 'tools/call', { name: 'team_board', arguments: { action: 'list' } }, 4);
    chk(!readCall?.result?.isError, '读动作照常可用');
    say('');

    say('【第 4 步】副作用：任务板文件是不是一个字节都没多');
    const before = treeBytes(boardRoot);
    // 再猛试几次写
    for (let i = 0; i < 3; i += 1) {
      await rpc(engine, 'tools/call', { name: 'team_board', arguments: { action: 'add', title: `越界写入 ${i}` } }, 10 + i);
      await rpc(engine, 'tools/call', { name: 'twin_remember', arguments: { content: '越界记忆' } }, 20 + i);
    }
    const after = treeBytes(boardRoot);
    chk(after === before, '只读模式下任务板字节数没变', `before=${before} after=${after}`);
    say('');

    say('【第 5 步】对照：同一个调用在非只读模式下应该能过');
    const rwEngine = createMcpEngine({ hub, readOnly: false, log: { info() {}, warn() {}, error() {} } });
    const rwList = await rpc(rwEngine, 'tools/list', {}, 1);
    const rwNames = (rwList?.result?.tools || []).map((t) => t.name);
    chk(rwNames.length > listed.length, '非只读模式工具更多', `${rwNames.length} > ${listed.length}`);
    chk(rwNames.includes('super_agent'), '非只读模式下 super_agent 回来了');
    say('');

    say('【第 6 步】判定表覆盖度（别漏掉某个工具）');
    const covered = Object.keys(READONLY_ALLOWED).length;
    const uncovered = allNames.filter((n) => !(n in READONLY_ALLOWED));
    chk(covered > 0, '判定表非空', `${covered} 个工具`);
    lines.push(`  · 判定表未覆盖（= 只读模式整体关闭）：${uncovered.join('、') || '（无）'}`);
    console.log(`  · 判定表未覆盖（= 只读模式整体关闭）：${uncovered.join('、') || '（无）'}`);
  } catch (err) {
    bad('验收过程异常', `${err?.name || 'Error'}: ${err?.message || err}`);
  } finally {
    try { await hub?.close(); } catch { /* 关不掉不算失败 */ }
    rmSync(root, { recursive: true, force: true });
  }

  say('');
  say('='.repeat(66));
  say(`结论：${pass} 项通过，${fail} 项失败`);
  say('');
  say('边界照写：');
  say('  · 这里验的是**服务端拦截**（协议层真拒 + 盘上无残留）。');
  say('  · 宿主的界面是否也把按钮置灰，由 verify-readonly.mjs 在装 dsh 的机器上补验。');
  say('  · 只读模式保护的是"借出去的那份"，不是"本机自己用"（本机自己用不受限）。');

  if (RECORD) {
    const out = join(PKG, 'docs', 'evidence', `readonly-core-${VERSION}.txt`);
    writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
    console.log('');
    console.log(`证据已写入：${out}`);
  }
  process.exitCode = fail ? 1 : 0;
}

main();
