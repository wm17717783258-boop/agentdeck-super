/**
 * tests/pack-clean.test.mjs —— 打包体检脚本本身得先可靠
 *
 * 这个脚本是要拦"把令牌发出去"的，它自己判错就是二次事故。
 * 所以用一个**专门造的假仓库**测它，不依赖真实仓库当前脏不脏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const SCRIPT = join(PKG, 'tools', 'pack-clean.mjs');

/** 跑一次体检，拿 JSON 结果。 */
function runScan(root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, json, stderr: r.stderr || '' };
}

function makeRepo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-packclean-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return root;
}

test('干净仓库：退出码 0，没有高危项', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'x', files: ['lib'] }),
    'lib/index.js': 'export const a = 1;',
    'README.md': '# x',
  });
  try {
    const { status, json } = runScan(root);
    assert.equal(status, 0, '干净仓库应该过');
    assert.equal(json.ok, true);
    assert.equal(json.counts.high, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('抓得到 .secrets 整棵目录（并且不往里翻）', () => {
  const root = makeRepo({
    '.secrets/gh.token': 'gho_example',
    '.secrets/nested/deep.txt': 'x',
    'lib/a.js': 'x',
  });
  try {
    const { status, json } = runScan(root);
    assert.equal(status, 1, '有高危项就该非 0');
    assert.equal(json.ok, false);
    const hit = json.findings.find((f) => f.rule === 'secrets');
    assert.ok(hit, '应该报 .secrets');
    assert.equal(hit.severity, 'high');
    assert.ok(json.skippedDirs.includes('.secrets'), '整棵跳过，不该往里翻');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('抓得到 internal / .tools / node_modules', () => {
  const root = makeRepo({
    'internal/PRO.md': '定价红线',
    '.tools/thing.exe': 'MZ',
    'node_modules/dep/index.js': 'x',
    'lib/a.js': 'x',
  });
  try {
    const { json } = runScan(root);
    const ids = json.findings.map((f) => f.rule);
    assert.ok(ids.includes('internal'));
    assert.ok(ids.includes('tools-bin'));
    assert.ok(ids.includes('node-modules'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('抓得到私钥 .pem 和 .env', () => {
  const root = makeRepo({
    'lib/some-private.pem': 'KEY',
    '.env': 'API_KEY=xxx',
    '.env.local': 'API_KEY=yyy',
    'lib/a.js': 'x',
  });
  try {
    const { json } = runScan(root);
    const paths = json.findings.map((f) => f.path.replace(/\\/g, '/'));
    assert.ok(paths.includes('lib/some-private.pem'), `应报私钥，实际：${paths.join(',')}`);
    assert.ok(paths.includes('.env'));
    assert.ok(paths.includes('.env.local'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assets 下的示例 pem 是允许的（白名单生效，不误报）', () => {
  const root = makeRepo({
    'assets/certs/demo.pem': 'SAMPLE',
    'assets/skins/basic/basic.svg': '<svg/>',
    'lib/a.js': 'x',
  });
  try {
    const { status, json } = runScan(root);
    assert.equal(status, 0, `assets 下的示例不该被判高危：${JSON.stringify(json.findings)}`);
    assert.equal(json.counts.high, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('抓得到 tgz / zip / log / sourcemap', () => {
  const root = makeRepo({
    'dist.tgz': 'x',
    'pack.zip': 'x',
    'run.log': 'x',
    'lib/a.js.map': 'x',
    'lib/a.js': 'x',
  });
  try {
    const { json } = runScan(root);
    const paths = json.findings.map((f) => f.path.replace(/\\/g, '/'));
    assert.ok(paths.includes('dist.tgz'));
    assert.ok(paths.includes('pack.zip'));
    assert.ok(paths.includes('run.log'));
    assert.ok(paths.includes('lib/a.js.map'));
    assert.equal(json.counts.high, 0, '这些不该算高危');
    assert.ok(json.counts.medium >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('算出可回收体积（给人一个"删了能省多少"的数）', () => {
  const root = makeRepo({
    'node_modules/dep/big.js': 'x'.repeat(5000),
    'lib/a.js': 'x',
  });
  try {
    const { json } = runScan(root);
    assert.ok(json.reclaimableBytes > 0, '应该算得出体积');
    assert.ok(typeof json.reclaimable === 'string' && json.reclaimable.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--allowlist：把 npm files 白名单摆出来', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'x', files: ['lib', 'bin'] }),
    'lib/a.js': 'x',
  });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json', '--allowlist'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const json = JSON.parse(r.stdout);
    assert.ok(json.allowlist, '应该带上白名单信息');
    assert.deepEqual(json.allowlist.declared, ['lib', 'bin']);
    assert.ok(json.allowlist.missingFromAllowlist.includes('internal'), '内部目录不该在白名单里');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空目录不崩，如实报 0 项', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-packclean-empty-'));
  try {
    const { status, json } = runScan(root);
    assert.equal(status, 0);
    assert.equal(json.counts.total, 0);
    assert.equal(json.scannedFiles, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('在真实仓库上跑：退出码必须是 0 或 1，不能崩', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', windowsHide: true, cwd: PKG });
  assert.ok(r.status === 0 || r.status === 1, `不该是 ${r.status}：${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.equal(typeof json.ok, 'boolean');
  assert.ok(Array.isArray(json.findings));
});

/**
 * 回归：体检必须能按**内容**抓出泄露，而不是只看文件名。
 *
 * 真机踩到的场景：docs/evidence/*.txt 名字完全正常，但里面原样记着
 * 真机测试用的内网 IP（192.168.1.10）和房间邀请令牌（?t=<32位>）。
 * 这些会随 npm 包（files 白名单含 docs/）发给所有下载的人。
 *
 * 这个测试要"会真变红"：如果 CONTENT_RULES 被删掉，下面的断言就会失败。
 */
test('内容体检：能抓出文件里的真实内网 IP 与邀请令牌', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /CONTENT_RULES/, '必须有内容级规则表');
  assert.match(src, /private-lan-ip/, '必须能抓真实内网 IP');
  assert.match(src, /room-invite-token/, '必须能抓房间邀请令牌');
  // 必须有误报白名单，否则体检结果会被示例 IP 淹没、失去可信度
  assert.match(src, /EXAMPLE_IPS|isExampleIp/, '必须有示例 IP 白名单减少误报');
});

test('内容体检：真实命中会写进提示，且区分示例 IP', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /isExampleIp\(m\[1\]\)/, '示例 IP 应在规则里被跳过');
  assert.match(src, /SELF_SKIP/, '体检脚本自身不该被自己报出来');
});
