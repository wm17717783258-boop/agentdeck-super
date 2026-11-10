#!/usr/bin/env node
/**
 * nexi —— Nexi 灵犀本地 Hub 的命令行入口。
 *
 * 子命令（都只做一件事，方便宿主/脚本/我自己验证）：
 *   nexi mcp                  stdio 起 MCP 服务（宿主配置里写这一条）
 *   nexi list                 列出当前 Hub 能提供的工具
 *   nexi call <tool> [json]   直接调一个工具，打印人话结果
 *   nexi doctor               体检：Node / 配置目录 / Hub 能否起来 / 各宿主探测
 *   nexi install [host|--all] 把 nexi 注册进宿主（默认只装探测到的）
 *   nexi uninstall [host|--all]
 *   nexi status               机器可读的一行状态（给脚本用）
 *
 * 约定：诊断信息一律 stderr，stdout 只给结构化结果。
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHub } from '../lib/hub.js';
import { serveStdio } from '../lib/mcp/server.js';
import {
  HOSTS, BUILTIN_HOSTS, HOST_REGISTRY_PROBLEMS, detectHosts, installHost, uninstallHost, installAll, launchCommand,
  buildSnippet, adHocHost, shapeKeys, shapeKeyOf, kindFor, restoreHost, repairHost,
} from '../lib/connect/hosts.js';
import { listBackups, backupSummary, DEFAULT_KEEP } from '../lib/connect/backup.js';
import { lockState } from '../lib/connect/lock.js';
import { hostsDir, saveCustomHost, removeCustomHost, loadCustomHosts } from '../lib/connect/registry.js';
import { platformCtx } from '../lib/connect/platform.js';
import { verifyHost, recordHostsEvidence, summarize } from '../lib/connect/verify.js';
import { buildDiagnostics } from '../lib/diagnostics.js';
import { auditHost, describeAudit } from '../lib/connect/audit.js';
import { readVersion } from '../lib/version.js';
import { planSelfRemoval, removeSelf, describePlan } from '../lib/selfremove.js';
import { logEvent, readTail, clearLogs, logsDir, formatEntry } from '../lib/log.js';
import { checkForUpdate, updateCheckEnabled } from '../lib/updatecheck.js';
import {
  defaultHome,
  currentMeta,
  stableLaunch,
  stableCliPath,
  setup,
  updateFromNpm,
  rollback,
  PACKAGE_ROOT,
} from '../lib/installer.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const rest = argv.slice(1);

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function print(obj) {
  process.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)}\n`);
}

/** 取值型开关：`--out <路径>` / `--out=<路径>` 两种写法都认。 */
const VALUE_FLAGS = {
  out: 'out',
  host: 'host',
  port: 'port',
  data: 'data',
  token: 'token',
  'public-url': 'publicUrl',
  tunnel: 'tunnel',
  'tls-cert': 'tlsCert',
  'tls-key': 'tlsKey',
  home: 'home',
  bundle: 'bundle',
  sha256: 'sha256',
  source: 'source',
  registry: 'registry',
  'launch-home': 'launchHome',
  label: 'label',
  path: 'path',
  shape: 'shape',
  kind: 'kind',
  docs: 'docs',
  cli: 'cli',
  name: 'name',
  tail: 'tail',
  day: 'day',
  to: 'to',
};

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--all') flags.all = true;
    else if (a === '--quick') flags.quick = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--md') flags.md = true;
    else if (a === '--last') flags.last = true;
    else if (a === '--export') flags.export = true;
    else if (a === '--toml') flags.toml = true;
    else if (a === '--record') flags.record = true;
    else if (a === '--portable') flags.portable = true;
    else if (a === '--public') flags.public = true;
    else if (a === '--read-only' || a === '--readonly') flags.readOnly = true;
    else if (a === '--no-hosts') flags.noHosts = true;
    else if (a === '--dev') flags.dev = true;
    else if (a === '--self') flags.self = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--keep-state') flags.keepState = true;
    else if (a === '--keep-hosts') flags.keepHosts = true;
    else if (a === '--check') flags.check = true;
    else if (a === '--clear') flags.clear = true;
    else if (a === '--dir') flags.dir = true;
    else if (typeof a === 'string' && a.startsWith('--') && VALUE_FLAGS[a.slice(2).split('=')[0]]) {
      // 取值型开关必须吃掉后面的值，不能把它当成位置参数——
      // 以前这里没处理，`--out x` 的 x 会掉进 flags._，调用方拿不到，路径就被静默丢掉了。
      const [name, inline] = a.slice(2).split('=');
      const key = VALUE_FLAGS[name];
      if (inline !== undefined) flags[key] = inline;
      else if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
        flags[key] = args[i + 1];
        i += 1;
      } else flags[key] = true;
    } else flags._.push(a);
  }
  return flags;
}

async function hubOptionsFromEnv() {
  return {
    workspace: process.env.NEXI_WORKSPACE || process.cwd(),
    boardRoot: process.env.NEXI_BOARD_ROOT || '',
    roomRoot: process.env.NEXI_ROOM_ROOT || '',
    petRoot: process.env.NEXI_PET_ROOT || '',
    licenseRoot: process.env.NEXI_LICENSE_ROOT || '',
    onLog: log,
  };
}

/**
 * 宿主到底接通了没有 —— 四层校验，不是全文搜 "nexi"。
 *
 * 旧实现是 `/nexi/i.test(读全文)`，它会把这些情况全判成"已注册"：
 * 条目指向的脚本已被删、command 的 node 路径不存在、注释里提到 nexi、
 * 别家 server 名字里带 nexi。假绿比红更糟 —— 用户看到 ✅ 就不再查了。
 */
function auditOf(host, currentLaunch) {
  if (!host || !host.installed || !host.path) {
    return { id: host && host.id, state: 'absent', reason: '宿主没装' };
  }
  return auditHost(host, { file: host.path, currentLaunch });
}

/**
 * 功能自检：在临时目录里真开一单、真画一遍皮肤。
 * 只用 mkdtemp，绝不动用户已有的账本/订单 —— 体检不该有副作用。
 */
async function functionalProbe() {
  const out = [];
  const tmp = mkdtempSync(join(tmpdir(), 'nexi-doctor-'));
  try {
    const [{ createMarket }, { createMarketTool }, skinsMod] = await Promise.all([
      import('../lib/market/index.js'),
      import('../lib/tools/market.js'),
      import('../lib/pet/skins.js'),
    ]);

    const market = createMarket({ root: tmp, billing: null });
    const tool = createMarketTool({ market, billing: null });
    const textOf = (r) => (r && typeof r.text === 'string' ? r.text : String(r ?? ''));

    const cat = typeof market.catalog === 'function' ? market.catalog() : { skins: [] };
    const list = Array.isArray(cat.skins) ? cat.skins : [];
    const paid = list.filter((s) => Number(s.price) > 0);
    out.push({ key: '货架', ok: list.length > 0, detail: `${list.length} 套皮肤（付费 ${paid.length} 套）` });

    const pick = paid[0] || list[0];
    if (pick) {
      const placed = textOf(await tool.execute({ action: 'place', skinId: pick.id }, {}));
      const oid = (placed.match(/ord_[A-Za-z0-9_-]+/) || [])[0] || '';
      out.push({ key: '开单', ok: Boolean(oid), detail: oid ? `${oid}（${pick.name || pick.id}）` : '开不出订单' });
    } else {
      out.push({ key: '开单', ok: false, detail: '货架是空的，没东西可开' });
    }

    const states = skinsMod.SKIN_STATES || [];
    const all = (skinsMod.listSkins({}) || {}).skins || [];
    let drawn = 0;
    for (const s of all) {
      for (const st of states) {
        const svg = skinsMod.renderSprite({ skin: s, state: st });
        if (typeof svg === 'string' && svg.length > 0) drawn += 1;
      }
    }
    const expected = all.length * states.length;
    out.push({ key: '皮肤图', ok: expected > 0 && drawn === expected, detail: `${drawn}/${expected} 帧画得出来` });
  } catch (err) {
    out.push({ key: '功能', ok: false, detail: err.message });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/**
 * 体检。默认输出**给人看**的一段结论（这台机器到底能不能用）；
 * `--json` 才是机器可读结构 —— 老脚本按它解析，字段照旧不动。
 * `--quick` 只查"装没装"，不真开单。
 */
async function cmdDoctor() {
  const flags = parseFlags(rest);
  const version = await readVersion();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = nodeMajor >= 22;

  let tools = [];
  let hubErr = '';
  try {
    // 体检要安静：createHub 会给每个工具打一行 [nexi:info]，二十几行日志
    // 会把三段结论顶出屏幕 —— 用户本来就看不懂，再把结论挤走等于白做。
    // 真起不来时 hubErr 里有原因，不会因为静默而失明。
    const hub = await createHub({ ...(await hubOptionsFromEnv()), onLog: () => {} });
    tools = hub.list().map((t) => t.name);
  } catch (err) {
    hubErr = err.message;
  }

  const currentLaunch = launchCommand();
  const hosts = detectHosts().map((h) => {
    const audit = auditOf(h, currentLaunch);
    return { ...h, audit, registered: audit.state === 'wired' };
  });
  const live = hosts.filter((h) => h.installed);
  const wired = live.filter((h) => h.registered);
  // 装了但接不上（脚本没了 / node 没了 / 条目是注释）—— 这是真故障，不是"没装"
  const brokenWiring = live.filter((h) => !h.registered);

  // 宿主实际会跑哪一份代码：插件走 git、固定目录走 npm，两条分发路径会脱节。
  // 用户在 npm 上跑 `@latest doctor` 看到新版本，宿主里跑的却还是上次 --all 装的那份 ——
  // 表现是"升级了但行为没变"，最容易被当成网络问题查到半夜。
  const instMeta = currentMeta();
  const hostVer = String((instMeta && instMeta.version) || '');
  const hostStale = Boolean(hostVer && hostVer !== version);

  if (flags.json) {
    const checks = [];
    checks.push({ name: 'node', ok: nodeOk, detail: process.versions.node });
    checks.push({ name: 'nexi', ok: true, detail: version });
    checks.push({ name: 'hub', ok: tools.length > 0, detail: hubErr || `${tools.length} 个工具`, tools });
    checks.push({
      name: 'hosts',
      // 以前这里永远为真 —— 装了但条目指向已删脚本也算"过关"，等于体检盖章放行。
      ok: brokenWiring.length === 0,
      detail: brokenWiring.length
        ? `${live.length}/${hosts.length} 已安装，${brokenWiring.length} 个接不上`
        : `${live.length}/${hosts.length} 已安装，全部接通`,
      hosts: hosts.map((h) => ({
        id: h.id,
        label: h.label,
        installed: h.installed,
        registered: h.registered,
        audit: h.audit && h.audit.state,
        auditReason: (h.audit && (h.audit.reason || h.audit.note)) || '',
        path: h.path,
      })),
    });
    const launch = launchCommand();
    checks.push({
      name: 'launch',
      ok: true,
      detail: `${launch.command} ${launch.args.join(' ')}`,
      // 新增字段，老消费者忽略即可
      hostVersion: hostVer || 'npx',
      hostStale,
    });
    print({ ok: checks.every((c) => c.ok), checks });
    return checks.every((c) => c.ok) ? 0 : 1;
  }

  const fn = flags.quick ? [] : await functionalProbe();
  const lines = [];
  lines.push(`Nexi 自检 · v${version}`);
  lines.push('');
  lines.push('① 运行环境');
  lines.push(`  ${nodeOk ? '✅' : '❌'} Node ${process.versions.node}${nodeOk ? '' : '（要 22 或更高，去 nodejs.org 装新版）'}`);
  lines.push(`  ${tools.length ? '✅' : '❌'} ${tools.length} 个工具${hubErr ? `（起不来：${hubErr}）` : ' 都能列出来'}`);
  lines.push('');
  lines.push('② 接进宿主了吗');
  if (!live.length) {
    lines.push('  ❌ 这台机器没探测到任何支持的宿主');
    lines.push('     Claude Code / Codex / Gemini CLI / dsh 装一个，再回来跑这条命令');
  } else {
    for (const h of live) {
      const a = h.audit || {};
      lines.push(`  ${h.registered ? '✅' : '❌'} ${h.label}  ${describeAudit(a)}`);
    }
    // 没装的宿主**折成一行**：接入表有 25 个，一家一行会把结论顶出屏幕 ——
    // 用户要的是"我这台能不能用"，不是"世界上还有多少家没装"。
    const absent = hosts.filter((x) => !x.installed);
    if (absent.length) {
      lines.push(`  ·  没装 ${absent.length} 个：${absent.map((h) => h.label).join('、')}`);
    }
    const customCount = HOSTS.filter((h) => h.source === 'custom').length;
    lines.push(`  ·  接入表 ${HOSTS.length} 个（内置 ${BUILTIN_HOSTS.length} + 自定义 ${customCount}${customCount ? '' : '，用 nexi host add 可加任意 Agent'}）`);
    for (const p of HOST_REGISTRY_PROBLEMS) {
      lines.push(`  ❌ 注册表 ${p.file} 没读进去：${p.error}`);
    }
    if (!hostVer) {
      lines.push('  ·  没有固定目录：宿主每次从 npm 现取（首次会多等几秒）');
    } else if (hostStale) {
      lines.push(`  ❌ 宿主跑的是 ${hostVer}，而这条命令是 ${version}`);
      lines.push('     → 跑一次 npx -y agentdeck-super@latest --all，宿主才会换成新那份');
    } else {
      lines.push(`  ✅ 宿主跑的是 ${hostVer}（固定目录，和这条命令同一份）`);
    }
  }
  // 排障入口：出问题时先让用户跑 nexi logs，比让他复制终端靠谱。
  lines.push(`  ·  运行日志 ${logsDir()}（nexi logs 看最近 30 条）`);
  if (!flags.quick) {
    lines.push('');
    lines.push('③ 真能干活吗（在临时目录里试，不碰你的数据）');
    for (const f of fn) lines.push(`  ${f.ok ? '✅' : '❌'} ${f.key}  ${f.detail}`);
  }

  // 可选更新检查：**默认关**。只有 NEXI_UPDATE_CHECK=1 才联网 ——
  // "不分网络"是硬承诺，不能靠每次体检偷偷连一下 registry 来换一个提示。
  if (updateCheckEnabled()) {
    const up = await checkForUpdate({ current: version });
    if (up.ok && up.outdated) lines.push(`  ·  有新版本 ${up.latest}（当前 ${version}）：nexi update`);
    else if (up.ok) lines.push('  ·  已是最新版');
  }

  const bad = [];
  if (!nodeOk) bad.push('Node 版本太低');
  if (!tools.length) bad.push('工具起不来');
  if (!live.length) bad.push('没有可用宿主');
  else if (!wired.length) bad.push('宿主没接上 nexi');
  for (const f of fn) if (!f.ok) bad.push(f.key);

  lines.push('');
  lines.push('────────────────────────────');
  if (!bad.length) {
    lines.push('结论：这台机器可以直接用。');
  } else {
    lines.push(`结论：还不能用 —— ${bad.join('、')}`);
    if (bad.includes('宿主没接上 nexi')) lines.push('      修法：nexi install --all');
  }
  lines.push('');
  lines.push('把下面这段复制给我，我一眼就能看出问题在哪：');
  lines.push('┌────────────────────────────────');
  lines.push(`│ 机器 ${process.platform}/${process.arch} · node ${process.versions.node}`);
  lines.push(`│ 版本 ${version}`);
  // 诊断块是给人复制粘贴的：25 家全铺开一行太长，只列已装的 + 总数。
  // 26 个宿主全列出来会把结论顶出屏幕；只说结论 + 谁出问题。
  lines.push(`│ 宿主 ${wired.length}/${hosts.length} 已接${brokenWiring.length ? ` · 接不上：${brokenWiring.map((h) => h.id).join(',')}` : ''}`);
  if (fn.length) lines.push(`│ 功能 ${fn.map((f) => `${f.key}=${f.ok ? 'ok' : '失败'}`).join(' ')}`);
  else lines.push('│ 功能 （--quick 跳过）');
  lines.push(`│ 结论 ${bad.length ? 'FAIL' : 'PASS'}`);
  lines.push('└────────────────────────────────');
  logEvent(bad.length ? 'warn' : 'info', 'doctor', {
    version,
    node: process.versions.node,
    tools: tools.length,
    wired: `${wired.length}/${hosts.length}`,
    pass: bad.length === 0,
    bad: bad.join(','),
  });
  print(lines.join('\n'));

  // --export：把这次体检连同宿主清单、配置结构、日志尾部打包成可直接发出的目录。
  // 只导结构不导内容 —— 配置里可能有 key，诊断包不该成为泄密包。
  if (flags.export) {
    const diag = buildDiagnostics({
      version,
      doctorText: lines.join('\n'),
      outDir: typeof flags.out === 'string' ? resolve(flags.out) : process.cwd(),
    });
    print([
      '',
      `诊断包：${diag.dir}`,
      `${diag.files.length} 个文件，${(diag.bytes / 1024).toFixed(1)} KB。`,
      '里面没有 API key、token、配置原文，家目录都缩成了 ~，可以直接发出去。',
    ].join('\n'));
  }

  return bad.length ? 1 : 0;
}

async function cmdList() {
  const hub = await createHub(await hubOptionsFromEnv());
  print(hub.list().map((t) => ({ name: t.name, description: t.description })));
}

async function cmdCall() {
  const name = rest[0];
  if (!name) {
    log('用法：nexi call <tool> [json参数]');
    return 2;
  }
  let args = {};
  if (rest[1]) {
    try {
      args = JSON.parse(rest[1]);
    } catch (err) {
      log(`参数不是合法 JSON：${err.message}`);
      return 2;
    }
  }
  const hub = await createHub(await hubOptionsFromEnv());
  const blocks = await hub.call(name, args);
  for (const b of blocks) {
    print(b.type === 'text' ? b.text : JSON.stringify(b));
  }
  return 0;
}

async function cmdInstall() {
  const flags = parseFlags(rest);
  // --portable：配置里写裸 `node` 而不是本机 node 的绝对路径。
  // 什么时候用：这份配置要被拷到别的电脑、或者你不知道对面 node 装在哪。
  // name：同一个 Agent 里装多份 nexi（不同参数/不同工作区）时给条目换个名字。
  // 以前只有"走宿主 CLI"那条路认它，写配置文件那条路硬编码 nexi —— 于是 --name 静默失效。
  const entryName = typeof flags.name === 'string' && flags.name.trim() ? flags.name.trim() : undefined;
  const opts = { dryRun: flags.dryRun, force: flags.force, portable: flags.portable === true, name: entryName };
  if (flags.all) {
    const results = installAll(opts);
    print(results);
    return results.some((r) => r.ok) ? 0 : 1;
  }
  const target = flags._[0];
  if (!target) {
    const hosts = detectHosts();
    print({ hint: 'nexi install <host-id> 或 --all', hosts: hosts.map((h) => ({ id: h.id, label: h.label, installed: h.installed, path: h.path })) });
    return 0;
  }
  // 目标文件从哪来，优先级（以前这里只认环境变量，命令行传的路径会被静默丢掉）：
  //   ① 命令行显式给的路径（第 2 个位置参数）
  //   ② 环境变量 NEXI_HOST_CONFIG
  //   ③ 宿主默认路径
  const explicit = typeof flags._[1] === 'string' && flags._[1].trim() ? flags._[1].trim() : '';
  const targetPath = explicit || process.env.NEXI_HOST_CONFIG || undefined;

  // 「能不能生成正确配置」和「该不该写这台机器的默认路径」是两件事，不要混：
  //   · 适配能力跟宿装没装**无关**——我们知道它的配置格式就能生成（这才是插件要做的）；
  //   · 但没装的宿主，不该默默往它默认路径塞文件（副作用控制）。
  // 所以：显式给了路径 / 加了 --force / dry-run → 照常生成，不拦；
  // 只有"没装 + 没给路径 + 要真写"才拒绝，并告诉人怎么继续。
  if (!targetPath && !opts.force && !opts.dryRun) {
    const found = detectHosts().find((h) => h.id === target);
    if (found && !found.installed) {
      print({
        ok: false,
        code: 'host_not_installed',
        id: target,
        hint: `本机没装 ${found.label}，不往它的默认路径写配置（免得在没装的宿主目录里留文件）。`
          + `想看/取这份配置：加 --dry-run 拿预览，或显式给路径 nexi install ${target} <文件路径>；`
          + `确认要写默认路径就加 --force。`,
        wouldWrite: found.path,
        // 直接给出配置内容：适配不需要装宿主，用户（或别的脚本）拿着就能用
        preview: (() => {
          const r = installHost(target, { ...opts, path: found.path, dryRun: true });
          return r.ok ? r.preview : null;
        })(),
      });
      return 1;
    }
  }
  // nexi install custom <文件> --shape servers
  // 未收录的 Agent 走这条：不写注册表、不等发版，直接按形状写进它自己的配置。
  if (target === 'custom') {
    const file = explicit || flags.path || '';
    if (!file) {
      print({ ok: false, hint: `用法：nexi install custom <配置文件路径> --shape ${shapeKeys().join('|')} [--kind json|toml|yaml]` });
      return 2;
    }
    const shape = flags.shape || 'mcpServers';
    if (!shapeKeys().includes(shape)) return print({ ok: false, hint: `shape 可选：${shapeKeys().join(' / ')}` }), 2;
    const kind = ['toml', 'yaml'].includes(flags.kind) ? flags.kind : (shape.startsWith('yaml.') ? 'yaml' : 'json');
    const host = adHocHost({ id: 'custom', label: '自定义 Agent', shape, kind, path: resolve(file) });
    const res = installHost('custom', { ...opts, host, path: resolve(file) });
    print(res);
    return res.ok ? 0 : 1;
  }

  const res = installHost(target, { ...opts, path: targetPath });
  print(res);
  return res.ok ? 0 : 1;
}

async function cmdUninstall() {
  const flags = parseFlags(rest);
  if (flags.self) return cmdUninstallSelf(flags);
  if (flags.all) {
    const out = detectHosts().filter((h) => h.installed).map((h) => ({ id: h.id, ...uninstallHost(h.id, { dryRun: flags.dryRun }) }));
    print(out);
    return 0;
  }
  const target = flags._[0];
  if (!target) {
    print({ hint: 'nexi uninstall <host-id> 或 --all', hosts: HOSTS.map((h) => h.id) });
    return 0;
  }
  // 和 install 一样的路径优先级：命令行显式路径 > NEXI_HOST_CONFIG > 宿主默认路径。
  // 以前这里也只认环境变量，命令行传的路径被静默丢掉，
  // 于是"卸载成功了"其实卸的是宿主默认路径、你指的那个文件一个字没动。
  const explicit = typeof flags._[1] === 'string' && flags._[1].trim() ? flags._[1].trim() : '';
  const targetPath = explicit || process.env.NEXI_HOST_CONFIG || undefined;

  // `uninstall custom <文件> --shape X`：与 `install custom` 对称。
  // 不给 shape 时按 mcpServers 处理 —— 这是最常见的形状，也是 install custom 的默认值。
  if (target === 'custom') {
    if (!explicit) {
      print({ ok: false, hint: `用法：nexi uninstall custom <配置文件路径> [--shape ${shapeKeys().join('|')}] [--kind json|toml|yaml] [--name nexi]` });
      return 2;
    }
    const shape = typeof flags.shape === 'string' ? flags.shape : 'mcpServers';
    const kind = typeof flags.kind === 'string' ? flags.kind : 'json';
    if (!shapeKeys().includes(shape)) {
      print({ ok: false, hint: `shape 不认识：${shape}`, shapes: shapeKeys() });
      return 2;
    }
    const host = adHocHost({ id: 'custom', label: '自定义 Agent', shape, kind, path: resolve(explicit) });
    const res = uninstallHost('custom', { dryRun: flags.dryRun, path: resolve(explicit), host, name: flags.name });
    print(res);
    return res.ok ? 0 : 1;
  }

  const res = uninstallHost(target, { dryRun: flags.dryRun, path: targetPath });
  print(res);
  return res.ok ? 0 : 1;
}

/**
 * `nexi uninstall --self` —— 把产品自己卸干净（宿主条目 + 安装目录 + 状态目录）。
 *
 * 分两段执行：
 *   ① 活着的进程把宿主配置里的 nexi 摘掉 —— 它懂各家格式，也只有它能当场做；
 *   ② 目录交给清理进程（等本进程退出再删）。在 Windows 上删运行中的目录必失败，
 *      所以"删完立刻回读"这一步由清理进程做，并把结果写进日志，路径打印出来。
 *
 * 没有 --yes 就只算计划、不动手：这是不可逆操作，默认不该"手快就没了"。
 */
/**
 * nexi restore —— 从备份回滚某个宿主的配置。
 *
 * 为什么需要：从 1.11.x 起每次写入前都会备份，但"有备份"不等于"能回滚"——
 * 用户得自己去配置目录里翻一堆带时间戳的文件，还得判断哪个是装之前、
 * 哪个是卸之前。这条命令把这件事变成一句话。
 */
async function cmdRestore() {
  const flags = parseFlags(rest);
  const id = flags._[0];

  // 不带宿主：列出所有"有备份可回"的宿主，让人知道能救谁
  if (!id) {
    const rows = [];
    for (const h of detectHosts()) {
      if (!h.installed || !h.path) continue;
      const sum = backupSummary(h.path);
      if (!sum.count) continue;
      rows.push({ id: h.id, label: h.label, path: h.path, count: sum.count, bytes: sum.bytes, latest: sum.latest });
    }
    print({ hint: 'nexi restore <host> 看这个宿主有哪些备份；加 --last 回滚到最近一份', hosts: rows });
    return 0;
  }

  const opts = {
    last: flags.last === true,
    to: typeof flags.to === 'string' ? flags.to : undefined,
    path: typeof flags.path === 'string' ? flags.path : undefined,
    dryRun: flags.dryRun === true,
  };
  const r = restoreHost(id, opts);

  if (r.ok && r.listed) {
    const rows = (r.backups || []).map((b, i) => ({
      序号: i + 1,
      时间: b.at,
      来由: b.why,
      大小: b.size,
      文件: b.path,
    }));
    print({
      ok: true,
      host: id,
      path: r.path,
      hint: `共 ${rows.length} 份。回滚最近一份：nexi restore ${id} --last`,
      backups: rows,
    });
    return 0;
  }

  if (r.reason === 'no-backup') {
    print({ ok: false, host: id, path: r.path, hint: '这个宿主还没有备份（第一次写入前才会生成）' });
    return 1;
  }
  print(r);
  return r.ok ? 0 : 1;
}

async function cmdUninstallSelf(flags) {
  const home = typeof flags.home === 'string' ? flags.home : defaultHome();
  const opts = {
    installHome: home,
    stateRoot: undefined,
    keepState: flags.keepState === true,
    // 当前跑的是不是固定安装目录里的那份代码？从源码目录跑时不能删源码。
    selfRoot: PACKAGE_ROOT,
  };
  const plan = planSelfRemoval(opts);
  const installed = flags.keepHosts ? [] : detectHosts().filter((h) => h.installed);

  if (flags.dryRun || !flags.yes) {
    const text = [
      `将摘掉宿主条目：${installed.length ? installed.map((h) => h.id).join(', ') : '（无）'}`,
      '将删除这些目录：',
      describePlan(plan),
    ].join('\n');
    print({
      ok: true,
      dryRun: !flags.yes,
      needConfirm: !flags.yes,
      installHome: plan.installHome,
      stateRoot: plan.stateRoot,
      hosts: installed.map((h) => h.id),
      targets: plan.targets,
      skipped: plan.skipped,
      text,
      hint: flags.yes ? undefined : '确认无误后加 --yes 真的执行（--keep-state 保留授权/账本/任务板）',
    });
    return flags.yes ? 0 : 2;
  }

  const hosts = installed.map((h) => {
    const r = uninstallHost(h.id);
    return { id: h.id, ok: r.ok, changed: r.changed, path: r.path };
  });
  const removal = removeSelf({ ...opts, plan });
  const out = {
    ok: removal.ok && hosts.every((h) => h.ok !== false),
    hosts,
    removed: removal.removed,
    deferred: removal.deferred,
    failed: removal.failed,
    log: removal.log,
    note: removal.note,
    text: describePlan(plan),
  };
  print(out);
  return out.ok ? 0 : 1;
}

/** `nexi logs` —— 排障时先看这个，不用再让用户复制终端。 */
function cmdLogs() {
  const flags = parseFlags(rest);
  if (flags.clear) {
    print({ ok: true, ...clearLogs() });
    return 0;
  }
  if (flags.dir || flags.path === true) {
    print({ ok: true, dir: logsDir() });
    return 0;
  }
  const tail = Number(flags.tail || 30);
  const { dir, files, entries } = readTail({ lines: Number.isFinite(tail) ? tail : 30, day: typeof flags.day === 'string' ? flags.day : undefined });
  if (flags.json) {
    // NDJSON：一行一条，jq -c 直接吃。没有日志时也要吐一行 ——
    // 空输出会让 `nexi logs --json | jq` 在脚本里表现成"管道没数据"，
    // 分不清是没日志还是命令坏了。
    if (!entries.length) {
      process.stdout.write(`${JSON.stringify({ ok: true, entries: 0, dir, files, note: '还没有日志；跑一次 nexi doctor 就会写进来' })}\n`);
      return 0;
    }
    for (const e of entries) process.stdout.write(`${JSON.stringify(e)}\n`);
    return 0;
  }
  const lines = [`目录：${dir}`, `文件：${files.slice(-3).join(', ') || '（还没有日志）'}`, ''];
  for (const e of entries) lines.push(formatEntry(e));
  if (!entries.length) lines.push('（还没有日志。跑一次 nexi doctor 就会写进来；NEXI_LOG=0 可关闭。）');
  print(lines.join('\n'));
  return 0;
}

async function cmdStatus() {
  const hub = await createHub(await hubOptionsFromEnv());
  const hosts = detectHosts();
  const out = {
    version: await readVersion(),
    tools: hub.list().length,
    hostsInstalled: hosts.filter((h) => h.installed).map((h) => h.id),
    workspace: (await hubOptionsFromEnv()).workspace,
  };
  print(out);
  return 0;
}

/**
 * nexi setup —— 固定目录安装 / 更新。
 *
 * 这是给最终用户和 npx 用的入口：默认把当前包复制到 %LOCALAPPDATA%\Nexi，
 * 写入稳定启动器，然后只改写探测到的宿主。后续所有版本都复用同一个启动器路径。
 */
async function cmdSetup() {
  const flags = parseFlags(rest);
  const home = typeof flags.home === 'string' ? flags.home : defaultHome();
  const hosts = flags.noHosts ? 'none' : (flags._.length ? flags._ : undefined);
  const r = await setup({
    sourceRoot: typeof flags.source === 'string' ? flags.source : PACKAGE_ROOT,
    bundle: typeof flags.bundle === 'string' ? flags.bundle : undefined,
    home,
    sha256: typeof flags.sha256 === 'string' ? flags.sha256 : '',
    dryRun: flags.dryRun === true,
    hosts,
    force: flags.force !== false,
    action: 'setup',
  });
  print(r);
  return r.ok ? 0 : 1;
}

/**
 * nexi update —— 有网从 npm 最新版更新；离线/未上架用 --bundle。
 * 默认仍是固定目录 + 稳定启动器，绝不把宿主配置改回某个临时版本目录。
 */
async function cmdUpdate() {
  const flags = parseFlags(rest);
  const home = typeof flags.home === 'string' ? flags.home : defaultHome();
  // `--check` 只问一句"有没有新版"，不装、不写盘。
  // 这是唯一会联网的入口，而且必须由用户显式敲出来。
  if (flags.check) {
    const current = currentMeta(home)?.version || await readVersion();
    const r = await checkForUpdate({ current, force: true });
    print({
      ...r,
      hint: r.outdated
        ? `有新版本 ${r.latest}（当前 ${current}）：nexi update 或 npm i -g agentdeck-super`
        : (r.ok ? '已是最新' : '没查到（离线/registry 不通都不影响使用）'),
    });
    return r.ok ? 0 : 1;
  }
  const hosts = flags.noHosts ? 'none' : (flags._.length ? flags._ : undefined);
  const common = {
    home,
    hosts,
    force: flags.force !== false,
    dryRun: flags.dryRun === true,
  };
  try {
    const r = flags.bundle
      ? await setup({
        ...common,
        bundle: flags.bundle,
        sha256: typeof flags.sha256 === 'string' ? flags.sha256 : '',
        action: 'update',
      })
      : await updateFromNpm({
        ...common,
        registry: typeof flags.registry === 'string' ? flags.registry : undefined,
      });
    print(r);
    return r.ok ? 0 : 1;
  } catch (err) {
    print({
      ok: false,
      reason: String(err?.message || err),
      home,
      hint: '未上架或离线时：nexi update --bundle <本地 tgz 或 URL>',
    });
    return 1;
  }
}

async function cmdRollback() {
  const flags = parseFlags(rest);
  const home = typeof flags.home === 'string' ? flags.home : defaultHome();
  const r = rollback(home, { dryRun: flags.dryRun === true });
  print(r);
  return r.ok ? 0 : 1;
}

async function cmdVersion() {
  const flags = parseFlags(rest);
  const home = typeof flags.home === 'string' ? flags.home : defaultHome();
  const current = currentMeta(home);
  print({
    ok: true,
    version: current?.version || await readVersion(),
    packageVersion: await readVersion(),
    home,
    current,
    launcher: stableCliPath(home),
    launch: stableLaunch(home),
  });
  return 0;
}

/**
 * nexi pair —— 安装后的稳定配对入口。
 *
 * 真机测试不需要用户知道版本目录在哪里；状态统一放到 <安装目录>/pair，
 * 升级后仍能接着用。显式设置 NEXI_PAIR_DIR 时尊重用户自己的目录。
 */
async function cmdPair() {
  const home = process.env.NEXI_INSTALL_HOME || defaultHome();
  const env = { ...process.env };
  if (!env.NEXI_PAIR_DIR) env.NEXI_PAIR_DIR = join(home, 'pair');
  const script = join(PACKAGE_ROOT, 'tools', 'nexi-pair.mjs');
  const r = spawnSync(process.execPath, [script, ...rest], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.error) {
    log(`配对命令没起来：${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

async function cmdMcp() {
  // stdio 模式：stdout 是协议通道，任何日志都只能走 stderr
  const flags = parseFlags(rest);
  const readOnly = flags.readOnly || /^(1|true|yes)$/i.test(String(process.env.NEXI_MCP_READONLY || ''));
  await serveStdio({
    ...(await hubOptionsFromEnv()),
    readOnly,
    log: { info() {}, debug() {}, warn: log, error: log },
  });
  return null; // 保持进程存活，等待 stdin 关闭
}

/**
 * 自动化相关子命令的公共通道：起一次 Hub，调一次 deck_automation，收摊。
 * 起 Hub 时把巡检关掉（automation.enabled=false）——命令行只负责改状态，
 * 真正的执行归正在跑的那个宿主，免得同一条任务被两个进程各跑一次。
 */
async function automationCall(args) {
  const opts = await hubOptionsFromEnv();
  const hub = await createHub({ ...opts, config: { automation: { enabled: false } } });
  try {
    const blocks = await hub.call('deck_automation', args);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n');
    const ok = !/❌|失败|写盘失败|不认识|没有这个/.test(text);
    // --json 的契约是"输出能被 jq 解析"。以前这里无视这个开关，直接打人话，
    // 于是 `nexi jobs --json | jq` 会炸 —— 脚本化场景等于没有这个开关。
    if (rest.includes('--json')) print({ ok, action: args.action || 'list', output: text });
    else print(text);
    return ok ? 0 : 1;
  } finally {
    await hub.close();
  }
}

async function cmdStop() {
  const reason = rest.filter((x) => !x.startsWith('--')).join(' ').trim();
  return automationCall({ action: 'stop', reason });
}

async function cmdResume() {
  return automationCall({ action: 'resume' });
}

async function cmdJobs() {
  return automationCall({ action: 'list', limit: Number(rest[0]) || 20 });
}

async function cmdApprove() {
  const approvalId = rest[0];
  if (!approvalId) {
    log('用法：nexi approve <审批号>');
    return 2;
  }
  return automationCall({ action: 'approve', approvalId });
}

async function cmdDeny() {
  const approvalId = rest[0];
  if (!approvalId) {
    log('用法：nexi deny <审批号> [原因]');
    return 2;
  }
  return automationCall({ action: 'deny', approvalId, reason: rest.slice(1).join(' ') });
}

/**
 * nexi pet —— 把 2D 悬浮桌宠拉起来（1.10.0）。
 * 不装 Electron：用本机自带 Edge/Chrome 的 --app 窗口，无地址栏、无标签页。
 * 转调 bin/nexi-pet.mjs，参数原样透传（--size/--corner/--state/--port/--out/--print）。
 */
/**
 * nexi config [host|--all] —— 直接给出接入配置，**不需要装那个宿主**。
 *
 * 这是"插件适配"的正解：适配靠的是知道宿主的配置格式，不是把宿主装到本机。
 * 8 个宿主的配置形状我们自己维护、有测试钉着，所以任何一台机器上都能生成。
 *
 * 输出可直接粘进宿主配置文件；也可以 --out <路径> 写出来。
 * dry-run 语义：本命令**默认就是只输出**，不写任何宿主目录。
 */
async function cmdConfig() {
  const flags = parseFlags(rest);
  const out = typeof flags.out === 'string' ? flags.out : '';
  const wantAll = flags.all === true;
  const ids = wantAll ? HOSTS.map((h) => h.id) : [flags._[0]].filter(Boolean);
  if (!ids.length) {
    print({
      hint: 'nexi config <host-id> 或 --all；给出该宿主的 MCP 接入配置（不用装宿主）。',
      hosts: HOSTS.map((h) => ({ id: h.id, label: h.label, kind: h.kind, defaultPath: h.paths()[0] })),
    });
    return 0;
  }

  const results = [];
  // 探测一次就够：以前写在循环里，30 个宿主 × 一次全盘探测 = 用户等 1.8 秒。
  const detected = detectHosts();
  for (const id of ids) {
    const host = HOSTS.find((h) => h.id === id);
    if (!host) {
      results.push({ id, ok: false, reason: `不认识宿主：${id}` });
      continue;
    }
    // 关键：用 dry-run 拿配置文本，绝不落盘到宿主目录。
    // via:'file' 是必须的 —— 有 CLI 的宿主在 dry-run 下会返回"要执行的 CLI 参数"，
    // 而不是配置文本；但 nexi config 的语义是"给我这份配置长什么样"，
    // 跟本机有没有装 CLI 无关，所以要显式要走文件那条渲染路径。
    const r = installHost(id, { dryRun: true, force: true, via: 'file' });
    const kind = kindFor(host, host.paths()[0]);
    if (!r.ok) {
      // 「生成配置」和「能不能写进这台机器的那个文件」是两件事。
      // 目标文件里有半截哨兵时，install 会拒绝写（对），但 config 仍然该给出
      // 正确的配置文本 —— 否则用户会以为这个宿主适配不了。给出片段 + needsRepair。
      const shapeName = host.shape || (kind === 'yaml' ? 'yaml.mcpServers' : 'mcpServers');
      const snippet = buildSnippet({ shape: shapeName, launch: launchCommand({}), toml: kind === 'toml' });
      if (snippet) {
        results.push({
          id,
          label: host.label,
          kind,
          ok: true,
          defaultPath: host.paths()[0],
          installedLocally: detected.find((h) => h.id === id)?.installed === true,
          config: snippet,
          needsRepair: true,
          warnings: [
            ...(r.warnings || []),
            `这段配置本身是对的；但目标文件里有历史残留，install 会拒绝写入 —— 先跑 nexi repair ${id}。`,
          ],
        });
        continue;
      }
      results.push({ id, label: host.label, ok: false, reason: r.reason || '生成失败', warnings: r.warnings });
      continue;
    }
    const rec = {
      id,
      label: host.label,
      // kind 要按**默认落点**解析：Continue 是 auto（yaml 或 json 都认），
      // 直接抛 host.kind 会让调用方拿到 "auto" 这种没有信息量的值。
      kind: kindFor(host, host.paths()[0]),
      ok: true,
      defaultPath: host.paths()[0],
      // 本机装没装，只影响"要不要顺手写进去"，不影响能不能生成
      installedLocally: detected.find((h) => h.id === id)?.installed === true,
      config: r.preview,
    };
    // 显式要写文件才写（--out），否则只打印
    if (out) {
      const ext = rec.kind === 'toml' ? '.toml' : (rec.kind === 'yaml' ? '.yaml' : '.json');
      const file = ids.length > 1
        ? `${out.replace(/\.(json|toml|ya?ml)$/i, '')}-${id}${ext}`
        : out;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, r.preview, 'utf8');
        rec.writtenTo = file;
      } catch (err) {
        rec.writeError = String(err?.message || err);
      }
    }
    results.push(rec);
  }
  print(wantAll ? results : results[0]);
  return results.every((r) => r.ok) ? 0 : 1;
}

/**
 * nexi repair [host|--all] —— 把 nexi 自己留在配置文件里的残渣清干净。
 *
 * 为什么必须有这条：`install` 碰到半截哨兵会**拒绝写入**（否则文件越写越乱），
 * 但只拒绝不收拾，用户就卡死在那儿 —— 让他自己去 TOML 里数哪几行该删，是刁难。
 * 这条命令只删 nexi 自己的东西（哨兵注释 + [mcp_servers.nexi] 表），
 * 动手前照例备份，删完就能重新 install。
 */
async function cmdRepair() {
  const flags = parseFlags(rest);
  // parseFlags 把 --dry-run 归一成 flags.dryRun；写成 flags['dry-run'] 会永远是 undefined，
  // 于是「干跑」变成真写 —— 这一条踩过一次，现在由 tests/fault-recovery 钉住。
  const dryRun = flags.dryRun === true;
  const wantAll = flags.all === true;
  const ids = wantAll ? HOSTS.map((h) => h.id) : [flags._[0]].filter(Boolean);
  if (!ids.length) {
    print({
      ok: false,
      hint: '用法：nexi repair <host-id> 或 --all [--dry-run]；清掉 nexi 在配置里留下的半截标记，之后可重新 install。',
      hosts: HOSTS.map((h) => h.id),
    });
    return 2;
  }

  const rows = [];
  for (const id of ids) {
    const r = repairHost(id, { dryRun, path: typeof flags.path === 'string' ? flags.path : undefined });
    rows.push({ id, ...r });
  }
  const fixed = rows.filter((r) => r.changed);
  const broken = rows.filter((r) => !r.ok);
  if (wantAll) {
    // --all 时只报有动静的，避免 30 行 "clean" 把有用的信息淹了
    print({
      ok: broken.length === 0,
      dryRun,
      repaired: fixed.map((r) => ({ id: r.id, removed: r.removed, backup: r.backup })),
      failed: broken.map((r) => ({ id: r.id, reason: r.reason, message: r.message })),
      unchanged: rows.length - fixed.length - broken.length,
    });
  } else {
    print(rows[0]);
  }
  return broken.length ? 1 : 0;
}

/**
 * nexi relay —— 起跨机中继服务器（别的电脑靠它协作）。
 *
 * 为什么做进 CLI：跨机测试要给用户"一条命令起服务器"。
 * 以前 relay-server.mjs 在 tools/ 下、依赖仓库结构，单拷一个文件跑不起来。
 * 放进 CLI 之后，装了包的任何一台电脑都能直接起。
 */
async function cmdRelay() {
  const flags = parseFlags(rest);
  const port = Number(flags._[0] || 8787);
  const host = typeof flags.host === 'string' ? flags.host : '0.0.0.0';
  const tlsCert = typeof flags.tlsCert === 'string' ? flags.tlsCert : '';
  const tlsKey = typeof flags.tlsKey === 'string' ? flags.tlsKey : '';
  const dataDir = typeof flags.data === 'string' ? flags.data : '';
  const publicUrl = typeof flags.publicUrl === 'string' ? flags.publicUrl : '';

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    log('--tls-cert 和 --tls-key 必须成对给（证书 + 私钥）。');
    return 1;
  }

  const { startRelayServer } = await import('../tools/relay-server.mjs');
  const relay = await startRelayServer({
    port, host, quiet: false,
    ...(dataDir ? { dataDir } : {}),
    ...(tlsCert ? { tlsCert, tlsKey } : {}),
    ...(publicUrl ? { publicUrl } : {}),
  });
  const scheme = tlsCert ? 'https' : 'http';
  log(`relay 已启动：${scheme}://${host}:${relay.port}`);
  if (host === '0.0.0.0') {
    const nets = await import('node:os');
    for (const list of Object.values(nets.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) log(`  别的电脑填这个：${scheme}://${i.address}:${relay.port}`);
      }
    }
  }
  if (relay.publicUrl) log(`  公网地址：${relay.publicUrl}（邀请链接会用它；必须真的能回源到本 relay）`);
  log('  建房间要授权码（协作版起）；进房间凭邀请，不需要授权。Ctrl+C 停止。');
  await new Promise((done) => {
    const stop = async () => { await relay.close(); done(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

/**
 * nexi serve —— 独立 MCP Streamable HTTP 服务。
 *
 * 这是“任意电脑、任意支持远程 MCP 的客户端”那条路线：不要求先装 DSH，
 * 也不要求宿主自己开 webServer。给 URL 和 Bearer token 就能接。
 *
 * 公网有三种写法：
 *   --public-url https://your-domain.example   已有反代/ngrok/frp/Tailscale Funnel
 *   --tunnel cloudflared                       本机自动起 Cloudflare Quick Tunnel
 *   --tunnel localtunnel / --public            本机没有 cloudflared 时的后备
 *
 * 规则：只要不是回环地址，或者启用了隧道/公网 URL，就必须有 token。
 * 没有就自动生成一个并打印，绝不把无鉴权 MCP 端口挂到公网。
 */
async function cmdServe() {
  const flags = parseFlags(rest);
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  const port = Number(flags.port ?? flags._[0] ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log('端口不合法：--port 需要 0-65535 的整数。');
    return 2;
  }

  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const publicUrlRaw = typeof flags.publicUrl === 'string' ? String(flags.publicUrl).trim() : '';
  const requestedTunnel = flags.tunnel === true
    ? 'auto'
    : (typeof flags.tunnel === 'string' ? String(flags.tunnel).trim() : '');
  const tunnelProvider = requestedTunnel || (flags.public ? 'auto' : '');
  const publicMode = Boolean(publicUrlRaw || tunnelProvider);
  if (publicUrlRaw && tunnelProvider) {
    log('--public-url 和 --tunnel 只能选一个：已有反代地址就不要再起隧道。');
    return 2;
  }

  let explicitPublic = '';
  if (publicUrlRaw) {
    try {
      const { normalizePublicUrl } = await import('../tools/nexi-tunnel.mjs');
      explicitPublic = normalizePublicUrl(publicUrlRaw);
    } catch (err) {
      log(`公网地址不合法：${err?.message || err}`);
      return 2;
    }
  }

  const readOnly = flags.readOnly === true
    || /^(1|true|yes)$/i.test(String(process.env.NEXI_MCP_READONLY || ''));
  let token = typeof flags.token === 'string' ? String(flags.token).trim() : '';
  if (!token) token = String(process.env.NEXI_MCP_TOKEN || '').trim();
  const autoToken = !token && (!loopback || publicMode);
  if (autoToken) token = randomBytes(24).toString('base64url');

  const hub = await createHub(await hubOptionsFromEnv());
  const definitions = hub.list();
  if (!definitions.length) {
    await hub.close();
    log('没有可暴露的 MCP 工具，serve 没启动。');
    return 1;
  }

  let server = null;
  let tunnel = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (tunnel) {
      try { await tunnel.stop(); } catch { /* 清理失败不影响退出 */ }
      tunnel = null;
    }
    if (server) {
      try { await server.close(); } catch { /* 已经关闭 */ }
      server = null;
    }
    try { await hub.close(); } catch { /* 已经关闭 */ }
  };

  try {
    const { startMcpHttpServer } = await import('../lib/mcp/standalone.js');
    server = await startMcpHttpServer({
      definitions,
      host,
      port,
      token,
      readOnly,
      log: { info() {}, debug() {}, warn: log, error: log },
    });

    let publicBase = explicitPublic;
    if (publicMode) {
      const { startTunnel, verifyPublicHealth, tunnelInstallHint } = await import('../tools/nexi-tunnel.mjs');
      if (!explicitPublic) {
        tunnel = await startTunnel({
          provider: tunnelProvider,
          port: server.port,
          host: '127.0.0.1',
          timeoutMs: 90000,
          log: (m) => log(`  ${m}`),
        });
        if (!tunnel.ok) {
          log(`公网隧道没起来：${tunnel.reason || '未知原因'}`);
          for (const failure of Array.isArray(tunnel.failures) ? tunnel.failures : []) {
            log(`  · ${failure.provider}: ${failure.reason}`);
            if (failure.tail) log(`    ${String(failure.tail).split('\n').slice(-4).join('\n    ')}`);
          }
          log(tunnelInstallHint());
          await stop();
          return 1;
        }
        publicBase = tunnel.url;
      }
      const health = await verifyPublicHealth(publicBase, { timeoutMs: 30000 });
      if (!health.ok) {
        log(`公网入口不可达：${health.reason || publicBase}`);
        await stop();
        return 1;
      }
    }

    const localUrl = `${server.origin}/mcp`;
    print({
      ok: true,
      service: 'nexi-mcp',
      transport: 'streamable-http',
      localUrl,
      healthz: `${server.origin}/healthz`,
      endpointAliases: ['/mcp', '/v1/mcp', '/adbp/v1/mcp', '/adbp/mcp'],
      tools: definitions.length,
      readOnly,
      authRequired: Boolean(token),
      token: autoToken ? token : undefined,
      publicUrl: publicBase || undefined,
      publicMcpUrl: publicBase ? `${publicBase}/mcp` : undefined,
    });
    if (autoToken) {
      log('已自动生成 MCP token（公网模式必须鉴权）。客户端请带：Authorization: Bearer <上面的 token>');
    }
    if (publicBase) {
      log(`公网探活通过：${publicBase}/healthz`);
      log(`远程 MCP 填：${publicBase}/mcp`);
      log(`公网入口提供方：${tunnel?.provider || 'external'}；Ctrl+C 会一起关闭隧道。`);
    } else if (!loopback) {
      log(`服务已绑到 ${host}:${server.port}；别的设备用本机局域网地址访问 /mcp。`);
    }
    log('Ctrl+C 停止。');
  } catch (err) {
    log(`serve 启动失败：${err?.message || err}`);
    await stop();
    return 1;
  }

  await new Promise((done) => {
    const onSignal = () => { void stop().finally(done); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
  return 0;
}

async function cmdPet() {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'nexi-pet.mjs');
  const passthrough = rest.filter((a) => typeof a === 'string');
  return await new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...passthrough], { stdio: 'inherit' });
    child.on('close', (code) => done(typeof code === 'number' ? code : 0));
    child.on('error', (err) => {
      log(`桌宠起不来：${err?.message || err}`);
      done(1);
    });
  });
}

async function cmdVerifyHost() {
  const flags = parseFlags(rest);
  const ids = flags.all ? null : [flags._[0]].filter(Boolean);
  if (!flags.all && !ids.length) {
    print({ hint: 'nexi verify-host <host-id> 或 --all [--record]', hosts: HOSTS.map((h) => h.id) });
    return 0;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const launch = typeof flags.launchHome === 'string' ? stableLaunch(flags.launchHome) : undefined;
  const one = (id) => verifyHost(id, {
    stamp,
    dryRun: flags.dryRun,
    launch,
    timeoutMs: Number(process.env.NEXI_VERIFY_TIMEOUT_MS) || 120000,
  });
  const results = ids ? ids.map(one) : HOSTS.map((h) => one(h.id));
  const summary = summarize(results);
  const version = await readVersion();
  let evidence = '';
  if (flags.record) evidence = recordHostsEvidence(results, version);
  print({
    version,
    summary,
    evidence: evidence || '（没写证据文件；加 --record 才会写 docs/evidence/hosts-<版本>.txt）',
    results: results.map((r) => ({
      id: r.id,
      label: r.label,
      tier: r.tier,
      status: r.status,
      path: r.path,
      steps: (r.steps || []).map((s) => `=${s.ok ? 'ok' : 'fail'} ${s.name}: ${s.detail}`.replace(/^=/, '')),
    })),
  });
  return summary.failed > 0 ? 1 : 0;
}

/**
 * `nexi where` —— 宿主配置到底落在哪。
 *
 * 为什么要有这条命令：
 *   用户问「插件凭什么分电脑系统」。答案是：不分。产物只有一个包，
 *   三系统跑同一份代码；真正不一样的是**宿主自己把配置放在哪**。
 *   这条命令把那三张表一次打印出来，当前系统那列标 ←，不用靠嘴解释。
 */
function cmdWhere() {
  const flags = parseFlags(rest);
  const here = process.platform;
  // 非本机系统用占位家目录算（真机的 home 套到 macOS 上会拼出
  // `C://Users//x/Library/...` 这种四不像），展示时再缩成 ~。
  const HOME = { win32: 'C:////Users////you', darwin: '/Users/you', linux: '/home/you' };
  const ctx = {};
  for (const p of ['win32', 'darwin', 'linux']) {
    ctx[p] = p === here ? platformCtx() : platformCtx({ platform: p, home: HOME[p], env: {} });
  }
  const ctxHome = Object.fromEntries(['win32', 'darwin', 'linux'].map((p) => [p, ctx[p].home]));
  const tildify = (p, home) => {
    const sep = p === 'win32' ? '\\' : '/';
    return p.startsWith(home + sep) ? `~${sep}${p.slice(home.length + 1)}` : p;
  };
  const rows = HOSTS.map((h) => {
    const cell = (p) => tildify(h.paths(ctx[p])[0], ctxHome[p]);
    return { id: h.id, label: h.label, win32: cell('win32'), darwin: cell('darwin'), linux: cell('linux') };
  });
  if (flags.json) {
    print({ platform: here, package: 'agentdeck-super', sameArtifact: true, hosts: rows });
    return 0;
  }
  const lines = [];
  lines.push(`一个包，三个系统：agentdeck-super 用同一份代码跑，hosts 表只差「宿主把配置放哪」。`);
  lines.push(`本机：${here}（下面标 ← 的那列就是本机实际会写的路径）`);
  lines.push('');
  for (const r of rows) {
    lines.push(`${r.label}（${r.id}）`);
    for (const p of ['win32', 'darwin', 'linux']) {
      lines.push(`  ${p === here ? '←' : ' '} ${p.padEnd(6)} ${r[p]}`);
    }
  }
  lines.push('');
  lines.push('同一份安装包：npm i -g agentdeck-super / npx -y agentdeck-super@latest 在任何系统上都是同一条命令。');
  print(lines.join('\n'));
  return 0;
}

/**
 * `nexi host` —— 接入表的增删看。
 *
 * 为什么这是产品能力而不是开发者工具：
 *   Agent 出新的速度比我们发版快。用户手上那个 Agent 只要吃 MCP，
 *   就能用一条命令把它描述进来，从此 install/where/doctor 全都认它。
 */
/**
 * 接入表里"配置形状"这一列。JSON 宿主的形状就是它挂的 key；
 * YAML 宿主得区分开（`mcpServers` 在 JSON 里是对象、在 YAML 里是列表，不是一回事）。
 */
function hostShapeLabel(h) {
  if (h.kind === 'toml') return 'toml';
  if (h.kind === 'yaml') return `yaml/${String(h.shape || '').replace(/^yaml\./, '')}`;
  if (h.kind === 'auto') return 'yaml / json';
  return shapeKeyOf(h.id);
}

function cmdHost() {
  const sub = rest[0] || 'list';
  const flags = parseFlags(rest.slice(1));
  if (sub === 'list') {    const custom = loadCustomHosts();
    const rows = HOSTS.map((h) => {
      const ctx = undefined;
      const p = (h.paths(ctx) || [])[0] || '';
      const det = detectHosts().find((d) => d.id === h.id);
      return {
        id: h.id,
        label: h.label,
        source: h.source || (BUILTIN_HOSTS.includes(h) ? 'builtin' : 'custom'),
        shape: hostShapeLabel(h),
        installed: Boolean(det && det.installed),
        path: p,
        docs: h.docs || '',
        // 这条路径是怎么来的：官方文档核对过（docs）、本机真装过（verified）、
        // 还是社区约定（community）。用户有权知道自己信的是哪一档。
        confidence: h.confidence || 'docs',
      };
    });
    if (flags.json) {
      print({ dir: custom.dir, problems: [...HOST_REGISTRY_PROBLEMS, ...custom.problems], hosts: rows });
      return 0;
    }
    if (flags.md) {
      // 生成 markdown 表格：文档里的清单从这里出，避免手抄一份然后慢慢和代码分叉。
      // 路径缩成 `~`：这份表格会进公开文档，不该带上谁的家目录。
      const home = platformCtx().home;
      const appData = process.env.APPDATA || '';
      const tilde = (p) => {
        const s = String(p);
        // Windows 上 %APPDATA%\… 比 ~\AppData\Roaming\… 更认得出来
        if (appData && s.toLowerCase().startsWith(appData.toLowerCase())) return `%APPDATA%${s.slice(appData.length)}`;
        if (home && s.startsWith(home)) return `~${s.slice(home.length)}`;
        return s;
      };
      const conf = { verified: '本机实装', docs: '文档核对', community: '社区约定' };
      const lines = ['| 宿主 | id | 配置形状 | 依据 | 自定义 | 配置文件 | 官方文档 |', '| --- | --- | --- | --- | --- | --- | --- |'];
      for (const r of rows) {
        lines.push(`| ${r.label} | \`${r.id}\` | ${r.shape} | ${conf[r.confidence] || r.confidence} | ${r.source === 'custom' ? '是' : ''} | \`${tilde(r.path)}\` | ${r.docs || ''} |`);
      }
      print(lines.join('\n'));
      return 0;
    }
    const lines = [`接入表：${rows.length} 个（内置 ${BUILTIN_HOSTS.length} + 自定义 ${rows.length - BUILTIN_HOSTS.length}）`,
      `自定义目录：${custom.dir}（丢一份 JSON 进去就生效，不用发版）`,
      // 「依据」三档全标出来，包括最常见的那档 —— 只标异常档等于让人以为"没标的就是信得过"。
      `依据：✓ 本机已装 · [已实装] 真装过并核过写入 · [仅文档] 照官方文档写、没真装 · [社区约定] 推测`, ''];
    for (const r of rows) {
      const conf = r.confidence === 'community' ? '[社区约定] '
        : (r.confidence === 'verified' ? '[已实装] ' : '[仅文档] ');
      lines.push(`  ${r.installed ? '✓' : '·'} ${r.id.padEnd(16)} ${String(r.shape).padEnd(16)} ${r.source === 'custom' ? '[自定义] ' : ''}${conf}${r.path}`);
    }
    const problems = [...HOST_REGISTRY_PROBLEMS, ...custom.problems];
    if (problems.length) {
      lines.push('', '注册表里有文件没用上（不影响别的宿主）：');
      for (const p of problems) lines.push(`  · ${p.file}${p.id ? `（${p.id}）` : ''}：${p.error}`);
    }
    print(lines.join('\n'));
    return 0;
  }
  if (sub === 'add') {
    const id = flags._[0];
    const paths = flags._.slice(1).filter((p) => typeof p === 'string' && p.trim());
    if (!id || !paths.length) {
      print({ ok: false, hint: `用法：nexi host add <id> <配置文件路径…> [--label 名字] [--shape ${shapeKeys().join('|')}] [--kind json|toml|yaml] [--docs URL] [--cli 命令]` });
      return 2;
    }
    const res = saveCustomHost({
      id,
      label: flags.label || id,
      kind: flags.kind,
      shape: flags.shape || 'mcpServers',
      paths,
      docs: flags.docs || '',
      cli: flags.cli || '',
    });
    print(res.ok ? { ok: true, ...res, hint: `已记入接入表；跑 nexi install ${id} 就能写进它的配置` } : res);
    return res.ok ? 0 : 1;
  }
  if (sub === 'rm' || sub === 'remove') {
    const id = flags._[0];
    if (!id) return print({ ok: false, hint: '用法：nexi host rm <id>' }), 2;
    const res = removeCustomHost(id);
    print(res);
    return res.ok ? 0 : 1;
  }
  print({ ok: false, hint: `不认识的子命令：${sub}（可用 list / add / rm）` });
  return 2;
}

/**
 * `nexi snippet` —— 给「只能手动粘贴配置」的 Agent 一段现成 JSON/TOML。
 * 这是接入的最后一条兜底通道：只要对方支持 MCP，就一定能接上。
 */
function cmdSnippet() {
  const flags = parseFlags(rest);
  const shape = flags.shape || 'mcpServers';
  const toml = flags.toml === true || shape === 'toml' || flags.kind === 'toml';
  if (!toml && !shapeKeys().includes(shape)) {
    log(`shape 可选：${shapeKeys().join(' / ')} / toml`);
    return 2;
  }
  const text = buildSnippet({
    shape,
    toml,
    name: flags.name || 'nexi',
    launch: launchCommand({ portable: flags.portable === true }),
  });
  if (!text) return print({ ok: false, hint: '生成失败：shape 不认识' }), 2;
  if (flags.out) {
    writeFileSync(flags.out, text, 'utf8');
    print({ ok: true, out: flags.out, bytes: Buffer.byteLength(text) });
    return 0;
  }
  process.stdout.write(text);
  return 0;
}

function help() {
  print(`nexi —— Nexi 灵犀本地 Hub

用法：
  nexi mcp                    stdio 起 MCP 服务（写进宿主配置的就是这条）；--read-only 只给看不给改
  nexi serve                  独立 MCP HTTP 服务（默认 127.0.0.1:8790/mcp）
    --public-url <URL>       已有反代/隧道地址；必须真的能回源到本机
    --tunnel [auto|cloudflared|localtunnel]  自动起公网隧道并探活
    --public                 自动选择可用隧道（等同 --tunnel auto）
    --token <TOKEN>          公网/非回环地址必填；不填会自动生成并打印
  nexi list                   列出 Hub 工具
  nexi call <tool> [json]     直接调用一个工具
  nexi doctor                 体检（Node / Hub / 宿主探测）
    --export                  顺手导出诊断包（不含密钥与配置原文，可直接发出去）
    --out <目录>              诊断包放哪（默认当前目录）
  nexi setup                  固定目录安装 / 更新（默认写所有已探测宿主）
    --home <DIR>              安装根目录（默认 %LOCALAPPDATA%\Nexi）
    --bundle <tgz|URL>        从交付包安装（支持离线）
    --sha256 <HASH>           校验收到的安装包
    --no-hosts                只装文件，不改宿主配置（测试/预演）
    --dry-run                 只算计划，不落盘
  nexi update [--bundle ...]  有 npm 就拉最新版；未上架用 --bundle
    --check                   只问一句"有没有新版"（唯一会联网的入口，需显式调用）
  nexi rollback               切回上一版（宿主路径不变）
  nexi version                看当前固定目录版本和稳定启动器
  nexi config [host|--all]    直接给出接入配置，不需要装那个宿主（--out <文件> 写出来）
  nexi relay                  起跨机中继服务器（别的电脑靠它协作）
    --port <N>                端口（默认 8787）
    --token <TOKEN>           连接口令；不给会自动生成并打印
  nexi serve                  只跑 HTTP/MCP 服务，不起 Hub（给反向代理/容器用）
    --host <地址>             监听地址（默认 127.0.0.1）
    --port <N>                端口（默认 8790）
  nexi logs                   最近的运行日志（JSONL 落盘，按天轮转）
    --tail <N>                看最后 N 条（默认 30）
    --json                    原样输出 JSON 行（给 grep / jq）
    --dir                     只打印日志目录
    --clear                   清空日志
  nexi pair <host|guest|check|sync>  真机配对；状态在 <安装目录>/pair，升级不丢
  nexi where                  宿主配置在三个系统上分别落哪（一个包，不分系统）
  nexi host list|add|rm       接入表：任何吃 MCP 的 Agent 都能一条命令加进来（不用发版）
  nexi snippet [--shape X]    生成可直接粘贴的配置片段（mcpServers/servers/context_servers/mcp.servers/mcp.local/mcp.stdio/amp.mcpServers/yaml.extensions/yaml.mcpServers/toml）
  nexi install custom <文件> --shape X  装进任何未收录的 Agent
  nexi install <host>|--all   注册进宿主（--dry-run 只看差异）
  nexi uninstall <host>|--all 精确回滚
  nexi uninstall --self       把自己卸干净（宿主条目 + 安装目录 + 状态目录）
    --yes                     确认执行（不加只打印计划）
    --keep-state              保留授权 / 账本 / 任务板 / 宿主注册表
  nexi restore <host>         看这个宿主有哪些配置备份
    --last                    回滚到最近一份（回滚前会再备份一次，可撤销）
    --to <文件>               回滚到指定备份
    --dry-run                 只说要做什么
  nexi repair <host>|--all    清掉 nexi 在配置里留下的半截标记（install 拒绝写入时的出口）
    --dry-run                 只说要删什么，不动文件
  nexi verify-host <host>|--all  宿主认证：装→宿主自己确认→卸→配置逐字节还原（--record 写证据）
  nexi status                 一行状态
  nexi jobs                   看定时任务 / 待审批 / 最近执行
  nexi stop [原因]            全局停止：到点的任务一条都不跑（落盘，正在跑的宿主立刻生效）
  nexi resume                 恢复自动化
  nexi approve <审批号>       放行一条待审批（立刻执行那一次）
  nexi deny <审批号> [原因]   拒绝一条待审批
  nexi pet                    桌宠窗口（Ctrl+C 关闭；其余参数原样传给桌宠）
  nexi help [--md]            就是这一页；--md 输出成 Markdown 表格

宿主 id：${HOSTS.map((h) => h.id).join(', ')}`);
  return 0;
}

/**
 * `nexi <子命令> --help` 一律**只解释、不执行**。
 *
 * 这不是讲究，是止血：自检时 `nexi rollback --help` 真的把安装目录回滚到了上一个版本
 * （history.json 里留下一条 action:"rollback"），`nexi pet --help` 真弹了个桌宠窗口，
 * `nexi verify-host --help` 把 "--help" 当成宿主 id 去认证了一遍。
 * 在任何 CLI 里 --help 都该是只读的；一个带副作用的 --help 会让"先看看怎么用"变成事故。
 */
const helpAsked = rest.some((a) => a === '--help' || a === '-h');

const table = {
  mcp: cmdMcp,
  list: cmdList,
  call: cmdCall,
  doctor: cmdDoctor,
  setup: cmdSetup,
  update: cmdUpdate,
  rollback: cmdRollback,
  version: cmdVersion,
  pair: cmdPair,
  install: cmdInstall,
  where: cmdWhere,
  host: cmdHost,
  snippet: cmdSnippet,
  uninstall: cmdUninstall,
  restore: cmdRestore,
  logs: cmdLogs,
  'verify-host': cmdVerifyHost,
  status: cmdStatus,
  jobs: cmdJobs,
  stop: cmdStop,
  resume: cmdResume,
  approve: cmdApprove,
  deny: cmdDeny,
  pet: cmdPet,
  config: cmdConfig,
  repair: cmdRepair,
  relay: cmdRelay,
  serve: cmdServe,
  help,
  '--help': help,
  '-h': help,
};

/**
 * 拼错的子命令：给一个"最接近的那个"。
 * 为什么值得写：`nexi instal codex` 这种手滑，如果只是打一页帮助就退出 0，
 * 脚本/CI 会以为装成功了 —— 假成功比报错难查得多。
 */
function nearestCommand(input, names) {
  const s = String(input || '').toLowerCase();
  if (!s) return null;
  const dist = (a, b) => {
    const m = a.length; const n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i += 1) {
      const cur = [i];
      for (let j = 1; j <= n; j += 1) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  };
  let best = null;
  for (const name of names) {
    const d = dist(s, name);
    if (d <= Math.max(1, Math.floor(name.length / 3)) && (!best || d < best.d)) best = { name, d };
  }
  return best ? best.name : null;
}

const run = table[cmd] || (() => {
  const guess = nearestCommand(cmd, Object.keys(table).filter((k) => !k.startsWith('-')));
  log(`不认识子命令：${cmd}${guess ? `；你是想输 \`nexi ${guess}\` 吗？` : ''}`);
  // 顺手把帮助打出来：让人不用再猜一次（CLI 里 --help 是只读的，这里也一样）。
  help();
  // 但退出码必须是 2 —— 打一页帮助然后退出 0 会让脚本以为成功了，假成功比报错难查。
  return 2;
});

/** 日志里的参数：把密钥类值抹掉，其余原样（太长会在 log.js 里再截断）。 */
function sanitizeArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (/^--(token|sha256|secret)$/.test(a)) { out.push(a, '[已隐去]'); i += 1; continue; }
    out.push(a);
  }
  return out.slice(0, 8).join(' ');
}

const startedAt = Date.now();
let code;
try {
  if (helpAsked && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' && table[cmd]) {
    log(`nexi ${cmd}：带 --help，只显示帮助，没有执行任何动作。`);
    code = help();
  } else {
    code = await run();
  }
} catch (err) {
  // 崩了也要留一条：这是"用户说它坏了"时唯一能复盘的东西
  logEvent('error', 'cli', { cmd, args: sanitizeArgs(rest), error: String(err?.stack || err), version: readVersion() });
  throw err;
}
if (typeof code === 'number') process.exitCode = code;
// `--help` 不记日志：帮助是只读的（本文件的注释里已经把这条写死了），
// 而写日志要创建状态目录 —— 那会让"看一眼怎么用"在 home 里留下东西。
if (!helpAsked) {
  logEvent(code === 0 || code === undefined ? 'info' : 'warn', 'cli', {
    cmd,
    args: sanitizeArgs(rest),
    code: typeof code === 'number' ? code : 0,
    ms: Date.now() - startedAt,
    version: readVersion(),
  });
}
