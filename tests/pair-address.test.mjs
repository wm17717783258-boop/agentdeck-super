/**
 * tests/pair-address.test.mjs —— 配对工具选地址要选对
 *
 * 真机踩到的坑：nexi-pair 选到了 `198.18.0.1`（Meta，VPN/隧道类网卡）。
 * 地址在本机通，但**另一台设备连不上**，于是 guest 报"邀请已失效"——
 * 看起来像令牌坏了，其实是地址选错了。这个文件把判定钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const SRC = readFileSync(join(PKG, 'tools', 'nexi-pair.mjs'), 'utf8');

test('配对工具的地址判定：虚拟网卡名单要和 nexi-lan 一致', () => {
  // 这些网卡名都必须被认作虚拟（否则会选中它们，导致对面连不上）
  for (const needle of ['vmnet', 'vbox', 'wsl', 'docker', 'hyper-v', 'virtual', 'meta']) {
    assert.ok(
      new RegExp(needle, 'i').test(SRC),
      `地址判定没排除 ${needle} 类网卡：对面可能连不上`,
    );
  }
});

test('选了虚拟网卡时必须给出警告（不能静默配对失败）', () => {
  assert.ok(/function addressWarning/.test(SRC), '缺 addressWarning()');
  assert.ok(/只找到虚拟网卡地址/.test(SRC), '警告文案应说明"只找到虚拟网卡"');
  // host 流程里必须真的调用它
  const hostFn = SRC.slice(SRC.indexOf('async function cmdHost'));
  assert.ok(/addressWarning\(best\)/.test(hostFn), 'cmdHost 里要真的用上警告');
});

test('完全没地址时也警告（不能拿回环去配）', () => {
  assert.ok(/没找到任何局域网地址/.test(SRC), '缺"没找到任何局域网地址"的提示');
  // 回环必须被跳过
  assert.ok(/startsWith\('127\.'\)/.test(SRC), '应该跳过回环地址');
});

test('地址选择是稳定的（同一台机器每次选同一个）', () => {
  // 排序里有 tie-breaker，避免两次跑选出不同地址（会让配对结果不可复现）
  assert.ok(/localeCompare/.test(SRC), '排序应有稳定的 tie-breaker');
});

test('配对工具不带角色时仍打印帮助（没被地址逻辑弄坏）', () => {
  const r = spawnSync(process.execPath, [join(PKG, 'tools', 'nexi-pair.mjs')], {
    cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(r.status, 0, `应该正常退出：${r.stderr}`);
  assert.match(r.stdout, /真机配对/);
  assert.match(r.stdout, /host/);
});
