/**
 * M4 定时任务 / 审批 / 全局停止：规则解析、状态落盘、到点真执行、停下来真不跑。
 *
 * 铁律：每个"跑了"都得能在盘上找到痕迹（state.json 的 runs / 任务板的 addTask 调用），
 * 不许拿返回值假装。独立 tmpdir，不碰本机状态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describeEvery,
  describeJob,
  dueJobs,
  isDue,
  nextRunAt,
  normalizeJob,
  parseEvery,
} from '../lib/automation/schedule.js';
import { automationDir, loadState, newId, pushRun, saveState, stateFile, updateState } from '../lib/automation/store.js';
import { createRunner, startTicker } from '../lib/automation/runner.js';
import { createAutomationTool } from '../lib/automation/index.js';

const T0 = Date.parse('2026-11-05T20:00:00+08:00');

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-auto-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** 假任务板：记下每一次 addTask，好断言"任务真的落到板子上"。 */
function fakeBoard({ teams = [{ id: 'team_a' }], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async listTeams() {
      return teams;
    },
    async addTask(teamId, payload) {
      if (fail) throw new Error('板子炸了');
      calls.push({ teamId, payload });
      return { id: `task_${calls.length}` };
    },
  };
}

function readStateFile(root) {
  return JSON.parse(readFileSync(stateFile(root), 'utf8'));
}

test('周期写法：30s / 10m / 2h / 1d 都能解析成毫秒，乱七八糟的给 null', () => {
  assert.equal(parseEvery('30s'), 30 * 1000);
  assert.equal(parseEvery('10m'), 10 * 60 * 1000);
  assert.equal(parseEvery('2h'), 2 * 60 * 60 * 1000);
  assert.equal(parseEvery('1d'), 24 * 60 * 60 * 1000);
  assert.equal(parseEvery('90'), 90);
  assert.equal(parseEvery('1.5h'), 90 * 60 * 1000);
  assert.equal(parseEvery(''), null);
  assert.equal(parseEvery('abc'), null);
  assert.equal(parseEvery(null), null);
  // 人话：整单位不给小数
  assert.equal(describeEvery(30 * 1000), '30 秒');
  assert.equal(describeEvery(2 * 60 * 60 * 1000), '2 小时');
  assert.equal(describeEvery(90 * 60 * 1000), '90 分钟');
});

test('建任务：缺标题/缺时间/周期越界/时间看不懂/agent 没 prompt 全部拒绝，且理由是人话', () => {
  const now = () => T0;
  assert.match(normalizeJob({ every: '10m' }, { now }).error, /标题/);
  assert.match(normalizeJob({ title: '甲' }, { now }).error, /二选一/);
  assert.match(normalizeJob({ title: '甲', every: '0.5s' }, { now }).error, /周期/);
  assert.match(normalizeJob({ title: '甲', every: '99d' }, { now }).error, /周期/);
  assert.match(normalizeJob({ title: '甲', at: '下周三' }, { now }).error, /看不懂时间/);
  assert.match(normalizeJob({ title: '甲', every: '1h', action: 'agent' }, { now }).error, /prompt/);
  assert.match(normalizeJob({ title: '甲', every: '1h', action: '录像' }, { now }).error, /不认识/);

  const ok = normalizeJob({ title: '每天体检', every: '1d', acceptance: 'doctor 全绿' }, { now });
  assert.equal(ok.ok, true);
  assert.equal(ok.job.action, 'task');
  assert.equal(ok.job.every, 24 * 60 * 60 * 1000);
  // 周期任务从「现在 + 一个周期」开始，不许刚建完就立刻跑
  assert.equal(Date.parse(ok.job.nextAt), T0 + 24 * 60 * 60 * 1000);
  assert.equal(ok.job.runCount, 0);
  assert.ok(ok.job.id.startsWith('job_'));

  const one = normalizeJob({ title: '开会', at: '2026-11-05T21:00:00+08:00' }, { now });
  assert.equal(one.ok, true);
  assert.equal(Date.parse(one.job.at), T0 + 60 * 60 * 1000);
  assert.equal(dateOf(one.job.nextAt), T0 + 60 * 60 * 1000);
  // 一次性任务没有"下一次"
  assert.equal(nextRunAt(one.job, T0 + 60 * 60 * 1000), null);
});

function dateOf(iso) {
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms), `时间戳不合法：${iso}`);
  return ms;
}

test('下次什么时候跑：按锚点往前推一格，错过一整夜也不补跑一串', () => {
  const job = { every: 60 * 1000, nextAt: new Date(T0).toISOString() };
  assert.equal(dateOf(nextRunAt(job, T0)), T0 + 60 * 1000);
  // 睡过头 10 分钟：只推到下一个未来格子，不是把 10 次补上
  assert.equal(dateOf(nextRunAt(job, T0 + 10 * 60 * 1000)), T0 + 11 * 60 * 1000);
});

test('状态落盘：写进去能读回来；文件坏了给保底状态 + 原因，不许 throw', () => {
  const { root, done } = freshRoot('store');
  try {
    const empty = loadState({ root });
    assert.equal(empty.ok, true);
    assert.equal(empty.missing, true);
    assert.deepEqual(empty.state.jobs, []);

    const job = normalizeJob({ title: '甲', every: '10m' }, { now: () => T0 }).job;
    const saved = updateState({ root }, (state) => { state.jobs.push(job); });
    assert.equal(saved.ok, true);
    assert.equal(loadState({ root }).state.jobs.length, 1);
    assert.equal(automationDir(root).endsWith('.agentdeck/automation') || automationDir(root).endsWith('.agentdeck\\automation'), true);

    // 坏 JSON：不抛，给空状态 + error
    writeFileSync(stateFile(root), '{ 这不是 JSON', 'utf8');
    const broken = loadState({ root });
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.state.jobs, []);
    assert.ok(broken.error);

    // 加工函数抛错 → 整次放弃，盘上的文件不被写坏
    const aborted = updateState({ root }, () => { throw new Error('故意炸'); });
    assert.equal(aborted.ok, false);
    assert.equal(loadState({ root }).ok, false); // 还是坏文件，说明没被"半写"
  } finally {
    done();
  }
});

test('runs 上限与 id：执行记录不无限长，id 每次都不同', () => {
  const { root, done } = freshRoot('runs');
  try {
    updateState({ root }, (state) => {
      for (let i = 0; i < 205; i += 1) pushRun(state, { at: T0 + i, jobId: 'job_x', jobTitle: '甲', ok: true });
    });
    const state = loadState({ root }).state;
    assert.equal(state.runs.length, 200);
    // 末尾那条是最后写进去的
    assert.equal(state.runs.at(-1).at, new Date(T0 + 204).toISOString());
    assert.notEqual(newId('job'), newId('job'));
  } finally {
    done();
  }
});

test('到点真执行：往任务板丢任务、runCount 涨、下次时间往前挪、runs 有记录', async () => {
  const { root, done } = freshRoot('tick');
  try {
    const board = fakeBoard();
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '每日巡检', every: '10m', acceptance: '全绿' }, { now: () => T0 }).job);
    });
    const runner = createRunner({ root, deps: { board }, now: () => T0 + 10 * 60 * 1000 });

    const res = await runner.tick();
    assert.equal(res.ok, true);
    assert.equal(res.executed.length, 1);
    assert.equal(res.executed[0].ok, true);
    // 任务真落板子上了，标题/验收/角色都对
    assert.equal(board.calls.length, 1);
    assert.equal(board.calls[0].teamId, 'team_a');
    assert.equal(board.calls[0].payload.title, '每日巡检');
    assert.equal(board.calls[0].payload.acceptance, '全绿');
    assert.equal(board.calls[0].payload.source, 'automation');

    const state = readStateFile(root);
    assert.equal(state.jobs[0].runCount, 1);
    assert.equal(state.jobs[0].lastStatus, 'ok');
    assert.equal(dateOf(state.jobs[0].nextAt), T0 + 20 * 60 * 1000);
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].ok, true);
    assert.equal(state.runs[0].taskId, 'task_1');

    // 同一时刻再 tick 一次：没到点，不许重复执行
    const again = await runner.tick();
    assert.equal(again.executed.length, 0);
    assert.equal(board.calls.length, 1);
  } finally {
    done();
  }
});

test('没建小组时不假装干活：如实说任务没地方落，并记成失败', async () => {
  const { root, done } = freshRoot('noteam');
  try {
    const board = fakeBoard({ teams: [] });
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '落不了地', every: '1m' }, { now: () => T0 }).job);
    });
    const runner = createRunner({ root, deps: { board }, now: () => T0 + 60 * 1000 });
    const res = await runner.tick();
    assert.equal(res.executed.length, 1);
    assert.equal(res.executed[0].ok, false);
    assert.match(res.executed[0].detail, /小组/);
    assert.equal(board.calls.length, 0);
    const state = readStateFile(root);
    assert.equal(state.jobs[0].lastStatus, 'failed');
    assert.match(state.jobs[0].lastError, /小组/);
  } finally {
    done();
  }
});

test('action:agent 真派活：成功记 ok，失败把返回码写进记录', async () => {
  const { root, done } = freshRoot('agent');
  try {
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '跑一次', every: '5m', action: 'agent', prompt: '把测试跑一遍' }, { now: () => T0 }).job);
    });
    const seen = [];
    const okRunner = createRunner({
      root,
      deps: { runAgent: async (spec, prompt) => { seen.push({ spec, prompt }); return { rc: 0, out: '全绿 327 passed' }; } },
      now: () => T0 + 5 * 60 * 1000,
    });
    const res = await okRunner.tick();
    assert.equal(res.executed[0].ok, true);
    assert.match(res.executed[0].detail, /全绿/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompt, '把测试跑一遍');

    // 换成 fail 的 Agent：不许把失败说成成功
    updateState({ root }, (state) => {
      state.jobs[0].nextAt = new Date(T0).toISOString();
      state.jobs[0].enabled = true;
    });
    const badRunner = createRunner({
      root,
      deps: { runAgent: async () => ({ rc: 2, err: '命令不存在' }) },
      now: () => T0 + 6 * 60 * 1000,
    });
    const bad = await badRunner.tick();
    assert.equal(bad.executed[0].ok, false);
    assert.match(bad.executed[0].detail, /返回码 2/);
  } finally {
    done();
  }
});

test('要审批的任务：到点只进队列不执行；approve 之后才真跑', async () => {
  const { root, done } = freshRoot('approval');
  try {
    const board = fakeBoard();
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '发版', every: '1h', needsApproval: true }, { now: () => T0 }).job);
    });
    const runner = createRunner({ root, deps: { board }, now: () => T0 + 60 * 60 * 1000 });
    const res = await runner.tick();
    assert.equal(res.executed.length, 0, '要审批的任务到点不许自己跑');
    assert.equal(res.queued.length, 1);
    assert.equal(board.calls.length, 0);

    const state = readStateFile(root);
    assert.equal(state.approvals.length, 1);
    assert.equal(state.approvals[0].status, 'pending');
    assert.equal(state.jobs[0].lastStatus, 'awaiting-approval');

    // 再 tick 一次（到点还没人批）：不许重复排队
    await runner.tick({ nowMs: T0 + 61 * 60 * 1000 });
    assert.equal(readStateFile(root).approvals.length, 1);

    // 工具层批准 → 真执行
    const tool = createAutomationTool({ board, workspace: root });
    const out = await tool.execute({ action: 'approve', approvalId: state.approvals[0].id });
    assert.match(out.text, /已执行/);
    assert.equal(board.calls.length, 1);
    const after = readStateFile(root);
    assert.equal(after.approvals[0].status, 'done');
    assert.equal(after.jobs[0].runCount, 1);

    // 再批一次：不给重复执行
    const twice = await tool.execute({ action: 'approve', approvalId: state.approvals[0].id });
    assert.match(twice.text, /没有这条待审批/);
    assert.equal(board.calls.length, 1);
  } finally {
    done();
  }
});

test('全局停止是真停：停下来一条都不跑，恢复之后照跑（状态在盘上，跨进程有效）', async () => {
  const { root, done } = freshRoot('stop');
  try {
    const board = fakeBoard();
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '停不停', every: '1m' }, { now: () => T0 }).job);
      state.stopped = { at: new Date(T0).toISOString(), by: '测试', reason: '手动停' };
    });
    const runner = createRunner({ root, deps: { board }, now: () => T0 + 60 * 1000 });
    const stopped = await runner.tick();
    assert.equal(stopped.skipped, 'stopped');
    assert.equal(stopped.executed.length, 0);
    assert.equal(board.calls.length, 0);
    assert.equal(readStateFile(root).jobs[0].runCount, 0);

    // 另一个进程（这里是工具）解除停止 → 同一个 runner 立刻照跑
    const tool = createAutomationTool({ board, workspace: root });
    assert.match((await tool.execute({ action: 'resume' })).text, /已恢复/);
    const res = await runner.tick();
    assert.equal(res.executed.length, 1);
    assert.equal(board.calls.length, 1);

    // 停止中手动 run 也必须被挡住
    await tool.execute({ action: 'stop', reason: '再停一次' });
    const manual = await tool.execute({ action: 'run', jobId: readStateFile(root).jobs[0].id });
    assert.match(manual.text, /全局已停止/);
    assert.equal(board.calls.length, 1);
  } finally {
    done();
  }
});

test('maxRuns 到量就退休：跑够次数不再触发', async () => {
  const { root, done } = freshRoot('maxruns');
  try {
    const board = fakeBoard();
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '只跑两次', every: '1m', maxRuns: 2 }, { now: () => T0 }).job);
    });
    let nowMs = T0;
    const runner = createRunner({ root, deps: { board }, now: () => nowMs });
    for (let i = 0; i < 3; i += 1) {
      nowMs += 60 * 1000;
      await runner.tick({ nowMs });
    }
    assert.equal(board.calls.length, 2);
    const job = readStateFile(root).jobs[0];
    assert.equal(job.runCount, 2);
    assert.equal(isDue(job, nowMs + 10 * 60 * 1000), false);
    assert.equal(dueJobs({ jobs: [job] }, nowMs + 10 * 60 * 1000).length, 0);
  } finally {
    done();
  }
});

test('一次性任务跑完自动失活，不会再被拉起来', async () => {
  const { root, done } = freshRoot('oneshot');
  try {
    const board = fakeBoard();
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '一次性', at: '2026-11-05T20:30:00+08:00' }, { now: () => T0 }).job);
    });
    const runner = createRunner({ root, deps: { board }, now: () => T0 + 60 * 60 * 1000 });
    const res = await runner.tick();
    assert.equal(res.executed.length, 1);
    const job = readStateFile(root).jobs[0];
    assert.equal(job.enabled, false);
    assert.equal(job.runCount, 1);
    // 再往后一大截也不跑
    const later = await runner.tick({ nowMs: T0 + 30 * 24 * 60 * 60 * 1000 });
    assert.equal(later.executed.length, 0);
    assert.equal(board.calls.length, 1);
    assert.match(describeJob(job), /一次性/);
  } finally {
    done();
  }
});

test('工具契约：add/list/status/remove 一路走通，坏输入给中文原因而不是崩', async () => {
  const { root, done } = freshRoot('tool');
  try {
    const board = fakeBoard();
    const tool = createAutomationTool({ board, workspace: root });
    assert.equal(tool.name, 'deck_automation');
    assert.ok(tool.description.includes('stop'));

    const bad = await tool.execute({ action: '放火' });
    assert.match(bad.text, /不认识的动作/);

    const added = await tool.execute({ action: 'add', title: '每天归档', every: '1d', acceptance: '目录清空', needsApproval: true });
    assert.match(added.text, /排好了/);
    assert.match(added.text, /要你点头/);

    const listed = await tool.execute({ action: 'list' });
    assert.match(listed.text, /每天归档/);
    assert.match(listed.text, /定时任务 1 条/);

    const status = await tool.execute({});
    assert.match(status.text, /自动化在跑/);

    const jobId = readStateFile(root).jobs[0].id;
    const gone = await tool.execute({ action: 'remove', jobId });
    assert.match(gone.text, /已删掉/);
    assert.equal(readStateFile(root).jobs.length, 0);
    const goneAgain = await tool.execute({ action: 'remove', jobId });
    assert.match(goneAgain.text, /没有这个定时任务/);
  } finally {
    done();
  }
});

test('巡检定时器：能起能停，停了之后到点也不许再跑', async () => {
  const { root, done } = freshRoot('ticker');
  try {
    const board = fakeBoard();
    // 用真实时钟：巡检里 now() 是 Date.now()，这条任务建在一小时前 → 一起步就该被吃掉
    const real = Date.now();
    updateState({ root }, (state) => {
      state.jobs.push(normalizeJob({ title: '启动即到点', every: '1h' }, { now: () => real - 2 * 60 * 60 * 1000 }).job);
    });
    const runner = createRunner({ root, deps: { board }, now: () => Date.now(), log: () => {} });
    const dispose = startTicker({ runner, tickMs: 60 * 1000, log: () => {} });
    assert.equal(typeof dispose, 'function');
    await new Promise((resolve) => setTimeout(resolve, 2400));
    dispose();
    assert.equal(board.calls.length, 1, '巡检起来后第一趟应该真跑了一条');
    const afterDispose = board.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(board.calls.length, afterDispose, 'dispose 之后不许再跑');
  } finally {
    done();
  }
});

test('两个工作区互不干扰：各管各的定时任务', async () => {
  const a = freshRoot('iso-a');
  const b = freshRoot('iso-b');
  try {
    updateState({ root: a.root }, (state) => {
      state.jobs.push(normalizeJob({ title: 'A 的任务', every: '1h' }, { now: () => T0 }).job);
    });
    assert.equal(loadState({ root: b.root }).state.jobs.length, 0);
    assert.notEqual(stateFile(a.root), stateFile(b.root));
    saveState({ root: b.root, state: { jobs: [], approvals: [], runs: [], stopped: null } });
    assert.equal(loadState({ root: b.root }).state.jobs.length, 0);
    assert.equal(loadState({ root: a.root }).state.jobs.length, 1);
  } finally {
    a.done();
    b.done();
  }
});
