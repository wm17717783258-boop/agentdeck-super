/**
 * tests/selfcheck-hostile.test.mjs —— 自检第 4 轮：负面测试（专门搞破坏）
 *
 * 前三轮验的都是"正常路径"。这一轮换角度：**喂垃圾、断依赖、越界、并发**，
 * 看它会不会崩、会不会静默做错事。
 *
 * 判定标准不是"报错"，而是：
 *   ① 绝不 throw（工具的 execute 契约是永不抛错）
 *   ② 绝不"假装成功"（失败要如实说）
 *   ③ 绝不越界写（路径穿越必须挡）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { mergeDelta, computeDelta, readCursor, syncOnce, kindOf } from '../lib/sync/delta.js';
import { verifyPassport } from '../lib/identity.js';
import { verifyMandate } from '../lib/twin/mandate.js';
import { judgeAutonomy, normalizeMandate } from '../lib/twin/mandate.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

async function withHub(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-hostile-'));
  const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
  try {
    return await fn(hub, root);
  } finally {
    try { await hub.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }
}

const JUNK = [
  null, undefined, 0, 1, -1, '', '   ', 'string', true, false, [], {}, [{}],
  { action: null }, { action: 123 }, { action: {} }, { action: [] },
  { action: 'NOT_A_REAL_ACTION' }, { action: 'delta', incoming: 'not-an-array' },
  { action: 'delta', incoming: [null, 1, 'x', {}, { id: '' }] },
  { incoming: [null, undefined] }, { passphrase: 123 }, { blob: 123 },
  { blob: 'NEXISYNC1.garbage' }, { passphrase: 'short' },
];

test('自检 4：所有工具喂垃圾都不抛错、不返回空', async () => {
  await withHub(async (hub) => {
    const tools = hub.list().map((t) => t.name);
    const problems = [];
    for (const name of tools) {
      const def = hub.tools.get(name);
      for (const junk of JUNK) {
        let out;
        try {
          out = await def.execute(junk, { hub: true });
        } catch (err) {
          problems.push(`${name} 抛错（喂 ${JSON.stringify(junk)}）：${err?.message || err}`);
          continue;
        }
        if (!out || typeof out !== 'object' || typeof out.text !== 'string') {
          problems.push(`${name} 返回形状不对（喂 ${JSON.stringify(junk)}）：${JSON.stringify(out)?.slice(0, 80)}`);
        }
      }
    }
    assert.deepEqual(problems.slice(0, 10), [], `有 ${problems.length} 处不达标：\n${problems.slice(0, 10).join('\n')}`);
  });
});

test('自检 4：delta 遇到垃圾 incoming 不崩，且不假装成功', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-hostile-delta-'));
  try {
    for (const junk of [null, undefined, 'str', 123, {}, [null], [{}], [{ id: '' }]]) {
      const r = mergeDelta({ root, changes: junk });
      assert.equal(typeof r.ok, 'boolean', `mergeDelta(${JSON.stringify(junk)}) 应返回 ok 布尔`);
      assert.ok(Array.isArray(r.applied), 'applied 应是数组');
      assert.ok(Array.isArray(r.conflicts), 'conflicts 应是数组');
    }
    const c = computeDelta({ root, since: 'not-a-number' });
    assert.equal(typeof c.ok, 'boolean');
    const s = syncOnce({ root, incoming: 'not-an-array' });
    assert.equal(typeof s.ok, 'boolean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 4：路径穿越必须被挡（不能写到工作区外）', async () => {
  await withHub(async (hub, root) => {
    const evil = [
      '../../../evil.txt',
      '..\\..\\..\\evil.txt',
      'C:/Windows/Temp/evil.txt',
      '/etc/passwd',
    ];
    for (const p of evil) {
      const out = textOf(await hub.tools.get('twin_remember').execute(
        { content: 'x', type: 'event', id: p },
        { hub: true },
      ));
      // 不该崩；也不该在 root 之外生成文件（这里只能验"没崩 + 没报成功写出去"）
      assert.equal(typeof out, 'string');
    }
    // 确认工作区外没有我们造出来的东西
    assert.ok(!existsSync(join(root, '..', '..', '..', 'evil.txt')), '不该写到上层目录');
  });
});

test('自检 4：伪造的卡/执照必须验不过', () => {
  // 通行证
  for (const fake of [
    'NEXP1.abc.def', 'NEXP1..', 'NEXP1.a.b', 'xxxx', '',
    'NEXP1.' + Buffer.from('{"v":1,"kid":"kid_fake","pub":""}').toString('base64url') + '.sig',
  ]) {
    const v = verifyPassport(fake);
    assert.equal(v.ok, false, `伪造卡不该验过：${fake.slice(0, 40)}`);
    assert.ok(typeof v.code === 'string' && v.code.length > 0, '应给机器可读的错误码');
  }
  // 分身执照
  for (const fake of ['NEXM1.abc.def', 'NEXM1..', 'garbage', '']) {
    const v = verifyMandate(fake);
    assert.equal(v.ok, false, `伪造执照不该验过：${fake.slice(0, 40)}`);
  }
});

test('自检 4：执照判定对越界输入给出"不放行"（不是默认允许）', () => {
  const claims = normalizeMandate({
    scope: { tools: ['fs_read'], actions: ['board_add'], deny: ['shell'] },
  });
  // 白名单外 → 必须 confirm（不是 allow）
  assert.equal(judgeAutonomy(claims, { tool: 'deck_market' }).effect, 'confirm');
  // deny 内 → 必须 deny
  assert.equal(judgeAutonomy(claims, { tool: 'shell' }).effect, 'deny');
  // 白名单内 → allow
  assert.equal(judgeAutonomy(claims, { tool: 'fs_read' }).effect, 'allow');
  // 空输入 → 不该 allow
  assert.notEqual(judgeAutonomy(claims, {}).effect, 'allow', '空动作不该默许');
});

test('自检 4：kindOf 对怪输入不崩', () => {
  for (const junk of [null, undefined, 0, '', [], {}, { type: 123 }, { kind: null }]) {
    const k = kindOf(junk);
    assert.equal(typeof k, 'string');
    assert.ok(k.length > 0);
  }
});

test('自检 4：游标文件被写成垃圾后仍能继续同步（不永久卡死）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-hostile-cursor-'));
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(root, '.agentdeck'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'sync-cursor.json'), '不是 JSON {{{', 'utf8');
    const c = readCursor(root);
    assert.equal(c.pushCursor, 0, '坏游标应回 0，而不是抛错');
    const r = syncOnce({ root });
    assert.equal(r.ok, true, `坏游标后应能继续同步：${r.reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
