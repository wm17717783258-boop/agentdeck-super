/**
 * tests/cross-platform-files.test.mjs —— 「别人家的配置文件长什么样」的机器验收。
 *
 * 用户的要求是「不分电脑系统」。这句话在路径之外还有一层更细的意思是：
 * **同一个文件，从 Windows 记事本、PowerShell、Linux vim 里出来，字节是不一样的。**
 * 插件如果只认自己爱写的那种字节，那它实际上还是「分系统」的 ——
 * 只不过分界线从操作系统变成了编辑器。
 *
 * 这个文件锁住五件事：
 *   ① UTF-8 BOM：读得懂，也**还回去**（不能装一次 MCP 就把文件编码改掉）；
 *   ② UTF-16：明确告诉用户是什么编码、怎么转，而不是抛 JSON 语法错；
 *   ③ CRLF：写回不混行，二次安装判「无变化」，卸载逐字节还原；
 *   ④ YAML 的 BOM 与 CRLF 同样保留；
 *   ⑤ 宿主 id 不能用 Windows 设备名（注册表要能整个目录拷到另一台机器）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HOSTS, adHocHost, installHost, uninstallHost } from '../lib/connect/hosts.js';
import { normalizeHostSpec } from '../lib/connect/registry.js';
import { samePath } from '../lib/connect/audit.js';
import { sniffEncoding, detectEol, readConfigText } from '../lib/connect/encoding.js';

const LAUNCH = { command: 'node', args: ['/x/nexi.mjs', 'mcp'] };
const JSON_HOST = HOSTS.find((h) => h.kind === 'json' && !h.cli);
const TOML_HOST = HOSTS.find((h) => h.kind === 'toml');
const YAML_HOST = HOSTS.find((h) => h.kind === 'yaml');

function tmpdirOf(tag) {
  return mkdtempSync(path.join(tmpdir(), `nexi-${tag}-`));
}

/** 装到一个临时文件上（借用内置宿主的形状，路径换成临时的）。 */
function installAt(host, file) {
  const h = { ...host, paths: () => [file] };
  return installHost(host.id, { host: h, launch: LAUNCH, path: file, force: true });
}

test('UTF-8 BOM：读得懂、装得上、写回去还带 BOM', () => {
  const dir = tmpdirOf('bom');
  const file = path.join(dir, 'mcp.json');
  const original = '\uFEFF{\n  "mcpServers": {}\n}\n';
  writeFileSync(file, original);

  const r = installAt(JSON_HOST, file);
  assert.equal(r.ok, true, `带 BOM 的 JSON 被拒了：${JSON.stringify(r.warnings)}`);
  const after = readFileSync(file, 'utf8');
  assert.ok(after.startsWith('\uFEFF'), '安装后 BOM 丢了 —— 等于我们偷偷改了用户文件的编码');
  assert.match(after, /"nexi"/);
});

test('UTF-8 BOM：卸载后 BOM 仍在，用户内容还原', () => {
  const dir = tmpdirOf('bom-back');
  const file = path.join(dir, 'mcp.json');
  const original = '\uFEFF{\n  "mcpServers": {}\n}\n';
  writeFileSync(file, original);
  installAt(JSON_HOST, file);
  uninstallHost(JSON_HOST.id, { path: file });
  assert.equal(readFileSync(file, 'utf8'), original, '卸载没有逐字节还原（BOM 或格式被改）');
});

test('UTF-16 文件：拒绝改写，但说的是人话 + 怎么修', () => {
  const dir = tmpdirOf('utf16');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, Buffer.from('{\r\n  "mcpServers": {}\r\n}\r\n', 'utf16le'));

  const r = installAt(JSON_HOST, file);
  assert.equal(r.ok, false);
  const text = (r.warnings || []).join(' ');
  assert.match(text, /UTF-16/, '没有告诉用户这是 UTF-16');
  assert.match(text, /UTF-8/, '没有告诉用户该转成什么');
  assert.ok(!/Unexpected token|not valid JSON|JSON\.parse/i.test(text), `还在抛 JSON 语法错：${text}`);
  // 文件一个字节都不能动
  assert.equal(readFileSync(file).toString('utf16le'), '{\r\n  "mcpServers": {}\r\n}\r\n');
});

test('TOML CRLF：写回不混行', () => {
  const dir = tmpdirOf('toml-crlf');
  const file = path.join(dir, 'config.toml');
  writeFileSync(file, 'model = "x"\r\n\r\n[mcp_servers.other]\r\ncommand = "y"\r\n');
  installAt(TOML_HOST, file);

  const body = readFileSync(file, 'utf8');
  assert.ok(body.includes('\r\n'), '原文件是 CRLF，装完变成 LF 了');
  const mixed = body.split('\n').some((line) => line && !line.endsWith('\r'));
  assert.equal(mixed, false, '文件被写成了 CRLF 与 LF 混行');
  assert.match(body, /\[mcp_servers\.nexi\]/);
});

test('TOML：二次安装判「无变化」，不写盘不备份', () => {
  const dir = tmpdirOf('toml-idem');
  const file = path.join(dir, 'config.toml');
  writeFileSync(file, 'model = "x"\r\n');
  const first = installAt(TOML_HOST, file);
  const second = installAt(TOML_HOST, file);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false, '第二次安装仍判定有变化 → 每次都会写盘 + 堆备份');
});

test('TOML：卸载逐字节还原（CRLF / 无尾换行 / 空文件 / 纯 BOM）', () => {
  const dir = tmpdirOf('toml-back');
  const cases = [
    ['crlf', 'model = "x"\r\n\r\n[mcp_servers.other]\r\ncommand = "y"\r\n'],
    ['lf-no-tail', 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"'],
    ['empty', ''],
    ['bom-only', '\uFEFF'],
  ];
  for (const [name, original] of cases) {
    const file = path.join(dir, `${name}.toml`);
    writeFileSync(file, original);
    installAt(TOML_HOST, file);
    const u = uninstallHost(TOML_HOST.id, { path: file });
    assert.equal(u.ok, true, `${name} 卸载失败`);
    assert.equal(readFileSync(file, 'utf8'), original, `${name} 卸载后不是原文`);
  }
});

test('YAML：装完仍是原换行与 BOM，卸载还原', () => {
  assert.ok(YAML_HOST, '没有 YAML 宿主可测');
  const dir = tmpdirOf('yaml-crlf');
  const file = path.join(dir, 'config.yaml');
  const original = 'extensions:\r\n  other:\r\n    type: stdio\r\n    command: other\r\n';
  writeFileSync(file, original);
  const r = installAt(YAML_HOST, file);
  assert.equal(r.ok, true, `YAML 安装失败：${JSON.stringify(r.warnings)}`);
  const body = readFileSync(file, 'utf8');
  assert.ok(body.includes('\r\n'), 'YAML 的 CRLF 被改成了 LF');
  assert.equal(body.split('\n').some((l) => l && !l.endsWith('\r')), false, 'YAML 被写成混行');

  uninstallHost(YAML_HOST.id, { path: file });
  assert.equal(readFileSync(file, 'utf8'), original, 'YAML 卸载后不是原文');
});

test('宿主 id 不能用 Windows 设备名', () => {
  const dir = tmpdirOf('reserved');
  for (const id of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']) {
    const r = normalizeHostSpec({ id, label: id, path: path.join(dir, 'x.json'), shape: 'mcpServers' });
    assert.equal(r.ok, false, `${id} 被当成合法 id —— 在 Windows 上这个文件根本存不下`);
    assert.match(r.errors.join(' '), /设备名/);
  }
  // 正常 id 不受影响
  for (const id of ['console', 'con-1', 'com10', 'my-agent']) {
    const r = normalizeHostSpec({ id, label: id, path: path.join(dir, 'x.json'), shape: 'mcpServers' });
    assert.equal(r.ok, true, `${id} 被误判成保留名`);
  }
});

test('路径比较按目标系统的语义：Windows / macOS 不区分大小写，Linux 区分', () => {
  // 这个断言只在对应系统上有意义，但 samePath 读的是 process.platform，
  // 所以按当前平台给出期望值 —— 至少保证不会「Windows 上区分大小写」这种反向错误。
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  assert.equal(samePath('/Users/You/a.js', '/users/you/a.js'), caseInsensitive);
});

test('编码嗅探：BOM / 无 BOM 的 UTF-16 / 二进制，逐个认得出', () => {
  assert.equal(sniffEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x7b])).encoding, 'utf8-bom');
  assert.equal(sniffEncoding(Buffer.from([0xff, 0xfe, 0x7b, 0x00])).encoding, 'utf16le');
  assert.equal(sniffEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x7b])).encoding, 'utf16be');
  // 无 BOM 的 UTF-16LE：ASCII 文本 + \0
  const le = Buffer.from('{\n  "a": 1\n}\n', 'utf16le');
  assert.equal(sniffEncoding(le).encoding, 'utf16le');
  const be = Buffer.from(le);
  for (let i = 0; i < be.length; i += 2) {
    const t = be[i];
    be[i] = be[i + 1];
    be[i + 1] = t;
  }
  assert.equal(sniffEncoding(be).encoding, 'utf16be');
  // 正常 UTF-8 不能被误判
  assert.equal(sniffEncoding(Buffer.from('{"a":1}\n')).encoding, 'utf8');
  assert.equal(sniffEncoding(Buffer.from('{"名字":"王冕"}\n')).encoding, 'utf8');
});

test('readConfigText：不存在的文件不算错误，新建时按 LF 无 BOM', () => {
  const r = readConfigText(path.join(tmpdirOf('missing'), 'nope.json'));
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
  assert.equal(r.text, '');
  assert.equal(r.bom, '');
  assert.equal(r.eol, '\n');
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(existsSync(path.join(tmpdirOf('missing'), 'nope.json')), false);
});

test('JSON 缩进风格：单行 / 4 空格 / tab 都按原样还回去', () => {
  const dir = tmpdirOf('indent');
  const cases = [
    ['single-line', '{"mcpServers":{}}\n'],
    ['four-space', '{\n    "mcpServers": {}\n}\n'],
    ['tab', '{\n\t"mcpServers": {}\n}\n'],
  ];
  for (const [name, original] of cases) {
    const file = path.join(dir, `${name}.json`);
    writeFileSync(file, original);
    installAt(JSON_HOST, file);
    const mid = readFileSync(file, 'utf8');
    if (name === 'single-line') {
      assert.ok(!mid.includes('\n  "'), '单行文件被展开了');
    } else if (name === 'four-space') {
      assert.ok(mid.includes('\n    "mcpServers"'), '4 空格缩进被改成了别的宽度');
    } else {
      assert.ok(mid.includes('\n\t"mcpServers"'), 'tab 缩进被改成了空格');
    }
    uninstallHost(JSON_HOST.id, { path: file });
    assert.equal(readFileSync(file, 'utf8'), original, `${name} 卸载后没还原成原文`);
  }
});
