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

test('帮助里要把三种方式都写出来（用户才不用猜）', () => {
  // 帮助文本里应有：--invite-file、NEXI_INVITE、以及 shell 例子
  assert.ok(/invite-file/.test(SRC));
  assert.ok(/NEXI_INVITE/.test(SRC));
  assert.ok(/PowerShell|Power Shell/.test(SRC) || /env:NEXI_INVITE/.test(SRC), '应给出 PowerShell 写法');
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

test('没有任何输入时，帮助里给出三种绕开 shell 的方式', () => {
  const r = spawnSync(process.execPath, [PAIR, 'guest'], {
    cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  const out = r.stdout;
  assert.match(out, /--invite-file/, '帮助应提 --invite-file');
  assert.match(out, /NEXI_INVITE/, '帮助应提 NEXI_INVITE');
  assert.match(out, /cmd|PowerShell|bash/i, '帮助应给出各 shell 写法');
});
