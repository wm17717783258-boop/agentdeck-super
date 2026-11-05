/**
 * lib/engine/adbp.js —— 自研 ADBP 接入层（AgentDeck 接入层 · Part 3）
 *
 * ADBP = AgentDeck Bridge Protocol。解决的问题：
 *   "任何语言的 Agent，只要会发 HTTP，几十行代码就能加入这个团队。"
 *   不要求它是 Node、不要求它有 CLI、不要求支持 ACP/MCP。
 *
 * 本文件只做**服务端入口**：把 HTTP 请求翻译成 board（任务板）上的动作。
 * 六个路由（v1，全部挂在 `/adbp/v1` 前缀下）：
 *   GET  /manifest  公开  告诉外部 Agent：我是 ADBP 服务、版本、能力清单
 *   POST /hello     公开  注册成团队成员 → { teamId, memberId, token }
 *   GET  /tasks     鉴权  领活；带 `?wait=25` 时长轮询（这是唯一返回 Promise 的路由）
 *   POST /result    鉴权  交活：ok=true 完成任务，ok=false 记失败
 *   POST /chat      鉴权  往团队里说一句话（appendEvent + onEvent 推给宿主）
 *   GET  /state     鉴权  看团队、任务、统计（给外部 Agent 做上下文感知）
 *
 * 为什么 handler 签名是 (method, path, body, headers) 而不是 (req, res)：
 *   路由由宿主的 webServer 挂载（lib/index.js），本模块不碰网络、不建服务器。
 *   这样它既能被 webServer 调用，也能在单测里直接函数调用，还能在没有
 *   webServer 的环境里安全存在（构造即完成，不打印、不报错）。
 *
 * 为什么只有带 wait 的 /tasks 返回 Promise：
 *   契约里 handler 是同步的，但长轮询必须等。经 Lead 同意做了最小扩展：
 *     · 其余路由：board 方法是同步的（CONTRACTS §2.1），所以**同步**返回 {status,json}
 *     · 带 wait：返回 Promise<{status,json}>
 *   调用方 `await` 一次即可同时兼容两种形态。
 *
 * 为什么 board 只按鸭子类型调用、绝不 import 队友的 board.js：
 *   接入层和任务板是两条独立的演进线。board 由别人维护，接口按 CONTRACTS §2.1；
 *   这里只依赖"有这些方法"这一事实，参数顺序用 fn.length 猜 + 多形态兜底，
 *   将来 board 内部实现换了也不影响接入层。
 */

import { randomBytes } from 'node:crypto';

export const ADBP_VERSION = '1';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时：够跑完一批任务，又不会永久有效
const DEFAULT_MAX_WAIT_SEC = 30; // 长轮询上限：防止外面用 wait=99999 把连接占死
const POLL_SLICE_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isThenable = (v) => Boolean(v && typeof v.then === 'function');
const nowIso = () => new Date().toISOString();

/** 同步优先的"也许异步"：同步结果直接进 cont，Promise 则接上。 */
function maybe(value, cont) {
  return isThenable(value) ? value.then(cont) : cont(value);
}

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value.id || value.teamId || value.memberId || value.taskId || '');
}

/**
 * 调 board 上的某个方法：按契约顺序逐个形态试，同步抛错才换下一种。
 *
 * 为什么不用 fn.length 猜参数形态（曾经的写法，踩过坑）：
 *   `waitForTask(teamId, memberId, { timeoutMs = 1000 } = {})` 的 length 是 2，
 *   `addMember(teamId, input = {})` 的 length 是 1 —— 默认参数会让 length 说谎，
 *   一旦按 length 重排参数就会把 teamId 当 memberId 传进去，board 不报错、
 *   只是干错事（长轮询白等一整拍）。所以一律先按 CONTRACTS §2.1 的顺序调，
 *   只有同步抛错（比如旧版 board 少一个参数）才退到下一种形态。
 *
 * 只兜底同步失败——异步 board 的拒绝交给上层，不重试（避免重复建成员/重复交活）。
 */
function invoke(fn, argVariants, fallback = undefined) {
  if (typeof fn !== 'function') return fallback;
  let lastErr;
  for (const args of argVariants) {
    try {
      const out = fn(...args);
      if (isThenable(out)) return out;
      return out === undefined ? fallback : out;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return fallback;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] ?? '') : '';
}

function parsePath(path) {
  const raw = String(path || '');
  const qAt = raw.indexOf('?');
  const pathname = qAt >= 0 ? raw.slice(0, qAt) : raw;
  const search = qAt >= 0 ? raw.slice(qAt + 1) : '';
  const query = {};
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent((eq >= 0 ? pair.slice(0, eq) : pair).replace(/\+/g, ' '));
    const v = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')) : '';
    if (k) query[k] = v;
  }
  return {
    // 去掉结尾斜杠并统一小写，`/adbp/v1/` 和 `/ADBP/v1` 都能匹配上
    pathname: pathname.replace(/\/+$/, '').toLowerCase(),
    query,
  };
}

/**
 * 造一个 ADBP 服务端入口。
 * @param {object} opts
 * @param {object} [opts.board]   任务板（鸭子类型，见 CONTRACTS §2.1）。没有也允许：
 *                                构造不报错，只有 /hello 会回 503 说明原因。
 * @param {string} [opts.name]    展示给外部 Agent 的服务名
 * @param {string} [opts.teamId]  指定入组团队；不给就复用第一个团队，没有就建一个
 * @param {number} [opts.maxWaitSec=30] 长轮询上限（秒）
 * @param {Function} [opts.log]   日志函数，形如 log(level, msg)
 * @param {Function} [opts.onEvent] 团队事件回调（chat 等），宿主据此推给 UI
 * @returns {{ manifest: Function, handler: Function, tokens: Map }}
 */
export function createIngress(opts = {}) {
  const board = opts.board || null;
  const name = String(opts.name || 'agentdeck-super');
  const maxWaitSec = Number(opts.maxWaitSec) > 0 ? Number(opts.maxWaitSec) : DEFAULT_MAX_WAIT_SEC;
  const pinnedTeamId = opts.teamId ? String(opts.teamId) : '';
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  /** token → { teamId, memberId, name, kind, at } */
  const tokens = new Map();
  /** 已交过活的 taskId：远程客户端会重试，同一份结果只认第一次（幂等） */
  const doneResults = new Set();
  let cachedTeamId = '';
  let teamIdPromise = null;

  const safeLog = (level, msg) => {
    try {
      log(level, `[adbp] ${msg}`);
    } catch {
      /* 日志失败绝不能影响协议 */
    }
  };

  function manifest() {
    // 自描述：外部 Agent 只读这一个 GET 就该知道版本、团队、能干什么、怎么带 token
    return {
      protocol: 'adbp',
      version: ADBP_VERSION,
      name,
      teamId: pinnedTeamId || cachedTeamId || null,
      capabilities: ['manifest', 'hello', 'tasks', 'long-poll', 'result', 'chat', 'state'],
      endpoints: [
        { method: 'GET', path: '/adbp/v1/manifest', auth: false, desc: '本文件：协议自描述' },
        { method: 'POST', path: '/adbp/v1/hello', auth: false, desc: '注册成团队成员，换 token' },
        { method: 'GET', path: '/adbp/v1/tasks', auth: true, desc: '领活；?wait=25 时长轮询，超时返回 task:null' },
        { method: 'POST', path: '/adbp/v1/result', auth: true, desc: '交活；同 taskId 重复提交幂等' },
        { method: 'POST', path: '/adbp/v1/chat', auth: true, desc: '往团队里说一句话' },
        { method: 'GET', path: '/adbp/v1/state', auth: true, desc: '团队 / 任务 / 统计快照' },
      ],
      routes: {
        manifest: 'GET /adbp/v1/manifest',
        hello: 'POST /adbp/v1/hello {name,kind,capabilities?}',
        tasks: 'GET /adbp/v1/tasks?memberId=&wait=25',
        result: 'POST /adbp/v1/result {memberId,taskId,ok,output,note?}',
        chat: 'POST /adbp/v1/chat {memberId,text}',
        state: 'GET /adbp/v1/state?teamId=',
      },
      auth: 'hello 之后每次请求带 Authorization: Bearer <token>',
      notes: [
        'ADBP 是拉取式协议：服务端不会主动推任务，客户端自己轮询 /tasks',
        '任务状态以服务端 board 为准，客户端重连只需带 memberId，不缓存任务',
        '长轮询无任务时返回 200 + { task: null }（等同空数组），不会 500',
      ],
    };
  }

  // ── 团队 / 成员 ─────────────────────────────────────────

  function ensureTeamId() {
    if (pinnedTeamId) return pinnedTeamId;
    if (cachedTeamId) return cachedTeamId;
    if (teamIdPromise) return teamIdPromise;
    const teams = invoke(board?.listTeams, [[]], []);
    return maybe(teams, (raw) => {
      const list = Array.isArray(raw) ? raw : raw?.teams || [];
      if (list.length) {
        cachedTeamId = idOf(list[0]);
        if (cachedTeamId) return cachedTeamId;
      }
      const created = invoke(board?.createTeam, [
        [{ name: 'ADBP 团队', description: '通过 ADBP 接入的成员团队' }],
        ['ADBP 团队'],
      ]);
      return maybe(created, (team) => {
        cachedTeamId = idOf(team);
        return cachedTeamId;
      });
    });
  }

  function addMember(teamId, body) {
    return invoke(board?.addMember, [
      [teamId, { name: body.name, kind: body.kind || 'adbp', role: body.role || 'member', capabilities: body.capabilities || [] }],
      [{ teamId, name: body.name, kind: body.kind || 'adbp', role: body.role || 'member' }],
      [teamId, body.name, body.kind || 'adbp'],
    ], {});
  }

  // ── 任务 ────────────────────────────────────────────────

  function shapeTask(task) {
    if (!task) return null;
    return {
      id: idOf(task),
      title: task.title || task.subject || task.name || '',
      role: task.role || task.assigneeRole || '',
      acceptance: task.acceptance || task.acceptanceCriteria || task.detail || task.description || '',
      context: task.context || task.input || task.notes || {},
      status: task.status || 'pending',
    };
  }

  /** 领一个活：优先 nextTaskFor（board 自己保证原子性），否则 list+claim 兜底。 */
  function takeTask(teamId, memberId) {
    if (typeof board?.nextTaskFor === 'function') {
      const got = invoke(board.nextTaskFor, [
        [teamId, memberId],
        [memberId],
      ]);
      return maybe(got, (task) => (task ? shapeTask(task) : null));
    }
    if (typeof board?.listTasks === 'function' && typeof board?.claimTask === 'function') {
      const tasks = invoke(board.listTasks, [[teamId], []], []);
      return maybe(tasks, (raw) => {
        const free = (Array.isArray(raw) ? raw : []).find(
          (t) => (!t.status || t.status === 'pending') && !t.memberId && !t.assignee,
        );
        if (!free) return null;
        const claimed = invoke(board.claimTask, [
          [teamId, idOf(free), memberId],
          [idOf(free), memberId],
        ]);
        return maybe(claimed, () => shapeTask(free));
      });
    }
    return null;
  }

  /** 长轮询：一直等到有活或超时。只有这里一定是异步。 */
  async function waitForTask(teamId, memberId, waitMs) {
    const deadline = Date.now() + Math.max(0, waitMs);
    while (Date.now() < deadline) {
      const task = await takeTask(teamId, memberId);
      if (task) return task;
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      if (typeof board?.waitForTask === 'function') {
        // 用短切片调 waitForTask：既守契约的 Promise 语义，又能按时返回
        const got = await invoke(board.waitForTask, [
          [teamId, memberId, { timeoutMs: Math.min(remain, 1000) }],
          [memberId, { timeoutMs: Math.min(remain, 1000) }],
        ]);
        if (got) return shapeTask(got);
      } else {
        await sleep(Math.min(remain, POLL_SLICE_MS));
      }
    }
    return null;
  }

  function completeTask(teamId, body) {    const failed = body.ok === false;
    const fn = failed ? board?.failTask : board?.completeTask;
    if (typeof fn !== 'function') return false;
    const payload = {
      ok: !failed,
      output: String(body.output ?? ''),
      note: body.note ? String(body.note) : '',
    };
    const done = invoke(fn, [
      [teamId, String(body.taskId), payload],
      [String(body.taskId), payload],
      [String(body.taskId), payload.output],
    ]);
    return maybe(done, () => true);
  }

  async function appendChatEvent(teamId, event) {
    const full = { at: nowIso(), ...event };
    if (typeof board?.appendEvent === 'function') {
      const out = invoke(board.appendEvent, [
        [teamId, full],
        [{ teamId, ...full }],
      ]);
      try {
        await out;
      } catch (err) {
        safeLog('warn', `appendEvent 失败：${err?.message || err}`);
      }
    }
    if (onEvent) {
      try {
        const out = onEvent({ teamId, ...full });
        if (isThenable(out)) out.catch((err) => safeLog('warn', `onEvent 异步失败：${err?.message || err}`));
      } catch (err) {
        safeLog('warn', `onEvent 抛错：${err?.message || err}`);
      }
    }
  }

  // ── 鉴权 ────────────────────────────────────────────────

  function issueToken(teamId, memberId, body) {
    const token = randomBytes(24).toString('hex');
    tokens.set(token, {
      teamId,
      memberId,
      name: String(body.name || ''),
      kind: String(body.kind || 'adbp'),
      at: Date.now(),
    });
    return token;
  }

  function authenticate(body, headers, query) {
    let token = '';
    const auth = headerValue(headers, 'authorization');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) token = m[1].trim();
    if (!token) token = headerValue(headers, 'x-adbp-token').trim();
    if (!token) token = String(body?.token || query?.token || '').trim();
    const hit = token ? tokens.get(token) : null;
    if (!hit) return null;
    if (Date.now() - hit.at > TOKEN_TTL_MS) {
      tokens.delete(token);
      return null;
    }
    return hit;
  }

  const unauthorized = () => ({
    status: 401,
    json: { ok: false, error: 'unauthorized', hint: '先 POST /adbp/v1/hello 拿 token，再带 Authorization: Bearer <token>' },
  });

  // ── 路由实现 ────────────────────────────────────────────

  function routeHello(body) {
    if (!board) {
      return {
        status: 503,
        json: { ok: false, error: 'board-unavailable', hint: '宿主没有注入任务板，ADBP 只能读 /manifest' },
      };
    }
    return maybe(ensureTeamId(), (teamId) => {
      if (!teamId) return { status: 500, json: { ok: false, error: '无法创建或找到团队' } };
      return maybe(addMember(teamId, body), (member) => {
        // board 没给 member.id 时自己造一个：token 照样能用于后续请求
        const memberId = idOf(member) || `adbp-${randomBytes(4).toString('hex')}`;
        const token = issueToken(teamId, memberId, body);
        safeLog('info', `hello name=${body.name || '?'} kind=${body.kind || 'adbp'} member=${memberId}`);
        return {
          status: 200,
          json: { ok: true, teamId, memberId, token, protocol: 'adbp', version: ADBP_VERSION },
        };
      });
    });
  }

  function routeTasks(body, query, auth) {
    const memberId = String(query.memberId || body?.memberId || auth.memberId);
    const waitSec = Math.min(Math.max(Number(query.wait) || 0, 0), maxWaitSec);
    if (waitSec > 0) {
      // 长轮询：只有这一条路径返回 Promise
      return waitForTask(auth.teamId, memberId, waitSec * 1000).then((task) => ({
        status: 200,
        json: { ok: true, task, waitedSec: waitSec },
      }));
    }
    return maybe(takeTask(auth.teamId, memberId), (task) => ({ status: 200, json: { ok: true, task } }));
  }

  /**
   * 这个任务在 board 上是不是已经结束过了？
   * 只读 listTasks 判断，不新增对 board 的方法依赖；board 不可用时返回 null（当成没结束）。
   */
  function finishedOnBoard(teamId, taskId) {
    if (typeof board?.listTasks !== 'function') return null;
    const tasks = invoke(board.listTasks, [[teamId], []], []);
    return maybe(tasks, (raw) => {
      const hit = (Array.isArray(raw) ? raw : []).find((t) => idOf(t) === taskId);
      if (!hit) return null;
      const st = String(hit.status || '').toLowerCase();
      const open = !st || ['pending', 'claimed', 'in_progress', 'in-progress', 'running', 'doing'].includes(st);
      return open ? null : hit;
    });
  }

  function routeResult(body, auth) {
    const taskId = String(body.taskId || '');
    if (!taskId) return { status: 400, json: { ok: false, error: '缺少 taskId' } };
    const memberId = String(body.memberId || auth.memberId);

    // 幂等第一道：本进程已经收过这个 taskId（客户端超时重试最常见）
    if (doneResults.has(taskId)) {
      return { status: 200, json: { ok: true, duplicate: true, taskId } };
    }

    // 幂等第二道：进程重启后仍以 board 为准（内存里什么都不留）
    return maybe(finishedOnBoard(auth.teamId, taskId), (finished) => {
      if (finished) {
        doneResults.add(taskId);
        return { status: 200, json: { ok: true, duplicate: true, taskId } };
      }
      return maybe(completeTask(auth.teamId, body), (done) => {
        if (!done) return { status: 503, json: { ok: false, error: 'board 没有 completeTask/failTask' } };
        doneResults.add(taskId);
        // 交完活顺手在团队时间线留一条，方便人和别的 Agent 看到进展
        appendChatEvent(auth.teamId, {
          memberId,
          type: 'result',
          taskId,
          text: `任务 ${taskId} ${body.ok === false ? '失败' : '完成'}`,
          note: body.note ? String(body.note) : '',
        });
        return { status: 200, json: { ok: true, duplicate: false, taskId } };
      });
    });
  }

  function routeChat(body, auth) {
    const text = String(body.text || '');
    if (!text) return { status: 400, json: { ok: false, error: '缺少 text' } };
    const memberId = String(body.memberId || auth.memberId);
    appendChatEvent(auth.teamId, { memberId, type: 'chat', text });
    return { status: 200, json: { ok: true, memberId } };
  }

  function routeState(query, auth) {
    const teamId = String(query.teamId || auth.teamId);
    const team = invoke(board?.getTeam, [[teamId], []], null);
    const tasks = invoke(board?.listTasks, [[teamId], []], []);
    const stats = invoke(board?.stats, [[teamId], []], null);
    return maybe(team, (teamVal) =>
      maybe(tasks, (taskList) =>
        maybe(stats, (stat) => ({
          status: 200,
          json: {
            ok: true,
            team: teamVal,
            tasks: (Array.isArray(taskList) ? taskList : []).map(shapeTask),
            stats: stat || null,
          },
        })),
      ),
    );
  }

  // ── 入口 ────────────────────────────────────────────────

  /**
   * 处理一个 ADBP 请求。
   * @param {string} method  HTTP 方法（大小写不敏感）
   * @param {string} path    路径，可带 query（`/adbp/v1/tasks?wait=25`）
   * @param {object} [body]  已解析的 JSON body
   * @param {object} [headers] 原始请求头（可以是 Headers 实例或普通对象）
   * @returns {{status:number, json:object}|null|Promise<{status:number,json:object}>}
   *          `null` 表示"这不是 ADBP 的路径"，宿主应继续把请求交给别的路由。
   */
  function handler(method, path, body, headers) {
    try {
      const { pathname, query } = parsePath(path);
      if (!pathname.startsWith('/adbp/v1')) return null;

      const verb = String(method || 'GET').toUpperCase();
      const route = pathname.slice('/adbp/v1'.length).replace(/^\/+/, '');
      const payload = body && typeof body === 'object' ? body : {};

      if (!route || route === 'manifest') {
        if (verb !== 'GET') return { status: 405, json: { ok: false, error: 'method not allowed' } };
        return { status: 200, json: manifest() };
      }

      if (route === 'hello') {
        if (verb !== 'POST') return { status: 405, json: { ok: false, error: 'method not allowed' } };
        return guard(routeHello(payload));
      }

      const auth = authenticate(payload, headers, query);
      if (!auth) return unauthorized();

      let out;
      if (route === 'tasks') {
        if (verb !== 'GET' && verb !== 'POST') out = { status: 405, json: { ok: false, error: 'method not allowed' } };
        else out = routeTasks(payload, query, auth);
      } else if (route === 'result') {
        out = verb === 'POST' ? routeResult(payload, auth) : { status: 405, json: { ok: false, error: 'method not allowed' } };
      } else if (route === 'chat') {
        out = verb === 'POST' ? routeChat(payload, auth) : { status: 405, json: { ok: false, error: 'method not allowed' } };
      } else if (route === 'state') {
        out = verb === 'GET' ? routeState(query, auth) : { status: 405, json: { ok: false, error: 'method not allowed' } };
      } else {
        out = { status: 404, json: { ok: false, error: `未知路由：${route}`, manifest: manifest().routes } };
      }
      return guard(out);
    } catch (err) {
      safeLog('error', `handler 异常：${err?.stack || err}`);
      return { status: 500, json: { ok: false, error: String(err?.message || err) } };
    }
  }

  /** board 是异步实现时把拒绝也翻成 500，绝不让 Promise 悬着把 HTTP 连接挂死。 */
  function guard(out) {
    if (!isThenable(out)) return out;
    return out.catch((err) => {
      safeLog('error', `异步路由异常：${err?.stack || err}`);
      return { status: 500, json: { ok: false, error: String(err?.message || err) } };
    });
  }

  return { manifest, handler, tokens };
}

export default { ADBP_VERSION, createIngress };
