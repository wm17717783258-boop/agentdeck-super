// SPDX-License-Identifier: Apache-2.0
/**
 * 可选的"有没有新版"检查 —— **默认关**，这是刻意的。
 *
 * 这个产品的硬承诺之一是不分网络：拔掉网线、DNS 全挂，MCP 照样能起。
 * 一个"每次启动悄悄连一次 npm"的更新检查会直接违背这条，
 * 而且用户永远不知道自己被联网了。
 *
 * 所以：
 *   · 只有 `NEXI_UPDATE_CHECK=1`（或显式 `nexi update --check`）才联网；
 *   · 结果缓存 24 小时，不让用户每次敲命令都打一次 registry；
 *   · 超时 1.5 秒、任何异常都当"没查到"，绝不阻塞主流程、绝不弹错。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { stateRoot } from './connect/platform.js';

export const REGISTRY_LATEST = 'https://registry.npmjs.org/agentdeck-super/latest';
export const CACHE_TTL_MS = 24 * 3600 * 1000;

export function updateCheckEnabled(env = process.env) {
  const v = String(env.NEXI_UPDATE_CHECK ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function cacheFile(env = process.env) {
  const custom = String(env.NEXI_UPDATE_CACHE || '').trim();
  return custom || join(stateRoot(), 'update-check.json');
}

/** semver 比较（只处理 1.2.3 形式的正式版；预发布按字典序兜底）。 */
export function compareVersions(a, b) {
  const parse = (v) => String(v || '').trim().replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

function readCache(env) {
  try {
    const file = cacheFile(env);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || !data.at || !data.latest) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(env, latest) {
  try {
    const file = cacheFile(env);
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), latest }, null, 2), 'utf8');
  } catch { /* 缓存写不了不影响结果 */ }
}

/**
 * 查最新版。
 * @param {object} opts
 * @param {string} opts.current 当前版本
 * @param {boolean} [opts.force] 忽略缓存与开关（`nexi update --check` 用）
 * @returns {Promise<{ok:boolean,checked:boolean,latest?:string,current:string,outdated?:boolean,reason?:string,fromCache?:boolean,error?:string}>}
 */
export async function checkForUpdate(opts = {}) {
  const env = opts.env || process.env;
  const current = String(opts.current || '0.0.0');
  const force = opts.force === true;

  if (!force && !updateCheckEnabled(env)) {
    return { ok: true, checked: false, current, reason: 'disabled（默认不联网；要查就设 NEXI_UPDATE_CHECK=1 或加 --check）' };
  }

  const cached = force ? null : readCache(env);
  if (cached && Date.now() - Date.parse(cached.at) < CACHE_TTL_MS) {
    return {
      ok: true,
      checked: false,
      current,
      latest: cached.latest,
      outdated: compareVersions(cached.latest, current) > 0,
      fromCache: true,
      reason: `24 小时内查过（${cached.at}）`,
    };
  }

  if (typeof fetch !== 'function') {
    return { ok: false, checked: false, current, error: '这个 Node 没有 fetch（需要 18+）' };
  }

  const timeoutMs = Number(opts.timeoutMs || 1500);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(opts.url || REGISTRY_LATEST, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const latest = String(body.version || '').trim();
    if (!latest) throw new Error('响应里没有 version');
    writeCache(env, latest);
    return { ok: true, checked: true, current, latest, outdated: compareVersions(latest, current) > 0 };
  } catch (err) {
    // 断网 / 超时 / registry 挂了 —— 都不是错误，只是"没查到"，不能影响主流程
    return {
      ok: false,
      checked: true,
      current,
      error: err.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(err.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export default { checkForUpdate, updateCheckEnabled, compareVersions, cacheFile };
