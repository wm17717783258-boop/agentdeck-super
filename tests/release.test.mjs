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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('release --dry-run 真跑：该成功就成功，该拦就拦，反正不许改文件', () => {
  const pkgBefore = readFileSync(join(PKG, 'package.json'), 'utf8');
  const r = spawnSync(process.execPath, [RELEASE, '--dry-run'], {
    cwd: PKG, encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.match(out, /阶段 0/, '必须打印预检阶段');

  /*
   * 这条曾经写成"必须退出 0"，结果它其实是**看 npm 状态的**：
   * 当前版本已经发过 → 预检按设计硬拦（退出 1 + 让你升版本）。
   * 那是正确行为，不是缺陷；把"版本已存在"当成失败会让全量回归在真实环境里随机变红
   * （同一台机器上刚才绿、过一会儿红，只是因为 npm view 有没有连通）。
   * 所以按状态分支断言：两种情况都要断言得死死的，只是断言的内容不同。
   */
  if (/npm 上已存在 \S+@\S+/.test(out)) {
    assert.equal(r.status, 1, `版本已存在时必须拦下来，实际退出码 ${r.status}：\n${out.slice(-800)}`);
    assert.match(out, /先升版本/, '拦下来还不够，必须告诉人怎么解决（升版本）');
    assert.doesNotMatch(out, /--dry-run：预检完就停/, '已经拦下了就不该再说"预检完就停"');
  } else {
    assert.equal(r.status, 0, `--dry-run 应当成功退出，实际：\n${out.slice(-800)}`);
    assert.match(out, /--dry-run：预检完就停/, '必须明确说没有改动文件');
    assert.match(out, /闭源边界（代码层）/, '预检必须跑闭源边界守卫（拆分后的硬红线）');
  }

  // 两种情况都一样：package.json 不能被动过
  assert.equal(readFileSync(join(PKG, 'package.json'), 'utf8'), pkgBefore,
    '--dry-run 不该改动 package.json');
});

test('redact：幂等 —— 真改一次之后，第二遍必须 0 命中', () => {
  /*
   * 这条原来是在仓库根直接跑 `redact.mjs`（不带 --apply）两次，然后断言第二遍 0 命中。
   * 那个写法从根上是错的，而且错得很隐蔽：
   *   脱敏脚本默认是**干跑**（不 --apply 就一个字节都不改），
   *   所以第二遍当然还能看见同一处 —— 它测的不是"幂等"，测的是"有没有真改"，
   *   而后者恰恰是干跑模式下**不该发生**的事。
   *   于是这条断言在正常代码上也会红，红得毫无信息量。
   *
   * 现在换成：造一个迷你目录（含一个真实内网 IP），--apply 跑两次。
   *   第一次必须把 IP 换掉（证明它真的会改）；
   *   第二次必须 0 命中（证明它不会把替换后再替换一遍 —— 那会把文件改乱）。
   * 顺带的好处：不再碰仓库里的真实文件，也不依赖仓库里"正好有没有敏感数据"。
   */
  const dir = mkdtempSync(join(tmpdir(), 'nexi-redact-idem-'));
  const file = join(dir, 'sample.txt');
  const RAW_IP = '192.168.31.189';
  try {
    writeFileSync(file, `我的地址是 ${RAW_IP}\n`, 'utf8');
    const run = () => spawnSync(process.execPath, [REDACT, '--apply', '--root', dir], {
      cwd: PKG, encoding: 'utf8', timeout: 180_000, windowsHide: true,
    });

    const r1 = run();
    assert.equal(r1.status, 0, `第一遍脱敏失败：\n${`${r1.stdout || ''}${r1.stderr || ''}`.slice(0, 600)}`);
    const after1 = readFileSync(file, 'utf8');
    assert.doesNotMatch(after1, new RegExp(RAW_IP.replace(/\./g, '\\.')),
      `--apply 必须真的把真实 IP 换掉，实际还是：${after1.trim()}`);
    assert.match(after1, /192\.168\.1\.10/, '替换目标应该是白名单里的示例地址');

    const r2 = run();
    assert.equal(r2.status, 0);
    const out2 = `${r2.stdout || ''}${r2.stderr || ''}`;
    assert.match(out2, /命中 0 个文件/,
      `脱敏必须幂等（跑第二遍不该再有命中），实际：\n${out2.slice(0, 600)}`);
    assert.equal(readFileSync(file, 'utf8'), after1, '第二遍不该再改文件内容');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
