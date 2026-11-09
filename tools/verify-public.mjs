#!/usr/bin/env node
/**
 * 公网 MCP 验收：本机起真实 MCP HTTP 服务 + 公网隧道，然后从公网侧验证
 *   /healthz 200
 *   无 token 的 initialize 必须 401
 *   带 Bearer token 的 initialize 必须 200
 *   tools/list 必须能拿到工具清单
 *
 * 只有四项全过才算 PASS。隧道进程活着但 /healthz 不通 = FAIL。
 *
 * 用法：
 *   node tools/verify-public.mjs
 *   node tools/verify-public.mjs --provider cloudflared --timeout 120000
 *   node tools/verify-public.mjs --provider localtunnel --out docs/evidence/public-local.txt
 *
 * 退出码：0 全过；1 有检查失败；2 参数错误。
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHub } from '../lib/hub.js';
import { startMcpHttpServer } from '../lib/mcp/standalone.js';
import {
  detectTunnelProviders,
  startTunnel,
  tunnelInstallHint,
  verifyPublicHealth,
} from './nexi-tunnel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const argv = process.argv.slice(2);

function flagValue(name, fallback = '') {
  const eq = `${name}=`;
  const withEq = argv.find((a) => a.startsWith(eq));
  if (withEq) return withEq.slice(eq.length);
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const provider = String(flagValue('--provider', 'auto')).toLowerCase();
const port = Number(flagValue('--port', '0'));
const timeoutMs = Math.max(10000, Number(flagValue('--timeout', '120000')) || 120000);
const explicitOut = flagValue('--out', '');

if (!['auto', 'cloudflared', 'localtunnel'].includes(provider)) {
  console.error('--provider 只支持 auto / cloudflared / localtunnel');
  process.exit(2);
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('--port 需要 0-65535 的整数');
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const lines = [];
const record = (line = '') => {
  console.log(line);
  lines.push(line);
};

const startedAt = new Date().toISOString();
const token = randomBytes(24).toString('base64url');
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'nexi-verify-public', version },
  },
};

let hub = null;
let server = null;
let tunnel = null;
let outcome = 'FAIL';
let failure = '';

async function cleanup() {
  if (tunnel) {
    try { await tunnel.stop(); } catch { /* 已退出 */ }
    tunnel = null;
  }
  if (server) {
    try { await server.close(); } catch { /* 已关闭 */ }
    server = null;
  }
  if (hub) {
    try { await hub.close(); } catch { /* 已关闭 */ }
    hub = null;
  }
}

function writeEvidence() {
  const defaultName = `public-${version}.txt`;
  const target = resolve(explicitOut || join(PKG, 'docs', 'evidence', defaultName));
  const summary = [
    `Nexi 灵犀 · 公网 MCP 验收（${version}）`,
    `时间：${startedAt}`,
    `平台：${process.platform}/${process.arch} · Node ${process.versions.node}`,
    `隧道 provider：${provider}`,
    `结果：${outcome}${failure ? ` · ${failure}` : ''}`,
    '',
    ...lines,
    '',
    '说明：',
    '- 本脚本从公网 URL 发起请求，不是只测 127.0.0.1。',
    '- cloudflared / localtunnel 的临时域名会随进程关闭而失效，不代表长期托管。',
    '- token 不在本文件里输出。',
  ].join('\n');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${summary}\n`, 'utf8');
  console.log(`证据已写入：${target}`);
}

process.once('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  record(`Nexi 灵犀 · 公网 MCP 验收（${version}）`);
  record(`时间：${startedAt}`);
  record(`平台：${process.platform}/${process.arch} · Node ${process.versions.node}`);
  record('');

  const detected = detectTunnelProviders();
  record(`隧道探测：cloudflared=${detected.cloudflared.available ? '可用' : '不可用'}，localtunnel=${detected.localtunnel.available ? '可用' : '不可用'}`);

  hub = await createHub({
    workspace: mkdtempSync(join(tmpdir(), 'nexi-public-work-')),
    onLog: () => {},
  });
  const definitions = hub.list();
  if (!definitions.length) throw new Error('没有可暴露的 MCP 工具');

  server = await startMcpHttpServer({
    definitions,
    host: '127.0.0.1',
    port,
    token,
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  record(`本地 MCP：http://127.0.0.1:${server.port}/mcp（工具 ${definitions.length} 个）`);

  tunnel = await startTunnel({
    provider,
    port: server.port,
    host: '127.0.0.1',
    timeoutMs,
    log: (m) => record(`  ${m}`),
  });
  if (!tunnel.ok) {
    record(`FAIL 隧道没起来：${tunnel.reason || '未知原因'}`);
    for (const item of Array.isArray(tunnel.failures) ? tunnel.failures : []) {
      record(`  · ${item.provider}: ${item.reason}`);
      if (item.tail) record(`    ${String(item.tail).split('\n').slice(-4).join('\n    ')}`);
    }
    record(tunnelInstallHint());
    throw new Error('隧道不可用');
  }
  record(`OK 隧道已分配：${tunnel.url}（${tunnel.provider}）`);

  const health = await verifyPublicHealth(tunnel.url, { timeoutMs: Math.min(30000, timeoutMs) });
  if (!health.ok) throw new Error(health.reason || '公网 /healthz 不可达');
  record('OK 公网 /healthz 200');

  const denied = await fetch(`${tunnel.url}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(initializeBody),
    signal: AbortSignal.timeout(20000),
  });
  const deniedText = await denied.text();
  if (denied.status !== 401) {
    throw new Error(`无 token 的 initialize 应返回 401，实际 ${denied.status}：${deniedText.slice(0, 160)}`);
  }
  record('OK 无 token 被 401 拒绝');

  const init = await fetch(`${tunnel.url}/mcp`, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify(initializeBody),
    signal: AbortSignal.timeout(20000),
  });
  const initText = await init.text();
  if (init.status !== 200) {
    throw new Error(`带 token 的 initialize 应返回 200，实际 ${init.status}：${initText.slice(0, 160)}`);
  }
  if (!/"serverInfo"/.test(initText)) {
    throw new Error(`initialize 响应里没有 serverInfo：${initText.slice(0, 160)}`);
  }
  const serverVersion = (/"version":"([^"]+)"/.exec(initText) || [])[1] || '?';
  record(`OK Bearer initialize 200（serverInfo.version=${serverVersion}）`);

  const session = init.headers.get('mcp-session-id');
  const list = await fetch(`${tunnel.url}/mcp`, {
    method: 'POST',
    headers: {
      ...headers,
      authorization: `Bearer ${token}`,
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(20000),
  });
  const listText = await list.text();
  if (list.status !== 200) {
    throw new Error(`tools/list 应返回 200，实际 ${list.status}：${listText.slice(0, 160)}`);
  }
  const toolNames = [...listText.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
  if (toolNames.length !== definitions.length) {
    throw new Error(`tools/list 返回 ${toolNames.length} 个工具，本地应有 ${definitions.length} 个`);
  }
  record(`OK tools/list 200，${toolNames.length} 个工具`);
  record(`   ${toolNames.join(', ')}`);

  outcome = 'PASS';
  record('');
  record('PASS 公网 MCP 验收通过：任意网络只要能访问这个 HTTPS 地址，就能带 token 接入。');
} catch (err) {
  failure = err?.message || String(err);
  record('');
  record(`FAIL ${failure}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  writeEvidence();
}
