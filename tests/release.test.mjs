/**
 * tests/release.test.mjs —— 发布链路本身也要有闸
 *
 * 这个文件测的是「发版脚本」而不是业务代码。理由很直接：
 * 发版脚本出错是**不可逆**的（包一旦发出去就收不回，版本号也废了）。
 * 所以它的三条硬约束必须有测试盯着：
 *
 *   1. 默认**不发布** —— 必须显式 `--publish` 才发；
 *   2. 阶段顺序固定 —— 脱敏必须排在打包前面（顺序错了 = 把内网 IP 发出去）；
 *   3. `--dry-run` 一个文件都不改。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const RELEASE = join(PKG, 'tools', 'release.mjs');
const REDACT = join(PKG, 'tools', 'redact.mjs');

const SRC = readFileSync(RELEASE, 'utf8');

test('release：默认不发布，必须显式 --publish', () => {
  assert.match(SRC, /const PUBLISH = argv\.includes\('--publish'\)/,
    '必须有 --publish 开关');
  // 裸跑 `npm publish` 一定出现在 `if (PUBLISH)` 分支里
  assert.match(SRC, /if \(PUBLISH\) \{[\s\S]{0,600}npm', \['publish'/,
    'npm publish 只能在 PUBLISH 为真时执行');
});

test('release：阶段顺序把脱敏排在打包前面', () => {
  const iRedact = SRC.indexOf("tools/redact.mjs");
  const iPack = SRC.indexOf("['pack']");
  assert.ok(iRedact > 0, '必须调用脱敏脚本');
  assert.ok(iPack > 0, '必须调用 npm pack');
  assert.ok(iRedact < iPack,
    '脱敏必须早于打包 —— 反过来就会把真实内网 IP 打进包里发出去');
});

test('release：每个阶段失败都调 bail（不会静默往下走）', () => {
  // 5 个阶段 + 发布，每个都要有失败出口
  const bails = SRC.match(/bail\(/g) || [];
  assert.ok(bails.length >= 5,
    `至少要 6 个失败出口（实际 ${bails.length}），否则某一步红了会继续往下跑`);
  // bail 必须真的退出进程
  assert.match(SRC, /function bail[\s\S]{0,800}process\.exit\(1\)/,
    'bail 必须退出，不能只是打印');
});

test('release：--dry-run 只做预检，在任何写操作之前退出', () => {
  const iDry = SRC.indexOf('if (DRY)');
  const iRedactCall = SRC.indexOf("tools/redact.mjs");
  assert.ok(iDry > 0 && iDry < iRedactCall,
    '--dry-run 的退出必须早于脱敏（脱敏会改文件）');
});

test('release：Windows 上 npm 走 shell，否则命令根本起不来', () => {
  // 踩过的坑：shell:false 时 spawnSync('npm', …) 在 Windows 报 ENOENT，
  // 被误读成「npm 未登录」。
  assert.match(SRC, /shell: useShell/, '必须显式控制 shell');
  assert.match(SRC, /IS_WIN && \/\^\(npm\|npx\|git\)\$\/\.test\(cmd\)/,
    'win32 下 npm/npx/git 必须走 shell');
});

test('release：预检能区分「包名未注册」和「版本已存在」', () => {
  assert.match(SRC, /E404/,
    '必须区分 404（名字可用）和版本已存在（必须升版本），否则会误判可发');
});

test('release --dry-run 真跑：退出码 0 且不改文件', () => {
  const pkgBefore = readFileSync(join(PKG, 'package.json'), 'utf8');
  const r = spawnSync(process.execPath, [RELEASE, '--dry-run'], {
    cwd: PKG, encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.equal(r.status, 0, `--dry-run 应当成功退出，实际：\n${out.slice(-800)}`);
  assert.match(out, /阶段 0/, '必须打印预检阶段');
  assert.match(out, /--dry-run：预检完就停/, '必须明确说没有改动文件');
  // package.json 不能被动过
  assert.equal(readFileSync(join(PKG, 'package.json'), 'utf8'), pkgBefore,
    '--dry-run 不该改动 package.json');
});

test('redact：幂等 —— 连跑两次第二次必须 0 命中', () => {
  const r1 = spawnSync(process.execPath, [REDACT], {
    cwd: PKG, encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  const r2 = spawnSync(process.execPath, [REDACT], {
    cwd: PKG, encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  assert.equal(r1.status, 0);
  assert.equal(r2.status, 0);
  const out2 = `${r2.stdout || ''}${r2.stderr || ''}`;
  assert.match(out2, /命中 0 个文件/,
    `脱敏必须幂等（跑第二遍不该再有命中），实际：\n${out2.slice(0, 600)}`);
});

test('redact：源码里不写真实内网 IP（规则靠网段匹配）', () => {
  const src = readFileSync(REDACT, 'utf8');
  // 允许出现示例地址（白名单里那些），但不该出现任何"具体机器号"
  const hits = (src.match(/\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g) || [])
    .filter((ip) => !['192.168.1.10', '192.168.1.1', '192.168.0.1', '192.168.1.100',
      '192.168.31.1', '10.0.0.1', '10.0.0.9', '10.0.0.2', '192.168.13.1', '10.0.0.8',
      '192.168.1.10'].includes(ip));
  assert.deepEqual(hits, [],
    `脱敏脚本自己不该硬编码真实 IP（那本身就是泄露）：${hits.join(', ')}`);
});
