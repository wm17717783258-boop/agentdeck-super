/**
 * agentdeck-super · engine/board.js —— 任务板（全局唯一真相源）
 *
 * 设计约束（来自 docs/CONTRACTS.md §2.1）：
 *   createBoard({ storage, root }) => Board
 *   Board 的方法签名全部是「同步返回值」，只有 waitForTask 返回 Promise。
 *
 * 为什么整体做成同步实现：
 *   1) 契约里的调用方（lib/tools/*.js、engine/adbp.js）按同步签名写代码，返回 Promise 会直接写坏他们；
 *   2) 跨进程安全要求「读-改-写」中间不被别的进程插队。同步文件锁 + 临时文件原子 rename 能在
 *      完全同步的代码里做到这一点，而单线程 JS 的同步函数天然不可被打断，所以进程内串行化自动成立
 *      （不需要额外的 Promise 链，同步临界区本身就是串行化）；
 *   3) waitForTask 是唯一的长轮询入口，它在两次尝试之间用 setTimeout 让出事件循环，
 *      因此慢轮询不会卡住宿主的事件循环。
 *
 * 为什么 storage 句柄是可选的：
 *   宿主 dsh-storage 的 ctx.storageDomain 是异步 API（打开域要注册 schema 并 await），
 *   无法支撑本模块的同步签名；CONTRACTS 也明确允许「不可用时退化为 ~/.dsh/agentdeck-super/state.json」。
 *   所以这里只接受「同步形状」的 storage 把手（loadSync/saveSync，或 getSync/setSync），
 *   形状不符一律忽略并记一条 warn，绝不抛错拖垮宿主。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 状态文件版本号：将来换布局时用它做迁移判定，而不是靠猜字段。 */
const STATE_VERSION = 1
/** 锁文件过期时间（毫秒）：持有者崩溃后，别的进程最多等这么久就接管，避免整块板永久卡死。 */
const DEFAULT_STALE_LOCK_MS = 10_000
/** 抢锁最长等待时间（毫秒）：超时后降级为无锁写入并记 warn —— 宁可冒一次竞态，也不让宿主转圈。 */
const DEFAULT_LOCK_WAIT_MS = 10_000
/** 抢锁重试间隔（毫秒）。 */
const LOCK_RETRY_MS = 15
/** waitForTask 默认轮询间隔（毫秒）。 */
const DEFAULT_POLL_MS = 250

/** 任务状态机：pending --claim--> running --complete/fail--> done|failed */
export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
})

/**
 * 默认落盘目录：没有显式 root 时退到 DSH home 下的 agentdeck-super/。
 * 用 DSH_HOME 而不是硬编码 ~/.dsh，是为了让隔离档（例如 --profile agentdecktest）各用各的状态，
 * 测试和真实使用不会互相污染。
 */
function defaultRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'agentdeck-super')
}

/** 同步睡眠：只用于抢锁重试，避免 await 把同步临界区撕成两半。 */
function sleepSync(ms) {
  if (ms <= 0) return
  // Atomics.wait 是 Node 里唯一不依赖 shell 的同步睡眠；主线程允许使用。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 异步睡眠：waitForTask 用，必须让出事件循环，不能同步阻塞宿主。 */
function sleep(ms, wakers) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms))
    function done() {
      clearTimeout(timer)
      wakers.delete(done)
      resolve()
    }
    // 有人在板上写了东西（新任务/事件）时提前叫醒，长轮询才够快。
    wakers.add(done)
  })
}

/** 短 id：人类可读、够唯一、不占字节。 */
function shortId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

/** 深拷贝，保证外部拿到的是快照，改它不会污染真相源。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 空状态。teams/tasks/events 都以 teamId 为一级键，读写都是 O(1) 定位。 */
function emptyState() {
  return { version: STATE_VERSION, seq: 0, teams: {}, tasks: {}, events: {} }
}

/**
 * 创建任务板。
 * @param {object} [options]
 * @param {{loadSync?: Function, saveSync?: Function, getSync?: Function, setSync?: Function}} [options.storage]
 *        宿主存储把手（同步形状）；不提供或形状不符时落盘到 root/state.json。
 * @param {string|null} [options.root] 状态目录；显式传 null 表示纯内存（测试/一次性编排用）。
 * @param {(msg: string, detail?: any) => void} [options.onWarn] 降级告警出口（lib/index.js 会接到 ctx.logger.warn）。
 * @param {() => number} [options.now] 时钟注入，便于测试。
 * @param {number} [options.staleLockMs] 锁过期时间。
 * @param {number} [options.lockWaitMs] 抢锁最长等待。
 * @param {number} [options.pollIntervalMs] waitForTask 轮询间隔。
 */
export function createBoard(options = {}) {
  const {
    storage = null,
    root = defaultRoot(),
    onWarn = null,
    now = Date.now,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    lockWaitMs = DEFAULT_LOCK_WAIT_MS,
    pollIntervalMs = DEFAULT_POLL_MS,
  } = options || {}

  const warnings = []
  function warn(message, detail) {
    const line = `[agentdeck-super/board] ${message}`
    warnings.push(detail === undefined ? line : `${line} :: ${String(detail)}`)
    try {
      onWarn?.(line, detail)
    } catch {
      // 告警出口自己炸了也不能影响任务板。
    }
  }

  // ── 存储后端选择 ────────────────────────────────────────────────────────────
  // 只认同步形状；异步 storage 无法支撑同步签名，直接忽略并退化到文件。
  const syncStorage =
    storage &&
    typeof storage.loadSync === 'function' &&
    typeof storage.saveSync === 'function'
      ? storage
      : null
  if (storage && !syncStorage) {
    warn('传入的 storage 不是同步形状（需要 loadSync/saveSync），已退化为文件存储')
  }

  const baseDir = root === null ? null : path.resolve(String(root))
  const stateFile = baseDir ? path.join(baseDir, 'state.json') : null
  const lockFile = baseDir ? path.join(baseDir, '.lock') : null
  let usingFile = Boolean(baseDir)

  /** 内存态 + 磁盘指纹：指纹用来判断「别的进程有没有改过文件」。 */
  let state = emptyState()
  let fingerprint = null

  /** 读到过的状态指纹（mtimeMs:size）。null 表示文件还不存在。 */
  function fileFingerprint() {
    if (!stateFile) return null
    try {
      const st = fs.statSync(stateFile)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  function ensureDir() {
    if (!baseDir) return
    try {
      fs.mkdirSync(baseDir, { recursive: true })
    } catch (error) {
      warn('状态目录创建失败，退化为纯内存', error?.message)
      usingFile = false
    }
  }

  /** 从存储介质装载状态；解析失败保留旧内存态（绝不把坏文件的变化放大）。 */
  function loadState() {
    if (syncStorage) {
      try {
        const loaded = syncStorage.loadSync()
        if (loaded && typeof loaded === 'object') state = normalizeState(loaded)
        return
      } catch (error) {
        warn('storage.loadSync 失败，保留内存态', error?.message)
        return
      }
    }
    if (!usingFile) return
    const next = fileFingerprint()
    if (next === fingerprint) return // 没变就不用解析
    fingerprint = next
    if (next === null) {
      state = emptyState()
      return
    }
    try {
      const raw = fs.readFileSync(stateFile, 'utf8')
      state = normalizeState(JSON.parse(raw))
    } catch (error) {
      warn('state.json 读取/解析失败，保留内存态', error?.message)
    }
  }

  /** 原子写：先写临时文件再 rename，别的进程永远读不到半截 JSON。 */
  function saveState() {
    if (syncStorage) {
      try {
        syncStorage.saveSync(clone(state))
      } catch (error) {
        warn('storage.saveSync 失败', error?.message)
      }
      return
    }
    if (!usingFile) return
    ensureDir()
    if (!usingFile) return
    const tmp = `${stateFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      fs.renameSync(tmp, stateFile)
      fingerprint = fileFingerprint()
    } catch (error) {
      warn('state.json 写入失败', error?.message)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // 临时文件清不掉也无所谓，下次覆盖。
      }
    }
  }

  state = emptyState()

  /** 抢文件锁；返回释放函数。拿不到锁时降级为无锁并记 warn（活优先于绝对一致）。 */
  function acquireLock() {
    if (!usingFile || !lockFile) return noop
    ensureDir()
    if (!usingFile) return noop
    const deadline = now() + lockWaitMs
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx')
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }))
        } finally {
          fs.closeSync(fd)
        }
        return () => {
          try {
            fs.rmSync(lockFile, { force: true })
          } catch {
            // 释放失败就等它过期，不抛。
          }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          warn('文件锁创建失败，降级为无锁写入', error?.message)
          return noop
        }
        // 过期回收：进程崩溃留下的锁必须能被接管，否则整块板永久卡死。
        let stale = false
        try {
          const st = fs.statSync(lockFile)
          stale = now() - st.mtimeMs > staleLockMs
        } catch {
          stale = true // 刚被别人删掉，直接重试
        }
        if (stale) {
          try {
            fs.rmSync(lockFile, { force: true })
          } catch {
            // 抢不到删除就下一轮再试。
          }
          continue
        }
        if (now() >= deadline) {
          warn(`文件锁等待超过 ${lockWaitMs}ms，降级为无锁写入`)
          return noop
        }
        sleepSync(LOCK_RETRY_MS)
      }
    }
  }

  /** 所有写操作的唯一通道：抢锁 → 重读最新态 → 改 → 原子落地 → 放锁。 */
  function transaction(mutator) {
    const release = acquireLock()
    try {
      loadState()
      const result = mutator(state)
      saveState()
      return result
    } finally {
      release()
    }
  }

  /** 读操作的通道：先刷新（stat 一次，很便宜），再返回快照。 */
  function read(fn) {
    loadState()
    return fn(state)
  }

  // ── 长轮询唤醒：写操作后叫醒所有等待者 ─────────────────────────────────────
  const wakers = new Set()
  function notify() {
    for (const wake of [...wakers]) {
      try {
        wake()
      } catch {
        // 单个等待者出错不影响别人。
      }
    }
  }

  loadState()

  // ── 内部取值助手 ────────────────────────────────────────────────────────────
  function teamBucket(s, teamId) {
    return s.teams[teamId] ? s.teams[teamId] : null
  }

  function tasksOf(s, teamId) {
    if (!s.tasks[teamId]) s.tasks[teamId] = {}
    return s.tasks[teamId]
  }

  function eventsOf(s, teamId) {
    if (!s.events[teamId]) s.events[teamId] = []
    return s.events[teamId]
  }

  function requireTeam(s, teamId) {
    const team = teamBucket(s, teamId)
    if (!team) throw new Error(`team not found: ${teamId}`)
    return team
  }

  /** 依赖是否全部完成：只认 done，failed/pending 都算没满足。 */
  function depsSatisfied(tasks, task) {
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : []
    return deps.every((depId) => tasks[depId] && tasks[depId].status === TASK_STATUS.DONE)
  }

  function pushEvent(s, teamId, evt) {
    const seq = ++s.seq
    const record = {
      seq,
      ts: evt?.ts ?? new Date(now()).toISOString(),
      kind: evt?.kind ?? 'note',
      text: evt?.text ?? '',
      ...evt,
      seq,
    }
    eventsOf(s, teamId).push(record)
    return record
  }

  // ── 对外 API（严格按 CONTRACTS §2.1） ───────────────────────────────────────

  function createTeam({ name, goal, members, id: wantedId } = {}) {
    // id 可显式指定：跨机房间要用「房主小组的 id」在本机复刻同一个小组，
    // 否则远端任务拉下来无处可落（踩过的坑：sync 说拉回来 1 条，任务板还是空的）。
    const team = transaction((s) => {
      const askId = String(wantedId ?? '').trim();
      if (askId && s.teams[askId]) return clone(s.teams[askId]);
      const id = askId && /^[\w:-]{1,64}$/.test(askId) ? askId : shortId('team')
      const record = {
        id,
        name: String(name ?? 'team'),
        goal: String(goal ?? ''),
        members: [],
        createdAt: new Date(now()).toISOString(),
      }
      s.teams[id] = record
      tasksOf(s, id)
      eventsOf(s, id)
      pushEvent(s, id, { kind: 'team/create', text: `队伍已创建：${record.name}` })
      // 允许建队时一次带入成员（省一次往返，ADBP hello 也复用这里）。
      if (Array.isArray(members)) {
        for (const spec of members) addMemberLocked(s, id, spec)
      }
      return clone(record)
    })
    notify()
    return team
  }

  function addMemberLocked(s, teamId, spec) {
    const team = requireTeam(s, teamId)
    const member = {
      id: spec?.id || shortId('mem'),
      name: String(spec?.name ?? spec?.id ?? 'member'),
      kind: String(spec?.kind ?? 'agent'),
      manifest: spec?.manifest ?? null,
      joinedAt: new Date(now()).toISOString(),
    }
    team.members.push(member)
    pushEvent(s, teamId, { kind: 'member/join', text: `${member.name} 加入（${member.kind}）`, memberId: member.id })
    return member
  }

  function getTeam(teamId) {
    const team = read((s) => teamBucket(s, teamId))
    return team ? clone(team) : null
  }

  function listTeams() {
    return read((s) => Object.values(s.teams)).map((team) => clone(team))
  }

  function addMember(teamId, spec) {
    const member = transaction((s) => addMemberLocked(s, teamId, spec))
    notify()
    return clone(member)
  }

  function listMembers(teamId) {
    const team = read((s) => teamBucket(s, teamId))
    return team ? clone(team.members) : []
  }

  function addTask(teamId, payload = {}) {
    const task = transaction((s) => {
      requireTeam(s, teamId)
      const tasks = tasksOf(s, teamId)
      const id = payload.id ? String(payload.id) : shortId('task')
      if (tasks[id]) throw new Error(`task already exists: ${id}`)
      const record = {
        id,
        title: String(payload.title ?? ''),
        role: String(payload.role ?? 'worker'),
        acceptance: payload.acceptance ?? null,
        context: payload.context ?? null,
        dependsOn: Array.isArray(payload.dependsOn) ? payload.dependsOn.map(String) : [],
        assignee: payload.assignee ? String(payload.assignee) : null,
        status: TASK_STATUS.PENDING,
        output: null,
        note: null,
        createdAt: new Date(now()).toISOString(),
        updatedAt: null,
        claimedAt: null,
        finishedAt: null,
        attempts: 0,
      }
      tasks[id] = record
      pushEvent(s, teamId, { kind: 'task/add', text: `新增任务：${record.title}`, taskId: id, role: record.role })
      return record
    })
    notify()
    return clone(task)
  }

  function listTasks(teamId, filter = {}) {
    const status = filter?.status ?? null
    const assignee = filter?.assignee ?? null
    const tasks = read((s) => Object.values(tasksOf(s, teamId)))
    return tasks
      .filter((task) => (status ? task.status === status : true))
      .filter((task) => (assignee ? task.assignee === assignee : true))
      .map((task) => clone(task))
  }

  /** 抢占式认领：pending 才能被拿走；返回 true 表示这次真的抢到了。 */
  function claimTask(teamId, taskId, memberId) {
    const claimed = transaction((s) => {
      const tasks = tasksOf(s, teamId)
      const task = tasks[taskId]
      if (!task || task.status !== TASK_STATUS.PENDING) return false
      task.status = TASK_STATUS.RUNNING
      task.assignee = memberId ? String(memberId) : task.assignee
      task.claimedAt = new Date(now()).toISOString()
      task.updatedAt = task.claimedAt
      task.attempts = (task.attempts || 0) + 1
      pushEvent(s, teamId, {
        kind: 'task/claim',
        text: `${task.assignee || 'member'} 认领：${task.title}`,
        taskId,
        memberId: task.assignee || null,
      })
      return true
    })
    if (claimed) notify()
    return claimed
  }

  function settleTask(teamId, taskId, status, { output, note } = {}) {
    const task = transaction((s) => {
      const tasks = tasksOf(s, teamId)
      const current = tasks[taskId]
      if (!current) throw new Error(`task not found: ${taskId}`)
      current.status = status
      current.output = output === undefined ? current.output : output
      current.note = note === undefined ? current.note : note
      current.finishedAt = new Date(now()).toISOString()
      current.updatedAt = current.finishedAt
      pushEvent(s, teamId, {
        kind: status === TASK_STATUS.DONE ? 'task/done' : 'task/fail',
        text: `${status === TASK_STATUS.DONE ? '完成' : '失败'}：${current.title}${note ? `（${note}）` : ''}`,
        taskId,
      })
      return current
    })
    return clone(task)
  }

  function completeTask(teamId, taskId, result = {}) {
    const ok = result?.ok !== false
    const task = settleTask(teamId, taskId, ok ? TASK_STATUS.DONE : TASK_STATUS.FAILED, {
      output: result?.output ?? null,
      note: result?.note ?? null,
    })
    notify()
    return task
  }

  function failTask(teamId, taskId, reason) {
    const task = settleTask(teamId, taskId, TASK_STATUS.FAILED, { note: reason ?? null })
    notify()
    return task
  }

  /**
   * 找下一个可做的任务：依赖已完成、状态 pending、且没有指派给别人。
   * 指派给自己的任务排在最前面（尊重显式分工），其余按创建顺序先来先得。
   */
  function nextTaskFor(teamId, memberId) {
    const candidate = read((s) => {
      const tasks = tasksOf(s, teamId)
      const open = Object.values(tasks)
        .filter((task) => task.status === TASK_STATUS.PENDING)
        .filter((task) => depsSatisfied(tasks, task))
        .filter((task) => !task.assignee || task.assignee === memberId)
        .sort((a, b) => {
          const mine = (task) => (task.assignee === memberId ? 0 : 1)
          const delta = mine(a) - mine(b)
          return delta !== 0 ? delta : String(a.createdAt).localeCompare(String(b.createdAt))
        })
      return open[0] ?? null
    })
    return candidate ? clone(candidate) : null
  }

  /**
   * 长轮询取活：等到有活就直接认领后返回（认领是抢占式，两个轮询者不会拿到同一个任务）。
   * 超时返回 null，由调用方回 {task:null} 让外部 Agent 继续轮询。
   */
  async function waitForTask(teamId, memberId, waitOptions = {}) {
    const timeoutMs = Number.isFinite(waitOptions?.timeoutMs) ? Math.max(0, waitOptions.timeoutMs) : 25_000
    const interval = Number.isFinite(waitOptions?.pollIntervalMs) ? Math.max(1, waitOptions.pollIntervalMs) : pollIntervalMs
    const deadline = now() + timeoutMs
    for (;;) {
      const candidate = nextTaskFor(teamId, memberId)
      if (candidate && claimTask(teamId, candidate.id, memberId)) {
        const claimed = read((s) => (s.tasks[teamId] ? s.tasks[teamId][candidate.id] : null))
        return claimed ? clone(claimed) : candidate
      }
      const left = deadline - now()
      if (left <= 0) return null
      await sleep(Math.min(interval, left), wakers)
    }
  }

  function appendEvent(teamId, evt = {}) {
    let record = null
    try {
      record = transaction((s) => {
        if (!teamBucket(s, teamId)) throw new Error(`team not found: ${teamId}`)
        return pushEvent(s, teamId, evt)
      })
    } catch (error) {
      warn('appendEvent 失败', error?.message)
      return null
    }
    notify()
    return clone(record)
  }

  function listEvents(teamId, sinceSeq = 0) {
    const events = read((s) => eventsOf(s, teamId))
    const from = Number.isFinite(sinceSeq) ? Number(sinceSeq) : 0
    return events.filter((evt) => evt.seq > from).map((evt) => clone(evt))
  }

  function stats(teamId) {
    return read((s) => {
      const tasks = Object.values(tasksOf(s, teamId))
      const tally = { total: tasks.length, done: 0, failed: 0, running: 0, pending: 0 }
      for (const task of tasks) {
        if (task.status === TASK_STATUS.DONE) tally.done += 1
        else if (task.status === TASK_STATUS.FAILED) tally.failed += 1
        else if (task.status === TASK_STATUS.RUNNING) tally.running += 1
        else tally.pending += 1
      }
      return tally
    })
  }

  /** 订阅板事件（工具层/路由层用来推流）；返回退订函数。契约之外的便利方法。 */
  function subscribe(listener) {
    if (typeof listener !== 'function') return noop
    wakers.add(listener)
    return () => wakers.delete(listener)
  }

  return {
    createTeam,
    getTeam,
    listTeams,
    addMember,
    listMembers,
    addTask,
    listTasks,
    claimTask,
    completeTask,
    failTask,
    nextTaskFor,
    waitForTask,
    appendEvent,
    listEvents,
    stats,
    // —— 契约之外的辅助面（不改变上面任何签名） ——
    subscribe,
    /** 当前所有降级告警（装机器上排查用，docs/host-api.md 里会讲怎么看）。 */
    warnings: () => [...warnings],
    /** 状态目录 / 状态文件位置，方便运维定位。 */
    location: () => ({ root: baseDir, file: stateFile, storage: syncStorage ? 'host' : usingFile ? 'file' : 'memory' }),
    /** 手动落盘一次（进程退出前用）。 */
    flush: () => {
      transaction(() => undefined)
    },
  }
}

function noop() {}

/** 把任意读到的东西规整成合法状态，防止坏文件把内存态带歪。 */
function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const state = { ...base, ...raw }
  state.version = Number(state.version) || STATE_VERSION
  state.seq = Number.isFinite(state.seq) ? Number(state.seq) : 0
  state.teams = state.teams && typeof state.teams === 'object' ? state.teams : {}
  state.tasks = state.tasks && typeof state.tasks === 'object' ? state.tasks : {}
  state.events = state.events && typeof state.events === 'object' ? state.events : {}
  for (const teamId of Object.keys(state.teams)) {
    if (!state.tasks[teamId]) state.tasks[teamId] = {}
    if (!state.events[teamId]) state.events[teamId] = []
  }
  return state
}

export default createBoard
