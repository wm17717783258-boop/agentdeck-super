/**
 * tools/verify-console.mjs —— 证明 `/deck/console` 真能在宿主里点
 *
 * 单元测试只证明 HTML 拼得对；这一份证明的是**端到端**：
 *   起一个真 DSH 宿主（headless profile，装的是当前包）→ 开 `/deck/console`
 *   → GET 拿到表单 → POST 真点几个按钮 → 断言返回 ± 盘上状态真的变了
 *   → 再把只读模式（mcp.readOnly=true）开起来，证明写动作在**服务端**被拦。
 *
 * 为什么必须走真宿主：测试台的价值就是"用户在宿主 GUI 里能摸到"，
 * 用假 ctx 拼一个页面证明不了这一点。
 *
 * 用法：
 *   node tools/verify-console.mjs --pkg .            # 体检
 *   node tools/verify-console.mjs --pkg . --record   # 体检 + 写 docs/evidence/console-<ver>.txt
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const PKG = (() => {
  const i = argv.indexOf('--pkg');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : join(HERE, '..');
})();
const RECORD = argv.includes('--record');
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;

const OUT = join(PKG, 'docs', 'evidence', `console-${ver}.txt`);
const ROOT = join('D:', 'demo', 'console');
const WARM_DSH = process.env.DSH_HOME || join(process.env.USERPROFILE || 'C:\\Users\\王冕', '.dsh');
const WARM_PROFILE = join(WARM_DSH, 'profiles', 'web');
const lines = [];
const checks = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  say(`${ok ? '✔' : '✘'} ${name}${detail ? ` —— ${detail}` : ''}`);
};
const clip = (s, n = 150) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

async function freePort() {
  return new Promise((res) => {
    const sv = createServer();
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); });
  });
}

/** 递归复制目录（跳过 node_modules 里的 .pnpm 软链麻烦：整体复制即可，pnpm 的链接是相对的）。 */
function cpTree(from, to) {
  if (!existsSync(from)) return;
  const st = statSync(from);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) cpTree(join(from, e), join(to, e));
  } else {
    mkdirSync(dirname(to), { recursive: true });
    try { writeFileSync(to, readFileSync(from)); } catch { /* 个别锁文件复制不了就算了 */ }
  }
}

const DSH = 'dsh';

/** 起一个真 DSH 宿主（`dsh --profile web`），跑的是已装进 profile 的那份插件。
 *
 *  踩过的坑：从零建一个全新 `DSH_HOME` 时，宿主会先花几分钟 bootstrap 一个
 *  profile（pnpm 装依赖），在本机上会卡住、也测不出"用户点开就能用"。
 *  所以这里**复制一个已经装好插件的热 profile 目录**过去，只换状态根 ——
 *  等价于"用户本来就在用的那个宿主"，只是数据目录隔离。
 */
async function startHost({ readOnly = false, port }) {
  const home = join(ROOT, readOnly ? 'ro-home' : 'rw-home');
  const work = join(ROOT, readOnly ? 'ro-work' : 'rw-work');
  const board = join(ROOT, readOnly ? 'ro-board' : 'rw-board');
  const lic = join(ROOT, readOnly ? 'ro-lic' : 'rw-lic');
  for (const d of [work, board, lic]) mkdirSync(d, { recursive: true });

  // 把一个真的装好插件的 profile 复制进隔离 DSH_HOME（跳过 node_modules 的 reinstall）
  mkdirSync(join(home, 'profiles'), { recursive: true });
  const src = WARM_PROFILE;
  if (!existsSync(src)) {
    throw new Error(`找不到可复制的热 profile：${src}\n先跑一次 dsh plugin --profile web add <tgz> 再来。`);
  }
  cpTree(src, join(home, 'profiles', 'web'));
  for (const f of ['.anonymous-user-id', '.credentials.yaml']) {
    const s = join(WARM_DSH, f);
    if (existsSync(s)) writeFileSync(join(home, f), readFileSync(s));
  }

  // 用 overlay patch 拧配置（跟用户改配置是同一条路径，不另开一条后门）
  const patch = join(ROOT, readOnly ? 'ro.yml' : 'rw.yml');
  writeFileSync(patch, [
    '- id: agentdeck-super',
    '  config:',
    `    workspace: ${work}`,
    `    boardRoot: ${board}`,
    `    petRoot: ${work}`,
    `    licenseRoot: ${lic}`,
    '    automation:',
    '      enabled: false',
    `    mcp: { readOnly: ${readOnly} }`,
    '',
  ].join('\n'), 'utf8');

  const env = { ...process.env, DSH_HOME: home };
  const proc = spawn('cmd.exe', [
    '/c', DSH,
    '--profile', 'web',
    '--patch', patch,
    '--no-open', '--port', String(port),
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { err += d.toString('utf8'); });

  const deadline = Date.now() + 240000;
  for (;;) {
    if (Date.now() > deadline) {
      say(`   ✘ 宿主 240 秒没起来。stdout/stderr：`);
      for (const l of (out + err).trim().split('\n').slice(-20)) say(`   ${l}`);
      throw new Error('宿主起不来');
    }
    if (proc.exitCode !== null) {
      say(`   ✘ 宿主提前退出（exit ${proc.exitCode}）`);
      for (const l of (out + err).trim().split('\n').slice(-20)) say(`   ${l}`);
      throw new Error('宿主提前退出');
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/deck`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) break;
    } catch { /* 还没监听 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { proc, port, home, work, board, lic, patch, out: () => out + err };
}

async function stopHost(h) {
  try {
    spawnSync('taskkill', ['/PID', String(h.proc.pid), '/T', '/F'], { windowsHide: true });
  } catch { /* 忽略 */ }
  try { h.proc.kill(); } catch { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 1200));
}

async function fetchRetry(url, opts = {}, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 20000) });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

const post = async (port, fields) => {
  const r = await fetchRetry(`http://127.0.0.1:${port}/deck/console`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: r.status, html: await r.text() };
};
const getPage = async (port) => {
  const r = await fetchRetry(`http://127.0.0.1:${port}/deck/console`, { timeoutMs: 10000 });
  return { status: r.status, html: await r.text() };
};

async function main() {
  say('Nexi 灵犀 —— 测试台（/deck/console）真宿主端到端');
  say(`版本：${ver}`);
  say(`被测包：${PKG}`);
  say(`时间：${new Date().toISOString()}`);
  say('');

  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const t0 = Date.now();

  // ── 第一次：正常（可写）
  say('① 正常模式：测试台能开、能点、点完盘上真的有东西');
  const port = await freePort();
  const host = await startHost({ readOnly: false, port });
  say(`   宿主已起，端口 ${port}`);
  try {
    const g = await getPage(port);
    check('GET /deck/console 出页面（200）', g.status === 200, `HTTP ${g.status}，${g.html.length} 字节`);
    check('页面里有可点的按钮（测试台不是只读状态页）', g.html.includes('<button type="submit"'), '有 submit 按钮');
    check('页面自报本机工具数（不写死）', /本机工具 <b>\d+<\/b> 个/.test(g.html), clip((g.html.match(/本机工具 <b>\d+<\/b> 个/) || [''])[0], 40));
    check('正常模式下没有动作被置灰', !g.html.includes('class="act blocked"'), '全部可点');
    check('页面零外链（断网也开得起来）', !/https?:\/\/(?!127\.0\.0\.1)/.test(g.html), '无外部地址');

    const c = await post(port, { __id: 'board-create', 'board-create__name': '测试台建的组' });
    check('点「建一个小组」→ 200 且回显原始返回', c.status === 200 && c.html.includes('原始返回'), `HTTP ${c.status}`);
    const created = /【team_board】已创建小组 (team_\w+)/.exec(c.html);
    check('返回里带真小组 id（不是编的）', Boolean(created), created ? created[1] : clip(c.html, 120));

    const a = await post(port, { __id: 'board-add', 'board-add__title': '测试台加的任务', 'board-add__acceptance': '点完能在盘上找到' });
    check('点「加一条任务」→ 真写进去', a.status === 200 && /task_\w+/.test(a.html), clip((a.html.match(/task_\w+/) || [''])[0], 40));

    const s = await post(port, { __id: 'board-stats' });
    check('点「统计」→ 看得到刚才那个组', s.html.includes('测试台建的组') || /统计|小组/.test(s.html), clip(s.html.replace(/<[^>]*>/g, ' '), 100));

    // 盘上核对：这一条是"测试台真的调了工具"的硬证据
    const st = join(host.board, 'state.json');
    check('盘上 state.json 存在', existsSync(st), clip(st, 80));
    if (existsSync(st)) {
      const raw = readFileSync(st, 'utf8');
      check('盘上真有测试台建的小组', raw.includes('测试台建的组'), `${raw.length} 字节`);
      check('盘上真有测试台加的任务', raw.includes('测试台加的任务'), '任务标题在盘上');
    }

    const pp = await post(port, { __id: 'pp-show' });
    check('点「看本机身份」→ 通行证工具在测试台里活着', pp.status === 200 && /agent_passport/.test(pp.html), clip(pp.html.replace(/<[^>]*>/g, ' '), 110));

    const bad = await post(port, { __id: 'board-create' });
    check('必填留空 → 给人话，不抛栈', bad.status === 200 && bad.html.includes('必填'), '「name」是必填的');

    const unknown = await post(port, { __id: 'rm -rf /' });
    check('伪造的动作 id → 被拒（不猜、不静默执行）', unknown.status === 200 && unknown.html.includes('不认识的测试台动作'), '拒绝');
  } finally {
    await stopHost(host);
  }

  // ── 第二次：只读
  say('');
  say('② 只读模式：写动作在服务端被拦（页面置灰只是提示，不是闸门）');
  const port2 = await freePort();
  const host2 = await startHost({ readOnly: true, port: port2 });
  say(`   宿主已起，端口 ${port2}`);
  try {
    const g = await getPage(port2);
    check('只读模式下测试台照常打开', g.status === 200, `HTTP ${g.status}`);
    check('页面上写动作已置灰并写明原因', g.html.includes('class="act blocked"') && g.html.includes('只读模式'), '有 blocked');

    // 关键：绕过页面直接 POST（等于有人手搓请求）
    const w = await post(port2, { __id: 'board-add', 'board-add__title': '只读模式下不该写进去' });
    check('直连 POST 写动作 → 服务端拦住', w.html.includes('只读模式') && w.html.includes('已被拦下'), clip(w.html.replace(/<[^>]*>/g, ' '), 120));

    const st2 = join(host2.board, 'state.json');
    const raw2 = existsSync(st2) ? readFileSync(st2, 'utf8') : '';
    check('被拦的写动作没在盘上留下任何东西', !raw2.includes('只读模式下不该写进去'), raw2 ? `${raw2.length} 字节` : '无状态文件（更彻底）');

    const r = await post(port2, { __id: 'board-list' });
    check('只读模式下读动作照常可用', r.status === 200 && r.html.includes('原始返回'), `HTTP ${r.status}`);
  } finally {
    await stopHost(host2);
  }

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
  say(`✘ 脚本自己崩了：${err?.stack || err}`);
  process.exitCode = 1;
});
