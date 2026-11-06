/**
 * agent_join 的成员登记回归 —— 真机 bug：join 与 list 读写两个不同的存储。
 *
 * 现象：join 回「已加入小组 …」，list 里却找不到这个人，
 *       反而只列出一堆环境探测到的 Agent（Claude Code / Codex / dsh…）。
 * 根因：join 写进**任务板**（board.addMember），list 只读**宿主注册表**（deps.registry）。
 * 这里把"写完必须读得到"钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

/** 起一个真插件实例，拿到工具调用入口。 */
async function boot(root) {
  const tools = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: () => null,
    emit() {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject() {},
    tools: { register(def) { tools.push(def); return () => {}; } },
  };
  await apply(ctx, { workspace: root, boardRoot: root, licenseRoot: root, agents: [] });
  return async (name, args) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `工具 ${name} 没注册`);
    const out = await t.execute(args, {});
    return typeof out === 'string' ? out : String(out?.text ?? '');
  };
}

test('join 之后 list 必须看得见这个人（两个存储不许各写各的）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexi-join-reg-'));
  try {
    const call = await boot(root);

    const cr = await call('team_board', { action: 'create', name: '回归组' });
    const teamId = (cr.match(/team_[0-9a-f]{8,}/) || [])[0];
    assert.ok(teamId, `建组没给 id：${cr.slice(0, 120)}`);

    const joined = await call('agent_join', { action: 'join', name: '回归成员', role: 'tester', capabilities: ['测'], teamId });
    assert.match(joined, /已加入/, `join 失败：${joined.slice(0, 150)}`);

    const list = await call('agent_join', { action: 'list', teamId });
    assert.match(list, /回归成员/, `join 完 list 里看不见他：${list.slice(0, 250)}`);
    // 该区分"登记进来的"和"环境探测到的"，不然用户分不清谁真在这个组里
    assert.match(list, /已登记/, '该标出这是登记进来的成员');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('leave 之后 list 里应该没有他了', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexi-join-leave-'));
  try {
    const call = await boot(root);
    const cr = await call('team_board', { action: 'create', name: '离开回归组' });
    const teamId = (cr.match(/team_[0-9a-f]{8,}/) || [])[0];

    await call('agent_join', { action: 'join', name: '临时成员', role: 'worker', teamId });
    assert.match(await call('agent_join', { action: 'list', teamId }), /临时成员/, '加了没进去');

    const left = await call('agent_join', { action: 'leave', name: '临时成员', teamId });
    assert.ok(!/运行失败/.test(left), `leave 出错：${left.slice(0, 120)}`);

    const after = await call('agent_join', { action: 'list', teamId });
    assert.ok(!after.includes('临时成员'), `离开后 list 里还有他：${after.slice(0, 250)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
