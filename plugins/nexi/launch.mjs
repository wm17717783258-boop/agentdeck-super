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
 *   已装固定目录、且不比插件旧  → 直接用它的启动器（离线可用）
 *   没装 / 装了但老旧           → 走 npm 拿新版（失败再退回本地那份）
 *
 * 为什么必须比版本：插件走 git，固定目录走 npm，两条路会脱节。
 * 用户昨天 `--all` 装的是 1.11.12，今天从市场装了 1.11.15 的插件，
 * 这里若无脑用本地那份，宿主跑的还是 1.11.12 的逻辑 —— 面板写新、行为是旧，
 * 多设备配对这类新能力会当场失灵，而报错看起来像"网络问题"。
 *
 * 两条路都把参数原样透传，stdio 也原样透传 —— 对 MCP 来说 stdin/stdout
 * 就是协议通道，任何缓冲或重定向都会让握手失败。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const passthrough = process.argv.slice(2);
const PKG = 'agentdeck-super';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

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

/** 只比 x.y.z 三段；读不出来一律当 0，不抛。 */
function verParts(v) {
  return String(v || '').split(/[.\-+]/).slice(0, 3).map((n) => {
    const x = Number.parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
}

/** a 是否比 b 旧。缺版本号时返回 false（说不清就不拦）。 */
function isOlder(a, b) {
  if (!a || !b) return false;
  const x = verParts(a);
  const y = verParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

const home = installHome();
const stable = join(home, 'bin', 'nexi.mjs');
const hasLocal = existsSync(stable);
const localVersion = String((readJson(join(home, 'current.json')) || {}).version || '');
const pluginVersion = String((readJson(join(HERE, '.claude-plugin', 'plugin.json')) || {}).version || '');
const stale = hasLocal && isOlder(localVersion, pluginVersion);
const useLocal = hasLocal && !stale;

// 自检用：不真的起进程，只报这次会选哪条路。测试靠它，不带这个变量时无副作用。
if (process.env.NEXI_PLUGIN_DRY) {
  process.stdout.write(`source=${useLocal ? 'local' : 'npx'} local=${localVersion || '-'} plugin=${pluginVersion || '-'}\n`);
  process.exit(0);
}

function startLocal() {
  return spawn(process.execPath, [stable, ...passthrough], { stdio: 'inherit', windowsHide: true });
}

function startNpx() {
  return spawn('npx', ['-y', PKG, ...passthrough], {
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32', // Windows 上 npx 是 .cmd 垫片，不开 shell 找不到
  });
}

if (stale) {
  process.stderr.write(
    `[nexi] 本机固定目录是 ${localVersion}，插件是 ${pluginVersion} —— 这次从 npm 取新版。`
    + '想把它固定下来：npx -y agentdeck-super --all\n',
  );
}

const child = useLocal ? startLocal() : startNpx();
let fellBack = false;

child.on('error', (err) => {
  // 走 npm 那条约不到（断网 / 代理）时，退回本地旧版：能跑总比起不来强。
  if (!useLocal && hasLocal && !fellBack) {
    fellBack = true;
    process.stderr.write(
      `[nexi] 从 npm 取新版失败（${err.message}），先用本机这份 ${localVersion}。`
      + '版本可能偏旧，联网后跑一次 npx -y agentdeck-super --all。\n',
    );
    const local = startLocal();
    local.on('error', (e2) => {
      process.stderr.write(`[nexi] 本机那份也起不来：${e2.message}\n`);
      process.exit(127);
    });
    local.on('exit', (code, signal) => process.exit(signal ? 0 : code ?? 0));
    return;
  }
  if (fellBack) return;
  process.stderr.write(`[nexi] 启动失败：${err.message}\n`);
  process.stderr.write(`[nexi] 已试：${useLocal ? stable : `npx -y ${PKG}`}\n`);
  process.stderr.write(`[nexi] 先跑一次 \`npx -y ${PKG} --all\` 装上固定目录。\n`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  if (fellBack) return; // 交给退路那一路收尾
  // 被信号杀掉时（宿主关闭）用 0 退出，别让宿主以为插件崩了
  process.exit(signal ? 0 : code ?? 0);
});
