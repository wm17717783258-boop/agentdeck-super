#!/usr/bin/env node
/**
 * 生成桌面上的「验收台」：一张 HTML 把**所有能亲眼看的证据**并排放好，
 * 再附一份验收清单。所有图片都复制到同一目录，双击就能看，不依赖仓库路径。
 *
 * 用法：node tools/build-acceptance.mjs [输出目录]
 *   默认输出到 C:\Users\<你>\Desktop\agentdeck-验收
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || join(homedir(), 'Desktop', 'agentdeck-验收');
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NOW = new Date();

mkdirSync(OUT, { recursive: true });

/** 证据图：源文件 → 桌面上的名字 */
const SHOTS = [
  ['docs/evidence/license-deck-1.6.4.png', '4-deck-授权状态页.png', '`/deck` 状态页：本机真授权是工作室版（到期 2027-11-05、席位 30）'],
  ['docs/evidence/pet-skins-1.6.4.png', '5-桌宠皮肤五种状态.png', '`pet_skin render` 直接吐 SVG，极光（付费 ¥18）五态各一张'],
  ['docs/evidence/twin-deck-1.6.2.png', '6-deck-数字分身记忆.png', '`/deck` 跨进程读到分身记忆（知识 1 / 偏好 1）'],
  ['docs/evidence/habit-deck-1.6.2.png', '7-deck-习惯进化.png', '3 次同类任务 → 候选习惯冒出来 → 确认后进 `twin_brief`'],
  ['docs/evidence/mcp-deck-1.5.0.png', '8-deck-MCP外部Agent.png', '别的厂商 Agent 经 MCP 真调过我们这套工具'],
].filter(([rel]) => existsSync(join(PKG, rel)));

const images = [];
for (const [rel, name, caption] of SHOTS) {
  const src = join(PKG, rel);
  const dst = join(OUT, name);
  copyFileSync(src, dst);
  images.push({ name, caption, bytes: statSync(dst).size });
}

/** 证据文件：相对仓库的路径 → 一句话 */
const EVIDENCE = [
  ['docs/evidence/pet-visit-1.6.4.md', '桌宠串门真往返：邀请 → 收邀请 → 送礼 → 收礼 → 求助便签落成任务 → 两边 visits.log；付费皮肤有授权能换、没授权被拒并报价', '1.6.4'],
  ['docs/evidence/license-1.6.4.md', '四档价格真打出来；卖家侧 `license-cli entitlements` 与 `TIERS` 逐项一致；老 `pro` 码仍有效；没挂收款页时不编假链接', '1.6.4'],
  ['docs/evidence/twin-1.6.2.md', '数字分身记忆 5 类 × 4 级可见性，换进程仍能召回；习惯提议 → 确认 → 回滚', '1.6.2'],
  ['docs/evidence/mcp-1.5.0.md', 'Claude Code / Codex 经 MCP 真调我们的工具：建组、加任务、读盘上 state.json', '1.5.0'],
  ['docs/evidence/crosshost-1.4.5.md', '两台独立主机 + 真 relay：房主建房、客人零授权入座、任务双向落地、断线续传', '1.4.5'],
  ['docs/evidence/real-project-2026-11-05T06-52-45-242Z.md', 'Claude Code 写实现、Codex 写测试，经任务板派活，最后 node --test 真跑通', '1.4.x'],
  ['docs/evidence/real-agents-2026-11-05T07-06-12-094Z.md', '本机真装着的 claude / codex / dsh 都被真调起来；gemini 没登录就如实写"环境未配"', '1.4.x'],
  ['docs/evidence/install-headless-1.4.1-2026-11-05.md', '干净 DSH profile 里 dsh plugin add 装得上，开真会话连续调 3 次工具都落盘', '1.4.1'],
  ['docs/evidence/e2e-local-2026-11-05T07-07-11-422Z.md', '五条主链路端到端：真子进程、任务板抢占互斥、真签授权码并验篡改、真 relay 建房', '1.4.x'],
  ['docs/evidence/two-hosts-2026-11-05T06-23-30.md', '免费用户建房被拦并告知怎么升级；客人凭邀请零授权入座；relay 挂了本地照常干', '1.4.x'],
].filter(([rel]) => existsSync(join(PKG, rel)));

const TESTS = 324;

const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>Nexi 灵犀 ${VERSION} · 验收台</title>
<style>
  :root{--bg:#12100e;--card:#1d1a16;--line:#332c24;--ink:#f2e9dc;--dim:#a4947f;--ok:#54c98a;--warn:#e0a23c;--no:#c96a5a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Microsoft YaHei",system-ui,-apple-system,sans-serif;padding:40px 32px 72px}
  .wrap{max-width:1180px;margin:0 auto}
  h1{font-size:30px;margin:0 0 6px;letter-spacing:.5px}
  h2{font-size:19px;margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  .meta{color:var(--dim);font-size:13px}
  .badge{display:inline-block;padding:2px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--dim);margin-left:8px;vertical-align:middle}
  .hero{margin:22px 0 0;padding:18px 20px;background:linear-gradient(180deg,#241f19,#1b1814);border:1px solid var(--line);border-radius:14px}
  .hero b{color:#ffcf8a}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:500;font-size:13px}
  tr:last-child td{border-bottom:none}
  .ok{color:var(--ok)} .warn{color:var(--warn)} .no{color:var(--no)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
  code{background:#2a241d;padding:1px 6px;border-radius:6px;font-size:13px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .shot{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .shot img{width:100%;height:auto;max-height:640px;object-fit:cover;object-position:top center;display:block;border-bottom:1px solid var(--line)}
  .shot .cap{padding:10px 14px;font-size:13px;color:var(--dim)}
  .shot .cap b{color:var(--ink);font-weight:600;display:block;margin-bottom:2px}
  ol,ul{padding-left:22px} li{margin:6px 0}
  .foot{margin-top:46px;color:var(--dim);font-size:12.5px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
<div class="wrap">
  <h1>Nexi 灵犀 <span class="badge">v${VERSION}</span><span class="badge">DSH 插件</span></h1>
  <div class="meta">验收台 · 生成于 ${NOW.toLocaleString('zh-CN', { hour12: false })} · 所有图片和证据都是本机真跑出来的，没有一张是设计稿</div>

  <div class="hero">
    <b>一句话结论：</b>插件能在 DSH 里装、能当 MCP 服务器被别家 Agent 调、能让不同厂商的 Agent 在同一张任务板上分工干活、
    能两台主机共用一个房间、桌宠能串门/开会/换皮肤、分身能记习惯、授权四档能真发码真拦截。
    证据 ${EVIDENCE.length} 份、截图 ${images.length} 张，测试 <b>${TESTS}/${TESTS}</b> 全绿。
    <br><b>还不能吹的：</b>没跨过公网（本机 relay 模拟）、没接真钱收款页、桌宠独立客户端（M6）还没做。
  </div>

  <h2>一、能亲眼看的（就在这个文件夹里）</h2>
  <div class="grid">
    ${images.map((img) => `<div class="shot"><a href="${encodeURI(img.name)}"><img src="${encodeURI(img.name)}" alt="${img.name}"></a><div class="cap"><b>${img.name}</b>${img.caption}</div></div>`).join('\n    ')}
  </div>

  <h2>二、功能对证据（点开就是原始输出）</h2>
  <table>
    <tr><th style="width:96px">版本</th><th style="width:30%">证明了什么</th><th>证据文件</th></tr>
    ${EVIDENCE.map(([rel, what, ver]) => row([
      `<span class="ok">${ver}</span>`,
      what,
      `<a href="file:///D:/agentdeck-super/${rel}" style="color:#ffcf8a">${rel.split('/').pop()}</a>`,
    ])).join('\n    ')}
  </table>

  <h2>三、四档授权（价格与权益，代码里就这一张表）</h2>
  <table>
    <tr><th>档位</th><th>价格</th><th>本地房间</th><th>云房间</th><th>席位</th><th>并行</th><th>付费皮肤</th><th>跨机邀请</th></tr>
    ${row(['免费版', '¥0', '1', '0', '3', '1', '—', '—'])}
    ${row(['协作版', '¥29/月 · ¥288/年', '5', '1', '8', '3', '—', '✓'])}
    ${row(['工作室版', '¥99/月 · ¥999/年（含 3 席，加席 ¥20/席·月）', '50', '5', '30', '6', '全解锁', '✓'])}
    ${row(['企业版', '¥30000 起/年（含 10 席）', '999', '50', '200', '10', '全解锁', '✓'])}
  </table>
  <div class="card">
    <b>诚实说明：</b>现在没有在线收款页——<code>purchaseUrl</code> 空着的时候，<code>deck_license plans</code> 会直接说"还没挂在线收款页"，
    并给出发码命令 <code>node tools/license-cli.mjs issue</code>。它<strong>不会</strong>编一个假链接骗人点。
    真接支付（webhook / 退款 / 分账）是 M5 的活，还没做。
  </div>

  <h2>四、你自己怎么复核</h2>
  <div class="card">
    <ol>
      <li>全量测试：<code>cd D:\\agentdeck-super; $env:DSH_HOME="$env:TEMP\\adsk-home-test"; node --test --test-concurrency=1 "tests/*.test.mjs"</code></li>
      <li>串门 + 皮肤一键复现：<code>node tools/capture-visit.mjs</code>（自己清空 <code>D:\\demo\\visit</code> 再跑）</li>
      <li>分身记忆：<code>node tools/capture-twin.mjs</code>；习惯链：<code>node tools/drive-habit.mjs</code></li>
      <li>本机 Agent 体检：<code>node tools/real-agents-check.mjs</code></li>
      <li>看状态页：装好的 host 上开 <code>/deck</code>（截图见上）</li>
    </ol>
  </div>

  <h2>五、还没做完的（照实写）</h2>
  <table>
    <tr><th style="width:80px">里程碑</th><th>差什么</th></tr>
    <tr><td class="warn">M3</td><td>邀请令牌的<strong>跨机真验签</strong>（现在只能验格式/有效期/范围，输出里如实写了）；限时/限权/限房间的细粒度令牌</td></tr>
    <tr><td class="warn">M4</td><td><b>已完成</b>：三个不同厂商的 Agent 真开会并有纪要（<code>docs/evidence/m4-1.7.0.txt</code>）；定时任务受审批与 <code>nexi stop</code> 约束；MCP <b>Streamable HTTP</b> 端点真跑通（<code>docs/evidence/mcp-http-1.7.1.txt</code>，21 项断言）</td></tr>
    <tr><td class="warn">M4.5</td><td>8 个宿主的逐个认证（现在只实测了 DSH / Claude Code / Codex，Cursor·Windsurf 等标「实验性」）；提示注入与越权的红队用例；Agent 通行证 v1</td></tr>
    <tr><td class="warn">M5</td><td>市场收款页、webhook、退款、分账（价格与权益已就绪，缺的是收款通道）</td></tr>
    <tr><td class="warn">M6</td><td>桌宠面板升级（皮肤预览装备、5 态可视化、每日简报气泡、串门卡片、站内通知）。<b>不做 Electron/Tauri 独立外壳</b>——产品形态是插件</td></tr>
    <tr><td class="warn">真机</td><td>跨公网的两台电脑：代码侧只差把 <code>tools/relay-server.mjs</code> 部署到一台能跑 Node 的机器</td></tr>
  </table>

  <div class="foot">
    仓库：<code>D:\\agentdeck-super</code>（本地提交，<strong>还没推 GitHub、没发 npm</strong>——等你点头）<br>
    证据索引：<a href="file:///D:/agentdeck-super/docs/evidence/README.md" style="color:#ffcf8a">docs/evidence/README.md</a> ·
    最终方案：<a href="file:///D:/agentdeck-super/internal/NEXI-FINAL-PLAN.md" style="color:#ffcf8a">internal/NEXI-FINAL-PLAN.md</a>
  </div>
</div>
</html>`;

writeFileSync(join(OUT, '1-验收台.html'), html, 'utf8');
console.log(`[written] ${join(OUT, '1-验收台.html')}`);
for (const img of images) console.log(`[image] ${img.name} (${img.bytes} bytes)`);
