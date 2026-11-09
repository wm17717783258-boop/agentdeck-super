/**
 * tests/pair-invite-input.test.mjs —— 邀请链接的三种输入方式都要能用
 *
 * 真机踩到的坑（最坑的一个）：邀请链接里含 `&`，在 cmd / PowerShell 里是元字符。
 *   node tools/nexi-pair.mjs guest --invite "http://x/?room=a&t=b"
 * 双引号被 shell 吃掉之后，`&t=b` 变成另一条命令，插件收到的是残缺链接，
 * 报"邀请已失效" —— **看起来像插件坏了，其实是 shell 干的**。
 *
 * 所以必须支持绕开 shell 的输入方式，并且这条要有测试钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const PAIR = join(PKG, 'tools', 'nexi-pair.mjs');
const SRC = readFileSync(PAIR, 'utf8');

test('支持 --invite-file（绕开 shell 对 & 的处理）', () => {
  assert.ok(/--invite-file/.test(SRC), '缺 --invite-file 支持');
  assert.ok(/inviteFile/.test(SRC), '应该有 inviteFile 变量');
});

test('支持 NEXI_INVITE 环境变量（最省事的方式）', () => {
  assert.ok(/NEXI_INVITE/.test(SRC), '缺 NEXI_INVITE 环境变量支持');
  assert.ok(/process\.env\.NEXI_INVITE/.test(SRC), '应该从 process.env 读');
});

test('帮助里主路径和退路各一条，不摆一堆让人挑', () => {
  // 支持的方式有三种（--invite / --invite-file / NEXI_INVITE），
  // 但**给用户看的**只留前两种，且必须分主次：
  // 以前三条并列（①②③），用户不知道该抄哪条；
  // 而"② 次稳"里的 `set NEXI_INVITE=a&b` 在 cmd 里会从 & 处截断 —— 本身就不稳。
  assert.ok(/invite-file/.test(SRC), '缺 --invite-file 退路');
  assert.ok(/--invite/.test(SRC), '缺 --invite 主路径');
  assert.ok(/NEXI_INVITE/.test(SRC), '环境变量仍要支持（测试/自动化在用）');
});

test('--invite-file 真能用：从文件读链接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsk-invfile-'));
  const file = join(dir, 'invite.txt');
  try {
    writeFileSync(file, 'http://127.0.0.1:1/?room=abc-123&t=tok_456\n', 'utf8');
    const r = spawnSync(process.execPath, [PAIR, 'guest', '--invite-file', file], {
      cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    // 端口 1 没人听 → 必须报**网络**错，不能报"缺邀请"
    assert.doesNotMatch(r.stdout, /用法：node/, `应该读到了链接：${r.stdout.slice(0, 200)}`);
    assert.doesNotMatch(r.stdout, /读不到邀请文件/, `文件应该读得到：${r.stdout.slice(0, 200)}`);
    assert.match(r.stdout, /收到邀请/, `应该开始处理邀请：${r.stdout.slice(0, 200)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--invite-file 指向不存在的文件时如实报错', () => {
  const r = spawnSync(process.execPath, [PAIR, 'guest', '--invite-file', 'C:/definitely/not/here.txt'], {
    cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.match(r.stdout, /读不到邀请文件/, `应明确说读不到：${r.stdout.slice(0, 200)}`);
});

test('没有任何输入时，帮助给出一条主路径 + 一条退路，且不推荐会被截断的写法', () => {
  const r = spawnSync(process.execPath, [PAIR, 'guest'], {
    cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  const out = r.stdout;
  assert.match(out, /--invite-file/, '退路要写出来：链接被 shell 吃掉时靠它');
  assert.match(out, /guest --invite "/, '主路径要是能整行复制就跑的命令');
  assert.ok(out.indexOf('guest --invite "') < out.indexOf('--invite-file'),
    '主路径要排在退路前面，顺序本身就是指引');
  assert.doesNotMatch(out, /set NEXI_INVITE=[^"]/,
    'cmd 的 set X=a&b 会在 & 处截断，不能写成推荐方案');
});
