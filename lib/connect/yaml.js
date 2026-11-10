// SPDX-License-Identifier: Apache-2.0
/**
 * 最小 YAML 编辑器 —— 只做两件事：在某个顶层 key 下加/更新一项、删掉我们加的那一项。
 *
 * 为什么不引 yaml 包：
 *   ① 这个产品的硬要求是「零运行时依赖、离线能起」。为了两个宿主多拖一棵依赖树，
 *      等于让所有用户在装插件时多下一个包。
 *   ② 更重要：**整份重新序列化会毁掉用户的手写文件**。注释、锚点、空行、键顺序、
 *      引号风格全会丢，diff 出来是一片红。宿主配置是用户自己也在编辑的东西，
 *      我们不能把它变成"我们生成的"。
 *
 * 所以这里不解析整份 YAML，只做**按行切片**：
 *   · 找到顶层 `key:` 那一行，按缩进算出它的块范围；
 *   · 在块尾插一段带哨兵注释的子项（map 风格 `nexi:` 或 seq 风格 `- name: nexi`）；
 *   · 卸载时按哨兵把这一段整块剪掉，块空了就连 key 一起删。
 *
 * 覆盖面（够用，且都是官方文档里真实出现的写法）：
 *   · 块状 map / 块状 seq / 流式数组 `args: ["a", "b"]` / 双引号标量与布尔
 *   · CRLF 保留、文件末尾无换行也能处理、BOM 会原样留着
 *
 * 明确不处理（遇到会拒写而不是猜）：
 *   · `extensions: { ... }` 这种非空的行内 map —— 报 conflict，让用户手改或 --force 走另一条路
 *   · 锚点/别名、多文档 `---` 分隔、tab 缩进（YAML 本身就不许）
 */

import { existsSync, readFileSync } from 'node:fs';

export const SENT_START = '# >>> nexi (managed by nexi, 删这一段即移除) >>>';
export const SENT_END = '# <<< nexi <<<';

const isBlank = (l) => /^[ \t]*$/.test(l);
const isComment = (l) => /^[ \t]*#/.test(l);

/** 缩进宽度（tab 按 2 算，只用于比较大小，不用于还原）。 */
function indentOf(line) {
  const m = /^[ \t]*/.exec(line);
  return m[0].replace(/\t/g, '  ').length;
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** 行内注释去掉（只处理 ` #` 之前的内容；引号里的 # 不管，我们的值里没有）。 */
function stripInlineComment(s) {
  return String(s).replace(/\s+#.*$/, '').trim();
}

/**
 * 找顶层 key 的块范围。
 * @returns {{keyIndex:number,start:number,end:number,last:number,inline:string}|null}
 *   start/end 是块的子行区间 [start, end)；last 是最后一个有内容的子行下标。
 */
export function findTopBlock(lines, key) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) !== 0) continue;
    if (isBlank(line) || isComment(line) || line.trimStart().startsWith('-')) continue;
    const m = /^([^:]+?)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    if (unquote(m[1]) !== key) continue;
    const inline = stripInlineComment(m[2]);
    let last = i;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (isBlank(l)) continue;
      // 顶格注释视为下一段的注释，不算进块里（否则会把别人的注释卷进插入点之后）
      if (isComment(l) && indentOf(l) === 0) break;
      if (indentOf(l) === 0) break;
      last = j;
    }
    return { keyIndex: i, start: i + 1, end: j, last, inline };
  }
  return null;
}

/** 我们的哨兵区间（含首尾两行）。 */
export function sentinelRange(lines) {
  const s = lines.findIndex((l) => l.trim() === SENT_START);
  if (s === -1) return null;
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i].trim() === SENT_END) return { start: s, endExclusive: i + 1 };
  }
  // 只有头没有尾 —— 文件被人手改坏了，按"从哨兵到文件末尾"处理，别留半截
  return { start: s, endExclusive: lines.length };
}

/** map 风格：块里 `name:` 这一项的区间。 */
function mapChildRange(lines, block, name) {
  for (let i = block.start; i < block.end; i++) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    const m = /^([ \t]*)([^:#]+?)[ \t]*:/.exec(lines[i]);
    if (!m) continue;
    if (unquote(m[2]) !== name) continue;
    const ci = indentOf(lines[i]);
    let last = i;
    for (let j = i + 1; j < block.end; j++) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]) <= ci) break;
      last = j;
    }
    return { start: i, end: last + 1, indent: ci };
  }
  return null;
}

/** seq 风格：块里所有 `- ` 开头的项的区间。 */
function seqItems(lines, block) {
  const items = [];
  for (let i = block.start; i < block.end; i++) {
    const m = /^([ \t]*)-([ \t]+|$)/.exec(lines[i]);
    if (!m) continue;
    const ci = indentOf(lines[i]);
    let last = i;
    for (let j = i + 1; j < block.end; j++) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]) <= ci) break;
      last = j;
    }
    items.push({ start: i, end: last + 1, indent: ci });
  }
  return items;
}

/** seq 风格：按 name 找项（Continue 的 mcpServers 是 [{name, command, ...}]）。 */
function seqItemByName(lines, block, name) {
  // 列表项的 name 可能写在同一行的 `- name: x`，也可能另起一行 `name: x`
  const re = new RegExp(`^[ \\t]*(?:-[ \\t]+)?name[ \\t]*:[ \\t]*['"]?${escRe(name)}['"]?[ \\t]*$`);
  for (const item of seqItems(lines, block)) {
    for (let i = item.start; i < item.end; i++) {
      if (re.test(lines[i])) return item;
    }
  }
  return null;
}

/** 块里第一行内容的缩进 —— 沿用用户自己的缩进风格（2 空格还是 4 空格）。 */
function inferChildIndent(lines, block) {
  for (let i = block.start; i < block.end; i++) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    return indentOf(lines[i]);
  }
  return 2;
}

function buildBlock(bodyLines, indent) {
  const pad = ' '.repeat(indent);
  return [
    `${pad}${SENT_START}`,
    ...bodyLines.map((l) => (l === '' ? '' : pad + l)),
    `${pad}${SENT_END}`,
  ];
}

function splitDoc(text) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const norm = body.replace(/\r\n/g, '\n');
  const endsWithNewline = norm.endsWith('\n');
  const lines = norm === '' ? [] : norm.replace(/\n$/, '').split('\n');
  return { bom, eol, lines, endsWithNewline };
}

function joinDoc({ bom, eol, lines }) {
  return `${bom}${lines.join(eol)}${eol}`;
}

/**
 * 在 `key` 块下写入/更新我们的子项。
 *
 * @param {string} text 原文件内容（可为空串）
 * @param {object} opts
 * @param {string} opts.key    顶层 key，例如 'extensions' / 'mcpServers'
 * @param {'map'|'seq'} [opts.style] 子项是 map 的成员还是 seq 的一项
 * @param {string} [opts.name] 子项名（seq 风格时匹配 `name:` 字段）
 * @param {string[]} opts.body 子项内容（相对缩进 0 的行）
 * @param {boolean} [opts.force] 已有同名但不是我写的，是否覆盖
 * @returns {{ok:boolean,text?:string,changed?:boolean,conflict?:string}}
 */
export function upsertYamlChild(text, { key, style = 'map', name = 'nexi', body = [], force = false } = {}) {
  const doc = splitDoc(String(text ?? ''));
  const { lines } = doc;

  // ① 我们已经写过（有哨兵）→ 原地重建，缩进沿用上一版
  const sent = sentinelRange(lines);
  if (sent) {
    const firstChild = lines[sent.start + 1] ?? '';
    const indent = indentOf(firstChild) || 2;
    lines.splice(sent.start, sent.endExclusive - sent.start, ...buildBlock(body, indent));
    const out = joinDoc(doc);
    return { ok: true, text: out, changed: out !== String(text ?? '') };
  }

  let block = findTopBlock(lines, key);

  // ② 顶层 key 存在但是行内 map/标量 → 不猜，拒写（让人工决定）
  if (block && block.inline && block.inline !== '{}' && block.inline !== '~' && block.inline !== 'null') {
    return { ok: false, conflict: `${key} 是行内写法（${block.inline.slice(0, 40)}），不自动改写` };
  }
  if (block && (block.inline === '{}' || block.inline === '~' || block.inline === 'null')) {
    lines[block.keyIndex] = `${key}:`;
    block = findTopBlock(lines, key);
  }

  // ③ 块里已有同名项但不是我们写的 → 默认不动
  if (block) {
    const existing = style === 'seq' ? seqItemByName(lines, block, name) : mapChildRange(lines, block, name);
    if (existing) {
      if (!force) {
        return { ok: false, conflict: `${key} 下已有 ${name}（不是 nexi 写的）；加 --force 才会覆盖` };
      }
      lines.splice(existing.start, existing.end - existing.start, ...buildBlock(body, existing.indent));
      const out = joinDoc(doc);
      return { ok: true, text: out, changed: out !== String(text ?? ''), forced: true };
    }
    const indent = style === 'seq' ? inferChildIndent(lines, block) : inferChildIndent(lines, block);
    lines.splice(block.last + 1, 0, ...buildBlock(body, indent));
    const out = joinDoc(doc);
    return { ok: true, text: out, changed: out !== String(text ?? '') };
  }

  // ④ 连 key 都没有 → 末尾补一个完整的块
  if (lines.length && !isBlank(lines[lines.length - 1])) lines.push('');
  lines.push(`${key}:`);
  lines.push(...buildBlock(body, 2));
  const out = joinDoc(doc);
  return { ok: true, text: out, changed: out !== String(text ?? '') };
}

/**
 * 删掉我们写的那一项（只删我们的；块空了连 key 一起删）。
 * @returns {{ok:true,text:string,changed:boolean}}
 */
export function removeYamlChild(text, { key, style = 'map', name = 'nexi' } = {}) {
  const doc = splitDoc(String(text ?? ''));
  const { lines } = doc;
  const original = String(text ?? '');

  const sent = sentinelRange(lines);
  if (sent) {
    lines.splice(sent.start, sent.endExclusive - sent.start);
  } else {
    const block = findTopBlock(lines, key);
    if (!block) return { ok: true, text: original, changed: false };
    const item = style === 'seq' ? seqItemByName(lines, block, name) : mapChildRange(lines, block, name);
    if (!item) return { ok: true, text: original, changed: false };
    lines.splice(item.start, item.end - item.start);
  }

  // 收尾：这个 key 底下已经没有实际内容了 → 把空壳一起删掉。
  // （空 `mcpServers:` 对宿主是 no-op，留着只会让人以为还有东西。）
  const after = findTopBlock(lines, key);
  if (after && after.inline === '' && !lines.slice(after.start, after.end).some((l) => !isBlank(l) && !isComment(l))) {
    let stop = after.keyIndex + 1;
    while (stop < lines.length && isBlank(lines[stop])) stop += 1;
    lines.splice(after.keyIndex, stop - after.keyIndex);
  }

  const out = joinDoc(doc);
  return { ok: true, text: out, changed: out !== original };
}

/** YAML 标量：JSON 字符串就是合法的 YAML 双引号标量（反斜杠会被正确转义）。 */
export function yamlStr(v) {
  return JSON.stringify(String(v ?? ''));
}

/** 流式数组：`["a", "b"]` —— 官方文档里就是这么写的，读起来比块状短。 */
export function yamlFlowArray(list) {
  return `[${(list || []).map((v) => yamlStr(v)).join(', ')}]`;
}

/** 流式空 map。 */
export const YAML_EMPTY_MAP = '{}';

/**
 * 计划写入：算出「写完之后文件长什么样」，不落盘。
 * 落盘由 hosts.js 统一做（备份 + 原子替换），这里只管文本。
 */
export function planYaml(file, { key, style, name = 'nexi', body, force = false }) {
  const exists = existsSync(file);
  const warnings = [];
  const text = exists ? readFileSync(file, 'utf8') : '';
  if (!exists) warnings.push(`${file} 不存在，将新建`);
  const r = upsertYamlChild(text, { key, style, name, body, force });
  if (!r.ok) return { ok: false, warnings: [...warnings, r.conflict], path: file };
  return { ok: true, warnings, unchanged: !r.changed, text: r.text, path: file };
}

/** 卸载计划：算出删除后的文本。 */
export function planYamlRemove(file, { key, style, name = 'nexi' }) {
  if (!existsSync(file)) return { ok: true, changed: false, text: undefined, warnings: [], path: file };
  const text = readFileSync(file, 'utf8');
  const r = removeYamlChild(text, { key, style, name });
  return { ok: true, changed: r.changed, text: r.text, warnings: [], path: file };
}

export default {
  SENT_START,
  SENT_END,
  findTopBlock,
  sentinelRange,
  upsertYamlChild,
  removeYamlChild,
  planYaml,
  planYamlRemove,
  yamlStr,
  yamlFlowArray,
};
