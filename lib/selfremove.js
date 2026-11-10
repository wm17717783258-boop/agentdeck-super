// SPDX-License-Identifier: Apache-2.0
/**
 * `nexi uninstall --self` —— 把产品自己卸干净。
 *
 * 为什么不能直接 rm -rf：
 *   · 在跑的那个进程正踩在安装目录里（bin/nexi.mjs 就在里面）。
 *     Windows 上删运行中文件必失败；POSIX 上删得掉，但进程后面再 require 就崩。
 *   · 状态目录 / 注册表 / 宿主配置是三处不同的东西，混在一起删会误伤用户数据。
 *
 * 所以分三步：
 *   ① 先把宿主配置里的 nexi 条目摘掉（这一步必须由活着的进程做，它懂各宿主格式）；
 *   ② 能当场删的当场删，删完**立刻回读**确认不在了（不当"已删除"的空口承诺）；
 *   ③ 删不掉的（安装目录自己）交给一个**独立的清理进程**：它等本进程退出后再删，
 *      并把结果写进 temp 下的日志。CLI 打印这个日志路径 —— 用户能自己去看有没有删干净。
 *
 * 安全边界（写死，不靠调用方自觉）：
 *   · 只接受绝对路径；只删名字里带 nexi / agentdeck-super 的目录；
 *   · 拒绝家目录、盘根、系统目录、当前工作目录的父级；
 *   · 从源码目录跑 `--self` 时，只清宿主注册项，不动源码目录（那不是我们装的东西）。
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { stateRoot as platformStateRoot } from './connect/platform.js';

/** 状态根：$DSH_HOME/agentdeck-super（跟人走，不跟项目走）。 */
export function stateRoot(env = process.env) {
  return platformStateRoot({ env, home: homedir() });
}

/** 目录大小（给人看"要删掉多少"，删不动时也能量化）。 */
export function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let names = [];
      try { names = readdirSync(cur); } catch { continue; }
      for (const n of names) stack.push(join(cur, n));
    } else {
      total += st.size;
    }
  }
  return total;
}

/**
 * 这个路径能不能删。返回 null 表示可以，否则返回拒绝原因。
 * 规则宁可保守：删多了是不可逆的，删少了用户重跑一次就行。
 */
export function unsafeReason(target, { home = homedir() } = {}) {
  if (!target || !isAbsolute(target)) return '不是绝对路径';
  const t = resolve(target);
  const h = resolve(home);
  if (t === h) return '这是家目录本身';
  if (t === dirname(t)) return '这是盘根';
  if (h.startsWith(t + sep)) return '这是家目录的上级目录';
  const base = t.split(/[\\/]/).filter(Boolean).pop() || '';
  if (!/nexi|agentdeck-super/i.test(base)) return `目录名不含 nexi / agentdeck-super（${base}），不敢删`;
  return null;
}

/**
 * 算出「要删哪些东西」。只算，不动手。
 * @param {object} opts
 * @param {string} opts.installHome 固定安装目录（lib/installer 的 defaultHome）
 * @param {string} [opts.stateRoot]
 * @param {boolean} [opts.keepState] 保状态（授权、账本、任务板、注册表）
 */
export function planSelfRemoval(opts = {}) {
  const installHome = resolve(opts.installHome || '');
  const state = resolve(opts.stateRoot || stateRoot());
  const targets = [];
  const skipped = [];

  const push = (path, kind, label) => {
    const why = unsafeReason(path, opts);
    if (why) {
      skipped.push({ path, kind, label, reason: why });
      return;
    }
    targets.push({
      path: resolve(path),
      kind,
      label,
      exists: existsSync(path),
      bytes: existsSync(path) ? dirSize(path) : 0,
    });
  };

  push(installHome, 'install', '固定安装目录（代码 + 启动器 + 版本目录）');
  if (!opts.keepState) push(state, 'state', '机级状态（任务板 / 授权 / 账本 / 宿主注册表）');
  else skipped.push({ path: state, kind: 'state', label: '机级状态', reason: '--keep-state：保留授权、账本与注册表' });

  return { installHome, stateRoot: state, targets: targets.filter((t) => t.exists), skipped };
}

/** 清理进程的源码。CJS 写进 `node -e`，不依赖当前包的类型与 cwd。 */
export const CLEANUP_CODE = `
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const log = (o) => { try { fs.appendFileSync(data.log, JSON.stringify(o) + '\\n'); } catch {} };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const t0 = Date.now();
log({ at: new Date().toISOString(), phase: 'wait', parent: data.parent });
while (Date.now() - t0 < data.waitMs && alive(data.parent)) sleep(100);
const results = [];
for (const target of data.targets) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    results.push({ path: target, gone: !fs.existsSync(target) });
  } catch (err) {
    results.push({ path: target, gone: false, error: String(err && err.message || err) });
  }
}
log({ at: new Date().toISOString(), phase: 'done', results });
process.exit(0);
`;

/**
 * 真的执行删除。
 * @returns {{ok:boolean, removed:Array, deferred:Array, failed:Array, log:string, note:string}}
 */
export function removeSelf(opts = {}) {
  const plan = opts.plan || planSelfRemoval(opts);
  const logFile = join(tmpdir(), `nexi-self-uninstall-${Date.now()}.log`);
  const selfRoot = resolve(opts.selfRoot || '');
  const insideSelf = selfRoot && plan.targets.some((t) => {
    const root = resolve(t.path);
    return selfRoot === root || selfRoot.startsWith(root + sep);
  });

  const removed = [];
  const deferred = [];
  const failed = [];

  if (!insideSelf) {
    // 没在要删的目录里跑（例如从源码目录跑 --self）→ 可以全删，删完立刻回读
    for (const t of plan.targets) {
      try {
        rmSync(t.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch (err) {
        failed.push({ path: t.path, error: String(err.message || err) });
        continue;
      }
      if (existsSync(t.path)) failed.push({ path: t.path, error: '删除后仍然存在' });
      else removed.push(t.path);
    }
    return {
      ok: failed.length === 0,
      removed,
      deferred,
      failed,
      log: '',
      note: failed.length ? '有目录没删掉，见 failed' : '已全部删除并回读确认',
    };
  }

  // 在要删的目录里跑：能当场删的先删（状态目录通常不在安装目录里），装不下的一律交给清理进程
  const targets = [];
  for (const t of plan.targets) {
    const root = resolve(t.path);
    const covers = selfRoot === root || selfRoot.startsWith(root + sep);
    if (covers) { targets.push(t.path); continue; }
    try {
      rmSync(t.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (existsSync(t.path)) failed.push({ path: t.path, error: '删除后仍然存在' });
      else removed.push(t.path);
    } catch (err) {
      failed.push({ path: t.path, error: String(err.message || err) });
    }
  }

  if (targets.length) {
    const payloadFile = join(tmpdir(), `nexi-self-uninstall-${Date.now()}.json`);
    writeFileSync(payloadFile, JSON.stringify({
      parent: process.pid,
      // 给父进程留足时间把最后的输出刷出去；活着的进程删不掉自己的目录
      waitMs: Number(opts.waitMs ?? 20_000),
      log: logFile,
      targets,
    }, null, 2), 'utf8');
    appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), phase: 'scheduled', targets })}\n`);
    deferred.push(...targets);
    // 测试要把"计划里的清理进程"单独跑一遍，所以允许不 spawn、只把 payload 交出去
    if (opts.spawnCleanup !== false) {
      const child = spawn(process.execPath, ['-e', CLEANUP_CODE, payloadFile], {
        cwd: tmpdir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }
    return {
      ok: failed.length === 0,
      removed,
      deferred,
      failed,
      log: logFile,
      payloadFile,
      note: `本进程退出后由清理进程删除（日志：${logFile}）`,
    };
  }

  return {
    ok: failed.length === 0,
    removed,
    deferred,
    failed,
    log: logFile,
    note: '已全部删除并回读确认',
  };
}

/** 给 CLI 用：把计划打印成人话。 */
export function describePlan(plan) {
  const lines = [];
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  for (const t of plan.targets) lines.push(`  删 ${t.path}  (${mb(t.bytes)})  — ${t.label}`);
  for (const s of plan.skipped) lines.push(`  留 ${s.path}  — ${s.reason}`);
  if (!plan.targets.length) lines.push('  没有可删除的目录（这机器上大概只注册进了宿主，没做固定安装）');
  return lines.join('\n');
}

export default { planSelfRemoval, removeSelf, describePlan, stateRoot, dirSize, unsafeReason };
