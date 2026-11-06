/**
 * 1.10.0 自动化加固：到点回调（webhook）、失败重试、每日上限。
 *
 * 这里的回调不是 mock 出来的：真起一个 http 服务器、真发 POST、真收 body，
 * 断言的依据是服务器端收到的内容，不是"函数被调用过"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeJob, normalizeWebhook, describeJob } from '../lib/automation/schedule.js';
import { createRunner } from '../lib/automation/runner.js';
import { loadState, pushRun, updateState } from '../lib/automation/store.js';

const T0 = Date.parse('2026-11-05T20:00:00+08:00');

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-hook-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** 真 HTTP 服务器：把每次收到的请求体收进 hits，返回指定状态码。 */
async function hookServer({ status = 200 } = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    hits,
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fakeBoard({ teams = [{ id: 'team_a' }], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async listTeams() { return teams; },
    async addTask(teamId, payload) {
      if (fail) throw new Error('板子炸了');
      calls.push({ teamId, payload });
      return { id: `task_${calls.length}` };
    },
  };
}

function seedJob(root, job) {
  const saved = updateState({ root }, (state) => { state.jobs.push(job); });
  assert.ok(saved.ok, `落盘失败：${saved.error}`);
}

/* ── 1. 地址规范化：只认 http/https ─────────────────────────────────────── */

test('webhook 只收 http/https：字符串、对象、非法协议各有明确结果', () => {
  assert.equal(normalizeWebhook(null), null);
  assert.equal(normalizeWebhook(''), null);
  assert.equal(normalizeWebhook('ftp://x/y'), null, 'ftp 不该被接受');
  assert.equal(normalizeWebhook('file:///C:/secret.txt'), null, 'file 协议必须拒掉');
  assert.equal(normalizeWebhook('data:text/plain,hi'), null, 'data 协议必须拒掉');
  assert.equal(normalizeWebhook('不是个网址'), null);

  const a = normalizeWebhook('https://example.com/x');
  assert.equal(a.url, 'https://example.com/x');
  assert.equal(a.method, 'POST');
  assert.equal(a.on, 'always');

  const b = normalizeWebhook({ url: 'http://127.0.0.1:1/h', on: 'fail', method: 'put', timeoutMs: 500 });
  assert.equal(b.method, 'PUT');
  assert.equal(b.on, 'fail');
  assert.equal(b.timeoutMs, 1000, '超时要被夹到 1 秒起');
});

test('normalizeJob 对配错的 webhook 当场报错，不悄悄不生效', () => {
  const bad = normalizeJob({ title: 'x', every: '10m', webhook: 'ftp://x/y' }, { now: () => T0 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /http\/https/);
});

/* ── 2. 真回调：服务器真的收到了 ────────────────────────────────────────── */

test('到点回调：真 HTTP 服务器收到 POST，body 里有任务名和结果', async () => {
  const { root, done } = freshRoot('hit');
  const board = fakeBoard();
  const srv = await hookServer();
  try {
    const runner = createRunner({ root, deps: { board }, now: () => T0 });
    seedJob(root, {
      id: 'job_hook', title: '每天汇报', action: 'task', every: 10 * 60 * 1000, at: null,
      role: 'worker', teamId: 'team_a', enabled: true, runCount: 0, maxRuns: null,
      nextAt: new Date(T0).toISOString(), attempts: 0,
      webhook: normalizeWebhook(srv.url),
    });

    const out = await runner.tick({ nowMs: T0 });
    assert.equal(out.executed.length, 1, '该跑的没跑');
    assert.equal(srv.hits.length, 1, '回调没发出去');
    const got = JSON.parse(srv.hits[0].body);
    assert.equal(srv.hits[0].method, 'POST');
    assert.equal(got.jobId, 'job_hook');
    assert.equal(got.title, '每天汇报');
    assert.equal(got.ok, true);
    assert.match(got.detail, /team_a/, '回调里得带上落到哪个小组');

    // 回调结果也记进 runs，事后查得到
    const state = loadState({ root }).state;
    assert.equal(state.runs.at(-1).webhook.ok, true, 'runs 里没记回调结果');
  } finally {
    await srv.close();
    done();
  }
});

test('on:"fail" 时成功不发回调；on:"ok" 时失败不发', async () => {
  const { root, done } = freshRoot('on');
  const board = fakeBoard();
  const srv = await hookServer();
  try {
    const runner = createRunner({ root, deps: { board }, now: () => T0 });
    seedJob(root, {
      id: 'job_only_fail', title: '只在失败时喊我', action: 'task', every: 10 * 60 * 1000, at: null,
      role: 'worker', teamId: 'team_a', enabled: true, runCount: 0, maxRuns: null,
      nextAt: new Date(T0).toISOString(), attempts: 0,
      webhook: normalizeWebhook({ url: srv.url, on: 'fail' }),
    });
    await runner.tick({ nowMs: T0 });
    assert.equal(srv.hits.length, 0, '成功了不该发 fail 回调');
    const last = loadState({ root }).state.runs.at(-1);
    assert.equal(last.webhook.skipped, 'on-fail');
  } finally {
    await srv.close();
    done();
  }
});

test('回调发不出去不算任务失败：任务照样算成功，回调结果如实记失败', async () => {
  const { root, done } = freshRoot('dead');
  const board = fakeBoard();
  try {
    const runner = createRunner({ root, deps: { board }, now: () => T0 });
    // 指向一个没人听的端口
    seedJob(root, {
      id: 'job_dead_hook', title: '回调没人收', action: 'task', every: 10 * 60 * 1000, at: null,
      role: 'worker', teamId: 'team_a', enabled: true, runCount: 0, maxRuns: null,
      nextAt: new Date(T0).toISOString(), attempts: 0,
      webhook: normalizeWebhook({ url: 'http://127.0.0.1:1/dead', timeoutMs: 1000 }),
    });

    const out = await runner.tick({ nowMs: T0 });
    assert.equal(out.executed[0].ok, true, '回调失败不该把任务判成失败');
    const last = loadState({ root }).state.runs.at(-1);
    assert.equal(last.ok, true);
    assert.equal(last.webhook.ok, false, '回调失败要如实记下来');
    assert.ok(board.calls.length === 1, '任务本身该照常落到板子上');
  } finally {
    done();
  }
});

/* ── 3. 失败重试 ───────────────────────────────────────────────────────── */

test('失败重试：按退避排下一次，重试期间不推进到正常周期', async () => {
  const { root, done } = freshRoot('retry');
  const board = fakeBoard({ fail: true });
  try {
    const runner = createRunner({ root, deps: { board }, now: () => T0 });
    seedJob(root, {
      id: 'job_retry', title: '板子会炸', action: 'task', every: 60 * 60 * 1000, at: null,
      role: 'worker', teamId: 'team_a', enabled: true, runCount: 0, maxRuns: null,
      nextAt: new Date(T0).toISOString(), attempts: 0,
      retry: { max: 2, backoffMs: 60 * 1000 },
    });

    // 第一次失败 → 排 1 分钟后重试
    const first = await runner.tick({ nowMs: T0 });
    assert.equal(first.executed[0].ok, false);
    assert.equal(first.executed[0].retrying, true, '第一次失败该排重试');
    let job = loadState({ root }).state.jobs[0];
    assert.equal(job.attempts, 1);
    assert.equal(Date.parse(job.nextAt) - T0, 60 * 1000, `退避不对：${job.nextAt}`);
    assert.equal(job.lastStatus, 'retrying');

    // 还没到重试点：不跑
    const between = await runner.tick({ nowMs: T0 + 30 * 1000 });
    assert.equal(between.executed.length, 0, '没到退避时间就跑了');

    // 到点重试 → 退避翻倍到 2 分钟
    const second = await runner.tick({ nowMs: T0 + 60 * 1000 });
    assert.equal(second.executed[0].retrying, true);
    job = loadState({ root }).state.jobs[0];
    assert.equal(job.attempts, 2);
    assert.equal(Date.parse(job.nextAt) - (T0 + 60 * 1000), 120 * 1000, '退避没翻倍');

    // 再来一次：超出 max=2，不再重试，回到正常周期
    const third = await runner.tick({ nowMs: T0 + 180 * 1000 });
    assert.equal(third.executed[0].retrying, false, '超过 max 之后不该再重试');
    job = loadState({ root }).state.jobs[0];
    assert.equal(job.lastStatus, 'failed');
    assert.ok(Date.parse(job.nextAt) > T0 + 180 * 1000, '该回到正常周期了');
  } finally {
    done();
  }
});

test('重试期间成功了一次就清零 attempts', async () => {
  const { root, done } = freshRoot('reset');
  let boom = true;
  const board = {
    async listTeams() { return [{ id: 'team_a' }]; },
    async addTask() { if (boom) throw new Error('先炸一次'); return { id: 'task_x' }; },
  };
  try {
    const runner = createRunner({ root, deps: { board }, now: () => T0 });
    seedJob(root, {
      id: 'job_reset', title: '会好起来的', action: 'task', every: 60 * 60 * 1000, at: null,
      role: 'worker', teamId: 'team_a', enabled: true, runCount: 0, maxRuns: null,
      nextAt: new Date(T0).toISOString(), attempts: 0,
      retry: { max: 3, backoffMs: 60 * 1000 },
    });
    await runner.tick({ nowMs: T0 });
    assert.equal(loadState({ root }).state.jobs[0].attempts, 1);

    boom = false;
    await runner.tick({ nowMs: T0 + 60 * 1000 });
    const job = loadState({ root }).state.jobs[0];
    assert.equal(job.attempts, 0, '成功之后 attempts 该清零');
    assert.equal(job.pendingRetryAt, null);
    assert.equal(job.lastStatus, 'ok');
  } finally {
    done();
  }
});

/* ── 4. 每日上限 ──────────────────────────────────────────────────────── */

test('每日上限：当天跑满就不跑，记录写明跳过原因，第二天恢复', async () => {
  const { root, done } = freshRoot('cap');
  const board = fakeBoard();
  try {
    const runner = createRunner({ root, deps: { board }, now: () => T0 });
    seedJob(root, {
      id: 'job_cap', title: '别刷屏', action: 'task', every: 60 * 1000, at: null,
      role: 'worker', teamId: 'team_a', enabled: true, runCount: 0, maxRuns: null,
      nextAt: new Date(T0).toISOString(), attempts: 0,
      maxRunsPerDay: 2,
    });

    // 手工先把今天的用量写到 2 次
    updateState({ root }, (state) => {
      pushRun(state, { at: T0 - 1000, jobId: 'job_cap', ok: true, detail: '第一次' });
      pushRun(state, { at: T0 - 500, jobId: 'job_cap', ok: true, detail: '第二次' });
    });

    const out = await runner.tick({ nowMs: T0 });
    assert.equal(out.executed.length, 0, '超了每日上限还跑');
    assert.equal(out.skippedJobs.length, 1);
    assert.equal(out.skippedJobs[0].reason, 'daily-limit');
    assert.equal(board.calls.length, 0, '不该往板子上加任务');

    const state = loadState({ root }).state;
    assert.equal(state.jobs[0].lastStatus, 'daily-limit');
    assert.match(state.runs.at(-1).detail, /今天已经跑满 2 次/);

    // 第二天（+24h）恢复
    const nextDay = T0 + 24 * 60 * 60 * 1000;
    const out2 = await runner.tick({ nowMs: nextDay });
    assert.equal(out2.executed.length, 1, '第二天该恢复');
  } finally {
    done();
  }
});

/* ── 5. 描述里能看见新能力 ─────────────────────────────────────────────── */

test('describeJob 把重试/回调/每日上限/等重试都写出来', () => {
  const { job } = normalizeJob({
    title: '全都要', every: '10m', maxRuns: 5, maxRunsPerDay: 3,
    retry: { max: 2, backoffMs: 30000 },
    webhook: 'https://example.com/hook',
  }, { now: () => T0 });
  const text = describeJob(job);
  assert.match(text, /最多 5 次/);
  assert.match(text, /每天最多 3 次/);
  assert.match(text, /失败重试 2 次/);
  assert.match(text, /回调/);
});
