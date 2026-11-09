#!/usr/bin/env node
/**
 * tools/pack-trim.mjs —— 按体检结果清理交付包（**默认只预演，不删**）
 *
 * 和 pack-clean.mjs 的分工：
 *   pack-clean  只检查，说"哪里有问题"，不改盘
 *   pack-trim   真删，但**默认 dry-run**，必须显式 --apply 才落手
 *
 * 为什么默认不删：删除不可逆。上次交付包里混进明文 GitHub 令牌，正确顺序是
 *   ① 先作废令牌（外部动作，脚本管不了）→ ② 再删文件 → ③ 复检。
 *   如果脚本一上来就把 .secrets 删了，人容易以为"处理完了"，而令牌其实还在外面飘。
 *   所以这里永远先打印要删什么、为什么、多大，等人按 --apply。
 *
 * 用法：
 *   node tools/pack-trim.mjs                      # 预演（默认）
 *   node tools/pack-trim.mjs --json               # 预演，机器可读
 *   node tools/pack-trim.mjs --apply              # 真删（高危项需 --force）
 *   node tools/pack-trim.mjs --apply --force      # 高危项也删（还要求 --i-know-token）
 *   node tools/pack-trim.mjs --apply --only=tarball,sourcemap
 *
 * 安全约束（写死在代码里，不是文档里的建议）：
 *   - 目标路径必须落在 --root 之内；任何越界目标直接拒绝执行。
 *   - 绝不删除 .git、lib、bin、tools、tests、docs 这些源码目录。
 *   - 高危项（凭据/私钥）默认跳过，需 --force + --i-know-token 双确认。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const argv = process.argv.slice(2);

function flagValue(name, fallback = '') {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

/**
 * 取开关值：同时认 `--name value` 和 `--name=value` 两种写法。
 * 只认前者会踩坑——`--only=log` 不会被 indexOf('--only') 找到，
 * 于是"限定范围"被静默忽略、删掉的东西比用户想的多。这种坑必须在这里堵死。
 */
function flagAny(name, fallback = '') {
  const eq = `${name}=`;
  const withEq = argv.find((a) => a.startsWith(eq));
  if (withEq) return withEq.slice(eq.length);
  return flagValue(name, fallback);
}

const ROOT = resolve(flagAny('--root', PKG));
const AS_JSON = argv.includes('--json');
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const TOKEN_ACK = argv.includes('--i-know-token');
const ONLY = (() => {
  const raw = flagAny('--only', '');
  return raw ? new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
})();

/** 永远不许删的源码/资料目录（防止"清理脚本"变成事故）。 */
const PROTECTED = new Set(['.git', 'lib', 'bin', 'tools', 'tests', 'docs', 'assets', 'licenses', 'scripts', 'src']);
/** 高危规则：涉及凭据，默认不动。 */
const SENSITIVE_RULES = new Set(['secrets', 'issuer-keys', 'pem', 'envfile', 'token-file', 'tools-bin']);

function safeUnderRoot(rel) {
  const full = resolve(join(ROOT, rel));
  const r = relative(ROOT, full);
  if (!r || r.startsWith('..') || resolve(ROOT) === full) return null;
  return full;
}

function sizeOf(full) {
  try {
    const st = statSync(full);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of readdirSync(full)) total += sizeOf(join(full, name));
    return total;
  } catch {
    return 0;
  }
}

function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 用 pack-clean 的结果当输入——两套规则只维护一份。 */
function readFindings() {
  const r = spawnSync(process.execPath, [join(PKG, 'tools', 'pack-clean.mjs'), '--root', ROOT, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

const clean = readFindings();
if (!clean) {
  console.error('读不到体检结果：pack-clean.mjs 没能跑起来。');
  process.exitCode = 2;
  process.exit(2);
}

const candidates = [];
const skipped = [];

for (const f of clean.findings) {
  if (ONLY && !ONLY.has(f.rule)) {
    skipped.push({ ...f, skipReason: '不在 --only 名单里' });
    continue;
  }
  const rel = f.path;
  const full = safeUnderRoot(rel);
  if (!full) {
    skipped.push({ ...f, skipReason: '路径越界（拒绝执行）' });
    continue;
  }
  const top = rel.split(/[\\/]/)[0];
  if (PROTECTED.has(top)) {
    skipped.push({ ...f, skipReason: `${top} 是源码/资料目录，永不清理` });
    continue;
  }
  const sensitive = SENSITIVE_RULES.has(f.rule);
  if (sensitive && !(FORCE && TOKEN_ACK)) {
    skipped.push({
      ...f,
      skipReason: sensitive
        ? '凭据/私钥类：需要 --force --i-know-token 双确认（先作废令牌再删）'
        : '需要 --force',
    });
    continue;
  }
  candidates.push({ rule: f.rule, path: rel, full, severity: f.severity, why: f.why, exists: existsSync(full) });
}

const planned = candidates.filter((c) => c.exists);
const plannedBytes = planned.reduce((s, c) => s + sizeOf(c.full), 0);

// ── 执行 ────────────────────────────────────────────────────────────────
const done = [];
const failed = [];

if (APPLY) {
  for (const c of planned) {
    // 每删一个都再确认一次路径还在 root 之内（防符号链接/竞态）
    const again = safeUnderRoot(c.path);
    if (!again || again !== c.full) {
      failed.push({ path: c.path, error: '路径校验未通过，已跳过' });
      continue;
    }
    try {
      rmSync(c.full, { recursive: true, force: true });
      done.push(c.path);
    } catch (err) {
      failed.push({ path: c.path, error: String(err?.message || err) });
    }
  }
}

const result = {
  applied: APPLY,
  root: ROOT,
  planned: planned.map((c) => ({ rule: c.rule, path: c.path, severity: c.severity, bytes: sizeOf(c.full), why: c.why })),
  plannedBytes,
  plannedHuman: human(plannedBytes),
  deleted: done,
  failed,
  skipped,
  note: APPLY ? '' : '这是预演。确认无误后加 --apply 才真删。',
};

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log(APPLY ? '打包清理 —— 执行模式\n' : '打包清理 —— 预演模式（什么都没删）\n');
  console.log(`仓库根：${ROOT}`);
  console.log('');
  if (!planned.length) {
    console.log('没有可清理项（要么本来干净，要么高危项被安全策略拦住了）。');
  } else {
    console.log(`将处理 ${planned.length} 项，释放 ${human(plannedBytes)}：`);
    for (const c of planned) {
      console.log(`  [${c.severity.toUpperCase()}] ${c.path}  (${human(sizeOf(c.full))}) — ${c.why}`);
    }
  }
  if (skipped.length) {
    console.log('');
    console.log(`安全跳过 ${skipped.length} 项：`);
    for (const s of skipped) console.log(`  [${s.severity.toUpperCase()}] ${s.path} — ${s.skipReason}`);
  }
  if (APPLY) {
    console.log('');
    console.log(`已删除 ${done.length} 项${failed.length ? `，失败 ${failed.length} 项` : ''}。`);
    for (const f of failed) console.log(`  ✗ ${f.path}：${f.error}`);
    console.log('');
    console.log('建议复检：node tools/pack-clean.mjs');
  } else {
    console.log('');
    console.log('下一步：确认上面这份清单 → 加 --apply 执行 → 再跑一次 pack-clean 复检。');
    if (skipped.some((s) => SENSITIVE_RULES.has(s.rule))) {
      console.log('');
      console.log('提醒：凭据类文件即使删掉，泄露出去的令牌仍然有效。先作废重签，再删文件。');
    }
  }
}

process.exitCode = failed.length ? 1 : 0;
