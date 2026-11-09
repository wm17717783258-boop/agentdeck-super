#!/usr/bin/env node
/**
 * tools/nexi-lan.mjs —— 让"多台设备真机测试"变得能用
 *
 * 真机测试的麻烦不在代码，在三件脏活：
 *   1) 用户得知道"我这台机器的局域网地址是什么、别的设备该连哪个"（现在要自己去 ipconfig 里翻）
 *   2) 用户得有个**能在别的设备上打开**的入口（手机没法跑 node，但能开浏览器）
 *   3) 出了问题得能判断"到底对面连上来了没有"
 *
 * 这个脚本一次把这三件都办了。
 *
 * 用法：
 *   node tools/nexi-lan.mjs                 打印本机所有地址 + 该用哪个 + 配对码
 *   node tools/nexi-lan.mjs --serve         起一个"加入页"HTTP 服务（手机浏览器能打开）
 *   node tools/nexi-lan.mjs --json          机器可读（给别的脚本/自动化用）
 *   node tools/nexi-lan.mjs --port 9000     换端口
 *
 * 明确不做的事：
 *   - 不画二维码（终端里画码不可靠，画错比不画更坑）。改成给一段可以直接复制/发微信的文本。
 *   - 不开公网隧道（那要第三方账号）。跨公网请看 docs/多设备协作测试方案.md 阶段 D。
 */

import { createServer } from 'node:http';
import { networkInterfaces, hostname, platform, release } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const SERVE = argv.includes('--serve');

function flagValue(name, fallback = '') {
  const eq = `${name}=`;
  const withEq = argv.find((a) => a.startsWith(eq));
  if (withEq) return withEq.slice(eq.length);
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const PORT = Number(flagValue('--port', 8788)) || 8788;
const RELAY_PORT = Number(flagValue('--relay-port', 8787)) || 8787;

/**
 * 收集本机所有 IPv4 地址，按"别人最可能连得上"排序。
 * 真局域网地址优先；虚拟网卡（VMware/WSL/Docker/Hyper-V）和回环垫底。
 */
function collectAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4') continue;
      const isLoopback = info.address.startsWith('127.');
      const looksVirtual = /vmnet|vbox|wsl|docker|hyper-v|loopback|virtual/i.test(name);
      out.push({
        iface: name,
        address: info.address,
        internal: Boolean(info.internal) || isLoopback,
        virtual: looksVirtual,
        rank: (isLoopback ? 100 : 0) + (looksVirtual ? 50 : 0),
      });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address));
}

function bestAddress(addrs) {
  const usable = addrs.filter((a) => !a.internal && !a.virtual);
  if (usable.length) return { ...usable[0], why: '真实局域网网卡，别的设备应该能连' };
  const nonLoop = addrs.filter((a) => !a.internal);
  if (nonLoop.length) return { ...nonLoop[0], why: '虚拟网卡：能试，但别的设备大概率连不通' };
  return {
    address: '127.0.0.1',
    iface: '(仅本机)',
    internal: true,
    virtual: false,
    why: '只有回环地址：别的设备连不上，请先接上 WiFi 或网线',
  };
}

/** 生成一段可以直接发微信/贴聊天的测试说明（比二维码实用）。 */
function handoffText({ host, relayUrl, joinUrl, token }) {
  return [
    '【Nexi 灵犀 · 多设备测试】',
    '',
    `配对码：${token}`,
    `中继地址：${relayUrl}`,
    `加入页：${joinUrl}`,
    '',
    '第二台设备要做的：',
    '1) 连同一个 WiFi',
    `2) 浏览器打开加入页，点「测试能不能连上中继」`,
    '3) 拿到 agentdeck-super-1.10.0.tgz 并解包',
    `4) node bin/nexi.mjs call deck_room '{"action":"join","inviteUrl":"<第一台设备给你的邀请链接>"}'`,
    '',
    '注意：进房间不需要授权码，只有建房间的那台需要。',
  ].join('\n');
}

function joinPageHtml({ host, relayPort, token }) {
  const relay = `http://${host}:${relayPort}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexi 灵犀 · 加入测试</title>
<style>
  :root{--bg:#0f1117;--card:#181b24;--fg:#e8eaf0;--mute:#8b93a7;--accent:#5b8cff;--ok:#3ecf8e;--bad:#ff6b6b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);padding:20px;
    font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:640px;margin:0 auto}
  h1{font-size:20px;margin:0 0 6px}
  .mute{color:var(--mute);font-size:13px}
  .card{background:var(--card);border:1px solid #252a36;border-radius:12px;padding:16px;margin:14px 0}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
  pre{background:#0b0d12;border:1px solid #252a36;border-radius:8px;padding:12px;overflow:auto;margin:8px 0;white-space:pre-wrap;word-break:break-all}
  .token{font-size:26px;letter-spacing:.18em;font-weight:700;color:var(--accent)}
  .btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer}
  .copy{background:#0b0d12;border:1px solid #333a4a;color:var(--fg);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
  .ok{color:var(--ok)}.bad{color:var(--bad)}
  ol{padding-left:20px}li{margin:7px 0}
</style></head><body><div class="wrap">
  <h1>Nexi 灵犀 · 多设备测试</h1>
  <p class="mute">你现在在<b>第二台设备</b>上。这一页负责把这台设备接进测试。</p>

  <div class="card">
    <div class="mute">配对码（两边应一致）</div>
    <div class="row">
      <span class="token">${esc(token)}</span>
      <button class="copy" onclick="cp('${esc(token)}',this)">复制</button>
    </div>
  </div>

  <div class="card">
    <div class="mute">中继地址（第二台设备连这个）</div>
    <pre>${esc(relay)}</pre>
    <button class="copy" onclick="cp('${esc(relay)}',this)">复制地址</button>
  </div>

  <div class="card">
    <div class="mute">先自检：这台设备能不能连上中继</div>
    <div class="row">
      <button class="btn" onclick="probe()">测试连接</button>
      <span id="probe" class="mute">未测试</span>
    </div>
  </div>

  <div class="card">
    <div class="mute">接下来三步</div>
    <ol>
      <li>确认两台设备在<b>同一个 WiFi</b>（手机热点也行）</li>
      <li>拿到 <code>agentdeck-super-1.10.0.tgz</code>（从第一台设备传：微信/U 盘/网盘都行）</li>
      <li>解包后，用第一台设备给你的邀请链接进房：
        <pre>node bin/nexi.mjs call deck_room '{"action":"join","inviteUrl":"&lt;邀请链接&gt;"}'</pre>
      </li>
    </ol>
    <p class="mute"><b>进房间不需要授权码</b>，只有建房间的那台需要。</p>
  </div>
</div>
<script>
function cp(t,btn){
  if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){btn.textContent='已复制';setTimeout(function(){btn.textContent='复制'},1200)})}
  else{var i=document.createElement('textarea');i.value=t;document.body.appendChild(i);i.select();document.execCommand('copy');i.remove();btn.textContent='已复制'}
}
async function probe(){
  var el=document.getElementById('probe');
  el.textContent='请求中…';el.className='mute';
  try{
    var r=await fetch('${esc(relay)}/v1/plans',{signal:AbortSignal.timeout(6000)});
    var j=await r.json();
    if(j&&j.ok){el.textContent='连上了，中继正常（档位 '+((j.plans||[]).length)+' 个）';el.className='ok'}
    else{el.textContent='连上了，但返回异常';el.className='mute'}
  }catch(e){
    el.textContent='连不上：'+(e&&e.name==='TimeoutError'?'超时':'网络不可达')+' —— 检查是否同一 WiFi、防火墙是否放行';
    el.className='bad';
  }
}
</script></body></html>`;
}

async function main() {
  let version = '?';
  try {
    version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
  } catch {
    // 读不到版本不影响这个脚本的用途
  }

  const addrs = collectAddresses();
  const best = bestAddress(addrs);
  const joinUrl = `http://${best.address}:${PORT}/`;
  const relayUrl = `http://${best.address}:${RELAY_PORT}`;
  const token = randomBytes(3).toString('hex').toUpperCase();

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version,
      host: hostname(),
      platform: `${platform()} ${release()}`,
      addresses: addrs,
      best,
      relayUrl,
      joinUrl,
      joinPort: PORT,
      relayPort: RELAY_PORT,
      token,
      hasRealLan: !best.internal && !best.virtual,
      handoff: handoffText({ host: hostname(), relayUrl, joinUrl, token }),
    }, null, 2)}\n`);
    return;
  }

  console.log(`Nexi 灵犀 v${version} —— 多设备测试助手\n`);
  console.log(`本机：${hostname()}（${platform()} ${release()}）\n`);

  console.log('本机可用地址：');
  if (!addrs.length) console.log('  （一个都没有：网卡没起来？）');
  for (const a of addrs) {
    const tag = a.internal ? '仅本机' : a.virtual ? '虚拟网卡' : '局域网';
    const mark = a.address === best.address ? '   <= 用这个' : '';
    console.log(`  [${tag}]  ${a.address.padEnd(16)} ${a.iface}${mark}`);
  }
  console.log('');

  if (best.internal) {
    console.log('!! 没找到局域网地址，别的设备连不上这台。');
    console.log('   先确认这台接了 WiFi 或有线网。');
    console.log('   （纯离线手测：同一台机器开两个目录也能验，见方案阶段 A。）\n');
  } else if (best.virtual) {
    console.log(`!! 只找到虚拟网卡（${best.iface}），别的设备大概率连不通。`);
    console.log('   建议切到真实 WiFi 再跑一次本命令。\n');
  } else {
    console.log(`选定地址：${best.address}（${best.iface}）—— ${best.why}\n`);
  }

  console.log('─'.repeat(60));
  console.log('第一台设备（房主，要发码的那台）：');
  console.log(`  1) 起中继：  node tools/relay-server.mjs --port ${RELAY_PORT} --host 0.0.0.0 --data .relay-data`);
  console.log(`  2) 建房间时 relayUrl 填：  ${relayUrl}`);
  console.log('');
  console.log('第二台设备（客人，不需要授权码）：');
  console.log(`  中继地址填：  ${relayUrl}`);
  console.log(`  加入页：      ${joinUrl}`);
  console.log(`  配对码：      ${token}`);
  console.log('─'.repeat(60));

  if (SERVE) {
    const server = createServer((req, res) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url, `http://${best.address}:${PORT}`).pathname;
      } catch {
        pathname = '/';
      }
      if (pathname === '/' || pathname === '/join') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(joinPageHtml({ host: best.address, relayPort: RELAY_PORT, token }));
        return;
      }
      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, token, relay: relayUrl }));
        return;
      }
      if (pathname === '/handoff') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(handoffText({ host: hostname(), relayUrl, joinUrl, token }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('可用：/ 、/healthz 、/handoff');
    });
    server.listen(PORT, '0.0.0.0');
    console.log('');
    console.log(`加入页已启动：${joinUrl}`);
    console.log('  用第二台设备的浏览器打开它（手机也行），点里面的「测试连接」。');
    console.log(`  纯文本版说明：${joinUrl}handoff（方便复制到微信）`);
    console.log('');
    console.log('按 Ctrl-C 停止。');

    process.on('SIGINT', () => {
      server.close(() => process.exit(0));
      // 兜底：个别平台 close 回调不触发
      setTimeout(() => process.exit(0), 500).unref();
    });
    await new Promise(() => {});
  } else {
    console.log('');
    console.log('想让第二台设备用浏览器打开加入页（含连通性自检 + 可复制说明）：');
    console.log(`  node tools/nexi-lan.mjs --serve --port ${PORT}`);
  }
}

main().catch((err) => {
  console.error('出错了：', err?.stack || err);
  process.exitCode = 2;
});
