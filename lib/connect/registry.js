// SPDX-License-Identifier: Apache-2.0
/**
 * 自定义宿主注册表 —— 「不分 Agent」的落地点。
 *
 * 现实：Agent 每周都在冒新的。指望我们每发一版才能接一个，永远追不上。
 * 所以接入能力必须**在用户手里**：一份 JSON 描述「这个 Agent 的 MCP 配置在哪个文件、挂在哪个 key」，
 * 丢进目录就生效，不发版、不联网、不问我们。
 *
 * 位置：$DSH_HOME/agentdeck-super/hosts.d/*.json（NEXI_HOSTS_DIR 可覆盖）
 * 形状：
 *   {
 *     "id": "warp",
 *     "label": "Warp",
 *     "kind": "json",                  // json | toml
 *     "shape": "mcpServers",           // mcpServers | servers | context_servers | mcp.servers
 *     "paths": ["~/.warp/mcp.json"],   // 支持 ~ 和 ${ENV}
 *     "docs": "https://…",
 *     "cli": "warp"                    // 可选：优先用它自己的 CLI 注册
 *   }
 *
 * 规则（都是踩过的坑）：
 *   · id 只允许小写字母数字和 - _，防止有人拿它拼路径。
 *   · paths 必须是绝对路径（展开 ~ / ${ENV} 之后），相对路径一律拒绝 ——
 *     否则"装好了"会落到当前目录，用户换个项目就找不到。
 *   · 同名 id 覆盖内置宿主（自定义优先），但会在 list 里标 source:"custom"，不偷偷替换。
 *   · 坏文件只跳过并记原因，不让整张表崩 —— 一个手写错的 JSON 不该让插件起不来。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';

import { platformCtx, pjoin } from './platform.js';

/** 注册表目录：跟着机级状态走，跟项目和安装目录都无关。 */
export function hostsDir(env = process.env) {
  if (env.NEXI_HOSTS_DIR) return env.NEXI_HOSTS_DIR;
  const home = env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'agentdeck-super', 'hosts.d');
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
export const SHAPE_KEYS = ['mcpServers', 'servers', 'context_servers', 'mcp.servers', 'mcp.local', 'mcp.stdio', 'amp.mcpServers'];

/** 展开 `~` 与 `${VAR}`；不认识的变量原样保留（报错时能看出是哪一段）。 */
export function expandPath(raw, ctx = platformCtx()) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let s = raw.trim();
  if (s === '~') s = ctx.home;
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = pjoin(ctx, ctx.home, s.slice(2));
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
    const v = ctx.env[name];
    return v === undefined ? m : v;
  });
  return s;
}

/**
 * 校验并规范化一份宿主描述。返回 {ok, host, errors}。
 * 这里刻意严格：注册表是用户手写的，错在写入前拦掉，比事后"装完没生效"好查。
 */
export function normalizeHostSpec(raw, ctx = platformCtx()) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['不是一个 JSON 对象'] };
  }
  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id)) errors.push(`id 不合法（只允许小写字母数字和 - _，2–40 位）：${id || '空'}`);
  const label = String(raw.label || '').trim() || id;
  const kind = raw.kind === 'toml' ? 'toml' : 'json';
  const shape = raw.shape ? String(raw.shape) : 'mcpServers';
  if (kind === 'json' && !SHAPE_KEYS.includes(shape)) {
    errors.push(`shape 不认识：${shape}（可选 ${SHAPE_KEYS.join(' / ')}）`);
  }
  const rawPaths = Array.isArray(raw.paths) ? raw.paths : (raw.path ? [raw.path] : []);
  const paths = [];
  for (const p of rawPaths) {
    const expanded = expandPath(p, ctx);
    if (!expanded) continue;
    if (!isAbsolute(expanded)) {
      errors.push(`路径必须是绝对路径（或用 ~ / \${ENV} 开头）：${p}`);
      continue;
    }
    if (!paths.includes(expanded)) paths.push(expanded);
  }
  if (!paths.length) errors.push('至少要给一个 paths');
  const cli = raw.cli ? String(raw.cli).trim() : '';
  if (cli && !/^[A-Za-z0-9._-]+$/.test(cli)) errors.push(`cli 不合法：${cli}`);
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    host: {
      id,
      label,
      tier: 'A',
      kind,
      shape,
      docs: raw.docs ? String(raw.docs) : '',
      cli: cli || undefined,
      source: 'custom',
      // 与内置宿主同签名：paths(ctx) 返回候选文件。
      // 用「原始写法」在调用时展开，这样 nexi where 在 Windows 上也能预览 darwin 的落点。
      paths: (c = ctx) => rawPaths.map((p) => expandPath(p, c)).filter(Boolean),
      _spec: { id, label, kind, shape, paths: rawPaths, docs: raw.docs || '', cli: cli || undefined },
    },
  };
}

/**
 * 读目录里所有 *.json。坏文件不抛：进 problems，调用方自己决定要不要打印。
 * 返回 {hosts, problems, dir}
 */
export function loadCustomHosts(opts = {}) {
  const ctx = opts.ctx || platformCtx();
  const dir = opts.dir || hostsDir(ctx.env);
  const hosts = [];
  const problems = [];
  if (!existsSync(dir)) return { hosts, problems, dir };
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    return { hosts, problems: [{ file: dir, error: `目录读不了：${err.message}` }], dir };
  }
  for (const name of names) {
    const file = join(dir, name);
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      problems.push({ file, error: `不是合法 JSON：${err.message}` });
      continue;
    }
    // 允许一个文件里放多个宿主：{ "hosts": [ … ] }
    const list = Array.isArray(raw?.hosts) ? raw.hosts : [raw];
    for (const item of list) {
      const res = normalizeHostSpec(item, ctx);
      if (!res.ok) {
        problems.push({ file, id: item?.id || '(无 id)', error: res.errors.join('；') });
        continue;
      }
      hosts.push(res.host);
    }
  }
  return { hosts, problems, dir };
}

/** 合并：自定义覆盖同名内置（排在前面，findHost 先命中）。 */
export function mergeHosts(builtin, custom) {
  const customIds = new Set(custom.map((h) => h.id));
  return [...custom, ...builtin.filter((h) => !customIds.has(h.id))];
}

/** 写一份宿主描述进注册表。同名覆盖（先写临时文件再 rename，避免半截文件）。 */
export function saveCustomHost(spec, opts = {}) {
  const ctx = opts.ctx || platformCtx();
  const dir = opts.dir || hostsDir(ctx.env);
  const res = normalizeHostSpec(spec, ctx);
  if (!res.ok) return { ok: false, errors: res.errors };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${res.host.id}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(res.host._spec, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return { ok: true, file, id: res.host.id };
}

export function removeCustomHost(id, opts = {}) {
  const ctx = opts.ctx || platformCtx();
  const dir = opts.dir || hostsDir(ctx.env);
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return { ok: false, reason: 'not-found', file };
  unlinkSync(file);
  return { ok: true, file };
}

/** 内置宿主 + 自定义宿主的最终表（自定义优先）。 */
export function withCustomHosts(builtin, opts = {}) {
  const { hosts, problems, dir } = loadCustomHosts(opts);
  return { hosts: mergeHosts(builtin, hosts), problems, dir, custom: hosts };
}
