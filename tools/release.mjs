#!/usr/bin/env node
/**
 * tools/release.mjs —— 一条命令从源码走到「可以发」
 *
 * 为什么需要它：
 *   发一次版要手工跑 5 件事 —— 脱敏、打包体检、全量测试、npm pack、装一遍验证。
 *   少跑一件就会出事，而且顺序错了更惨（先打包再脱敏 = 把 IP 发出去）。
 *   这个脚本把顺序**固定死**，任何一步红就立刻停，并告诉你下一步该干什么。
 *
 * 用法：
 *   node tools/release.mjs                 # 全流程走到「产物验证通过」，不发布
 *   node tools/release.mjs --publish       # 再加一步真发 npm
 *   node tools/release.mjs --publish --otp=123456   # 账号开了 2FA 时（非交互终端没法弹框）
 *   node tools/release.mjs --dry-run       # 只做预检（查版本/登录/git），什么都不改
 *   node tools/release.mjs --skip tests    # 跳过测试（快速试打包，别用来发版）
 *   node tools/release.mjs --skip redact   # 跳过脱敏（已确认干净时）
 *
 * 阶段（顺序不可调）：
 *   0 预检   版本号 / npm 登录 / git 干净度 / Node 版本
 *   1 脱敏   真实内网 IP、邀请令牌 → 示例值（幂等，跑第二遍 0 命中）
 *   2 体检   打包卫生：凭据泄露 / 大文件 / 混杂产物（有 HIGH 直接停）
 *   3 测试   tests/*.test.mjs 全量（串行，避免 Windows 临时目录锁竞争）
 *   4 打包   npm pack，产出 tgz
 *   5 验收   把 tgz 装进临时目录，跑 doctor，确认「装完真能用」
 *   6 发布   仅 --publish 时执行
 *
 * 设计取舍：
 *   · **不替用户做删除**。体检报出的历史 tgz、`.tools/*.exe` 只提示，不自动删 ——
 *     删错了比留着更麻烦。要删会打印确切命令让你自己决定。
 *   · 阶段 5 用**临时目录**装，不碰你机器上已装的那份；
 *   · 全程把关键输出记进 `docs/evidence/release-<版本>.txt`，出问题可回溯。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const DRY = argv.includes('--dry-run');
const PUBLISH = argv.includes('--publish');
const skipArg = argv.indexOf('--skip');
const SKIP = skipArg >= 0
  ? String(argv[skipArg + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
  : [];

/*
 * 2FA：账号开了 auth-and-writes 时，npm publish 在非交互终端里没法弹框问你要动态码，
 * 只会甩一句 EOTP。所以动态码必须提前拿到 —— 命令行 --otp= 或环境变量 NPM_OTP。
 * 解析放在顶层而不是发布分支里，是为了让「发布分支里到底做什么」一眼能看完。
 */
const otpArg = (() => {
  const inline = argv.find((a) => a.startsWith('--otp='));
  if (inline) return inline;
  const i = argv.indexOf('--otp');
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return `--otp=${argv[i + 1]}`;
  const envOtp = String(process.env.NPM_OTP || '').trim();
  return envOtp ? `--otp=${envOtp}` : null;
})();

const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const started = Date.now();
const log = [];
const steps = [];

function say(line = '') {
  console.log(line);
  log.push(line);
}

function head(no, name, why) {
  say('');
  say('─'.repeat(64));
  say(`阶段 ${no}｜${name}　${why}`);
  say('─'.repeat(64));
}

/**
 * 跑一条命令，返回 { ok, out, code }。输出实时透传到屏幕。
 *
 * ⚠️ Windows 上 `npm` 是个 `.cmd` 垫片，`shell: false` 直接起不来
 * （spawnSync 报 ENOENT，看起来像"命令不存在"）。踩过这个坑 ——
 * 之前误判成「npm 未登录」「拿不到包文件清单」，其实命令根本没执行。
 * 解决：win32 下走 shell，并把带空格的参数自己加引号。
 */
const IS_WIN = process.platform === 'win32';

function quoteIfNeeded(a) {
  const s = String(a);
  if (!/[\s"&|<>^]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function run(cmd, args = [], opts = {}) {
  const useShell = opts.shell ?? (IS_WIN && /^(npm|npx|git)$/.test(cmd));
  const finalArgs = useShell && IS_WIN ? args.map(quoteIfNeeded) : args;
  const r = spawnSync(cmd, finalArgs, {
    cwd: PKG,
    encoding: 'utf8',
    windowsHide: true,
    shell: useShell,
    timeout: opts.timeout ?? 900_000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (opts.echo !== false && out.trim()) {
    const lines = out.trimEnd().split(/\r?\n/);
    // keep：只打印匹配的行。不加过滤的话，被调用的工具会把自己的运行日志
    // （`[nexi:info] 已注册工具 …` 之类）全吐进来，把结论淹掉。
    const shown = opts.keep ? lines.filter((l) => opts.keep.test(l)) : lines;
    for (const line of shown) say(`  ${line}`);
    if (opts.keep && shown.length < lines.length) {
      say(`  …（省略 ${lines.length - shown.length} 行工具日志）`);
    }
  }
  // rawStdout 单独留一份：`npm ... --json` 的 JSON 在 stdout，notice 在 stderr，
  // 合并之后就没法 JSON.parse 了。
  return { ok: r.status === 0 && !r.error, out, rawStdout: r.stdout || '', code: r.status, err: r.error };
}

function record(id, ok, detail) {
  steps.push({ id, ok, detail, ms: Date.now() - started });
}

/**
 * registry 权威状态。
 *
 * 坑：npm 包文档带 `cache-control: public, max-age=300`，用普通 `npm view` 会在
 * 发布后整整 5 分钟里一直返回旧文档 —— 把「已经发成功」误判成「查不到」。
 * 必须带 --prefer-online 强制回源，否则发布验收会假失败。
 */
function registryState() {
  // 注意：不要用 `npm view --prefer-online` 做验收判定。
  // 实测发布后它仍会返回旧文档（registry 文档有约 5 分钟缓存），会把成功判成失败。
  // 这里直接打 registry，并带 cache-busting 参数，拿到的才是真状态。
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name).replace(/^%40/, '@')}?_=${Date.now()}`;
  const r = run(process.execPath, ['-e', `
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    fetch(${JSON.stringify(url)}, { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }, signal: ctl.signal })
      .then((res) => res.text())
      .then((txt) => { clearTimeout(t); process.stdout.write(txt); })
      .catch((e) => { clearTimeout(t); process.stderr.write(String(e && e.message || e)); process.exit(1); });
  `], { timeout: 40_000, echo: false });

  let versions = [];
  let latest = null;
  let next = null;
  if (r.ok) {
    try {
      const doc = JSON.parse(String(r.rawStdout || '{}'));
      versions = Object.keys(doc.versions || {});
      latest = (doc['dist-tags'] || {}).latest || null;
      next = (doc['dist-tags'] || {}).next || null;
    } catch { /* 解析失败按查不到处理 */ }
  }
  return { versions, latest, next, reachable: r.ok };
}

/** 某阶段失败 → 打印原因与「你现在该做什么」，然后退出。 */
function bail(stepName, reason, next) {
  say('');
  say(`❌ 停在「${stepName}」：${reason}`);
  say('');
  say('下一步：');
  for (const line of String(next).split('\n')) say(`  ${line}`);
  record(stepName, false, reason);
  writeEvidence();
  process.exit(1);
}

function evidenceName() {
  // --dry-run 只验预检，绝不能覆盖正式发布留下的证据（之前就踩过：干跑一次把
  // release-1.11.8.txt 盖成了 900 字节的预检输出，真实测试数字全丢了）。
  return DRY ? `release-${VERSION}-dryrun.txt` : `release-${VERSION}.txt`;
}

function writeEvidence() {
  try {
    const dir = join(PKG, 'docs', 'evidence');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, evidenceName());
    const header = [
      `# release ${VERSION}`,
      `# ${new Date().toISOString()}`,
      `# node ${process.version} / ${process.platform}`,
      `# 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
      '',
    ];
    writeFileSync(file, [...header, ...log].join('\n'), 'utf8');
  } catch {
    /* 证据写不进去不该让发版本身失败 */
  }
}

// ─────────────────────────────────────────────────────────────
// 阶段 0：预检
// ─────────────────────────────────────────────────────────────
head(0, '预检', '版本 / 登录 / 运行环境');

say(`  包名　　：${pkg.name}`);
say(`  版本　　：${VERSION}`);
say(`  Node 　　：${process.version}（要求 ${pkg.engines?.node || '未声明'}）`);

const nodeMajor = Number(process.version.replace(/^v/, '').split('.')[0]);
const nodeMinor = Number(process.version.replace(/^v/, '').split('.')[1]);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  bail('预检', `Node ${process.version} 低于 engines 要求 >=22.12.0`,
    '升 Node，或用 NEXI_NODE 指向一个够新的 node 再跑。');
}
say('  ✅ Node 版本达标');

// npm 登录状态：只有真要发才必须
const who = run('npm', ['whoami'], { echo: false, timeout: 60_000 });
if (who.ok) {
  say(`  ✅ npm 已登录：${who.out.trim()}`);
} else {
  say('  ⚠️  npm 未登录（--publish 前必须解决）');
  say('     解决：npm login    （或设 NPM_TOKEN 环境变量）');
}

/*
 * 这个版本号在 npm 上的状态，三种情况要分开说，不能一律当"可发"：
 *   · 404         → 包名还没被注册，首次 publish 会占住这个名字（好事，也是唯一机会）
 *   · 返回同版本  → 已发过，再发会被拒，必须升版本
 *   · 其它失败    → 网络/限流，**无法判断**，只能提示人工确认
 */
const seen = run('npm', ['view', `${pkg.name}@${VERSION}`, 'version'], { echo: false, timeout: 60_000 });
const seenOut = seen.out || '';
if (/E404|is not in this registry/.test(seenOut)) {
  say(`  ✅ npm 上没有 ${pkg.name} —— 名字可用，首次发布会注册它`);
} else if (seen.ok && seenOut.trim() === VERSION) {
  /*
   * 同一个版本号不可能发第二次。这里必须**当场停**，不能只打印一句 ❌ 继续往下走：
   * 继续跑会白跑一轮脱敏 + 体检 + 全量测试 + 打包（好几分钟），最后在 npm publish
   * 那一步才被拒 —— 那几分钟什么都证明不了，还容易让人以为"发布成功了一部分"。
   */
  bail('预检', `npm 上已存在 ${pkg.name}@${VERSION}，同一个版本号发不了第二次`, [
    '先升版本，再重新跑发布：',
    '  npm version patch|minor|major --no-git-tag-version',
    '升完顺手把 LICENSING.md / CHANGELOG 里写的版本号一起改掉，别只改 package.json。',
  ].join('\n'));
} else if (!seen.ok) {
  say('  ⚠️  查不到 npm 上的版本状态（网络/限流），发布前请自己确认一次：');
  say(`     npm view ${pkg.name} version`);
} else {
  say(`  ✅ npm 上最新是 ${seenOut.trim()}，${VERSION} 是新版本`);
}

// git 干净度：脏工作区发出去，事后查不清「这个版本对应哪份代码」
const git = run('git', ['status', '--porcelain'], { echo: false, timeout: 60_000 });
if (git.ok) {
  const dirty = git.out.trim().split('\n').filter(Boolean);
  if (dirty.length) {
    say(`  ⚠️  git 工作区有 ${dirty.length} 处未提交改动（发布后不便回溯）`);
    for (const d of dirty.slice(0, 5)) say(`     ${d}`);
    if (dirty.length > 5) say(`     …还有 ${dirty.length - 5} 处`);
  } else {
    say('  ✅ git 工作区干净');
  }
} else {
  say('  ⚠️  不是 git 仓库（无法用 commit 回溯版本来源）');
}

/*
 * 闭源边界（代码层）：静态引用 / loadPro 契约 / pro 是否被 git 跟踪。
 * 打包层还有一道（阶段 4 拿真实清单再查一次）—— 硬红线查两次不嫌多：
 * 一次赶在动手之前，一次赶在产物出门之前。
 */
const boundary = run(process.execPath, ['tools/guard-boundary.mjs', '--skip-pack'], {
  keep: /规矩|✅|❌|\[/,
  timeout: 120_000,
});
if (!boundary.ok) {
  bail('预检', '闭源边界守卫不通过',
    '这是硬红线：按上面写的原因修，别绕过。修完手工确认一次：\n'
    + '  node tools/guard-boundary.mjs');
}
say('  ✅ 闭源边界（代码层）：无静态引用、loadPro 契约对齐、pro/ 未被 git 跟踪');

record('预检', true, `v${VERSION}`);

if (DRY) {
  say('');
  say('（--dry-run：预检完就停，没有改动任何文件）');
  writeEvidence();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// 阶段 1：脱敏
// ─────────────────────────────────────────────────────────────
if (SKIP.includes('redact')) {
  say('');
  say('阶段 1｜脱敏　（按 --skip redact 跳过）');
} else {
  head(1, '脱敏', '真实内网 IP / 邀请令牌 → 示例值');
  const r = run(process.execPath, ['tools/redact.mjs', '--apply'], {
    keep: /命中 \d+ 个文件|没有需要脱敏|→|第 \d+ 行/,
  });
  if (!r.ok) bail('脱敏', '脱敏脚本执行失败', '看上面的报错；这个脚本出错要当事故处理。');
  const hit = (r.out.match(/命中 (\d+) 个文件/) || [])[1] || '0';
  say('');
  say(hit === '0'
    ? '  ✅ 没有需要脱敏的内容'
    : `  ✅ 已脱敏 ${hit} 个文件（脱敏是幂等的，下次应报 0）`);
  record('脱敏', true, `${hit} 个文件`);
}

// ─────────────────────────────────────────────────────────────
// 阶段 2：打包体检
// ─────────────────────────────────────────────────────────────
if (SKIP.includes('check')) {
  say('');
  say('阶段 2｜体检　（按 --skip check 跳过）');
} else {
  head(2, '体检', '凭据泄露 / 大文件 / 混杂产物');
  const r = run(process.execPath, ['tools/pack-clean.mjs'], {
    keep: /\[HIGH\]|\[MEDIUM\]|扫了 \d+ 个文件|合计可回收/,
  });

  /*
   * 关键区分：体检扫的是**整个仓库**，但真正会外发的是 `npm pack` 里的那些文件。
   * 仓库里躺着 `.tools/*.exe`（20MB 第三方二进制）确实不卫生，但它不在
   * `package.json` 的 files 白名单里 —— 永远不会跟着包出去。
   * 把它当发布阻断项，人就会开始习惯性绕过体检，那比不体检更危险。
   *
   * 所以：只有「会进包」的 HIGH 才拦发布；其余降级为警告，仍然显示，仍然建议清。
   */
  const packList = run('npm', ['pack', '--dry-run', '--json'], { echo: false, timeout: 180_000 });
  let shipped = [];
  try {
    // 取 stdout 里的第一段 JSON（npm 可能在上面贴几行 notice）
    const raw = packList.rawStdout || '';
    const start = raw.indexOf('[');
    const j = JSON.parse(raw.slice(start));
    shipped = (j[0]?.files || []).map((f) => f.path.replace(/\\/g, '/'));
  } catch {
    say('  ⚠️  拿不到 npm 包文件清单，HIGH 项一律按「会发出去」处理');
  }
  if (shipped.length) say(`  （本次会发出 ${shipped.length} 个文件）`);
  const willShip = (p) => {
    const rel = String(p).replace(/\\/g, '/').replace(/\/$/, '');
    return shipped.some((f) => f === rel || f.startsWith(`${rel}/`));
  };

  const highLines = r.out.split(/\r?\n/).filter((l) => l.includes('[HIGH]'));
  const mediumCount = (r.out.match(/\[MEDIUM\]/g) || []).length;

  const blocking = [];
  const tolerated = [];
  for (const line of highLines) {
    // 形如 `  [HIGH] .tools  (20.2MB) — 说明`
    const m = line.match(/\[HIGH\]\s+(\S+)/);
    const path = m ? m[1] : '';
    (path && willShip(path) ? blocking : tolerated).push(line);
  }

  if (blocking.length) {
    bail('体检', `发现 ${blocking.length} 项 HIGH 风险，且**会随包发出去**`,
      `${blocking.join('\n')}\n\n凭据类要**作废重签**，不是删文件就完事。\n`
      + '删完/换完再跑一次本脚本。');
  }
  if (tolerated.length) {
    say('');
    say(`  ⚠️  ${tolerated.length} 项 HIGH 只在仓库里、不进 npm 包（不拦发布）`);
    for (const l of tolerated) say(`     ${l.trim()}`);
    say('     建议清掉：本机工具目录不该混在源码里。');
  }
  if (mediumCount) {
    say('');
    say(`  ⚠️  ${mediumCount} 项 MEDIUM（不拦发布，但建议清掉）`);
    say('     这些通常是历史打包产物；删掉可回收体积、避免和源码漂移。');
  }
  if (!highLines.length && !mediumCount) {
    say('');
    say('  ✅ 体检干净');
  }
  record('体检', true, `阻断 0 / 仅仓库内 ${tolerated.length} / MEDIUM ${mediumCount}`);
}

// ─────────────────────────────────────────────────────────────
// 阶段 3：全量测试
// ─────────────────────────────────────────────────────────────
if (SKIP.includes('tests')) {
  say('');
  say('阶段 3｜测试　（按 --skip tests 跳过 —— 这个版本不要直接发）');
} else {
  head(3, '测试', 'tests/*.test.mjs 全量（串行）');
  const r = run(process.execPath, ['tools/test-summary.mjs'], {
    timeout: 1_200_000,
    keep: /测试汇总|^\s*ℹ (tests|pass|fail|cancelled|skipped) |^\s*✖|测试文件|失败的用例/,
  });
  if (!r.ok) {
    bail('测试', '有测试失败',
      '先修红的用例。修完单独跑那一个：\n'
      + '  node --test tests/<那个文件>.test.mjs\n'
      + '全绿之后再跑一次本脚本。');
  }
  const pass = (r.out.match(/tests (\d+)/) || [])[1] || '?';
  say('');
  say(`  ✅ 测试全绿（${pass} 条）`);
  record('测试', true, `${pass} 条通过`);
}

// ─────────────────────────────────────────────────────────────
// 阶段 4：打包
// ─────────────────────────────────────────────────────────────
head(4, '打包', 'npm pack');

/**
 * 打包前后的 tgz 名单对比：这样能精确知道**这一次**产出了哪个文件，
 * 不用把 `nexi-<版本>.tgz` 这个名字规则在脚本里再写一遍（写死就会和
 * npm 的实际命名漂移）。
 */
const tgzBefore = new Set(readdirSync(PKG).filter((n) => n.endsWith('.tgz')));

const packed = run('npm', ['pack'], {
  timeout: 300_000,
  keep: /package size|unpacked size|total files|filename/,
});
if (!packed.ok) bail('打包', 'npm pack 失败', '看上面的 npm 报错。');

const tgzAfter = readdirSync(PKG).filter((n) => n.endsWith('.tgz'));
const created = tgzAfter.filter((n) => !tgzBefore.has(n));
const tgz = created.length ? created[0] : `${pkg.name}-${VERSION}.tgz`;
const tgzPath = join(PKG, tgz);

if (!existsSync(tgzPath)) {
  bail('打包', `没找到产物 ${tgz}`, '检查 npm pack 的输出。');
}
const sizeMB = (statSync(tgzPath).size / 1024 / 1024).toFixed(2);
say('');
say(`  ✅ 产物：${tgz}（${sizeMB} MB）`);

// ── 闭源边界守卫 ──────────────────────────────────────────────
// 商业层（pro/）绝不允许进公开包。这不是「最好别」，是硬红线：
// 一旦发出去，AGPL 之下就再也收不回来了（1.11.5–1.11.8 已经吃过一次这个亏）。
// 用 npm 自己算的文件清单来判断，避免和 files 白名单的语义漂移。
say('');
say('  正在核对闭源边界（pro/ 不得进包）…');
const dryJson = run('npm', ['pack', '--dry-run', '--json'], { timeout: 180_000 });
if (!dryJson.ok) {
  bail('打包', '拿不到打包清单（npm pack --dry-run --json 失败）',
    '这一步是闭源泄露的最后一道闸，拿不到清单就不能发布。');
}
let packList = [];
try {
  const parsed = JSON.parse(String(dryJson.rawStdout || '').trim());
  packList = Array.isArray(parsed) && parsed[0] && Array.isArray(parsed[0].files)
    ? parsed[0].files.map((f) => String(f && f.path || ''))
    : [];
} catch (err) {
  bail('打包', `打包清单解析失败：${String(err && err.message || err).slice(0, 160)}`,
    '拿不到清单就不能确认没泄露，停止发布。');
}
if (!packList.length) {
  bail('打包', '打包清单是空的', 'npm 输出格式可能变了，先手工确认 npm pack 正常。');
}
const leakedPro = packList.filter((p) => p === 'pro' || p.startsWith('pro/'));
if (leakedPro.length) {
  bail('打包', `公开包里混进了闭源商业层（${leakedPro.length} 个文件）`,
    '这是硬红线，必须先修 package.json 的 files 白名单：\n'
    + `  泄露样本：${leakedPro.slice(0, 6).join('、')}${leakedPro.length > 6 ? ' …' : ''}\n`
    + '  正确做法：files 里保留 "!pro" 与 "!pro/**"，且不要用通配把根目录全包进来。\n'
    + '  注意 AGPL 不可撤销 —— 一旦发出去就收不回来了。');
}
say(`  ✅ 闭源边界干净：${packList.length} 个文件，pro/ 零命中`);

record('打包', true, `${tgz} ${sizeMB}MB`);

// ─────────────────────────────────────────────────────────────
// 阶段 5：产物验收 —— 装进临时目录，确认「装完真能用」
// ─────────────────────────────────────────────────────────────
head(5, '产物验收', '把 tgz 装进临时目录跑一遍，不碰你已装的那份');

const sandbox = mkdtempSync(join(tmpdir(), 'nexi-release-'));
try {
  const install = run('npm', ['install', '--no-save', '--prefix', sandbox, tgzPath], {
    timeout: 300_000,
    echo: false, // 成功时不刷 npm 的依赖树日志；失败时下面会单独打
  });
  if (!install.ok) {
    say('  npm install 输出：');
    for (const line of String(install.out || '').trimEnd().split(/\r?\n/).slice(-20)) say(`    ${line}`);
    bail('产物验收', 'tgz 装不进空目录',
      '包本身可能是坏的（缺文件 / postinstall 报错 / peerDependencies 解不开）。');
  }

  // 找装进去的入口：优先 bin/nexi.mjs
  const entry = join(sandbox, 'node_modules', pkg.name, 'bin', 'nexi.mjs');
  if (!existsSync(entry)) {
    bail('产物验收', `包装完但没有 ${pkg.name}/bin/nexi.mjs`,
      'package.json 的 files 白名单漏了 bin/，或者 pack 时被 exclude 了。');
  }

  const doctor = run(process.execPath, [entry, 'doctor'], {
    timeout: 180_000,
    keep: /工具 \d+ 个|就绪|"name"|"ok"|version|node/i,
  });
  if (!doctor.ok) {
    bail('产物验收', '装完跑 doctor 不通过',
      '这就是用户装上会遇到的状态。看上面的 doctor 输出定位。');
  }
  const toolCount = (doctor.out.match(/"name"\s*:/g) || []).length;
  say('');
  say(`  ✅ 装完能起来（doctor 通过，${toolCount} 项检查/工具）`);

  // 再验一次工具真的能调（不是只有列表）
  const call = run(process.execPath, [entry, 'call', 'team_board', '{"action":"list"}'], {
    timeout: 60_000,
    keep: /【team_board】|错误|Error/,
  });
  say(call.ok ? '  ✅ 真实工具调用成功' : '  ⚠️  工具调用未通过（可能是本机无团队数据，属正常）');
  record('产物验收', true, `doctor ok / ${toolCount} 项`);
} finally {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发锁住，删不掉不影响结论 */
  }
}

// ─────────────────────────────────────────────────────────────
// 阶段 6：发布
// ─────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
say('');
say('═'.repeat(64));
say(`全部通过（${elapsed}s）　${pkg.name}@${VERSION}　${tgz} ${sizeMB} MB`);
say('═'.repeat(64));

if (PUBLISH) {
  head(6, '发布', 'npm publish —— 发完还要去 registry 查一遍，退出码 0 不等于发成了');
  // 2026-11-10 定的规矩：npm 不是测试渠道。
  // 没做过"真机 + 第二台设备"验收的版本，只许进 next，不许顶到 latest ——
  // 因为用户 npx 时打的就是 latest，那一份会被当成成熟产品用。
  // 验收通过后要顶 latest：node tools/release.mjs --publish --latest
  const tag = argv.includes('--latest') ? 'latest' : 'next';
  if (tag === 'next') {
    say(`  ·  这一版只打 next（npm 上 latest 不动）—— 验收通过后加 --latest 再发一次才顶上去`);
  }
  const pub = run('npm', ['publish', tgzPath, '--access', 'public', '--tag', tag, ...(otpArg ? [otpArg] : [])], { timeout: 300_000 });
  // npm 现在的发布是**异步**的：PUT 之后先回一句 "being processed"，版本要过 1–3 分钟
  // 才出现在 registry 文档里；这期间再发同一版本会收到 409 "previously staged version"。
  // 所以：① 报错也先查 registry；② 409/"processing" 不算失败，进长等待。
  let pending = false;
  if (!pub.ok) {
    const twofa = /one-?time password|OTP|EOTP|2FA/i.test(pub.out);
    const inFlight = /previously staged version|previously published versions|Cannot publish over|being processed|may take a few minutes/i.test(pub.out);
    const now = registryState();
    if (now.versions.includes(VERSION)) {
      say('');
      say(`  ⚠️  npm 报了错，但 registry 里已经有 ${VERSION} —— 按已发布处理，继续验收`);
    } else if (inFlight) {
      pending = true;
      say('');
      say('  ⏳ 已进入 npm 的发布流水线（它先返回 409「正在处理」，1–3 分钟后才可查）。');
      say('     这不是失败 —— 等待上线，别急着重发。');
    } else {
      bail('发布', twofa ? '这一版需要 2FA，但当前终端做不了浏览器授权' : 'npm publish 失败',
        twofa
          ? '先分清你的 2FA 是哪种：\n'
            + '  · 手机令牌 6 位码 → 带码重跑（30 秒内有效）：\n'
            + '      node tools/release.mjs --publish --otp=123456\n'
            + `  · 指纹 / 安全密钥（WebAuthn）→ --otp 永远无效，必须在**真终端窗口**里发：\n`
            + `      npm publish ${tgzPath} --access public\n`
            + '    它会打印 npmjs.com 授权链接，浏览器确认后自动继续。\n'
            + '  · 长期方案：建带 bypass 2FA 的 granular token（权限选「发布与分期」），之后不再要 2FA。'
          : '常见原因：\n'
            + '  · 版本号已存在 → npm version patch --no-git-tag-version 后重跑\n'
            + '  · 未登录 → npm login\n'
            + '  · 名字被占 / 无权限 → npm view ' + pkg.name + ' owner');
    }
  }
  if (pub.ok) {
    say('');
    say(`  ✅ npm publish 已接受：https://www.npmjs.com/package/${pkg.name}/v/${VERSION}`);
  }

  // 退出码 0 只代表"服务器收下了"。真正的成功标志是 registry 文档里出现这个版本，
  // 并且 dist-tags.latest 指向它 —— 用户 npx 装的时候打的就是这条路径。
  say('');
  say('  正在向 registry 确认（强制回源；npm 异步发布一般要 1–3 分钟）…');
  let confirmed = false;
  let state = null;
  const TRIES = 30;          // 30 × 20s ≈ 10 分钟，够异步流水线跑完
  for (let i = 0; i < TRIES; i += 1) {
    state = registryState();
    if (state.versions.includes(VERSION)) {
      confirmed = true;
      break;
    }
    process.stdout.write(`\r  等待中 ${String(i + 1).padStart(2)}/${TRIES}  `);
    run(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000)'], { timeout: 30_000 });
  }
  if (confirmed) process.stdout.write('\r                                  \r');
  if (!confirmed) {
    say(`  ⚠️  等了约 ${Math.round((TRIES * 20) / 60)} 分钟，registry 仍没有 ${VERSION}。`);
    say(pending
      ? '     它还在流水线里。过几分钟再查一次，别急着重发（重发只会拿到 409）。'
      : '     可能被 hold 住待审，或者根本没提交成功。');
    say(`     确认命令：npm view ${pkg.name} versions --json --prefer-online`);
    record('发布', false, pending ? '异步处理未完成' : 'registry 未确认');
    bail('发布', '已提交但 registry 还查不到', `过几分钟跑：npm view ${pkg.name}@${VERSION} version --prefer-online`);
  }
  say(`  ✅ registry 已可查：${pkg.name}@${VERSION}`);

  const after = registryState();
  if (tag === 'latest') {
    if (after.latest !== VERSION) {
      say(`  ⚠️  dist-tags.latest 现在指向 ${after.latest || '(空)'}，不是 ${VERSION} —— 用户 npx 会装到别的版本。`);
      say(`     修正：npm dist-tag add ${pkg.name}@${VERSION} latest`);
    } else {
      say(`  ✅ dist-tags.latest 已指向 ${VERSION}（用户 npx 装到的就是这一份）`);
    }
  } else {
    const nextVer = after.next || '(查不到，可能还在同步)';
    say(`  ·  dist-tags：latest=${after.latest || '(空)'}（没动）　next=${nextVer}`);
    say(`     要试这一版：npx -y ${pkg.name}@next <命令>`);
    say(`     验收通过后再顶：npm dist-tag add ${pkg.name}@${VERSION} latest`);
  }

  // 发完最该做的事：从 registry 真装一次。这是唯一能证明"用户能装上"的动作。
  say('');
  say('  下一步（这条才是真验收，别省）：');
  say(`    node tools/dev.mjs --from-registry`);
  record('发布', true, 'published + registry confirmed');
} else {
  say('');
  say('没有发布（默认只验证到「可以发」）。确认无误后：');
  say(`  node tools/release.mjs --publish`);
  say('');
  say('或者手动：');
  say(`  npm publish ${tgz} --access public`);
  say('');
  say('发完之后建议接着做：');
  say(`  git tag v${VERSION} && git push --tags`);
  say('  然后到各宿主上重装一次，确认真机可用（这是唯一可信的验收）：');
  say('  node install.mjs && node bin/nexi.mjs verify-host --all --record');
}

writeEvidence();
say('');
say(`证据已写入 docs/evidence/${evidenceName()}`);
