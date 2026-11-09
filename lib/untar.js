/**
 * lib/untar.js —— 纯 JS 的 .tgz 解包（不调外部 tar）
 *
 * 为什么要自己写：
 *   1) Windows 上 `tar` 走的是系统代码页，路径里带中文（"Nexi灵犀-完整项目"）
 *      就会报 `Failed to open archive`——这是真机抓到的，不是猜的。
 *   2) 用户装插件时不一定有 tar（尤其是精简过的 Windows 环境）。
 *   3) 我们要解的是自己的包，格式固定（ustar + gzip），没必要赌外部工具的行为。
 *
 * 支持范围（够用且明确）：
 *   - gzip 压缩的 tar（.tgz / .tar.gz）
 *   - ustar 与 GNU 长文件名（type 'L'）两种扩展头
 *   - 目录、普通文件、PAX 头（type 'x'，只取 path，别的忽略）
 *   - 符号链接/设备文件一律跳过（包是我们自己打的，不该有）
 *
 * 安全：解出来的每个路径都做一次"必须落在目标目录内"校验（挡 ../../ 穿越与绝对路径）。
 * 任何异常都返回 { ok:false, reason }，不抛。
 */

import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

const BLOCK = 512;

/** 读 null 结尾的字符串（tar 头里的字段都是定长 + \0 填充）。 */
function readString(buf, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) end += 1;
  return buf.toString('utf8', offset, end).trim();
}

/** 读八进制数字字段（tar 里长度/模式都是八进制 ASCII）。 */
function readOctal(buf, offset, length) {
  const text = readString(buf, offset, length);
  if (!text) return 0;
  const n = parseInt(text, 8);
  return Number.isFinite(n) ? n : 0;
}

/** 校验目标路径必须落在 root 内，挡 ../ 和绝对路径。 */
function safeJoin(root, memberPath) {
  // Windows 上 tar 里可能是正斜杠；统一转成当前平台分隔符
  const normalized = memberPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (isAbsolute(memberPath)) return null;
  const target = resolve(join(root, normalized));
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    // rel 为空 = 正好是 root 本身，也算越界（不该往 root 里写文件）
    if (rel === '') return null;
    return null;
  }
  return target;
}

/**
 * 解一个 tar 缓冲区（未压缩）到 dir。
 * @returns {{ ok:boolean, files:string[], dirs:string[], skipped:string[], reason?:string }}
 */
export function untarBuffer(buffer, dir) {
  const files = [];
  const dirs = [];
  const skipped = [];
  let offset = 0;
  let pendingLongName = '';

  try {
    mkdirSync(dir, { recursive: true });
    while (offset + BLOCK <= buffer.length) {
      const header = buffer.subarray(offset, offset + BLOCK);
      offset += BLOCK;

      // 全零块 = 归档结束
      if (header.every((b) => b === 0)) break;

      const nameField = readString(header, 0, 100);
      const size = readOctal(header, 124, 12);
      const typeFlag = String.fromCharCode(header[156] || 48);
      const prefix = readString(header, 345, 155);
      const mode = readOctal(header, 100, 8);

      // 数据区按 512 对齐
      const dataStart = offset;
      const dataEnd = dataStart + size;
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      offset = dataEnd + padding;

      if (typeFlag === 'L') {
        // GNU 长文件名：这一块的数据就是下一个条目的真名
        pendingLongName = buffer.toString('utf8', dataStart, dataEnd).replace(/\0+$/, '').trim();
        continue;
      }
      if (typeFlag === 'x' || typeFlag === 'g') {
        // PAX 扩展头：只尝试取 path=，取不到就忽略（我们的包不依赖它）
        const pax = buffer.toString('utf8', dataStart, dataEnd);
        const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(pax);
        if (m) pendingLongName = m[1];
        continue;
      }

      let memberPath = pendingLongName || (prefix ? `${prefix}/${nameField}` : nameField);
      pendingLongName = '';
      if (!memberPath) continue;

      if (typeFlag === '5') {
        const target = safeJoin(dir, memberPath);
        if (!target) {
          skipped.push(`${memberPath}（路径越界）`);
          continue;
        }
        mkdirSync(target, { recursive: true });
        dirs.push(relative(dir, target));
        continue;
      }

      if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '') {
        // 符号链接 / 硬链接 / 设备节点：我们的包不该有，安全起见跳过
        skipped.push(`${memberPath}（类型 ${typeFlag} 不支持）`);
        continue;
      }

      const target = safeJoin(dir, memberPath);
      if (!target) {
        skipped.push(`${memberPath}（路径越界）`);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer.subarray(dataStart, dataEnd));
      if (mode) {
        try { chmodSync(target, mode & 0o777); } catch { /* Windows 上 chmod 基本是空操作 */ }
      }
      files.push(relative(dir, target));
    }
    return { ok: true, files, dirs, skipped };
  } catch (err) {
    return { ok: false, files, dirs, skipped, reason: `${err?.name || 'Error'}: ${err?.message || err}` };
  }
}

/**
 * 解一个 .tgz 文件到 dir（读盘 + gunzip + untar）。
 * @returns {{ ok:boolean, files:string[], dirs:string[], skipped:string[], reason?:string }}
 */
export function extractTgz(tgzPath, dir, { readFile = null } = {}) {
  try {
    const read = typeof readFile === 'function' ? readFile : defaultRead;
    const gz = read(tgzPath);
    const raw = gunzipSync(gz);
    return untarBuffer(raw, dir);
  } catch (err) {
    return {
      ok: false,
      files: [],
      dirs: [],
      skipped: [],
      reason: `解包 ${tgzPath} 失败：${err?.name || 'Error'}: ${err?.message || err}`,
    };
  }
}

/** 默认读盘实现（拆出来是为了让上面的形参遮蔽不影响默认行为）。 */
function defaultRead(file) {
  return readFileSync(file);
}

export default { untarBuffer, extractTgz };
