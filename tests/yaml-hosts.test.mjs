/**
 * tests/yaml-hosts.test.mjs —— YAML 宿主（Goose / Continue 新版）的写入与回滚。
 *
 * 这一组的重点是**不毁用户文件**：
 *   · 注释、别的扩展、键顺序都得留着（所以我们不整份重新序列化）；
 *   · 装两次不能变两次（幂等）；
 *   · 卸完必须逐字节回到装之前；
 *   · 生成的 YAML 得真能被解析成预期的结构。
 *
 * 最后一条用一个**测试里独立写的** YAML 子集解析器来验 —— 不用产物自己的代码验自己，
 * 也不给运行时加依赖（这个包的硬要求是零依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findHost, installHost, uninstallHost, buildSnippet, kindFor, adHocHost } from '../lib/connect/hosts.js';
import { platformCtx } from '../lib/connect/platform.js';

// ---------------------------------------------------------------- 测试用 YAML 解析

/** 解析我们可能产出的 YAML 子集：块状 map / 块状 seq / 流式数组 / 引号标量 / 注释。 */
export function parseYaml(text) {
  const raw = String(text).replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (const l of raw) {
    if (!l.trim()) continue;
    if (/^\s*#/.test(l)) continue;
    lines.push(l.replace(/\s+$/, ''));
  }
  if (!lines.length) return null;
  let i = 0;
  const indentOf = (l) => /^[ \t]*/.exec(l)[0].length;
  const isSeqLine = (l) => /^[ \t]*-([ \t]+|$)/.test(l);
  const splitKey = (l) => {
    const m = /^[ \t]*([^:]+?)[ \t]*:[ \t]?(.*)$/.exec(l);
    return m ? [m[1].replace(/^["']|["']$/g, ''), m[2]] : null;
  };
  const scalar = (s) => {
    const t = String(s).trim();
    if (t === '{}') return {};
    if (t === '[]') return [];
    if (t.startsWith('[') && t.endsWith(']')) return flowSeq(t);
    if (/^".*"$/.test(t)) return JSON.parse(t);
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+$/.test(t)) return Number(t);
    return t;
  };
  const flowSeq = (t) => {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    const out = [];
    let cur = '';
    let q = null;
    for (const ch of inner) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === ',') { out.push(scalar(cur)); cur = ''; continue; }
      cur += ch;
    }
    out.push(scalar(cur));
    return out;
  };
  const parseMap = (indent) => {
    const obj = {};
    while (i < lines.length && indentOf(lines[i]) === indent && !isSeqLine(lines[i])) {
      const kv = splitKey(lines[i]);
      if (!kv) break;
      i += 1;
      const [k, v] = kv;
      if (v === '') {
        obj[k] = i < lines.length && indentOf(lines[i]) > indent ? parseBlock(indentOf(lines[i])) : null;
      } else {
        obj[k] = scalar(v);
      }
    }
    return obj;
  };
  const parseSeq = (indent) => {
    const arr = [];
    while (i < lines.length && indentOf(lines[i]) === indent && isSeqLine(lines[i])) {
      const after = lines[i].replace(/^[ \t]*-[ \t]*/, '');
      if (/^[^:]+?:([ \t]|$)/.test(after)) {
        const childIndent = indent + 2;
        lines[i] = `${' '.repeat(childIndent)}${after}`;
        arr.push(parseMap(childIndent));
      } else {
        i += 1;
        arr.push(scalar(after));
      }
    }
    return arr;
  };
  const parseBlock = (indent) => (isSeqLine(lines[i]) ? parseSeq(indent) : parseMap(indent));
  return parseBlock(indentOf(lines[0]));
}

const tmpFile = (name, content) => {
  const dir = mkdtempSync(join(tmpdir(), 'nexi-yaml-'));
  const file = join(dir, name);
  if (content !== undefined) writeFileSync(file, content, 'utf8');
  return file;
};

// ---------------------------------------------------------------- 路径

test('Goose 三系统路径：Windows 多一层 Block/config，mac/linux 走 ~/.config', () => {
  const goose = findHost('goose');
  assert.ok(goose, 'Goose 没进接入表');
  const win = goose.paths(platformCtx({
    platform: 'win32', home: 'C:\\Users\\u', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
  }))[0];
  assert.match(win, /Block[\\/]goose[\\/]config[\\/]config\.yaml$/, win);
  for (const plat of ['darwin', 'linux']) {
    const p = goose.paths(platformCtx({ platform: plat, home: plat === 'darwin' ? '/Users/u' : '/home/u', env: {} }))[0];
    assert.equal(p, `${plat === 'darwin' ? '/Users/u' : '/home/u'}/.config/goose/config.yaml`);
    assert.ok(!p.includes('AppData'), `${plat} 不该出现 AppData：${p}`);
    assert.ok(!p.includes('\\'), `${plat} 不该出现反斜杠：${p}`);
  }
});

test('Continue 两代格式：path 先 yaml，写入器按目标文件扩展名决定', () => {
  const cont = findHost('continue');
  assert.ok(cont);
  assert.equal(cont.kind, 'auto');
  const paths = cont.paths(platformCtx({ platform: 'linux', home: '/home/u', env: {} }));
  assert.match(paths[0], /config\.yaml$/);
  assert.match(paths[1], /config\.json$/);
  assert.equal(kindFor(cont, '/home/u/.continue/config.yaml'), 'yaml');
  assert.equal(kindFor(cont, '/home/u/.continue/config.json'), 'json');
  assert.equal(kindFor(findHost('goose'), 'x.yaml'), 'yaml');
  assert.equal(kindFor(findHost('codex'), 'x.toml'), 'toml');
});

// ---------------------------------------------------------------- Goose（map 形状）

const GOOSE_BEFORE = [
  '# 我自己的 goose 配置',
  'active_provider: anthropic',
  'providers:',
  '  anthropic:',
  '    enabled: true',
  '',
  'extensions:',
  '  developer:',
  '    type: builtin',
  '    name: developer',
  '    enabled: true',
  '',
].join('\n');

test('Goose：写进 extensions.<id>，字段是 cmd/args/envs/timeout，别家扩展与注释都在', () => {
  const file = tmpFile('config.yaml', GOOSE_BEFORE);
  // 显式给一条带反斜杠的 Windows 路径：YAML 双引号里 `\U` `\A` 都是非法转义，
  // 写的时候必须转义成 \\，读回来还要一模一样 —— 这是最容易出"装了起不来"的地方。
  const launch = { command: 'C:\\Users\\u\\Apps\\nodejs\\node.exe', args: ['D:\\ai\\nexi\\bin\\nexi.mjs', 'mcp'], env: {} };
  const r = installHost('goose', { path: file, force: true, launch });
  assert.equal(r.ok, true, JSON.stringify(r));
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('# 我自己的 goose 配置'), '注释被吃掉了');
  const doc = parseYaml(text);
  assert.equal(doc.active_provider, 'anthropic');
  assert.equal(doc.extensions.developer.name, 'developer', '别家扩展被覆盖了');
  const nexi = doc.extensions.nexi;
  assert.equal(nexi.type, 'stdio');
  assert.equal(nexi.enabled, true);
  assert.equal(nexi.timeout, 300);
  assert.equal(nexi.cmd, launch.command, 'Windows 路径没原样还原（转义错了）');
  assert.deepEqual(nexi.args, launch.args);
  assert.deepEqual(nexi.envs, {});
});

test('Goose：装两次是同一份东西（幂等），卸载逐字节回到装之前', () => {
  const file = tmpFile('config.yaml', GOOSE_BEFORE);
  assert.equal(installHost('goose', { path: file, force: true }).changed, true);
  const second = installHost('goose', { path: file, force: true });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false, '第二次不该再改文件');

  const back = uninstallHost('goose', { path: file });
  assert.equal(back.ok, true);
  assert.equal(back.changed, true);
  assert.equal(readFileSync(file, 'utf8'), GOOSE_BEFORE, '卸载后应与装之前一字不差');
});

test('Goose：文件不存在时新建，只有一个 extensions 块', () => {
  const file = tmpFile('config.yaml');
  const r = installHost('goose', { path: file, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const text = readFileSync(file, 'utf8');
  assert.equal((text.match(/^extensions:/gm) || []).length, 1, '不该写出两个顶层 extensions');
  const doc = parseYaml(text);
  assert.ok(doc.extensions.nexi.cmd);
});

test('Goose：CRLF 文件写入后仍是 CRLF（不把用户的换行风格搞混）', () => {
  const crlf = `${GOOSE_BEFORE.replace(/\n/g, '\r\n')}`;
  const file = tmpFile('config.yaml', crlf);
  assert.equal(installHost('goose', { path: file, force: true }).ok, true);
  const text = readFileSync(file, 'utf8');
  const lone = text.split('\r\n').join('').includes('\n');
  assert.equal(lone, false, '混进了裸 LF');
  assert.equal(uninstallHost('goose', { path: file }).ok, true);
  assert.equal(readFileSync(file, 'utf8'), crlf);
});

test('Goose：已有同名但不是我们写的 → 默认拒写，--force 才覆盖', () => {
  const mine = ['extensions:', '  nexi:', '    type: stdio', '    cmd: someone-else', ''].join('\n');
  const file = tmpFile('config.yaml', mine);
  const r = installHost('goose', { path: file, force: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'config-conflict');
  assert.match(String(r.warnings.join(' ')), /已有 nexi/);
  assert.equal(readFileSync(file, 'utf8'), mine, '拒写时不能动文件');

  const forced = installHost('goose', { path: file, force: true });
  assert.equal(forced.ok, true);
  const doc = parseYaml(readFileSync(file, 'utf8'));
  assert.notEqual(doc.extensions.nexi.cmd, 'someone-else');
  assert.equal(doc.extensions.nexi.type, 'stdio');
});

// ---------------------------------------------------------------- Continue（list 形状）

const CONT_BEFORE = [
  'name: my-config',
  'version: 0.0.1',
  'schema: v1',
  'models: []',
  '',
  'mcpServers:',
  '  - name: sqlite',
  '    command: npx',
  '    args:',
  '      - "-y"',
  '      - mcp-sqlite',
  '',
].join('\n');

test('Continue：写进 mcpServers 列表（不是对象），别的 server 留着', () => {
  const file = tmpFile('config.yaml', CONT_BEFORE);
  const r = installHost('continue', { path: file, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const doc = parseYaml(readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(doc.mcpServers), 'Continue 新版要求列表');
  assert.equal(doc.mcpServers.length, 2);
  assert.equal(doc.mcpServers[0].name, 'sqlite', '原有的 server 被挤掉/改写了');
  const nexi = doc.mcpServers[1];
  assert.equal(nexi.name, 'nexi');
  assert.equal(nexi.type, 'stdio');
  assert.equal(typeof nexi.command, 'string');
  assert.deepEqual(nexi.args.slice(1), ['mcp']);
  assert.deepEqual(nexi.env, {});
});

test('Continue：幂等 + 卸载回到原样（列表项整段剪掉，不留空行垃圾）', () => {
  const file = tmpFile('config.yaml', CONT_BEFORE);
  installHost('continue', { path: file, force: true });
  assert.equal(installHost('continue', { path: file, force: true }).changed, false);
  assert.equal(uninstallHost('continue', { path: file }).ok, true);
  assert.equal(readFileSync(file, 'utf8'), CONT_BEFORE);
});

test('Continue：老 config.json 仍按 JSON 写（同一个宿主两代格式都认）', () => {
  const file = tmpFile('config.json', JSON.stringify({ mcpServers: { keep: { command: 'x' } } }, null, 2));
  const r = installHost('continue', { path: file, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(doc.mcpServers.keep, '老的别家 server 丢了');
  assert.equal(typeof doc.mcpServers.nexi.command, 'string', 'JSON 里的 entry 不该变成列表');
  assert.equal(uninstallHost('continue', { path: file }).ok, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers), ['keep']);
});

// ---------------------------------------------------------------- 片段与临时通道

test('snippet 的两种 YAML 形状都能被解析成预期的 key', () => {
  const goose = parseYaml(buildSnippet({ shape: 'yaml.extensions' }));
  assert.ok(goose.extensions.nexi.cmd, 'Goose 片段结构不对');
  const cont = parseYaml(buildSnippet({ shape: 'yaml.mcpServers' }));
  assert.ok(Array.isArray(cont.mcpServers), 'Continue 片段应该是列表');
  assert.equal(cont.mcpServers[0].name, 'nexi');
});

test('install custom：未收录的 YAML 宿主也能写（临时通道）', () => {
  const file = tmpFile('agent.yaml', '');
  const host = adHocHost({ id: 'custom', label: '自定义', kind: 'yaml', shape: 'yaml.mcpServers', path: file });
  const r = installHost('custom', { host, path: file, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const doc = parseYaml(readFileSync(file, 'utf8'));
  assert.equal(doc.mcpServers[0].name, 'nexi');
});
