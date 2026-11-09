#!/usr/bin/env node
/**
 * AgentDeck Relay —— 跨机器 / 跨人的协同中转（零依赖，单文件）
 *
 * 作用：让两台机器（或两个人）的 DSH 进同一个「房间」，共享任务板与消息。
 * 收费模型（真实可执行）：
 *   · **建房间要授权**（房主付费）——服务器用插件里同一把公钥验 ADSK 授权码，本地改代码绕不过去；
 *   · **进房间不要授权**（客人免费）——这是传播机制：你付费，你的朋友/同事带自己的 Agent 进来干活。
 * 免费用户完全可用本地房间（不经过本服务）。
 *
 * 启动：
 *   node tools/relay-server.mjs --port 8787 --data .relay-data
 *   自建服务器 / 群晖 / 树莓派 / Cloudflare 都可以；数据只是"谁领了哪块活"的事件流，不含代码内容。
 *
 * HTTP 接口（v1）：
 *   POST /v1/rooms                 建房间（需 Authorization: Bearer <ADSK 授权码>）
 *     body { name, owner, teamId } → { roomId, inviteToken, syncToken, seats, exp }
 *   POST /v1/rooms/:id/join        凭邀请进房（不需要授权）
 *     body { inviteToken, member:{ name, petSkin, role } } → { seatId, syncToken }
 *   POST /v1/rooms/:id/events      追加事件（Bearer syncToken）
 *     body { events:[{ kind, payload }] } → { seq }
 *   GET  /v1/rooms/:id/events?since=N&token=xxx → { events, seq, members }
 *   GET  /v1/rooms/:id             房间概况（Bearer syncToken 或 inviteToken）
 *   POST /v1/rooms/:id/leave       { syncToken }
 *   GET  /healthz
 */

import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createPublicKey, verify as cryptoVerify, randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { ISSUER_PUBLIC_SPKI_B64URL, verifyLicense, entitlements } from '../lib/license.js';
import { createHostingApi, HOSTING_PLANS } from '../lib/hosting/index.js';

const EVENT_LIMIT = 5000; // 单房间事件上限，超出丢弃最旧的（状态以最新为准）
const MAX_BODY = 512 * 1024;

// ── 房间存储：一个房间一个 JSON 文件，原子写 ────────────────────────────────

function createStore(dataDir) {
  const dir = resolve(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  /** @type {Map<string, object>} */
  const cache = new Map();

  const pathOf = (id) => join(dir, `${id}.json`);

  function load(id) {
    if (cache.has(id)) return cache.get(id);
    const p = pathOf(id);
    if (!existsSync(p)) return null;
    try {
      const room = JSON.parse(readFileSync(p, 'utf8'));
      cache.set(id, room);
      return room;
    } catch {
      return null;
    }
  }

  function save(room) {
    cache.set(room.id, room);
    const p = pathOf(room.id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(room), 'utf8');
    renameSync(tmp, p);
  }

  function list() {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => load(f.replace(/\.json$/, '')))
      .filter(Boolean);
  }

  return { load, save, list, dir };
}

// ── 工具 ───────────────────────────────────────────────────────────────────

function token() {
  return randomBytes(24).toString('base64url');
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/**
 * 对外可点的基础地址。
 *
 * 优先级：
 *   1. 运营者显式配置的 publicUrl（反代/隧道/VPS 的正式域名）
 *   2. 反代给的 X-Forwarded-Host/Proto
 *   3. 请求自己的 Host
 *   4. 本地兜底
 *
 * 显式 publicUrl 必须在最前：Quick Tunnel / 反代的请求 Host 经常是内部端口，
 * 不覆盖就会把 `http://127.0.0.1:8787` 发给客人，跨网络必挂。
 */
function publicBase(req, fallback, explicit = '') {
  if (explicit) return String(explicit).replace(/\/+$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (!host) return fallback || '';
  const proto = String(req.headers['x-forwarded-proto'] || '').trim() || 'http';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

/** publicUrl 只接受 http(s)，且不带凭据/查询串。 */
function normalizePublicUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`publicUrl 不是合法 URL：${text}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`publicUrl 必须是 http:// 或 https://：${text}`);
  }
  if (url.username || url.password) throw new Error('publicUrl 不要带用户名/密码');
  if (url.search || url.hash) throw new Error('publicUrl 不要带查询参数或锚点');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const PAGE_CSS = 'body{font:15px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:36px 24px 64px;color:#1f2328;background:#fbfcfd}'
  + '.card{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e6ea;border-radius:12px;padding:26px 28px}'
  + 'h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 6px;color:#3d444d}'
  + 'code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px;background:#f2f4f7;padding:2px 6px;border-radius:4px;word-break:break-all}'
  + '.muted{color:#656d76}.big{font-size:17px;font-weight:600}.ok{color:#1a7f37}.bad{color:#b42318}'
  + 'ol{padding-left:22px}li{margin:4px 0}a{color:#1f6feb}';

/** 邀请落地页：客人没装 DSH 也能打开，看的懂、复制得走（这是传播入口）。 */
function invitePage({ room, inviteToken, base }) {
  const deep = `dsh://agentdeck/join?room=${room.id}&t=${inviteToken}`;
  const active = (room.seats || []).filter((s) => !s.leftAt).length;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(room.name)} · 加入协同房间</title><style>${PAGE_CSS}</style></head><body><div class="card">
<h1>${esc(room.name)}</h1>
<div class="muted">邀请你带着自己的 Agent 进来一起干活 · 现有 ${active} 人 · 席位 ${room.maxSeats}</div>
<h2>第一步：装插件（DSH 里一行命令）</h2>
<p class="mono">dsh plugin add agentdeck-super</p>
<h2>第二步：点这个链接进房间</h2>
<p><a class="mono" href="${esc(deep)}">${esc(deep)}</a></p>
<p class="muted">链接打不开？在 DSH 里执行 <code>/deck</code> → 房间 → 粘贴邀请码：<span class="mono">${esc(inviteToken)}</span></p>
<h2>说明</h2>
<ol>
<li>你是客人，<b>不需要买授权</b>；房间是你朋友的额度在撑。</li>
<li>房间只同步「谁领了哪块活」和便签，不上传你的代码和文件。</li>
<li>你自己的 Agent（Claude Code / Codex / Gemini / DSH…）留在自己机器上跑。</li>
</ol>
<p class="muted">此页由 AgentDeck Relay 自动生成：${esc(base)}</p>
</div></body></html>`;
}

/** 首页：服务自述 + 怎么用（自建的人第一眼看这里）。 */
function landingPage({ base, rooms }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentDeck Relay</title><style>${PAGE_CSS}</style></head><body><div class="card">
<h1>AgentDeck Relay</h1>
<div class="muted">跨机器 / 跨人的协同中转 · 协议 ADBP v1 · 当前 ${rooms} 个房间</div>
<h2>这个服务干什么</h2>
<p>让两台机器、两个人的 Agent 进同一个房间：共享任务板、认领、回流、便签。<b>建房间要授权（房主付费），进房间不要授权（客人免费）。</b></p>
<h2>房主：建房间</h2>
<ol><li>在 DSH 里装插件：<span class="mono">dsh plugin add agentdeck-super</span></li>
<li>设置里把 relay 地址填成 <span class="mono">${esc(base)}</span></li>
<li><code>/deck</code> 页粘贴授权码 → <code>deck_room action=create</code></li></ol>
<h2>客人：进房间</h2>
<p>让房主把邀请链接发你，打开就是加入页；或用自己的 <code>deck_room action=join</code>，粘邀请码即可。</p>
<h2>运维</h2>
<p>健康检查：<a class="mono" href="/healthz">/healthz</a> · 数据目录只在服务器上，内容是事件流（标题/认领/便签），不含代码。</p>
</div></body></html>`;
}

function sendHtml(res, status, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function publicMember(seat) {
  return { seatId: seat.seatId, name: seat.name, petSkin: seat.petSkin || 'basic', role: seat.role || 'worker', joinedAt: seat.joinedAt };
}

// ── 服务器 ─────────────────────────────────────────────────────────────────

/**
 * 起一个 relay。
 * @param {{ port?:number, dataDir?:string, publicKeyB64Url?:string, now?:()=>number, host?:string, quiet?:boolean, publicUrl?:string }} opts
 * @returns {Promise<{ url:string, publicUrl:string, port:number, close:()=>Promise<void>, store:object }>}
 */
export async function startRelayServer(opts = {}) {
  const store = createStore(opts.dataDir || '.relay-data');
  const now = opts.now || (() => Date.now());
  const configuredPublicUrl = normalizePublicUrl(opts.publicUrl || process.env.NEXI_RELAY_PUBLIC_URL || '');
  // 公钥优先级：显式参数 > 环境变量 > 内置官方公钥。
  // 环境变量这条是给「自建 relay」用的：你用 tools/license-cli.mjs init 生成自己的
  // 密钥对后，把公钥丢进 AGENTDECK_LICENSE_PUBKEY，自建服务器就只认你自己发的码。
  const pubB64 = opts.publicKeyB64Url || String(process.env.AGENTDECK_LICENSE_PUBKEY || '').trim() || ISSUER_PUBLIC_SPKI_B64URL;
  const quiet = opts.quiet !== false;

  function verifyOwnerLicense(adsk) {
    if (!adsk) return { ok: false, reason: '建房间需要授权码（免费版请用本地房间）', tier: 'free' };
    const v = verifyLicense(adsk, { publicKeyB64Url: pubB64, now });
    if (!v.ok) return { ok: false, reason: v.reason, tier: 'free' };
    const ent = entitlements(v.tier);
    if (!ent.cloudRooms) return { ok: false, reason: `${ent.label}不含云房间（协作版起支持）`, tier: v.tier };
    // 授权里的 seats 是“这次实际买了多少席”，档位 maxSeats 是“这档最多能开到多少席”。
    // 房间必须按两者较小值执行，否则企业版只买 10 席也会被当成 200 席放行。
    const claimed = Math.floor(Number(v.claims?.seats));
    const maxSeats = Math.max(1, Math.min(
      Number.isFinite(claimed) && claimed > 0 ? claimed : ent.maxSeats,
      ent.maxSeats,
    ));
    return { ok: true, tier: v.tier, ent, claims: v.claims, maxSeats };
  }

  /** 跨域头：网页加入页和状态页都要跨域打这些接口，缺了浏览器直接挡。 */
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };

  /**
   * 托管 API 单例。惰性建：没装 lib/hosting 时 relay 照常只做房间转发。
   * 验签器直接复用 verifyLicense —— 服务端只认「公钥算出来的签名」，和房间授权同一把钥匙。
   */
  let hostingApiSingleton = null;
  function getHostingApi() {
    if (hostingApiSingleton) return hostingApiSingleton;
    try {
      hostingApiSingleton = createHostingApi({
        root: resolve(opts.dataDir || '.relay-data'),
        verify: (code) => {
          const v = verifyLicense(code, { publicKeyB64Url: pubB64, now });
          if (!v.ok) return { ok: false, reason: v.reason };
          return { ok: true, tier: v.tier, claims: v.claims };
        },
        now,
        log: (m) => { if (!quiet) console.log(`[hosting] ${m}`); },
      });
    } catch (err) {
      if (!quiet) console.log(`托管模块没加载（relay 只做房间转发）：${err?.message || err}`);
      hostingApiSingleton = null;
    }
    return hostingApiSingleton;
  }

  /** 找房间 + 校验同步令牌；返回 { room, seat } 或 { error } */
  function authorizeRoom(roomId, req, { allowInvite = false, queryToken = '' } = {}) {
    const room = store.load(roomId);
    if (!room) return { error: [404, { error: '房间不存在', code: 'room_not_found' }] };
    if (room.closedAt) return { error: [410, { error: '房间已关闭', code: 'room_closed' }] };
    const t = bearer(req) || queryToken;
    if (!t) return { error: [401, { error: '缺少令牌', code: 'no_token' }] };
    if (allowInvite && t === room.inviteToken) return { room, seat: null };
    if (t === room.hostToken) return { room, seat: room.seats.find((s) => s.seatId === room.hostSeatId) || null };
    const seat = room.seats.find((s) => s.syncToken === t);
    if (!seat) return { error: [401, { error: '令牌无效', code: 'bad_token' }] };
    return { room, seat };
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://relay.local');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/healthz') {
        return send(res, 200, {
          ok: true,
          service: 'agentdeck-relay',
          v: 1,
          rooms: store.list().length,
          ...(configuredPublicUrl ? { publicUrl: configuredPublicUrl } : {}),
        });
      }

      // 首页（自建的人第一眼看这里）与邀请落地页（客人没装 DSH 也能看懂）
    // ── 托管 API（1.11）：授权码换令牌、用量、云房间配额 ──────────────────
    // 挂在 relay 上而不是独立服务：自己搭 relay 的人一行就带上配额；
    // 托管方也只是同一份代码跑在公网。验签复用 lib/license.js，公钥支持环境变量覆盖。
    if (p.startsWith('/v1/') || p === '/v1') {
      try {
        const hostingApi = getHostingApi();
        if (hostingApi) {
          // 只有这几个路径归托管管，别把 /v1/rooms 这些既有房间路由抢走
          const HOSTING_PATHS = ['/v1/activate', '/v1/usage', '/v1/plans', '/v1/rooms/claim', '/v1/rooms/release'];
          const isHostingPath = HOSTING_PATHS.some((hp) => p === hp || p === `${hp}/`);
          if (isHostingPath) {
            let body = null;
            if (req.method === 'POST') body = await readBody(req);
            const out = hostingApi(req.method, p, body, req.headers);
            if (out) {
              res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', ...cors });
              res.end(JSON.stringify(out.json));
              return;
            }
          }
        }
      } catch (err) {
        log(`托管 API 出错：${err?.message || err}`);
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', ...cors });
        res.end(JSON.stringify({ ok: false, code: 'hosting_error', reason: '托管服务内部错误' }));
        return;
      }
    }

    if (req.method === 'GET' && p === '/') {
        const base = publicBase(req, `http://127.0.0.1:${server.address()?.port || 0}`, configuredPublicUrl);
        const roomId = String(url.searchParams.get('room') || '').trim();
        if (!roomId) return sendHtml(res, 200, landingPage({ base, rooms: store.list().filter((r) => !r.closedAt).length }));
        const room = store.load(roomId);
        if (!room) return sendHtml(res, 404, landingPage({ base, rooms: store.list().filter((r) => !r.closedAt).length }).replace('<h1>AgentDeck Relay</h1>', '<h1>房间不存在</h1><p class="bad">这个邀请对应的房间已经不在了，让房主重新发一次。</p>'));
        if (room.closedAt) return sendHtml(res, 410, landingPage({ base, rooms: 0 }).replace('<h1>AgentDeck Relay</h1>', '<h1>房间已关闭</h1><p class="bad">房主关掉了这个房间，让房主新建一个再邀请你。</p>'));
        const inviteToken = String(url.searchParams.get('t') || url.searchParams.get('token') || '').trim();
        // 邀请码不对就只给房名，不给码（避免拿到链接就永久可用）
        return sendHtml(res, 200, invitePage({
          room,
          inviteToken: inviteToken === room.inviteToken ? inviteToken : '',
          base,
        }));
      }

      // 建房间
      if (req.method === 'POST' && p === '/v1/rooms') {
        const body = await readBody(req);
        const lic = verifyOwnerLicense(bearer(req));
        if (!lic.ok) return send(res, 402, { error: lic.reason, code: 'license_required', tier: lic.tier });
        const owner = String(body.owner || lic.claims.sub || '房主');
        const owned = store.list().filter((r) => !r.closedAt && r.ownerKey === lic.claims.id).length;
        if (owned >= lic.ent.cloudRooms) {
          return send(res, 402, {
            error: `${lic.ent.label}最多 ${lic.ent.cloudRooms} 个云房间，已有 ${owned} 个（关闭旧的或升级到工作室版）`,
            code: 'room_quota',
          });
        }
        const id = randomUUID();
        const hostSeatId = randomUUID();
        const room = {
          id,
          name: String(body.name || '未命名房间').slice(0, 80),
          teamId: String(body.teamId || ''),
          createdAt: now(),
          owner,
          ownerKey: lic.claims.id,
          tier: lic.tier,
          maxSeats: lic.maxSeats,
          inviteToken: token(),
          hostToken: token(),
          hostSeatId,
          seats: [
            {
              seatId: hostSeatId,
              name: owner,
              petSkin: String(body.petSkin || 'basic'),
              role: 'owner',
              syncToken: token(),
              joinedAt: now(),
            },
          ],
          events: [],
          seq: 0,
        };
        store.save(room);
        const hostSeat = room.seats[0];
        if (!quiet) console.log(`[relay] 建房 ${room.name} (${id}) 房主=${owner} 档位=${lic.tier}`);
        return send(res, 201, {
          roomId: id,
          name: room.name,
          inviteToken: room.inviteToken,
          inviteUrl: `dsh://agentdeck/join?room=${id}&t=${room.inviteToken}`,
          // 网页版邀请：没装 DSH 的人也能打开、看得懂、复制得走（传播靠它）
          inviteWebUrl: `${publicBase(req, '', configuredPublicUrl) || ''}/?room=${id}&t=${room.inviteToken}`,
          syncToken: hostSeat.syncToken,
          // 房主专用令牌：关房要用它（只发给建房间的人，不随邀请外泄）
          hostToken: room.hostToken,
          seatId: hostSeatId,
          seats: room.maxSeats,
          expiresAt: lic.claims.exp * 1000,
        });
      }

      // 进房间（客人免费）
      const mJoin = /^\/v1\/rooms\/([\w-]+)\/join$/.exec(p);
      if (req.method === 'POST' && mJoin) {
        const body = await readBody(req);
        const room = store.load(mJoin[1]);
        if (!room) return send(res, 404, { error: '房间不存在', code: 'room_not_found' });
        if (room.closedAt) return send(res, 410, { error: '房间已关闭', code: 'room_closed' });
        if (String(body.inviteToken || bearer(req)) !== room.inviteToken) {
          return send(res, 403, { error: '邀请已失效或不是这个房间的邀请', code: 'bad_invite' });
        }
        const active = room.seats.filter((s) => !s.leftAt);
        if (active.length >= room.maxSeats) {
          return send(res, 409, { error: `房间满员（上限 ${room.maxSeats} 个席位）`, code: 'room_full' });
        }
        const member = body.member || {};
        const seat = {
          seatId: randomUUID(),
          name: String(member.name || '客人').slice(0, 40),
          petSkin: String(member.petSkin || 'basic').slice(0, 40),
          role: String(member.role || 'worker').slice(0, 20),
          syncToken: token(),
          joinedAt: now(),
        };
        room.seats.push(seat);
        pushEvent(room, { kind: 'presence/join', payload: { seatId: seat.seatId, name: seat.name, petSkin: seat.petSkin }, seatId: seat.seatId });
        store.save(room);
        if (!quiet) console.log(`[relay] 进房 ${seat.name} → ${room.name}（${active.length + 1}/${room.maxSeats}）`);
        return send(res, 201, {
          seatId: seat.seatId,
          syncToken: seat.syncToken,
          roomId: room.id,
          name: room.name,
          // 房主小组 id 一起发下去：客人本机要靠它复刻同一个小组，
          // 否则远端任务拉下来无处可落（"team not found"，板子永远空的）
          teamId: room.teamId || '',
          maxSeats: room.maxSeats,
          members: room.seats.filter((s) => !s.leftAt).map(publicMember),
        });
      }

      // 追加事件
      const mEvents = /^\/v1\/rooms\/([\w-]+)\/events$/.exec(p);
      if (req.method === 'POST' && mEvents) {
        const body = await readBody(req);
        const auth = authorizeRoom(mEvents[1], req);
        if (auth.error) return send(res, auth.error[0], auth.error[1]);
        const list = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
        for (const ev of list) pushEvent(auth.room, ev, auth.seat?.seatId);
        store.save(auth.room);
        return send(res, 200, { seq: auth.room.seq, accepted: list.length });
      }

      // 拉事件（长轮询）
      if (req.method === 'GET' && mEvents) {
        const auth = authorizeRoom(mEvents[1], req, { queryToken: url.searchParams.get('token') || '' });
        if (auth.error) return send(res, auth.error[0], auth.error[1]);
        const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0));
        const waitMs = Math.min(25000, Math.max(0, Math.floor(Number(url.searchParams.get('wait')) || 0)) * 1000);
        const deadline = now() + waitMs;
        let room = auth.room;
        while (room.events.filter((e) => e.seq > since).length === 0 && now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.min(500, Math.max(50, deadline - now()))));
          room = store.load(room.id) || room;
          if (room.closedAt) break;
        }
        const events = room.events.filter((e) => e.seq > since);
        return send(res, 200, {
          events,
          seq: room.seq,
          members: room.seats.filter((s) => !s.leftAt).map(publicMember),
          closed: Boolean(room.closedAt),
        });
      }

      // 房间概况
      const mRoom = /^\/v1\/rooms\/([\w-]+)$/.exec(p);
      if (req.method === 'GET' && mRoom) {
        const auth = authorizeRoom(mRoom[1], req, { allowInvite: true, queryToken: url.searchParams.get('token') || '' });
        if (auth.error) return send(res, auth.error[0], auth.error[1]);
        const room = auth.room;
        return send(res, 200, {
          roomId: room.id,
          name: room.name,
          teamId: room.teamId || '',
          owner: room.owner,
          createdAt: room.createdAt,
          closed: Boolean(room.closedAt),
          maxSeats: room.maxSeats,
          seq: room.seq,
          members: room.seats.filter((s) => !s.leftAt).map(publicMember),
          eventCount: room.events.length,
        });
      }

      // 关房（房主）
      const mClose = /^\/v1\/rooms\/([\w-]+)\/close$/.exec(p);
      if (req.method === 'POST' && mClose) {
        const auth = authorizeRoom(mClose[1], req);
        if (auth.error) return send(res, auth.error[0], auth.error[1]);
        if (bearer(req) !== auth.room.hostToken) return send(res, 403, { error: '只有房主能关房', code: 'not_host' });
        auth.room.closedAt = now();
        pushEvent(auth.room, { kind: 'room/closed', payload: {} });
        store.save(auth.room);
        return send(res, 200, { ok: true, closedAt: auth.room.closedAt });
      }

      // 离开
      const mLeave = /^\/v1\/rooms\/([\w-]+)\/leave$/.exec(p);
      if (req.method === 'POST' && mLeave) {
        const auth = authorizeRoom(mLeave[1], req);
        if (auth.error) return send(res, auth.error[0], auth.error[1]);
        if (!auth.seat) return send(res, 400, { error: '房主不能离开房间，请用关房', code: 'host_cannot_leave' });
        auth.seat.leftAt = now();
        pushEvent(auth.room, { kind: 'presence/leave', payload: { seatId: auth.seat.seatId, name: auth.seat.name } });
        store.save(auth.room);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: '没有这个接口', code: 'not_found' });
    } catch (err) {
      return send(res, 400, { error: err && err.message ? err.message : String(err), code: 'bad_request' });
    }
  };

  function pushEvent(room, ev, fallbackSeatId = null) {
    const kind = String(ev && ev.kind ? ev.kind : 'unknown').slice(0, 40);
    room.seq += 1;
    room.events.push({
      seq: room.seq,
      at: now(),
      kind,
      seatId: String(ev?.seatId || fallbackSeatId || ''),
      payload: ev && typeof ev.payload === 'object' && ev.payload ? ev.payload : {},
    });
    if (room.events.length > EVENT_LIMIT) room.events.splice(0, room.events.length - EVENT_LIMIT);
    return room.seq;
  }

  // TLS：给了证书就起 HTTPS，否则起 HTTP。
  // 为什么必须支持：公网部署不带 TLS 等于把房间内容裸奔在网络上。
  // 以前只能在前面加一层反代，那对自建的用户来说是个额外门槛。
  const tlsCert = opts.tlsCert || process.env.NEXI_RELAY_TLS_CERT || '';
  const tlsKey = opts.tlsKey || process.env.NEXI_RELAY_TLS_KEY || '';
  const useTls = Boolean(tlsCert && tlsKey);
  let server;
  if (useTls) {
    const { readFileSync: rf } = await import('node:fs');
    server = createSecureServer(
      { cert: rf(resolve(String(tlsCert)), 'utf8'), key: rf(resolve(String(tlsKey)), 'utf8') },
      handler,
    );
  } else {
    server = createServer(handler);
  }

  await new Promise((resolvePromise, reject) => {
    const onError = (err) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.off('error', onError);
      resolvePromise();
    });
  });
  const port = server.address().port;
  const scheme = useTls ? 'https' : 'http';
  return {
    // 注意：这里必须用 server.address().port —— 传 --port 0（自动挑端口）时，
    // opts.port 是 0，照着它拼 URL 会得到一个连不上的 http://127.0.0.1:0。
    // 调用方（测试脚本 / 启动脚本）都靠这个 url 去连，拼错就是死等。
    url: `${scheme}://${opts.host || '127.0.0.1'}:${port}`,
    publicUrl: configuredPublicUrl,
    tls: useTls,
    host: opts.host || '127.0.0.1',
    port,
    store,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && /relay-server\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const port = Number(arg('--port', 8787));
  const dataDir = arg('--data', '.relay-data');
  // 关键：**必须能绑到对外的地址**，否则这个 relay 只能本机访问，
  // "不同电脑之间协作"就根本无从谈起。
  // 但默认值保持 127.0.0.1：不打招呼就把服务暴露到局域网/公网是危险的，
  // 想让别的电脑连，显式加 --host 0.0.0.0（CLI 会打印别的电脑该填哪个地址）。
  const host = arg('--host', '127.0.0.1');
  // 给了证书就起 HTTPS —— 公网部署必须带这个，否则内容在网络上是明文。
  const tlsCert = arg('--tls-cert', '');
  const tlsKey = arg('--tls-key', '');
  const publicUrl = arg('--public-url', process.env.NEXI_RELAY_PUBLIC_URL || '');
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    console.error('--tls-cert 和 --tls-key 必须成对给（证书 + 私钥）。');
    process.exit(1);
  }
  const relay = await startRelayServer({ port, host, dataDir, quiet: false, tlsCert, tlsKey, publicUrl });
  const shown = relay.url.replace('127.0.0.1', host === '0.0.0.0' ? '<本机IP>' : host);
  console.log(`AgentDeck Relay 已启动：${shown}`);
  console.log(`  监听：${host}:${relay.port}${host === '0.0.0.0' ? '（所有网卡，别的电脑用这台机器的 IP 访问）' : ''}`);
  console.log(`  房间数据目录：${resolve(dataDir)}`);
  if (relay.publicUrl) {
    console.log(`  公网地址：${relay.publicUrl}`);
    console.log('  邀请链接会使用这个公网地址（必须真的能回源到本 relay）。');
  }
  console.log('  建房间需要授权码；进房间凭邀请，不需要授权。Ctrl+C 停止。');
  if (host === '0.0.0.0') {
    const nets = networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) {
          console.log(`  → 别的电脑填这个：http://${i.address}:${relay.port}`);
        }
      }
    }
    console.log('  ⚠️ 公网部署务必放在 HTTPS 反代后面（relay 自己只讲 HTTP）。');
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.log('\n正在关闭…');
      await relay.close();
      process.exit(0);
    });
  }
}
