#!/usr/bin/env node
/**
 * tools/nexi-tunnel.mjs —— 给 relay / MCP 端点加一个临时公网入口。
 *
 * 说明白一点：没有公网 relay、没有反代、没有隧道时，任何软件都不可能
 * 凭空穿透 NAT。这个模块做的是"自动把现成的隧道工具拉起来并验证真的可达"，
 * 不是魔法，也不是 24h SLA 托管。
 *
 * 支持：
 *   cloudflared 隧道（Cloudflare Quick Tunnel，临时 trycloudflare.com 域名）
 *   localtunnel（第三方 loca.lt，npx 可直接跑，作为无 cloudflared 时的后备）
 *   外部 public URL（你自己已有反代/ngrok/frp/Tailscale Funnel）
 *
 * 所有 provider 都必须通过公网 `/healthz` 探测才会返回成功；进程退出时 stop()
 * 会收拾子进程，避免留下占端口的僵尸。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findOnPath } from '../lib/connect/hosts.js';

const DEFAULT_TIMEOUT_MS = 60000;
const URL_PATTERNS = {
  cloudflared: /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i,
  localtunnel: /https:\/\/[a-z0-9-]+\.loca\.lt\b/i,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 找 cloudflared。
 *
 * winget 装完不会刷新当前进程的 PATH，新开的宿主也未必继承到，
 * 只查 PATH 会出现"明明装了却报 file cannot be empty"的假阴性。
 * 所以 PATH 找不到时补查各平台的默认安装位置。
 */
function resolveCloudflared() {
  const onPath = findOnPath(['cloudflared']);
  if (onPath) return onPath;
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      join(programFilesX86, 'cloudflared', 'cloudflared.exe'),
      join(programFiles, 'cloudflared', 'cloudflared.exe'),
    );
    if (localAppData) {
      candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
    }
  } else {
    candidates.push('/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared');
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** 把用户给的公网地址收敛成一个没有尾斜杠、没有凭据/查询串的 origin(+path)。 */
export function normalizePublicUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new TypeError(`公网地址不是合法 URL：${text}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`公网地址必须是 http:// 或 https://：${text}`);
  }
  if (url.username || url.password) throw new TypeError('公网地址里不要带用户名/密码。');
  if (url.search || url.hash) throw new TypeError('公网地址不要带查询参数或锚点。');
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** 当前机器上哪些隧道 provider 可用（只探测，不下载）。 */
export function detectTunnelProviders() {
  const cloudflared = resolveCloudflared();
  const npx = findOnPath(['npx']);
  return {
    cloudflared: {
      available: Boolean(cloudflared),
      command: cloudflared || '',
      note: cloudflared ? '已安装' : '未找到 cloudflared；装法：winget install --id Cloudflare.cloudflared',
    },
    localtunnel: {
      available: Boolean(npx),
      command: npx || '',
      via: npx || '',
      note: npx ? '通过 npx 运行（首次可能下载包）' : '未找到 npx；先安装 Node.js/npm',
    },
  };
}

function providerChoices(provider, detected) {
  const p = String(provider || 'auto').toLowerCase();
  if (p === 'auto') {
    return ['cloudflared', 'localtunnel'].filter((id) => detected[id]?.available);
  }
  // 显式指定也必须校验可用性：否则 commandFor 会拿到空命令，
  // spawn 直接抛 "The argument 'file' cannot be empty"，用户看不懂。
  if (p === 'cloudflared' || p === 'localtunnel') {
    return detected[p]?.available ? [p] : [];
  }
  return [];
}

function commandFor(provider, detected, port, host) {
  if (provider === 'cloudflared') {
    return {
      command: detected.cloudflared.command,
      args: ['tunnel', '--url', `http://${host}:${port}`, '--no-autoupdate', '--loglevel', 'info'],
      shell: false,
    };
  }
  const npx = detected.localtunnel.command;
  const args = ['--yes', 'localtunnel', '--port', String(port), '--local-host', host];
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${npx}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`],
      shell: false,
    };
  }
  return { command: npx, args, shell: false };
}

async function terminate(child, { spawnImpl = spawn } = {}) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      let killer;
      try {
        killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          shell: false,
        });
      } catch {
        finish();
        return;
      }
      killer.once?.('exit', finish);
      killer.once?.('error', finish);
      setTimeout(finish, 2500);
    });
    try { child.kill?.('SIGKILL'); } catch { /* 已退出 */ }
    return;
  }
  try { child.kill?.('SIGTERM'); } catch { /* 已退出 */ }
  await sleep(300);
  try { child.kill?.('SIGKILL'); } catch { /* 已退出 */ }
}

function capture(child) {
  const state = { out: '', err: '', exited: false, exitCode: null };
  child.stdout?.on?.('data', (chunk) => { state.out += String(chunk); });
  child.stderr?.on?.('data', (chunk) => { state.err += String(chunk); });
  child.once?.('exit', (code) => { state.exited = true; state.exitCode = code; });
  child.once?.('error', (err) => {
    state.exited = true;
    state.err += `\n${err?.message || err}`;
  });
  return state;
}

async function waitUrl(provider, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pattern = URL_PATTERNS[provider];
  while (Date.now() < deadline) {
    const match = pattern.exec(`${state.out}\n${state.err}`);
    if (match) return match[0];
    if (state.exited) return '';
    await sleep(150);
  }
  return '';
}

async function healthOk(url, { fetchImpl = fetch, timeoutMs = 8000, healthPath = '/healthz' } = {}) {
  try {
    const target = `${url.replace(/\/+$/, '')}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`;
    const res = await fetchImpl(target, {
      headers: {
        'bypass-tunnel-reminder': 'true',
        'user-agent': 'nexi-tunnel-check/1',
        accept: 'application/json,text/plain,*/*',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res?.ok === true && Number(res.status) === 200;
  } catch {
    return false;
  }
}

/**
 * 起一条隧道。
 *
 * @param {{
 *   provider?: string,
 *   port: number,
 *   host?: string,
 *   publicUrl?: string,
 *   timeoutMs?: number,
 *   healthPath?: string,
 *   fetchImpl?: Function,
 *   spawnImpl?: Function,
 *   log?: Function,
 *   detected?: object,
 * }} opts
 */
export async function startTunnel(opts = {}) {
  if (opts.publicUrl) {
    const url = normalizePublicUrl(opts.publicUrl);
    return {
      ok: true,
      provider: 'external',
      url,
      pid: null,
      stop: async () => {},
      logs: () => '',
    };
  }

  const provider = String(opts.provider || 'auto').toLowerCase();
  if (!provider || provider === 'off' || provider === 'none') {
    return { ok: false, provider: 'off', reason: '没有指定公网入口', stop: async () => {}, logs: () => '' };
  }
  if (!Number.isInteger(Number(opts.port)) || Number(opts.port) <= 0) {
    return { ok: false, provider, reason: `端口不合法：${opts.port}`, stop: async () => {}, logs: () => '' };
  }

  const detected = opts.detected || detectTunnelProviders();
  const choices = providerChoices(provider, detected);
  if (!choices.length) {
    const known = ['auto', 'cloudflared', 'localtunnel', 'off'];
    const key = String(provider || '').toLowerCase();
    const detail = detected[key]?.note ? `：${detected[key].note}` : '';
    return {
      ok: false,
      provider,
      reason: known.includes(provider)
        ? `本机没有可用的隧道 provider${detail}`
        : `不认识的隧道 provider：${provider}`,
      providers: detected,
      stop: async () => {},
      logs: () => '',
    };
  }

  const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const host = String(opts.host || '127.0.0.1');
  const spawnImpl = opts.spawnImpl || spawn;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const failures = [];

  for (const id of choices) {
    const spec = commandFor(id, detected, Number(opts.port), host);
    let child = null;
    let state = null;
    try {
      log(`正在启动 ${id} 隧道…`);
      child = spawnImpl(spec.command, spec.args, {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(id === 'localtunnel' ? { BYPASS_TUNNEL_REMINDER: '1' } : {}),
        },
        shell: spec.shell,
      });
      state = capture(child);
      const url = await waitUrl(id, state, timeoutMs);
      if (!url) {
        failures.push({
          provider: id,
          reason: state.exited
            ? `进程已退出（code=${state.exitCode}）`
            : `${Math.round(timeoutMs / 1000)} 秒内没看到公网 URL`,
          tail: `${state.out}\n${state.err}`.trim().slice(-800),
        });
        await terminate(child, { spawnImpl });
        continue;
      }

      let ok = false;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        ok = await healthOk(url, {
          fetchImpl: opts.fetchImpl,
          timeoutMs: Math.min(8000, Math.max(1500, timeoutMs)),
          healthPath: opts.healthPath || '/healthz',
        });
        if (ok) break;
        if (state.exited) break;
        await sleep(800);
      }
      if (!ok) {
        failures.push({
          provider: id,
          url,
          reason: '公网 URL 已生成，但 /healthz 一直不可达',
          tail: `${state.out}\n${state.err}`.trim().slice(-800),
        });
        await terminate(child, { spawnImpl });
        continue;
      }

      let stopped = false;
      return {
        ok: true,
        provider: id,
        url,
        pid: child.pid || null,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await terminate(child, { spawnImpl });
        },
        logs: () => `${state.out}\n${state.err}`.trim(),
      };
    } catch (err) {
      failures.push({ provider: id, reason: err?.message || String(err) });
      await terminate(child, { spawnImpl });
    }
  }

  return {
    ok: false,
    provider,
    reason: '所有可用隧道都启动失败',
    failures,
    providers: detected,
    stop: async () => {},
    logs: () => '',
  };
}

/**
 * 显式探测一个公网地址是否真的能回到本机服务。
 * pair / serve 在打印邀请链接前必须调用它，不能只凭"进程启动了"就宣布成功。
 */
export async function verifyPublicHealth(url, opts = {}) {
  const base = normalizePublicUrl(url);
  if (!base) return { ok: false, reason: '公网地址为空' };
  const deadline = Date.now() + (Math.max(3000, Number(opts.timeoutMs) || 30000));
  let last = '';
  while (Date.now() < deadline) {
    try {
      const target = `${base}${opts.healthPath || '/healthz'}`;
      const res = await (opts.fetchImpl || fetch)(target, {
        headers: { 'bypass-tunnel-reminder': 'true', accept: 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(8000),
      });
      last = `HTTP ${res.status}`;
      if (res.ok && res.status === 200) return { ok: true, url: base, status: res.status };
    } catch (err) {
      last = err?.message || String(err);
    }
    await sleep(800);
  }
  return { ok: false, url: base, reason: `公网 /healthz 不可达（${last || '超时'}）` };
}

export function tunnelInstallHint() {
  return [
    'cloudflared（推荐）：',
    '  Windows: winget install --id Cloudflare.cloudflared',
    '  macOS:   brew install cloudflared',
    '  Linux:   按 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 安装',
    'localtunnel（npx 后备）：',
    '  先装 Node.js/npm，然后 npx --yes localtunnel --port 8787',
    '已有反代/ngrok/frp/Tailscale Funnel：直接传 --public-url https://你的域名',
  ].join('\n');
}

export default {
  normalizePublicUrl,
  detectTunnelProviders,
  startTunnel,
  verifyPublicHealth,
  tunnelInstallHint,
};
