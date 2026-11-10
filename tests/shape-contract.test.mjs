/**
 * tests/shape-contract.test.mjs —— 每种配置形状的**字段级**契约。
 *
 * 为什么单独立一个文件：
 *   「装上了」和「宿主认识」是两件事。`{"nexi":{"command":"node"}}` 写进 Zed 的
 *   context_servers 也是合法 JSON，审计也查得到条目、查得到脚本存在 —— 全绿，
 *   但 Zed 起不来，因为 Zed 要的是扁平 `command` + `args` + `env`
 *   （见 https://zed.dev/docs/ai/mcp 的 custom server 示例）。
 *
 *   同理，OpenCode 的 `mcp.servers.<name>` 要 `type:"local"` 且 `command` 是**数组**；
 *   VS Code 的 `servers.<name>` 要 `type:"stdio"`；
 *   Crush 的 `mcp.<name>` 是 `type:"stdio"` + `command` 字符串；
 *   Kilo CLI 的 `mcp.<name>` 是 `type:"local"` + 数组 + `environment`。
 *
 *   这些字段没有一条是「随便写的」——每条都对着官方文档核过。谁改形状，
 *   这个文件会立刻红，并告诉他官方要的是什么。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSnippet, shapeKeys } from '../lib/connect/hosts.js';

const LAUNCH = { command: '/usr/bin/node', args: ['/opt/nexi/bin/nexi.mjs', 'mcp'], env: { FOO: 'bar' } };

function snippet(shape) {
  const text = buildSnippet({ shape, launch: LAUNCH });
  assert.ok(text, `${shape} 生成失败`);
  return text;
}

function jsonEntry(shape) {
  const obj = JSON.parse(snippet(shape));
  // 顶层只有一个键（形状的 key），进去就是我们的条目
  const key = Object.keys(obj)[0];
  return { obj, key, entry: obj[key].nexi };
}

test('mcpServers（Claude Desktop / Cursor / Windsurf / Cline / LM Studio…）', () => {
  const { key, entry } = jsonEntry('mcpServers');
  assert.equal(key, 'mcpServers');
  assert.equal(entry.command, LAUNCH.command);
  assert.deepEqual(entry.args, LAUNCH.args);
  assert.deepEqual(entry.env, LAUNCH.env);
});

test('servers（VS Code）：必须显式 type:"stdio"，否则它会把本地命令当远程服务器', () => {
  const { key, entry } = jsonEntry('servers');
  assert.equal(key, 'servers');
  assert.equal(entry.type, 'stdio');
  assert.equal(entry.command, LAUNCH.command);
  assert.deepEqual(entry.args, LAUNCH.args);
});

test('context_servers（Zed）：扁平 command 字符串，不是 {command:{path}}', () => {
  const { key, entry } = jsonEntry('context_servers');
  assert.equal(key, 'context_servers');
  // Zed 官方示例：{"command": "some-command", "args": [...], "env": {}}
  assert.equal(typeof entry.command, 'string', 'Zed 的 command 必须是字符串');
  assert.equal(entry.command, LAUNCH.command);
  assert.deepEqual(entry.args, LAUNCH.args);
  assert.deepEqual(entry.env, LAUNCH.env);
  assert.equal(entry.command.path, undefined, 'Zed 不接受嵌套的 command.path');
});

test('mcp.servers（OpenCode V2）：type:local + command 数组 + environment', () => {
  const obj = JSON.parse(snippet('mcp.servers'));
  const entry = obj.mcp.servers.nexi;
  assert.equal(entry.type, 'local');
  assert.ok(Array.isArray(entry.command), 'OpenCode 的 command 必须是「可执行文件 + 参数」的数组');
  assert.deepEqual(entry.command, [LAUNCH.command, ...LAUNCH.args]);
  assert.deepEqual(entry.environment, LAUNCH.env);
  assert.equal(entry.env, undefined, 'OpenCode 用 environment，不是 env');
});

test('mcp.local（Kilo CLI）：type:local + 数组 + environment + enabled', () => {
  const obj = JSON.parse(snippet('mcp.local'));
  const entry = obj.mcp.nexi;
  assert.equal(entry.type, 'local');
  assert.deepEqual(entry.command, [LAUNCH.command, ...LAUNCH.args]);
  assert.deepEqual(entry.environment, LAUNCH.env);
  assert.equal(entry.enabled, true);
  assert.equal(obj.mcp.servers, undefined, 'Kilo CLI 的 server 直接挂在 mcp 下，没有 servers 层');
});

test('mcp.stdio（Crush）：type:stdio + command 字符串', () => {
  const obj = JSON.parse(snippet('mcp.stdio'));
  const entry = obj.mcp.nexi;
  assert.equal(entry.type, 'stdio');
  assert.equal(typeof entry.command, 'string');
  assert.equal(entry.command, LAUNCH.command);
  assert.deepEqual(entry.args, LAUNCH.args);
});

test('amp.mcpServers（Amp）：键名本身带点，条目扁平', () => {
  const obj = JSON.parse(snippet('amp.mcpServers'));
  const entry = obj['amp.mcpServers'].nexi;
  assert.equal(entry.command, LAUNCH.command);
  assert.deepEqual(entry.args, LAUNCH.args);
});

test('yaml.extensions（Goose）：type/name/cmd/args/envs/enabled 一个都不能少', () => {
  const text = snippet('yaml.extensions');
  for (const field of ['type: stdio', 'name:', 'cmd:', 'args:', 'envs:', 'enabled: true']) {
    assert.ok(text.includes(field), `Goose 形状缺少字段 ${field}：\n${text}`);
  }
  // Goose 用 cmd，不是 command
  assert.ok(!/^\s*command:/m.test(text), 'Goose 用 cmd，不是 command');
});

test('yaml.mcpServers（Continue）：列表项，name/command/args/env 齐全', () => {
  const text = snippet('yaml.mcpServers');
  assert.match(text, /^mcpServers:/m);
  assert.match(text, /^\s*-\s+name:/m);
  for (const field of ['type: stdio', 'command:', 'args:', 'env:']) {
    assert.ok(text.includes(field), `Continue 形状缺少字段 ${field}：\n${text}`);
  }
});

test('TOML（Codex）：[mcp_servers.<name>] + command/args', () => {
  const text = buildSnippet({ shape: 'mcpServers', launch: LAUNCH, toml: true, name: 'nexi' });
  assert.match(text, /^\[mcp_servers\.nexi\]$/m);
  assert.match(text, /^command = ".*"$/m);
  assert.match(text, /^args = \[.*\]$/m);
});

test('形状清单不许悄悄少：10 种一个不少', () => {
  assert.deepEqual(shapeKeys().sort(), [
    'amp.mcpServers', 'context_servers', 'mcp.local', 'mcp.servers', 'mcp.stdio',
    'mcpServers', 'servers', 'yaml.extensions', 'yaml.mcpServers',
  ].sort());
});

test('每种形状都必须能被任意宿主复用：name 参数真的生效', () => {
  for (const shape of shapeKeys()) {
    const text = buildSnippet({ shape, launch: LAUNCH, name: 'my-nexi' });
    assert.ok(text.includes('my-nexi'), `${shape} 忽略了 name 参数`);
  }
});
