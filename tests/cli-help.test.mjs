/**
 * tests/cli-help.test.mjs —— `nexi <子命令> --help` 必须只解释、不执行
 *
 * 为什么值得单开一条测试：
 *   自检时 `nexi rollback --help` 真的把安装目录回滚了（history.json 里多了一条
 *   action:"rollback" 的记录），`nexi pet --help` 真弹了个桌宠窗口。
 *   "--help 有副作用"这种缺陷平时没人报，因为受害者以为自己在看文档。
 *
 * 断言的写法：给一条**空的**临时 home，跑 `<子命令> --help`，然后查三件事：
 *   ① 退出码必须是 0；
 *   ② 输出里必须有用法说明 **且必须有「只显示帮助」那句**；
 *   ③ 输出里**不能**出现真命令的结果 JSON（各子命令成功/失败都会 print 一个含 `"ok":` 的对象）。
 *
 * 为什么要 ③：突变测试发现，把拦截去掉之后 `stop --help` / `rollback --help` 在空 home 上
 * 也不会留下文件（它们直接失败了），"目录里没多东西"根本抓不到回归。
 * 真正可靠的信号是**输出的形状**：真跑过 → 一定有一份带 "ok" 的 JSON；只解释 → 只有帮助文本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const NEXI = join(REPO, 'bin', 'nexi.mjs');

/** 这些子命令只要被执行就一定有副作用：回滚版本、停自动化、弹窗、装宿主 */
const RISKY = ['rollback', 'pet', 'stop', 'setup', 'update', 'install', 'uninstall', 'verify-host'];

const runHelp = (cmd, home) => spawnSync(process.execPath, [NEXI, cmd, '--help', '--home', home], {
  cwd: REPO,
  encoding: 'utf8',
  timeout: 30_000,
  // 不给它任何真宿主/真安装目录的机会
  env: { ...process.env, DSH_HOME: home, LOCALAPPDATA: home, APPDATA: home, HOME: home },
});

test('每个带副作用的子命令：--help 只解释、不执行、不落任何文件', () => {
  for (const cmd of RISKY) {
    const home = mkdtempSync(join(tmpdir(), `adsk-help-${cmd}-`));
    try {
      const r = runHelp(cmd, home);
      assert.equal(r.status, 0, `${cmd} --help 退出码应为 0，实际 ${r.status}；stderr=${String(r.stderr).slice(0, 300)}`);
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /用法：/, `${cmd} --help 必须打印用法`);
      assert.match(out, /只显示帮助/, `${cmd} --help 必须明说"没有执行"`);
      assert.doesNotMatch(out, /"ok"\s*:/,
        `${cmd} --help 打出了命令结果的 JSON —— 说明它真的执行了`);

      const leftovers = readdirSync(home);
      assert.deepEqual(leftovers, [],
        `${cmd} --help 竟然在 home 里留下了东西：${leftovers.join(', ')} —— 说明它执行了`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('--help / -h / 不带参数：都只给帮助，且是同一份', () => {
  const a = spawnSync(process.execPath, [NEXI, '--help'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  const b = spawnSync(process.execPath, [NEXI, '-h'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  const c = spawnSync(process.execPath, [NEXI], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  for (const r of [a, b, c]) {
    assert.equal(r.status, 0);
    assert.match(r.stdout, /用法：/);
  }
  assert.equal(a.stdout, b.stdout, '--help 和 -h 应该是同一份帮助');
});

test('未知子命令：报错但不崩', () => {
  const r = spawnSync(process.execPath, [NEXI, 'no-such-command'], { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  assert.match(`${r.stdout}${r.stderr}`, /不认识子命令/, '未知子命令要明确说"不认识"');
  assert.match(r.stdout, /用法：/, '顺手把帮助打出来，别让人再猜一次');
  // 退出码必须是 2：只打帮助退出 0 会让 `nexi instal` 这种手滑在 CI 里"看起来成功"
  assert.equal(r.status, 2, '未知子命令必须以非 0 退出，否则脚本查不出拼错');
});
