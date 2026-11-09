/**
 * tests/selfcheck-writefail.test.mjs —— 自检第 14 轮补：写盘失败必须如实报
 *
 * 第 14 轮抓到一个真 bug：把 `.agentdeck/twin` 换成文件后，`remember()` 抛 EEXIST。
 * 修完之后顺手把**同一类问题**（写失败却报成功 / 抛异常）在其它模块上也扫一遍。
 *
 * 判定：
 *   · 绝不抛异常给调用方
 *   · 写不进去时必须是 ok:false（不能假报成功）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { remember, writeMemory, forget } from '../lib/twin/memory.js';
import { writeCursor } from '../lib/sync/delta.js';
import { saveState as saveAutomation } from '../lib/automation/store.js';
import { savePolicy } from '../lib/policy/engine.js';

/**
 * 造一个"写不进去"的工作区：把目标目录的位置用一个**文件**占住，
 * 这样 mkdirSync(recursive) 会 EEXIST、写文件会 ENOTDIR。
 */
function makeBlockedRoot(blockPath) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-blocked-'));
  const parts = blockPath.split('/');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = join(cur, parts[i]);
    mkdirSync(cur, { recursive: true });
  }
  // 最后一个组件：用文件占位
  writeFileSync(join(cur, parts[parts.length - 1]), '我是文件，不是目录', 'utf8');
  return root;
}

test('自检 14b：记忆写盘失败 → ok:false，不抛异常', () => {
  const root = makeBlockedRoot('.agentdeck/twin');
  try {
    for (const fn of [
      () => writeMemory(root, { items: [] }),
      () => remember(root, { content: 'x', type: 'event' }, { now: () => 1800000000000 }),
    ]) {
      let out;
      try {
        out = fn();
      } catch (err) {
        assert.fail(`不该抛异常：${err?.message || err}`);
      }
      assert.equal(out.ok, false, `写不进去应 ok:false，实际 ${JSON.stringify(out)?.slice(0, 150)}`);
      assert.ok(typeof out.reason === 'string' && out.reason.length > 0, '失败要给原因');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14b：同步游标写盘失败 → ok:false，不抛', () => {
  const root = makeBlockedRoot('.agentdeck');
  try {
    let out;
    try {
      out = writeCursor(root, { pushCursor: 1, peerCursor: 2 });
    } catch (err) {
      assert.fail(`不该抛异常：${err?.message || err}`);
    }
    assert.equal(out.ok, false, `写不进去应 ok:false：${JSON.stringify(out)}`);
    assert.ok(out.reason, '要给原因');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14b：自动化状态写盘失败 → ok:false，不抛', () => {
  const root = makeBlockedRoot('.agentdeck/automation');
  try {
    let out;
    try {
      out = saveAutomation({ root, state: { jobs: [] } });
    } catch (err) {
      assert.fail(`不该抛异常：${err?.message || err}`);
    }
    assert.equal(out.ok, false, `写不进去应 ok:false：${JSON.stringify(out)?.slice(0, 150)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14b：策略写盘失败 → ok:false，不抛', () => {
  // 策略写在 <root>/policy.json，用目录占名字让它写不进去
  const root = mkdtempSync(join(tmpdir(), 'adsk-blocked-pol-'));
  try {
    mkdirSync(join(root, 'policy.json'), { recursive: true });
    let out;
    try {
      out = savePolicy(root, { rules: [] });
    } catch (err) {
      assert.fail(`不该抛异常：${err?.message || err}`);
    }
    assert.equal(out.ok, false, `写不进去应 ok:false：${JSON.stringify(out)?.slice(0, 150)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14b：忘掉一条时写盘失败也不假报成功', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-blocked-forget-'));
  try {
    // 先正常写一条
    const w = remember(root, { content: '待删', type: 'event' }, { now: () => 1800000000000 });
    assert.ok(w?.ok !== false, '先应能正常写');

    // 然后把 twin 目录换成文件（模拟磁盘故障）
    const twinDir = join(root, '.agentdeck', 'twin');
    rmSync(twinDir, { recursive: true, force: true });
    writeFileSync(twinDir, '挡住了', 'utf8');

    let out;
    try {
      out = forget(root, { id: w.item?.id });
    } catch (err) {
      assert.fail(`不该抛异常：${err?.message || err}`);
    }
    // 要么说没删到，要么说写失败；总之不能假报成功
    const claimedSuccess = out?.ok === true && Number(out.removed) > 0;
    assert.equal(claimedSuccess, false, `写不进去却说删成功了：${JSON.stringify(out)?.slice(0, 150)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

