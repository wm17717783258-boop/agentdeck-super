/**
 * tests/untar.test.mjs —— 自己的 .tgz 解包器
 *
 * 起因：双机验收在中文路径下被系统 tar 打回（`Failed to open archive`）。
 * 这个解包器就是替代品，所以它必须比 tar 更能扛：
 *   中文路径、长文件名、目录、PAX 头、以及**不可信归档**（路径穿越）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

import { untarBuffer, extractTgz } from '../lib/untar.js';

/** 手搓一个 tar 缓冲区（够用来测解包，不需要真 tar）。 */
function makeTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const header = Buffer.alloc(512, 0);
    const name = Buffer.from(e.name, 'utf8');
    name.copy(header, 0, 0, Math.min(name.length, 99));
    header.write('0000644\0', 100, 8, 'ascii');            // mode
    header.write('0000000\0', 108, 8, 'ascii');            // uid
    header.write('0000000\0', 116, 8, 'ascii');            // gid
    const data = e.data ? Buffer.from(e.data, 'utf8') : Buffer.alloc(0);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');        // mtime
    header.write('        ', 148, 8, 'ascii');              // checksum 占位
    header.write(e.type || '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    // checksum：先把校验位当空格算，再写回去（标准做法）
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header);
    if (data.length) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0)); // 结束块
  return Buffer.concat(chunks);
}

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'adsk-untar-'));
}

test('解普通文件与目录', () => {
  const root = tmpRoot();
  try {
    const tar = makeTar([
      { name: 'pkg/', type: '5' },
      { name: 'pkg/a.txt', data: 'hello' },
      { name: 'pkg/sub/b.txt', data: '世界' },
    ]);
    const r = untarBuffer(tar, root);
    assert.equal(r.ok, true, r.reason);
    assert.equal(readFileSync(join(root, 'pkg/a.txt'), 'utf8'), 'hello');
    assert.equal(readFileSync(join(root, 'pkg/sub/b.txt'), 'utf8'), '世界');
    assert.ok(r.files.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('中文路径能解（这是它存在的理由）', () => {
  const root = tmpRoot();
  try {
    const tar = makeTar([
      { name: 'Nexi灵犀-完整项目/lib/index.js', data: 'export const x = 1;' },
    ]);
    const r = untarBuffer(tar, root);
    assert.equal(r.ok, true, r.reason);
    const target = join(root, 'Nexi灵犀-完整项目/lib/index.js');
    assert.ok(existsSync(target), '中文路径的文件应该被解出来');
    assert.equal(readFileSync(target, 'utf8'), 'export const x = 1;');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('路径穿越被拒（../../escape 写不出去）', () => {
  const root = tmpRoot();
  try {
    const tar = makeTar([
      { name: '../../escape.txt', data: 'bad' },
      { name: '/abs-escape.txt', data: 'bad' },
      { name: 'ok.txt', data: 'good' },
    ]);
    const r = untarBuffer(tar, root);
    assert.equal(r.ok, true);
    assert.ok(r.skipped.length >= 2, `越界项应该被跳过：${JSON.stringify(r.skipped)}`);
    assert.ok(existsSync(join(root, 'ok.txt')), '正常文件照解');
    // 确认没写到上一级
    const parent = join(root, '..');
    assert.ok(!existsSync(join(parent, 'escape.txt')), '不该写出到上一级');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('符号链接被跳过（不当普通文件处理）', () => {
  const root = tmpRoot();
  try {
    const tar = makeTar([
      { name: 'link', data: '/etc/passwd', type: '2' },
      { name: 'real.txt', data: 'ok' },
    ]);
    const r = untarBuffer(tar, root);
    assert.equal(r.ok, true);
    assert.ok(r.skipped.some((s) => s.includes('link')), `符号链接应跳过：${JSON.stringify(r.skipped)}`);
    assert.ok(existsSync(join(root, 'real.txt')));
    assert.ok(!existsSync(join(root, 'link')), '不该把链接当文件写出来');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PAX 扩展头里的长 path 能认', () => {
  const root = tmpRoot();
  try {
    const longName = `${'去'.repeat(80)}/file.txt`; // 超过 100 字节
    const paxData = `30 path=${longName}\n`;
    const tar = makeTar([
      { name: 'pax-header', data: paxData, type: 'x' },
      { name: 'truncated', data: 'content' },
    ]);
    const r = untarBuffer(tar, root);
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.files.some((f) => f.includes('file.txt')), `长名应该被认出来：${JSON.stringify(r.files)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('坏输入：垃圾字节不崩，返回 ok:false 或空结果', () => {
  const root = tmpRoot();
  try {
    const r1 = untarBuffer(Buffer.from('这不是 tar'), root);
    assert.equal(typeof r1.ok, 'boolean');

    const r2 = extractTgz(join(root, '不存在.tgz'), join(root, 'out'));
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /失败/);
    assert.ok(!existsSync(join(root, 'out')), '失败时不该留空目录树');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('端到端：真 npm pack 出来的 tgz 能解开，且含关键文件', () => {
  const root = tmpRoot();
  const tmp = tmpRoot();
  try {
    const pack = spawnSync('npm', ['pack', '--pack-destination', tmp], {
      cwd: 'C:/Users/LENOVO/Documents/Codex/2026-11-07/d-y/work/nexi/Nexi灵犀-完整项目',
      encoding: 'utf8',
      windowsHide: true,
      shell: true,
    });
    if (pack.status !== 0) {
      // npm 不可用就跳过这条（不算失败），但要说清楚
      console.log('（跳过：本机 npm pack 没跑起来）');
      return;
    }
    const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    assert.ok(tgz, 'npm pack 应该产出 tgz');
    const r = extractTgz(join(tmp, tgz), root, { readFile: readFileSync });
    assert.equal(r.ok, true, r.reason);
    assert.ok(existsSync(join(root, 'package/package.json')), '应该解出 package.json');
    assert.ok(existsSync(join(root, 'package/lib/index.js')), '应该解出 lib/index.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
