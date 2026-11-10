/**
 * tests/diagnostics.test.mjs —— 诊断包：能带走现场，但不能带走密钥。
 *
 * 这类功能的风险全在"导多了"：配置文件里明摆着有 API key、token、内网地址，
 * 一旦整份拷进诊断包，用户为了求助把 key 发到群里，就是二次事故。
 *
 * 所以这里的断言分两类：
 *   ① 该有的都有（版本、宿主、日志、备份、说明）；
 *   ② 不该有的一个都不能有 —— 用一份**故意塞了假密钥**的配置验证，
 *      再拿本机真实配置跑一遍，全目录搜不到任何长随机串。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDiagnostics, shapeOfConfig, redactPath } from '../lib/diagnostics.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => mkdtempSync(path.join(tmpdir(), 'nexi-diag-'));

const FAKE_KEY = 'sk-测试用的假密钥-abcdefghijklmnop-0123456789';

test('脱敏：家目录换成 ~，用户名不出门', () => {
  const home = homedir();
  const p = path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  const red = redactPath(p, home);
  assert.ok(red.startsWith('~'), `没缩成 ~：${red}`);
  assert.ok(!red.includes(home), '仍然是完整家目录');
  assert.equal(redactPath('/etc/hosts', home), '/etc/hosts', '系统路径不该被动');
  assert.equal(redactPath('', home), '');
});

test('配置结构：只出键名与大小，绝不出值', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    mcpServers: {
      nexi: { command: 'node', args: ['x.mjs', 'mcp'], env: { NEKI_TOKEN: FAKE_KEY } },
      other: { command: 'y', env: { apiKey: FAKE_KEY } },
    },
    preferences: { theme: 'dark' },
  }, null, 2));

  const shape = shapeOfConfig(file);
  const text = JSON.stringify(shape);

  assert.equal(shape.format, 'json');
  assert.deepEqual(shape.topKeys, ['mcpServers', 'preferences']);
  assert.equal(shape.nexi.present, true);
  assert.equal(shape.nexi.where, 'mcpServers');
  assert.deepEqual(shape.nexi.fields, ['args', 'command', 'env']);

  // 核心：整个结构描述里不能出现那个假密钥，也不能出现它的任何片段
  assert.ok(!text.includes(FAKE_KEY), '结构描述里带出了密钥值');
  assert.ok(!text.includes('abcdefghij'), '密钥片段泄露');
});

test('配置结构：坏 JSON 要如实报告，且不把原文倒出来', () => {
  const dir = tmp();
  const file = path.join(dir, 'broken.json');
  writeFileSync(file, `{ "mcpServers": { "x": { "apiKey": "${FAKE_KEY}" } }, `); // 少个右括号

  const shape = shapeOfConfig(file);
  assert.equal(shape.format, 'json (解析失败)');
  assert.ok(shape.parseError, '没有报错原因');
  const text = JSON.stringify(shape);
  assert.ok(!text.includes(FAKE_KEY), '解析失败时把原文带出来了');
});

test('配置结构：YAML 宿主也能描述（Goose 的 extensions 层级）', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, [
    'active_provider: anthropic',
    'providers:',
    '  anthropic:',
    '    api_key: ' + FAKE_KEY,
    'extensions:',
    '  nexi:',
    '    type: stdio',
    '    cmd: node',
    '  developer:',
    '    type: builtin',
    '',
  ].join('\n'));

  const shape = shapeOfConfig(file);
  assert.equal(shape.format, 'yaml');
  assert.ok(shape.topKeys.includes('extensions'), `顶层键不对：${shape.topKeys}`);
  assert.equal(shape.nexi.present, true);
  assert.ok(!JSON.stringify(shape).includes(FAKE_KEY), 'YAML 里的 api_key 泄露了');
});

test('配置结构：文件不存在 / 空文件 / 读不了 都不抛', () => {
  const dir = tmp();
  assert.deepEqual(shapeOfConfig(path.join(dir, 'nope.json')), { exists: false });

  const empty = path.join(dir, 'empty.json');
  writeFileSync(empty, '   \n');
  assert.equal(shapeOfConfig(empty).format, 'empty');

  const unreadable = path.join(dir, 'locked.json');
  writeFileSync(unreadable, '{}');
  // 目录当文件读会 EISDIR
  const asDir = shapeOfConfig(dir);
  assert.equal(asDir.readable, false, '目录当文件读应该报不可读');
  assert.ok(asDir.error);
});

test('诊断包：文件齐、README 在、meta 里没有真实家目录', () => {
  const out = tmp();
  const diag = buildDiagnostics({ version: '9.9.9', doctorText: '结论 PASS', outDir: out });

  assert.equal(diag.ok, true);
  assert.ok(existsSync(diag.dir), '目录没建出来');
  for (const name of ['README.txt', 'meta.json', 'doctor.txt', 'hosts.json', 'config-shapes.json', 'backups.json', 'locks.json', 'state.json', 'logs.tail.txt']) {
    assert.ok(diag.files.includes(name), `少了 ${name}`);
    assert.ok(existsSync(path.join(diag.dir, name)), `${name} 没落盘`);
  }

  const meta = JSON.parse(readFileSync(path.join(diag.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.nexi, '9.9.9');
  assert.equal(meta.home, '~', 'meta 里带了真实家目录');
  assert.ok(!JSON.stringify(meta).includes(homedir()), 'meta 泄露了家目录');

  const readme = readFileSync(path.join(diag.dir, 'README.txt'), 'utf8');
  assert.match(readme, /没有/);
  assert.match(readme, /key/i);
});

test('诊断包：拿本机真实配置跑一遍，全目录搜不到任何长随机串', () => {
  const out = tmp();
  const diag = buildDiagnostics({ version: '9.9.9', doctorText: 'x', outDir: out });

  // 把所有文件拼起来，找形如 sk-xxx / 32 位以上十六进制 / ghp_ 的串
  let all = '';
  for (const f of readdirSync(diag.dir)) {
    all += readFileSync(path.join(diag.dir, f), 'utf8');
  }
  const secrets = all.match(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|[a-f0-9]{40,}|eyJ[A-Za-z0-9_-]{20,})\b/g) || [];
  assert.deepEqual(secrets.slice(0, 5), [], `诊断包里出现了疑似密钥：${secrets.slice(0, 3).join(', ')}`);

  // 也不许出现完整家目录
  assert.ok(!all.includes(homedir()), '诊断包里出现了完整家目录路径');
});

test('诊断包：--out 指向不存在的多层目录也能建', () => {
  const out = path.join(tmp(), 'a', 'b', 'c');
  const diag = buildDiagnostics({ version: '1.0.0', doctorText: 'x', outDir: out });
  assert.ok(existsSync(diag.dir));
  assert.equal(path.dirname(diag.dir), out);
});
