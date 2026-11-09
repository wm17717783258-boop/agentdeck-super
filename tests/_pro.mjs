/**
 * tests/_pro.mjs —— 判断闭源商业层（pro/）是否就位。
 *
 * 为什么测试需要知道这个：
 *   `deck_meeting` / `deck_market` / `deck_sync` 的**实现**属于 `pro/`（闭源商业层）。
 *   开源版本来就不带这些实现，所以两种部署形态都是合法的：
 *     · 完整版（装了 pro/）：23 个工具，开会/买皮肤/多设备同步都能真跑
 *     · 开源版（没装 pro/）：22 个工具，deck_meeting 不注册，market/sync 调用时如实降级
 *
 * 因此测试要做的是**反映这两种形态**，而不是把「开源版」判成错误。
 * 这不是放松标准：该跑的断言一条不少，只是把「依赖商业层」的那几条按形态分支。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 商业层是否就位（以 meeting 工具为准，它是唯一会改变工具数量的模块）。 */
export function hasPro() {
  return existsSync(join(ROOT, 'pro', 'meeting', 'tool.js'));
}

/** 只有装了商业层才出现的工具名。清单类断言用这个过滤。 */
export const PRO_ONLY_TOOLS = Object.freeze(['deck_meeting']);

/** 按形态过滤期望的工具清单：没有 pro 就把 pro 专属工具去掉。 */
export function expectTools(names) {
  const list = Array.isArray(names) ? names : [];
  return hasPro() ? list.slice() : list.filter((n) => !PRO_ONLY_TOOLS.includes(n));
}
