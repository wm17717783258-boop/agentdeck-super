// SPDX-License-Identifier: Apache-2.0
/**
 * 平台解析：把「这台机器是哪个系统」压缩成一个可注入的上下文对象。
 *
 * 为什么要有这一层：
 *   Nexi 的产物只有一个（纯 Node ESM、零原生依赖，npm 上同一个 tarball）。
 *   真正跟系统有关的只有一件事 —— **别人家的 App 把配置文件放在哪**。
 *   那是宿主的选择，不是我们的分支；我们只负责按表查对。
 *
 * 所以这里不写「Windows 版 / macOS 版」，只写三张表：
 *   win32   %APPDATA%            → C:\Users\x\AppData\Roaming
 *   darwin  ~/Library/Application Support
 *   linux   $XDG_CONFIG_HOME 或 ~/.config
 *
 * ctx 可注入，测试就能在这台 Windows 上把 darwin / linux 的路径算出来核对，
 * 不用等一台 Mac 才能发现 "~/AppData/Roaming" 这种鬼东西。
 */

import { homedir } from 'node:os';
import { posix as posixPath, win32 as winPath } from 'node:path';

/** 取一份平台上下文。参数只为测试注入，正常调用不传。 */
export function platformCtx(over = {}) {
  return {
    platform: over.platform || process.platform,
    home: over.home || homedir(),
    env: over.env || process.env,
  };
}

export function isWindows(ctx) {
  return ctx.platform === 'win32';
}

/**
 * 按目标系统拼路径。
 * 注意：这里刻意用 winPath / posixPath，而不是全局 path ——
 * 在 Windows 上算 darwin 路径时，全局 path.join 会吐出反斜杠，测试就假了。
 */
export function pjoin(ctx, ...parts) {
  const clean = parts.filter((p) => p !== undefined && p !== null && p !== '');
  return isWindows(ctx) ? winPath.join(...clean) : posixPath.join(...clean);
}

/**
 * 用户级「应用配置」根目录：
 *   Windows  %APPDATA%（缺省落到 ~\AppData\Roaming）
 *   macOS    ~/Library/Application Support
 *   Linux    $XDG_CONFIG_HOME（缺省 ~/.config）
 * Claude Desktop / VS Code / Cline 都吃这一套。
 */
export function configRoot(ctx) {
  if (isWindows(ctx)) {
    return ctx.env.APPDATA || pjoin(ctx, ctx.home, 'AppData', 'Roaming');
  }
  if (ctx.platform === 'darwin') {
    return pjoin(ctx, ctx.home, 'Library', 'Application Support');
  }
  return ctx.env.XDG_CONFIG_HOME || pjoin(ctx, ctx.home, '.config');
}

/**
 * `~/.config` 语义的根。Zed 在 macOS 上也读这里（不是 Application Support），
 * 所以它不能复用 configRoot。
 */
export function dotConfigRoot(ctx) {
  if (isWindows(ctx)) return configRoot(ctx);
  return ctx.env.XDG_CONFIG_HOME || pjoin(ctx, ctx.home, '.config');
}

/**
 * XDG 语义的根：**三系统统一** `$XDG_CONFIG_HOME` 或 `~/.config`。
 * OpenCode / Kilo CLI / Crush 这类命令行 Agent 在 Windows 上也读这里，
 * 不能跟着 %APPDATA% 走 —— 跟着走就会写到一个它们永远不看的地方。
 */
export function xdgRoot(ctx) {
  return ctx.env.XDG_CONFIG_HOME || pjoin(ctx, ctx.home, '.config');
}

/** `~` 语义的根。Cursor / Windsurf / Codex / OpenCode 等都把配置丢在家目录下。 */
export function homePath(ctx, ...parts) {
  return pjoin(ctx, ctx.home, ...parts);
}
