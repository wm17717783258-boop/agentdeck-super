#!/usr/bin/env node
/**
 * tools/test-summary.mjs —— 跑全量测试只打印汇总
 *
 * 为什么要它：在 cmd/PowerShell 里过滤 node --test 的中文输出很麻烦
 * （引号、编码、管道都会坏事）。这个脚本直接子进程跑、只摘出关键行。
 *
 * 用法：node tools/test-summary.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 收集某个目录下的测试文件；目录不存在就返回空（开源版没有 pro/ 是正常状态）。 */
function collect(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(dir, name));
}

// 核心测试永远跑；闭源商业层测试只在装了 pro/ 时才跑。
const CORE_FILES = collect(join(PKG, 'tests'));
const PRO_FILES = collect(join(PKG, 'pro', 'tests'));
const files = [...CORE_FILES, ...PRO_FILES];

if (!files.length) {
  console.error(`没有找到测试文件：${join(PKG, 'tests')}`);
  process.exit(2);
}

const proCount = new Set(PRO_FILES).size;
console.log(`测试范围：核心 ${CORE_FILES.length} 个文件`
  + (proCount ? ` + 商业层 ${proCount} 个文件（pro/）` : '（未安装商业层）'));

// 不要在子进程里把 "tests/*.test.mjs" 原样交给 Node：Windows 上 shell 不参与，
// Node 会把它当成一个字面文件名。这里先枚举真实文件，再显式传进去。
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 900000,
  shell: false,
});

const out = `${r.stdout || ''}${r.stderr || ''}`;

/*
 * node --test 有两套输出格式，取决于它自己是不是 TTY：
 *   · 直接跑在终端里 → spec reporter，汇总行是 `ℹ tests 1084`
 *   · 被 spawn 捕获输出（本脚本就是这种）→ tap reporter，汇总行是 `# tests 1084`
 *
 * 之前这里只认 `ℹ`，于是用脚本跑的时候汇总永远是空的（明明全绿却看不到数字）。
 * 两种前缀都认，才不会让「没输出」被误读成「测试没跑」。
 */
const SUMMARY_RE = /^(?:\u2139|#)\s+(tests|pass|fail|cancelled|skipped)\s+(\d+)\s*$/;
const LINES = out.split(/\r?\n/);
const summary = [];
const failedCases = []; // { name, detail[] }

for (let i = 0; i < LINES.length; i += 1) {
  const line = LINES[i];
  const m = line.match(SUMMARY_RE);
  if (m) summary.push(`ℹ ${m[1]} ${m[2]}`);

  // 只认真正的失败用例行；用索引往下抓它的诊断块，
  // 否则只剩一句 "not ok 603 - xxx"，assert 打的 expected/actual 全被丢掉，
  // 看的人只能猜是超时还是断言不符 —— 这个坑踩过太多次。
  const nm = line.match(/^not ok \d+ - (.+)$/);
  if (nm) {
    const detail = [];
    for (let j = i + 1; j < LINES.length; j += 1) {
      if (/^(?:not ok|ok) \d+/.test(LINES[j])) break;
      detail.push(LINES[j]);
      if (detail.length >= 60) break;
    }
    failedCases.push({ name: nm[1].trim(), detail });
  }
}

console.log('=== 全量测试汇总 ===');
for (const s of summary) console.log(s);
if (failedCases.length) {
  console.log('');
  console.log('=== 失败的用例 ===');
  for (const f of failedCases.slice(0, 20)) {
    console.log(`✖ ${f.name}`);
    // tap 的 error 段：取 error: 之后的内容，压掉缩进和空行，最多 12 行
    const body = f.detail.join('\n');
    const errAt = body.search(/^\s*error:\s*/m);
    const raw = errAt >= 0 ? body.slice(errAt) : body;
    const cleaned = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s{2,4}/, '').trimEnd())
      .filter((l, idx, arr) => l.trim() !== '' || (idx > 0 && arr[idx - 1].trim() !== ''))
      .slice(0, 14);
    for (const l of cleaned) console.log(`   ${l}`);
    console.log('');
  }
}

const failNum = Number(
  (out.match(/(?:\u2139|#)\s+fail\s+(\d+)/) || [])[1] || 0,
);
if (r.error) {
  console.error(`测试进程没有正常结束：${r.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n测试文件：${files.length} 个`);
  process.exitCode = (r.status ?? 1) || failNum ? 1 : 0;
}
