/**
 * tests/twomachines-wiring.test.mjs —— 双机验收脚本的两条硬约束
 *
 * 这个脚本要能在**任何一台机器**上直接跑，所以它不能：
 *   ① 依赖用户家目录里的真实签发私钥（从没发过码的机器上根本没有）
 *   ② 往用户家目录写任何东西
 * 这两条以前都被踩过（第一次跑就失败在"签不出授权码"），所以固化成测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const SRC = readFileSync(join(PKG, 'tools', 'verify-twomachines.mjs'), 'utf8');

test('不再调用 license-cli 发码（那条路依赖用户家目录的私钥）', () => {
  // 只挡"真调用"：注释里提一句"为什么不用 license-cli"是应该保留的说明，
  // 所以按调用形态匹配（传入脚本路径），而不是简单查字符串。
  const callPatterns = [
    /join\(REPO, 'tools', 'license-cli\.mjs'\)/,
    /spawnSync\([^)]*license-cli/,
    /execSync\([^)]*license-cli/,
  ];
  for (const re of callPatterns) {
    assert.ok(!re.test(SRC), `还在真调 license-cli.mjs：${re}`);
  }
  assert.ok(
    !/'license-cli'/.test(SRC) && !/"license-cli"/.test(SRC),
    '不该以字符串形式引用 license-cli（容易变成真调用）',
  );
});

test('自带临时签发密钥（测试不依赖任何外部材料）', () => {
  assert.ok(/function makeTestIssuer/.test(SRC), '缺 makeTestIssuer()');
  assert.ok(/generateKeyPairSync\('ed25519'\)/.test(SRC), '应该现场生成密钥对');
  assert.ok(/encodeLicense\(/.test(SRC), '应该用 lib/license.js 签码');
});

test('测试公钥通过环境变量传给 relay（不靠隐式继承）', () => {
  assert.ok(/AGENTDECK_LICENSE_PUBKEY/.test(SRC), '应该设置测试公钥');
  // startRelay 的 env 里必须显式带上
  const relayFn = SRC.slice(SRC.indexOf('async function startRelay'));
  const envBlock = relayFn.slice(0, relayFn.indexOf('});'));
  assert.ok(/AGENTDECK_LICENSE_PUBKEY/.test(envBlock), 'startRelay 的 env 里要显式带公钥');
});

test('不调外部 tar（Windows 中文路径会打不开）', () => {
  assert.ok(!/spawnSync\('tar'/.test(SRC), '还在调系统 tar');
  assert.ok(!/spawnSync\("tar"/.test(SRC), '还在调系统 tar');
  assert.ok(/extractTgz/.test(SRC), '应该用 lib/untar.js 自己解包');
});

test('两台机器各自独立的 DSH_HOME 与工作区（否则不算"两台电脑"）', () => {
  assert.ok(/DSH_HOME: join\(machineDir, 'home'\)/.test(SRC), '甲/乙机要有独立 DSH_HOME');
  assert.ok(/NEXI_WORK: join\(machineDir, 'work'\)/.test(SRC), '甲/乙机要有独立工作区');
});
