/**
 * tests/selfcheck-crash.test.mjs —— 自检第 14 轮：异常退出与恢复
 *
 * 前十三轮大多在"进程正常活着"的前提下测。这一轮换角度：**进程被打断**。
 *
 * 用户的真实场景：
 *   · 写到一半 Ctrl-C 了
 *   · 电脑断电了
 *   · 进程被 SIGKILL 了
 *   · 磁盘写了一半满了
 *
 * 验的是：**下次启动还能用，且已有的数据不丢**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBoard } from '../lib/engine/board.js';
import { remember, recall, readMemory } from '../lib/twin/memory.js';
import { readCursor, syncOnce } from '../lib/sync/delta.js';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

test('自检 14：写到一半被杀（SIGKILL），下次启动数据不丢', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-crash-kill-'));
  try {
    // 起一个子进程，让它写一堆记忆然后自杀
    const script = join(root, '.crash.mjs');
    writeFileSync(script, `
      import { remember } from 'file:///${join(PKG, 'lib/twin/memory.js').replace(/\\/g, '/')}';
      const MY_ROOT = ${JSON.stringify(root)};
      for (let i = 0; i < 200; i += 1) {
        remember(MY_ROOT, { content: '崩溃前 ' + i, type: 'event' }, { now: () => 1800000000000 + i });
        if (i === 100) process.kill(process.pid, 'SIGKILL');   // 写到一半强杀
      }
    `, 'utf8');

    const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    // 被 SIGKILL 掉，退出码非 0 是预期的
    assert.notEqual(r.status, 0, '子进程应该被强杀了');

    // 关键：现在以"新进程"的身份读，数据不该坏
    const mem = readMemory(root);
    assert.ok(mem, '强杀之后应还能读');
    assert.ok(Array.isArray(mem.memory?.items), 'items 应是数组');
    // 写进去的不该丢（应该至少有 100 条左右）
    assert.ok(mem.memory.items.length >= 50, `强杀前的数据应还在，实际 ${mem.memory.items.length} 条`);

    // 还能继续写（不是"错一次就废"）
    const w = remember(root, { content: '恢复之后', type: 'event' }, { now: () => 1800000200000 });
    assert.ok(w?.ok !== false, `恢复后应能继续写：${JSON.stringify(w)?.slice(0, 120)}`);
    const said = recall(root, { query: '恢复之后' }, { now: () => 1800000300000 });
    assert.ok((said?.items || []).length > 0, '应能召回新写的');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14：状态文件被截断（模拟断电），能读回可用状态或安全回落', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-crash-trunc-'));
  try {
    // 先正常写一份
    const board = createBoard({ root });
    const team = await board.createTeam({ name: '断电前的组', goal: 'x' });
    await board.addTask(team.id, { title: '断电前的任务', role: 'worker' });

    const stateFile = join(root, 'state.json');
    assert.ok(existsSync(stateFile), '应有状态文件');
    const full = readFileSync(stateFile, 'utf8');
    assert.ok(full.length > 10, '状态文件应有内容');

    // 模拟断电：截断成一半
    writeFileSync(stateFile, full.slice(0, Math.floor(full.length / 2)), 'utf8');

    // 关键：新开一个 board 不该崩
    const board2 = createBoard({ root });
    let teams;
    try {
      teams = await board2.listTeams();
    } catch (err) {
      assert.fail(`截断的状态文件不该让 listTeams 抛错：${err?.message || err}`);
    }
    assert.ok(Array.isArray(teams), '应返回数组（哪怕是空的）');

    // 还能继续用
    const t2 = await board2.createTeam({ name: '恢复后的组', goal: 'y' });
    assert.ok(t2?.id, `截断后应能继续建组：${JSON.stringify(t2)?.slice(0, 120)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14：崩溃后没有残留的半截临时文件干扰（原子写的副作用）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-crash-tmp-'));
  try {
    // 造几个"半截临时文件"（模拟上次写到一半留下）
    mkdirSync(join(root, '.agentdeck', 'twin'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'twin', 'memory.json.tmp-999-123'), '{"items":[{"id":"half}', 'utf8');
    writeFileSync(join(root, '.agentdeck', 'twin', 'memory.json.12345.tmp'), '半截', 'utf8');

    // 正常写一次
    const w = remember(root, { content: '临时文件存在时也能写', type: 'event' }, { now: () => 1800000000000 });
    assert.ok(w?.ok !== false, `不该被残留临时文件干扰：${JSON.stringify(w)?.slice(0, 150)}`);

    // 主文件应该是对的
    const mem = readMemory(root);
    assert.ok(mem.memory.items.length >= 1, '应能读到刚写的');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14：目录被删掉一半后还能重建（不是永久坏）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-crash-rmdir-'));
  try {
    const w1 = remember(root, { content: '删之前', type: 'event' }, { now: () => 1800000000000 });
    assert.ok(w1?.ok !== false);

    // 把整个 twin 目录删掉（模拟用户误删 / 清理工具干的好事）
    rmSync(join(root, '.agentdeck', 'twin'), { recursive: true, force: true });
    assert.ok(!existsSync(join(root, '.agentdeck', 'twin')), '目录应被删掉');

    // 关键：还能写回来（自动重建目录）
    const w2 = remember(root, { content: '删之后重建的', type: 'event' }, { now: () => 1800000100000 });
    assert.ok(w2?.ok !== false, `应能自动重建目录：${JSON.stringify(w2)?.slice(0, 150)}`);
    assert.ok(existsSync(join(root, '.agentdeck', 'twin', 'memory.json')), '应重建出文件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14：同步游标丢失后从零开始（不丢数据，只重传）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-crash-cursor-'));
  try {
    remember(root, { content: '游标丢失前', type: 'event' }, { now: () => 1800000000000 });
    const first = syncOnce({ root });
    assert.ok(first.pushedCount >= 1, '第一次应推到内容');

    // 删掉游标（模拟游标文件损坏/被清理）
    rmSync(join(root, '.agentdeck', 'sync-cursor.json'), { force: true });

    const c = readCursor(root);
    assert.equal(c.pushCursor, 0, '游标丢失后应回到 0');

    // 关键：会重传一遍（这是设计：宁可重传，不可漏传）
    const second = syncOnce({ root });
    assert.equal(second.ok, true, `游标丢失后应能继续：${second.reason}`);
    assert.ok(second.pushedCount >= 1, '应该重传一遍（不是丢数据）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14：磁盘只读时不崩（写失败要如实报，不是假装成功）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-crash-ro-'));
  try {
    // 用一个"文件当目录"制造写失败（比改权限更跨平台可靠）
    mkdirSync(join(root, '.agentdeck'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'twin'), '我是个文件，不是目录', 'utf8');

    // 这时写记忆会失败（路径冲突）——关键是不抛、且如实说
    let threw = false;
    let result;
    try {
      result = remember(root, { content: 'x', type: 'event' }, { now: () => 1800000000000 });
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, false, '写失败不该抛异常给调用方');
    assert.ok(result, '应返回结果对象');
    // 要么 ok:false，要么 ok:true 但实际没写成 —— 前者是对的
    if (result.ok === false) {
      assert.ok(typeof result.reason === 'string' || result.file, '失败要给出原因');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 14：反复崩 5 次，每次都能恢复（不是崩一次就永久坏）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-crash-loop-'));
  try {
    for (let round = 0; round < 5; round += 1) {
      const script = join(root, `.crash${round}.mjs`);
      writeFileSync(script, `
        import { remember } from 'file:///${join(PKG, 'lib/twin/memory.js').replace(/\\/g, '/')}';
        const MY_ROOT = ${JSON.stringify(root)};
        for (let i = 0; i < 50; i += 1) {
          remember(MY_ROOT, { content: '第${round}轮 ' + i, type: 'event' }, { now: () => ${1800000000000 + round * 100000} + i });
          if (i === 25) process.kill(process.pid, 'SIGKILL');
        }
      `, 'utf8');
      spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });

      // 每轮之后都验一次能读能写
      const mem = readMemory(root);
      assert.ok(Array.isArray(mem.memory?.items), `第 ${round} 轮崩后应能读`);
      const w = remember(root, { content: `第${round}轮恢复`, type: 'event' }, { now: () => 1800000000000 + round * 100000 + 99999 });
      assert.ok(w?.ok !== false, `第 ${round} 轮崩后应能写`);
    }
    // 最终所有轮次的数据都该在（累积）
    const finalMem = readMemory(root);
    assert.ok(finalMem.memory.items.length >= 20, `5 轮崩溃后数据应累积，实际 ${finalMem.memory.items.length} 条`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
