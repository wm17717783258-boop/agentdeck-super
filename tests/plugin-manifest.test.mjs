/**
 * tests/plugin-manifest.test.mjs —— Claude Code 插件市场的三个清单文件。
 *
 * 这三个文件是「用户在 /plugin 面板里能不能看到并装上」的唯一依据，
 * 而且它们和 npm 包**是两条分发路径**：npm 走 tarball，市场走 git。
 * 两条路的版本号一旦脱节，用户装到的就是「面板写 1.11.10、实际跑 1.11.9」。
 *
 * 所以这里盯四件事：
 *   1. marketplace.json 的结构（Claude Code 会按这个校验，缺字段直接不给上台）
 *   2. 条目 name 必须与 plugin.json 的 name 一致（官方文档点名的失败原因）
 *   3. plugin.json 的版本必须与 package.json 一致
 *   4. source 目录真实存在，且里面真有一个能起 MCP 的 .mcp.json
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const MARKET = readJson('.claude-plugin/marketplace.json');
const PLUGIN = readJson('plugins/nexi/.claude-plugin/plugin.json');
const MCP = readJson('plugins/nexi/.mcp.json');
const PKG = readJson('package.json');

test('marketplace.json 有必需字段，且条目 source 不含 ..', () => {
  assert.equal(typeof MARKET.name, 'string');
  assert.ok(MARKET.name.trim().length > 0, 'name 不能为空');
  assert.ok(MARKET.owner && typeof MARKET.owner.name === 'string', 'owner.name 必需');
  assert.ok(Array.isArray(MARKET.plugins) && MARKET.plugins.length > 0, 'plugins 不能是空数组');
  for (const p of MARKET.plugins) {
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.source, 'string', '本仓库内的插件用相对路径字符串');
    assert.ok(!p.source.includes('..'), `source 不能含 ..：${p.source}`);
    assert.ok(p.source.startsWith('./'), `source 应该是 ./ 开头：${p.source}`);
    const dir = path.join(ROOT, p.source);
    assert.ok(existsSync(dir), `source 指向的目录不存在：${p.source}`);
  }
});

test('条目 name 与 plugin.json 的 name 一致（否则按清单名装不上）', () => {
  const entry = MARKET.plugins.find((p) => p.source === './plugins/nexi');
  assert.ok(entry, '找不到 nexi 条目');
  assert.equal(entry.name, PLUGIN.name);
});

test('插件版本与 npm 包版本一致（两条分发路径不许脱节）', () => {
  // 用户可能从 /plugin 装（走 git），也可能从 npm 装。写着两个版本号却跑另一套，
  // 是最难查的一类问题 —— 报 bug 时双方看到的版本对不上。
  assert.equal(PLUGIN.version, PKG.version, `plugin.json=${PLUGIN.version} package.json=${PKG.version}`);
});

test('.mcp.json 起的是 nexi mcp，不是别的入口', () => {
  const servers = MCP.mcpServers || {};
  const nexi = servers.nexi;
  assert.ok(nexi, '.mcp.json 里没有 nexi 服务');
  const argv = [nexi.command, ...(nexi.args || [])].join(' ');
  assert.match(argv, /\bnexi\b|agentdeck-super/, `启动命令看起来不像本包：${argv}`);
  assert.match(argv, /\bmcp\b/, '必须带 mcp 子命令，否则起的是 CLI 不是协议服务');
});
