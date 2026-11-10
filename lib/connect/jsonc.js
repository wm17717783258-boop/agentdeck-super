// SPDX-License-Identifier: Apache-2.0
/**
 * JSONC —— 带注释的 JSON。
 *
 * 为什么必须有这一层：
 *   VS Code 的 `mcp.json`、CodeBuddy 的 `.mcp.json`、Continue 的部分配置文件
 *   官方都允许 `// 注释` 和尾逗号（JSONC）。用户手写时也几乎一定会有注释。
 *
 *   在这之前，我们用的是 `JSON.parse`：一份完全合法的 JSONC 会被判成
 *   「不是合法 JSON，拒绝改写」，体检里还会显示 broken。用户看到的是
 *   「这工具连我的配置文件都读不懂」。
 *
 * 两条原则：
 *   ① 读得懂：注释、尾逗号都剥掉再解析，审计/预览照常工作；
 *   ② 不毁原文：写回时**绝不**整份重排 —— 那会把用户所有注释抹掉。
 *      所以 hasJsonc() 为真且真的要改时，调用方应当拒绝写盘并给出手工方案。
 *      「读」和「写」在这里必须区别对待。
 */

/**
 * 去掉注释与尾逗号，得到标准 JSON 文本。
 * 只处理 JSONC 规范内的东西：`//`、`/* *\/`、尾逗号。字符串里的内容原样保留。
 */
export function stripJsonc(src) {
  const text = String(src);
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        // 转义：把下一个字符原样带上，别让它被当成引号
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  // 尾逗号：`,` 后面只跟空白与 } / ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 这份文本是不是「JSONC 而不是标准 JSON」（有注释或有尾逗号）。 */
export function hasJsonc(src) {
  const text = String(src);
  if (!text.trim()) return false;
  const compact = (s) => s.replace(/\s+/g, '');
  return compact(stripJsonc(text)) !== compact(text);
}

/**
 * 解析 JSONC。失败时抛出与 JSON.parse 同形状的错误，调用方的报错文案不用改。
 */
export function parseJsonc(src) {
  return JSON.parse(stripJsonc(src));
}

export default { stripJsonc, hasJsonc, parseJsonc };
