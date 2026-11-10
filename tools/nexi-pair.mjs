#!/usr/bin/env node
/**
 * tools/nexi-pair.mjs —— 真机配对：把"两台设备"的测试动作变成两行命令
 *
 * 为什么还要这个：nexi-lan.mjs 解决了"我该填哪个地址"，但真机测试还是有一堆手抄动作
 * （起 relay、发码、建房间、把链接传给对面、对面进房、双向往返验证）。
 * 中间任何一步抄错，用户都会以为是插件坏了。
 *
 * 这个脚本把角色拆成两个明确的口令：
 *
 *   第一台设备（房主）：
 *     node tools/nexi-pair.mjs host
 *     → 它自己起 relay、发码、建房间，然后打印**一段可以整段复制发给对面的文本**
 *
 *   第二台设备（客人）：
 *     node tools/nexi-pair.mjs guest --invite "<粘贴刚才那段>"
 *     → 它自己进房间、发一条测试消息、把结果打印出来
 *
 *   然后两边各自跑一次核对：
 *     node tools/nexi-pair.mjs check
 *     → 看房间里有谁、有几条消息、任务板是否同步
 *
 * 边界（写清楚）：
 *   - host 必须一直开着（relay 跑在它进程里）。关掉 = 房间没了。
 *   - guest 不需要授权码。
 *   - 目前 room 工具本身还是没有 relay 的内嵌模式，所以 host 这里会真起一个子进程。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { hostname, networkInterfaces, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

import { createHub } from '../lib/hub.js';
import { encodeLicense, TIERS } from '../lib/license.js';
import {
  normalizePublicUrl,
  startTunnel,
  verifyPublicHealth,
  tunnelInstallHint,
} from './nexi-tunnel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const argv = process.argv.slice(2);
const ROLE = argv[0] || 'help';

function hasFlag(name) {
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
}

function flagValue(name, fallback = '') {
  const eq = `${name}=`;
  const withEq = argv.find((a) => a.startsWith(eq));
  if (withEq) return withEq.slice(eq.length);
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

/**
 * 解析真机配对专用测试授权。
 *
 * 这不是生产发码：每次都临时生成一对 Ed25519 密钥，整个房间生命期结束就失效。
 * 它的用途是让物理设备测试能按 2/5/10/20/50 席逐级扩容，而不是所有测试都被
 * 默认的 plus/8 席卡死。
 */
export function pairSeatConfig(tierRaw = 'plus', seatsRaw = '') {
  const tier = String(tierRaw || 'plus').trim().toLowerCase();
  const def = TIERS[tier];
  if (!def) {
    return {
      ok: false,
      reason: `档位不对：${tierRaw || '(空)'}；可选 ${Object.keys(TIERS).join(' / ')}`,
    };
  }
  const maxSeats = Math.max(1, Math.floor(Number(def.maxSeats) || 1));
  const raw = String(seatsRaw ?? '').trim();
  if (!raw) return { ok: true, tier, label: def.label, seats: maxSeats, maxSeats };
  const seats = Number(raw);
  if (!Number.isInteger(seats) || seats < 1) {
    return { ok: false, reason: `--seats 必须是大于 0 的整数，收到 "${raw}"` };
  }
  if (seats > maxSeats) {
    return {
      ok: false,
      reason: `--seats ${seats} 超过${def.label}上限 ${maxSeats}；要更多席位请升级档位或改用企业控制面`,
    };
  }
  return { ok: true, tier, label: def.label, seats, maxSeats };
}

/** 把邀请链接的 origin 换成公网 origin；保留 room/t 参数。 */
export function publicInvite(localInvite, publicUrl) {
  const base = String(publicUrl || '').replace(/\/+$/, '');
  if (!base) return String(localInvite || '');
  try {
    const source = new URL(String(localInvite || ''));
    const room = source.searchParams.get('room') || '';
    const token = source.searchParams.get('t') || source.searchParams.get('token') || '';
    if (room && token) return `${base}/?room=${encodeURIComponent(room)}&t=${encodeURIComponent(token)}`;
  } catch {
    // 不是合法 URL 时继续尝试从文本里抠 room/t
  }
  const room = /[?&]room=([\w-]+)/.exec(String(localInvite || ''))?.[1] || '';
  const token = /[?&]t=([\w-]+)/.exec(String(localInvite || ''))?.[1] || '';
  return room && token ? `${base}/?room=${room}&t=${token}` : String(localInvite || '');
}

/**
 * 配对指引里给用户敲的命令前缀。
 *
 * 必须是 npx 全命令：第二台设备上只有 Node，没有本仓源码。
 * 真机踩过 —— 房主打印的是 `node tools/nexi-pair.mjs guest ...`，
 * 对面照着敲直接 "Cannot find module"，而房主这边一切正常，
 * 于是两边都以为是对方网络的问题。
 */
export const PAIR_CLI = 'npx -y agentdeck-super@latest pair';

/**
 * 房主屏幕上那段"发给对面"的文本。
 *
 * 只给**一条**能直接跑的命令。以前给三条（存文件 / 环境变量 / 直接贴），
 * 用户不知道挑哪条；而 cmd 里的 `set X=a&b` 还会把链接从 & 处截断，
 * 所谓"次稳"其实不稳。现在主路径一条，失败再给一条退路。
 */
export function buildInviteBlock({ invite, cli = PAIR_CLI } = {}) {
  const link = String(invite || '');
  return [
    '===== 把下面这一行发到第二台设备（原样粘贴，别改） =====',
    `${cli} guest --invite "${link}"`,
    '',
    '那台设备不用装本项目源码，也不要授权码，有 Node 就能跑。',
    '想把席位名写成"张三-设计部"：在那一行末尾加 --name "张三-设计部"。',
    '',
    '万一对面粘进去报错（少数终端会把链接里的 & 当分隔符）：',
    '  1) 把上面那条链接单独存成 invite.txt（记事本，只放链接，别加字）',
    `  2) 在那台设备上跑：${cli} guest --invite-file invite.txt`,
    '===== 复制结束 =====',
  ].join('\n');
}

/** 配对完成后的下一步提示，同样是 npx 全命令。 */
export function buildPairHints({ cli = PAIR_CLI } = {}) {
  return [
    '等第二台设备那边跑完之后，两边都跑一次：',
    `  ${cli} check`,
    '',
    '要验真实任务交付（可选，但这是唯一能证明"任务真的跨机了"的步骤）：',
    `  ${cli} task add --title "跨机验收任务" --acceptance "乙机看到并领取"`,
    `  两边各跑一次：${cli} sync`,
    '',
    '最后回你自己常用的 Agent 里问一句「房间里有谁？」——',
    '它应该答出「成员 2 人」。命令行通了不等于 Agent 通了，这一步才是。',
  ];
}

/** 从 team_board 的人话输出里取小组 id；取不到返回空串。 */
function teamIdFromText(text) {
  const m = /已创建小组\s+([A-Za-z0-9:_-]+)/.exec(String(text || ''));
  return m ? m[1] : '';
}

/** 配对专用：房主先建一个小组，再把这个小组绑进房间。 */
async function ensurePairTeam(hub) {
  const board = hub.tools.get('team_board');
  if (!board || typeof board.execute !== 'function') {
    return { ok: false, teamId: '', reason: '任务板工具没有注册' };
  }
  const out = textOf(await board.execute(
    { action: 'create', name: '真机配对小组', goal: '两台设备真实同步任务，验收跨机协作' },
    { hub: true },
  ));
  const teamId = teamIdFromText(out);
  return teamId
    ? { ok: true, teamId, out }
    : { ok: false, teamId: '', out, reason: '小组创建输出里没有 teamId' };
}

/**
 * 本机最可能被对面连上的地址。
 *
 * 真机踩过的坑：这里以前只排除回环，于是选到了 `198.18.0.1`（Meta）这种
 * **跑在 VPN/虚拟网络里的地址** —— 它在本机通，但对面那台设备连不上。
 * 现在和 tools/nexi-lan.mjs 用同一套判定：真实局域网网卡优先，
 * 虚拟网卡（VMware/VirtualBox/WSL/Docker/Hyper-V/Meta 等）排在后面。
 */
function bestAddress() {
  const cands = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4') continue;
      if (info.address.startsWith('127.')) continue;
      // Meta 是 Windows 上 VPN/隧道类网卡的常见名字，要一起排除
      const virt = /vmnet|vbox|wsl|docker|hyper-v|virtual|meta|tun|tap|tailscale|zerotier/i.test(name);
      cands.push({ address: info.address, iface: name, virt });
    }
  }
  // 真实网卡优先；同为真实/虚拟时按地址排序，保证结果稳定（同一台机器每次选同一个）
  cands.sort((a, b) => Number(a.virt) - Number(b.virt) || a.address.localeCompare(b.address));
  const chosen = cands[0] || null;
  return chosen;
}

/** 选到虚拟网卡时明确警告，别让用户以为配对好了。 */
function addressWarning(best) {
  if (!best) {
    return '没找到任何局域网地址：先接上 WiFi 或网线，否则别的设备连不上。';
  }
  if (best.virt) {
    return [
      `只找到虚拟网卡地址（${best.iface}）—— 别的设备**大概率连不上它**。`,
      '建议先接上真实 WiFi/网线，再跑一次本命令；',
      '或者用 node tools/nexi-lan.mjs 看看有没有别的可用地址。',
    ].join('\n');
  }
  return '';
}

/**
 * 数据落在哪。
 *
 * 默认是插件目录下的 `.nexi-pair`，真机直接跑就行。
 * `NEXI_PAIR_DIR` 只给自动化测试/同机双身份模拟用：把 host 和 guest
 * 各自的授权、任务板、房间会话彻底分开，避免「同一台机器共用一份状态」
 * 把跨机问题掩盖掉。
 */
const STATE_DIR = process.env.NEXI_PAIR_DIR
  ? resolve(String(process.env.NEXI_PAIR_DIR))
  : join(PKG, '.nexi-pair');
const STATE_FILE = join(STATE_DIR, 'state.json');
const WORK_DIR = join(STATE_DIR, 'work');
/** 授权根：必须和 withHub 里传给 licenseRoot 的路径**完全一致**。 */
const LIC_DIR = join(STATE_DIR, 'lic');
/**
 * 机级状态根（和 lib 里的 globalStateRoot 保持一致）。
 *
 * 配对不是为了给命令行看个热闹：**配完这台的 Agent 也得进同一间屋**。
 * 所以房间会话与小组板写机级目录 —— 用户在自己项目里问"房间里有谁"，
 * Agent 立刻答得上来。以前写进 `.nexi-pair/`：命令说配对成功，
 * Agent 那边却说"还没配置 relay 地址"（真机踩到）。
 *
 * 自动化测试要"同机模拟两台"，靠两个变量分开：
 *   NEXI_PAIR_HOME  这台"设备"的家目录（等价宿主那边的 DSH_HOME）
 *   NEXI_PAIR_DIR   配对自己的状态（授权、invite、中转数据）
 * 只给 NEXI_PAIR_DIR 时，机级根收进配对目录里，绝不碰真实 ~/.dsh ——
 * 这条**优先于** DSH_HOME：否则"同机两台"会共用一个机级根，测出来的还是单机。
 */
const HOME_DIR = process.env.NEXI_PAIR_HOME
  || (process.env.NEXI_PAIR_DIR
    ? join(STATE_DIR, 'home')
    : (process.env.DSH_HOME || join(homedir(), '.dsh')));
/** 和 lib 里 globalStateRoot 完全同一个算法，否则"配对写的"和"Agent 读的"不是一处。 */
const DEVICE_ROOT = join(HOME_DIR, 'agentdeck-super');

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return {};
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

async function withHub(fn) {
  mkdirSync(WORK_DIR, { recursive: true });
  const hub = await createHub({
    workspace: WORK_DIR,
    // 机级目录：配完这台设备，它的 Agent 就能看见同一个小组、同一间房。
    // （NEXI_PAIR_DIR 只管配对自己的状态；机级根由 DEVICE_ROOT 决定，见文件头。）
    boardRoot: DEVICE_ROOT,
    roomRoot: join(DEVICE_ROOT, 'room'),
    // 必须和写授权码用的 LIC_DIR 是同一个路径，否则"激活了却还说免费版"
    licenseRoot: LIC_DIR,
    onLog: () => {},
  });
  try {
    return await fn(hub);
  } finally {
    try { await hub.close(); } catch { /* 关不掉不影响结论 */ }
  }
}

/** 起 relay 子进程，等它报出地址。 */
function startRelay(port, dataDir, { host = '0.0.0.0', publicUrl = '' } = {}) {
  const args = [
    join(PKG, 'tools', 'relay-server.mjs'),
    '--port', String(port), '--host', host, '--data', dataDir,
  ];
  if (publicUrl) args.push('--public-url', publicUrl);
  const child = spawn(process.execPath, [
    ...args,
  ], {
    cwd: PKG,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => {
    err += d.toString();
    out += d.toString();
  });
  child.on('error', (e) => {
    err += `${e?.message || e}\n`;
    out += `${e?.message || e}\n`;
  });
  return { child, get output() { return out; }, get error() { return err; } };
}

async function waitRelay(relay, ms = 30000, preferredPort = 0) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (relay.child.exitCode !== null) return 0;
    // relay 在 listen 成功之后才会打印这行。先读启动确认，别先做网络探测：
    // Windows 上对尚未监听的端口 fetch 偶发会拖过 AbortSignal 的超时，
    // 导致 host 明明已经起来却卡在“正在起中继…”。
    const ready = /AgentDeck Relay 已启动：https?:\/\/[^\s:]+:(\d{2,5})/.exec(relay.output);
    if (ready) return Number(ready[1]);
    await new Promise((r) => setTimeout(r, 100));
  }
  // 极少数情况下输出被宿主吞掉；最后再用本机地址做一次短探测。
  if (preferredPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${preferredPort}/healthz`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return preferredPort;
    } catch {
      // 没有输出且探测失败，按启动失败处理。
    }
  }
  return 0;
}

// ── host：第一台设备 ─────────────────────────────────────────────────────

async function cmdHost() {
  const portRaw = String(flagValue('--port', 8787) ?? 8787).trim();
  const requestedPort = portRaw === '' ? 8787 : Number(portRaw);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    console.log(`端口不合法：${portRaw}（应为 0-65535，0 表示自动挑一个空闲端口）`);
    process.exitCode = 1;
    return;
  }
  const seatCfg = pairSeatConfig(flagValue('--tier', 'plus'), flagValue('--seats', ''));
  if (!seatCfg.ok) {
    console.log(seatCfg.reason);
    process.exitCode = 1;
    return;
  }
  const publicUrlRaw = String(flagValue('--public-url', '') || '').trim();
  const tunnelArg = hasFlag('--tunnel')
    ? (String(flagValue('--tunnel', '') || '').trim() || 'auto')
    : '';
  const autoPublic = hasFlag('--public');
  const publicMode = Boolean(publicUrlRaw || tunnelArg || autoPublic);
  const best = bestAddress();

  let explicitPublic = '';
  if (publicUrlRaw) {
    try {
      explicitPublic = normalizePublicUrl(publicUrlRaw);
    } catch (err) {
      console.log(`公网地址不合法：${err?.message || err}`);
      process.exitCode = 1;
      return;
    }
  }
  if (explicitPublic && tunnelArg) {
    console.log('--public-url 和 --tunnel 只能选一个：已有反代/隧道地址就别再启动第二条隧道。');
    process.exitCode = 1;
    return;
  }
  if (!publicMode && !best) {
    console.log('找不到可用的局域网地址。先接上 WiFi 或网线，或者用 --public 走公网入口。');
    process.exitCode = 1;
    return;
  }

  // 公网模式优先绑回环：外面由 cloudflared/localtunnel/反代进来。
  // 局域网模式仍绑 0.0.0.0，否则第二台设备连不上。
  const relayHost = publicMode ? '127.0.0.1' : '0.0.0.0';
  const lanRelayUrl = best ? `http://${best.address}:${requestedPort}` : '';
  const localDisplay = `http://127.0.0.1:${requestedPort}`;
  const publicProvider = explicitPublic ? 'external' : (tunnelArg || (autoPublic ? 'auto' : ''));

  console.log('Nexi 灵犀 · 真机配对（第一步：房主）\n');
  if (best) console.log(`本机局域网：${best.address}（${best.iface}）`);
  if (publicMode) {
    console.log(`公网模式：${explicitPublic || `等待 ${publicProvider} 分配地址`}`);
    console.log(`本机中继将绑到：${localDisplay}（由隧道/反代回源）\n`);
  } else {
    console.log(`中继将绑到：${lanRelayUrl}\n`);
    const warn = addressWarning(best);
    if (warn) {
      console.log('!! 注意：');
      console.log(`   ${warn.split('\n').join('\n   ')}`);
      console.log('');
    }
  }
  console.log(`测试授权：${seatCfg.label} / ${seatCfg.seats} 席（仅本次配对，非生产授权）`);
  console.log(`席位口径：房主占 1 席，最多还可加入 ${Math.max(0, seatCfg.seats - 1)} 台设备\n`);

  // 1) 造临时签发密钥 + 签一张协作版（跨机房间是付费档）
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const code = encodeLicense({
    v: 1, id: `lic_pair_${Math.random().toString(16).slice(2, 8)}`, tier: seatCfg.tier,
    sub: '真机配对', iat: nowSec, exp: nowSec + 7 * 86400, seats: seatCfg.seats, skins: [],
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;

  let relay = null;
  let tunnel = null;
  let publicBase = explicitPublic;
  let shuttingDown = false;

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (tunnel) {
      try { await tunnel.stop(); } catch { /* 清理失败不影响退出 */ }
      tunnel = null;
    }
    if (relay?.child) {
      try { relay.child.kill(); } catch { /* 已经退出 */ }
    }
  };

  const stopWithState = async () => {
    await cleanup();
    try {
      writeState({ role: 'host-stop', relayUrl: '', localRelayUrl: '', invite: '' });
    } catch { /* 状态写不进去不影响关闭 */ }
  };

  // 2) 起 relay
  console.log('正在起中继…');
  relay = startRelay(requestedPort, join(STATE_DIR, 'relay-data'), {
    host: relayHost,
    publicUrl: explicitPublic,
  });
  const realPort = await waitRelay(relay, 15000, requestedPort);
  if (!realPort) {
    console.log('中继没起来。输出：');
    console.log(relay.output.slice(0, 800));
    await cleanup();
    process.exitCode = 1;
    return;
  }
  const localRelayUrl = `http://127.0.0.1:${realPort}`;
  const displayRelay = publicMode ? localRelayUrl : lanRelayUrl.replace(`:${requestedPort}`, `:${realPort}`);
  console.log(`中继已就绪：${displayRelay}\n`);

  try {
    // 3) 公网入口：要么验证已有反代，要么启动隧道；没验证成功绝不打印邀请
    if (publicMode) {
      if (!explicitPublic) {
        console.log(`正在启动公网隧道（${publicProvider}）…`);
        tunnel = await startTunnel({
          provider: publicProvider,
          port: realPort,
          host: '127.0.0.1',
          timeoutMs: 90000,
          log: (m) => console.log(`  ${m}`),
        });
        if (!tunnel.ok) {
          console.log(`公网隧道没起来：${tunnel.reason || '未知原因'}`);
          if (Array.isArray(tunnel.failures)) {
            for (const f of tunnel.failures) {
              console.log(`  · ${f.provider}: ${f.reason}`);
              if (f.tail) console.log(`    ${String(f.tail).split('\n').slice(-4).join('\n    ')}`);
            }
          }
          console.log('');
          console.log(tunnelInstallHint());
          await cleanup();
          process.exitCode = 1;
          return;
        }
        publicBase = tunnel.url;
        console.log(`隧道已分配：${publicBase}（${tunnel.provider}）`);
      }

      const verified = await verifyPublicHealth(publicBase, { timeoutMs: 30000 });
      if (!verified.ok) {
        console.log(`公网入口不可达：${verified.reason || publicBase}`);
        console.log('没有让 /healthz 真的返回 200，不能把这条邀请当成可用链接。');
        await cleanup();
        process.exitCode = 1;
        return;
      }
      console.log(`公网探活通过：${publicBase}/healthz\n`);
    }

    // 4) 激活 + 建房间。建房走本机 relay，邀请再换成对面能连到的 origin。
    //
    // 局域网模式下这个 origin 必须是局域网地址：relay 是用 127.0.0.1 建的房，
    // 它生成的网页邀请就带着 127.0.0.1。对面拿到它连的是**自己**的回环 ——
    // 永远连不上，而且报错长得像"房间不存在"。同机双实例测不出来，
    // 因为那台机器上 127.0.0.1 恰好就是房主。
    const lanBase = best ? `http://${best.address}:${realPort}` : '';
    const room = await withHub(async (hub) => {
      // 授权要写到 licenseRoot 下面（不是工作区）—— 写错地方就会出现
      // "明明激活了却说我是免费版"（真机踩到过这个）
      mkdirSync(join(LIC_DIR, '.agentdeck', 'license'), { recursive: true });
      writeFileSync(join(LIC_DIR, '.agentdeck', 'license', 'key.txt'), code, 'utf8');
      // 跨机任务要落到同一个小组里。以前这里只建房不建组，guest 进房后
      // 没有 teamId 可复刻，sync 会"成功"但任务板永远是空的。
      const team = await ensurePairTeam(hub);
      const createArgs = { action: 'create', name: '真机配对房间', relayUrl: localRelayUrl };
      if (team.ok) createArgs.teamId = team.teamId;
      const out = textOf(await hub.tools.get('deck_room').execute(createArgs, { hub: true }));
      // 邀请优先用**网页加入页**形态（带 http 地址）：
      //   · guest 拿到它就能自己知道中继在哪，不用再手工填地址
      //   · dsh:// 深链里没有地址，跨设备时 guest 无从连
      // 真机踩过：只给 dsh:// 深链 → guest 报"没有配置 relay 地址"，白跑一轮。
      const webInvite = (out.match(/https?:\/\/[^\s]+\?room=[^\s]+/) || [])[0] || '';
      const deepInvite = (out.match(/dsh:\/\/agentdeck\/join\?[^\s]+/) || [])[0] || '';
      // 都没有就自己拼一条：relay 地址 + room + token（这两样建房间的返回值里一定有）
      const roomIdM = /room[=:]?\s*([0-9a-f-]{8,})/i.exec(out);
      const tokenM = /(?:t=|邀请码[：:]\s*)([\w-]{8,})/.exec(out);
      const synthesized = roomIdM && tokenM && !webInvite
        ? `${localRelayUrl}/?room=${roomIdM[1]}&t=${tokenM[1]}`
        : '';
      const localInvite = webInvite || synthesized || deepInvite;
      // 公网优先；没有公网就换成局域网地址（不是留着 127.0.0.1）。
      const invite = publicInvite(localInvite, publicBase || lanBase);
      const roomId = (out.match(/room[=:]?\s*([0-9a-f-]{8,})/i) || [])[1] || '';
      return { out, invite, localInvite, roomId, webInvite, deepInvite, team };
    });

    if (!room.invite) {
      console.log('房间没建起来。原始输出：');
      console.log(room.out.slice(0, 800));
      await cleanup();
      process.exitCode = 1;
      return;
    }

    const inviteBase = publicBase || lanBase;
    writeState({
      role: 'host',
      relayUrl: publicBase || inviteBase,
      localRelayUrl,
      relayPort: realPort,
      publicUrl: publicBase || '',
      tunnelProvider: tunnel?.provider || (explicitPublic ? 'external' : ''),
      invite: room.invite,
      localInvite: room.localInvite || '',
      roomId: room.roomId,
      teamId: room.team?.teamId || '',
      pubB64,
      tier: seatCfg.tier,
      seats: seatCfg.seats,
      pidHost: process.pid,
    });

    // 5) 打印一段可以整段复制发给对面的文本
    console.log(`中继地址：${inviteBase}`);
    console.log(`席位：${seatCfg.seats}（房主 1 席，可加入 ${Math.max(0, seatCfg.seats - 1)} 台客人设备）`);
    console.log('');
    console.log(buildInviteBlock({ invite: room.invite }));
    console.log('');
    console.log('房间已建好，中继在这个进程里跑着 —— 别关这个窗口。');
    if (publicBase) console.log(`公网入口已验证：${publicBase}（${tunnel?.provider || 'external'}）。`);
    if (room.team?.ok) console.log(`跨机小组已建好：${room.team.teamId}`);
    else console.log(`跨机小组没建起来（任务同步会受限）：${room.team?.reason || '未知原因'}`);
    console.log(buildPairHints().join('\n'));
    console.log('');
    console.log('按 Ctrl-C 结束（房间和隧道一起关闭）。');
  } catch (err) {
    console.log(`房主模式出错：${err?.stack || err}`);
    await cleanup();
    process.exitCode = 2;
    return;
  }

  const onSignal = () => {
    void stopWithState().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await new Promise(() => {});
}

// ── guest：第二台设备 ────────────────────────────────────────────────────

async function cmdGuest() {
  /**
   * 取邀请链接。三种来源，按优先级：
   *   1) --invite "<链接>"
   *   2) 环境变量 NEXI_INVITE（**真机推荐** —— 绕开 shell 转义）
   *   3) --invite-file <路径>（把链接存成文件再读）
   *
   * 为什么要有后两种：邀请链接里含 `&`，在 cmd/PowerShell 里是元字符。
   * 真机踩过 —— 双引号一被 shell 吃掉，`&t=...` 就成了另一条命令，
   * 于是 token 变空、报"邀请已失效"。报错看着像插件坏了，其实是 shell 干的。
   */
  const inviteFile = String(flagValue('--invite-file', '') || '').trim();
  let invite = String(flagValue('--invite', '') || '').trim();
  if (!invite && inviteFile) {
    try {
      invite = readFileSync(resolve(inviteFile), 'utf8').trim();
    } catch (err) {
      console.log(`读不到邀请文件：${inviteFile}（${err?.message || err}）`);
      process.exitCode = 1;
      return;
    }
  }
  if (!invite) invite = String(process.env.NEXI_INVITE || '').trim();
  const deviceName = (
    String(flagValue('--name', '') || '').trim()
    || String(process.env.NEXI_DEVICE_NAME || '').trim()
    || hostname()
    || '客人'
  ).slice(0, 40);
  let relayHint = String(flagValue('--relay', '') || '').trim();
  if (!invite) {
    console.log('第一台设备（房主）会打印一整行给你，原样粘过来就行。');
    console.log('');
    console.log(`  ${PAIR_CLI} guest --invite "<房主给的那条链接>"`);
    console.log('');
    console.log('链接里的 & 会被个别终端当成分隔符。真粘不进去就存文件：');
    console.log('  把链接单独存成 invite.txt（只放链接，别加别字），然后');
    console.log(`  ${PAIR_CLI} guest --invite-file invite.txt`);
    console.log('');
    console.log('邀请链接长这样：http://192.168.x.x:8787/?room=xxxx&t=yyyy');
    console.log('装了 DSH 的机器也可能是：dsh://agentdeck/join?room=xxxx&t=yyyy（同样能进）');
    process.exitCode = 1;
    return;
  }

  // 兜底：链接里没有 http 地址（比如 dsh:// 深链）时，
  // 看本机是否记过中继（同机复测常见），或让用户用 --relay 指定。
  if (!/^https?:\/\//i.test(invite) && !relayHint) {
    const st = readState();
    if (st.relayUrl) relayHint = String(st.relayUrl);
  }

  console.log('Nexi 灵犀 · 真机配对（第二步：客人）\n');
  console.log(`收到邀请：${invite.slice(0, 70)}${invite.length > 70 ? '…' : ''}\n`);
  console.log(`设备席位名：${deviceName}`);
  console.log('客人不需要授权码。正在进房…\n');

  const result = await withHub(async (hub) => {
    // 参数名按 deck_room 的真实签名：join 用 inviteUrl（不是 url）
    // —— 真机抓过这个坑：写错参数名工具会给"缺 inviteUrl"的提示，白白浪费一轮排查
    const joinArgs = { action: 'join', inviteUrl: invite, memberName: deviceName };
    if (relayHint) joinArgs.relayUrl = relayHint;
    const joinOut = textOf(await hub.tools.get('deck_room').execute(joinArgs, { hub: true }));
    // 进房之后做一次 sync —— 这才是"报到"：
    // 把本地任务推上去、把房间里的拉下来。房主那边因此能看到对面真的接上了。
    // （真机踩过：本来写了 action:'send'，但 deck_room 根本没有 send 这个动作，
    //   只有 create/join/sync/info/close/leave。用不存在的动作等于没报到。）
    let syncOut = '';
    let teamOut = '';
    try {
      syncOut = textOf(await hub.tools.get('deck_room').execute(
        { action: 'sync', waitSec: 0 },
        { hub: true },
      ));
    } catch (err) {
      syncOut = `（同步失败：${err?.message || err}）`;
    }
    try {
      teamOut = textOf(await hub.tools.get('team_board').execute(
        { action: 'teams' },
        { hub: true },
      ));
    } catch (err) {
      teamOut = `（读取小组失败：${err?.message || err}）`;
    }
    return { joinOut, syncOut, teamOut };
  });

  console.log('进房结果：');
  console.log(`  ${result.joinOut.split('\n').slice(0, 4).join('\n  ')}`);
  console.log('');
  console.log('已同步报到：');
  console.log(`  ${result.syncOut.split('\n').slice(0, 3).join('\n  ')}`);
  console.log('跨机小组：');
  console.log(`  ${result.teamOut.split('\n').slice(0, 2).join('\n  ')}`);
  console.log('');

  // 判定必须看**两个**输出，而且不能把"包含'失败'字样"当成宽松信号后仍然报成功。
  // 真机踩过：前面只检查 joinOut，于是"进房其实没成功"也打印了"进房成功"。
  const joinOk = !/失败|连不上|错误|没有配置/.test(result.joinOut);
  const syncOk = !/失败|连不上|错误|没有配置/.test(result.syncOut);
  const ok = joinOk && syncOk;
  if (ok) {
    // 把中继地址一起记下来：不记的话，客人在**自己**这台设备上跑 check
    // 会打印"本机没记过，先跑一次 host 或 guest"，而它明明刚跑完 guest。
    // 真机踩过 —— 用户因此以为配对没成，白重跑一轮。
    let relayUrl = relayHint;
    try {
      const u = new URL(invite);
      if (/^https?:$/.test(u.protocol)) relayUrl = u.origin;
    } catch { /* 不是合法 URL 就退回 relayHint */ }
    writeState({ role: 'guest', invite, relayUrl: relayUrl || '', guestAt: new Date().toISOString() });
    console.log(`进房并同步成功，已占用 1 席（${deviceName}）。现在两边都跑一次：`);
    console.log(`  ${PAIR_CLI} check`);
    console.log('');
    console.log('然后回你自己常用的 Agent 里问一句「房间里有谁？」');
    console.log('它应该答出「成员 2 人」——这台设备的 Agent 已经在同一间屋里了（1.11.14 起自动）。');
  } else {
    const why = !joinOk ? '进房那一步' : '同步那一步';
    console.log(`没成功（${why}）。把上面的输出发给房主一起看。`);
    if (!joinOk) {
      console.log('');
      console.log('常见原因：');
      console.log('  · 房主那边的窗口关了（中继没了）');
      console.log('  · 两台不在同一个 WiFi');
      console.log('  · 邀请链接抄错或过期 —— 让房主重跑 host 拿一条新的');
    }
    process.exitCode = 1;
  }
}

// ── check：两边都能核对 ──────────────────────────────────────────────────

async function cmdCheck() {
  const state = readState();
  console.log('Nexi 灵犀 · 真机配对核对\n');

  if (state.relayUrl) {
    console.log(`中继：${state.relayUrl}`);
    let relayOk = false;
    try {
      const r = await fetch(`${state.relayUrl}/v1/plans`, { signal: AbortSignal.timeout(6000) });
      relayOk = r.ok;
    } catch {
      relayOk = false;
    }
    console.log(`  可达性：${relayOk ? '连得上' : '连不上（房主那边的窗口是不是关了？）'}`);
  } else {
    console.log('中继：（本机没记过，先跑一次 host 或 guest）');
  }

  // Agent 那边到底认不认这间屋 —— 这是 1.11.14 修的最后一公里，单独报一行。
  // 只读机级房间记录，不发请求；读不出来也不影响配对结论。
  try {
    const pointer = join(DEVICE_ROOT, 'room', '.agentdeck', 'rooms', 'last.json');
    if (existsSync(pointer)) {
      const last = JSON.parse(readFileSync(pointer, 'utf8'));
      const who = Array.isArray(last.members) ? last.members.length : 0;
      const rid = String(last.roomId || '');
      console.log(`Agent 那边：已进房 ${rid ? `${rid.slice(0, 8)}…` : ''}${who ? `（${who} 人）` : ''}`);
      console.log('  换个目录问它「房间里有谁」也答得上来 —— 这台设备的 Agent 在同一间屋里。');
    } else {
      console.log('Agent 那边：还没有房间记录（先跑一次 host 或 guest，它就会写进去）');
    }
  } catch {
    console.log('Agent 那边：房间记录读不出来（不影响配对本身）');
  }

  const local = await withHub(async (hub) => {
    // 先同步再读板：以前顺序反了，check 永远显示同步前的旧板，
    // 任务明明拉回来了也看不见。
    let pull = '';
    try {
      // deck_room 的动作是 create/join/sync/info/close/leave —— 没有 pull。
      // 拉消息用 sync（waitSec:0 立即返回，不阻塞）。
      pull = textOf(await hub.tools.get('deck_room').execute({ action: 'sync', waitSec: 0 }, { hub: true }));
    } catch (err) {
      pull = `（同步失败：${err?.message || err}）`;
    }
    let board = '';
    let roomInfo = '';
    try {
      board = textOf(await hub.tools.get('team_board').execute({ action: 'list' }, { hub: true }));
    } catch (err) {
      board = `（读取任务板失败：${err?.message || err}）`;
    }
    try {
      roomInfo = textOf(await hub.tools.get('deck_room').execute({ action: 'info' }, { hub: true }));
    } catch (err) {
      roomInfo = `（读取房间失败：${err?.message || err}）`;
    }
    return { board, roomInfo, pull };
  });

  console.log('');
  console.log('本机任务板：');
  console.log(`  ${local.board.split('\n').slice(0, 3).join('\n  ')}`);
  console.log('');
  console.log('房间状态：');
  console.log(`  ${local.roomInfo.split('\n').slice(0, 4).join('\n  ')}`);
  console.log('');
  console.log('最近事件：');
  console.log(`  ${local.pull.split('\n').slice(0, 6).join('\n  ')}`);
  console.log('');
  console.log('判定：如果两边都看到对方的报到消息，跨机协作就通了。');
  console.log('任务验收：一边 task add，两边 sync，另一边 task list 能看到同一条。');
}

async function cmdSync() {
  console.log('Nexi 灵犀 · 真机任务同步\n');
  const out = await withHub(async (hub) => {
    const sync = textOf(await hub.tools.get('deck_room').execute(
      { action: 'sync', waitSec: 0 },
      { hub: true },
    ));
    const board = textOf(await hub.tools.get('team_board').execute({ action: 'list' }, { hub: true }));
    return { sync, board };
  });
  console.log('同步结果：');
  console.log(`  ${out.sync.split('\n').slice(0, 5).join('\n  ')}`);
  console.log('');
  console.log('本机任务板：');
  console.log(`  ${out.board.split('\n').slice(0, 12).join('\n  ')}`);
}

async function cmdMembers() {
  const state = readState();
  if (!state.relayUrl) {
    console.log('本机还没进过房间。先跑 host 或 guest，再执行 members。');
    process.exitCode = 1;
    return;
  }
  console.log('Nexi 灵犀 · 项目席位名单\n');
  const info = await withHub(async (hub) => {
    let sync = '';
    try {
      sync = textOf(await hub.tools.get('deck_room').execute({ action: 'sync', waitSec: 0 }, { hub: true }));
    } catch (err) {
      sync = `（同步失败：${err?.message || err}）`;
    }
    const roomInfo = textOf(await hub.tools.get('deck_room').execute({ action: 'info' }, { hub: true }));
    return { sync, roomInfo };
  });
  console.log(info.roomInfo);
  console.log('');
  console.log(`同步：${info.sync.split('\n')[0] || '（无输出）'}`);
}

async function cmdTask() {
  const sub = String(argv[1] || 'list').toLowerCase();
  const known = ['add', 'list', 'claim', 'done', 'fail'];
  if (!known.includes(sub)) {
    console.log('用法：');
    console.log('  nexi pair task add --title "标题" --acceptance "验收标准"');
    console.log('  nexi pair task list');
    console.log('  nexi pair task claim --id task_xxx');
    console.log('  nexi pair task done --id task_xxx --output "产出"');
    console.log('  nexi pair task fail --id task_xxx --note "失败原因"');
    process.exitCode = 2;
    return;
  }
  if (sub === 'add' && !String(flagValue('--title', '') || '').trim()) {
    console.log('task add 需要 --title（这条任务要干什么）。');
    process.exitCode = 2;
    return;
  }
  if (sub !== 'add' && sub !== 'list' && !String(flagValue('--id', '') || '').trim()) {
    console.log(`task ${sub} 需要 --id（task list 输出里的任务号）。`);
    process.exitCode = 2;
    return;
  }

  const result = await withHub(async (hub) => {
    const board = hub.tools.get('team_board');
    let args;
    if (sub === 'add') {
      args = {
        action: 'add',
        title: String(flagValue('--title', '')).trim(),
        acceptance: String(flagValue('--acceptance', '')).trim(),
        role: String(flagValue('--role', 'worker')).trim() || 'worker',
      };
    } else if (sub === 'list') {
      args = { action: 'list' };
    } else if (sub === 'claim') {
      args = { action: 'claim', taskId: String(flagValue('--id', '')).trim() };
    } else if (sub === 'done') {
      args = { action: 'done', taskId: String(flagValue('--id', '')).trim(), output: String(flagValue('--output', '')).trim() };
    } else {
      args = { action: 'fail', taskId: String(flagValue('--id', '')).trim(), note: String(flagValue('--note', '')).trim() };
    }
    return textOf(await board.execute(args, { hub: true }));
  });
  console.log(result);
}

function cmdHelp() {
  console.log('Nexi 灵犀 · 真机配对\n');
  console.log('第一台设备（房主）：');
  console.log('  nexi pair host');
  console.log('  → 起中继、发码、建房间，打印一段可发给对面的文本\n');
  console.log('第二台设备（客人）：');
  console.log('  nexi pair guest --invite "<粘贴邀请链接>" --name "张三-设计部"');
  console.log('  → 进房并报到，不需要授权码；每台设备占 1 席\n');
  console.log('两边都可以：');
  console.log('  nexi pair check');
  console.log('  → 看中继可达性、房间状态、最近事件\n');
  console.log('项目管理员看席位名单：');
  console.log('  nexi pair members');
  console.log('  → 看每台设备/每个人的席位名和当前房间成员\n');
  console.log('真实任务交付（两边各开终端）：');
  console.log('  nexi pair task add --title "跨机验收任务" --acceptance "对方看到并领取"');
  console.log('  nexi pair sync');
  console.log('  nexi pair task list');
  console.log('  nexi pair task claim --id <任务号>');
  console.log('  nexi pair task done --id <任务号> --output "已完成"\n');
  console.log('换端口：nexi pair host --port 9000');
  console.log('扩席位：nexi pair host --tier business --seats 50');
  console.log('成员命名：nexi pair guest --invite-file invite.txt --name "张三-设计部"');
  console.log(`没装过这个包、只在别的设备上临时用：${PAIR_CLI} guest --invite "<链接>"`);
}

const TABLE = { host: cmdHost, guest: cmdGuest, check: cmdCheck, sync: cmdSync, members: cmdMembers, task: cmdTask, help: cmdHelp };
const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const fn = TABLE[ROLE] || cmdHelp;
  try {
    // cmdHelp 是同步的（返回 undefined），host/guest/check 是 async。
    // 以前统一写 .catch() —— 碰到同步的 cmdHelp 就崩在
    // "Cannot read properties of undefined (reading 'catch')"。这里两种都认。
    const maybe = fn();
    if (maybe && typeof maybe.catch === 'function') {
      maybe.catch((err) => {
        console.error('出错：', err?.stack || err);
        process.exitCode = 2;
      });
    }
  } catch (err) {
    console.error('出错：', err?.stack || err);
    process.exitCode = 2;
  }
}
