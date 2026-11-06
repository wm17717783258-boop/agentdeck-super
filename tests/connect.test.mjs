/**
 * Nexi Connect：安装器真跑测试。
 * 全部在临时目录里做，不碰用户真实配置；真实宿主安装另有 evidence 记录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHost, uninstallHost, detectHosts, HOSTS, launchCommand } from '../lib/connect/hosts.js';

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
