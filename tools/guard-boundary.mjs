#!/usr/bin/env node
/**
 * tools/guard-boundary.mjs —— 开源 / 闭源物理边界守卫
 *
 * 为什么需要它：`pro/` 是闭源商业层，绝不能出现在公开 npm 包或公开仓库里；
 * 同时开源代码也绝不能**静态**引用它，否则用户装上开源版就是一堆 ENOENT。
 * 这两件事靠"记得住"是不行的，必须有一条能在发布前跑红的闸门。
 *
 * 四条硬规矩（全部有代码证据，不靠语义猜）：
 *   1. 公开包里不许出现 `pro/` 的任何文件 —— 以 `npm pack --dry-run --json` 的真实清单为准。
 *      为什么不看 package.json 的 files：那是个语义很绕的白名单，`!pro` 在不同 npm 版本
 *      下行为并不完全一致；只有真实打包清单才是"用户真会拿到的东西"。
 *   2. 开源代码里不许有指向 `pro/` / `agentdeck-pro` 的**静态** import / require。
 *      唯一合法的接缝是 `lib/pro-resolve.js` 里的动态 import（用反引号拼 specifier，
 *      本脚本的引号正则天然不匹配它 —— 这是设计，不是巧合）。
 *   3. 每一处 `loadPro('x')` 的目标都必须在本文件顶部的契约清单里。
 *      改名字忘了改调用点，会在开源形态静默降级成"未安装商业层"，比报错更难发现。
 *   4. `pro/` 不许被 git 跟踪（公开仓库的红线），且必须被 .gitignore 覆盖。
 *
 * 用法：
 *   node tools/guard-boundary.mjs              # 全量（含真实 npm pack，约 5–20 秒）
 *   node tools/guard-boundary.mjs --skip-pack  # 只查代码与 git（单测里用这个，跑得快）
 *   node tools/guard-boundary.mjs --json       # 机器可读结果
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

/*
 * 扫哪个根目录：默认就是本仓库。
 * 允许 --root 是为了两件事：① 拆包脚本能对**暂存目录**做同一套检查；
 * ② 单测能造一个"故意违规"的假仓库，证明这道闸真的会红（不然守卫可能只是空转）。
 */
const ROOT = (() => {
  const i = argv.indexOf('--root');
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : PKG;
})();
const SKIP_PACK = argv.includes('--skip-pack') || argv.includes('--fast');
const AS_JSON = argv.includes('--json');

/**
 * 闭源层的契约清单：`loadPro(spec)` 允许出现的全部 spec。
 * 加一个 pro 模块 → 这里加一行；改名字 → 这里和调用点一起改。
 * 少了它，"改名字忘了改调用点"这种错会静默降级，线上永远发现不了。
 */
export const PRO_SPECS = Object.freeze([
  'billing/index.js',   // 在线支付渠道（stripe / wechat / alipay / manual）
  'market/index.js',    // 皮肤市场门面（货架 / 下单 / 订单 / 退款）
  'market/themes.js',   // 主题包（皮肤 + 音效 + 动作打包卖）
  'market/invoice.js',  // 发票数据
  'market/reconcile.js',// 渠道对账单 ↔ 本机订单逐笔勾对
  'sync/index.js',      // 多设备加密同步：快照打包
  'sync/delta.js',      // 多设备加密同步：增量与冲突
  'meeting/index.js',   // 跨厂商会议引擎
  'meeting/tool.js',    // deck_meeting 工具本体
]);

/** 扫描范围：这些目录里的代码会进公开包（src/ 也扫，前端一旦 import 后端闭源层同样炸）。 */
const SCAN_DIRS = ['lib', 'bin', 'mcp', 'tools', 'src', 'scripts'];
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'verify-1.11.4-final', 'verify-1.11.4-final2', 'verify-1.11.4-final3']);

const problems = [];
const notes = [];
const fail = (rule, detail, how) => problems.push({ rule, detail, how });

/** 递归列出代码文件（跳过 node_modules / .tmp-* / verify-* 历史副本）。 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.tmp-') || e.name.startsWith('verify-')) continue;
      walk(full, out);
      continue;
    }
    if (!e.isFile()) continue;
    const dot = e.name.lastIndexOf('.');
    if (dot < 0 || !CODE_EXT.has(e.name.slice(dot))) continue;
    out.push(full);
  }
  return out;
}

/**
 * 只抓**引号**包起来的静态模块路径。
 * 动态 import 用的是反引号模板（`../pro/${key}`），天然不在这个正则里 ——
 * 也就是说本检查放行的是"唯一那一个合法接缝"，不是"随便写动态 import 都放行"。
 */
const STATIC_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** 规矩 2：开源代码不许静态指向闭源层。 */
function checkStaticImports() {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // 注释里提到 pro/ 是正常的（解释为什么这么做），只看真 import 语句。
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(?:\*|\/\/)/.test(line)) return;
        STATIC_IMPORT_RE.lastIndex = 0;
        let m;
        while ((m = STATIC_IMPORT_RE.exec(line)) !== null) {
          const spec = m[1];
          if (!/(^|\/)pro\//.test(spec) && !spec.startsWith('agentdeck-pro')) continue;
          offenders.push({ file: relative(ROOT, file).replace(/\\/g, '/'), line: i + 1, spec });
        }
      });
    }
  }
  if (offenders.length) {
    fail(
      '静态引用闭源层',
      offenders.map((o) => `${o.file}:${o.line} → ${o.spec}`).join('\n'),
      '开源版没有 pro/ 目录，这样写用户装上就是 MODULE_NOT_FOUND。改用 loadPro(...)（见 lib/pro-resolve.js）。',
    );
  } else {
    notes.push(`规矩 2 通过：${SCAN_DIRS.join(' / ')} 里没有静态引用 pro/`);
  }
}

/** 规矩 3：每个 loadPro('x') 都必须在契约清单里；装了商业层就还得在盘上。 */
function checkProSpecs() {
  const used = new Map(); // spec → [文件:行]
  const CALL_RE = /loadPro\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      // 跳过接缝自身与本脚本：它俩的文档/清单里本来就会写出 loadPro('x') 这种字样。
      if (file.endsWith('pro-resolve.js') || file.endsWith('guard-boundary.mjs')) continue;
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        CALL_RE.lastIndex = 0;
        let m;
        while ((m = CALL_RE.exec(line)) !== null) {
          const spec = m[1];
          if (!used.has(spec)) used.set(spec, []);
          used.get(spec).push(`${relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`);
        }
      });
    }
  }

  const unknown = [...used.keys()].filter((s) => !PRO_SPECS.includes(s));
  if (unknown.length) {
    fail(
      'loadPro 目标不在契约清单',
      unknown.map((s) => `${s}（${used.get(s).join('、')}）`).join('\n'),
      '要么把 spec 改成存在的那一个，要么把它加进 tools/guard-boundary.mjs 的 PRO_SPECS。'
        + '不修的话，这几处会静默降级成"未安装商业层"，线上永远不报错。',
    );
  }

  const hasProDir = existsSync(join(ROOT, 'pro'));
  if (hasProDir) {
    const missing = PRO_SPECS.filter((s) => !existsSync(join(ROOT, 'pro', s)));
    if (missing.length) {
      fail('商业层缺文件', missing.join('\n'), '本机装了 pro/ 但清单里的模块不在盘上：先补齐再发布完整版。');
    } else {
      notes.push(`规矩 3 通过：${PRO_SPECS.length} 个闭源模块全部就位，${used.size} 处 loadPro 调用点全部对得上`);
    }
  } else {
    notes.push(`规矩 3（部分通过）：开源形态（无 pro/），已校验 ${used.size} 处 loadPro 调用点都在契约清单里`);
  }
}

/** 规矩 1：公开包里不许有 pro/。 */
function checkPack() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    fail(
      '拿不到打包清单',
      String(r.stderr || r.stdout || '').slice(0, 800) || `npm pack 退出码 ${r.status}`,
      '这一步是闭源泄露的最后一道闸：拿不到清单就不能发布。先修 npm pack。',
    );
    return;
  }
  let list = [];
  try {
    const parsed = JSON.parse(r.stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    list = (first?.files || []).map((f) => String(f.path || '').replace(/\\/g, '/'));
  } catch (err) {
    fail('打包清单解析失败', String(err?.message || err), 'npm 输出格式变了：改 tools/guard-boundary.mjs 的解析，别绕过这道闸。');
    return;
  }
  const leaked = list.filter((p) => p === 'pro' || p.startsWith('pro/'));
  if (leaked.length) {
    fail(
      '公开包里混进闭源层',
      `${leaked.length} 个文件，例如：${leaked.slice(0, 8).join('、')}`,
      '这是硬红线。先修 package.json 的 files 白名单（补 !pro / !pro/**），再重新打包确认。',
    );
    return;
  }
  // 反向检查：公开包里必须真有核心文件。全被排除掉的"干净"是另一种事故。
  const mustHave = ['lib/index.js', 'lib/pro-resolve.js', 'bin/nexi.mjs', 'package.json', 'LICENSE'];
  const missing = mustHave.filter((p) => !list.includes(p));
  if (missing.length) {
    fail('公开包缺核心文件', missing.join('、'), 'files 白名单把该发的东西排掉了：这样的包装上跑不起来。');
    return;
  }
  notes.push(`规矩 1 通过：公开包 ${list.length} 个文件，pro/ 零命中`);
}

/** 规矩 4：pro/ 不许进 git（公开仓库红线）。 */
function checkGit() {
  if (!existsSync(join(ROOT, '.git'))) {
    notes.push('规矩 4 跳过：这里不是 git 工作区');
    return;
  }
  const tracked = spawnSync('git', ['ls-files', '--', 'pro'], { cwd: ROOT, encoding: 'utf8' });
  if (tracked.status !== 0) {
    notes.push('规矩 4 跳过：git 命令不可用');
    return;
  }
  const files = String(tracked.stdout || '').trim().split('\n').filter(Boolean);
  if (files.length) {
    fail(
      '闭源层被 git 跟踪',
      `${files.length} 个文件，例如：${files.slice(0, 8).join('、')}`,
      '闭源代码一旦进过公开仓库就再也收不回来了（历史里永远拿得到）。'
        + '先 git rm --cached pro，再确认 .gitignore 有 pro/，然后检查远端历史。',
    );
    return;
  }
  /*
   * 探测路径用 pro/package.json 而不是 pro 本身，并且带 --no-index：
   * · 开源仓库里 pro/ 根本**不存在**，`git check-ignore pro` 会因为"不是目录"直接返回 1，
   *   于是开源形态永远误报 —— 这个坑是实测出来的，不是猜的；
   * · --no-index 让它只按 .gitignore 规则判，不看索引里有没有这个文件。
   */
  const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', 'pro/package.json'], { cwd: ROOT });
  if (ignored.status !== 0) {
    fail('pro/ 没被 .gitignore 覆盖', '.gitignore 里没有 pro/', '补一行 pro/，否则下一次 git add -A 就把它带进去了。');
    return;
  }
  notes.push('规矩 4 通过：git 零跟踪 + .gitignore 已覆盖');
}

checkStaticImports();
checkProSpecs();
checkGit();
if (!SKIP_PACK) checkPack();

if (AS_JSON) {
  console.log(JSON.stringify({ ok: problems.length === 0, problems, notes }, null, 2));
} else {
  for (const n of notes) console.log(`  · ${n}`);
  if (problems.length) {
    console.error(`\n❌ 闭源边界守卫：${problems.length} 项不通过\n`);
    for (const p of problems) {
      console.error(`[${p.rule}]`);
      for (const line of String(p.detail).split('\n')) console.error(`  ${line}`);
      console.error(`  → ${p.how}\n`);
    }
  } else {
    console.log('\n✅ 闭源边界守卫：全部通过');
  }
}

process.exit(problems.length ? 1 : 0);
