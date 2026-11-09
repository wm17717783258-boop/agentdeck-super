#!/usr/bin/env node
/**
 * install.mjs —— 一条命令装好 Nexi（固定目录 + 所有已探测宿主）
 *
 * 默认行为（推荐）：
 *   node install.mjs
 *   node install.mjs --all
 *   node install.mjs --bundle .\agentdeck-super-1.11.5.tgz
 *
 * 它不再把源码目录的绝对路径写进宿主配置，而是：
 *   ① 复制到固定目录（Windows 默认 %LOCALAPPDATA%\Nexi）
 *   ② 写稳定启动器 bin/nexi.mjs
 *   ③ 把稳定启动器注册到本机已安装的 Agent
 *   ④ 以后升级只切 current.json，宿主路径不变
 *
 * 旧行为仍保留给开发调试：
 *   node install.mjs --dev codex      # 直接把当前源码目录写进 codex 配置
 *
 * 装完让宿主自己确认：
 *   node install.mjs --verify
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHome } from './lib/installer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEXI = join(HERE, 'bin', 'nexi.mjs');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (name) => {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
};

if (has('--help') || has('-h')) {
  console.log(`
Nexi 安装器

  node install.mjs                     固定目录安装 + 本机已装的 Agent
  node install.mjs --all               同上（显式写法）
  node install.mjs --bundle <tgz|URL>  从交付包安装
  node install.mjs --dry-run           只算计划，不落盘
  node install.mjs --no-hosts          只装文件，不碰宿主配置
  node install.mjs --home <DIR>        指定安装根目录
  node install.mjs --verify            装完让宿主自己报一遍
  node install.mjs --dev [host]        开发模式：源码目录直接写宿主配置

默认安装目录：
  Windows  %LOCALAPPDATA%\\Nexi
  macOS    ~/Library/Application Support/Nexi
  Linux    ~/.local/share/nexi（或 $XDG_DATA_HOME/nexi）

宿主配置只指向 <安装目录>\\bin\\nexi.mjs；升级不需要重新找路径。
`);
  process.exit(0);
}

// --dev 是对旧行为的显式逃生口：只给开发调试用，不作为最终用户默认路径。
if (has('--dev')) {
  const passthrough = args.filter((a) => a !== '--dev' && a !== '--verify');
  const dev = spawnSync(process.execPath, [NEXI, 'install', ...passthrough], {
    cwd: HERE, stdio: 'inherit', windowsHide: true,
  });
  process.exit(dev.status ?? 1);
}

const passthrough = args.filter((a) => a !== '--verify');
const setupArgs = ['setup', ...passthrough];

/* --verify：装完让宿主自己报一遍（这是最硬的证据） */
if (has('--verify')) {
  const home = resolve(valueOf('--home') || defaultHome());
  const install = spawnSync(process.execPath, [NEXI, ...setupArgs], {
    cwd: HERE, stdio: 'inherit', windowsHide: true,
  });
  if ((install.status ?? 1) !== 0) process.exit(install.status ?? 1);
  const r = spawnSync(process.execPath, [NEXI, 'verify-host', '--all', '--record', '--launch-home', home], {
    cwd: HERE, stdio: 'inherit', windowsHide: true,
  });
  process.exit(r.status ?? 1);
}

console.log('');
console.log('Nexi 灵犀 —— 固定目录安装');
console.log('='.repeat(56));
console.log(`来源：${HERE}`);
console.log('');

const r = spawnSync(process.execPath, [NEXI, ...setupArgs], {
  cwd: HERE, stdio: 'inherit', windowsHide: true,
});
const code = r.status ?? 1;
const dryRun = has('--dry-run');

console.log('');
console.log('='.repeat(56));
if (code === 0) {
  console.log(dryRun ? '干跑完成；上面的路径只是计划，什么都没写。' : '装好了。下一步：');
  console.log('');
  console.log('  1) 让宿主自己确认（可选，但这是最硬的证据）：');
  console.log('       node install.mjs --verify');
  console.log('     或者手动跑：');
  console.log('       claude mcp list   /   codex mcp list   /   gemini mcp list');
  console.log('');
  console.log('  2) 打开那个 Agent，直接说人话试功能：');
  console.log('       「用 team_board 建个小组叫测试」');
  console.log('       「记一条：我的项目用 pnpm」  →  「把我刚记的找回来」');
  console.log('       「用 pet_skin 换上水墨」');
  console.log('       「开一场会，议题写评审」');
  console.log('       「用 deck_audit 看我刚才干了什么」');
  console.log('');
  console.log('  3) 想知道某台电脑的 Agent 该怎么配（不用装它）：');
  console.log('       node bin/nexi.mjs config --all');
  console.log('');
  console.log('  4) 以后更新同一台机器：');
  console.log('       node install.mjs');
  console.log('     或：node <安装目录>\\bin\\nexi.mjs update');
} else {
  console.log('有没装成功的，看上面的输出。');
  console.log('想先看会写什么再决定：node install.mjs --dry-run');
  console.log('某个 Agent 没装却想提前给它配：node bin/nexi.mjs config <id>');
}
console.log('');

process.exitCode = code;
