// 证明「装进 DSH profile 的那份插件」真的在跑：真 DSH 宿主 + 真邀请函 + /visit 当场验签
//
//   node tools/verify-installed-visit.mjs [profileDir] [baseUrl]
//
//   profileDir 默认 C:\Users\…\.dsh\profiles\web；baseUrl 不填就自己起一个临时宿主再关掉。
// 想手工对着已经在跑的宿主跑，就把 baseUrl 传进来。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const profileDir = process.argv[2] || join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web');
const OUT = join(PKG, 'docs', 'evidence', `visit-installed-${ver}.txt`);
const ROOT = 'D:\\demo\\installed';

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const installedPkg = join(profileDir, 'node_modules', 'agentdeck-super', 'package.json');

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

// 没给 baseUrl 就自己起一个临时 DSH 宿主（真 dsh 进程，装的就是 profile 里那份）
async function startHost() {
  const port = await firstFreePort();
  const overlay = join(ROOT, 'host.yml');
  const work = join(ROOT, 'host', 'work');
  const board = join(ROOT, 'host', 'board');
  mkdirSync(work, { recursive: true });
  writeFileSync(overlay, [
    '- id: agentdeck-super',
    '  config:',
    `    workspace: ${work}`,
    `    boardRoot: ${board}`,
    `    petRoot: ${work}`,
    `    licenseRoot: ${join(ROOT, 'host', 'lic')}`,
  ].join('\n') + '\n', 'utf8');

  const child = spawn('cmd.exe', ['/c', 'dsh', '--profile', 'web', '--patch', overlay, '--no-open', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (c) => { log += String(c); });
  child.stderr.on('data', (c) => { log += String(c); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`宿主 90 秒没起来：\n${log.slice(-400)}`);
    try {
      const res = await fetch(`${base}/deck`);
      if (res.ok) break;
    } catch { /* 还没监听，继续等 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { base, child, port, log: () => log };
}

say(`# 装进 DSH profile 的那份插件在真宿主里跑 /visit（${ver}）`);
say(`# ${new Date().toISOString()}`);
say('');
say('## 1. 装的是哪一份');
say('');
say(`- profile：\`${profileDir}\``);
say(`- 磁盘上 package.json 的 version：\`${existsSync(installedPkg) ? JSON.parse(readFileSync(installedPkg, 'utf8')).version : '(缺)'}\``);
const visitJs = readFileSync(join(profileDir, 'node_modules', 'agentdeck-super', 'lib', 'pet', 'visit.js'), 'utf8');
say(`- 装的那份 \`lib/pet/visit.js\` 里有 Ed25519 吗：${/ed25519/i.test(visitJs) ? '有' : '**没有**'}（KEY_ALG 行：\`${(visitJs.match(/KEY_ALG\s*=\s*'[^']+'/) || ['(找不到)'])[0]}\`）`);
say(`- 还留着 v1 兼容吗：${/visit-secret/.test(visitJs) ? '留着（老链接仍能读）' : '**没了**'}`);
say('');

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'issuer', 'work'), { recursive: true });

// 用「装进 profile 的那份 bin/nexi.mjs」签一张邀请函（独立进程、独立工作区）
async function call(tool, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(profileDir, 'node_modules', 'agentdeck-super', 'bin', 'nexi.mjs'), 'call', tool, JSON.stringify(args)], {
      env: {
        ...process.env,
        NEXI_WORKSPACE: join(ROOT, 'issuer', 'work'),
        NEXI_BOARD_ROOT: join(ROOT, 'issuer', 'board'),
        NEXI_PET_ROOT: join(ROOT, 'issuer', 'work'),
        NEXI_LICENSE_ROOT: join(ROOT, 'issuer', 'lic'),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`nexi call ${tool} 退出 ${code}`))));
  });
}

// 先给签发方一个名字，这样落地页上认得出是谁
const { createProfileStore } = await import(pathToFileURL(join(profileDir, 'node_modules', 'agentdeck-super', 'lib', 'pet', 'profile.js')).href);
createProfileStore({ root: join(ROOT, 'issuer', 'work') }).update((draft) => {
  draft.name = '小犀';
  draft.habits = [{ key: 'sql-report', label: '每周写 SQL 周报', confidence: 0.82 }];
});

const inviteText = await call('pet_visit', { action: 'invite', scope: 'work', ttlHours: 2 });
const token = (inviteText.match(/[?&]t=([A-Za-z0-9._~-]+)/) || [])[1] || '';
const kid = (inviteText.match(/kid_[0-9a-f]{12}/) || ['(没打印)'])[0];
if (!token) { console.error('没拿到令牌：\n' + inviteText); process.exitCode = 1; throw new Error('no token'); }

say('## 2. 签发方（另一个进程、另一个工作区，用装好的那份代码签）');
say('');
say('```text');
for (const line of inviteText.split('\n').filter((l) => /签发|皮肤|习惯|范围|有效期/.test(l))) {
  say(line.replace(/t=[A-Za-z0-9._~-]+/g, `t=<令牌已脱敏，长度 ${token.length}>`));
}
say('```');
say('');

// 再伪造一张"改过一个字"的，验证宿主侧也拒
const [body, sig] = token.split('.');
const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
forged.from.name = '冒充的小犀';
const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;

let host = null;
let base = process.argv[3] || '';
if (!base) {
  host = await startHost();
  base = host.base;
} else if (!/^https?:\/\//i.test(base)) {
  console.error(`baseUrl 得是 http(s) 地址，收到的是 ${base}`);
  process.exitCode = 1;
  throw new Error('bad baseUrl');
}

say('## 3. 真 DSH 宿主（profile `web` + 我们这份插件）当场验签');
say('');
say(`宿主地址：\`${base}\`（${host ? '本次运行现起的 `dsh --profile web --patch <临时 overlay> --no-open`' : '手工启动的'}，\`/visit\` 路由由插件注册）`);
say('');
say('| 请求 | 状态码 | 结论 |');
say('| --- | --- | --- |');
const cases = [
  ['真邀请函', `${base}/visit?t=${token}`],
  ['改过一个字的', `${base}/visit?t=${tampered}`],
  ['乱写的', `${base}/visit?t=obviously-not-a-real-token`],
];
let failed = 0;
const seen = {};
for (const [name, url] of cases) {
  const res = await fetch(url);
  const html = await res.text();
  seen[name] = {
    ok: html.includes('签名有效（Ed25519）'),
    bad: html.includes('签名对不上'),
    junk: html.includes('解析不出来'),
    head: html.includes('邀请你去串门'),
  };
  const s = seen[name];
  const verdict = s.ok ? `**签名有效（Ed25519）** · 签发方 ${kid}` : s.bad ? '**签名对不上**（拒收状态）' : s.junk ? '解析不出来（降级提示）' : '无签名结论';
  say(`| ${name} | ${res.status} | ${verdict}${name === '改过一个字的' && s.head ? ' ⚠️ 还显示了邀请标题' : ''} |`);
  if (res.status !== 200) failed += 1;
  const expect = name === '真邀请函' ? s.ok : name === '改过一个字的' ? (s.bad && !s.head) : s.junk;
  if (!expect) failed += 1;
}
say('');
const deck = await fetch(`${base}/deck`);
const deckHtml = await deck.text();
const deckVer = (deckHtml.match(/v?(\d+\.\d+\.\d+)/) || [])[0] || '(没找着)';
say(`- \`/deck\` 状态页：${deck.status}，里面写的版本：\`${deckVer}\``);
say('');

const checks = [
  ['装的版本是 ' + ver, existsSync(installedPkg) && JSON.parse(readFileSync(installedPkg, 'utf8')).version === ver],
  ['装的代码里有 ed25519', /ed25519/i.test(visitJs)],
  ['装的代码保留 v1 兼容', /visit-secret/.test(visitJs)],
  ['真邀请函验签通过', seen['真邀请函'].ok],
  ['改过一个字被拒（且不显示邀请标题）', seen['改过一个字的'].bad && !seen['改过一个字的'].head],
  ['乱写的降级但页面不白屏', seen['乱写的'].junk],
  ['/deck 返回 200', deck.status === 200],
  ['/deck 报的版本与磁盘一致', deckVer.replace(/^v/, '') === ver],
];
const bad = checks.filter(([, ok]) => !ok);
say('## 4. 断言');
say('');
for (const [name, ok] of checks) say(`- ${ok ? '✅' : '❌'} ${name}`);
say('');
say('## 5. 收摊');
say('');
say(`- 演示目录 \`${ROOT}\` 连同签发私钥一起删掉；两个进程的工作区从此互不相干。`);
say(`- 令牌只在内存里出现过（长度 ${token.length}），没写进这份证据。`);
if (host) say(`- 临时宿主（PID ${host.child.pid}）已连子进程一起结束。`);
say('');
say(bad.length
  ? `**结论：${bad.length} 项断言没过，不算通过。**`
  : `**结论：${checks.length} 项断言全过——装进 profile 的那份代码，在真 DSH 宿主里对真邀请函验签通过，对改过字的当场拒收。**`);

if (host) {
  spawnSync('taskkill', ['/PID', String(host.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
rmSync(ROOT, { recursive: true, force: true });
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`[written] ${OUT}`);
// 不用 process.exit()：Windows 上句柄没关就强退会触发 libuv 断言（假失败）
process.exitCode = bad.length ? 1 : 0;
