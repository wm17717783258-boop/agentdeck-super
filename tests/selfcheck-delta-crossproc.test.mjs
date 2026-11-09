/**
 * tests/selfcheck-delta-crossproc.test.mjs —— 第 17 轮自检：两个独立进程的增量同步
 *
 * 单进程测试证明不了落盘。这轮用两个真进程 + 两个独立工作区：
 *   A 推送 → 载荷写文件 → B 合并 → 用 B 自己的模块读回来。
 * 覆盖记忆之外的习惯 / 自动化 / 策略，并验证冲突对象能原样解决。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const href = (rel) => `file:///${join(PKG, rel).replace(/\\/g, '/')}`;

function runIn(root, body) {
  const file = join(root, `.step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.mjs`);
  const src = String(body)
    .split('__DELTA__').join(href('lib/sync/delta.js'))
    .split('__MEM__').join(href('lib/twin/memory.js'))
    .split('__CTX__').join(href('lib/twin/context.js'))
    .split('__AUTO__').join(href('lib/automation/store.js'))
    .split('__POLICY__').join(href('lib/policy/engine.js'));
  writeFileSync(file, src, 'utf8');
  const r = spawnSync(process.execPath, [file], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let parsed = null;
  try { parsed = JSON.parse(lines[lines.length - 1] || 'null'); } catch { /* 失败时下面报 */ }
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json: parsed };
}

test('跨进程：记忆/习惯/自动化/策略四类变化都能推到另一台并真读回来', () => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-delta-x-'));
  const rootA = join(base, 'A');
  const rootB = join(base, 'B');
  const wire = join(base, 'wire.json');
  try {
    const a = runIn(base, `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { remember } from '__MEM__';
      import { syncOnce } from '__DELTA__';

      const ROOT = ${JSON.stringify(rootA)};
      mkdirSync(join(ROOT, '.agentdeck', 'twin'), { recursive: true });
      mkdirSync(join(ROOT, '.agentdeck', 'automation'), { recursive: true });

      const mem = remember(ROOT, { content: '跨进程同步的记忆', type: 'event' }, { now: () => 5000 });
      if (mem?.ok === false) { console.error('写记忆失败', JSON.stringify(mem)); process.exit(1); }

      writeFileSync(join(ROOT, '.agentdeck', 'twin', 'habits.json'), JSON.stringify({
        version: 1, updatedAt: 5000, rejected: [],
        confirmed: [{ key: 'e2e-habit', label: '每天写简报', at: 5000, evidence: 3, confidence: 0.7 }],
      }, null, 2));

      writeFileSync(join(ROOT, '.agentdeck', 'automation', 'state.json'), JSON.stringify({
        version: 1, approvals: [], runs: [],
        jobs: [{ id: 'job_e2e', name: '每日汇总', enabled: true, updatedAt: 5000 }],
      }, null, 2));

      writeFileSync(join(ROOT, 'policy.json'), JSON.stringify({
        version: 1,
        rules: [{ id: 'rule_e2e', match: { tool: 'shell' }, effect: 'deny', updatedAt: 5000 }],
      }, null, 2));

      const rep = syncOnce({ root: ROOT });
      if (!rep.ok) { console.error('A 同步失败', rep.reason); process.exit(1); }
      writeFileSync(${JSON.stringify(wire)}, JSON.stringify(rep.pushed), 'utf8');
      console.log(JSON.stringify({ pushed: rep.pushedCount, buckets: rep.pushed.map((x) => x.bucket) }));
    `);
    assert.equal(a.status, 0, `A 进程失败：${a.out}\n${a.err}`);
    assert.ok(a.json?.pushed >= 4, `A 应至少推出 4 条：${JSON.stringify(a.json)}`);

    const b = runIn(base, `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { recall } from '__MEM__';
      import { readHabits } from '__CTX__';
      import { loadState } from '__AUTO__';
      import { loadPolicy } from '__POLICY__';
      import { syncOnce } from '__DELTA__';

      const ROOT = ${JSON.stringify(rootB)};
      mkdirSync(ROOT, { recursive: true });
      const incoming = JSON.parse(readFileSync(${JSON.stringify(wire)}, 'utf8'));
      const rep = syncOnce({ root: ROOT, incoming });
      if (!rep.ok) { console.error('B 合并失败', rep.reason); process.exit(1); }

      const said = recall(ROOT, { query: '跨进程同步' }, { now: () => 5001 });
      const habits = readHabits(ROOT).habits;
      const auto = loadState({ root: ROOT }).state;
      const pol = loadPolicy(ROOT).policy;

      console.log(JSON.stringify({
        applied: rep.appliedCount,
        conflicts: rep.conflicts.length,
        memoryHit: (said?.items || []).some((x) => String(x.text || '').includes('跨进程同步')),
        habitHit: (habits.confirmed || []).some((x) => x.key === 'e2e-habit'),
        jobHit: (auto.jobs || []).some((x) => x.id === 'job_e2e'),
        ruleHit: (pol?.rules || []).some((x) => x.id === 'rule_e2e'),
      }));
    `);
    assert.equal(b.status, 0, `B 进程失败：${b.out}\n${b.err}`);
    assert.ok(b.json?.applied >= 4, `B 应合进至少 4 条：${JSON.stringify(b.json)}`);
    assert.equal(b.json.memoryHit, true, 'B 应能召回同步来的记忆');
    assert.equal(b.json.habitHit, true, 'B 应能读出同步来的习惯');
    assert.equal(b.json.jobHit, true, 'B 应能读出同步来的自动化任务');
    assert.equal(b.json.ruleHit, true, 'B 应能读出同步来的策略规则');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('跨进程冲突：冲突对象原样回传就能解决，不重复、不写错分区', () => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-delta-xc-'));
  const rootA = join(base, 'A');
  const rootB = join(base, 'B');
  const wire = join(base, 'wire.json');
  try {
    const a = runIn(base, `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { syncOnce } from '__DELTA__';

      const ROOT = ${JSON.stringify(rootA)};
      mkdirSync(join(ROOT, '.agentdeck', 'twin'), { recursive: true });
      writeFileSync(join(ROOT, '.agentdeck', 'twin', 'habits.json'), JSON.stringify({
        version: 1, updatedAt: 6000, rejected: [],
        confirmed: [{ key: 'same-habit', label: '对面刚改的版本', at: 6000, evidence: 4, confidence: 0.8 }],
      }, null, 2));
      const rep = syncOnce({ root: ROOT });
      if (!rep.ok) { console.error(rep.reason); process.exit(1); }
      writeFileSync(${JSON.stringify(wire)}, JSON.stringify(rep.pushed), 'utf8');
      console.log(JSON.stringify({ pushed: rep.pushedCount }));
    `);
    assert.equal(a.status, 0, `A 进程失败：${a.out}\n${a.err}`);

    const b = runIn(base, `
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { readHabits } from '__CTX__';
      import { syncOnce, resolveConflict } from '__DELTA__';

      const ROOT = ${JSON.stringify(rootB)};
      mkdirSync(join(ROOT, '.agentdeck', 'twin'), { recursive: true });
      writeFileSync(join(ROOT, '.agentdeck', 'twin', 'habits.json'), JSON.stringify({
        version: 1, updatedAt: 1000, rejected: [],
        confirmed: [{ key: 'same-habit', label: '本机旧版本', at: 1000, evidence: 1, confidence: 0.4 }],
      }, null, 2));

      const incoming = JSON.parse(readFileSync(${JSON.stringify(wire)}, 'utf8'));
      const rep = syncOnce({ root: ROOT, incoming });
      if (!rep.ok) { console.error(rep.reason); process.exit(1); }
      const conflict = rep.conflicts[0];
      const fixed = conflict ? resolveConflict({ root: ROOT, change: conflict }) : { ok: false, reason: '没有冲突' };
      const after = readHabits(ROOT).habits;
      const hits = (after.confirmed || []).filter((x) => x.key === 'same-habit');

      console.log(JSON.stringify({
        conflicts: rep.conflicts.length,
        resolved: fixed.ok,
        reason: fixed.reason || '',
        count: hits.length,
        label: hits[0]?.label || '',
      }));
    `);
    assert.equal(b.status, 0, `B 进程失败：${b.out}\n${b.err}`);
    assert.equal(b.json?.conflicts, 1, `应识别 1 处冲突：${JSON.stringify(b.json)}`);
    assert.equal(b.json.resolved, true, `冲突应能原样解决：${JSON.stringify(b.json)}`);
    assert.equal(b.json.count, 1, '解决后不能出现重复条目');
    assert.equal(b.json.label, '对面刚改的版本');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
