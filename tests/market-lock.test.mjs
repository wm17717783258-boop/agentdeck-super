#!/usr/bin/env node
/**
 * 跨进程写账本的互斥：**这条测试用真进程**。
 *
 * 为什么不能用 Promise.all 假装并发：
 *   Node 是单线程，`readFileSync` / `writeFileSync` 是同步的，Promise.all 里的几个
 *   place/confirm 其实是一个接一个跑完的，中间不会交错 —— 于是"并发安全"会假绿。
 *   真实事故场景是两个宿主（Claude Code 和 Cursor 同时开着 nexi）各起一个进程，
 *   抢同一份 orders.json：两边都读到 5 单，各加 1 单再 rename，后写的覆盖先写的。
 *
 * 修复前的实测数字：3 进程 × 5 单 → 账本只剩 5 单、销售流水 2 条。
 * 修复后（lib/market/store.js 的 withFileLock）：一条不少。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMarketStore, acquireFileLock, marketPaths, LOCK_STALE_MS } from '../lib/market/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'fixtures', 'market-lock-child.mjs');

const makeRoot = () => mkdtempSync(join(tmpdir(), 'adsk-lock-'));

/** 开一个子进程往同一个 root 追加 count 条订单 */
function runChild(root, tag, count) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, root, tag, String(count)], {
      cwd: join(HERE, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('三个进程同时往同一账本追加：一条都不许丢', async () => {
  const root = makeRoot();
  try {
    const PER = 6;
    const PROCS = 3;
    const results = await Promise.all([0, 1, 2].map((i) => runChild(root, `p${i}`, PER)));
    for (const r of results) {
      assert.equal(r.code, 0, `子进程挂了：${r.err.slice(0, 300)}`);
    }
    const claimed = results.reduce((sum, r) => {
      try { return sum + Number(JSON.parse(r.out).written || 0); } catch { return sum; }
    }, 0);
    assert.equal(claimed, PROCS * PER, `子进程声称写了 ${claimed} 条，应为 ${PROCS * PER}`);

    const store = createMarketStore({ root });
    const n = store.readOrders().doc.orders.length;
    assert.equal(n, PROCS * PER,
      `账本里只有 ${n} 条，丢了 ${PROCS * PER - n} 条 —— 读-改-写没有互斥`);

    // 销售/订单内容也要真在盘上，不是只看计数
    const ids = new Set(store.readOrders().doc.orders.map((o) => o.id));
    for (let p = 0; p < PROCS; p += 1) {
      for (let i = 0; i < PER; i += 1) {
        assert.ok(ids.has(`ord_p${p}${String(i).padStart(6, '0')}`), `缺 ord_p${p}${i}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同一个进程里连续写：账本不撕裂、不留 .tmp、不留 .lock', () => {
  const root = makeRoot();
  try {
    const store = createMarketStore({ root });
    for (let i = 0; i < 20; i += 1) {
      const res = store.updateOrders((doc) => {
        doc.orders.push({
          id: `ord_seq${String(i).padStart(6, '0')}`,
          skinId: 'premium-aurora',
          amount: 1800,
          state: 'created',
          buyer: 'local',
        });
        return doc;
      });
      assert.equal(res.ok, true, `第 ${i + 1} 次写失败：${res.reason}`);
      assert.equal(store.readOrders().doc.orders.length, i + 1);
    }
    const paths = marketPaths(root);
    const dir = dirname(paths.ordersFile);
    // 目录里不该有 .tmp / .lock 残留
    const names = readdirSync(dir);
    assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), [], '留下 .tmp');
    assert.deepEqual(names.filter((n) => n.endsWith('.lock')), [], '留下 .lock（锁没释放）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('锁：拿不到就如实失败，不会硬写；陈旧锁会被抢走', () => {
  const root = makeRoot();
  try {
    const store = createMarketStore({ root });
    store.writeOrders({ v: 1, orders: [] }); // 确保目录存在
    const paths = marketPaths(root);
    const lockFile = `${paths.ordersFile}.lock`;

    // ① 别人持锁（模拟另一个进程正在写）→ 这次必须失败，且账本不动
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8');
    const blocked = store.updateOrders((doc) => {
      doc.orders.push({ id: 'ord_blocked1', skinId: 'premium-aurora', amount: 1800, state: 'created' });
      return doc;
    });
    assert.equal(blocked.ok, false, '锁被占着的时候不该写成功');
    assert.match(String(blocked.reason), /另一个进程|锁/, `失败原因要说清是锁：${blocked.reason}`);
    assert.equal(store.readOrders().doc.orders.length, 0, '被锁挡住的写不该改动账本');

    // ② 陈旧锁（进程崩了没删）→ 超过 staleMs 就该能抢过来
    const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
    utimesSync(lockFile, old, old);
    const stolen = store.updateOrders((doc) => {
      doc.orders.push({ id: 'ord_afterlock', skinId: 'premium-aurora', amount: 1800, state: 'created' });
      return doc;
    });
    assert.equal(stolen.ok, true, `陈旧锁应该被抢走，实际：${stolen.reason}`);
    assert.equal(store.readOrders().doc.orders.length, 1);

    // ③ 手动加锁/释放：释放后锁文件必须消失
    const got = acquireFileLock(paths.ordersFile);
    assert.equal(got.ok, true);
    assert.ok(existsSync(lockFile), '拿到锁应该有 .lock 文件');
    got.release();
    assert.equal(existsSync(lockFile), false, '释放后 .lock 必须删掉');
    got.release(); // 重复释放不该抛
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
