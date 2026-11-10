/**
 * tests/host-audit.test.mjs —— 体检不许说谎（宿主连通性审计）。
 *
 * 注意与 tests/audit.test.mjs 区分：那个测的是 lib/policy/audit.js 的审计日志流，
 * 这个测的是 lib/connect/audit.js —— 「宿主到底接通了没有」。
 *
 * 这一组针对「假绿」：配置里看起来有 nexi，实际宿主连不上。
 * 旧判据是一行正则 `/nexi/i.test(配置全文)`，下面每种情况它都会给绿勾：
 *
 *   · 条目指向的脚本已经删了
 *   · command 写的 node 路径不存在
 *   · 只是注释里提到 nexi
 *   · 别家 server 名字里带 nexi
 *   · 条目是 null
 *
 * 每个场景在这里都有一个对应用例。任何一个变绿（误判成 wired），就是回归。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditHost, extractEntry, describeAudit } from '../lib/connect/audit.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = path.join(ROOT, 'bin', 'nexi.mjs'); // 一个真实存在的脚本
const tmp = () => mkdtempSync(path.join(tmpdir(), 'nexi-haudit-'));

function write(dir, name, content) {
  const f = path.join(dir, name);
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return f;
}

const jsonHost = { id: 'h', kind: 'json' };
const tomlHost = { id: 'h', kind: 'toml' };
const yamlHost = { id: 'h', kind: 'yaml' };

test('wired：条目在、脚本在、解释器在', () => {
  const dir = tmp();
  const file = write(dir, 'mcp.json', {
    mcpServers: { nexi: { command: process.execPath, args: [SELF, 'mcp'], env: {} } },
  });
  const a = auditHost(jsonHost, { file });
  assert.equal(a.state, 'wired', a.reason);
  assert.equal(a.target, SELF);
});

test('unreachable：条目指向的脚本已经被删了（旧判据会说 ok）', () => {
  const dir = tmp();
  const file = write(dir, 'mcp.json', {
    mcpServers: { nexi: { command: process.execPath, args: [path.join(dir, '早就删了', 'nexi.mjs'), 'mcp'] } },
  });
  const a = auditHost(jsonHost, { file });
  assert.equal(a.state, 'unreachable');
  assert.match(a.reason, /脚本不在了/);
});

test('unreachable：command 指的 node 已经不存在（换过 Node 版本）', () => {
  const dir = tmp();
  const file = write(dir, 'mcp.json', {
    mcpServers: { nexi: { command: path.join(dir, 'nvm', 'v20.0.0', 'node.exe'), args: [SELF, 'mcp'] } },
  });
  const a = auditHost(jsonHost, { file });
  assert.equal(a.state, 'unreachable');
  assert.match(a.reason, /解释器不在了/);
});

test('unreachable：command 是裸名但 PATH 上找不到', () => {
  const dir = tmp();
  const file = write(dir, 'mcp.json', {
    mcpServers: { nexi: { command: 'definitely-not-a-real-binary-xyz', args: [SELF, 'mcp'] } },
  });
  const a = auditHost(jsonHost, { file });
  assert.equal(a.state, 'unreachable');
  assert.match(a.reason, /PATH 上找不到/);
});

test('absent：只是在注释里提到 nexi（TOML 与 YAML 都不算装）', () => {
  const dir = tmp();
  const t = write(dir, 'config.toml', ['# nexi 以前装过，后来删了', 'model = "gpt-5"', ''].join('\n'));
  assert.equal(auditHost(tomlHost, { file: t }).state, 'absent');

  const y = write(dir, 'config.yaml', [
    '# nexi: 这一行是注释',
    'active_provider: anthropic',
    'extensions:',
    '  developer:',
    '    type: builtin',
    '',
  ].join('\n'));
  assert.equal(auditHost(yamlHost, { file: y }).state, 'absent');
});

test('absent：别家 server 名字里带 nexi，不算我们', () => {
  const dir = tmp();
  const file = write(dir, 'mcp.json', {
    mcpServers: {
      'nexi-helper': { command: 'x', args: [] },
      'my-nexi': { command: 'y', args: [] },
      nexi2: { command: 'z', args: [] },
    },
  });
  assert.equal(auditHost(jsonHost, { file }).state, 'absent');
});

test('absent/unreachable：条目是 null、空对象、0、空串，都不算装好', () => {
  const dir = tmp();
  for (const val of [null, {}, 0, '']) {
    const file = write(dir, 'mcp.json', { mcpServers: { nexi: val } });
    const a = auditHost(jsonHost, { file });
    assert.notEqual(a.state, 'wired', `nexi=${JSON.stringify(val)} 被判成了 wired`);
  }
});

test('broken：配置文件本身不是合法 JSON（不猜、不动）', () => {
  const dir = tmp();
  const file = write(dir, 'mcp.json', '{ "mcpServers": { "nexi": ');
  const a = auditHost(jsonHost, { file });
  assert.equal(a.state, 'broken');
  assert.ok(a.reason);
});

test('wired：OpenCode / Kilo / Crush 的 command 是数组形状也能认', () => {
  const dir = tmp();
  const file = write(dir, 'opencode.json', {
    mcp: { nexi: { type: 'local', command: [process.execPath, SELF, 'mcp'], environment: {} } },
  });
  const a = auditHost(jsonHost, { file });
  assert.equal(a.state, 'wired', a.reason);
});

test('wired：mcp.servers 嵌套形状', () => {
  const dir = tmp();
  const file = write(dir, 'opencode2.json', {
    mcp: { servers: { nexi: { command: process.execPath, args: [SELF, 'mcp'] } } },
  });
  assert.equal(auditHost(jsonHost, { file }).state, 'wired');
});

test('wired：Goose 的 YAML extensions.nexi（cmd + 流式 args）', () => {
  const dir = tmp();
  const file = write(dir, 'config.yaml', [
    'extensions:',
    '  nexi:',
    '    type: stdio',
    '    name: "nexi"',
    '    enabled: true',
    `    cmd: ${JSON.stringify(process.execPath)}`,
    `    args: [${JSON.stringify(SELF)}, "mcp"]`,
    '    envs: {}',
    '  developer:',
    '    type: builtin',
    '',
  ].join('\n'));
  const a = auditHost(yamlHost, { file });
  assert.equal(a.state, 'wired', a.reason);
});

test('wired：Continue 的列表项（- name: nexi）', () => {
  const dir = tmp();
  const file = write(dir, 'config.yaml', [
    'name: my-config',
    'mcpServers:',
    '  - name: sqlite',
    '    command: npx',
    '    args: ["-y", "mcp-sqlite"]',
    '  - name: "nexi"',
    '    type: stdio',
    `    command: ${JSON.stringify(process.execPath)}`,
    `    args: [${JSON.stringify(SELF)}, "mcp"]`,
    '    env: {}',
    '',
  ].join('\n'));
  const a = auditHost(yamlHost, { file });
  assert.equal(a.state, 'wired', a.reason);
});

test('wired：Codex 的 TOML 哨兵块', () => {
  const dir = tmp();
  const file = write(dir, 'config.toml', [
    'model = "gpt-5"',
    '',
    '# >>> nexi',
    '[mcp_servers.nexi]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([SELF, 'mcp'])}`,
    '# <<< nexi',
    '',
  ].join('\n'));
  const a = auditHost(tomlHost, { file });
  assert.equal(a.state, 'wired', a.reason);
});

test('extractEntry：文件不存在 / 空文件 / 读不了 都不抛', () => {
  const dir = tmp();
  assert.equal(extractEntry(path.join(dir, 'nope.json'), jsonHost).found, false);
  assert.equal(extractEntry(write(dir, 'empty.json', '   '), jsonHost).found, false);
  const r = extractEntry(dir, jsonHost); // 目录当文件
  assert.equal(r.found, false);
  assert.ok(r.readError);
});

test('describeAudit：每种状态都给得出一句人能照着做的话', () => {
  for (const state of ['wired', 'stale', 'unreachable', 'broken', 'absent']) {
    const text = describeAudit({ state, reason: '原因' });
    assert.ok(text && text.length > 1, `${state} 没有说明`);
  }
  assert.match(describeAudit({ state: 'unreachable', reason: 'x' }), /install --all/, '没给出下一步');
});

test('doctor 的 hosts 检查不是写死的 ok:true（静态防线）', () => {
  const src = readFileSync(path.join(ROOT, 'bin', 'nexi.mjs'), 'utf8');
  const at = src.indexOf("name: 'hosts'");
  assert.ok(at > 0, '找不到 hosts 检查段');
  // 只截到下一项检查为止，别把 launch 的 ok:true 也算进来
  const next = src.indexOf("name: 'launch'", at);
  const block = src.slice(at, next > at ? next : at + 900);
  assert.ok(!/ok:\s*true/.test(block), 'hosts 检查又变回永远 ok:true 了');
  assert.match(block, /brokenWiring/, 'hosts 检查没有把"接不上"算进去');
});
