#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * tools/dev.mjs —— 开发循环：一条命令把「改完的代码」推成「宿主里真能用的状态」。
 *
 * 为什么要有这个：改一行代码想验证，正常流程是
 *   改 → 单测 → 打包 → 装到本机宿主 → 打开宿主确认 → 发现不对再改
 * 手做一遍五六分钟，还容易漏步骤（尤其是"忘了打包，装的还是上一版"）。
 * 这个脚本把五步串成一条命令，并且**每一步都用真实产物**验证，不用假数据。
 *
 * 和 release.mjs 的分工：
 *   release.mjs —— 对外发布质量闸（脱敏 / 凭据 / 体检 / 产物验收 / publish）
 *   dev.mjs     —— 对内快速回路（单测 / 打包 / 装宿主 / 宿主自报 / 工具冒烟）
 * 两者都不改你的代码，只跑、只报。
 *
 * 用法：
 *   node tools/dev.mjs                 全流程（单测 + 打包 + 装全部宿主 + 自报 + 冒烟）
 *   node tools/dev.mjs --fast          跳过单测（只验安装链路）
 *   node tools/dev.mjs --skip-pack     复用当前目录已有的 tgz
 *   node tools/dev.mjs --only claude-code,qwen-code   只核实这几个宿主（装还是全装）
 *   node tools/dev.mjs --no-install    只单测 + 打包
 *   node tools/dev.mjs --from-registry 走真实用户路径：装 registry 上已发布的包，不打包
 *   node tools/dev.mjs --from-registry --tag latest   同上，装 dist-tag 而不是当前版本号
 *
 * 为什么要有 --from-registry：
 *   本地 tgz 装出来的宿主配置里，命令行是 `npx --package C:\...\xxx.tgz agentdeck-super`；
 *   真实用户装出来的配置是 `npx -y agentdeck-super`。两者不是一回事 ——
 *   tgz 路径一旦被删/被挪，宿主那边就哑了，而你在本地测永远测不出来。
 *   --from-registry 装的就是 registry 上那一份，宿主里写什么、能不能跨机器跑，
 *   跟用户拿到手完全一致。发布前用默认模式快速回路，发布后用这个模式验收。
 *
 * 退出码：0 = 全绿；1 = 有宿主失败或冒烟失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const OPT = {
  fast: has('--fast'),
  skipPack: has('--skip-pack'),
  noInstall: has('--no-install'),
  fromRegistry: has('--from-registry'),
  tag: valOf('--tag'),
  only: (valOf('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
};

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const LINES = [];
const steps = [];

function say(s = '') {
  console.log(s);
  LINES.push(s);
}

function head(n, title, why) {
  say('');
  say(`━━━ 阶段 ${n}｜${title} ━━━`);
  if (why) say(`  （${why}）`);
}

function bail(stage, why, fix) {
  say('');
  say(`❌ ${stage} 失败：${why}`);
  if (fix) say(`   怎么办：${fix}`);
  report();
  process.exit(1);
}

function run(cmd, args = [], opts = {}) {
  const useShell = opts.shell ?? (IS_WIN && /^(npm|npx|git)$/.test(cmd));
  const quote = (a) => (useShell && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const r = spawnSync(cmd, args.map(quote), {
    cwd: opts.cwd || PKG,
    encoding: 'utf8',
    windowsHide: true,
    shell: useShell,
    timeout: opts.timeout ?? 900_000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (opts.echo) {
    for (const line of out.trimEnd().split(/\r?\n/)) {
      if (!opts.keep || opts.keep.test(line)) say(`  ${line}`);
    }
  }
  return { ok: r.status === 0 && !r.error, out, rawStdout: r.stdout || '', code: r.status, err: r.error };
}

const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));

say('╔══════════════════════════════════════════════════════════╗');
say('║  Nexi 开发循环 · 测试 → 打包 → 装宿主 → 宿主自报 → 冒烟  ║');
say('╚══════════════════════════════════════════════════════════╝');
say(`  版本 ${pkg.version}    node ${process.version}    ${IS_WIN ? 'Windows' : process.platform}`);
if (OPT.fast) say('  --fast：跳过单测');

// ── 阶段 1：单测 ────────────────────────────────────────────────
let testStats = null;
if (OPT.fast) {
  say('');
  say('阶段 1｜单测　（--fast 跳过）');
} else {
  head(1, '单测', '改完代码第一道闸，不过就别往下走');
  const r = run(process.execPath, ['tools/test-summary.mjs'], {
    keep: /ℹ (tests|pass|fail|cancelled|skipped)|✖|测试文件/,
    echo: true,
  });
  const g = (k) => Number((r.out.match(new RegExp(`ℹ ${k} (\\d+)`)) || [])[1] || 0);
  testStats = { tests: g('tests'), pass: g('pass'), fail: g('fail'), skipped: g('skipped') };
  if (!r.ok || testStats.fail > 0) {
    bail('单测', `${testStats.fail} 条失败`, '先修红的用例。测试红了打包出来的东西就是坏的。');
  }
  say('');
  say(`  ✅ ${testStats.tests} 条 / 通过 ${testStats.pass} / 跳过 ${testStats.skipped}`);
  steps.push({ name: '单测', ok: true, note: `${testStats.pass}/${testStats.tests}` });
}

// ── 阶段 2：取产物（打包 or registry 校验）─────────────────────
let tgz = null;
let pkgSpec = null; // 交给 npx 的包描述符：tgz 路径 或 registry 上的 name@version
if (OPT.fromRegistry) {
  head(2, 'registry 校验', '--from-registry：不打包，装 registry 上已发布的那一份');
  const spec = OPT.tag ? `agentdeck-super@${OPT.tag}` : `agentdeck-super@${pkg.version}`;
  const r = run('npm', ['view', spec, 'version', '--json'], { timeout: 120_000 });
  if (!r.ok) {
    bail(
      'registry 校验',
      `${spec} 在 registry 上查不到`,
      '先 node tools/release.mjs --publish，或改用 --tag latest 装最新已发布版本。',
    );
  }
  const seen = (r.rawStdout || '').trim() || '?';
  say(`  ✅ registry 上有：${spec} → ${seen}`);
  say('  （这一步之后宿主里写的就是 npx -y agentdeck-super，和真实用户一致）');
  pkgSpec = spec;
  steps.push({ name: 'registry', ok: true, note: spec });
} else if (OPT.skipPack) {
  const found = readdirSync(PKG).filter((n) => n.endsWith('.tgz')).sort();
  tgz = found.length ? join(PKG, found[found.length - 1]) : null;
  say('');
  say(`阶段 2｜打包　（--skip-pack，复用 ${tgz ? tgz.split(/[\\/]/).pop() : '（没找到 tgz）'}）`);
  if (!tgz) bail('打包', '目录里没有 .tgz', '去掉 --skip-pack 让我重新打包。');
  pkgSpec = tgz;
} else {
  head(2, '打包', '装机用的必须是刚打出来的包，不能是上一版');
  // 先删同版本旧包，否则 npm pack 会覆盖但容易误判"是不是新的"
  for (const n of readdirSync(PKG).filter((x) => x.endsWith('.tgz'))) {
    try {
      rmSync(join(PKG, n), { force: true });
    } catch { /* 删不掉就算了，后面按文件名取最新的 */ }
  }
  const r = run('npm', ['pack'], { keep: /package size|unpacked size|total files|filename|\.tgz$/, echo: true });
  if (!r.ok) bail('打包', 'npm pack 失败', '看上面的 npm 报错。');
  const name = r.rawStdout.trim().split(/\r?\n/).filter(Boolean).pop();
  tgz = join(PKG, name);
  if (!existsSync(tgz)) bail('打包', `打出来的包找不到：${name}`, '检查 package.json 的 files 白名单。');
  say('');
  say(`  ✅ ${name}`);
  steps.push({ name: '打包', ok: true, note: name });
  pkgSpec = tgz;
}

// ── 阶段 3：装到本机宿主（走真实用户命令）─────────────────────
const hostsMod = await import('../lib/connect/hosts.js');
let installOut = '';
if (OPT.noInstall) {
  say('');
  say('阶段 3｜装宿主　（--no-install 跳过）');
} else {
  head(3, '装宿主', OPT.fromRegistry
    ? '用 npx 从 registry 拉起安装器 —— 跟用户敲的是同一条命令'
    : '用 npx 从刚打的包拉起安装器（本地路径，只作快速回路）');
  const r = OPT.fromRegistry
    ? run('npx', ['--yes', pkgSpec], {
      timeout: 600_000,
      keep: /"id"|"ok"|"changed"|"via"|failures|installed|宿主/,
    })
    : run('npx', ['--yes', '--package', tgz, 'agentdeck-super'], {
      timeout: 600_000,
      keep: /"id"|"ok"|"changed"|"via"|failures|installed|宿主/,
    });
  installOut = r.out;
  for (const line of r.out.trimEnd().split(/\r?\n/)) {
    if (/宿主|installed|failures|✓|✗/.test(line)) say(`  ${line}`);
  }
  if (!r.ok) {
    // 退出码非 0 不等于装失败：安装器里有些探测（宿主 CLI 自己读注册表之类）
    // 在受限环境会被拦，但该写进宿主的配置已经写完了。把原因打出来，别吞掉。
    const hint = String(r.out || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/^npm (notice|warn)/.test(s))
      .slice(-3);
    say('');
    say(`  ⚠️  安装器退出码 ${r.code} —— 下面按宿主逐个核实是不是真失败`);
    for (const h of hint) say(`     ${h}`);
  }
  // 先不下结论：等阶段 4 让宿主自己报完，再判定这次安装到底成不成。
  steps.push({
    name: '装宿主',
    ok: r.ok,
    note: r.ok ? '安装器成功' : `退出码 ${r.code}（待核实）`,
    pending: !r.ok,
  });
}

// ── 阶段 4：宿主自报矩阵 ──────────────────────────────────────
const matrix = [];
if (!OPT.noInstall) {
  head(4, '宿主自报', '不看我写了什么，只看宿主自己认不认');
  const detected = hostsMod.detectHosts().filter((d) => d.installed);
  const targets = OPT.only.length ? detected.filter((d) => OPT.only.includes(d.id)) : detected;

  for (const d of targets) {
    const host = hostsMod.HOSTS.find((h) => h.id === d.id);
    const row = { id: d.id, label: d.label, how: host?.cli ? 'cli' : 'file', ok: false, note: '' };

    if (host?.cli) {
      // 宿主有 CLI：让它自己列一遍
      const r = hostsMod.hostCliList(d.id, { timeout: 60_000 });
      if (!r.ok) {
        row.note = r.reason || 'CLI 调用失败';
      } else if (!r.hasNexi) {
        row.note = '宿主列表里没有 nexi';
      } else {
        row.ok = true;
        const m = r.out.split(/\r?\n/).find((l) => /nexi/i.test(l)) || '';
        // 从宿主输出里抠一个状态词，作为"真的连上了"的证据
        const status = /Connected|connected/.test(m) ? 'Connected'
          : /enabled/i.test(m) ? 'enabled'
            : /Disabled|disabled/.test(m) ? 'Disabled'
              : /local/.test(m) ? 'local'
                : 'listed';
        // Disabled 不是我们装错了：Gemini 在"未受信工作区"里会主动禁用服务器。
        // 说清楚原因，别让人以为安装失败。
        row.note = status === 'Disabled'
          ? 'Disabled（工作区未受信，Gemini 自己禁的；在受信目录打开即启用）'
          : status;
      }
    } else {
      // 只有配置文件的宿主：读文件确认 nexi 条目在
      const file = d.path;
      try {
        const txt = readFileSync(file, 'utf8');
        const key = hostsMod.shapeKeyOf(d.id);
        const hasEntry = key === 'mcp.servers'
          ? /"mcp"[\s\S]*"servers"[\s\S]*"nexi"/.test(txt)
          : new RegExp(`"${key}"[\\s\\S]*"nexi"`).test(txt) || /\[mcp_servers\.nexi\]/.test(txt);
        row.ok = hasEntry;
        row.note = hasEntry ? 'config' : '配置里没有 nexi';
      } catch (e) {
        row.note = `读不到配置：${e.code || e.message}`;
      }
    }
    matrix.push(row);
  }

  const pad = (s, n) => String(s).padEnd(n);
  say('');
  say(`  ${pad('宿主', 20)} ${pad('方式', 6)} ${pad('结果', 10)} 证据`);
  say(`  ${'-'.repeat(20)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(24)}`);
  for (const r of matrix) {
    say(`  ${pad(r.label, 20)} ${pad(r.how, 6)} ${pad(r.ok ? '✅ 已装' : '❌ 未装', 10)} ${r.note}`);
  }
  const okCount = matrix.filter((r) => r.ok).length;
  say('');
  say(`  合计：${okCount} / ${matrix.length} 个宿主确认可用`);
  steps.push({ name: '宿主自报', ok: okCount === matrix.length && matrix.length > 0, note: `${okCount}/${matrix.length}` });

  // 判定依据换成「宿主自己认不认」，而不是安装器的退出码：
  // 安装器说失败、但每个宿主都确认装了 → 那是非致命错误（探测被拦之类），不该报红。
  // 反过来只要有宿主没装成，就是真失败。
  const installStep = steps.find((s) => s.pending);
  if (installStep) {
    installStep.pending = false;
    if (matrix.length > 0 && okCount === matrix.length) {
      installStep.ok = true;
      installStep.warn = true;
      installStep.note = `退出码非 0，但 ${okCount}/${matrix.length} 宿主已装（非致命）`;
    } else {
      installStep.note = `退出码非 0，且只有 ${okCount}/${matrix.length} 宿主装成`;
    }
  }
}

// ── 阶段 5：配置真伪 ──────────────────────────────────────────
// 装上了 ≠ 换台机器还能用。宿主配置里如果记的是
//   本地 tgz 路径 / 项目绝对路径 / WorkBuddy 私有 node 路径
// 那这份配置就是"只在这台机器这个目录下有效"，用户一迁移就哑。
// 这里只抠 nexi 自己那一段看，避免被别的 MCP 服务器的路径误伤。
const portability = [];
if (!OPT.noInstall) {
  head(5, '配置真伪', '宿主里记的那行命令，本地包删了 / 换台机器还活不活');

  const sliceNexi = (txt, hostId) => {
    try {
      const obj = JSON.parse(txt);
      const key = hostsMod.shapeKeyOf(hostId);
      const node = key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
      const entry = node && node.nexi;
      if (entry) return JSON.stringify(entry);
    } catch { /* 不是 JSON，往下走 TOML */ }
    const m = txt.match(/\[mcp_servers\.nexi\]([\s\S]*?)(?=\r?\n\[|$)/);
    if (m) return m[0];
    return txt;
  };

  // 归一化：配置里的 JSON 是双反斜杠转义，直接 includes 比不出来
  const norm = (s) => String(s).replace(/[\\/]+/g, '/').toLowerCase();
  let stableHome = null;
  try {
    stableHome = norm((await import('../lib/installer.js')).defaultHome());
  } catch { /* 拿不到就退化成只看 registry 形式 */ }
  const pkgNorm = norm(PKG);

  for (const d of hostsMod.detectHosts().filter((x) => x.installed)) {
    let txt = '';
    try {
      txt = readFileSync(d.path, 'utf8');
    } catch {
      continue;
    }
    const seg = sliceNexi(txt, d.id);
    const n = norm(seg);
    const flags = [];
    if (/\.tgz/i.test(seg)) flags.push('local-tgz');
    if (n.includes(pkgNorm)) flags.push('local-path');
    if (/[\\/]versions[\\/]\d+\.\d+\.\d+/.test(seg)) flags.push('private-node');
    if (/\.workbuddy[\\/]/.test(seg)) flags.push('workbuddy-node');
    if (stableHome && n.includes(stableHome)) flags.push('stable-home');
    if (/npx/.test(seg) && /agentdeck-super/.test(seg)) flags.push('registry-npx');
    portability.push({ label: d.label, flags, how: hostsMod.HOSTS.find((h) => h.id === d.id)?.cli ? 'cli' : 'file' });
  }

  const pad = (s, n) => String(s).padEnd(n);
  say('');
  say(`  ${pad('宿主', 20)} ${pad('落地方式', 8)} 判定`);
  say(`  ${'-'.repeat(20)} ${'-'.repeat(8)} ${'-'.repeat(34)}`);
  for (const r of portability) {
    const bad = r.flags.filter((f) => f === 'private-node' || f === 'workbuddy-node');
    const local = r.flags.filter((f) => f === 'local-tgz' || f === 'local-path');
    const good = r.flags.includes('stable-home') ? '固定安装目录'
      : r.flags.includes('registry-npx') ? 'registry npx' : '';
    const verdict = bad.length
      ? `❌ 不可移植（${bad.join(',')}）`
      : local.length
        ? `⚠️  仅本机（${local.join(',')}）`
        : good ? `✅ 可移植（${good}）` : '✅ 可移植';
    say(`  ${pad(r.label, 20)} ${pad(r.how, 8)} ${verdict}`);
  }

  const fatal = portability.filter((r) => r.flags.some((f) => f === 'private-node' || f === 'workbuddy-node'));
  const localOnly = portability.filter((r) => r.flags.some((f) => f === 'local-tgz' || f === 'local-path'));
  // registry 模式下还出现本地路径 = 装的根本不是 registry 那一份，必须拦
  const registryBroken = OPT.fromRegistry ? localOnly : [];
  say('');
  if (fatal.length) {
    say(`  ❌ ${fatal.length} 个宿主写死了机器私有路径，换台机器必挂`);
  }
  if (registryBroken.length && !fatal.length) {
    say(`  ❌ --from-registry 模式下仍有 ${registryBroken.length} 个宿主记着本地路径`);
  }
  if (!fatal.length && !registryBroken.length) {
    const allStable = portability.length > 0
      && portability.every((r) => r.flags.includes('stable-home') || r.flags.includes('registry-npx'));
    if (localOnly.length) {
      say(`  ⚠️  ${localOnly.length} 个宿主记的是本地包路径 —— 快速回路正常，但别拿它当发布验收`);
    } else if (allStable) {
      say(`  ✅ ${portability.length} 个宿主全部指向固定安装目录 —— 删项目目录、清 npx 缓存都不影响`);
    } else {
      say('  ✅ 没有写死机器私有路径');
    }
  }
  steps.push({
    name: '配置真伪',
    ok: fatal.length === 0 && registryBroken.length === 0,
    note: fatal.length || registryBroken.length
      ? `${fatal.length + registryBroken.length} 个不可移植`
      : localOnly.length ? '仅本机（预期）' : '可移植',
  });
}

// ── 阶段 6：工具冒烟 ──────────────────────────────────────────
head(6, '工具冒烟', '装上了不等于能用：真调一次工具，看它返不返人话');
const entry = process.execPath;
let smokeOk = true;
const toolCount = (() => {
  const r = run(entry, ['bin/nexi.mjs', 'doctor'], { keep: /工具 \d+ 个|就绪/, echo: true, timeout: 180_000 });
  // 只认 doctor 最后那句汇总「工具 23 个」。
  // 早先这里数「已注册工具」日志行，结果只数到 15 —— 有 8 个工具不打这行，
  // 于是数字比真实少，看着像"工具少了一半"，实际是解析错了。
  const m = r.out.match(/工具\s*(\d+)\s*个/);
  return m ? Number(m[1]) : 0;
})();
say('');
say(`  ${toolCount > 0 ? '✅' : '❌'} 工具注册：${toolCount} 个`);
if (toolCount === 0) smokeOk = false;

const call = run(entry, ['bin/nexi.mjs', 'call', 'team_board', '{"action":"list"}'], { timeout: 90_000 });
const callSane = /【team_board】|错误|Error|任务/.test(call.out);
say(`  ${callSane ? '✅' : '❌'} 真实调用 team_board：${callSane ? '返回正常' : '没有可识别的返回'}`);
if (!callSane) smokeOk = false;
steps.push({ name: '工具冒烟', ok: smokeOk, note: `${toolCount} 个工具` });

// ── 收尾 ──────────────────────────────────────────────────────
function report() {
  say('');
  say('══════════ 汇总 ══════════');
  for (const s of steps) say(`  ${s.ok ? (s.warn ? '⚠️ ' : '✅') : '❌'} ${s.name.padEnd(10)} ${s.note}`);

  const dir = join(PKG, 'docs', 'evidence');
  if (existsSync(dir)) {
    const f = join(dir, `devloop-${STAMP}.txt`);
    writeFileSync(f, `${LINES.join('\n')}\n`, 'utf8');
    say('');
    say(`  证据：${f.replace(PKG, '.')}`);
  }
}

report();

const allOk = steps.every((s) => s.ok) && matrix.every((r) => r.ok);
say('');
if (allOk) {
  const warns = steps.filter((s) => s.warn).length;
  say(warns
    ? `🟢 全绿（${warns} 项 ⚠️ 提示，不影响结论）。可以继续改代码，或者 node tools/release.mjs 走发布。`
    : '🟢 全绿。可以继续改代码，或者 node tools/release.mjs 走发布。');
} else {
  say('🔴 有未通过项，见上面的 ❌。');
}
process.exit(allOk ? 0 : 1);
