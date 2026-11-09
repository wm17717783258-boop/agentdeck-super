/**
 * M2 分身记忆：记忆五类/四级可见性、召回、删除、导出、习惯提议→确认→回滚、工具契约。
 *
 * 铁律：每个断言都得是"真写盘、真读回来"，不许发明细。
 * 独立 DSH_HOME（tmpdir），不碰本机真实记忆。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_TYPES,
  VISIBILITIES,
  memoryPath,
  readMemory,
  recall,
  remember,
  forget,
  stats,
  exportMemory,
  normalizeVisibility,
  visibleWithin,
} from '../lib/twin/memory.js';
import { proposeHabits, confirmHabit, rejectHabit, rollbackHabit, buildBrief, buildShareable, readHabits } from '../lib/twin/context.js';
import { createTwinTools, TWIN_TOOL_NAMES } from '../lib/twin/index.js';
import { createProfileStore, HABIT_PROMOTE_AT, observe } from '../lib/pet/profile.js';

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-twin-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

async function callTool(tools, name, args) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `缺工具 ${name}`);
  const value = await tool.execute(args);
  assert.ok(value && typeof value.text === 'string', `${name} 必须返回 {text}`);
  return value.text;
}

test('记忆：写进去能在盘上查得到，换一个进程也读得出来', () => {
  const { root, done } = freshRoot('write');
  try {
    const written = remember(root, { text: '用户要求所有金额走报销单，别直接现金', type: 'preference', tags: ['报销', '财务'] });
    assert.equal(written.ok, true);
    assert.equal(written.deduped, false);
    assert.ok(written.item.id.startsWith('mem_'));

    const file = memoryPath(root);
    assert.ok(existsSync(file), '记忆文件必须真落盘');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.items.length, 1);
    assert.equal(onDisk.items[0].text, '用户要求所有金额走报销单，别直接现金');
    assert.equal(onDisk.items[0].type, 'preference');
    assert.deepEqual(onDisk.items[0].tags, ['报销', '财务']);
    // 默认私有：不写 visibility 不允许漏成公开
    assert.equal(onDisk.items[0].visibility, 'private');

    // 重新读一份（模拟另一个进程）
    const reread = readMemory(root);
    assert.equal(reread.ok, true);
    assert.equal(reread.memory.items.length, 1);
  } finally { done(); }
});

test('记忆：重复的同一句合并而不是刷屏，标签会并集', () => {
  const { root, done } = freshRoot('dedupe');
  try {
    remember(root, { text: '代码改动后必须跑 node --test', type: 'preference', tags: ['测试'] });
    const again = remember(root, { text: '代码改动后必须跑  node --test  ', type: 'preference', tags: ['CI'] });
    assert.equal(again.ok, true);
    assert.equal(again.deduped, true);
    assert.deepEqual(again.item.tags.sort(), ['CI', '测试'].sort());
    assert.equal(stats(root).total, 1, '重复写不能变成两条');
  } finally { done(); }
});

test('记忆：五类都能写，四级可见性都认得；对外闸门真的挡住私有条目', () => {
  const { root, done } = freshRoot('types');
  try {
    for (const type of MEMORY_TYPES) remember(root, { text: `${type} 类的一条记忆`, type });
    for (const vis of VISIBILITIES) remember(root, { text: `可见性是 ${vis} 的一条`, type: 'relation', visibility: vis });
    const counted = stats(root);
    assert.equal(counted.total, MEMORY_TYPES.length + VISIBILITIES.length);
    for (const vis of VISIBILITIES) assert.ok(counted.byVisibility[vis] >= 1, `${vis} 没记上`);

    // 中文别名也要认（用户在对话里说的是中文）
    assert.equal(normalizeVisibility('好友'), 'friend');
    assert.equal(normalizeVisibility('瞎写'), 'private', '认不出就落最保守的 private');
    // 闸门口径：visibility 写的是「最少谁能看」
    assert.equal(visibleWithin('private', 'private'), true, '本人看得到自己的全部');
    assert.equal(visibleWithin('private', 'friend'), false, '私有记忆不许给好友看');
    assert.equal(visibleWithin('friend', 'friend'), true);
    assert.equal(visibleWithin('friend', 'room'), false, '房间成员不一定是你好友');
    assert.equal(visibleWithin('public', 'public'), true);

    const asFriend = recall(root, { query: '可见性', maxVisibility: 'friend', limit: 20 });
    assert.equal(asFriend.items.some((item) => item.visibility === 'private'), false, '私有记忆不许出现在 friend 视角');
    assert.ok(asFriend.hidden > 0, '被挡住的数量要如实报');
  } finally { done(); }
});

test('记忆：召回按相关度排，命中会累加次数', () => {
  const { root, done } = freshRoot('recall');
  try {
    remember(root, { text: '这个项目用 pnpm，不要用 npm 装依赖', type: 'semantic', tags: ['构建'] });
    remember(root, { text: '客户喜欢先看结论再看细节', type: 'preference' });
    remember(root, { text: '把季度报表发到财务邮箱', type: 'event', tags: ['报表'] });

    const hit = recall(root, { query: 'pnpm 装依赖' });
    assert.equal(hit.ok, true);
    assert.ok(hit.items.length >= 1);
    assert.match(hit.items[0].text, /pnpm/);
    assert.ok(hit.items[0].hits >= 1, '命中要记次数');

    const byTag = recall(root, { tags: ['报表'] });
    assert.equal(byTag.items[0].text, '把季度报表发到财务邮箱');

    const byType = recall(root, { type: 'preference', any: true });
    assert.ok(byType.items.every((item) => item.type === 'preference'));

    // 中文不具备分词：靠二元组也要能命中
    const zh = recall(root, { query: '结论' });
    assert.ok(zh.items.some((item) => item.text.includes('结论')));
  } finally { done(); }
});

test('记忆：删得掉、删前留 .bak、清空要二次确认', () => {
  const { root, done } = freshRoot('forget');
  try {
    const a = remember(root, { text: '随手记的一条 A', type: 'event' });
    remember(root, { text: '随手记的一条 B', type: 'event' });
    assert.equal(stats(root).total, 2);

    const one = forget(root, { id: a.item.id });
    assert.equal(one.removed, 1);
    assert.equal(stats(root).total, 1);

    const guarded = forget(root, { all: true });
    assert.equal(guarded.ok, false, '不带 confirm 不许清空');
    assert.match(guarded.reason, /confirm/);

    const all = forget(root, { all: true, confirm: true });
    assert.equal(all.ok, true);
    assert.equal(stats(root).total, 0);
    assert.ok(existsSync(`${memoryPath(root)}.bak`), '删前要留一份 .bak');
  } finally { done(); }
});

test('记忆：导出 json 与 md 都能给出可携带的文本', () => {
  const { root, done } = freshRoot('export');
  try {
    remember(root, { text: '导出测试：客户叫王工', type: 'relation', tags: ['客户'] });
    const json = exportMemory(root, { format: 'json' });
    assert.equal(json.ok, true);
    assert.equal(json.count, 1);
    assert.ok(JSON.parse(json.text).items.length === 1);

    const md = exportMemory(root, { format: 'md' });
    assert.match(md.text, /分身记忆导出/);
    assert.match(md.text, /关系（1）/);
    assert.match(md.text, /客户叫王工/);
  } finally { done(); }
});

test('习惯：观察到 2 次先提议 → 用户确认才真学进画像 → 能回滚', () => {
  const { root, done } = freshRoot('habit');
  try {
    let clock = Date.parse('2026-11-05T01:00:00Z');
    const store = createProfileStore({ root, now: () => clock });
    // 同一时段同一类活干两次（显式 at 保证不是重复事件）
    for (let i = 0; i < 2; i += 1) {
      clock += 60 * 1000;
      store.get();
      const seen = store.update((draft) => draft);
      assert.equal(seen.ok, true);
    }
    for (let i = 0; i < 2; i += 1) {
      const at = new Date(clock).toISOString();
      const res = observe(store, { type: 'task_done', role: 'worker', tags: ['报销'], at });
      assert.equal(res.ok, true);
      clock += 60 * 1000;
    }
    const profileBefore = store.get();
    assert.equal(profileBefore.habits.length, 0, `2 次还不够自动升级（阈值 ${HABIT_PROMOTE_AT}）`);

    const proposals = proposeHabits({ root, store });
    assert.equal(proposals.ok, true);
    assert.equal(proposals.proposals.length, 1);
    assert.match(proposals.proposals[0].label, /报销/);
    const key = proposals.proposals[0].key;

    const confirmed = confirmHabit({ root, store }, { key });
    assert.equal(confirmed.ok, true);
    assert.equal(store.get().habits.length, 1, '确认后画像里必须真有这条习惯');
    assert.equal(proposeHabits({ root, store }).proposals.length, 0, '确认过的不再重复提议');

    const back = rollbackHabit({ root, store }, { key });
    assert.equal(back.ok, true);
    assert.equal(store.get().habits.length, 0, '回滚后画像里也要消失');
  } finally { done(); }
});

test('习惯：拒绝过的候选不再出现', () => {
  const { root, done } = freshRoot('reject');
  try {
    const store = createProfileStore({ root, now: () => Date.parse('2026-11-05T02:00:00Z') });
    observe(store, { type: 'task_added', role: 'lead', tags: ['周报'], at: '2026-11-05T02:00:00Z' });
    observe(store, { type: 'task_added', role: 'lead', tags: ['周报'], at: '2026-11-05T02:10:00Z' });
    const [first] = proposeHabits({ root, store }).proposals;
    assert.ok(first, '两次同款活应该冒出一个候选');
    rejectHabit({ root }, { key: first.key });
    assert.equal(proposeHabits({ root, store }).proposals.length, 0);
  } finally { done(); }
});

test('习惯：桌宠自动记下的也还得你点头才算数（两套账不打架）', () => {
  const { root, done } = freshRoot('auto-habit');
  try {
    const store = createProfileStore({ root, now: () => Date.parse('2026-11-05T02:00:00Z') });
    for (let i = 0; i < 3; i += 1) {
      observe(store, { type: 'task_done', role: 'worker', tags: ['周报'], at: `2026-11-05T02:${String(i * 10).padStart(2, '0')}:00Z` });
    }
    assert.equal(store.get().habits.length, 1, `3 次到点自动记一笔（阈值 ${HABIT_PROMOTE_AT}）`);
    const before = proposeHabits({ root, store }).proposals;
    assert.equal(before.length, 1, '自动记下的那条仍然要列出来等你确认');
    assert.equal(before[0].auto, true, '要标出来是桌宠自己记的');
    const confirmed = confirmHabit({ root, store }, { key: before[0].key });
    assert.equal(confirmed.ok, true);
    assert.equal(readHabits(root).habits.confirmed.length, 1, '确认后进 twin 账本（简报来源）');
    assert.equal(proposeHabits({ root, store }).proposals.length, 0, '确认过就不再追问');
  } finally { done(); }
});

test('简报：有习惯有记忆才写进去；对外版不许带私有内容', () => {
  const { root, done } = freshRoot('brief');
  try {
    const store = createProfileStore({ root, now: () => Date.parse('2026-11-05T03:00:00Z') });
    remember(root, { text: '对内：报价底线不能低于 8000', type: 'preference', visibility: 'private' });
    remember(root, { text: '对外：我们在做企业报销自动化', type: 'semantic', visibility: 'public' });

    const brief = buildBrief({ root, store, boardSummary: { teams: 1, todo: 2, doing: 1, done: 3 }, allowShare: true });
    assert.equal(brief.ok, true);
    assert.match(brief.text, /数字分身/);
    assert.match(brief.text, /报价底线/);
    assert.match(brief.text, /任务板/);

    const share = brief.shareable;
    assert.equal(share.ok, true);
    assert.equal(share.memory.some((item) => item.text.includes('报价底线')), false, '对外版绝不能带私有记忆');
    assert.equal(share.memory.some((item) => item.text.includes('报销自动化')), true);

    const direct = buildShareable({ root, store });
    assert.equal(direct.memory.every((item) => item.visibility !== 'private'), true);
  } finally { done(); }
});

test('工具契约：5 个工具都返回人话，喂垃圾参数也不许抛', async () => {
  const { root, done } = freshRoot('tools');
  try {
    const tools = createTwinTools({ root, profile: createProfileStore({ root }) });
    assert.deepEqual(tools.map((tool) => tool.name), TWIN_TOOL_NAMES);

    const saved = await callTool(tools, 'twin_remember', { text: '客户周一上午开会，别排活', type: 'preference', tags: ['排期'] });
    assert.match(saved, /已记住|已合并/);

    const found = await callTool(tools, 'twin_recall', { query: '开会' });
    assert.match(found, /客户周一上午开会/);

    const brief = await callTool(tools, 'twin_brief', { limit: 2 });
    assert.match(brief, /twin_brief/);

    const list = await callTool(tools, 'twin_habit', { action: 'propose' });
    assert.match(list, /候选/);

    const statsText = await callTool(tools, 'twin_forget', { action: 'stats' });
    assert.match(statsText, /记忆统计/);

    const exported = await callTool(tools, 'twin_forget', { action: 'export', format: 'md' });
    assert.match(exported, /客户周一上午开会/);

    // 垃圾参数：空 text / 未知动作 / 不存在的 key
    const empty = await callTool(tools, 'twin_remember', {});
    assert.match(empty, /空的/);
    const badAction = await callTool(tools, 'twin_habit', { action: 'explode' });
    assert.match(badAction, /不认识的动作/);
    const noKey = await callTool(tools, 'twin_habit', { action: 'confirm', key: 'nope' });
    assert.match(noKey, /没有这个候选/);
    const guard = await callTool(tools, 'twin_forget', { all: true });
    assert.match(guard, /confirm/);

    const removed = await callTool(tools, 'twin_forget', { query: '开会' });
    assert.match(removed, /已删除/);
  } finally { done(); }
});



test('状态页摘要：宿主把 root 传成函数也要算得出来（踩过的坑）', async () => {
  const { root, done } = freshRoot('deck');
  try {
    remember(root, { text: '页面摘要要能看到这条', type: 'semantic' }, { now: () => Date.now() });
    const { twinSummary } = await import('../lib/index.js');
    const twin = { stats, readHabits, proposeHabits };

    // 宿主真实形态：deps.root 是 () => 工作区
    const viaFn = twinSummary({ root: () => root, twin, petStore: null });
    assert.equal(viaFn.ready, true);
    assert.equal(viaFn.total, 1);
    assert.equal(viaFn.byType.semantic, 1);

    // CLI / 测试里常见的字符串形态，也要一致
    const viaStr = twinSummary({ root, twin, petStore: null });
    assert.equal(viaStr.total, 1);

    // 模块没挂上时必须是"未就绪"，绝不能抛
    assert.equal(twinSummary({ root }).ready, false);
  } finally { done(); }
});
