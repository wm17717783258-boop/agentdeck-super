/**
 * 房间客户端（跨机器 / 跨人的协同）
 *
 * 一句话：把远端房间的事件流「物化」成本地任务板上的任务，把本地的新任务「推」到远端。
 * 状态永远以本地任务板为准（离线可用），relay 只是搬运工——这跟 ADBP 的设计取向一致。
 *
 * 关键设计：
 *  · 远端任务 → 本地 id 用确定性前缀 `r_<seat6>_<远端id>`，天然幂等，不需要映射表；
 *  · 重复事件（断线重连、重复拉取）只会撞到 "already exists"，被静默跳过；
 *  · 游标（since seq）落盘，重连从上次的位置继续；
 *  · 联网失败不抛异常，返回 { ok:false }，本地照常工作。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { entitlements } from './license.js';

/** 远端任务在本地的确定性 id */
export function localTaskId(seatId, remoteTaskId) {
  const seat = String(seatId || 'anon').replace(/[^\w]/g, '').slice(0, 6) || 'anon';
  const rid = String(remoteTaskId || '').replace(/[^\w-]/g, '').slice(0, 40) || 'unknown';
  return `r_${seat}_${rid}`;
}

function jsonFetch(fetchImpl, url, init = {}) {
  return fetchImpl(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

/**
 * 创建房间客户端。
 * @param {{
 *   relayUrl: string,
 *   root: string,
 *   board: object,
 *   teamId: string,
 *   license?: object,
 *   fetchImpl?: Function,
 *   now?: () => number,
 *   log?: (msg: string, extra?: object) => void,
 * }} deps
 */
export function createRoomClient(deps) {
  const {
    relayUrl,
    root,
    board,
    teamId: initialTeamId,
    license = null,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    log = () => {},
  } = deps;
  // 可变的：客人进房间时，房主的小组 id 由 relay 下发，本机据此复刻同一个小组
  let teamId = String(initialTeamId || '');

  const base = String(relayUrl || '').replace(/\/+$/, '');
  const sessionDir = join(root, '.agentdeck', 'rooms');
  const sessionPath = (roomId) => join(sessionDir, `${String(roomId).replace(/[^\w-]/g, '')}.json`);
  let session = null; // { roomId, name, seatId, syncToken, inviteToken, hostToken, cursor, teamId, createdAt }

  function persist() {
    if (!session) return;
    try {
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
      const p = sessionPath(session.roomId);
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
      renameSync(tmp, p);
    } catch (err) {
      log('房间状态落盘失败', { reason: err && err.message });
    }
  }

  function loadSession(roomId) {
    try {
      const p = sessionPath(roomId);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  function appendChat(line) {
    try {
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
      appendFileSync(join(sessionDir, 'chat.log'), `${new Date(now()).toISOString()} ${line}\n`, 'utf8');
    } catch {
      /* 记日志失败不影响主流程 */
    }
  }

  const ent = entitlementsOf(license);

  function entitlementsOf(lic) {
    if (!lic) return entitlements('free');
    if (lic.entitlements) return lic.entitlements;
    if (lic.ok && lic.tier) return entitlements(lic.tier);
    return entitlements('free');
  }

  // ── 建房间（房主付费）────────────────────────────────────────────────────

  async function createRoom({ name, member = {}, petSkin = 'basic' } = {}) {
    if (!base) return { ok: false, reason: '没有配置 relay 地址（在插件设置里填 cloud.relayUrl）' };
    if (!ent.cloudRooms) {
      return {
        ok: false,
        reason: `${ent.label}不含云房间：协作版（¥29/月）起可建跨机房间；本地房间不受影响`,
        needUpgrade: true,
      };
    }
    const licKey = String(license?.key || '').trim();
    if (!licKey) return { ok: false, reason: '建云房间需要授权码（在 /deck 状态页里粘贴）', needUpgrade: true };
    try {
      const res = await jsonFetch(fetchImpl, `${base}/v1/rooms`, {
        method: 'POST',
        headers: { authorization: `Bearer ${licKey}` },
        body: JSON.stringify({ name: name || '协同房间', owner: member.name || license?.claims?.sub || '', teamId, petSkin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.error || `建房间失败：HTTP ${res.status}`, code: data.code };
      session = {
        roomId: data.roomId,
        name: data.name,
        relayUrl: base,
        seatId: data.seatId,
        syncToken: data.syncToken,
        inviteToken: data.inviteToken,
        inviteUrl: data.inviteUrl,
        inviteWebUrl: data.inviteWebUrl || '',
        hostToken: data.hostToken || data.syncToken,
        host: true,
        cursor: 0,
        teamId,
        createdAt: now(),
      };
      persist();
      return { ok: true, room: publicSession(), inviteUrl: data.inviteUrl, inviteWebUrl: data.inviteWebUrl || '', inviteToken: data.inviteToken, seats: data.seats };
    } catch (err) {
      return { ok: false, reason: `连不上 relay：${err && err.message ? err.message : String(err)}` };
    }
  }

  // ── 进房间（客人免费）────────────────────────────────────────────────────

  async function joinRoom({ roomId, inviteToken, inviteUrl = '', member = {}, petSkin = 'basic', role = 'worker' } = {}) {
    if (!base) return { ok: false, reason: '没有配置 relay 地址' };
    let rid = roomId;
    let tok = inviteToken;
    if (inviteUrl && (!rid || !tok)) {
      const m = /[?&]room=([\w-]+)/.exec(inviteUrl);
      const t = /[?&]t=([\w-]+)/.exec(inviteUrl);
      if (m) rid = m[1];
      if (t) tok = t[1];
    }
    if (!rid || !tok) return { ok: false, reason: '邀请信息不完整：需要 roomId 和邀请码（或用完整邀请链接）' };
    try {
      const res = await jsonFetch(fetchImpl, `${base}/v1/rooms/${encodeURIComponent(rid)}/join`, {
        method: 'POST',
        body: JSON.stringify({ inviteToken: tok, member: { name: member.name || '客人', petSkin, role } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.error || `进房间失败：HTTP ${res.status}`, code: data.code };
      // 客人的小组 id 由房主那边带过来：relay 下发 room.teamId，本机据此复刻同一个小组
      if (data.teamId) teamId = String(data.teamId);
      session = {
        roomId: rid,
        name: data.name,
        relayUrl: base,
        seatId: data.seatId,
        syncToken: data.syncToken,
        inviteToken: tok,
        host: false,
        cursor: 0,
        teamId,
        createdAt: now(),
      };
      persist();
      return { ok: true, room: publicSession(), members: data.members || [] };
    } catch (err) {
      return { ok: false, reason: `连不上 relay：${err && err.message ? err.message : String(err)}` };
    }
  }

  /** 恢复已保存的房间（重启后接着用） */
  function resume(roomId) {
    const saved = loadSession(roomId);
    if (!saved) return { ok: false, reason: `没有找到房间记录：${roomId}` };
    session = saved;
    if (saved.teamId) teamId = String(saved.teamId); // 重启后接着同步也要认得房主的小组
    return { ok: true, room: publicSession() };
  }

  function publicSession() {
    if (!session) return null;
    const { roomId, name, seatId, host, cursor, createdAt, inviteUrl, inviteWebUrl, teamId: boundTeam } = session;
    return { roomId, name, seatId, host, cursor, createdAt, inviteUrl, inviteWebUrl: inviteWebUrl || '', teamId: boundTeam || '' };
  }

  // ── 事件物化：远端 → 本地任务板 ─────────────────────────────────────────

  /**
   * 保证房间对应的小组在本机存在。
   * 跨机场景里房主的小组 id 是远端生成的，客人本机没有这个小组；
   * 不先复刻就直接 addTask，会掉进 "team not found"，任务拉下来等于白拉。
   * @returns {{ ok:boolean, created:boolean, teamId:string, reason?:string }}
   */
  function ensureRoomTeam() {
    const id = String(teamId || '').trim();
    if (!id) return { ok: false, created: false, teamId: '', reason: '房间没有绑定小组' };
    try {
      if (board.getTeam(id)) return { ok: true, created: false, teamId: id };
      const roomName = session?.name || '协同房间';
      board.createTeam({ id, name: `${roomName}·协同`, goal: '从跨机房间同步下来的小组（房主创建）' });
      return { ok: true, created: true, teamId: id };
    } catch (err) {
      return { ok: false, created: false, teamId: id, reason: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 把一个远端事件写成本地状态。幂等、不抛异常。
   * 关键：任务 id 用「来源席位 + 远端 id」做确定性映射；来源机器看到自己的事件直接跳过，
   * 因此不需要任何映射表，断线重连也不会长出重复任务。
   * @returns {{ applied:boolean, kind:string, taskId?:string, reason?:string }}
   */
  function applyEvent(ev) {
    const kind = String(ev?.kind || '');
    const payload = ev?.payload || {};
    const originSeat = String(payload.originSeat || ev?.seatId || '');
    const isMine = Boolean(session && originSeat === session.seatId);
    const resolveId = () => (isMine ? String(payload.taskId || payload.id || '') : localTaskId(originSeat, payload.taskId || payload.id));
    try {
      // 任务类事件先确保本机有房主那个小组：顺序反了就是 "team not found"，拉下来等于白拉
      if (kind.startsWith('task/') && !isMine) {
        const ensured = ensureRoomTeam();
        if (!ensured.ok) return { applied: false, kind, reason: `小组复刻失败：${ensured.reason || '未知'}` };
      }
      if (kind === 'task/add') {
        if (isMine) return { applied: false, kind, reason: 'own' };
        const id = localTaskId(originSeat, payload.id || `ev${ev.seq}`);
        const exists = board.listTasks(teamId, {}).some((t) => t.id === id);
        if (exists) return { applied: false, kind, taskId: id, reason: 'already' };
        board.addTask(teamId, {
          id,
          title: String(payload.title || '(远端任务)'),
          role: String(payload.role || 'worker'),
          acceptance: payload.acceptance ?? null,
          context: { ...(payload.context || {}), roomOrigin: { seat: originSeat, id: String(payload.id || `ev${ev.seq}`) } },
          dependsOn: [], // 跨机依赖不直接搬，避免死等
        });
        return { applied: true, kind, taskId: id };
      }
      if (kind === 'task/claim') {
        const id = resolveId();
        if (!id) return { applied: false, kind, reason: 'no-id' };
        const ok = board.claimTask(teamId, id, String(payload.memberName || payload.memberId || '远端成员'));
        markPublished(id, 'running');
        return { applied: Boolean(ok), kind, taskId: id };
      }
      if (kind === 'task/done') {
        const id = resolveId();
        if (!id) return { applied: false, kind, reason: 'no-id' };
        board.completeTask(teamId, id, {
          output: String(payload.summary || payload.output || '远端完成'),
        });
        markPublished(id, 'done');
        return { applied: true, kind, taskId: id };
      }
      if (kind === 'task/fail') {
        const id = resolveId();
        if (!id) return { applied: false, kind, reason: 'no-id' };
        board.failTask(teamId, id, String(payload.note || payload.reason || '远端失败'));
        markPublished(id, 'failed');
        return { applied: true, kind, taskId: id };
      }
      if (kind === 'chat') {
        appendChat(`[${payload.from || '远端'}] ${payload.text || ''}`);
        board.appendEvent(teamId, { kind: 'room/chat', text: String(payload.text || ''), from: payload.from || '远端' });
        return { applied: true, kind };
      }
      if (kind.startsWith('presence/') || kind.startsWith('visit/') || kind === 'room/closed') {
        board.appendEvent(teamId, { kind: `room/${kind}`, text: `${payload.name || payload.seatId || ''} ${kind}`, from: payload.name });
        return { applied: true, kind };
      }
      return { applied: false, kind, reason: 'ignored' };
    } catch (err) {
      return { applied: false, kind, reason: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 记录「这个本地任务的最新状态已经上过 relay」。
   *
   * 为什么不能只放在内存里：CLI 每次 sync 都是新进程；不落盘就会
   * 每次 sync 都把同一条 claim/done 再推一遍，事件流越长越乱。
   */
  function markPublished(localId, status) {
    if (!session || !localId) return;
    if (!session.published || typeof session.published !== 'object') session.published = {};
    session.published[String(localId)] = String(status);
  }

  // ── 推 / 拉 ────────────────────────────────────────────────────────────

  async function push(events) {
    if (!session) return { ok: false, reason: '还没有加入任何房间' };
    const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
    if (!list.length) return { ok: true, accepted: 0 };
    try {
      const res = await jsonFetch(fetchImpl, `${base}/v1/rooms/${session.roomId}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.syncToken}` },
        body: JSON.stringify({ events: list }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.error || `HTTP ${res.status}` };
      return { ok: true, accepted: data.accepted || 0, seq: data.seq };
    } catch (err) {
      return { ok: false, reason: `推送失败：${err && err.message ? err.message : String(err)}` };
    }
  }

  async function pull({ waitSec = 0 } = {}) {
    if (!session) return { ok: false, reason: '还没有加入任何房间' };
    try {
      const url = `${base}/v1/rooms/${session.roomId}/events?since=${session.cursor || 0}&wait=${Math.max(0, Math.floor(waitSec))}&token=${encodeURIComponent(session.syncToken)}`;
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${session.syncToken}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 房间被房主关掉不是「出故障」：这是正常终点，要让 agent 循环安静停下，
        // 而不是每个 tick 都刷一条错误。所以 410/room_closed 统一折成 ok:true + closed:true。
        if (data.code === 'room_closed' || res.status === 410) {
          return { ok: true, closed: true, seq: session.cursor || 0, fetched: 0, applied: 0, members: [], reason: data.error || '房间已关闭' };
        }
        return { ok: false, reason: data.error || `HTTP ${res.status}`, code: data.code };
      }
      const results = (data.events || []).map(applyEvent);
      if (typeof data.seq === 'number' && data.seq >= (session.cursor || 0)) {
        session.cursor = data.seq;
        persist();
      }
      // 分开数：事件落地数 ≠ 任务落地数（进房/打招呼这类事件也会 applied），
      // 回执里说"落到本机任务板 N 条"就必须是任务数，不能忽悠人。
      const appliedTasks = results.filter((r) => r.applied && String(r.kind || '').startsWith('task/')).length;
      return {
        ok: true,
        seq: data.seq,
        fetched: (data.events || []).length,
        applied: results.filter((r) => r.applied).length,
        appliedTasks,
        members: data.members || [],
        closed: Boolean(data.closed),
      };
    } catch (err) {
      return { ok: false, reason: `拉取失败：${err && err.message ? err.message : String(err)}` };
    }
  }

  /** 一次同步：先把本地新任务推上去，再拉远端回来 */
  async function syncOnce({ waitSec = 0 } = {}) {
    const pulled = await pull({ waitSec });
    return pulled;
  }

  /**
   * 把本地任务板推上去：
   *   · pending 的原生任务 → task/add（兼容旧 relay/旧版本，重复 add 由对端幂等忽略）
   *   · running/done/failed 的状态变化 → task/claim / task/done / task/fail
   *
   * 以前只推 pending，导致「乙机认领/完成后 sync，甲机看不到」——
   * 任务虽然跨机出现了，但交付闭环没有跨机。这里按本地状态补上。
   */
  async function publishLocalTasks() {
    if (!session) return { ok: false, reason: '还没有加入任何房间' };
    const tasks = board.listTasks(teamId, {});
    const events = [];

    for (const t of tasks) {
      if (t.status === 'pending' && !String(t.id).startsWith('r_')) {
        events.push({
          kind: 'task/add',
          payload: {
            id: t.id,
            title: t.title,
            role: t.role,
            acceptance: t.acceptance,
            context: t.context,
            originSeat: session.seatId, // 来源席位：所有机器据此算同一个本地 id
          },
        });
      }
    }

    for (const t of tasks) {
      if (!['running', 'done', 'failed'].includes(String(t.status))) continue;
      const previous = session.published && session.published[String(t.id)];
      if (previous === String(t.status)) continue;
      const ref = refFor(t.id);
      if (!ref.taskId || !ref.originSeat) continue;
      const common = {
        taskId: ref.taskId,
        originSeat: ref.originSeat,
        title: ref.title || t.title,
        memberName: session.host ? '房主' : '客人',
      };
      if (t.status === 'running') {
        events.push({ kind: 'task/claim', payload: common });
      } else if (t.status === 'done') {
        events.push({
          kind: 'task/done',
          payload: { ...common, summary: t.output || t.note || '已完成' },
        });
      } else {
        events.push({
          kind: 'task/fail',
          payload: { ...common, note: t.note || t.output || '失败（未填写原因）' },
        });
      }
    }

    if (!events.length) return { ok: true, accepted: 0 };
    const res = await push(events);
    if (res.ok) {
      for (const t of tasks) {
        if (['running', 'done', 'failed'].includes(String(t.status))) {
          markPublished(t.id, t.status);
        }
      }
      persist();
    }
    return res;
  }

  /**
   * 取一个任务在「房间坐标」里的引用：认领/完成时用得到。
   * 如果是远端同步过来的任务，返回它原始席位的坐标；本地任务返回自己的席位。
   * @param {string} taskId 本地任务 id
   * @returns {{ taskId:string, originSeat:string, title?:string }}
   */
  function refFor(taskId) {
    const t = board.listTasks(teamId, {}).find((x) => x.id === taskId);
    const origin = t?.context?.roomOrigin;
    if (origin && origin.seat) return { taskId: String(origin.id), originSeat: String(origin.seat), title: t.title };
    return { taskId: String(taskId), originSeat: String(session?.seatId || ''), title: t?.title };
  }

  async function info() {
    if (!session) return { ok: false, reason: '还没有加入任何房间' };
    try {
      const res = await jsonFetch(fetchImpl, `${base}/v1/rooms/${session.roomId}`, {
        headers: { authorization: `Bearer ${session.syncToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.error || `HTTP ${res.status}` };
      return { ok: true, ...data, session: publicSession() };
    } catch (err) {
      return { ok: false, reason: `查询失败：${err && err.message ? err.message : String(err)}` };
    }
  }

  async function leave() {
    if (!session) return { ok: false, reason: '还没有加入任何房间' };
    try {
      const res = await jsonFetch(fetchImpl, `${base}/v1/rooms/${session.roomId}/leave`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.syncToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.error || `HTTP ${res.status}` };
      persist();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `离开失败：${err && err.message ? err.message : String(err)}` };
    }
  }

  async function closeRoom() {
    if (!session) return { ok: false, reason: '还没有加入任何房间' };
    if (!session.host) return { ok: false, reason: '只有房主能关房' };
    try {
      const res = await jsonFetch(fetchImpl, `${base}/v1/rooms/${session.roomId}/close`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.hostToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, reason: data.error || `HTTP ${res.status}` };
      return { ok: true, closedAt: data.closedAt };
    } catch (err) {
      return { ok: false, reason: `关房失败：${err && err.message ? err.message : String(err)}` };
    }
  }

  return {
    createRoom,
    joinRoom,
    resume,
    ensureRoomTeam,
    applyEvent,
    push,
    pull,
    syncOnce,
    publishLocalTasks,
    refFor,
    info,
    leave,
    closeRoom,
    session: publicSession,
    get sessionData() {
      return session;
    },
    entitlements: ent,
  };
}
