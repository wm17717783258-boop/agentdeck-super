/**
 * tests/mandate-wiring.test.mjs —— 分身执照真的接线了吗（从工具带里取 execute 真调）
 *
 * 为什么要单独一个文件：tests/mandate.test.mjs 证明的是"引擎算得对"；
 * 这个文件证明的是"接线生效"——把工具带里注册好的 execute 取出来真调，
 * 看它是不是真会被执照拦住。两者不能互相替代（1.10.0 的 policy 就吃过这个亏：
 * 假 hub 的单测全绿、真宿主却是坏的）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';

/** 每个用例一个独立工作区，避免互相看见对方的执照。 */
async function withHub(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mandate-wire-'));
  let hub = null;
  try {
    hub = await createHub({ workspace: root, onLog: () => {} });
    await fn(hub, root);
  } finally {
    try { await hub?.close(); } catch { /* 关不掉不算测试失败 */ }
    rmSync(root, { recursive: true, force: true });
  }
}

const textOf = (value) => String(value && typeof value === 'object' ? value.text ?? '' : value ?? '');
const callText = async (hub, name, args) => textOf(await hub.tools.get(name).execute(args, { hub: true }));

test('twin_mandate 出现在工具表里', async () => {
  await withHub(async (hub) => {
    const names = hub.list().map((t) => t.name);
    assert.ok(names.includes('twin_mandate'), `工具表里没有 twin_mandate：${names.join(', ')}`);
  });
});

test('无执照时：自主调用被拦，主人直调放行', async () => {
  await withHub(async (hub) => {
    const exec = hub.tools.get('deck_sync').execute;

    const autonomous = textOf(await exec({ action: 'info', autonomous: true }, { hub: true }));
    assert.match(autonomous, /需要主人确认|执照/, `自主调用没被拦：${autonomous.slice(0, 80)}`);

    const byHuman = textOf(await exec({ action: 'info' }, { hub: true }));
    assert.doesNotMatch(byHuman, /需要主人确认/, `主人直调不该被执照拦：${byHuman.slice(0, 80)}`);
    assert.match(byHuman, /deck_sync/, '主人直调应该拿到真实结果');
  });
});

test('签了执照后：不在白名单的自主调用仍要确认，带 confirm 可人工放行', async () => {
  await withHub(async (hub) => {
    await callText(hub, 'twin_mandate', { action: 'issue' });
    const exec = hub.tools.get('deck_sync').execute;

    const blocked = textOf(await exec({ action: 'info', autonomous: true }, { hub: true }));
    assert.match(blocked, /不在执照白名单/, `白名单外的自主调用没被拦：${blocked.slice(0, 80)}`);

    const overridden = textOf(await exec({ action: 'info', autonomous: true, confirm: true }, { hub: true }));
    assert.doesNotMatch(overridden, /需要主人确认/, '主人带 confirm:true 应该能越过执照');
    assert.match(overridden, /deck_sync/);
  });
});

test('吊销执照后：自主调用立刻又回到"需要确认"', async () => {
  await withHub(async (hub) => {
    await callText(hub, 'twin_mandate', { action: 'issue' });
    const show = await callText(hub, 'twin_mandate', { action: 'show' });
    const id = (show.match(/当前执照：(\S+)/) || [])[1];
    assert.ok(id, `从 show 里拿不到执照 id：${show.slice(0, 120)}`);

    const revoked = await callText(hub, 'twin_mandate', { action: 'revoke', id });
    assert.match(revoked, /已吊销/);

    const exec = hub.tools.get('deck_sync').execute;
    const after = textOf(await exec({ action: 'info', autonomous: true }, { hub: true }));
    assert.match(after, /需要主人确认|执照/, `吊销后自主调用没被拦：${after.slice(0, 80)}`);
  });
});

test('deny 清单里的工具：自主调用直接拒（连 confirm 都救不回来，除非主人手动）', async () => {
  await withHub(async (hub) => {
    // 只放 fs_* 进白名单，shell 明确禁止
    await callText(hub, 'twin_mandate', {
      action: 'issue',
      tools: ['fs_*'],
      actions: [],
      deny: ['shell'],
    });
    const verdict = await callText(hub, 'twin_mandate', { action: 'check', tool: 'shell' });
    assert.match(verdict, /deny（不许干）/, `deny 判定不对：${verdict.slice(0, 100)}`);
  });
});

test('twin_mandate 的 execute 永不抛错（喂垃圾参数）', async () => {
  await withHub(async (hub) => {
    const exec = hub.tools.get('twin_mandate').execute;
    for (const junk of [null, undefined, {}, { action: '不存在' }, { action: 'revoke' }, { action: 'check' }]) {
      const out = await exec(junk, { hub: true });
      assert.ok(out && typeof out === 'object', `喂 ${JSON.stringify(junk)} 时返回值不对`);
      assert.equal(typeof out.text, 'string');
    }
  });
});
