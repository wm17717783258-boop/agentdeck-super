/**
 * tests/roles.test.mjs —— 角色分工 / 计划 / 调度 / 验收闸门
 *
 * 测试原则（docs/CONTRACTS.md 4）：
 *   · 只用假大脑，绝不联网、绝不调真模型；
 *   · 断言失败时把真实文本当 message 打出来，排错不用再跑一遍。
 *
 * 这一层的价值在于"模型给的烂计划不能把项目搞死"，
 * 所以重点覆盖：校验/纠错、回喂重试、降级、依赖环、上游失败级联跳过、并发上限。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import rolesDefault, {
  ROLES,
  ROLE_NAMES,
  normalizeRole,
  systemFor,
  buildPlannerPrompt,
  validatePlan,
  planProject,
  parsePlan,
  defaultGate,
  runGraph,
} from '../lib/engine/roles.js';
import { TOOL_NAMES } from '../lib/engine/toolbelt.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 按剧本回答的假大脑：每次 chat 取一条；用完了就把最后一条重复用。 */
function fakeBrain(replies) {
  const list = Array.isArray(replies) ? replies.slice() : [replies];
  const calls = [];
  return {
    calls,
    mode: 'host',
    async chat(payload) {
      calls.push(payload);
      const next = list.length > 1 ? list.shift() : list[0];
      if (typeof next === 'function') return next(payload, calls.length);
      if (next instanceof Error) throw next;
      if (typeof next === 'string') return { content: next, toolCalls: [], usage: { in: 1, out: 1 }, model: 'fake-brain' };
      return { toolCalls: [], usage: { in: 1, out: 1 }, model: 'fake-brain', ...next };
    },
    models: () => ['fake-brain'],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const planJson = (tasks) => JSON.stringify(tasks);

const goodPlan = [
  { id: 't1', title: '定接口', role: 'architect', acceptance: '给出 lib/x.js 的函数签名', dependsOn: [] },
  { id: 't2', title: '写实现', role: 'worker', acceptance: 'lib/x.js 能被 import 且导出 f', dependsOn: ['t1'] },
  { id: 't3', title: '跑测试', role: 'tester', acceptance: 'node --test 全绿', dependsOn: ['t2'] },
];

// ---------------------------------------------------------------------------
// ROLES：六个角色
// ---------------------------------------------------------------------------

test('ROLES：六个角色齐全，字段可用，工具名都在工具带里', () => {
  assert.deepEqual(ROLE_NAMES, ['lead', 'architect', 'critic', 'worker', 'tester', 'scribe']);
  for (const name of ROLE_NAMES) {
    const r = ROLES[name];
    assert.equal(r.id, name);
    assert.ok(r.name && r.name.length >= 2, `${name} 缺中文名`);
    assert.ok(r.system.length > 30, `${name} 的 system 太短：${r.system}`);
    assert.ok(r.system.includes(name), `${name} 的 system 里应该点明角色身份`);
    assert.ok(r.whenToUse, `${name} 缺 whenToUse`);
    assert.ok(r.defaultAcceptance, `${name} 缺 defaultAcceptance`);
    assert.ok(r.tools.length > 0, `${name} 没有推荐工具`);
    assert.equal(new Set(r.tools).size, r.tools.length, `${name} 的工具列表里有重复项：${r.tools.join(',')}`);
    for (const tool of r.tools) {
      assert.ok(TOOL_NAMES.includes(tool), `${name} 引用了不存在的工具 ${tool}（工具带里只有 ${TOOL_NAMES.join(',')}）`);
    }
  }
});

test('default 导出：把关键能力都挂上了', () => {
  for (const key of ['ROLES', 'ROLE_NAMES', 'normalizeRole', 'systemFor', 'planProject', 'parsePlan', 'validatePlan', 'runGraph', 'defaultGate']) {
    assert.ok(rolesDefault[key], `default 导出缺 ${key}`);
  }
});

test('normalizeRole：认识 id、认识中文名、认不出来当 worker', () => {
  assert.equal(normalizeRole('architect'), 'architect');
  assert.equal(normalizeRole('  Architect '), 'architect');
  assert.equal(normalizeRole('架构师'), 'architect');
  assert.equal(normalizeRole('测试员'), 'tester');
  assert.equal(normalizeRole('记录员'), 'scribe');
  assert.equal(normalizeRole(''), 'worker');
  assert.equal(normalizeRole(null), 'worker');
  assert.equal(normalizeRole('ninja'), 'worker');
  assert.equal(normalizeRole(undefined), 'worker');
});

test('systemFor：角色 prompt 打头，附加规则跟在后面', () => {
  const plain = systemFor('critic');
  assert.ok(plain.includes('评审官'), plain);
  assert.ok(!plain.includes('总目标'), '没有附加内容时不该出现总目标');

  const withExtra = systemFor('critic', '总目标：把 x 做出来');
  assert.ok(withExtra.startsWith(ROLES.critic.system), withExtra);
  assert.ok(withExtra.trim().endsWith('总目标：把 x 做出来'), withExtra);

  // 认不出来的角色不炸，退回 worker
  assert.ok(systemFor('外星人').includes('执行者'));
});

test('buildPlannerPrompt：带上目标和任务数上限', () => {
  const p = buildPlannerPrompt('做一个插件', { maxTasks: 5 });
  assert.ok(p.includes('做一个插件'), p);
  assert.ok(p.includes('最多 5 条'), p);
  assert.ok(p.includes('只输出 JSON 数组'), p);

  const obj = buildPlannerPrompt({ goal: '做个插件', level: 3 });
  assert.ok(obj.includes('做个插件'), obj);
});

// ---------------------------------------------------------------------------
// validatePlan：把模型的烂计划修好或判死
// ---------------------------------------------------------------------------

test('validatePlan：正常计划原样通过', () => {
  const res = validatePlan(goodPlan);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.equal(res.tasks.length, 3);
  assert.deepEqual(res.tasks[1].dependsOn, ['t1']);
  assert.equal(res.tasks[0].role, 'architect');
});

test('validatePlan：容忍 { tasks: [...] } 和缺 id 的写法', () => {
  const res = validatePlan({ tasks: [{ title: '写文档', role: 'scribe', acceptance: 'README 落盘' }] });
  assert.equal(res.ok, true);
  assert.equal(res.tasks[0].id, 't1', '缺 id 要自动补 t1');
  assert.equal(res.tasks[0].dependsOn.length, 0);
});

test('validatePlan：非数组/空数组直接判死', () => {
  for (const bad of [null, undefined, '', {}, { tasks: [] }, []]) {
    const res = validatePlan(bad);
    assert.equal(res.ok, false, `应为不通过：${JSON.stringify(bad)}`);
    assert.ok(res.errors.join(';').includes('模型没有返回任务数组'), res.errors.join(';'));
  }
});

test('validatePlan：id 重复自动改名，不认识的角色降级成 worker，缺验收用默认值', () => {
  const res = validatePlan([
    { id: 't1', title: 'A', role: 'architect', acceptance: 'ok', dependsOn: [] },
    { id: 't1', title: 'B', role: 'ninja', dependsOn: [] },
    { id: 't3', title: 'C', role: 'tester', acceptance: 'ok', dependsOn: [] },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.tasks.map((t) => t.id), ['t1', 't1-2', 't3']);
  assert.equal(res.tasks[1].role, 'worker');
  assert.equal(res.tasks[1].acceptance, ROLES.worker.defaultAcceptance);
  const w = res.warnings.join('\n');
  assert.ok(w.includes('任务 id 重复'), w);
  assert.ok(w.includes('"ninja" 不认识'), w);
  assert.ok(w.includes('缺验收标准'), w);
});

test('validatePlan：跳过没有 title 的项，丢掉不存在的依赖', () => {
  const res = validatePlan([
    { id: 't1', title: 'A', acceptance: 'ok' },
    { id: 't2', acceptance: '缺标题' },
    { id: 't3', title: 'C', acceptance: 'ok', dependsOn: ['t1', 'ghost'] },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.tasks.map((t) => t.id), ['t1', 't3']);
  assert.deepEqual(res.tasks[1].dependsOn, ['t1'], '幽灵依赖必须被剔除');
  assert.ok(res.warnings.join(';').includes('没有 title'), res.warnings.join(';'));
  assert.ok(res.warnings.join(';').includes('不存在的 ghost'), res.warnings.join(';'));
});

test('validatePlan：自依赖和依赖成环都判死', () => {
  const self = validatePlan([{ id: 't1', title: 'A', acceptance: 'ok', dependsOn: ['t1'] }]);
  assert.equal(self.ok, false);
  assert.ok(self.errors.join(';').includes('任务 t1 依赖了自己'), self.errors.join(';'));

  const cycle = validatePlan([
    { id: 'a', title: 'A', acceptance: 'ok', dependsOn: ['b'] },
    { id: 'b', title: 'B', acceptance: 'ok', dependsOn: ['a'] },
  ]);
  assert.equal(cycle.ok, false);
  const msg = cycle.errors.join(';');
  assert.ok(msg.includes('依赖成环'), msg);
  assert.ok(msg.includes('→'), `环要能看出来路径：${msg}`);
});

test('validatePlan：maxTasks 会截断，且最多只留 12 条', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `t${i + 1}`, title: `T${i + 1}`, acceptance: 'ok' }));
  assert.equal(validatePlan(many, { maxTasks: 3 }).tasks.length, 3);
  assert.equal(validatePlan(many).tasks.length, 12);
});

// ---------------------------------------------------------------------------
// parsePlan：从模型正文里抠 JSON
// ---------------------------------------------------------------------------

test('parsePlan：纯数组 / 围栏 / 带说明文字 / {tasks} 包装都能抠出来', () => {
  const arr = [{ id: 't1', title: 'A' }];
  const raw = JSON.stringify(arr);
  assert.deepEqual(parsePlan(raw), arr);
  assert.deepEqual(parsePlan('```json\n' + raw + '\n```'), arr);
  assert.deepEqual(parsePlan('好的，计划如下：\n' + raw + '\n以上。'), arr);
  assert.deepEqual(parsePlan(JSON.stringify({ tasks: arr })), arr);
  assert.deepEqual(parsePlan('```\n' + raw + '\n```'), arr);
});

test('parsePlan：空/非 JSON/坏 JSON 都返回 null，不抛错', () => {
  for (const bad of ['', null, undefined, '我不会', '[{', '{"tasks": 1}']) {
    assert.equal(parsePlan(bad), null, `应解析失败：${String(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// planProject：校验 + 回喂重试 + 降级
// ---------------------------------------------------------------------------

test('planProject：一次给出合格计划', async () => {
  const brain = fakeBrain(planJson(goodPlan));
  const plan = await planProject({ brain, brief: '做个工具插件', opts: { maxTasks: 8 } });
  assert.equal(plan.ok, true);
  assert.equal(plan.degraded, false);
  assert.equal(plan.goal, '做个工具插件');
  assert.deepEqual(plan.tasks.map((t) => t.id), ['t1', 't2', 't3']);
  assert.equal(brain.calls.length, 1);

  // 提示里必须既有组长设定又有"只输出 JSON"
  const sys = brain.calls[0].messages[0].content;
  assert.ok(sys.includes('任务图'), sys);
  assert.ok(brain.calls[0].messages[1].content.includes('最多 8 条'), brain.calls[0].messages[1].content);
});

test('planProject：第一次输出不是 JSON，回喂错误后第二次成功', async () => {
  const brain = fakeBrain(['我先想想……', planJson(goodPlan)]);
  const plan = await planProject({ brain, brief: '做个工具插件' });
  assert.equal(plan.ok, true);
  assert.equal(brain.calls.length, 2);
  const retryMsgs = brain.calls[1].messages;
  assert.ok(retryMsgs[retryMsgs.length - 1].content.includes('不是合法 JSON'), JSON.stringify(retryMsgs));
});

test('planProject：计划成环会被回喂，第二次修好', async () => {
  const badPlan = [
    { id: 'a', title: 'A', acceptance: 'ok', dependsOn: ['b'] },
    { id: 'b', title: 'B', acceptance: 'ok', dependsOn: ['a'] },
  ];
  const brain = fakeBrain([planJson(badPlan), planJson(goodPlan)]);
  const plan = await planProject({ brain, brief: '做个工具插件' });
  assert.equal(plan.ok, true);
  assert.equal(brain.calls.length, 2);
  const feedback = brain.calls[1].messages.at(-1).content;
  assert.ok(feedback.includes('依赖成环'), feedback);
});

test('planProject：两次都不合格就降级成一条 lead 任务，项目不卡死', async () => {
  const brain = fakeBrain('算了不给了');
  const plan = await planProject({ brain, brief: '做个工具插件' });
  assert.equal(plan.ok, false);
  assert.equal(plan.degraded, true);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].role, 'lead');
  assert.deepEqual(plan.tasks[0].dependsOn, []);
  assert.ok(plan.tasks[0].title.includes('做个工具插件'), plan.tasks[0].title);
  assert.ok(plan.errors[0].includes('计划两次都没有通过校验'), plan.errors);
  assert.equal(brain.calls.length, 2, '默认重试 1 次');
});

test('planProject：retries=0 时只问一次模型', async () => {
  const brain = fakeBrain('算了不给了');
  const plan = await planProject({ brain, brief: '做东西', opts: { retries: 0 } });
  assert.equal(plan.degraded, true);
  assert.equal(brain.calls.length, 1);
});

test('planProject：模型调用抛错 / 没有大脑 / 目标为空 都降级，不抛异常', async () => {
  const thrown = await planProject({ brain: fakeBrain(new Error('网络断了')), brief: '做东西' });
  assert.equal(thrown.degraded, true);
  assert.ok(thrown.errors[0].includes('调用模型生成计划失败'), thrown.errors);

  const noBrain = await planProject({ brain: null, brief: '做东西' });
  assert.equal(noBrain.degraded, true);
  assert.ok(noBrain.errors[0].includes('没有可用的大脑'), noBrain.errors);

  const noGoal = await planProject({ brain: fakeBrain('[]'), brief: '' });
  assert.equal(noGoal.degraded, true);
  assert.ok(noGoal.errors[0].includes('目标为空'), noGoal.errors);
  assert.equal(noGoal.tasks[0].id, 't1');
});

test('planProject：maxTasks 生效，模型给多了只会留前 N 条', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `t${i + 1}`, title: `T${i + 1}`, acceptance: 'ok' }));
  const brain = fakeBrain(planJson(many));
  const plan = await planProject({ brain, brief: '做东西', opts: { maxTasks: 2 } });
  assert.equal(plan.tasks.length, 2);
  assert.ok(brain.calls[0].messages[1].content.includes('最多 2 条'), brain.calls[0].messages[1].content);
});

// ---------------------------------------------------------------------------
// defaultGate：没有模型时的兜底验收
// ---------------------------------------------------------------------------

test('defaultGate：没结果/失败/空产出不通过，有产出通过并带出验收标准', () => {
  assert.equal(defaultGate({ acceptance: 'x' }, null).ok, false);
  assert.ok(defaultGate({ acceptance: 'x' }, null).reason.includes('没有返回结果'));

  const failed = defaultGate({ acceptance: 'x' }, { ok: false, error: '编译挂了' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, '编译挂了');

  const empty = defaultGate({ acceptance: 'x' }, { ok: true, output: '   ' });
  assert.equal(empty.ok, false);
  assert.ok(empty.reason.includes('没有产出内容'), empty.reason);

  const good = defaultGate({ acceptance: '命令 exit 0' }, { ok: true, output: '做完了' });
  assert.equal(good.ok, true);
  assert.ok(good.reason.includes('产出 3 字'), good.reason);
  assert.ok(good.reason.includes('命令 exit 0'), good.reason);
});

// ---------------------------------------------------------------------------
// runGraph：调度、并发、重试、级联跳过、死锁
// ---------------------------------------------------------------------------

test('runGraph：没有任务直接成功；没有 run 报明确错误', async () => {
  const empty = await runGraph({ tasks: [] });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.results, {});

  const noRun = await runGraph({ tasks: [{ id: 'a', title: 'A' }] });
  assert.equal(noRun.ok, false);
  assert.ok(noRun.failures[0].error.includes('runGraph 需要 run(task) 执行器'), noRun.failures);
});

test('runGraph：按依赖顺序跑，上游产出作为 context 传给下游', async () => {
  const started = [];
  const contexts = {};
  const tasks = [
    { id: 'a', title: 'A', dependsOn: [] },
    { id: 'b', title: 'B', dependsOn: ['a'] },
  ];
  const res = await runGraph({
    tasks,
    concurrency: 4,
    run: async (task) => {
      started.push(task.id);
      contexts[task.id] = task.context;
      return { ok: true, output: `产出-${task.id}` };
    },
    gate: () => ({ ok: true, reason: '过了' }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(started, ['a', 'b'], 'b 必须等 a 完成');
  assert.equal(res.results.a.output, '产出-a');
  assert.equal(res.results.a.attempts, 1);
  assert.equal(res.results.a.gate, '过了');
  assert.ok(contexts.b.includes('【上游 a 的产出】'), contexts.b);
  assert.ok(contexts.b.includes('产出-a'), contexts.b);
  assert.equal(contexts.a, '', '第一条任务没有上游上下文');
});

test('runGraph：并发不超过 concurrency，且真的并行', async () => {
  let inflight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i + 1}`, title: `T${i + 1}`, dependsOn: [] }));
  const res = await runGraph({
    tasks,
    concurrency: 2,
    run: async (task) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await sleep(10);
      inflight -= 1;
      return { ok: true, output: task.id };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(peak, 2, `并发峰值应为 2，实际 ${peak}`);
  assert.equal(Object.keys(res.results).length, 6);
});

test('runGraph：concurrency 乱传会被夹住（0 → 1，999 → 32）', async () => {
  const mk = () => Array.from({ length: 4 }, (_, i) => ({ id: `t${i + 1}`, title: `T`, dependsOn: [] }));
  let peak1 = 0;
  let inflight1 = 0;
  await runGraph({
    tasks: mk(),
    concurrency: 0,
    run: async () => {
      inflight1 += 1;
      peak1 = Math.max(peak1, inflight1);
      await sleep(5);
      inflight1 -= 1;
      return { ok: true, output: 'x' };
    },
  });
  assert.equal(peak1, 1);

  const wide = await runGraph({ tasks: mk(), concurrency: 999, run: async () => ({ ok: true, output: 'x' }) });
  assert.equal(wide.ok, true, '999 不该抛错，夹到 32 继续跑');
});

test('runGraph：上游失败会级联跳过下游（含传递依赖）', async () => {
  const res = await runGraph({
    tasks: [
      { id: 'a', title: 'A', dependsOn: [] },
      { id: 'b', title: 'B', dependsOn: ['a'] },
      { id: 'c', title: 'C', dependsOn: ['b'] },
      { id: 'd', title: 'D', dependsOn: [] },
    ],
    run: async (task) => (task.id === 'a' ? { ok: false, error: '编译挂了' } : { ok: true, output: 'ok' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.results.b.ok, false);
  assert.ok(res.results.b.error.includes('上游任务 a 失败，已跳过'), res.results.b.error);
  assert.ok(res.results.c.error.includes('上游任务 b 失败，已跳过'), res.results.c.error);
  assert.equal(res.results.d.ok, true, '无关任务照常跑完');
  assert.deepEqual(res.failures.map((f) => f.id), ['a', 'b', 'c']);
});

test('runGraph：验收不过会按 retries 重试，重试成功就通过', async () => {
  let n = 0;
  const res = await runGraph({
    tasks: [{ id: 'r', title: 'R', dependsOn: [], retries: 1 }],
    run: async () => {
      n += 1;
      return n === 1 ? { ok: true, output: '' } : { ok: true, output: '这次好了' };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(n, 2, '应该跑两次');
  assert.equal(res.results.r.attempts, 2);
  assert.ok(res.warnings.join(';').includes('第 1 次验收不通过'), res.warnings.join(';'));
});

test('runGraph：重试次数用完仍不过就算失败', async () => {
  let n = 0;
  const res = await runGraph({
    tasks: [{ id: 'r', title: 'R', dependsOn: [], retries: 2 }],
    run: async () => {
      n += 1;
      return { ok: true, output: '' };
    },
  });
  assert.equal(res.ok, false);
  assert.equal(n, 3, '首次 + 2 次重试');
  assert.equal(res.results.r.attempts, 3);
  assert.ok(res.failures[0].error.includes('没有产出内容'), res.failures[0].error);
});

test('runGraph：依赖成环不会死等，剩余任务标成未调度', async () => {
  const res = await runGraph({
    tasks: [
      { id: 'a', title: 'A', dependsOn: ['b'] },
      { id: 'b', title: 'B', dependsOn: ['a'] },
      { id: 'c', title: 'C', dependsOn: [] },
    ],
    run: async (t) => ({ ok: true, output: t.id }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.results.c.ok, true, '无关任务不能跟着一起死');
  assert.ok(res.results.a.error.includes('依赖成环或无就绪任务，未能调度'), res.results.a.error);
  assert.ok(res.results.b.error.includes('依赖成环或无就绪任务，未能调度'), res.results.b.error);
});

test('runGraph：run 抛异常 / gate 抛异常都只算该任务失败，不外抛', async () => {
  const thrown = await runGraph({
    tasks: [{ id: 'x', title: 'X', dependsOn: [] }],
    run: async () => {
      throw new TypeError('执行器炸了');
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.results.x.error, 'TypeError: 执行器炸了');

  const gateBoom = await runGraph({
    tasks: [{ id: 'y', title: 'Y', dependsOn: [] }],
    run: async () => ({ ok: true, output: '有产出' }),
    gate: () => {
      throw new Error('闸门自己坏了');
    },
  });
  assert.equal(gateBoom.ok, false);
  assert.ok(gateBoom.results.y.error.includes('验收闸门异常'), gateBoom.results.y.error);
});

test('runGraph：run 直接返回字符串也算成功；task 可以是字符串 id 之外的脏数据', async () => {
  const res = await runGraph({
    tasks: [{ id: 'a', title: 'A' }, null, { title: '没有 id 会被丢掉' }],
    run: async () => '纯文本产出',
  });
  assert.equal(Object.keys(res.results).length, 1, '没有 id 的任务应被剔除');
  assert.equal(res.results.a.ok, true);
  assert.equal(res.results.a.output, '纯文本产出');
});

test('runGraph：重复 id 自动改名并给 warning，不覆盖结果', async () => {
  const res = await runGraph({
    tasks: [
      { id: 't1', title: 'A', dependsOn: [] },
      { id: 't1', title: 'B', dependsOn: [] },
    ],
    run: async (t) => ({ ok: true, output: t.title }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.results).sort(), ['t1', 't1-2']);
  assert.equal(res.results['t1-2'].output, 'B');
  assert.ok(res.warnings.join(';').includes('任务 id 重复'), res.warnings.join(';'));
});

test('runGraph：不改调用方传进来的任务对象', async () => {
  const tasks = [{ id: 'a', title: 'A', dependsOn: ['ghost'] }];
  const snapshot = JSON.stringify(tasks);
  await runGraph({ tasks, run: async (t) => ({ ok: true, output: t.id }) });
  assert.equal(JSON.stringify(tasks), snapshot, 'input 上的 dependsOn/attempt 不能回写到原对象');
});

test('runGraph：抛出的异常不会让调用方收到未处理的 rejection', async () => {
  // gate 里异步 throw（不是同步 throw）也要被兜住
  const res = await runGraph({
    tasks: [{ id: 'a', title: 'A' }],
    run: async () => ({ ok: true, output: 'ok' }),
    gate: async () => {
      throw new Error('异步闸门炸了');
    },
  });
  assert.equal(res.ok, false);
});
