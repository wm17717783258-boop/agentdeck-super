/**
 * lib/connect/lock.js —— 跨进程互斥，保护"读-改-写"这一步。
 *
 * 为什么需要：宿主配置文件是**共享资源**。用户完全可能同时开着两个终端，
 * 一个 `nexi install --all`，另一个 `nexi install codex`；也可能编辑器里
 * 有个插件在我们写完之后立刻回写。没有锁的话两边各自读到旧内容、各自写回，
 * 后写的那个把先写的整段抹掉 —— 这类丢更新最难查，因为它不报错。
 *
 * 实现取最朴素也最可靠的一种：**O_EXCL 建锁文件**。
 * `wx` 是原子操作，三系统都成立，不需要 flock（Node 没有内置跨平台 flock）。
 * 锁里写 pid 与时间，超过 TTL 视为上一个进程已经死了（或崩了没清），允许抢占。
 *
 * 锁只包住落盘那一步（毫秒级），不包住"探测宿主"这种慢动作 ——
 * 否则 26 家全装时会自我串行化，慢得没法用。
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync, statSync } from 'node:fs';

export const LOCK_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const POLL_MS = 40;

function sleep(ms) {
  // 同步睡：这里在落盘临界区前，异步会让调用方全部染上 async。
  // Node 主线程允许 Atomics.wait；万一某个宿主把它禁了，退回忙等（最多几十毫秒）。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 兜底 */ }
  }
}

export function lockPathFor(target) {
  return `${target}.nexi.lock`;
}

/** 读锁内容；读不到或坏了返回 null（当作可以抢占）。 */
function readLock(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const info = JSON.parse(raw);
    if (!info || typeof info !== 'object') return null;
    return info;
  } catch {
    return null;
  }
}

function ageOf(file) {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 判断一个活着的 pid 是否真的还在跑（同机器）。跨机器不管 —— 那不是这个锁的职责。 */
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function tryAcquire(target, meta) {
  const file = lockPathFor(target);
  try {
    const fd = openSync(file, 'wx');
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...meta }));
    closeSync(fd);
    return { ok: true, file };
  } catch (err) {
    if (err.code !== 'EEXIST') return { ok: false, file, err };
    // 已经有人拿着：看是不是僵尸锁
    const info = readLock(file);
    const stale = ageOf(file) > LOCK_TTL_MS || (info && !pidAlive(info.pid));
    if (!stale) return { ok: false, file, held: info };
    // 抢占：先删再抢。两个进程同时抢时，只有一个能建成功，另一个下一轮重试。
    try { unlinkSync(file); } catch { /* 别人已经删了 */ }
    return { ok: false, file, stale: true };
  }
}

/**
 * 在 `target` 的保护下执行 fn。
 * 超时不是异常，而是返回 `{ ok:false, reason:'lock-timeout' }` ——
 * 调用方要能把「另一个 nexi 正在写这个文件」原样告诉用户，而不是抛栈。
 */
export function withFileLock(target, fn, opts = {}) {
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : DEFAULT_WAIT_MS;
  const meta = { host: opts.host || null, what: opts.what || 'write' };
  const deadline = Date.now() + waitMs;
  let last = null;

  for (;;) {
    const got = tryAcquire(target, meta);
    if (got.ok) {
      try {
        return { lock: 'acquired', value: fn(), file: got.file };
      } finally {
        try { unlinkSync(got.file); } catch { /* Windows 上偶发占用，留个僵尸锁也会被 TTL 清掉 */ }
      }
    }
    if (got.err) {
      // 目录不可写之类：不阻塞主流程，降级为无锁写（比"整个装不上"好）
      return { lock: 'unavailable', value: fn(), err: got.err };
    }
    last = got.held || null;
    if (Date.now() >= deadline) {
      return {
        lock: 'timeout',
        value: null,
        holder: last,
        reason: last && last.pid
          ? `另一个 nexi 进程（pid ${last.pid}）正在写这个文件，等了 ${waitMs}ms 还没放`
          : `锁文件被占用，等了 ${waitMs}ms`,
      };
    }
    sleep(POLL_MS);
  }
}

/** 给测试与 doctor 用：现在有没有人拿着某个配置的锁。 */
export function lockState(target) {
  const file = lockPathFor(target);
  if (!existsSync(file)) return { locked: false };
  const info = readLock(file);
  return { locked: true, info, ageMs: ageOf(file), stale: ageOf(file) > LOCK_TTL_MS };
}

export default { withFileLock, lockState, lockPathFor, LOCK_TTL_MS };
