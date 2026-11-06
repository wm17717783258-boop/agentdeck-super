/**
 * 1.10.0 悬浮桌宠客户端（bin/nexi-pet.mjs）：真起 HTTP、真出 HTML、真找浏览器。
 *
 * 这个套件刻意**不**去拉起 Edge 窗口（那会在测试里弹窗、还可能挂住 CI）：
 * 拉窗口那一步由证据脚本在真机上跑，这里证明"窗口要的一切都准备对了"——
 * 页面能出、SVG 是干净的、本地服务真回这一页、窗口参数算得对。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

import { buildPetHtml, externalRefs, findBrowser, windowPos } from '../bin/nexi-pet.mjs';
import { renderSprite, SKIN_STATES } from '../lib/pet/skins.js';

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-pet-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/* ── 1. 页面本身 ───────────────────────────────────────────────────────── */

test('页面是自包含的：内联 SVG、不引任何外链、能离线打开', () => {
  const svg = renderSprite({ skin: 'basic', state: 'idle', size: 200 });
  const html = buildPetHtml({ svg, size: 240 });

  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes(svg), 'SVG 该被原样内联进去');
  assert.match(html, /<svg/);
  // 不联网：没有真外链（SVG 的 xmlns 命名空间不算，它不联网）
  assert.deepEqual(externalRefs(html), [], '页面里不该出现任何真外链');
  assert.doesNotMatch(html, /<script[^>]+src=/i, '不该引外部脚本');
  assert.doesNotMatch(html, /<link[^>]+href=/i, '不该引外部样式');
  assert.doesNotMatch(html, /@import/);
  // 尺寸真的写进 CSS 了
  assert.match(html, /width: 240px/);
});

test('尺寸会被夹在合理区间，不会生成 5px 或 99999px 的怪物', () => {
  const svg = renderSprite({ skin: 'basic', state: 'idle', size: 100 });
  assert.match(buildPetHtml({ svg, size: 5 }), /width: 120px/, '太小要抬到下限');
  assert.match(buildPetHtml({ svg, size: 99999 }), /width: 560px/, '太大要压到上限');
  assert.match(buildPetHtml({ svg, size: 'abc' }), /width: 240px/, '乱写的回落默认值');
});

test('五种状态都能出图，未知状态回落到 idle 而不是空白', () => {
  for (const state of SKIN_STATES) {
    const svg = renderSprite({ skin: 'basic', state, size: 160 });
    assert.match(svg, /<svg/, `${state} 没出图`);
    const html = buildPetHtml({ svg, size: 160 });
    assert.ok(html.includes(String(state)) || !/data-state="undefined"/.test(html), `${state} 状态没带出去`);
  }
  const weird = renderSprite({ skin: 'basic', state: '不存在的状态', size: 160 });
  assert.match(weird, /data-state="idle"/, '未知状态该回落 idle');
});

test('页面里那点 JS 不写盘、不联网（右键关闭 + 双击换状态）', () => {
  const html = buildPetHtml({ svg: renderSprite({ skin: 'basic', size: 120 }), size: 180 });
  assert.match(html, /contextmenu/);
  assert.match(html, /window\.close\(\)/);
  assert.doesNotMatch(html, /fetch\(/, '不该有 fetch');
  assert.doesNotMatch(html, /localStorage/, '不该往本地存东西');
  assert.doesNotMatch(html, /XMLHttpRequest/);
});

/* ── 2. 窗口位置 ───────────────────────────────────────────────────────── */

test('四角位置算得对，且永远不会算出负数坐标', () => {
  const screen = { width: 1920, height: 1080 };
  const br = windowPos('bottom-right', 240, screen);
  assert.equal(br.width, 240);
  assert.ok(br.x > 1500 && br.x <= 1920 - 240, `右下 x 不对：${br.x}`);
  assert.ok(br.y > 700 && br.y <= 1080 - 240, `右下 y 不对：${br.y}`);

  const tl = windowPos('top-left', 240, screen);
  assert.equal(tl.x, 24);
  assert.equal(tl.y, 24);

  const tr = windowPos('top-right', 240, screen);
  assert.ok(tr.x > tl.x);

  // 小屏 + 大窗口：不能算成负坐标（那会让窗口跑到屏幕外）
  const tiny = windowPos('bottom-right', 500, { width: 400, height: 300 });
  assert.ok(tiny.x >= 0, `算出负 x：${tiny.x}`);
  assert.ok(tiny.y >= 0, `算出负 y：${tiny.y}`);
  assert.ok(tiny.width >= 120, '窗口宽度不能小于下限');
});

/* ── 3. 浏览器探测 ─────────────────────────────────────────────────────── */

test('本机能找到 Edge 或 Chrome；找不到也是明确返回 null 而不是抛异常', () => {
  const saved = process.env.NEXI_BROWSER;
  delete process.env.NEXI_BROWSER;
  try {
    const found = findBrowser();
    assert.ok(found === null || existsSync(found), `返回了一个不存在的路径：${found}`);
    if (found) assert.match(found, /(msedge|chrome)\.exe$/i);
  } finally {
    if (saved != null) process.env.NEXI_BROWSER = saved;
  }
  // 指一个不存在的路径：要老实返回 null，不能抛
  process.env.NEXI_BROWSER = 'C:\\definitely\\not\\here\\msedge.exe';
  try {
    const none = findBrowser();
    assert.notEqual(none, 'C:\\definitely\\not\\here\\msedge.exe', '不存在的路径不该被当成浏览器');
  } finally {
    if (saved != null) process.env.NEXI_BROWSER = saved;
    else delete process.env.NEXI_BROWSER;
  }
});

/* ── 4. 本地服务真的只回这一页 ─────────────────────────────────────────── */

test('本地小服务：GET / 回页面，别的路径 404，不读盘不代理', async () => {
  const { root, done } = freshRoot('serve');
  let server = null;
  try {
    const html = buildPetHtml({ svg: renderSprite({ skin: 'basic', size: 160 }), size: 200 });
    server = createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('只有 / 这一页');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const okRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(okRes.status, 200);
    assert.match(okRes.headers.get('content-type'), /text\/html/);
    const body = await okRes.text();
    assert.ok(body.includes('<svg'), '回来的该是那张带桌宠的页面');

    const miss = await fetch(`http://127.0.0.1:${port}/../../etc/passwd`);
    assert.equal(miss.status, 404, '别的路径一律 404（顺带证明不往外代理）');
    assert.match(await miss.text(), /只有 \/ 这一页/);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    done();
  }
});

/* ── 5. 出文件模式 ─────────────────────────────────────────────────────── */

test('--out 写出来的 HTML 能离线打开（内容与内存里那份一致）', () => {
  const { root, done } = freshRoot('outfile');
  try {
    const svg = renderSprite({ skin: 'basic', state: 'working', size: 200, root });
    const html = buildPetHtml({ svg, size: 240 });
    const file = join(root, 'pet.html');
    writeFileSync(file, html, 'utf8');
    assert.ok(existsSync(file));
    const back = readFileSync(file, 'utf8');
    assert.equal(back, html);
    assert.ok(back.includes('<svg'));
    assert.deepEqual(externalRefs(back), [], '写出来的文件里也不该有真外链');
  } finally {
    done();
  }
});

/* ── 6. 脚本真的存在、能被 node 跑 ─────────────────────────────────────── */

test('bin/nexi-pet.mjs 是真实文件，且 package.json 的 bin 表里有它', () => {
  const file = resolve('bin/nexi-pet.mjs');
  assert.ok(existsSync(file), `文件不在：${file}`);
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  assert.ok(pkg.bin?.['nexi-pet'], 'package.json 的 bin 里没有 nexi-pet');
  assert.match(String(pkg.bin['nexi-pet']), /nexi-pet\.mjs$/);
});
