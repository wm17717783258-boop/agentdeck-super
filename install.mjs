#!/usr/bin/env node
/**
 * install.mjs —— 一条命令装进这台电脑上所有主流 Agent
 *
 * 用法（在插件目录里跑）：
 *   node install.mjs              # 探测到哪个装哪个
 *   node install.mjs --all        # 同上（显式写法）
 *   node install.mjs --portable   # 配置里写裸 node（配置要拷去别的电脑时用）
 *   node install.mjs --dry-run    # 只看会写什么，不动任何文件
 *   node install.mjs codex        # 只装某一个
 *
 * 它做的事：把本插件注册成宿主能用的 MCP server。
 * 装完你可以让宿主自己确认（claude mcp list 之类），也可以：
 *   node install.mjs --verify
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEXI = join(HERE, 'bin', 'nexi.mjs');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

// 默认就是 --all（用户跑这条命令的意思就是"能装的都装上"）。
// 只有显式点名了某个宿主 id 时才不传 --all。
const NAMED = args.filter((a) => !a.startsWith('-') && !['--verify'].includes(a));
const passthrough = [
  ...args.filter((a) => a !== '--verify'),
  ...(NAMED.length ? [] : ['--all']),
];

/* --verify：装完让宿主自己报一遍（这是最硬的证据） */
if (has('--verify')) {
  const r = spawnSync(process.execPath, [NEXI, 'verify-host', '--all', '--record'], {
    cwd: HERE, stdio: 'inherit', windowsHide: true,
  });
  process.exit(r.status ?? 0);
}

console.log('');
console.log('Nexi 灵犀 —— 安装到本机的 Agent');
console.log('='.repeat(56));
console.log(`插件目录：${HERE}`);
console.log('');

/* 先看看这台机器上有哪些 Agent */
const probe = spawnSync(process.execPath, [NEXI, 'install'], { cwd: HERE, encoding: 'utf8', windowsHide: true });
let hosts = [];
try {
  const j = JSON.parse(String(probe.stdout || '{}').slice(String(probe.stdout || '{}').indexOf('{')));
  hosts = Array.isArray(j.hosts) ? j.hosts : [];
} catch { /* 拿不到就下面兜底 */ }

if (hosts.length) {
  const installed = hosts.filter((h) => h.installed);
  console.log(`探测到本机有 ${installed.length} 个可接入的 Agent：`);
  for (const h of hosts) {
    const mark = h.installed ? '✅' : '  ';
    const via = h.detectedBy === 'cli' ? '（只找到命令行，还没生成配置文件）' : '';
    console.log(`  ${mark} ${h.label}${via}`);
  }
  if (!installed.length) {
    console.log('');
    console.log('这台机器上没探测到任何 Agent。');
    console.log('先装一个（比如 Claude Code / Codex / Cursor），再回来跑这条命令。');
    console.log('也可以先看配置长什么样：node bin/nexi.mjs config --all');
    process.exit(0);
  }
  console.log('');
}

console.log('开始装入……');
console.log('');

const r = spawnSync(process.execPath, [NEXI, 'install', ...passthrough], {
  cwd: HERE, stdio: 'inherit', windowsHide: true,
});
const code = r.status ?? 1;

console.log('');
console.log('='.repeat(56));
if (code === 0) {
  console.log('装好了。下一步：');
  console.log('');
  console.log('  1) 让宿主自己确认（可选，但这是最硬的证据）：');
  console.log('       node install.mjs --verify');
  console.log('     或者手动跑宿主自己的命令：');
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
} else {
  console.log('有没装成功的，看上面的输出。');
  console.log('想先看会写什么再决定：node install.mjs --dry-run');
  console.log('某个 Agent 没装却想提前给它配：node bin/nexi.mjs config <id>');
}
console.log('');

process.exitCode = code;
