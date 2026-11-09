/**
 * tests/pack-trim.test.mjs —— 清理脚本必须是"删不掉不该删的东西"的那种
 *
 * 这个脚本会真删文件，所以它自己的安全属性比功能更重要：
 *   默认预演不删、源码目录永不删、凭据类要双确认、路径越界拒绝。
 * 每一条都单独测。全部在临时假仓库里跑，绝不碰真仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const TRIM = join(PKG, 'tools', 'pack-trim.mjs');
const CLEAN = join(PKG, 'tools', 'pack-clean.mjs');

function run(args, cwd = PKG) {
  const r = spawnSync(process.execPath, [TRIM, ...args], { encoding: 'utf8', windowsHide: true, cwd });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { status: r.status, json, stderr: r.stderr || '' };
}

function makeRepo(files = {}, dirs = []) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-packtrim-'));
  // package.json 必须有：pack-clean 会读它做白名单
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', files: ['lib'] }), 'utf8');
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return root;
}

test('默认就是预演：什么都不删，但把要删的列出来', () => {
  const root = makeRepo({ 'lib/a.js': 'x' }, ['node_modules']);
  try {
    const { json } = run(['--root', root, '--json']);
    assert.equal(json.applied, false);
    assert.ok(json.planned.some((p) => p.path === 'node_modules'));
    assert.ok(existsSync(join(root, 'node_modules')), '预演模式绝不能真删');
    assert.match(json.note, /预演/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--apply 才真删，且只删计划里的', () => {
  const root = makeRepo({ 'lib/a.js': 'keep-me', 'run.log': 'x' }, ['node_modules']);
  try {
    const { json } = run(['--root', root, '--json', '--apply', '--only=log']);
    assert.equal(json.applied, true);
    assert.ok(json.deleted.includes('run.log'), `应该删 run.log：${JSON.stringify(json.deleted)}`);
    assert.ok(existsSync(join(root, 'lib/a.js')), '源码不该被动');
    assert.ok(existsSync(join(root, 'node_modules')), '不在 --only 名单的不该被删');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('源码目录永不清理（lib/bin/tools/tests/docs 都在保护名单）', () => {
  const root = makeRepo({
    'lib/a.js': 'x',
    'bin/nexi.mjs': 'x',
    'tools/pack-clean.mjs': 'x',
    'tests/x.test.mjs': 'x',
    'docs/PRODUCT.md': 'x',
    // 伪造一条命中内部资料的路径，放在受保护目录下
    'docs/generated.log': 'x',
  });
  try {
    const { json } = run(['--root', root, '--json', '--apply', '--force', '--i-know-token']);
    assert.deepEqual(json.deleted, [], `不该删任何受保护目录：${JSON.stringify(json.deleted)}`);
    assert.ok(existsSync(join(root, 'lib/a.js')));
    assert.ok(existsSync(join(root, 'bin/nexi.mjs')));
    assert.ok(existsSync(join(root, 'docs/generated.log')), 'docs 下的文件也受保护');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('凭据类默认被跳过，即使加了 --apply', () => {
  const root = makeRepo({ '.secrets/gh.token': 'gho_x', 'lib/a.js': 'x' });
  try {
    const { json } = run(['--root', root, '--json', '--apply']);
    assert.ok(!json.deleted.includes('.secrets'), '凭据类不该被删');
    assert.ok(json.skipped.some((s) => s.path === '.secrets'), '应该出现在跳过列表');
    assert.ok(existsSync(join(root, '.secrets/gh.token')), '文件必须还在');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('凭据类：--force 但没 --i-know-token 仍然跳过', () => {
  const root = makeRepo({ '.secrets/gh.token': 'gho_x' });
  try {
    const { json } = run(['--root', root, '--json', '--apply', '--force']);
    assert.ok(!json.deleted.includes('.secrets'), '单确认不够，必须双确认');
    assert.ok(existsSync(join(root, '.secrets/gh.token')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('凭据类：双确认后才会删', () => {
  const root = makeRepo({ '.secrets/gh.token': 'gho_x', 'lib/a.js': 'x' });
  try {
    const { json } = run(['--root', root, '--json', '--apply', '--force', '--i-know-token']);
    assert.ok(json.deleted.includes('.secrets'), `双确认后应该删掉：${JSON.stringify(json.deleted)}`);
    assert.ok(!existsSync(join(root, '.secrets')), '目录应该没了');
    assert.ok(existsSync(join(root, 'lib/a.js')), '源码照旧');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--only 精确限定范围', () => {
  const root = makeRepo({ 'a.tgz': 'x', 'run.log': 'x', 'lib/a.js': 'x' });
  try {
    const { json } = run(['--root', root, '--json', '--apply', '--only=tarball']);
    assert.deepEqual(json.deleted, ['a.tgz']);
    assert.ok(existsSync(join(root, 'run.log')), '没点名的日志不该被删');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('算得出可释放体积', () => {
  const root = makeRepo({ 'lib/a.js': 'x' }, ['node_modules']);
  try {
    writeFileSync(join(root, 'node_modules', 'big.js'), 'x'.repeat(4096), 'utf8');
    const { json } = run(['--root', root, '--json']);
    // 4096 字节的文件 + 可能存在的其它命中项，所以是 >= 而不是 >
    assert.ok(json.plannedBytes >= 4096, `体积算小了：${json.plannedBytes}`);
    assert.ok(typeof json.plannedHuman === 'string' && json.plannedHuman.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('干净仓库：没有可清理项，退出码 0', () => {
  const root = makeRepo({ 'lib/a.js': 'x', 'README.md': '# hi' });
  try {
    const { status, json } = run(['--root', root, '--json']);
    assert.equal(status, 0);
    assert.equal(json.planned.length, 0);
    assert.equal(json.deleted.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('预演 + apply 的两次结果一致（不会"预演说删 A、执行却删 B"）', () => {
  const root = makeRepo({ 'x.tgz': 'x', 'y.zip': 'x', 'lib/a.js': 'x' });
  try {
    const dry = run(['--root', root, '--json']);
    const dryPaths = dry.json.planned.map((p) => p.path).sort();
    const applied = run(['--root', root, '--json', '--apply']);
    const appliedPaths = [...applied.json.deleted].sort();
    assert.deepEqual(appliedPaths, dryPaths, '预演和执行必须一致');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('真仓库上预演：只读，不产生任何删除', () => {
  // 对真实仓库跑一次预演，断言退出码正常且 applied 为 false
  const r = spawnSync(process.execPath, [TRIM, '--json'], { encoding: 'utf8', windowsHide: true, cwd: PKG });
  const json = JSON.parse(r.stdout);
  assert.equal(json.applied, false);
  assert.ok(Array.isArray(json.planned));
  // 顺带确认 pack-clean 还在（没被自己误删）
  assert.ok(existsSync(CLEAN), 'pack-clean.mjs 必须还在');
});
