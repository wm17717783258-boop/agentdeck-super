/**
 * tests/selfcheck-delta-persist.test.mjs —— 第 16 轮自检：增量同步不能"报成功但没落盘"
 *
 * 前 15 轮只验了记忆的增量。这轮盯三件事：
 *   ① 习惯 / 自动化 / 策略 推过来后，必须真的写进各自文件
 *   ② 记忆更新过（updatedAt 变新、at 没变）必须能推出去，不能永远漏
 *   ③ 不认识的 bucket 必须拒绝，不能算进 applied 假报成功
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { computeDelta, mergeDelta } from '../lib/sync/delta.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'adsk-delta-persist-'));
}

function writeJson(root, rel, value) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(root, rel) {
  const file = join(root, rel);
  assert.equal(existsSync(file), true, `文件没生成：${rel}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('习惯：对面推来的新确认项必须写进 habits.json（不能只报 applied）', () => {
  const root = tmpRoot();
  try {
    writeJson(root, '.agentdeck/twin/habits.json', {
      version: 1,
      updatedAt: 1000,
      confirmed: [{ key: 'other-habit', label: '本机已有的习惯', at: 1000, evidence: 2, confidence: 0.6 }],
      rejected: [],
    });

    const r = mergeDelta({
      root,
      changes: [{
        bucket: 'habits',
        id: 'morning-report',
        at: 5000,
        data: { key: 'morning-report', label: '每天早上写简报', at: 5000, evidence: 5, confidence: 0.8 },
      }],
    });

    assert.equal(r.ok, true, r.reason);
    const after = readJson(root, '.agentdeck/twin/habits.json');
    const hit = (after.confirmed || []).find((x) => x.key === 'morning-report');
    assert.equal(hit?.label, '每天早上写简报', `习惯没落盘：${JSON.stringify(after)}`);
    assert.ok((after.confirmed || []).some((x) => x.key === 'other-habit'), '本机原有习惯不能被冲掉');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('习惯：同一条两边都改过时进冲突，不静默覆盖人格', () => {
  const root = tmpRoot();
  try {
    writeJson(root, '.agentdeck/twin/habits.json', {
      version: 1,
      updatedAt: 1000,
      confirmed: [{ key: 'morning-report', label: '我这边的版本', at: 1000, evidence: 2, confidence: 0.6 }],
      rejected: [],
    });

    const r = mergeDelta({
      root,
      changes: [{
        bucket: 'habits',
        id: 'morning-report',
        at: 5000,
        data: { key: 'morning-report', label: '对面的版本', at: 5000, evidence: 5, confidence: 0.8 },
      }],
    });

    assert.equal(r.ok, true, r.reason);
    assert.equal(r.applied.length, 0, `习惯被静默覆盖了：${JSON.stringify(r)}`);
    assert.equal(r.conflicts.length, 1);
    const after = readJson(root, '.agentdeck/twin/habits.json');
    const hit = (after.confirmed || []).find((x) => x.key === 'morning-report');
    assert.equal(hit?.label, '我这边的版本', '冲突时本机版本必须保持不动');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自动化：对面推来的任务必须写进 automation/state.json', () => {
  const root = tmpRoot();
  try {
    writeJson(root, '.agentdeck/automation/state.json', { version: 1, jobs: [], approvals: [], runs: [] });

    const r = mergeDelta({
      root,
      changes: [{
        bucket: 'automation',
        id: 'job_remote_1',
        at: 5000,
        data: { id: 'job_remote_1', name: '每天 9 点汇总', enabled: true, updatedAt: 5000 },
      }],
    });

    assert.equal(r.ok, true, r.reason);
    const after = readJson(root, '.agentdeck/automation/state.json');
    assert.ok((after.jobs || []).some((x) => x.id === 'job_remote_1'),
      `自动化任务没落盘：${JSON.stringify(after)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('策略：对面推来的规则必须写进 policy.json', () => {
  const root = tmpRoot();
  try {
    writeJson(root, 'policy.json', { version: 1, rules: [] });

    const r = mergeDelta({
      root,
      changes: [{
        bucket: 'policy',
        id: 'rule_remote_1',
        at: 5000,
        data: { id: 'rule_remote_1', action: 'deny', tool: 'shell', updatedAt: 5000 },
      }],
    });

    assert.equal(r.ok, true, r.reason);
    const after = readJson(root, 'policy.json');
    assert.ok((after.rules || []).some((x) => x.id === 'rule_remote_1'),
      `策略规则没落盘：${JSON.stringify(after)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('增量：条目更新过（updatedAt 变新、at 没变）也必须被推出去', () => {
  const root = tmpRoot();
  try {
    writeJson(root, '.agentdeck/twin/memory.json', {
      version: 1,
      updatedAt: 5000,
      items: [{
        id: 'mem_updated',
        text: '改过的内容',
        type: 'event',
        at: 1000,
        createdAt: 1000,
        updatedAt: 5000,
      }],
    });

    const d = computeDelta({ root, since: 2000 });
    assert.equal(d.ok, true, d.reason);
    assert.ok(d.changes.some((x) => x.id === 'mem_updated'),
      `更新过的条目被游标漏掉了：${JSON.stringify(d.changes)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未知分区：必须跳过并给原因，不能算 applied', () => {
  const root = tmpRoot();
  try {
    const r = mergeDelta({
      root,
      changes: [{
        bucket: 'secrets',
        id: 'x',
        at: 5000,
        data: { id: 'x', payload: '不该被接受' },
      }],
    });

    assert.equal(r.ok, true, r.reason);
    assert.equal(r.applied.length, 0, `未知分区被当成已应用：${JSON.stringify(r)}`);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /不认识|不支持/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
