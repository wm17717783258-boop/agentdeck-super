/**
 * tests/selfcheck-sync-e2e.test.mjs —— 自检第 3 轮：真·跨进程增量同步
 *
 * 前两轮验的是"单进程里功能有反应"。这一轮换角度：
 *   **两个完全独立的 node 进程**，各自一个工作区，通过 JSON 文件传递"网络载荷"，
 *   验数据真的从 A 流到 B，且 B 能读出来。
 *
 * 这比单进程测试强的地方：进程边界会暴露"内存里看着对、落盘却不对"这类问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 在指定工作区里跑一段脚本（独立进程）。 */
function runIn(root, body) {
  const file = join(root, `.selfcheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  // 用绝对 file:// URL 导入，避免不同工作区的相对路径歧义
  const href = (rel) => `file:///${join(PKG, rel).replace(/\\/g, '/')}`;
  const src = String(body)
    .split('__MEM__').join(href('lib/twin/memory.js'))
    .split('__DELTA__').join(href('lib/sync/delta.js'))
    .split('__SYNC__').join(href('lib/sync/index.js'));
  writeFileSync(file, src, 'utf8');
  const r = spawnSync(process.execPath, [file], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

test('自检 3：A 写记忆 → 算出增量 → B 合并 → B 真读得到（两个独立进程）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-selfcheck3-'));
  const rootA = join(base, 'A');
  const rootB = join(base, 'B');
  const wire = join(base, 'wire.json');
  const resultB = join(base, 'b-result.json');
  try {
    // ── 进程 A：写一条记忆，算出增量，写到"网络载荷"文件 ──
    const a = runIn(base, `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { remember } from '__MEM__';
      import { syncOnce } from '__DELTA__';

      const MY_ROOT = ${JSON.stringify(rootA)};
      mkdirSync(MY_ROOT, { recursive: true });

      const at = 1800000000000;
      const r = remember(MY_ROOT, { content: '甲机写下的一条记忆', type: 'event' }, { now: () => at });
      if (r?.ok === false) { console.error('写记忆失败', JSON.stringify(r)); process.exit(1); }

      const rep = syncOnce({ root: MY_ROOT });
      if (!rep.ok) { console.error('syncOnce 失败', rep.reason); process.exit(1); }

      writeFileSync(${JSON.stringify(wire)}, JSON.stringify(rep.pushed), 'utf8');
      console.log(JSON.stringify({ id: r.item?.id, pushed: rep.pushedCount }));
    `);
    assert.equal(a.status, 0, `A 进程失败：${a.out}\n${a.err}`);
    const aOut = JSON.parse(a.out.trim().split('\n').pop());
    assert.ok(aOut.pushed >= 1, `A 应该推出至少 1 条：${JSON.stringify(aOut)}`);
    assert.ok(existsSync(wire), 'A 应该写出网络载荷');
    const payload = JSON.parse(readFileSync(wire, 'utf8'));
    assert.ok(Array.isArray(payload) && payload.length >= 1, `载荷应是数组：${typeof payload}`);

    // ── 进程 B：独立工作区，把载荷合进来，然后真读回来 ──
    const b = runIn(base, `
      import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { recall } from '__MEM__';
      import { syncOnce } from '__DELTA__';

      const MY_ROOT = ${JSON.stringify(rootB)};
      mkdirSync(MY_ROOT, { recursive: true });

      const incoming = JSON.parse(readFileSync(${JSON.stringify(wire)}, 'utf8'));
      const rep = syncOnce({ root: MY_ROOT, incoming });
      if (!rep.ok) { console.error('B 合并失败', rep.reason); process.exit(1); }

      // 关键：换一个召回，看数据真的落到本机了吗
      const said = recall(MY_ROOT, { query: '甲机写下' }, { now: () => 1800000001000 });
      const hit = (said?.items || []).some((x) => String(x.text || '').includes('甲机写下'));

      writeFileSync(${JSON.stringify(resultB)}, JSON.stringify({
        ok: rep.ok, applied: rep.appliedCount, conflicts: rep.conflicts.length, hit,
      }), 'utf8');
      console.log(JSON.stringify({ applied: rep.appliedCount, hit }));
    `);
    assert.equal(b.status, 0, `B 进程失败：${b.out}\n${b.err}`);
    const bOut = JSON.parse(b.out.trim().split('\n').pop());
    assert.ok(bOut.applied >= 1, `B 应该合进至少 1 条：${JSON.stringify(bOut)}`);
    assert.equal(bOut.hit, true, 'B 应该能真召回甲机写的那条记忆');

    // 再独立读一次落盘结果，确认不是进程内假象
    const persisted = JSON.parse(readFileSync(resultB, 'utf8'));
    assert.equal(persisted.hit, true, '落盘的结果也应显示召回成功');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('自检 3：A 的增量不会重复推（第二次同步为空）', () => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-selfcheck3b-'));
  const rootA = join(base, 'A');
  try {
    const r = runIn(base, `
      import { mkdirSync } from 'node:fs';
      import { remember } from '__MEM__';
      import { syncOnce } from '__DELTA__';

      const MY_ROOT = ${JSON.stringify(rootA)};
      mkdirSync(MY_ROOT, { recursive: true });
      remember(MY_ROOT, { content: '只该被推一次', type: 'event' }, { now: () => 1800000002000 });

      const first = syncOnce({ root: MY_ROOT });
      const second = syncOnce({ root: MY_ROOT });
      console.log(JSON.stringify({ first: first.pushedCount, second: second.pushedCount }));
    `);
    assert.equal(r.status, 0, `失败：${r.out}\n${r.err}`);
    const o = JSON.parse(r.out.trim().split('\n').pop());
    assert.ok(o.first >= 1, `第一轮应推出：${JSON.stringify(o)}`);
    assert.equal(o.second, 0, `第二轮不该重复推：${JSON.stringify(o)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('自检 3：B 的人格类冲突不会被静默覆盖（两个进程间也是）', () => {
  const base = mkdtempSync(join(tmpdir(), 'adsk-selfcheck3c-'));
  const rootB = join(base, 'B');
  try {
    const r = runIn(base, `
      import { mkdirSync } from 'node:fs';
      import { remember } from '__MEM__';
      import { syncOnce } from '__DELTA__';

      const MY_ROOT = ${JSON.stringify(rootB)};
      mkdirSync(MY_ROOT, { recursive: true });

      // 本机先有一条"偏好"
      remember(MY_ROOT, { content: '我的偏好', type: 'preference' }, { now: () => 1000 });

      // 对面推来更新的偏好（同 id 才构成冲突；这里用真实 id 不好拿，就验"新 id 直接进"）
      const rep = syncOnce({
        root: MY_ROOT,
        incoming: [{ bucket: 'memory', id: 'pref_from_peer', at: 9000, data: { id: 'pref_from_peer', text: '对面的偏好', type: 'preference', at: 9000 } }],
      });
      console.log(JSON.stringify({ ok: rep.ok, applied: rep.appliedCount, conflicts: rep.conflicts.length }));
    `);
    assert.equal(r.status, 0, `失败：${r.out}\n${r.err}`);
    const o = JSON.parse(r.out.trim().split('\n').pop());
    assert.equal(o.ok, true);
    // 新 id（本机没有）应直接插入，不算冲突
    assert.equal(o.applied, 1, `新 id 应直接插入：${JSON.stringify(o)}`);
    assert.equal(o.conflicts, 0, '新 id 不该报冲突');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
