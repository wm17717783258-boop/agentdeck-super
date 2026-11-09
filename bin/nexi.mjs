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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHub } from '../lib/hub.js';
import { serveStdio } from '../lib/mcp/server.js';
import { HOSTS, detectHosts, installHost, uninstallHost, installAll, launchCommand } from '../lib/connect/hosts.js';
import { verifyHost, recordHostsEvidence, summarize } from '../lib/connect/verify.js';
import { readVersion } from '../lib/version.js';
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
    else if (a === '--record') flags.record = true;
    else if (a === '--portable') flags.portable = true;
    else if (a === '--public') flags.public = true;
    else if (a === '--read-only' || a === '--readonly') flags.readOnly = true;
    else if (a === '--no-hosts') flags.noHosts = true;
    else if (a === '--dev') flags.dev = true;
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
    petRoot: process.env.NEXI_PET_ROOT || '',
    licenseRoot: process.env.NEXI_LICENSE_ROOT || '',
    onLog: log,
  };
}

/** 宿主配置文件里到底有没有 nexi —— 只看「宿主装没装」会漏掉最关键的一步。 */
function nexiRegistered(host) {
  if (!host || !host.installed || !host.path) return false;
  try {
    return /nexi/i.test(readFileSync(host.path, 'utf8'));
  } catch {
    return false;
  }
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
    const hub = await createHub(await hubOptionsFromEnv());
    tools = hub.list().map((t) => t.name);
  } catch (err) {
    hubErr = err.message;
  }

  const hosts = detectHosts().map((h) => ({ ...h, registered: nexiRegistered(h) }));
  const live = hosts.filter((h) => h.installed);
  const wired = live.filter((h) => h.registered);

  if (flags.json) {
    const checks = [];
    checks.push({ name: 'node', ok: nodeOk, detail: process.versions.node });
    checks.push({ name: 'nexi', ok: true, detail: version });
    checks.push({ name: 'hub', ok: tools.length > 0, detail: hubErr || `${tools.length} 个工具`, tools });
    checks.push({
      name: 'hosts',
      ok: true,
      detail: `${live.length}/${hosts.length} 已安装`,
      hosts: hosts.map((h) => ({ id: h.id, label: h.label, installed: h.installed, registered: h.registered, path: h.path })),
    });
    const launch = launchCommand();
    checks.push({ name: 'launch', ok: true, detail: `${launch.command} ${launch.args.join(' ')}` });
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
      lines.push(
        h.registered
          ? `  ✅ ${h.label}  已注册`
          : `  ❌ ${h.label}  宿主装了但没接上 → 跑 nexi install --all`,
      );
    }
    for (const h of hosts.filter((x) => !x.installed)) lines.push(`  ·  ${h.label}  没装，跳过`);
  }
  if (!flags.quick) {
    lines.push('');
    lines.push('③ 真能干活吗（在临时目录里试，不碰你的数据）');
    for (const f of fn) lines.push(`  ${f.ok ? '✅' : '❌'} ${f.key}  ${f.detail}`);
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
  lines.push(`│ 宿主 ${hosts.map((h) => `${h.id}=${h.installed ? (h.registered ? 'ok' : '未接') : '没装'}`).join(' ')}`);
  if (fn.length) lines.push(`│ 功能 ${fn.map((f) => `${f.key}=${f.ok ? 'ok' : '失败'}`).join(' ')}`);
  else lines.push('│ 功能 （--quick 跳过）');
  lines.push(`│ 结论 ${bad.length ? 'FAIL' : 'PASS'}`);
  lines.push('└────────────────────────────────');
  print(lines.join('\n'));
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
  const opts = { dryRun: flags.dryRun, force: flags.force, portable: flags.portable === true };
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
  const res = installHost(target, { ...opts, path: targetPath });
  print(res);
  return res.ok ? 0 : 1;
}

async function cmdUninstall() {
  const flags = parseFlags(rest);
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
  const res = uninstallHost(target, { dryRun: flags.dryRun, path: targetPath });
  print(res);
  return res.ok ? 0 : 1;
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
    print(text);
    return /❌|失败|写盘失败|不认识|没有这个/.test(text) ? 1 : 0;
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
    if (!r.ok) {
      results.push({ id, label: host.label, ok: false, reason: r.reason || '生成失败', warnings: r.warnings });
      continue;
    }
    const rec = {
      id,
      label: host.label,
      kind: host.kind,
      ok: true,
      defaultPath: host.paths()[0],
      // 本机装没装，只影响"要不要顺手写进去"，不影响能不能生成
      installedLocally: detectHosts().find((h) => h.id === id)?.installed === true,
      config: r.preview,
    };
    // 显式要写文件才写（--out），否则只打印
    if (out) {
      const file = ids.length > 1 ? out.replace(/\.json$|\.toml$/i, '') + `-${id}` + (host.kind === 'toml' ? '.toml' : '.json') : out;
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
  nexi setup                  固定目录安装 / 更新（默认写所有已探测宿主）
    --home <DIR>              安装根目录（默认 %LOCALAPPDATA%\Nexi）
    --bundle <tgz|URL>        从交付包安装（支持离线）
    --sha256 <HASH>           校验收到的安装包
    --no-hosts                只装文件，不改宿主配置（测试/预演）
    --dry-run                 只算计划，不落盘
  nexi update [--bundle ...]  有 npm 就拉最新版；未上架用 --bundle
  nexi rollback               切回上一版（宿主路径不变）
  nexi version                看当前固定目录版本和稳定启动器
  nexi pair <host|guest|check|sync>  真机配对；状态在 <安装目录>/pair，升级不丢
  nexi install <host>|--all   注册进宿主（--dry-run 只看差异）
  nexi uninstall <host>|--all 精确回滚
  nexi verify-host <host>|--all  宿主认证：装→宿主自己确认→卸→配置逐字节还原（--record 写证据）
  nexi status                 一行状态
  nexi jobs                   看定时任务 / 待审批 / 最近执行
  nexi stop [原因]            全局停止：到点的任务一条都不跑（落盘，正在跑的宿主立刻生效）
  nexi resume                 恢复自动化
  nexi approve <审批号>       放行一条待审批（立刻执行那一次）
  nexi deny <审批号> [原因]   拒绝一条待审批

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
  uninstall: cmdUninstall,
  'verify-host': cmdVerifyHost,
  status: cmdStatus,
  jobs: cmdJobs,
  stop: cmdStop,
  resume: cmdResume,
  approve: cmdApprove,
  deny: cmdDeny,
  pet: cmdPet,
  config: cmdConfig,
  relay: cmdRelay,
  serve: cmdServe,
  help,
  '--help': help,
  '-h': help,
};

const run = table[cmd] || (() => {
  log(`不认识子命令：${cmd}`);
  return help();
});

let code;
if (helpAsked && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' && table[cmd]) {
  log(`nexi ${cmd}：带 --help，只显示帮助，没有执行任何动作。`);
  code = help();
} else {
  code = await run();
}
if (typeof code === 'number') process.exitCode = code;
