#!/usr/bin/env node
/**
 * plugins/nexi/launch.mjs —— Claude Code 插件启动 MCP 时的垫脚。
 *
 * 为什么不直接在 .mcp.json 里写 `npx -y agentdeck-super mcp`：
 *   ① 每次会话启动都要问一次 npm（首次几秒，断网直接起不来）
 *   ② 用户可能已经用 `npx agentdeck-super --all` 装过固定目录，
 *      那份是本地副本，又快又不怕断网 —— 没理由不用
 *
 * 所以这里的顺序是：
 *   已装固定目录 → 直接用它的启动器（离线可用）
 *   没装         → 回退 npx（首次会下载，之后再快）
 *
 * 两条路都把参数原样透传，stdio 也原样透传 —— 对 MCP 来说 stdin/stdout
 * 就是协议通道，任何缓冲或重定向都会让握手失败。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const passthrough = process.argv.slice(2);

/** 与 lib/installer.js 的 defaultHome() 保持同一套规则，别各写一份。 */
function installHome() {
  const os = platform();
  if (os === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(local, 'Nexi');
  }
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Nexi');
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdg, 'nexi');
}

const stable = join(installHome(), 'bin', 'nexi.mjs');
const useLocal = existsSync(stable);

const child = useLocal
  ? spawn(process.execPath, [stable, ...passthrough], { stdio: 'inherit', windowsHide: true })
  : spawn('npx', ['-y', 'agentdeck-super', ...passthrough], {
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32', // Windows 上 npx 是 .cmd 垫片，不开 shell 找不到
  });

child.on('error', (err) => {
  process.stderr.write(`[nexi] 启动失败：${err.message}\n`);
  process.stderr.write(`[nexi] 已试：${useLocal ? stable : 'npx -y agentdeck-super'}\n`);
  process.stderr.write('[nexi] 先跑一次 `npx -y agentdeck-super --all` 装上固定目录。\n');
  process.exit(127);
});

child.on('exit', (code, signal) => {
  // 被信号杀掉时（宿主关闭）用 0 退出，别让宿主以为插件崩了
  process.exit(signal ? 0 : code ?? 0);
});
