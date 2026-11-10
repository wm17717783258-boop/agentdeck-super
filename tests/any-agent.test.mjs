/**
 * tests/any-agent.test.mjs —— 「适配所有 Agent」的四条通道。
 *
 * 用户的要求是：不分 Agent、不分系统、不分网络、不分设备。
 * 前两条里「不分系统」有 platform-matrix 守着；这个文件守「不分 Agent」：
 *
 *   ① 内置表：25 个主流宿主，形状各不相同（mcpServers / servers / context_servers /
 *      mcp.servers / mcp.local / mcp.stdio / amp.mcpServers / toml），全部能生成正确配置；
 *   ② 注册表：用户丢一份 JSON 进 hosts.d，就能把没收录的 Agent 接进来，不用我们发版；
 *   ③ 临时通道：nexi install custom <文件> --shape X，连注册表都不用写；
 *   ④ 兜底：nexi snippet 生成可粘贴片段，给那些只让在 UI 里粘 JSON 的 Agent。
 *
 * 这四条里任何一条断了，"适配所有 Agent"就是空话，所以每条都有断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOSTS, BUILTIN_HOSTS, buildSnippet, adHocHost, installHost, shapeKeys } from '../lib/connect/hosts.js';
import { withCustomHosts, normalizeHostSpec, saveCustomHost, loadCustomHosts, mergeHosts } from '../lib/connect/registry.js';
import { platformCtx } from '../lib/connect/platform.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'nexi.mjs');
const home = () => mkdtempSync(path.join(tmpdir(), 'nexi-any-'));

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return r;
}

test('内置表覆盖 25 个宿主，且没有重复 id', () => {
  assert.ok(BUILTIN_HOSTS.length >= 26, `内置宿主只有 ${BUILTIN_HOSTS.length} 个`);
  const ids = HOSTS.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, 'HOSTS 里有重复 id');
  for (const h of HOSTS) {
    assert.ok(h.label, `${h.id} 没有 label`);
    // auto = 同一个宿主两代格式并存（Continue 的 config.yaml / config.json），
    // 按目标文件扩展名决定写入器，不算"没写 kind"。
    assert.ok(['json', 'toml', 'yaml', 'auto'].includes(h.kind), `${h.id} 的 kind 不对：${h.kind}`);
  }
});

test('八种 JSON 形状 + 两种 YAML 形状 + TOML 都能生成结构正确的片段', () => {
  for (const shape of shapeKeys()) {
    const text = buildSnippet({ shape });
    assert.ok(text, `${shape} 生成失败`);
    if (shape.startsWith('yaml.')) {
      // YAML 片段不 JSON.parse，交给专门的 yaml-hosts 测试按结构核对
      assert.ok(text.includes('nexi'), `${shape} 片段里没有 nexi`);
      assert.ok(text.includes('command') || text.includes('cmd:'), `${shape} 片段里没有命令字段`);
      continue;
    }
    const data = JSON.parse(text);
    assert.equal(typeof data, 'object');
    const servers = shape === 'mcp.servers'
      ? data.mcp.servers
      : (shape === 'mcp.local' || shape === 'mcp.stdio' ? data.mcp : data[shape]);
    assert.ok(servers && servers.nexi, `${shape} 下没有 nexi 这一项`);
    const entry = servers.nexi;
    assert.ok(entry.command, `${shape} 的 entry 没有 command`);
  }
  // 每种形状的 entry 细节不同，逐个盯住，别让"生成成功但宿主读不懂"混过去。
  const mcpServers = JSON.parse(buildSnippet({ shape: 'mcpServers' })).mcpServers.nexi;
  assert.deepEqual(Object.keys(mcpServers).sort(), ['args', 'command', 'env']);
  const servers = JSON.parse(buildSnippet({ shape: 'servers' })).servers.nexi;
  assert.equal(servers.type, 'stdio', 'VS Code 不给 type 会把本地命令当远程');
  assert.ok(Array.isArray(servers.args));
  const oc = JSON.parse(buildSnippet({ shape: 'mcp.servers' })).mcp.servers.nexi;
  assert.equal(oc.type, 'local');
  assert.ok(Array.isArray(oc.command), 'OpenCode 的 command 必须是数组');
  assert.ok(oc.environment, 'OpenCode 用 environment 不是 env');
  const kilo = JSON.parse(buildSnippet({ shape: 'mcp.local' })).mcp.nexi;
  assert.equal(kilo.type, 'local');
  assert.ok(Array.isArray(kilo.command));
  const crush = JSON.parse(buildSnippet({ shape: 'mcp.stdio' })).mcp.nexi;
  assert.equal(crush.type, 'stdio');
  assert.equal(typeof crush.command, 'string');
  const amp = JSON.parse(buildSnippet({ shape: 'amp.mcpServers' }));
  assert.ok(amp['amp.mcpServers'].nexi, 'amp 的键名是 amp.mcpServers');
  const toml = buildSnippet({ toml: true });
  assert.match(toml, /^\[mcp_servers\.nexi\]$/m);
  assert.match(toml, /^command = "/m);
  assert.match(toml, /^args = \[/m);
});

test('注册表：丢一份 JSON 进去就能接新 Agent（不发版）', () => {
  const dir = home();
  const cfgFile = path.join(dir, 'newagent', 'mcp.json');
  const saved = saveCustomHost({
    id: 'newagent',
    label: 'New Agent',
    kind: 'json',
    shape: 'servers',
    paths: [cfgFile],
    docs: 'https://example.com/mcp',
    cli: 'newagent',
  }, { dir: path.join(dir, 'hosts.d'), ctx: platformCtx() });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const loaded = loadCustomHosts({ dir: path.join(dir, 'hosts.d') });
  assert.equal(loaded.hosts.length, 1);
  assert.equal(loaded.hosts[0].id, 'newagent');
  assert.equal(loaded.hosts[0].source, 'custom');
  assert.deepEqual(loaded.hosts[0].paths(), [cfgFile]);

  // 合并：自定义排前面，且同名会覆盖内置
  const merged = mergeHosts(BUILTIN_HOSTS, loaded.hosts);
  assert.equal(merged[0].id, 'newagent');
  assert.equal(merged.length, BUILTIN_HOSTS.length + 1);
  const overridden = mergeHosts(BUILTIN_HOSTS, [normalizeHostSpec({ id: 'cursor', paths: ['/tmp/x.json'] }).host]);
  assert.equal(overridden.filter((h) => h.id === 'cursor').length, 1, '同名宿主必须只留一个');
  assert.equal(overridden[0].source, 'custom');
  rmSync(dir, { recursive: true, force: true });
});

test('注册表：坏文件只跳过，不让整张表起不来', () => {
  const dir = home();
  mkdirSync(path.join(dir, 'hosts.d'), { recursive: true });
  writeFileSync(path.join(dir, 'hosts.d', 'broken.json'), '{ 这不是 JSON', 'utf8');
  writeFileSync(path.join(dir, 'hosts.d', 'relative.json'), JSON.stringify({ id: 'relagent', paths: ['mcp.json'] }), 'utf8');
  writeFileSync(path.join(dir, 'hosts.d', 'badid.json'), JSON.stringify({ id: '../../etc', paths: ['/tmp/a.json'] }), 'utf8');
  const res = loadCustomHosts({ dir: path.join(dir, 'hosts.d') });
  assert.equal(res.hosts.length, 0, '坏文件不该产出宿主');
  assert.equal(res.problems.length, 3, `应报 3 个问题，实际 ${JSON.stringify(res.problems)}`);
  assert.ok(res.problems.some((p) => /JSON/.test(p.error)));
  assert.ok(res.problems.some((p) => /绝对路径/.test(p.error)));
  assert.ok(res.problems.some((p) => /id 不合法/.test(p.error)));
  rmSync(dir, { recursive: true, force: true });
});

test('注册表：~ 和 ${ENV} 会被展开，且展开后必须是绝对路径', () => {
  const ok = normalizeHostSpec({ id: 'tildeagent', paths: ['~/.tilde/mcp.json'] });
  assert.equal(ok.ok, true);
  assert.ok(path.isAbsolute(ok.host.paths()[0]));
  const env = normalizeHostSpec({ id: 'envagent', paths: ['${HOME}/.envagent/mcp.json'] },
    platformCtx({ env: { ...process.env, HOME: process.env.HOME || process.env.USERPROFILE } }));
  assert.equal(env.ok, true, JSON.stringify(env.errors));
  const bad = normalizeHostSpec({ id: 'semiagent', paths: ['relative/mcp.json'] });
  assert.equal(bad.ok, false);
});

test('临时通道：install custom 能写进任何未收录的 Agent', () => {
  const dir = home();
  const file = path.join(dir, 'whatever', 'mcp.json');
  mkdirSync(path.dirname(file), { recursive: true });
  const r = run(['install', 'custom', file, '--shape', 'context_servers'], { DSH_HOME: path.join(dir, 'dsh') });
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(data.context_servers.nexi.command, '没写进 context_servers');
  assert.ok(Array.isArray(data.context_servers.nexi.args));
  rmSync(dir, { recursive: true, force: true });
});

test('临时通道：不认识的 shape 直接拒绝，不乱写文件', () => {
  const dir = home();
  const file = path.join(dir, 'x.json');
  const r = run(['install', 'custom', file, '--shape', 'nonsense'], { DSH_HOME: path.join(dir, 'dsh') });
  assert.equal(r.status, 2);
  assert.equal(existsSync(file), false, '拒绝的时候不该创建文件');
  rmSync(dir, { recursive: true, force: true });
});

test('CLI：host add → install → host list --json 全链路', () => {
  const dir = home();
  const dsh = path.join(dir, 'dsh');
  const file = path.join(dir, 'agent2', 'settings.json');
  mkdirSync(path.dirname(file), { recursive: true });

  const add = run(['host', 'add', 'agent2', file, '--label', 'Agent Two', '--shape', 'mcpServers'], { DSH_HOME: dsh });
  assert.equal(add.status, 0, add.stderr);
  assert.ok(JSON.parse(add.stdout).ok);

  const list = run(['host', 'list', '--json'], { DSH_HOME: dsh });
  assert.equal(list.status, 0, list.stderr);
  const data = JSON.parse(list.stdout);
  const row = data.hosts.find((h) => h.id === 'agent2');
  assert.ok(row, 'host list 里没有新加的宿主');
  assert.equal(row.source, 'custom');
  assert.equal(data.hosts.length, HOSTS.length + 1);

  const inst = run(['install', 'agent2', file], { DSH_HOME: dsh });
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).mcpServers.nexi);

  const rm = run(['host', 'rm', 'agent2'], { DSH_HOME: dsh });
  assert.equal(rm.status, 0, rm.stderr);
  const after = JSON.parse(run(['host', 'list', '--json'], { DSH_HOME: dsh }).stdout);
  assert.equal(after.hosts.some((h) => h.id === 'agent2'), false);
  rmSync(dir, { recursive: true, force: true });
});

test('兜底通道：nexi snippet 三个出口都对', () => {
  const plain = run(['snippet', '--shape', 'servers', '--portable']);
  assert.equal(plain.status, 0, plain.stderr);
  const data = JSON.parse(plain.stdout);
  assert.equal(data.servers.nexi.command, 'node', '--portable 必须是裸 node');

  const toml = run(['snippet', '--shape', 'toml']);
  assert.equal(toml.status, 0, toml.stderr);
  assert.match(toml.stdout, /\[mcp_servers\.nexi\]/);

  const dir = home();
  const out = path.join(dir, 'snippet.json');
  const written = run(['snippet', '--shape', 'mcpServers', '--out', out]);
  assert.equal(written.status, 0, written.stderr);
  assert.ok(JSON.parse(readFileSync(out, 'utf8')).mcpServers.nexi);
  rmSync(dir, { recursive: true, force: true });
});

test('安装到任意路径时：已有别的 server 不会被我们覆盖', () => {
  const dir = home();
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }), 'utf8');
  const host = adHocHost({ shape: 'mcpServers', path: file });
  const res = installHost('custom', { host, path: file });
  assert.equal(res.ok, true, JSON.stringify(res));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(data.mcpServers.other, '别人家的 server 被弄丢了');
  assert.ok(data.mcpServers.nexi);
  rmSync(dir, { recursive: true, force: true });
});
