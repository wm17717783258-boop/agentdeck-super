/**
 * tests/pair-guide.test.mjs —— 房主屏幕上那段"发给对面"的文本。
 *
 * 为什么单独测：这段文本是**唯一跨越两台设备的东西**。
 * 房主这台机器上一切正常，对面照着敲却起不来 —— 而且两边都会以为是网络问题。
 * 真机上就是这样白跑了两轮：
 *
 *   1. 邀请链接带着 127.0.0.1（中继是本机起的房），对面连的是它自己的回环；
 *   2. 命令写的是 `node tools/nexi-pair.mjs`，对面根本没有本仓源码；
 *   3. 给的"次稳"方案 `set NEXI_INVITE=a&b` 在 cmd 里会从 & 处截断。
 *
 * 所以这里锁四件事：
 *   1. 邀请链接必须是**可跨机**的地址，不许是回环
 *   2. 命令必须是能在一台干净设备上直接跑的（npx 全命令），不许出现开发者路径
 *   3. 主路径只有一条，退路只有一条（选项多了用户就不知道该抄哪条）
 *   4. 源码里所有给用户看的 console.log 都不许再写回 node tools/…
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAIR_CLI,
  buildInviteBlock,
  buildPairHints,
  publicInvite,
} from '../tools/nexi-pair.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(ROOT, 'tools', 'nexi-pair.mjs'), 'utf8');

const INVITE = 'http://192.168.1.10:8899/?room=abc-123&t=TOKEN_xyz';

test('邀请链接是局域网地址，不是 127.0.0.1', () => {
  // 中继用 127.0.0.1 建房 → relay 生成的网页邀请就带着 127.0.0.1。
  // 这一步是把它换成对面真能连到的地址。
  const out = publicInvite('http://127.0.0.1:8899/?room=abc-123&t=TOKEN_xyz', 'http://192.168.1.10:8899');
  assert.equal(out, INVITE);
  assert.ok(!/127\.0\.0\.1/.test(out), '换完之后不许还剩回环地址');
});

test('dsh 深链没有地址，换成本地 http 链接', () => {
  const out = publicInvite('dsh://agentdeck/join?room=abc-123&t=TOKEN_xyz', 'http://192.168.1.10:8899');
  assert.equal(out, INVITE, 'dsh 深链里没有中继地址，跨机时必须补上');
});

test('没给 base 时原样返回，不把链接弄坏', () => {
  assert.equal(publicInvite(INVITE, ''), INVITE);
  assert.equal(publicInvite('不是链接', ''), '不是链接');
});

test('发给对面的那行是 npx 全命令，且链接原样带引号', () => {
  const block = buildInviteBlock({ invite: INVITE });
  assert.ok(block.includes(`${PAIR_CLI} guest --invite "${INVITE}"`),
    '对面要能整行复制就跑，链接不能被截断、不能被转义');
});

test('配对指引里不许出现开发者路径', () => {
  const block = buildInviteBlock({ invite: INVITE });
  assert.ok(!block.includes('node tools/nexi-pair.mjs'),
    '第二台设备上没有本仓源码，照着敲只会 Cannot find module');
  assert.ok(!/set NEXI_INVITE=[^"]/.test(block),
    'cmd 的 set X=a&b 会在 & 处截断，不能当推荐方案');
});

test('主路径只给一条命令，退路只给一条', () => {
  const block = buildInviteBlock({ invite: INVITE });
  const primary = block.match(/guest --invite "/g) || [];
  const fallback = block.match(/--invite-file/g) || [];
  assert.equal(primary.length, 1, '主路径命令多给几条，用户就不知道该挑哪条');
  assert.equal(fallback.length, 1);
});

test('配对完成后的提示同样能直接在对面跑', () => {
  const hints = buildPairHints().join('\n');
  assert.ok(hints.includes(`${PAIR_CLI} check`));
  assert.ok(hints.includes(`${PAIR_CLI} sync`));
  assert.ok(!hints.includes('node tools/nexi-pair.mjs'));
});

test('源码里给用户看的输出不再写回开发者路径', () => {
  // 注释里可以提（那是给改代码的人看的），console.log 里不行。
  const offenders = SRC.split('\n')
    .filter((line) => line.includes('console.log') && line.includes('node tools/nexi-pair.mjs'));
  assert.deepEqual(offenders, [], `这些行会被用户当成命令抄走：\n${offenders.join('\n')}`);
});

test('房主打印的邀请来自 publicInvite，而不是原样输出', () => {
  // 光有 publicInvite 没用，得真被用上。以前是 `publicBase ? 换 : 原样`，
  // 局域网模式正好走 else —— 于是永远带着 127.0.0.1。
  assert.ok(/publicInvite\(localInvite, publicBase \|\| lanBase\)/.test(SRC),
    '局域网模式下也必须把邀请换成局域网地址');
  assert.ok(/const lanBase = best \?/.test(SRC), 'lanBase 要用真端口，不能用请求端口');
});

test('客人成功后要记下中继地址', () => {
  // 不记的话，客人在自己机器上跑 check 会说"本机没记过，先跑一次 host 或 guest"，
  // 而它明明刚跑完 guest —— 用户会以为配对没成，白重跑一轮。
  assert.ok(/writeState\(\{ role: 'guest', invite, relayUrl:/.test(SRC),
    'guest 成功后必须把 relayUrl 一起写进状态');
});
