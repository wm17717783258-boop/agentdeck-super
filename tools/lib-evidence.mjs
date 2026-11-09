/**
 * tools/lib-evidence.mjs —— 验收脚本共用的两个小事（抽出来避免每份脚本各写一遍）
 *
 * 1) workRoot(tag)：把原本硬编码的演示路径换成"系统临时目录下的一个独立沙箱"。
 *    为什么必须换：那些演示路径只在那台开发机上有；别人（以及你另一台电脑）跑同一个
 *    脚本会直接失败在"目录不存在"，看起来像功能坏了，其实是路径写死了。
 *
 * 2) Evidence 类：统一"通过/失败计数 + 证据落盘"，让每个脚本产出的 txt 长得一样，
 *    便于被人和 verify-acceptance.mjs 一起读。
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = join(HERE, '..');

/**
 * 造一个独立的工作根目录。
 * 优先用环境变量 NEXI_EVIDENCE_ROOT（让 CI 或你指定位置），否则用系统临时目录。
 * 不主动删除——脚本自己决定什么时候清（有些要留证据）。
 */
export function workRoot(tag = 'nexi') {
  const base = process.env.NEXI_EVIDENCE_ROOT
    ? join(String(process.env.NEXI_EVIDENCE_ROOT), tag)
    : join(tmpdir(), `nexi-${tag}-${process.pid}`);
  mkdirSync(base, { recursive: true });
  return base;
}

/** 清掉一个工作根（脚本收尾用）。 */
export function cleanRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 清不掉不影响结论（可能是文件被占用）
  }
}

/**
 * 从证据文本里取"真正的断言数"。
 *
 * 证据文件通常有三种写法：
 *   1. Evidence.finish()：结论：26 项通过，0 项失败
 *   2. M4 / visit-installed：**结论：17 项断言全过——...
 *   3. 只列断言行：  ✅ xxx / ❌ xxx（可能没有结论）
 *
 * 不能直接数全文 ✅：正文表格、命令回显里也会出现 ✅，
 * M4 就因此把 17 条断言数成 22 个字符。优先认结论，其次只数
 * 独立的断言列表行；只有前两者都没有时才退回全文计数。
 */
export function parseEvidenceCounts(text = '') {
  const src = String(text);
  const allPass = src.match(/结论[：:]\s*(\d+)\s*项断言全过/);
  if (allPass) return { pass: Number(allPass[1]), fail: 0, source: 'conclusion' };

  const partial = src.match(/结论[：:]\s*(\d+)\s*项断言里\s*(\d+)\s*项没过/);
  if (partial) {
    const total = Number(partial[1]);
    const fail = Number(partial[2]);
    return { pass: Math.max(0, total - fail), fail, source: 'conclusion' };
  }

  const standard = src.match(/结论[：:]\s*(\d+)\s*项通过[，,]\s*(\d+)\s*项失败/);
  if (standard) {
    return { pass: Number(standard[1]), fail: Number(standard[2]), source: 'conclusion' };
  }

  // 老式测试日志没有中文结论，但有 "pass 1018 / fail 0" 汇总。
  // 必须先认这个，否则正文测试名里偶尔出现的 ✅ 会被误当成一条断言。
  const summary = src.match(/\bpass\s+(\d+)\s*\/\s*fail\s+(\d+)\b/);
  if (summary) {
    return { pass: Number(summary[1]), fail: Number(summary[2]), source: 'summary' };
  }

  // 断言区：优先只看 "## …断言…" 到下一个二级标题之间，
  // 这样标题上方表格/回显里的 ✅ 不会被算进来。
  let scope = src;
  const heading = src.match(/^#{2,3}[^\n]*断言[^\n]*$/m);
  if (heading) {
    const rest = src.slice(heading.index + heading[0].length);
    const next = rest.search(/^##\s/m);
    scope = next === -1 ? rest : rest.slice(0, next);
  }

  const lines = scope.split(/\r?\n/);
  const checkLine = (line, mark) => new RegExp(`^\\s*(?:[-*]\\s*)?${mark}`).test(line);
  const pass = lines.filter((line) => checkLine(line, '✅')).length;
  const fail = lines.filter((line) => checkLine(line, '❌')).length;
  if (pass || fail) return { pass, fail, source: heading ? 'section' : 'lines' };

  // 表格型证据：一行一条断言，结果在单元格里（| ... | ✅ | ... |）。
  const tableLines = lines.filter((line) => /^\s*\|/.test(line));
  const tablePass = tableLines.reduce((n, line) => n + (line.match(/✅/g) || []).length, 0);
  const tableFail = tableLines.reduce((n, line) => n + (line.match(/❌/g) || []).length, 0);
  if (tablePass || tableFail) {
    return { pass: tablePass, fail: tableFail, source: 'table' };
  }

  // 兜底：老证据可能把多个断言塞在一行里
  return {
    pass: (scope.match(/✅/g) || []).length,
    fail: (scope.match(/❌/g) || []).length,
    source: 'chars',
  };
}

/**
 * 证据收集器：每个验收脚本都用它，产出格式统一的 txt。
 *
 * 用法：
 *   const ev = new Evidence('readonly-core', '1.10.0');
 *   ev.say('【第 1 步】…'); ev.ok('某项', '细节'); ev.bad('某项', '原因');
 *   ev.finish();   // 写文件 + 设置退出码
 */
export class Evidence {
  constructor(name, version, { record = false } = {}) {
    this.name = name;
    this.version = version;
    this.record = record;
    this.lines = [];
    this.pass = 0;
    this.fail = 0;
  }

  say(text = '') {
    this.lines.push(text);
  }

  ok(label, detail = '') {
    this.pass += 1;
    this.lines.push(`  ✅ ${label}${detail ? ` —— ${detail}` : ''}`);
  }

  bad(label, detail = '') {
    this.fail += 1;
    this.lines.push(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }

  chk(cond, label, detail = '') {
    if (cond) this.ok(label, detail);
    else this.bad(label, detail);
    return Boolean(cond);
  }

  get file() {
    return join(PKG, 'docs', 'evidence', `${this.name}-${this.version}.txt`);
  }

  finish({ write = this.record } = {}) {
    this.lines.push('');
    this.lines.push('='.repeat(66));
    this.lines.push(`结论：${this.pass} 项通过，${this.fail} 项失败`);
    if (write) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, `${this.lines.join('\n')}\n`, 'utf8');
        this.lines.push(`证据已写入：${this.file}`);
      } catch (err) {
        this.lines.push(`证据写盘失败（不影响验收结论）：${err?.message || err}`);
      }
    }
    process.stdout.write(`${this.lines.join('\n')}\n`);
    process.exitCode = this.fail ? 1 : 0;
    return { pass: this.pass, fail: this.fail };
  }
}

export default { PKG, workRoot, cleanRoot, parseEvidenceCounts, Evidence };
