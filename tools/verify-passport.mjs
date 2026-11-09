/**
 * tools/verify-passport.mjs —— Agent 通行证 v1 的真机验证（跨进程、跨目录、含 MCP 通道）
 *
 * 为什么不在单元测试里就算了：护照的整个价值是"另一台机器、另一个进程、不共享任何密钥目录也能验"。
 * 单元测试跑在同一个进程里，自己验自己签的卡说明不了这件事。所以这里全部走**子进程**：
 *   A 目录签卡 → B 目录（连身份密钥都没有）验卡 → 改一个字符必须验不过
 *   → 指定 kid 必须能拒绝陌生签发者 → required 能力必须能收窄
 *   → 再用 `nexi mcp` 的 stdio 协议确认：tools/list 里有 agent_passport、tools/call 真能签、只读模式下签不出来
 *
 * 用法：
 *   node tools/verify-passport.mjs                 # 验仓库这份
 *   node tools/verify-passport.mjs --pkg <目录>     # 验装好的那份（发版前必须跑这个）
 *   node tools/verify-passport.mjs --record         # 写 docs/evidence/passport-<版本>.txt
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PKG = resolve(argOf('pkg', REPO));
const RECORD = process.argv.includes('--record');
const NEXI = join(PKG, 'bin', 'nexi.mjs');

const lines = [];
const failures = [];
function say(line = '') {
  lines.push(line);
  console.log(line);
}
function check(name, ok, detail = '') {
  say(`${ok ? '✔' : '✘'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}

/** 跑一个子进程，返回 {code, stdout, stderr}；stdout 逐行给，便于取"最后一行是卡" */
function run(cmd, args, { env = {}, input } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cmd, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', (e) => done({ code: -1, stdout: out, stderr: `${err}${e.message}` }));
    child.on('close', (code) => done({ code, stdout: out, stderr: err }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** MCP stdio：喂一串 JSON-RPC，收回来的按 id 建索引 */
async function mcpSession(env, requests) {
  const payload = `${requests.map((r) => JSON.stringify(r)).join('\n')}\n`;
  const res = await run(NEXI, ['mcp'], { env, input: payload });
  const byId = new Map();
  for (const line of res.stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const msg = JSON.parse(text);
      if (msg && msg.id !== undefined) byId.set(msg.id, msg);
    } catch { /* 非协议行忽略（stdout 只该有协议，但别为一个坏行整段崩） */ }
  }
  return { byId, raw: res };
}

const textOf = (msg) => (msg?.result?.content || []).map((b) => b.text || '').join('\n');
const cardOf = (stdout) => {
  const rows = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = rows.length - 1; i >= 0; i -= 1) if (/^NEXP1\./.test(rows[i])) return rows[i];
  return '';
};

async function main() {
  const started = new Date();
  const version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
  const rootA = mkdtempSync(join(tmpdir(), 'nexi-pp-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'nexi-pp-b-'));
  const envA = { DSH_HOME: rootA, NEXI_WORKSPACE: join(rootA, 'ws'), NEXI_BOARD_ROOT: join(rootA, 'board'), NEXI_LICENSE_ROOT: join(rootA, 'lic'), NEXI_PET_ROOT: join(rootA, 'pet') };
  const envB = { DSH_HOME: rootB, NEXI_WORKSPACE: join(rootB, 'ws'), NEXI_BOARD_ROOT: join(rootB, 'board'), NEXI_LICENSE_ROOT: join(rootB, 'lic'), NEXI_PET_ROOT: join(rootB, 'pet') };
  for (const e of [envA, envB]) mkdirSync(e.NEXI_WORKSPACE, { recursive: true });

  say(`Nexi 灵犀 —— Agent 通行证 v1 真机验证`);
  say(`版本：${version}`);
  say(`被测包：${PKG}`);
  say(`时间：${started.toISOString()}`);
  say('');

  // ① A 目录签发（进程 1）
  const name = `小犀-${Date.now().toString(36)}`;
  const issued = await run(NEXI, ['call', 'agent_passport', JSON.stringify({
    action: 'issue',
    name,
    agent: 'dsh',
    host: 'codex',
    capabilities: ['team_board', 'pet_visit', 'deck_license'],
    tier: 'studio',
    ttlDays: 7,
  })], { env: envA });
  const card = cardOf(issued.stdout);
  check('① A 机器签发通行证（进程 1，nexi call）', Boolean(card) && /^NEXP1\.[\w-]+\.[\w-]+$/.test(card), card ? `${card.slice(0, 18)}…（${card.length} 字符）` : `没拿到卡：${issued.stdout}${issued.stderr}`.slice(0, 200));
  const kid = (issued.stdout.match(/kid：(kid_[A-Za-z0-9_-]+)/) || [])[1] || '';
  check('   kid 由公钥指纹算出（kid_ + 16 位）', /^kid_[A-Za-z0-9_-]{16}$/.test(kid), kid);
  const keyA = join(rootA, 'lic', '.agentdeck', 'identity', 'key.pem');
  check('   私钥只落在 A 机器（身份跟着"人"走，落在机级目录；B 机器上没有）', existsSync(keyA) && !existsSync(join(rootB, 'lic', '.agentdeck', 'identity', 'key.pem')), keyA);

  // ② B 目录验卡（进程 2，另一份 DSH_HOME，没有私钥）
  const verified = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'verify', card })], { env: envB });
  check('② B 机器验卡通过（进程 2，不共享密钥目录）', /通过：卡没被改过/.test(verified.stdout) && verified.stdout.includes(name), (verified.stdout.split(/\r?\n/).find((l) => l.includes('kid：')) || '').trim());

  // ③ 改一个字符 → 必须验不过
  const [pfx, payload, sig] = card.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.capabilities = [...claims.capabilities, 'super_agent'];
  const forged = `${pfx}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
  const tampered = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'verify', card: forged })], { env: envB });
  check('③ 改过的卡验不过（签名对不上）', /没通过/.test(tampered.stdout) && /bad_signature|签名/.test(tampered.stdout), (tampered.stdout.split(/\r?\n/)[0] || '').trim());

  // ④ 指定 kid：陌生的签发者必须被拒
  const pinned = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'verify', card, kid: 'kid_0000000000000000' })], { env: envB });
  check('④ 指定 kid=别人 时拒绝（kid 是签发者指纹）', /没通过/.test(pinned.stdout) && /kid_mismatch|不是/.test(pinned.stdout), (pinned.stdout.split(/\r?\n/)[0] || '').trim());
  const pinnedOk = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'verify', card, kid })], { env: envB });
  check('   指定 kid=正确 时通过（记住 kid 就能确认"还是那台机器"）', /通过：卡没被改过/.test(pinnedOk.stdout));

  // ⑤ 能力清单能收窄：要求一个没声明的能力 → 拒
  const need = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'verify', card, required: ['team_board', 'deck_meeting'] })], { env: envB });
  check('⑤ 要求未声明的能力时拒绝（deck_meeting）', /没通过/.test(need.stdout) && /deck_meeting/.test(need.stdout), (need.stdout.split(/\r?\n/)[0] || '').trim());

  // ⑥ 过期卡：A 机器签一张 1 天前就过期的（ttlDays 最小 1 天，所以用 --ttlDays 造不出来，直接改 payload 会被签住；
  //    这里改用 ttlDays=1 的卡 + 把 now 往前推 2 天——只能走库，不折腾 CLI，故只在单测里覆盖，这里说明清楚）
  say('⑥ 过期/时钟偏移：由 tests/identity.test.mjs 覆盖（CLI 只暴露 ttlDays≥1，造不出过期卡）');

  // ⑦ MCP stdio：工具清单与真调用
  const sess = await mcpSession(envB, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-passport', version } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_passport', arguments: { action: 'verify', card } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_passport', arguments: { action: 'show' } } },
  ]);
  const tools = sess.byId.get(2)?.result?.tools || [];
  check('⑦ MCP stdio：initialize 正常', Boolean(sess.byId.get(1)?.result?.serverInfo), sess.byId.get(1)?.result?.serverInfo?.version || '');
  check(`   tools/list 里有 agent_passport（共 ${tools.length} 个）`, tools.some((t) => t.name === 'agent_passport'), tools.map((t) => t.name).join(','));
  check('   tools/call 验卡通过', /通过：卡没被改过/.test(textOf(sess.byId.get(3))), (textOf(sess.byId.get(3)).split('\n')[0] || '').slice(0, 60));
  check('   tools/call show：B 机器如实说"还没有身份密钥"', /还没有身份密钥/.test(textOf(sess.byId.get(4))));

  // ⑧ 只读模式：能验卡，签不出来
  const ro = await mcpSession({ ...envB, NEXI_MCP_READONLY: '1' }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-passport-ro', version } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_passport', arguments: { action: 'issue', name: '偷偷签' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_passport', arguments: { action: 'verify', card } } },
  ]);
  const roTools = ro.byId.get(2)?.result?.tools || [];
  check(`⑧ 只读模式：广告 ${roTools.length} 个工具，agent_passport 带"仅 show/verify/list"`, roTools.some((t) => t.name === 'agent_passport' && /只读模式：仅 show\/verify\/list 可用/.test(t.description || '')), '');
  check('   只读模式签不出卡（isError）', ro.byId.get(3)?.result?.isError === true, (textOf(ro.byId.get(3)).split('\n')[0] || '').slice(0, 60));
  check('   只读模式仍然能验卡', /通过：卡没被改过/.test(textOf(ro.byId.get(4))));

  // ⑨ 账本：A 机器有 1 张，B 机器 0 张（通行证不会自己传播）
  const listA = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'list' })], { env: envA });
  const listB = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'list' })], { env: envB });
  check('⑨ A 机器账本 1 张、B 机器 0 张（卡只在你手上）', /已签发 1 张/.test(listA.stdout) && /还没签过卡/.test(listB.stdout), '');

  // ⑩ 吊销后仍验得过（诚实边界，不是 bug）——必须在证据里留痕，免得以后有人当成漏洞
  const rev = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'revoke', kid })], { env: envA });
  const afterRevoke = await run(NEXI, ['call', 'agent_passport', JSON.stringify({ action: 'verify', card })], { env: envB });
  check('⑩ 吊销只标本地账本：卡在 B 机器仍验得过（离线凭证没有吊销中心，已在文案里写明）', /已在本机账本吊销/.test(rev.stdout) && /通过：卡没被改过/.test(afterRevoke.stdout), '');

  say('');
  const summary = failures.length ? `失败 ${failures.length} 项：${failures.join('；')}` : '全部通过';
  say(`结论：${summary}`);
  say(`耗时：${((Date.now() - started.getTime()) / 1000).toFixed(1)}s`);

  const outFile = join(REPO, 'docs', 'evidence', `passport-${version}.txt`);
  if (RECORD) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
    console.log(`\n证据已写入：${outFile}`);
  }

  for (const dir of [rootA, rootB]) rmSync(dir, { recursive: true, force: true });
  return failures.length ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
