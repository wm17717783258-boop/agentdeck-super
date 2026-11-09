/**
 * Nexi Connect：安装器真跑测试。
 * 全部在临时目录里做，不碰用户真实配置；真实宿主安装另有 evidence 记录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installHost,
  uninstallHost,
  detectHosts,
  HOSTS,
  launchCommand,
  resolveNodeCommand,
  scoreNode,
  findAllOnPath,
  shapeKeyOf,
  cliAddArgs,
  cliAvailable,
  hostCliList,
} from '../lib/connect/hosts.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'nexi-connect-'));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('install：未安装的宿主直接报 host-not-installed，绝不凭空造配置', () => {
  const notInstalled = detectHosts().filter((h) => !h.installed);
  if (!notInstalled.length) return; // 本机全装齐了，这条没得测
  const host = notInstalled[0];
  const res = installHost(host.id, {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'host-not-installed');
  assert.equal(existsSync(host.path), false, '不该凭空造配置');
});

test('install：保留用户已有 mcpServers，只加 nexi 一项，并留备份', () => {
  const dir = tmpDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'other-bin', args: ['x'] } }, theme: 'dark' }, null, 2));

  const res = installHost('cursor', { path: file, force: true });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.ok(res.backup && existsSync(res.backup), '必须留备份');

  const after = readJson(file);
  assert.deepEqual(after.mcpServers.other, { command: 'other-bin', args: ['x'] }, '别人的配置一个字都不许动');
  assert.equal(after.theme, 'dark');
  assert.equal(after.mcpServers.nexi.command, launchCommand().command);
  assert.deepEqual(after.mcpServers.nexi.args, launchCommand().args);
});

test('install：幂等——第二次不改文件、不再加备份', () => {
  const dir = tmpDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, '{}');
  const first = installHost('cursor', { path: file, force: true });
  assert.equal(first.changed, true);
  const backupsAfterFirst = readdirSync(dir).filter((f) => f.includes('.nexi-backup-'));
  const second = installHost('cursor', { path: file, force: true });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false, '第二次应判定为无变化');
  assert.equal(readdirSync(dir).filter((f) => f.includes('.nexi-backup-')).length, backupsAfterFirst.length);
});

test('install：--dry-run 只给预览，不落盘、不备份', () => {
  const dir = tmpDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, '{"mcpServers":{}}');
  const before = readFileSync(file, 'utf8');
  const res = installHost('cursor', { path: file, force: true, dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.match(res.preview, /nexi/);
  assert.equal(readFileSync(file, 'utf8'), before, 'dry-run 不许改文件');
  assert.equal(readdirSync(dir).filter((f) => f.includes('.nexi-backup-')).length, 0);
});

test('install：同名条目是用户手写的、命令不同 → 默认拒绝覆盖', () => {
  const dir = tmpDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { nexi: { command: '/usr/bin/handmade', args: [] } } }));
  const res = installHost('cursor', { path: file });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'config-conflict');
  const after = readJson(file);
  assert.equal(after.mcpServers.nexi.command, '/usr/bin/handmade', '不许动用户手写的条目');
});

test('install：坏 JSON 拒绝改写，不破坏原文件', () => {
  const dir = tmpDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, '{ 这不是 json ');
  const res = installHost('cursor', { path: file, force: true });
  assert.equal(res.ok, false);
  assert.equal(readFileSync(file, 'utf8'), '{ 这不是 json ');
});

test('uninstall：精确回滚到只剩用户自己的配置', () => {
  const dir = tmpDir();
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'o', args: [] } } }, null, 2));
  installHost('cursor', { path: file, force: true });
  assert.ok(readJson(file).mcpServers.nexi, '先确认装上了');

  const res = uninstallHost('cursor', { path: file });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const after = readJson(file);
  assert.equal(after.mcpServers.nexi, undefined);
  assert.deepEqual(after.mcpServers.other, { command: 'o', args: [] });

  const again = uninstallHost('cursor', { path: file });
  assert.equal(again.changed, false, '重复卸载无副作用');
});

test('codex：TOML 用哨兵块写入，重复安装不叠加，卸载删干净', () => {
  const dir = tmpDir();
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'model = "gpt-5"\n\n[history]\npersistence = "save-all"\n');

  const first = installHost('codex', { path: file, force: true });
  assert.equal(first.ok, true);
  let text = readFileSync(file, 'utf8');
  assert.match(text, /^model = "gpt-5"/m, '用户原有配置要保留');
  assert.match(text, /\[mcp_servers\.nexi\]/);
  assert.equal((text.match(/\[mcp_servers\.nexi\]/g) || []).length, 1);

  const second = installHost('codex', { path: file, force: true });
  assert.equal(second.changed, false, '第二次应无变化');
  text = readFileSync(file, 'utf8');
  assert.equal((text.match(/\[mcp_servers\.nexi\]/g) || []).length, 1, '不允许写两份同名表');

  const removed = uninstallHost('codex', { path: file });
  assert.equal(removed.changed, true);
  const after = readFileSync(file, 'utf8');
  assert.doesNotMatch(after, /nexi/);
  assert.match(after, /^model = "gpt-5"/m);
});

test('detectHosts：只报事实，字段齐全，路径是绝对路径', () => {
  const hosts = detectHosts();
  assert.equal(hosts.length, HOSTS.length);
  for (const h of hosts) {
    assert.ok(h.id && h.label && h.kind && Array.isArray(h.candidates));
    assert.equal(typeof h.installed, 'boolean');
    assert.match(h.path, /^[A-Za-z]:\\|^\//, `路径应是绝对路径：${h.path}`);
  }
});

/**
 * 回归：launchCommand（nexi install / doctor 走这条）也不能把
 * "会随宿主升级消失的版本化私有 node"写进宿主配置。
 *
 * 真机踩过的坑：PATH 首个 node 是 <home>\.workbuddy\binaries\node\versions\<v>\node.exe，
 * 目录带版本号，IDE 一升级旧目录被删 → 所有宿主静默起不来。
 */
test('launchCommand 默认挑稳定 node，不写版本化私有路径', () => {
  const launch = launchCommand();
  assert.ok(launch.command, '必须给出 node 命令');
  assert.doesNotMatch(
    String(launch.command).replace(/\\/g, '/'),
    /\/versions?\/\d+\.\d+\.\d+/,
    `不应把版本化私有 node 写进宿主配置，实际：${launch.command}`,
  );
  assert.deepEqual(launch.args.slice(-1), ['mcp']);
});

test('launchCommand({portable:true}) 走裸命令 node', () => {
  const launch = launchCommand({ portable: true });
  assert.equal(launch.command, 'node');
  assert.equal(launch._node.source, 'bare');
});

test('scoreNode：系统级安装点得分高于版本化私有路径', () => {
  const stable = scoreNode('C://Program Files\\nodejs\\node.exe');
  const privateNode = scoreNode('C://Users//x//.workbuddy//binaries//node//versions//22.22.2-6//node.exe');
  const apps = scoreNode('C://Users//x//Apps//nodejs//node.exe');
  assert.ok(stable > privateNode, 'Program Files node 应高于私有 node');
  assert.ok(apps > privateNode, 'Apps/nodejs node 应高于私有 node');
  assert.ok(privateNode < 0, '版本化私有 node 应为负分');
});

test('resolveNodeCommand 与 launchCommand 选中同一个 node（两处不分叉）', () => {
  assert.equal(launchCommand().command, resolveNodeCommand().command);
});

test('findAllOnPath 返回数组（可能为空），且不含重复', () => {
  const all = findAllOnPath(['node']);
  assert.ok(Array.isArray(all));
  assert.equal(all.length, new Set(all).size);
});

/**
 * 回归：宿主之间真正的差异只有两件事 —— 服务器挂在哪个 key、entry 长什么样。
 * 早先 planJson 把 `mcpServers` 写死了，导致 Zed（context_servers）、
 * VS Code（servers）、OpenCode（mcp.servers）根本装不进去。
 * 这几条测试锁住"按形状写"，形状表被删/写错就会红。
 */
test('每家宿主的配置 key 都对（形状表没退化成写死 mcpServers）', () => {
  assert.equal(shapeKeyOf('claude-desktop'), 'mcpServers');
  assert.equal(shapeKeyOf('zed'), 'context_servers');
  assert.equal(shapeKeyOf('vscode'), 'servers');
  assert.equal(shapeKeyOf('opencode'), 'mcp.servers');
});

test('Zed：写入 context_servers，且是扁平 command/args/env', () => {
  const base = tmpDir();
  const file = join(base, 'settings.json');
  writeFileSync(file, '{}');
  const r = installHost('zed', { path: file, force: true });
  assert.equal(r.ok, true);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(data.context_servers?.nexi, '必须写在 context_servers 下');
  assert.equal(data.mcpServers, undefined, '不该顺手多写一个 mcpServers');
  assert.equal(typeof data.context_servers.nexi.command, 'string');
  assert.ok(Array.isArray(data.context_servers.nexi.args));
});

test('VS Code：写入 servers，并带 type:"stdio"（缺 type 会被当远程服务器）', () => {
  const base = tmpDir();
  const file = join(base, 'mcp.json');
  writeFileSync(file, '{}');
  assert.equal(installHost('vscode', { path: file, force: true }).ok, true);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(data.servers.nexi.type, 'stdio');
  assert.equal(data.mcpServers, undefined);
});

test('OpenCode：写入 mcp.servers，命令合数组、环境叫 environment', () => {
  const base = tmpDir();
  const file = join(base, 'opencode.json');
  writeFileSync(file, '{}');
  assert.equal(installHost('opencode', { path: file, force: true }).ok, true);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const entry = data.mcp.servers.nexi;
  assert.equal(entry.type, 'local');
  assert.ok(Array.isArray(entry.command), 'OpenCode 要 command 数组');
  assert.ok(entry.command.length >= 2);
  assert.equal(entry.env, undefined, 'OpenCode 用的字段叫 environment');
  assert.ok(entry.environment && typeof entry.environment === 'object');
});

test('各形状卸载时只删自己那一项，不破坏别家配置', () => {
  for (const id of ['zed', 'vscode', 'opencode', 'claude-desktop']) {
    const base = tmpDir();
    const file = join(base, `${id}.json`);
    writeFileSync(file, JSON.stringify({ untouched: { keep: true } }));
    installHost(id, { path: file, force: true });
    const r = uninstallHost(id, { path: file });
    assert.equal(r.ok, true, `${id} 卸载应成功`);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data.untouched, { keep: true }, `${id} 不该动别人的配置`);
    const key = shapeKeyOf(id);
    const servers = key === 'mcp.servers' ? data.mcp?.servers : data[key];
    assert.equal(servers?.nexi, undefined, `${id} 的 nexi 应被删干净`);
  }
});

/**
 * 回归：CLI 安装的参数方言。
 * 实测出来的两种：bare（claude/gemini/qwen）和 dashDash（codex/copilot，要 `--`）。
 * 拼错的话宿主会把它当成"命令的一部分"，报一个看不懂的错，或者静默不生效。
 */
test('CLI 方言：bare 与 dashDash 拼参正确', () => {
  const launch = { command: 'node', args: ['/x/nexi.mjs', 'mcp'], env: {} };
  const bare = HOSTS.find((h) => h.id === 'gemini-cli');
  const dash = HOSTS.find((h) => h.id === 'codex');
  assert.deepEqual(cliAddArgs(bare, 'nexi', launch), ['mcp', 'add', 'nexi', 'node', '/x/nexi.mjs', 'mcp']);
  assert.deepEqual(cliAddArgs(dash, 'nexi', launch), ['mcp', 'add', 'nexi', '--', 'node', '/x/nexi.mjs', 'mcp']);
});

test('claude / gemini / qwen 都要求 --scope user（否则只对当前项目生效）', () => {
  const launch = { command: 'node', args: ['/x/nexi.mjs', 'mcp'], env: {} };
  for (const id of ['claude-code', 'gemini-cli', 'qwen-code']) {
    const host = HOSTS.find((h) => h.id === id);
    const args = cliAddArgs(host, 'nexi', launch, host.cliAddExtra || []);
    assert.ok(args.includes('--scope'), `${id} 应显式要 user scope`);
    assert.equal(args[args.indexOf('--scope') + 1], 'user');
  }
});

test('宿主清单覆盖主流：至少包含 Zed / VS Code / OpenCode / Qwen / Copilot', () => {
  const ids = HOSTS.map((h) => h.id);
  for (const need of ['zed', 'vscode', 'opencode', 'qwen-code', 'copilot-cli']) {
    assert.ok(ids.includes(need), `缺少宿主：${need}`);
  }
  assert.ok(HOSTS.length >= 13, `宿主数应 >= 13，实际 ${HOSTS.length}`);
});

test('没有 CLI 的宿主不会假装能用 CLI', () => {
  const r = cliAvailable('claude-desktop');
  assert.equal(r.available, false);
  assert.equal(r.reason, 'host-has-no-cli');
});
