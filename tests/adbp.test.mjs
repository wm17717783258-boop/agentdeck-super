/**
 * tests/adbp.test.mjs —— 自研 ADBP 接入层（lib/engine/adbp.js）的单测。
 *
 * 验的是"任何语言的 Agent 只靠 HTTP 就能加入团队"这条承诺：
 *   · 自描述：GET /manifest 一个请求就能看懂协议、版本、能力、怎么带 token
 *   · 拉取式：/tasks 带 wait 长轮询（有活立刻返回、没活超时 200 + task:null，绝不 500）
 *   · 幂等：/result 同一个 taskId 重复提交只认第一次（远程客户端会重试）
 *   · 无状态：任务状态全在 board 上，ingress 内存里不留任务，重连只带 memberId
 *
 * board 用本地假实现（同步 + 异步两个版本），按 CONTRACTS §2.1 的鸭子类型，
 * 不 import 队友的 board.js —— 接入层对 board 只依赖"有这些方法"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { ADBP_VERSION, createIngress } from '../lib/engine/adbp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isThenable = (v) => Boolean(v && typeof v.then === 'function');

/**
 * 假任务板：严格的同步实现，语义对齐 CONTRACTS §2.1。
 * 额外记 calls.completeTask / calls.failTask 计数，用来验"幂等 = 只落一次账"。
 */
function makeBoard() {
  const state = { teams: [], tasks: [], events: [], members: [], seq: 0 };
  const calls = { completeTask: 0, failTask: 0, addMember: 0, claimTask: 0 };
  const nextId = (p) => `${p}-${++state.seq}`;
  const findTask = (id) => state.tasks.find((t) => t.id === id);
  const teamTasks = (teamId) => state.tasks.filter((t) => t.teamId === teamId);

  const board = {
    createTeam(input) {
      const team = { id: nextId('team'), name: input?.name || '团队', description: input?.description || '' };
      state.teams.push(team);
      return team;
    },
    getTeam(teamId) {
      return state.teams.find((t) => t.id === teamId) || null;
    },
    listTeams() {
      return state.teams;
    },
    addMember(teamId, input) {
      calls.addMember += 1;
      const member = { id: nextId('m'), teamId, name: input?.name || '', kind: input?.kind || 'adbp', role: input?.role || 'member' };
      state.members.push(member);
      return member;
    },
    listMembers(teamId) {
      return state.members.filter((m) => m.teamId === teamId);
    },
    addTask(teamId, input) {
      const task = {
        id: nextId('task'),
        teamId,
        title: input?.title || input?.subject || '活',
        acceptance: input?.acceptance || '',
        status: 'pending',
        assignee: null,
      };
      state.tasks.push(task);
      return task;
    },
    listTasks(teamId) {
      return teamTasks(teamId);
    },
    claimTask(teamId, taskId, memberId) {
      calls.claimTask += 1;
      const task = findTask(taskId);
      if (!task || task.status !== 'pending') return null;
      task.status = 'claimed';
      task.assignee = memberId;
      return task;
    },
    completeTask(teamId, taskId, payload) {
      calls.completeTask += 1;
      const task = findTask(taskId);
      if (task) {
        task.status = 'done';
        task.output = payload?.output ?? '';
      }
      return task || null;
    },
    failTask(teamId, taskId, payload) {
      calls.failTask += 1;
      const task = findTask(taskId);
      if (task) {
        task.status = 'failed';
        task.note = payload?.note || '';
      }
      return task || null;
    },
    nextTaskFor(teamId, memberId) {
      const free = teamTasks(teamId).find((t) => t.status === 'pending' && !t.assignee);
      if (!free) return null;
      free.status = 'claimed';
      free.assignee = memberId;
      return free;
    },
    /** 契约里的异步方法：等到有活或超时 */
    waitForTask(teamId, memberId, { timeoutMs = 1000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      return (async () => {
        while (Date.now() < deadline) {
          const free = teamTasks(teamId).find((t) => t.status === 'pending' && !t.assignee);
          if (free) {
            free.status = 'claimed';
            free.assignee = memberId;
            return free;
          }
          await sleep(15);
        }
        return null;
      })();
    },
    appendEvent(teamId, event) {
      const full = { id: nextId('ev'), teamId, ...event };
      state.events.push(full);
      return full;
    },
    listEvents(teamId) {
      return state.events.filter((e) => e.teamId === teamId);
    },
    stats(teamId) {
      const list = teamTasks(teamId);
      return { total: list.length, done: list.filter((t) => t.status === 'done').length };
    },
  };
  return { board, state, calls };
}

/** 假任务板（异步版）：每个方法都返回 Promise，验 handler 对异步 board 的兼容。 */
function makeAsyncBoard() {
  const { board, state, calls } = makeBoard();
  const wrapped = {};
  for (const [name, fn] of Object.entries(board)) {
    wrapped[name] = (...args) => Promise.resolve().then(() => fn(...args));
  }
  return { board: wrapped, state, calls };
}

/** 一次握手，返回带 Authorization 的请求头。 */
async function hello(ingress, extra = {}) {
  const out = await ingress.handler('POST', '/adbp/v1/hello', { name: '远程工位', kind: 'adbp', ...extra });
  assert.equal(out.status, 200, JSON.stringify(out.json));
  return { token: out.json.token, memberId: out.json.memberId, teamId: out.json.teamId, headers: { authorization: `Bearer ${out.json.token}` } };
}

// ── 自描述 / 路由边界 ────────────────────────────────────

test('manifest 自描述：一个 GET 就能看懂版本、能力、路由、鉴权方式', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board, name: '测试用的团队服务' });
  const out = await ingress.handler('GET', '/adbp/v1/manifest');

  assert.equal(out.status, 200);
  const m = out.json;
  assert.equal(m.protocol, 'adbp');
  assert.equal(m.version, ADBP_VERSION);
  assert.equal(m.name, '测试用的团队服务');
  for (const cap of ['manifest', 'hello', 'tasks', 'long-poll', 'result', 'chat', 'state']) {
    assert.ok(m.capabilities.includes(cap), `capabilities 缺 ${cap}`);
  }
  // 六个路由全在 endpoints 里，且每条都写清 auth 要不要
  assert.equal(m.endpoints.length, 6);
  assert.ok(m.endpoints.every((e) => e.method && e.path.startsWith('/adbp/v1/') && typeof e.auth === 'boolean'));
  assert.match(m.auth, /Bearer/);
  // 拉取式 + 幂等 + 长轮询超时行为都要在自描述里写明（外部 Agent 只读这个文件写客户端）
  const notes = m.notes.join('\n');
  assert.match(notes, /拉取式/);
  assert.match(notes, /以服务端 board 为准/);
  assert.match(notes, /task: null/);
});

test('不是 /adbp/v1 开头的路径返回 null，宿主可以继续交给别的路由', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board });
  assert.equal(await ingress.handler('GET', '/api/health'), null);
  assert.equal(await ingress.handler('POST', '/'), null);
  assert.equal(await ingress.handler('GET', '/adbp'), null, '/adbp 不是 /adbp/v1，也不该抢');
});

test('未知子路由 404 且把可用路由带回去（方便人排查）', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board });
  // 未鉴权的未知路径先撞 401：不向匿名调用方暴露路由表
  assert.equal((await ingress.handler('GET', '/adbp/v1/nope')).status, 401);
  const { headers } = await hello(ingress);
  const out = await ingress.handler('GET', '/adbp/v1/nope', null, headers);
  assert.equal(out.status, 404);
  assert.match(out.json.error, /未知路由/);
  assert.match(out.json.manifest.state, /^GET \/adbp\/v1\/state/);
});

test('方法不对给 405（manifest 只收 GET、result/chat 只收 POST）', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board });
  const { headers } = await hello(ingress);
  assert.equal((await ingress.handler('POST', '/adbp/v1/manifest')).status, 405);
  assert.equal((await ingress.handler('GET', '/adbp/v1/result', null, headers)).status, 405);
  assert.equal((await ingress.handler('GET', '/adbp/v1/chat', null, headers)).status, 405);
  assert.equal((await ingress.handler('POST', '/adbp/v1/state', null, headers)).status, 405);
});

// ── 握手 / 鉴权 ──────────────────────────────────────────

test('hello 换 token：自动建团队、把远程 Agent 加成成员', async () => {
  const { board, state, calls } = makeBoard();
  const ingress = createIngress({ board });
  const out = await ingress.handler('POST', '/adbp/v1/hello', { name: '远程工位', kind: 'openai' });

  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.protocol, 'adbp');
  assert.match(out.json.token, /^[0-9a-f]{48}$/);
  assert.ok(out.json.teamId, 'should create/find a team');
  assert.ok(out.json.memberId);
  assert.equal(calls.addMember, 1);
  assert.equal(state.members[0].name, '远程工位');
  assert.equal(state.members[0].kind, 'openai');
  // token 记在 ingress 里，外部拿不到别人的 token
  assert.equal(ingress.tokens.size, 1);
});

test('没注入 board 时：manifest 照样能读，hello 说清 503 原因（不崩）', async () => {
  const ingress = createIngress({});
  const man = await ingress.handler('GET', '/adbp/v1/manifest');
  assert.equal(man.status, 200);
  const out = await ingress.handler('POST', '/adbp/v1/hello', { name: 'x' });
  assert.equal(out.status, 503);
  assert.equal(out.json.error, 'board-unavailable');
  assert.match(out.json.hint, /任务板/);
});

test('鉴权：没 token 一律 401，且 hint 教怎么拿 token', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board });
  for (const [method, path] of [
    ['GET', '/adbp/v1/tasks'],
    ['POST', '/adbp/v1/result'],
    ['POST', '/adbp/v1/chat'],
    ['GET', '/adbp/v1/state'],
  ]) {
    const out = await ingress.handler(method, path, {});
    assert.equal(out.status, 401, `${method} ${path} 应该 401`);
    assert.match(out.json.hint, /hello/);
  }
});

test('token 三种带法都认：Bearer / x-adbp-token / ?token=', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board });
  const { token } = await hello(ingress);
  const state = (headers, path) => ingress.handler('GET', path, {}, headers);

  assert.equal((await state({ authorization: `Bearer ${token}` }, '/adbp/v1/state')).status, 200);
  assert.equal((await state({ 'x-adbp-token': token }, '/adbp/v1/state')).status, 200);
  assert.equal((await state(null, `/adbp/v1/state?token=${token}`)).status, 200);
  // Headers 实例也要认（node:http 原生请求头就是这个形态）
  assert.equal((await state(new Headers({ authorization: `Bearer ${token}` }), '/adbp/v1/state')).status, 200);
  // 假 token 当然不行
  assert.equal((await state({ authorization: 'Bearer 假的' }, '/adbp/v1/state')).status, 401);
});

// ── 领活：即时 / 长轮询 ─────────────────────────────────

test('tasks：有活就领走（board 上状态变 claimed），没活立刻回 task:null', async () => {
  const { board, state } = makeBoard();
  const ingress = createIngress({ board });
  const { headers, memberId } = await hello(ingress);
  const teamId = state.teams[0].id;
  board.addTask(teamId, { title: '翻译一页文档' });

  const first = await ingress.handler('GET', `/adbp/v1/tasks?memberId=${memberId}`, null, headers);
  assert.equal(first.status, 200);
  assert.equal(first.json.task.title, '翻译一页文档');
  assert.equal(first.json.task.status, 'claimed');
  assert.equal(first.json.task.id, state.tasks[0].id);

  const second = await ingress.handler('GET', `/adbp/v1/tasks?memberId=${memberId}`, null, headers);
  assert.equal(second.status, 200);
  assert.equal(second.json.task, null, '没活要回 task:null，让客户端睡一会儿再来');
});

test('长轮询：任务在等待期间出现就立刻返回（不是等满 wait）', async () => {
  const { board, state } = makeBoard();
  const ingress = createIngress({ board });
  const { headers, memberId } = await hello(ingress);
  const teamId = state.teams[0].id;

  const startedAt = Date.now();
  const pending = ingress.handler('GET', `/adbp/v1/tasks?wait=10&memberId=${memberId}`, null, headers);
  assert.ok(isThenable(pending), '带 wait 的路由必须返回 Promise，宿主 await 一次即可');
  await sleep(120);
  board.addTask(teamId, { title: '插队来的活' });
  const out = await pending;
  const elapsed = Date.now() - startedAt;

  assert.equal(out.status, 200);
  assert.ok(out.json.task.title, '插队来的活');
  assert.ok(elapsed < 800, `有活应该秒回，实际等了 ${elapsed}ms（等满一整拍说明 board 参数传错了）`);
});

test('长轮询：没活就按时收场，返回 200 + task:null（绝不 500），并受 maxWaitSec 夹紧', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board, maxWaitSec: 1 });
  const { headers, memberId } = await hello(ingress);

  const startedAt = Date.now();
  const out = await ingress.handler('GET', `/adbp/v1/tasks?wait=99&memberId=${memberId}`, null, headers);
  const elapsed = Date.now() - startedAt;

  assert.equal(out.status, 200, '超时必须 200，客户端不该把它当错误');
  assert.equal(out.json.ok, true);
  assert.equal(out.json.task, null);
  assert.equal(out.json.waitedSec, 1, 'wait=99 要按 maxWaitSec=1 夹紧');
  assert.ok(elapsed >= 900 && elapsed < 3000, `大约等 1s，实际 ${elapsed}ms`);
});

test('不带 wait 的 tasks 是同步返回（board 同步时不该变成 Promise）', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board });
  const { headers } = await hello(ingress);
  const out = ingress.handler('GET', '/adbp/v1/tasks', null, headers);
  assert.equal(isThenable(out), false, '同步 board 上必须同步返回，宿主的同步 HTTP 处理才不用改');
  assert.equal(out.status, 200);
});

// ── 交活：幂等 ──────────────────────────────────────────

test('result：完成任务、写 board、留一条团队时间线', async () => {
  const { board, state, calls } = makeBoard();
  const events = [];
  const ingress = createIngress({ board, onEvent: (e) => events.push(e) });
  const { headers, memberId } = await hello(ingress);
  const teamId = state.teams[0].id;
  const task = board.addTask(teamId, { title: '写个 README' });

  const out = await ingress.handler('POST', '/adbp/v1/result', { taskId: task.id, ok: true, output: '写好了' }, headers);
  assert.equal(out.status, 200);
  assert.equal(out.json.duplicate, false);
  assert.equal(calls.completeTask, 1);
  assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.tasks[0].output, '写好了');
  // 时间线：appendEvent 落到 board，onEvent 推给宿主 UI
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, 'result');
  assert.equal(events.length, 1);
  assert.match(events[0].text, /任务 .* 完成/);

  // ok:false 走 failTask，不碰 completeTask
  const bad = board.addTask(teamId, { title: '跑不动的活' });
  const failed = await ingress.handler('POST', '/adbp/v1/result', { taskId: bad.id, ok: false, note: '缺依赖' }, headers);
  assert.equal(failed.status, 200);
  assert.equal(calls.failTask, 1);
  assert.equal(state.tasks[1].status, 'failed');
});

test('result 幂等：同一个 taskId 重复提交只落一次账，第二次回 duplicate:true', async () => {
  const { board, state, calls } = makeBoard();
  const ingress = createIngress({ board });
  const { headers } = await hello(ingress);
  const task = board.addTask(state.teams[0].id, { title: '会被重试的活' });

  const first = await ingress.handler('POST', '/adbp/v1/result', { taskId: task.id, ok: true, output: '第一次' }, headers);
  const second = await ingress.handler('POST', '/adbp/v1/result', { taskId: task.id, ok: true, output: '重试' }, headers);
  const third = await ingress.handler('POST', '/adbp/v1/result', { taskId: task.id, ok: true, output: '又重试' }, headers);

  assert.equal(first.json.duplicate, false);
  assert.equal(second.json.duplicate, true, '第二次必须标 duplicate');
  assert.equal(third.json.duplicate, true);
  assert.equal(second.status, 200, '重试不是错误，必须 200');
  assert.equal(calls.completeTask, 1, 'completeTask 只能被调一次');
  assert.equal(state.tasks[0].output, '第一次', '重复提交不许覆盖已有结果');
});

test('result 幂等第二道：进程重启（新 ingress）后仍以 board 为准', async () => {
  const { board, state } = makeBoard();
  const first = createIngress({ board });
  const { headers } = await hello(first);
  const task = board.addTask(state.teams[0].id, { title: '重启前交过的活' });
  await first.handler('POST', '/adbp/v1/result', { taskId: task.id, ok: true, output: '交过了' }, headers);

  // 模拟重启：内存全丢，只剩 board
  const restarted = createIngress({ board });
  const { headers: h2 } = await hello(restarted);
  const out = await restarted.handler('POST', '/adbp/v1/result', { taskId: task.id, ok: true }, h2);
  assert.equal(out.status, 200);
  assert.equal(out.json.duplicate, true, 'board 上已结束的任务不该被重新记一次账');
});

test('result 缺 taskId 回 400（别默默成功）', async () => {
  const { board } = makeBoard();
  const ingress = createIngress({ board });
  const { headers } = await hello(ingress);
  const out = await ingress.handler('POST', '/adbp/v1/result', { ok: true }, headers);
  assert.equal(out.status, 400);
  assert.match(out.json.error, /taskId/);
});

test('board 方法带默认参数（fn.length 会说谎）时参数顺序也不能错', async () => {
  const seen = { addMember: null, listTasks: [] };
  const team = { id: 'team-d', name: 'D 队' };
  const board = {
    listTeams: () => [team],
    addMember(teamId, input = {}) {
      seen.addMember = [teamId, input.name, input.kind];
      return { id: 'm-d', teamId };
    },
    listTasks(teamId = '') {
      seen.listTasks.push(teamId);
      return [];
    },
    getTeam: () => team,
    stats: () => ({ total: 0, done: 0 }),
  };
  const ingress = createIngress({ board });
  const out = await ingress.handler('POST', '/adbp/v1/hello', { name: '默认参数工位', kind: 'cdp' });
  assert.equal(out.status, 200);
  assert.equal(out.json.teamId, 'team-d');
  assert.equal(out.json.memberId, 'm-d');
  assert.deepEqual(seen.addMember, ['team-d', '默认参数工位', 'cdp'], 'addMember 的第一个参数必须是 teamId');

  await ingress.handler('GET', '/adbp/v1/state', null, { authorization: `Bearer ${out.json.token}` });
  assert.deepEqual(seen.listTasks, ['team-d'], 'listTasks 也必须收到 teamId');
});

// ── 群聊 / 状态 ─────────────────────────────────────────

test('chat：写一条团队事件并推给宿主，空文本 400', async () => {
  const { board, state } = makeBoard();
  const pushed = [];
  const ingress = createIngress({ board, onEvent: (e) => pushed.push(e) });
  const { headers, memberId } = await hello(ingress);

  const out = await ingress.handler('POST', '/adbp/v1/chat', { text: '我这边在跑测试，10 分钟后回来' }, headers);
  assert.equal(out.status, 200);
  assert.equal(out.json.memberId, memberId);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, 'chat');
  assert.match(state.events[0].text, /10 分钟后回来/);
  assert.equal(pushed.length, 1);
  assert.ok(pushed[0].at, '事件要带时间戳');

  assert.equal((await ingress.handler('POST', '/adbp/v1/chat', { text: '' }, headers)).status, 400);
});

test('state：给外部 Agent 一份团队 / 任务 / 统计快照', async () => {
  const { board, state } = makeBoard();
  const ingress = createIngress({ board });
  const { headers } = await hello(ingress);
  board.addTask(state.teams[0].id, { title: '有活' });

  const out = await ingress.handler('GET', '/adbp/v1/state', null, headers);
  assert.equal(out.status, 200);
  assert.equal(out.json.team.id, state.teams[0].id);
  assert.equal(out.json.tasks.length, 1);
  assert.equal(out.json.tasks[0].title, '有活');
  assert.deepEqual(out.json.stats, { total: 1, done: 0 });
});

// ── 异步 board / 真 HTTP ────────────────────────────────

test('异步 board（方法都返回 Promise）：握手、领活、交活照样通', async () => {
  const asyncBoard = makeAsyncBoard();
  const ingress = createIngress({ board: asyncBoard.board });
  const res = await ingress.handler('POST', '/adbp/v1/hello', { name: '异步工位' });
  assert.equal(res.status, 200);
  const headers = { authorization: `Bearer ${res.json.token}` };
  const teamId = asyncBoard.state.teams[0].id;
  const task = await asyncBoard.board.addTask(teamId, { title: '异步板上的活' });

  const got = await ingress.handler('GET', '/adbp/v1/tasks', null, headers);
  assert.equal(got.status, 200);
  assert.equal(got.json.task.id, task.id);

  const done = await ingress.handler('POST', '/adbp/v1/result', { taskId: task.id, ok: true, output: 'ok' }, headers);
  assert.equal(done.status, 200);
  assert.equal(done.json.duplicate, false);
  // 异步板上真的落了状态（不是只回了 200 什么都没干）
  assert.equal(asyncBoard.state.tasks[0].status, 'done');
});

test('真 HTTP 一发：外部客户端只靠 fetch 就能入队（node:http 集成）', async () => {
  const { board, state } = makeBoard();
  const ingress = createIngress({ board });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const out = await ingress.handler(req.method, req.url, body, req.headers);
    if (!out) {
      res.writeHead(404).end('no route');
      return;
    }
    const text = JSON.stringify(out.json);
    res.writeHead(out.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const man = await (await fetch(`${base}/adbp/v1/manifest`)).json();
    assert.equal(man.protocol, 'adbp');

    const helloRes = await fetch(`${base}/adbp/v1/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'curl 也行的工位' }),
    });
    const session = await helloRes.json();
    assert.equal(helloRes.status, 200);
    const auth = { authorization: `Bearer ${session.token}` };

    board.addTask(session.teamId, { title: 'HTTP 来的活' });
    const tasks = await (await fetch(`${base}/adbp/v1/tasks?memberId=${session.memberId}`, { headers: auth })).json();
    assert.equal(tasks.task.title, 'HTTP 来的活');

    const result = await (
      await fetch(`${base}/adbp/v1/result`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: tasks.task.id, ok: true, output: '干完了' }),
      })
    ).json();
    assert.equal(result.ok, true);
    assert.equal(state.tasks[0].status, 'done');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
