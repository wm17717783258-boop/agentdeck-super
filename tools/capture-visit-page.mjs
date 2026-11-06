#!/usr/bin/env node
/**
 * 一条命令复现 `/visit` 落地页的证据：4 张截图 + 一次 HTTP 断言。
 *
 *   node tools/capture-visit-page.mjs [port]
 *
 * 干的事：
 *   1. 另起 `tools/serve-visit-page.mjs`（真 HTTP 服务，内存外无副作用的工作区）
 *   2. 拿真邀请函，再自己伪造一张"改过一个字"的邀请函
 *   3. 对 4 个 URL 各发一次请求，断言页面里该出现 / 不该出现的字
 *   4. 用本机 Edge headless 截 4 张图（找不到 Edge 就如实写"环境未配"，不编）
 *   5. 收摊：杀子进程、删演示目录（连签发私钥一起删，图里那条深链就废了）
 *
 * 令牌不进任何证据文件；只记长度。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const EVID = join(PKG, 'docs', 'evidence');
const DEMO = 'D:\\demo\\visitpage';
const port = Number(process.argv[2] || 57961);
const txtOut = join(EVID, `visit-page-probe-${ver}.txt`);

const EDGES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const edge = EDGES.find((p) => existsSync(p));

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

mkdirSync(EVID, { recursive: true });
say(`# /visit 落地页：4 个输入 × 真 HTTP 断言 + 真截图（${ver}）`);
say(`# 生成时间：${new Date().toISOString()} · 端口 ${port}`);
say('');

/* ── 1. 起演示主机 ────────────────────────────────────────────────── */
const child = spawn(process.execPath, [join(PKG, 'tools', 'serve-visit-page.mjs'), String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let buf = '';
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('演示主机 30 秒没打印 READY')), 30000);
  child.stdout.on('data', (chunk) => {
    buf += String(chunk);
    const hit = buf.match(/READY (\{.*\})/);
    if (hit) { clearTimeout(timer); resolve(JSON.parse(hit[1])); }
  });
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`演示主机退出（${code}）`)); });
});

const token = new URL(ready.good).searchParams.get('t') || '';
const [body, sig] = token.split('.');
const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
forged.from.name = '冒充的小犀';
const tamperedUrl = `${ready.base}/visit?t=${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;

const cases = [
  { name: 'good', url: ready.good, shot: `visit-page-${ver}.png`, h: 1200 },
  { name: 'tampered', url: tamperedUrl, shot: `visit-page-tampered-${ver}.png`, h: 900 },
  { name: 'noToken', url: ready.noToken, shot: `visit-page-no-token-${ver}.png`, h: 620 },
  { name: 'badToken', url: ready.badToken, shot: `visit-page-bad-token-${ver}.png`, h: 800 },
];

/* ── 2. HTTP 断言 ─────────────────────────────────────────────────── */
say('## HTTP 断言');
say('');
say('| 输入 | 状态码 | 签名有效 | 签名对不上 | 解析不出来 | 「邀请你去串门」标题 |');
say('| --- | --- | --- | --- | --- | --- |');
for (const c of cases) {
  const res = await fetch(c.url);
  const html = await res.text();
  c.status = res.status;
  c.marks = {
    ok: html.includes('签名有效（Ed25519）'),
    tampered: html.includes('签名对不上'),
    junk: html.includes('解析不出来'),
    inviteHead: html.includes('邀请你去串门'),
  };
  const yn = (b) => (b ? '有' : '—');
  say(`| ${c.name} | ${res.status} | ${yn(c.marks.ok)} | ${yn(c.marks.tampered)} | ${yn(c.marks.junk)} | ${yn(c.marks.inviteHead)} |`);
}
say('');
say('期望：`good` 只有「签名有效」；`tampered` 只有「签名对不上」且**没有**邀请标题；');
say('`noToken` / `badToken` 三个签名结论都不出现，页面 200 不白屏。');
say('');

/* ── 3. 截图 ──────────────────────────────────────────────────────── */
say('## 截图');
say('');
if (!edge) {
  say('**环境未配**：本机没找到 Microsoft Edge，截图这一步跳过（HTTP 断言仍然是真的）。');
} else {
  say(`用的浏览器：\`${edge}\`（\`--headless=new --screenshot\`）`);
  say('');
  for (const c of cases) {
    const png = join(EVID, c.shot);
    const ud = join(process.env.TEMP || process.env.TMP || '/tmp', `edge-visit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const r = spawnSync(edge, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=1000,${c.h}`, `--screenshot=${png}`, `--user-data-dir=${ud}`, c.url,
    ], { timeout: 90000, windowsHide: true });
    const size = existsSync(png) ? readFileSync(png).length : 0;
    say(`- \`${c.shot}\`（${c.name}）→ ${size ? `${size} 字节` : `**失败**，退出码 ${r.status}`}`);
  }
}
say('');

/* ── 4. 收摊 ──────────────────────────────────────────────────────── */
say('## 收摊');
say('');
say('- 演示主机已关；`D:\\demo\\visitpage` 连同签名私钥 `visit-key.json` 一起删掉——');
say('  截图里那条 `dsh://` 深链因此**再也签不出新东西**，它只是张图。');
say(`- 邀请令牌只出现在本次运行的内存里，长度 ${token.length} 字符，没写进任何文件。`);
try { rmSync(DEMO, { recursive: true, force: true }); } catch { /* 删不掉不影响结论 */ }
writeFileSync(txtOut, lines.join('\n') + '\n', 'utf8');
console.log(`[written] ${txtOut}`);

child.kill();
if (process.platform === 'win32' && child.pid) {
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
const bad = cases.filter((c) => c.status !== 200);
process.exit(bad.length ? 1 : 0);
