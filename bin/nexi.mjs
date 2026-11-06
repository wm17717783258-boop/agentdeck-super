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

function parseFlags(args) {
  const flags = { _: [] };
  for (const a of args) {
    if (a === '--all') flags.all = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--record') flags.record = true;
    else if (a === '--read-only' || a === '--readonly') flags.readOnly = true;
    else flags._.push(a);
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
  const opts = { dryRun: flags.dryRun, force: flags.force };
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
  // 目标文件从哪来，优先级写清楚（以前这里只认环境变量，命令行传的路径会被**静默丢掉**，
  // 结果就是"我明明指了别的文件，它却写了宿主真实配置"——真机上踩过，还污染了 4 个用户目录）：
  //   ① 命令行显式给的路径（第 2 个位置参数）
  //   ② 环境变量 NEXI_HOST_CONFIG
  //   ③ 宿主默认路径
  // 另外：宿主没装时，除非显式指定路径或加 --force，**不许**往它默认路径写配置——
  // 没装的宿主就该保持没装，不能因为我们install一下就在用户机器上留个文件。
  const explicit = typeof flags._[1] === 'string' && flags._[1].trim() ? flags._[1].trim() : '';
  const targetPath = explicit || process.env.NEXI_HOST_CONFIG || undefined;
  if (!targetPath && !opts.force) {
    const found = detectHosts().find((h) => h.id === target);
    if (found && !found.installed) {
      print({
        ok: false,
        code: 'host_not_installed',
        id: target,
        hint: `本机没装 ${found.label}，不往它的默认路径写配置。要真装请二者之一：① 显式给路径 nexi install ${target} <文件路径>；② 确认要写默认路径再加 --force。`,
        wouldWrite: found.path,
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
