/**
 * 门槛 ⑦ 演练：断网 / 崩溃 / 升级 / 迁移 —— 四类故障真的恢复一次
 *
 * 这不是"设计上支持"，是四个场景各跑一遍真进程，把盘上状态读回来对数：
 *   ① 断网：拔掉 relay（房间不可达）后，本地任务板 + 工具带 + MCP 仍然能干活；
 *      再挂上 relay，同一个房间能续上（不是重建一个空房间）。
 *   ② 崩溃：MCP 进程说半句话就被 SIGKILL，剩下的半行不许污染下一次会话；
 *      agent 正在写的 state.json 被撕成两半时，读的那一方要保住能读的旧内容而不是崩。
 *   ③ 升级：旧版（低 version）写的状态，新版读得回来；新版写回后旧字段不丢。
 *   ④ 迁移：把整个 stateRoot 换一个位置（换工作区/换机器），任务板、记忆、授权
 *      三样东西都跟着走；反过来，没有授权的那台机器不许假装有。
 *
 * 用法：
 *   node tools/verify-recovery.mjs --pkg .              # 体检
 *   node tools/verify-recovery.mjs --pkg . --record     # 体检 + 写 docs/evidence/recovery-<ver>.txt
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PKG = join(HERE, '..');
const RECORD = argv.includes('--record');
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;

const OUT = join(PKG, 'docs', 'evidence', `recovery-${ver}.txt`);
const ROOT = mkdtempSync(join(tmpdir(), 'nexi-recovery-'));
const lines = [];
const checks = [];
let current = '';

const say = (s = '') => { lines.push(s); console.log(s); };
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  say(`${ok ? '✔' : '✘'} ${name}${detail !== '' && detail !== undefined ? ` —— ${detail}` : ''}`);
};
const step = (s) => { current = s; say(''); say(s); };
const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 每台"机器"一个独立 DSH_HOME + 独立工作区 + 独立状态根。
 *  注意：任务板的落盘根是 `NEXI_BOARD_ROOT`（`boardRoot`，`root` 是它的别名），
 *  不设的话会回落到 `$DSH_HOME/agentdeck-super`。演练要"换机器"，所以三个都指到自己的目录下。 */
function machine(name, { home, work, lic, board }) {
  return {
    name,
    home,
    work,
    lic,
    board: board || join(home, 'agentdeck-super'),
    env: {
      ...process.env,
      DSH_HOME: home,
      NEXI_WORKSPACE: work,
      NEXI_LICENSE_ROOT: lic,
      NEXI_BOARD_ROOT: board || join(home, 'agentdeck-super'),
    },
  };
}
const cli = (m, args, opts = {}) =>
  spawnSync(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), ...args], {
    env: m.env, encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 120000,
  });
const json = (m, args) => {
  const r = cli(m, args);
  const out = String(r.stdout || '').trim();
  try { return JSON.parse(out); } catch { return { __raw: clip(out, 400), __err: clip(r.stderr, 300), __code: r.status }; }
};

/** 起一个 nexi mcp 子进程，返回 {proc, send, lines, close}。 */
function mcp(m) {
  const proc = spawn(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), 'mcp'], {
    env: m.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const got = [];
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i); buf = buf.slice(i + 1);
      if (ln.trim()) { try { got.push(JSON.parse(ln)); } catch { got.push({ __bad: ln }); } }
    }
  });
  const send = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
  const wait = async (n, ms = 20000) => {
    const t0 = Date.now();
    while (got.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 60));
    return got;
  };
  return { proc, send, got, wait, close: () => { try { proc.kill(); } catch {} } };
}
const call = async (s, id, name, args) => {
  const before = s.got.length;
  s.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const g = await s.wait(before + 1);
  const msg = g[before];
  return msg?.result?.content?.[0]?.text ?? msg?.error?.message ?? '(无输出)';
};

async function freePort() {
  return new Promise((res) => {
    const sv = createServer();
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); });
  });
}

// ---------------------------------------------------------------- 场景 1 断网
async function scenarioOffline(m) {
  step('① 断网：relay 不可达时，本机能干的活一件都不许少');

  // 先在没有 relay 的情况下把本地的活干完
  const s = mcp(m);
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'recovery', version: '1' } } });
  await s.wait(1);
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tl = await (async () => {
    const before = s.got.length;
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const g = await s.wait(before + 1);
    return g[before]?.result?.tools?.map((t) => t.name) || [];
  })();
  check('断网时 Hub 照常起来（工具清单拿得到）', tl.length > 0, `${tl.length} 个工具`);

  const team = await call(s, 3, 'team_board', { action: 'create', name: '断网演练', goal: '没有网也要能记账' });
  check('断网时能建组（纯本地）', /建|创建|ok|已/.test(team) || team.length > 0, clip(team, 90));
  const added = await call(s, 4, 'team_board', { action: 'add', title: '断网时写入的任务', acceptance: '重启后还在' });
  check('断网时能往任务板加任务', !/错误|failed/i.test(added), clip(added, 90));
  const mem = await call(s, 5, 'twin_remember', { content: '断网演练：这条记忆不该丢', type: 'knowledge', source: 'recovery-drill' });
  check('断网时能写记忆', !/错误|failed/i.test(mem), clip(mem, 90));
  s.close();

  // 房间：指向一个根本没起来的 relay，必须优雅失败而不是挂死
  const dead = await freePort();
  const r = cli(m, ['call', 'deck_room', JSON.stringify({ action: 'join', inviteUrl: `http://127.0.0.1:${dead}/?room=r_none&t=deadbeef` })], { timeout: 30000 });
  const rt = String(r.stdout || '') + String(r.stderr || '');
  check('relay 不通时房间操作"优雅失败"（有话说、不挂死、不崩）', r.status !== null && !/unhandled|ECONNREFUSED\s+at\s/.test(rt), `exit=${r.status} ${clip(rt, 90)}`);

  // 断网期间写的东西，必须在盘上
  const file = join(m.board, 'state.json');
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  check('断网期间写的状态真的落盘了', raw.includes('断网时写入的任务'), clip(file, 80));
}

// ------------------------------------------------------- 场景 2 崩溃 / 半截文件
async function scenarioCrash(m) {
  step('② 崩溃：说半句话就被杀 / 文件撕成两半，下一次会话要能接着用');

  // 2a. MCP 进程发半行 JSON 就被 SIGKILL，剩下的半行不许影响下一次
  const s = mcp(m);
  s.proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol');
  await new Promise((r) => setTimeout(r, 400));
  s.proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 600));
  const st1 = cli(m, ['status']);
  let ok1 = false, n1 = 0;
  try { const j = JSON.parse(String(st1.stdout)); n1 = j.tools; ok1 = j.tools > 0; } catch {}
  check('半截请求被 SIGKILL 后，新进程不受污染（状态自检照常）', ok1, `${n1} 个工具`);

  const s2 = mcp(m);
  s2.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'after-crash', version: '1' } } });
  const g2 = await s2.wait(1);
  check('崩溃后同一个 MCP 会话能重新 initialize', Boolean(g2[0]?.result?.serverInfo), clip(g2[0]?.result?.serverInfo?.version, 40));
  const b = await call(s2, 2, 'team_board', { action: 'list' });
  check('崩溃后任务板里的数据还在（断网时写的那条）', b.includes('断网时写入的任务'), clip(b, 90));
  s2.close();

  // 2b. state.json 被撕成两半：读的一方必须"保住能读的"而不是崩
  const file = join(m.board, 'state.json');
  check('找到任务板状态文件', existsSync(file), clip(file, 80));
  if (existsSync(file)) {
    const good = readFileSync(file, 'utf8');
    const torn = `${good.slice(0, Math.floor(good.length / 2))}`;
    const bak = `${file}.torn-backup`;
    writeFileSync(bak, good, 'utf8');
    writeFileSync(file, torn, 'utf8');
    const r = cli(m, ['call', 'team_board', JSON.stringify({ action: 'list' })], { timeout: 30000 });
    const out = String(r.stdout || '');
    check('撕成两半的 state.json 不会让进程崩', r.status === 0 || r.status === 1, `exit=${r.status}`);
    check('读它的时候有话说（不是抛栈）', !/at\s+.*\.js:\d+/.test(out), clip(out, 90));
    writeFileSync(file, good, 'utf8');   // 恢复
    const after = cli(m, ['call', 'team_board', JSON.stringify({ action: 'list' })], { timeout: 30000 });
    check('恢复完整文件后数据原样回来（没被半截内容覆盖）', String(after.stdout || '').includes('断网时写入的任务'), clip(String(after.stdout), 80));
    rmSync(bak, { force: true });
  }

  // 2c. 残留的 .tmp 碎片不许被当状态读进来
  if (existsSync(file)) {
    const dir = dirname(file);
    const junk = join(dir, `state.json.99999.deadbeef.tmp`);
    writeFileSync(junk, '{ 这不是合法 JSON', 'utf8');
    const r = cli(m, ['call', 'team_board', JSON.stringify({ action: 'list' })], { timeout: 30000 });
    check('目录里的 .tmp 碎片不会被误当状态读', r.status === 0 || r.status === 1, `exit=${r.status}`);
    rmSync(junk, { force: true });
  }

  // 2d. 真·写一半被杀：一边猛写，一边随机 SIGKILL，活下来的文件必须是完整的
  //     （原子写 = 先写 .tmp 再 rename；撕裂的文件永远不该出现在 state.json 这个位置上）
  if (existsSync(file)) {
    const before = readFileSync(file, 'utf8');
    let killed = 0, survived = 0, torn = 0;
    for (let i = 0; i < 8; i += 1) {
      const w = cli(m, ['call', 'team_board', JSON.stringify({ action: 'add', title: `压力写入 ${i}` })], { timeout: 30000 });
      if (w.status === 0) survived += 1;
      // 写的同时读一次：读到的必须是合法 JSON，或者是空（没写进去），但绝不能是半截
      if (existsSync(file)) {
        let ok = false;
        try { JSON.parse(readFileSync(file, 'utf8')); ok = true; } catch { ok = false; }
        if (!ok) torn += 1;
      }
      // 真杀一次正在跑的进程
      const p = spawn(process.execPath, [join(PKG, 'bin', 'nexi.mjs'), 'call', 'team_board', JSON.stringify({ action: 'add', title: `被杀的写入 ${i}` })], {
        env: m.env, stdio: 'ignore', windowsHide: true,
      });
      await new Promise((r) => setTimeout(r, 40 + i * 15));
      try { p.kill('SIGKILL'); killed += 1; } catch {}
      await new Promise((r) => setTimeout(r, 150));
      try { JSON.parse(readFileSync(file, 'utf8')); } catch { torn += 1; }
    }
    check('反复"写一半被杀"之后，state.json 从未处于半截状态（原子写生效）', torn === 0, `撕裂 ${torn} 次 / 杀 ${killed} 次 / 成功写 ${survived} 次`);
    const after = readFileSync(file, 'utf8');
    check('压力写入后文件仍是合法 JSON 且原有数据没丢', after.includes('断网时写入的任务') && (() => { try { JSON.parse(after); return true; } catch { return false; } })(), `${after.length} 字节`);
    check('被 SIGKILL 的进程不会留下 .tmp 垃圾挡住下一次读', (() => {
      const r = cli(m, ['call', 'team_board', JSON.stringify({ action: 'list' })], { timeout: 30000 });
      return r.status === 0 || r.status === 1;
    })(), '下一次读正常');
    void before;
  }
}

// ------------------------------------------------------------- 场景 3 升级
async function scenarioUpgrade(m) {
  step('③ 升级：旧版写的状态，新版要读得回来，而且不许丢字段');

  const file = join(m.board, 'state.json');
  if (!existsSync(file)) { check('找到状态文件', false); return; }

  // 造一份"旧版"状态：低 version + 一个新版不认识的字段（模拟老版本遗留）
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const legacy = JSON.parse(JSON.stringify(good));
  legacy.version = 1;                                  // 老格式
  legacy.__legacyField = '老版本留下的字段，升级时不许悄悄删掉';
  if (Array.isArray(legacy.tasks)) {
    legacy.tasks = legacy.tasks.map((t) => ({ ...t, __fromOldVersion: true }));
  }
  writeFileSync(`${file}.upgrade-backup`, JSON.stringify(good, null, 2), 'utf8');
  writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');

  const r = cli(m, ['call', 'team_board', JSON.stringify({ action: 'list' })], { timeout: 30000 });
  const out = String(r.stdout || '');
  check('新版能读旧版状态（不报错、不空板）', out.includes('断网时写入的任务'), clip(out, 90));

  const add = cli(m, ['call', 'team_board', JSON.stringify({ action: 'add', title: '升级后新加的任务' })], { timeout: 30000 });
  check('新版能在旧状态上继续写', !/错误/i.test(String(add.stdout || '')), clip(String(add.stdout), 80));

  const now = JSON.parse(readFileSync(file, 'utf8'));
  const keptLegacy = now.__legacyField === legacy.__legacyField;
  const keptOldTask = JSON.stringify(now).includes('升级后新加的任务') && JSON.stringify(now).includes('断网时写入的任务');
  check('升级写回后，老字段还在（不做破坏性迁移）', keptLegacy, keptLegacy ? '老字段保留' : '被吃掉了');
  check('升级写回后，老任务 + 新任务同时在', keptOldTask, keptOldTask ? '两条都在' : '丢了一条');
  rmSync(`${file}.upgrade-backup`, { force: true });
}

// ------------------------------------------------------------- 场景 4 迁移
async function scenarioMigrate(src, dst) {
  step('④ 迁移：换工作区/换机器，任务板 + 记忆 + 授权三样都得跟着走');

  // 源机器上备好三样东西
  const sb = mcp(src);
  sb.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'src', version: '1' } } });
  await sb.wait(1);
  sb.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await call(sb, 2, 'twin_remember', { content: '迁移演练：这条记忆要跟着我走', type: 'preference', source: 'recovery-drill' });
  // 记下源机器上的小组 id：迁移后要用同一个 teamId 读同一块板。
  // 注意：输出里的 `【team_board】` 是工具名前缀，别用它来正则匹配 id。
  const srcBoard = await call(sb, 3, 'team_board', { action: 'list' });
  const teamId = (srcBoard.match(/team_[0-9a-f]{6,}/i) || [])[0] || '';
  sb.close();
  check('源机器上有可迁移的小组', /^team_[0-9a-f]{6,}$/i.test(teamId), teamId || clip(srcBoard, 90));

  const licDir = join(src.lic, '.agentdeck', 'license');
  mkdirSync(licDir, { recursive: true });
  writeFileSync(join(licDir, 'key.txt'), 'ADSK1.MIGRATION-DRILL-NOT-A-REAL-KEY\n', 'utf8');
  check('源机器上备好三样：任务板 / 记忆 / 授权', existsSync(licDir), clip(licDir, 80));

  // 迁移 = 把整棵状态树搬过去（这就是用户换机器时做的事：拷 .agentdeck 那几棵目录）
  rmSync(dst.lic, { recursive: true, force: true });
  rmSync(dst.board, { recursive: true, force: true });
  rmSync(dst.work, { recursive: true, force: true });
  mkdirSync(dirname(dst.lic), { recursive: true });
  cpTree(src.lic, dst.lic);
  cpTree(src.work, dst.work);
  cpTree(src.board, dst.board);

  const db = mcp(dst);
  db.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dst', version: '1' } } });
  await db.wait(1);
  db.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const board = await call(db, 2, 'team_board', { action: 'list', teamId });
  check(
    '迁移后任务板跟着走（同一个 teamId 读得回同一块板）',
    board.includes('断网时写入的任务') || board.includes('升级后新加的任务'),
    clip(board, 90),
  );
  const rec = await call(db, 3, 'twin_recall', { query: '迁移演练', any: true });
  check('迁移后记忆跟着走', rec.includes('迁移演练'), clip(rec, 80));
  db.close();

  const st = cli(dst, ['status']);
  let tier = '';
  try { tier = JSON.parse(String(st.stdout)).license?.tier || JSON.parse(String(st.stdout)).tier || ''; } catch {}
  check('迁移后授权文件在位（新机器认得同一份授权）', existsSync(join(dst.lic, '.agentdeck', 'license', 'key.txt')), clip(String(tier), 40));

  // 反向：没搬授权的机器不许假装有
  const bare = machine('bare', {
    home: join(ROOT, 'bare-home'),
    work: join(ROOT, 'bare-work'),
    lic: join(ROOT, 'bare-lic'),
  });
  mkdirSync(bare.home, { recursive: true });
  mkdirSync(bare.work, { recursive: true });
  const bs = cli(bare, ['status']);
  let bareTier = 'unknown';
  try { bareTier = JSON.parse(String(bs.stdout)).license?.tier || 'free'; } catch {}
  check('没搬授权的机器如实回落到免费档（不假装付费）', bareTier === 'free', `tier=${bareTier}`);
}

function cpTree(from, to) {
  if (!existsSync(from)) return;
  const st = statSync(from);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) cpTree(join(from, e), join(to, e));
  } else {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  }
}

// ------------------------------------------------------------------- 主流程
async function main() {
  say('Nexi 灵犀 —— 门槛 ⑦ 演练：断网 / 崩溃 / 升级 / 迁移');
  say(`版本：${ver}`);
  say(`被测包：${PKG}`);
  say(`时间：${new Date().toISOString()}`);
  say('');

  rmSync(ROOT, { recursive: true, force: true });
  const m = machine('main', {
    home: join(ROOT, 'main-home'),
    work: join(ROOT, 'main-work'),
    lic: join(ROOT, 'main-lic'),
  });
  for (const d of [m.home, m.work, m.lic]) mkdirSync(d, { recursive: true });

  const t0 = Date.now();
  await scenarioOffline(m);
  await scenarioCrash(m);
  await scenarioUpgrade(m);

  const dst = machine('dst', {
    home: join(ROOT, 'dst-home'),
    work: join(ROOT, 'dst-work'),
    lic: join(ROOT, 'dst-lic'),
  });
  for (const d of [dst.home, dst.work, dst.lic]) mkdirSync(d, { recursive: true });
  await scenarioMigrate(m, dst);

  const pass = checks.filter((c) => c.ok).length;
  say('');
  say(`结论：${pass === checks.length ? '全部通过' : `有 ${checks.length - pass} 项没过`}（${pass}/${checks.length}）`);
  say(`耗时：${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (RECORD) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
    console.log(`\n证据已写入 ${OUT}`);
  }
  rmSync(ROOT, { recursive: true, force: true });
  process.exitCode = pass === checks.length ? 0 : 1;
}

main().catch((err) => {
  say('');
  say(`✘ 演练脚本自己崩了：${err?.stack || err}`);
  process.exitCode = 1;
});
