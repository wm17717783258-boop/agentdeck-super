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

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHub } from '../lib/hub.js';
import { serveStdio } from '../lib/mcp/server.js';
import { HOSTS, detectHosts, installHost, uninstallHost, installAll, launchCommand } from '../lib/connect/hosts.js';
import { verifyHost, recordHostsEvidence, summarize } from '../lib/connect/verify.js';
import { readVersion } from '../lib/version.js';

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
const VALUE_FLAGS = { out: 'out' };

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--all') flags.all = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--record') flags.record = true;
    else if (a === '--portable') flags.portable = true;
    else if (a === '--read-only' || a === '--readonly') flags.readOnly = true;
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

async function cmdDoctor() {
  const checks = [];
  const version = await readVersion();
  checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.versions.node });
  checks.push({ name: 'nexi', ok: true, detail: version });

  let hub = null;
  try {
    hub = await createHub(await hubOptionsFromEnv());
    const tools = hub.list().map((t) => t.name);
    checks.push({ name: 'hub', ok: tools.length > 0, detail: `${tools.length} 个工具`, tools });
  } catch (err) {
    checks.push({ name: 'hub', ok: false, detail: err.message });
  }

  const hosts = detectHosts();
  checks.push({
    name: 'hosts',
    ok: true,
    detail: `${hosts.filter((h) => h.installed).length}/${hosts.length} 已安装`,
    hosts: hosts.map((h) => ({ id: h.id, label: h.label, installed: h.installed, path: h.path })),
  });

  const launch = launchCommand();
  checks.push({ name: 'launch', ok: true, detail: `${launch.command} ${launch.args.join(' ')}` });

  print({ ok: checks.every((c) => c.ok), checks });
  return checks.every((c) => c.ok) ? 0 : 1;
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
    // 关键：用 dry-run 拿配置文本，绝不落盘到宿主目录
    const r = installHost(id, { dryRun: true, force: true });
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
  const one = (id) => verifyHost(id, { stamp, dryRun: flags.dryRun, timeoutMs: Number(process.env.NEXI_VERIFY_TIMEOUT_MS) || 120000 });
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
  nexi list                   列出 Hub 工具
  nexi call <tool> [json]     直接调用一个工具
  nexi doctor                 体检（Node / Hub / 宿主探测）
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

const table = {
  mcp: cmdMcp,
  list: cmdList,
  call: cmdCall,
  doctor: cmdDoctor,
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
  help,
  '--help': help,
  '-h': help,
};

const run = table[cmd] || (() => {
  log(`不认识子命令：${cmd}`);
  return help();
});

const code = await run();
if (typeof code === 'number') process.exitCode = code;
