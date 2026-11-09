#!/usr/bin/env node
/**
 * bin/nexi-pet.mjs —— 2D 悬浮桌宠客户端（不装 Electron，不装 Tauri）
 *
 * 为什么这么做：产品方案要的是"桌宠真在桌面上飘着"，但多打一个 Electron 壳
 * 会让插件体积翻十倍、还得单独签名分发。本机 Windows 自带 Edge（Chromium），
 * 用 `msedge --app=<url>` 就能开一个**没有地址栏、没有标签页**的独立窗口；
 * 再加一层"透明 + 置顶"的本地页面，就是桌宠本体。
 *
 * 这一层只干三件事：
 *   1. 生成一个自包含的 pet.html（内联 SVG，不联网、不引 CDN）；
 *   2. 在本机起一个极小的 http 服务把它喂给 Edge（file:// 下改不了窗口尺寸/位置语义）；
 *   3. 拉起 Edge --app 窗口，并把窗口位置/大小交给用户参数决定。
 *
 * 诚实边界（写清楚，不吹）：
 *   - 浏览器的窗口**不可能**做逐像素透明（那是 OS 合成器的事），这里用「无边框 + 圆角卡片」
 *     代替真透明；视觉上是浮在桌面上的小宠物，不是"抠掉背景的照片"。
 *   - 也不做鼠标穿透（点一下会激活窗口）。要真透明/穿透只能上 Electron/Tauri 或 Win32 原生窗口，
 *     那与"轻量插件"的产品定位冲突，所以明说而不是假装。
 *
 * 用法：
 *   node bin/nexi-pet.mjs                # 开桌宠（默认 240px，右下角）
 *   node bin/nexi-pet.mjs --size 320 --corner top-right
 *   node bin/nexi-pet.mjs --port 58501 --out D:\tmp\pet.html
 *   node bin/nexi-pet.mjs --print        # 只打印 URL / 文件路径，不开窗口
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { listSkins, renderSprite, SKIN_STATES } from '../lib/pet/skins.js';
import { createPetLayer } from '../lib/pet/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/* ── 参数 ──────────────────────────────────────────────────────────────── */

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}

const SIZE = Math.min(560, Math.max(120, Number(flag('size', 240)) || 240));
const CORNER = String(flag('corner', 'bottom-right'));
const WANT_PORT = Number(flag('port', 0)) || 0;
const OUT = flag('out', null);
const PRINT_ONLY = flag('print', false) === true;
const STATE = SKIN_STATES.includes(String(flag('state', 'idle'))) ? String(flag('state', 'idle')) : 'idle';

/* ── 找皮肤：用户装了就用用户的，没装就退到内置 ─────────────────────────── */

function pickSkin(root) {
  try {
    const skins = listSkins({ root });
    const listed = Array.isArray(skins) ? skins : skins?.skins || [];
    const usable = listed.find((s) => s && s.unlocked !== false && (s.available ?? true));
    if (usable) return usable;
  } catch {
    /* 皮肤层读不出来不算致命：下面会给占位图 */
  }
  return 'basic';
}

/* ── 生成页面：一份自包含 HTML（内联 SVG + 内联 CSS + 一点点 JS） ────────── */

export function buildPetHtml({ svg, size = SIZE, title = 'Nexi 桌宠' } = {}) {
  const px = Math.min(560, Math.max(120, Math.round(Number(size) || 240)));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #f4efe4; overflow: hidden; }
  /* 无边框小卡片：浏览器做不到逐像素透明，用圆角 + 柔和阴影代替，见文件头说明。 */
  body {
    display: flex; align-items: center; justify-content: center;
    width: ${px}px; height: ${px}px;
    border-radius: 28px;
    box-shadow: inset 0 0 0 1px rgba(120,96,64,.18);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none;
    cursor: grab;
  }
  body:active { cursor: grabbing; }
  #pet { width: ${px - 16}px; height: ${px - 16}px; display: block; }
  #pet svg { width: 100%; height: 100%; display: block; }
  #hint {
    position: fixed; left: 0; right: 0; bottom: 6px; text-align: center;
    font-size: 11px; color: #8a755a; opacity: .75; pointer-events: none;
  }
</style>
</head>
<body>
  <div id="pet" role="img" aria-label="Nexi 桌宠">${svg}</div>
  <div id="hint">拖我 · 右键关掉</div>
  <script>
    // 双击换状态是本地小彩蛋，不联网、不写盘：只在这张页面里转圈。
    const states = ${JSON.stringify(SKIN_STATES)};
    let i = states.indexOf(${JSON.stringify(STATE)});
    document.body.addEventListener('dblclick', () => {
      i = (i + 1) % states.length;
      document.title = 'Nexi 桌宠 · ' + states[i];
    });
    document.body.addEventListener('contextmenu', (e) => { e.preventDefault(); window.close(); });
  </script>
</body>
</html>`;
}

/* ── 找 Edge / Chrome ─────────────────────────────────────────────────── */

const BROWSER_CANDIDATES = [
  process.env.NEXI_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 窗口位置：四角之一，留 24px 边距；小屏上宁可贴边也不许算出屏幕外（负坐标）。 */
export function windowPos(corner, size, screen = { width: 1920, height: 1080 }) {
  const m = 24;
  const px = Math.min(560, Math.max(120, Math.round(Number(size) || 240)));
  const sw = Math.max(px, Math.round(Number(screen?.width) || 1920));
  const sh = Math.max(px, Math.round(Number(screen?.height) || 1080));
  // 屏幕比窗口还小时（远程桌面/缩放），左上角就是唯一合法位置。
  const maxX = Math.max(0, sw - px - m);
  const maxY = Math.max(0, sh - px - m - 48);
  const x = String(corner).includes('right') ? maxX : Math.min(m, maxX);
  const y = String(corner).includes('bottom') ? maxY : Math.min(m, maxY);
  return { x: Math.round(Math.max(0, x)), y: Math.round(Math.max(0, y)), width: px, height: px };
}

/** 页面里唯一允许出现的 http:// 是 SVG 的 XML 命名空间（不是外链，离线照样打开）。 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 页面里到底有没有"真外链"（会联网拉东西的那种）——测试和自查都用这一份判断。 */
export function externalRefs(html) {
  const stripped = String(html).split(SVG_NS).join('');
  const hits = stripped.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  return [...new Set(hits)];
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

async function main() {
  const root = String(flag('root', process.cwd()));
  const skin = pickSkin(root);

  let svg;
  try {
    svg = renderSprite({ skin, state: STATE, size: SIZE - 16, root });
  } catch (err) {
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><text x="50%" y="50%" text-anchor="middle" fill="#8a755a">桌宠素材读不出来：${String(err?.message || err).slice(0, 60)}</text></svg>`;
  }
  const html = buildPetHtml({ svg, size: SIZE });

  if (OUT) {
    mkdirSync(dirname(resolve(String(OUT))), { recursive: true });
    writeFileSync(resolve(String(OUT)), html, 'utf8');
  }

  // 极小的本地服务：只回一张页面，不读盘、不代理、不联网。
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html' || req.url?.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('只有 / 这一页');
  });
  await new Promise((done) => server.listen(WANT_PORT, '127.0.0.1', done));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  if (PRINT_ONLY) {
    console.log(JSON.stringify({ ok: true, url, out: OUT ? resolve(String(OUT)) : null, size: SIZE, corner: CORNER, browser: findBrowser(), skin: typeof skin === 'string' ? skin : skin?.id, state: STATE }, null, 2));
    server.close();
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    console.log('没找到 Edge / Chrome，桌宠窗口开不起来。');
    console.log(`页面已经准备好了，手动打开这个地址也一样：${url}`);
    console.log('（想指定浏览器：set NEXI_BROWSER=D:\\path\\to\\msedge.exe）');
    return; // 服务器留着，让用户手动打开
  }

  const pos = windowPos(CORNER, SIZE);
  const args = [
    `--app=${url}`,
    `--window-size=${pos.width},${pos.height}`,
    `--window-position=${pos.x},${pos.y}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    `--user-data-dir=${join(root, '.agentdeck', 'pet', 'browser-profile')}`,
  ];
  const child = spawn(browser, args, { detached: true, stdio: 'ignore' });
  child.unref();

  console.log('桌宠已起来（Edge --app 独立窗口，无地址栏、无标签页）。');
  console.log(`  皮肤：${typeof skin === 'string' ? skin : skin?.id || 'basic'}｜状态：${STATE}｜尺寸：${SIZE}px`);
  console.log(`  位置：${CORNER}（${pos.x}, ${pos.y}）`);
  console.log(`  地址：${url}`);
  console.log('  关掉：窗口里右键，或直接叉掉窗口。');
  console.log('  诚实说明：浏览器窗口做不到逐像素透明与鼠标穿透，这里是"无边框圆角小窗"；');
  console.log('  本地服务只回这一张页面，不读盘、不联网，关掉进程即结束。');
}

// 只在本文件被直接执行时跑（被 import 时只导出 buildPetHtml / windowPos / findBrowser）
const isDirect = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  main().catch((err) => {
    console.error(`桌宠启动失败：${err?.message || err}`);
    process.exitCode = 1;
  });
}

export default { buildPetHtml, windowPos, findBrowser, externalRefs };
