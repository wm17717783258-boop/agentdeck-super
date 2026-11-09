#!/usr/bin/env node
/**
 * tools/nexi-daemon.mjs —— 分身常驻守护进程
 *
 * 解决什么：`deck_automation` 的定时器挂在 DSH 插件进程里，宿主一关就停。
 *   "24 小时替主人干活" 的前提是有一个**不依赖宿主常驻**的东西在跑。
 *   这个守护进程就是它：脱离宿主，自己跑自动化巡检 + 记忆整理 + 房间同步。
 *
 * 它复用 lib 里已经验收过的能力，一行业务逻辑都不重写：
 *   - lib/automation/runner.js 的 createRunner + startTicker（每 30 秒巡检一次）
 *   - lib/hub.js 的 createHub（拿到完整 23 个工具，和宿主里是同一套）
 *   - lib/twin/mandate.js（自主行动前查执照）
 *
 * 用法：
 *   node tools/nexi-daemon.mjs                          # 前台跑（Ctrl-C 停）
 *   node tools/nexi-daemon.mjs --workspace D:\proj     # 指定工作区
 *   node tools/nexi-daemon.mjs --once                  # 只巡检一次就退出（给自己验活用）
 *   node tools/nexi-daemon.mjs --status                # 看当前状态，不启动
 *   node tools/nexi-daemon.mjs --install-tasks         # 生成 Windows 计划任务命令（不自动执行）
 *
 * 约定：
 *   - 诊断信息全走 stderr，stdout 只给结构化状态（和 bin/nexi.mjs 一致）
 *   - 状态文件 <workspace>/.agentdeck/daemon.json：pid / 启动时间 / 每轮结果
 *   - 单轮失败不退出（下轮继续）；只有启动阶段失败才退出码 1
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHub } from '../lib/hub.js';
import { createRunner, startTicker } from '../lib/automation/runner.js';
import { loadState } from '../lib/automation/store.js';
import { mandateSummary } from '../lib/twin/mandate.js';
import { readVersion } from '../lib/version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

const argv = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const log = (msg) => process.stderr.write(`[nexi-daemon] ${msg}\n`);

/**
 * 工具返回的是 MCP content 块（[{type:'text',text}]），这里抠出里头那层 JSON。
 * 抠不出来就返回 null —— 调用方（自动化 runner）会当成"没接住"如实报错，
 * 不会因为解析失败而误判任务已经落板。
 */
function parseToolJson(blocks) {
  try {
    const text = Array.isArray(blocks)
      ? blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
      : String(blocks ?? '');
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const start = cleaned.indexOf('{');
    const startArr = cleaned.indexOf('[');
    const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
    if (from === -1) return null;
    const slice = cleaned.slice(from);
    // 括号平衡扫描：跳过字符串与转义，避免把任务标题里的花括号当结构。
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < slice.length; i += 1) {
      const ch = slice[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return JSON.parse(slice.slice(0, i + 1));
      }
    }
    return null;
  } catch {
    return null;
  }
}
const print = (obj) => process.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)}\n`);

const workspace = resolve(String(flag('--workspace', process.env.NEXI_WORKSPACE || process.cwd())));
const tickMs = Math.max(5000, Number(flag('--tick-ms', 30000)) || 30000);

function daemonStateFile() {
  return join(workspace, '.agentdeck', 'daemon.json');
}

function readDaemonState() {
  const file = daemonStateFile();
  try {
    if (!existsSync(file)) return { v: 1, pid: 0, startedAt: '', ticks: 0, lastTickAt: '', lastResult: null };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return {
      v: 1,
      pid: Number(raw?.pid) || 0,
      startedAt: String(raw?.startedAt || ''),
      ticks: Number(raw?.ticks) || 0,
      lastTickAt: String(raw?.lastTickAt || ''),
      lastResult: raw?.lastResult ?? null,
    };
  } catch {
    return { v: 1, pid: 0, startedAt: '', ticks: 0, lastTickAt: '', lastResult: null };
  }
}

function writeDaemonState(patch) {
  const file = daemonStateFile();
  const next = { ...readDaemonState(), ...patch, updatedAt: new Date().toISOString() };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** 进程还活着吗（Windows 用 tasklist，其它平台用 kill -0 的等价物）。 */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── --status：看状态，不启动 ────────────────────────────────────────────

async function cmdStatus() {
  const state = readDaemonState();
  const alive = pidAlive(state.pid);
  const version = await readVersion();
  let automation = { ok: false };
  try {
    const loaded = loadState({ root: workspace });
    const jobs = loaded?.state?.jobs || [];
    automation = {
      ok: Boolean(loaded?.ok),
      jobs: jobs.length,
      enabled: jobs.filter((j) => j.enabled).length,
      stopped: Boolean(loaded?.state?.stopped),
      pending: (loaded?.state?.approvals || []).filter((a) => a.status === 'pending').length,
    };
  } catch (err) {
    automation = { ok: false, error: String(err?.message || err) };
  }

  let mandate = { hasActive: false };
  try {
    mandate = mandateSummary(workspace);
  } catch (err) {
    mandate = { hasActive: false, error: String(err?.message || err) };
  }

  const payload = {
    ok: true,
    version,
    workspace,
    daemon: {
      running: alive,
      pid: state.pid,
      startedAt: state.startedAt,
      ticks: state.ticks,
      lastTickAt: state.lastTickAt,
      stale: Boolean(state.pid) && !alive,
    },
    automation,
    mandate: {
      hasActive: mandate.hasActive,
      id: mandate.id,
      tools: mandate.tools?.length ?? 0,
      perDay: mandate.perDay ?? null,
      windows: mandate.windows || [],
      insideWindow: mandate.insideWindow !== false,
      expiresAt: mandate.expiresAt || 0,
      // 没执照时守护进程其实"干不了自主活"——状态里要说清楚，不能让用户以为它在跑。
      autonomousReady: Boolean(mandate.hasActive) && mandate.insideWindow !== false,
    },
    stateFile: daemonStateFile(),
  };
  print(payload);
  return 0;
}

// ── --install-tasks：只生成命令，不替用户改系统 ──────────────────────────

function cmdInstallTasks() {
  const nodePath = process.execPath;
  const script = join(PKG, 'tools', 'nexi-daemon.mjs');
  const logFile = join(workspace, '.agentdeck', 'daemon.log');
  const lines = [
    '下面这些命令是给你自己执行的（本脚本绝不代改系统）：',
    '',
    '# 1) 登录时自启（Windows 计划任务，最省事）',
    `schtasks /Create /TN "NexiTwinDaemon" /SC ONLOGON /RL LIMITED /TR "\\"${nodePath}\\" \\"${script}\\" --workspace \\"${workspace}\\" >> \\"${logFile}\\" 2>&1"`,
    '',
    '# 2) 立即跑一次',
    `schtasks /Run /TN "NexiTwinDaemon"`,
    '',
    '# 3) 不想用了，删掉（可回滚）',
    `schtasks /Delete /TN "NexiTwinDaemon" /F`,
    '',
    '# Linux/macOS 用这个（写进 crontab -e 也行）',
    `# @reboot ${nodePath} ${script} --workspace ${workspace} >> ${logFile} 2>&1`,
    '',
    '验证：node tools/nexi-daemon.mjs --status',
  ];
  print(lines.join('\n'));
  return 0;
}

// ── 主循环 ──────────────────────────────────────────────────────────────

async function main() {
  if (argv.includes('--status')) return cmdStatus();
  if (argv.includes('--install-tasks')) return cmdInstallTasks();

  const version = await readVersion();
  log(`Nexi 灵犀 分身守护 v${version}`);
  log(`工作区：${workspace}`);
  log(`巡检间隔：${tickMs}ms`);

  // 启动阶段：把 Hub 建起来。建不起来是硬伤，直接退 1（让计划任务能看见失败）。
  let hub;
  try {
    hub = await createHub({ workspace, onLog: log });
    const names = hub.list().map((t) => t.name);
    log(`Hub 就绪：${names.length} 个工具`);
  } catch (err) {
    log(`Hub 起不来，守护退出：${err?.message || err}`);
    return 1;
  }

  // 自动化 runner 的 deps：走 hub.call 转发到工具，这样守护进程和宿主用的是**同一套**
  // 业务逻辑（不复制一份）。runAgent 在纯 CLI 形态下没有宿主可借，留空 —— runner
  // 遇到 action:'agent' 会如实说"宿主没有派活能力"，而不是假装跑了。
  const deps = {
    board: {
      // autonomous:true —— 这两次调用是**分身自己**发起的，必须过执照闸门。
      // 不带这个标记就等于"主人亲自调"，会把执照限制绕过去（那正是它要防的事）。
      listTeams: async () => parseToolJson(await hub.call('team_board', { action: 'list', autonomous: true })),
      addTask: async (teamId, task) => parseToolJson(await hub.call('team_board', { action: 'add', teamId, autonomous: true, ...task })),
    },
    runAgent: null,
    fetch: globalThis.fetch,
  };

  const runner = createRunner({ root: workspace, deps, log });
  const stopTicker = startTicker({ runner, tickMs, log });

  writeDaemonState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    workspace,
    version,
    tickMs,
    lastResult: null,
  });

  /** 每轮把结果写回 daemon.json，--status 才看得到"最近一次跑了什么"。 */
  async function tickOnce() {
    let result;
    try {
      result = await runner.tick();
    } catch (err) {
      result = { ok: false, error: String(err?.message || err) };
    }
    const state = readDaemonState();
    writeDaemonState({
      ticks: state.ticks + 1,
      lastTickAt: new Date().toISOString(),
      lastResult: {
        ok: Boolean(result?.ok),
        executed: result?.executed?.length ?? 0,
        queued: result?.queued?.length ?? 0,
        skipped: result?.skipped ?? null,
        error: result?.error || '',
      },
    });
    return result;
  }

  if (argv.includes('--once')) {
    const result = await tickOnce();
    stopTicker();
    print({ ok: Boolean(result?.ok), once: true, workspace, result });
    return result?.ok === false ? 1 : 0;
  }

  // 常驻：自己再挂一个比 startTicker 更粗的记账心跳（30s 一轮，写 daemon.json）
  const heartbeat = setInterval(() => { void tickOnce(); }, tickMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  log('守护已启动。Ctrl-C 停止。');
  print({ ok: true, running: true, pid: process.pid, workspace, tickMs, stateFile: daemonStateFile() });

  const shutdown = (signal) => {
    log(`收到 ${signal}，正在停止…`);
    try { stopTicker(); } catch { /* 已经停了 */ }
    try { clearInterval(heartbeat); } catch { /* 同上 */ }
    writeDaemonState({ pid: 0, stoppedAt: new Date().toISOString() });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 常驻进程：不给事件循环留退出条件，靠信号停
  await new Promise(() => {});
  return 0;
}

main()
  .then((code) => { process.exitCode = Number(code) || 0; })
  .catch((err) => {
    log(`守护异常退出：${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  });
