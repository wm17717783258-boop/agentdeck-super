// SPDX-License-Identifier: Apache-2.0
/**
 * 配置文件的编码与换行。
 *
 * 为什么值得单独一层：
 *   同一个 JSON，在 Windows 记事本里存一次就带 UTF-8 BOM，在 PowerShell 5.1
 *   里重定向一次就变成 UTF-16LE，在 Linux 的 vim 里又是纯 UTF-8 + LF。
 *   这些都不是「我们分系统」，而是**用户手里的文件本来就长这样**。
 *   插件要做的只有三件：
 *
 *     ① 读得懂：BOM 剥掉再解析，不让 `Unexpected token \uFEFF` 吓到用户；
 *     ② 不改味：原来有 BOM，写回去还带 BOM；原来是 CRLF，写回去还是 CRLF。
 *        否则一次「装个 MCP」会把整个配置文件变成另一种编码，
 *        git diff 全红，隔壁用 GBK 读它的老工具直接乱码；
 *     ③ 说人话：UTF-16 / 二进制文件明确告诉用户是什么、怎么转，
 *        而不是抛一个 JSON 语法错。
 */

import { existsSync, readFileSync } from 'node:fs';

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

/**
 * 嗅探一段字节的编码。只认「配置文件世界里真实存在」的几种。
 * 返回 { encoding, bom, label }：
 *   utf8 / utf8-bom / utf16le / utf16be / binary
 */
export function sniffEncoding(buf) {
  if (!buf || buf.length === 0) return { encoding: 'utf8', bom: '', label: 'UTF-8（空文件）' };
  if (buf.length >= 3 && buf.subarray(0, 3).equals(BOM_UTF8)) {
    return { encoding: 'utf8-bom', bom: '\uFEFF', label: 'UTF-8 with BOM' };
  }
  if (buf.length >= 2 && buf.subarray(0, 2).equals(BOM_UTF16LE)) {
    return { encoding: 'utf16le', bom: '', label: 'UTF-16 LE' };
  }
  if (buf.length >= 2 && buf.subarray(0, 2).equals(BOM_UTF16BE)) {
    return { encoding: 'utf16be', bom: '', label: 'UTF-16 BE' };
  }
  // 没有 BOM 的 UTF-16：ASCII 文本会呈现为「字符 + \0」交替，JSON/TOML 里必现。
  // 抽前 512 字节看 NUL 的分布，避免把正常 UTF-8 误判。
  const probe = buf.subarray(0, Math.min(buf.length, 512));
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < probe.length; i += 1) {
    if (probe[i] === 0) (i % 2 === 0 ? (evenNul += 1) : (oddNul += 1));
  }
  const half = Math.max(1, Math.floor(probe.length / 2));
  if (oddNul > half * 0.6 && evenNul < half * 0.1) return { encoding: 'utf16le', bom: '', label: 'UTF-16 LE（无 BOM）' };
  if (evenNul > half * 0.6 && oddNul < half * 0.1) return { encoding: 'utf16be', bom: '', label: 'UTF-16 BE（无 BOM）' };
  // 含 NUL 又不是 UTF-16：二进制，别当配置改
  if (probe.includes(0)) return { encoding: 'binary', bom: '', label: '二进制' };
  return { encoding: 'utf8', bom: '', label: 'UTF-8' };
}

/** 换行风格。空文件按平台无关的 LF 处理（新建文件不该带 CRLF）。 */
export function detectEol(text) {
  return /\r\n/.test(String(text)) ? '\r\n' : '\n';
}

/** 把整段文本统一成指定换行。 */
export function toEol(text, eol) {
  const norm = String(text).replace(/\r\n/g, '\n');
  return eol === '\n' ? norm : norm.replace(/\n/g, eol);
}

/** 给用户看的修复指引：不同编码怎么转回来。 */
export function encodingHint(encoding) {
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    return '这个文件是 UTF-16 编码，MCP 宿主只认 UTF-8。用 VS Code / 记事本打开 → 另存为 → 编码选 UTF-8，再重试。';
  }
  if (encoding === 'binary') {
    return '这个文件看起来是二进制，不是文本配置。确认路径是否给错了。';
  }
  return '';
}

/**
 * 读一个配置文件，带着它的编码与换行一起回来。
 *
 * 返回：
 *   { ok, exists, text, bom, eol, encoding, label, error }
 *   text 已剥掉 BOM（bom 单独带），eol 是原文的换行风格。
 *   ok=false 时 error 是一句能直接给用户看的话（含怎么修）。
 */
export function readConfigText(file) {
  if (!file || !existsSync(file)) {
    return { ok: true, exists: false, text: '', bom: '', eol: '\n', encoding: 'utf8', label: 'UTF-8（新建）', error: '' };
  }
  let buf;
  try {
    buf = readFileSync(file);
  } catch (err) {
    return { ok: false, exists: true, text: '', bom: '', eol: '\n', encoding: 'unknown', label: '读不了', error: `读不了这个文件：${err.code || err.message}` };
  }
  const sniffed = sniffEncoding(buf);
  if (sniffed.encoding === 'utf16le' || sniffed.encoding === 'utf16be' || sniffed.encoding === 'binary') {
    return {
      ok: false,
      exists: true,
      text: '',
      bom: '',
      eol: '\n',
      encoding: sniffed.encoding,
      label: sniffed.label,
      error: `${file} 是 ${sniffed.label}，不能直接改。${encodingHint(sniffed.encoding)}`,
    };
  }
  // utf8 / utf8-bom：Node 的 utf8 解码遇到 BOM 会留成 \uFEFF，剥掉再交给解析器。
  let text = buf.toString('utf8');
  let bom = sniffed.bom;
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
    bom = '\uFEFF';
  }
  return { ok: true, exists: true, text, bom, eol: detectEol(text), encoding: sniffed.encoding, label: sniffed.label, error: '' };
}

export default { sniffEncoding, detectEol, toEol, encodingHint, readConfigText };
