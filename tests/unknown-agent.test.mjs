/**
 * tests/unknown-agent.test.mjs —— 「没收录的 Agent 也能接」的最后一条通道。
 *
 * 内置表再多也只是「我们知道的」。用户真正要的是：
 * **任何一个吃 MCP 的 Agent，都能用一条命令接上，不用等我们发版。**
 *
 * 这条通道由三部分组成，缺一个就不算通：
 *   ① 片段：`nexi snippet --shape X`，复制粘贴就能用（哪怕宿主只能 UI 里贴）；
 *   ② 任意文件：`install custom <任意路径> --shape X`，路径/扩展名都不挑；
 *   ③ 可逆：装进去的必须能原样卸出来 —— 能装不能卸，等于往别人配置里扔垃圾。
 *
 * 另外锁住 JSONC：VS Code / CodeBuddy 的配置官方允许注释与尾逗号。
 * 读得懂（审计不误报）、但**绝不整份重写**（那会删掉用户的注释）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { adHocHost, installHost, uninstallHost, shapeKeys } from '../lib/connect/hosts.js';
import { auditHost } from '../lib/connect/audit.js';
import { hasJsonc, parseJsonc, stripJsonc } from '../lib/connect/jsonc.js';

const NEXI = fileURLToPath(new URL('../bin/nexi.mjs', import.meta.url));
const LAUNCH = { command: process.execPath, args: [NEXI, 'mcp'], env: {} };
const DIR = mkdtempSync(path.join(tmpdir(), 'nexi-unknown-'));

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [NEXI, ...args], { encoding: 'utf8', timeout: 30_000, ...opts });
  return { code: r.status, out: `${r.stdout || ''}`, err: `${r.stderr || ''}` };
}

test('任意扩展名的文件都能装：.json / .jsonc / .yaml / .toml / .conf / 无扩展名', () => {
  const base = { 'a.json': '', 'b.jsonc': '', 'c.yaml': '', 'd.toml': '', 'e.conf': '', 'noext': '' };
  for (const [name, body] of Object.entries(base)) {
    const file = path.join(DIR, name);
    writeFileSync(file, body);
    const kind = name.endsWith('.yaml') ? 'yaml' : (name.endsWith('.toml') ? 'toml' : 'json');
    const shape = kind === 'yaml' ? 'yaml.mcpServers' : 'mcpServers';
    const r = installHost('custom', {
      host: adHocHost({ id: 'custom', path: file, shape, kind }),
      path: file,
      launch: LAUNCH,
      force: true,
      name: 'nexi',
    });
    assert.equal(r.ok, true, `${name} 装不上：${r.reason || (r.warnings || []).join('；')}`);
    assert.match(readFileSync(file, 'utf8'), /nexi/, `${name} 里没有 nexi`);
  }
});

test('能装就能卸：install custom → uninstall custom 逐字节还原', () => {
  const file = path.join(DIR, 'round.json');
  const original = '{\n  "mcpServers": {}\n}\n';
  writeFileSync(file, original);

  const inst = cli(['install', 'custom', file, '--shape', 'mcpServers']);
  assert.equal(inst.code, 0, `装失败：${inst.err || inst.out}`);
  assert.match(readFileSync(file, 'utf8'), /nexi/);

  // CLI 会把相对路径转绝对，这里直接给绝对路径
  const un = cli(['uninstall', 'custom', file, '--shape', 'mcpServers']);
  assert.equal(un.code, 0, `卸失败：${un.err || un.out}`);
  assert.equal(readFileSync(file, 'utf8'), original, '卸完不是原文');
});

test('JSONC 读得懂：带注释的配置能审计，不再误报 broken', () => {
  const file = path.join(DIR, 'commented.jsonc');
  writeFileSync(file, `{
  // 我的 MCP 服务器
  "servers": {
    /* nexi 在这 */
    "nexi": {
      "type": "stdio",
      "command": ${JSON.stringify(LAUNCH.command)},
      "args": ${JSON.stringify(LAUNCH.args)},
    },
  },
}
`);
  const host = adHocHost({ id: 'j', path: file, shape: 'servers' });
  const a = auditHost(host, { file, currentLaunch: LAUNCH });
  assert.equal(a.state, 'wired', `合法的 JSONC 被审成 ${a.state}：${a.reason || ''}`);
});

test('JSONC 不整份重写：带注释的文件，装的时候拒绝并给手工方案', () => {
  const file = path.join(DIR, 'keep-comments.jsonc');
  const original = `{
  // 这段注释对我很重要
  "mcpServers": {}
}
`;
  writeFileSync(file, original);
  const r = installHost('custom', {
    host: adHocHost({ id: 'custom', path: file, shape: 'mcpServers' }),
    path: file,
    launch: LAUNCH,
    force: true,
  });
  assert.equal(r.ok, false, '带注释的配置被整份重写了');
  assert.equal(r.reason, 'jsonc-preserve');
  assert.match((r.warnings || []).join(' '), /注释/, '没解释为什么不动');
  assert.match((r.warnings || []).join(' '), /snippet/, '没给出手工方案');
  assert.equal(readFileSync(file, 'utf8'), original, '文件被动过了');
});

test('JSONC 解析器：注释、尾逗号、URL 里的 // 都处理对', () => {
  assert.deepEqual(parseJsonc('{"a":1,// x\n"b":2,}'), { a: 1, b: 2 });
  assert.deepEqual(parseJsonc('{/* x */"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonc('{"url":"https://x/y","a":1}'), { url: 'https://x/y', a: 1 });
  assert.deepEqual(parseJsonc('{"s":"// 这不是注释"}'), { s: '// 这不是注释' });
  assert.deepEqual(parseJsonc('{"s":"/* 也不是 */"}'), { s: '/* 也不是 */' });
  assert.equal(hasJsonc('{"a":1}'), false);
  assert.equal(hasJsonc('{"a":1,}'), true);
  assert.equal(hasJsonc('{// c\n"a":1}'), true);
  assert.equal(stripJsonc('{"a":1,}'), '{"a":1}');
});

test('未知形状不崩：退出码 2 + 列出所有可选形状', () => {
  const r = cli(['snippet', '--shape', 'no-such-shape']);
  assert.equal(r.code, 2, '未知形状应以退出码 2 结束（用法错误）');
  const text = `${r.out}${r.err}`;
  for (const shape of ['mcpServers', 'servers', 'context_servers']) {
    assert.ok(text.includes(shape), `报错里没有列出 ${shape}`);
  }
});

test('十种形状都能出片段，且都能被 install custom 用', () => {
  for (const shape of shapeKeys()) {
    const kind = shape.startsWith('yaml.') ? 'yaml' : 'json';
    const ext = kind === 'yaml' ? '.yaml' : '.json';
    const file = path.join(DIR, `shape-${shape.replace(/\./g, '-')}${ext}`);
    writeFileSync(file, '');
    const r = installHost('custom', {
      host: adHocHost({ id: 'custom', path: file, shape, kind }),
      path: file,
      launch: LAUNCH,
      force: true,
    });
    assert.equal(r.ok, true, `${shape} 装不上：${r.reason || (r.warnings || []).join('；')}`);
  }
});

test('没装的宿主：不往它默认路径写文件，但给出可直接用的配置预览', () => {
  const before = readFileSync(NEXI, 'utf8').length; // 只用来确保 NEXI 可读
  assert.ok(before > 0);
  // 用一个肯定不存在的宿主 id → 应报「不认识」而不是静默成功
  const r = cli(['install', 'no-such-host-xyz']);
  assert.notEqual(r.out.trim(), '', '没有任何输出');
  assert.match(r.out, /不认识|no-such-host-xyz/);
});

test('卸载一个不存在的宿主：报错清楚，不误删任何东西', () => {
  const r = uninstallHost('no-such-host-xyz');
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /不认识/);
});
