/**
 * tools/common.js —— 四个宿主工具共用的胶水
 *
 * 为什么单独抽一层：四个工具都要做同一批脏活（拿工作区根目录、定位小组、
 * 找成员、派活、发事件、把各种奇形怪状的 board/registry 接口包成安全调用）。
 * 复制四遍必然漂移，所以集中在这里。
 *
 * 核心原则：**deps 里任何一项缺失都不许抛错**。插件装在别人的宿主里，
 * 少一个服务很常见（比如纯 CLI 环境没有 board）；工具要能降级干活并说清缺什么。
 */

import { makeCtx } from '../engine/toolbelt.js';

/** 统一整理依赖，顺便给每个字段兜一个安全默认值。 */
export function normalizeDeps(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  return {
    brain: d.brain || null,
    board: d.board || null,
    registry: d.registry || null,
    workspace: d.workspace ?? d.workspaceRoot ?? null,
    emit: typeof d.emit === 'function' ? d.emit : () => {},
    runAgent: typeof d.runAgent === 'function' ? d.runAgent : typeof d.dispatch === 'function' ? d.dispatch : null,
    callRemote: typeof d.callRemote === 'function' ? d.callRemote : null,
    ingress: d.ingress || null,
    askUser: typeof d.askUser === 'function' ? d.askUser : typeof d.ask === 'function' ? d.ask : null,
    cfg: d.cfg && typeof d.cfg === 'object' ? d.cfg : {},
    // ── 1.4 新增：跨机/授权/桌宠需要的额外依赖 ─────────────────────────────
    // root 统一成函数：工作区可能在会话中途变化，工具调用时再取最新值。
    root: typeof d.root === 'function' ? d.root : typeof d.root === 'string' ? () => d.root : null,
    // 授权文件目录（机级，跟人走）：没给就退回 root（老行为，至少不会崩）
    licenseRoot: typeof d.licenseRoot === 'function' ? d.licenseRoot : null,
    // 房间会话目录（机级）：一台设备一个席位，不能按项目隔离，否则换个目录就"房间没了"
    roomRoot: typeof d.roomRoot === 'function' ? d.roomRoot : null,
    // 授权迁移（插件启动时提供）：工具可能先于状态页被调用，读授权前要能先补一次迁移
    migrateLicense: typeof d.migrateLicense === 'function' ? d.migrateLicense : null,
    license: d.license || null, // lib/license.js 的导出（缺失时工具降级成"免费版"提示）
    room: d.room || null, // lib/room.js 的导出
    roomClient: typeof d.roomClient === 'function' ? d.roomClient : null, // 复用会话的房间客户端工厂
    pet: d.pet || null, // 桌宠档案（皮肤/习惯），用于状态页
  };
}

/** 工作区根目录：workspace 可能是字符串、{root}、{path}，都没有就用进程 cwd。 */
export function workspaceRoot(deps, toolCtx) {
  const w = deps?.workspace;
  const cand = typeof w === 'string' ? w : w?.root || w?.path || w?.dir || deps?.cfg?.workspace || deps?.cfg?.root;
  if (cand) return String(cand);
  const fromCtx = toolCtx?.root || toolCtx?.cwd || toolCtx?.workspace;
  return String(fromCtx || process.cwd());
}

/** 把 board 方法调用包成 Promise：不存在就返回 undefined，抛错也不外溢。 */
export async function callBoard(deps, method, ...args) {
  const board = deps?.board;
  if (!board || typeof board[method] !== 'function') return undefined;
  try {
    return await board[method](...args);
  } catch (err) {
    deps?.emit?.('board_error', { method, error: String(err?.message || err) });
    return undefined;
  }
}

/** 发事件给宿主（emit 可能是 async，失败也不影响主流程）。 */
export function emitSafe(deps, type, data) {
  try {
    const out = deps?.emit?.(type, data);
    if (out && typeof out.catch === 'function') out.catch(() => {});
  } catch { /* 事件丢了不算故障 */ }
}

/** 给 toolbelt 用的 ctx：把宿主依赖转成工具带认识的形状。 */
export function buildToolCtx({ deps, toolCtx, teamId } = {}) {
  const root = workspaceRoot(deps, toolCtx);
  const log = (text) => emitSafe(deps, 'log', { text: String(text) });
  return makeCtx({
    root,
    signal: toolCtx?.signal,
    log,
    board: deps?.board || null,
    teamId: teamId ? String(teamId) : '',
    registry: deps?.registry || null,
    runAgent: deps?.runAgent || null,
    dispatch: deps?.runAgent || null,
    ask: deps?.askUser || null,
    fetch: deps?.cfg?.fetch,
    emit: deps?.emit,
  });
}

/**
 * 定位小组：显式 teamId > toolCtx.teamId > cfg.teamId > 唯一的小组。
 * 返回 null 表示"没有小组"，调用方要给用户人话提示而不是崩。
 */
export async function resolveTeamId(deps, args = {}, toolCtx = {}) {
  const explicit = args.teamId || toolCtx.teamId || deps?.cfg?.teamId;
  if (explicit) return String(explicit);
  const teams = await callBoard(deps, 'listTeams');
  if (Array.isArray(teams) && teams.length === 1) return String(teams[0].id);
  return null;
}

/**
 * 把 registry / board 里的成员统一成 [{id,name,role,agent,status,capabilities}]。
 * 传 teamId 时把任务板里登记过的成员也算进来；否则只读环境注册表。
 */
export function listMembers(deps, teamId = '') {
  const reg = deps?.registry;
  let raw = null;
  if (Array.isArray(reg)) raw = reg;
  else if (Array.isArray(reg?.agents)) raw = reg.agents;
  else if (typeof reg?.list === 'function') {
    try {
      raw = reg.list();
    } catch {
      raw = null;
    }
  }
  const norm = (m) => (m && typeof m === 'object'
    ? {
        id: String(m.id ?? m.memberId ?? m.name ?? ''),
        name: String(m.name ?? m.label ?? m.id ?? ''),
        role: String(m.role ?? m.type ?? m.kind ?? 'worker'),
        agent: String(m.agent ?? m.cli ?? m.command ?? m.preset ?? ''),
        status: String(m.status ?? 'idle'),
        capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
        raw: m,
      }
    : null);
  const merged = [];
  const seen = new Set();
  const add = (m) => {
    const row = norm(m);
    if (!row || !row.id) return;
    const key = row.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(row);
  };
  if (teamId) {
    try {
      const boardRows = deps?.board?.listMembers?.(String(teamId));
      if (Array.isArray(boardRows)) boardRows.forEach(add);
    } catch { /* board 不可用时退回注册表 */ }
  }
  (Array.isArray(raw) ? raw : []).forEach(add);
  return merged;
}

/** 找成员：先按 id/name 精确找，再按角色找，最后按 agent 预设找。 */
export function pickMember(deps, wanted, teamId = '') {
  const list = listMembers(deps, teamId);
  if (!list.length) return null;
  const key = String(wanted ?? '').trim().toLowerCase();
  if (!key) return null;
  return (
    list.find((m) => m.id.toLowerCase() === key || m.name.toLowerCase() === key) ||
    list.find((m) => m.role.toLowerCase() === key) ||
    list.find((m) => m.agent.toLowerCase() === key) ||
    null
  );
}

/** 按角色挑一个空闲成员（并行派活时用）；传 teamId 时也看任务板登记的人。 */
export function pickMemberByRole(deps, role, teamId = '') {
  const list = listMembers(deps, teamId);
  const r = String(role || '').toLowerCase();
  const byRole = list.filter((m) => m.role.toLowerCase() === r);
  const pool = byRole.length ? byRole : list;
  return pool.find((m) => !/busy|running/.test(m.status)) || pool[0] || null;
}

export function clipText(text, max = 20_000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字）`;
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 参数的简短展示（报告里用，别把整个大文件内容塞进轨迹）。 */
export function summarizeArgs(args, max = 120) {
  if (args == null) return '';
  let s;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 稳定的 key（用于识别"重复的同一个工具调用"）。 */
export function stableKey(name, args) {
  let body;
  try {
    body = JSON.stringify(args, Object.keys(args || {}).sort());
  } catch {
    body = String(args);
  }
  return `${name}|${body}`;
}

/**
 * 派活给成员。deps.runAgent(spec, prompt, opts) 是 cli.js 的约定；
 * 返回统一成 { ok, rc, out, err, ms }，任何异常都变成 ok:false。
 */
export async function dispatchTo(deps, member, prompt, opts = {}) {
  if (typeof deps?.runAgent !== 'function') {
    return { ok: false, rc: 1, out: '', err: '宿主没有提供派活能力（deps.runAgent 缺失）', ms: 0 };
  }
  const started = Date.now();
  try {
    const spec = member?.raw || member || {};
    const res = await deps.runAgent(spec, prompt, opts);
    const ms = Number(res?.ms ?? res?.durationMs ?? Date.now() - started);
    const rc = Number(res?.rc ?? res?.exitCode ?? (res?.ok === false ? 1 : 0));
    return {
      ok: rc === 0 && res?.ok !== false,
      rc,
      out: String(res?.out ?? res?.stdout ?? res?.output ?? res?.content ?? ''),
      err: String(res?.err ?? res?.stderr ?? res?.error ?? ''),
      ms,
      raw: res,
    };
  } catch (err) {
    return { ok: false, rc: 1, out: '', err: `${err?.name || 'Error'}: ${err?.message || err}`, ms: Date.now() - started };
  }
}

/**
 * 宿主侧工具返回值形状（plugin-core 查实的真实 API）：
 *   definition = { name, description, parameters, output, execute, timeoutMs }
 *   execute(args, exec) 返回 { text } 或字符串；render 把值转成宿主认的 content 块。
 * 契约（CONTRACTS 2.8）只写了 name/description/parameters/execute，
 * 多出来的 output 是附加字段，不会破坏旧契约，但能让新宿主正确渲染。
 */
export const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '给人看的纯文本结果（报告/结论/错误说明）。' },
    },
    // required 必须写：宿主会拿 output.schema 做支持度校验，裸 properties 也能过，
    // 但写上 required 模型才知道"一定会有 text"，少一次试探。
    required: ['text'],
  },
  render(args, value) {
    const text = typeof value === 'string'
      ? value
      : String(value?.text ?? value?.content ?? value?.message ?? '');
    return [{ type: 'text', text }];
  },
};

/** 把任何返回值归一成宿主认的 { text }。 */
export function toToolResult(value) {
  if (typeof value === 'string') return { text: value };
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value;
    return { text: String(value.content ?? value.message ?? JSON.stringify(value)) };
  }
  return { text: String(value ?? '') };
}

/**
 * 工具统一的容错包装：execute 永远返回 { text }，绝不抛错。
 * 第二个参数（宿主叫 exec / 我们叫 toolCtx）形状不确定，只按需安全取值。
 */
export function safeExecute(toolName, fn) {
  return async (args, exec) => {
    try {
      const out = await fn(args && typeof args === 'object' ? args : {}, exec || {});
      return toToolResult(out);
    } catch (err) {
      const msg = `错误：${toolName} 运行失败 —— ${err?.name || 'Error'}: ${err?.message || err}`;
      try {
        exec?.logger?.warn?.(msg);
      } catch { /* 忽略 */ }
      return { text: msg };
    }
  };
}

/** 校验必填字段，返回错误文案或空字符串。 */
export function requireFields(args, fields) {
  const missing = fields.filter((f) => args?.[f] == null || String(args[f]).trim() === '');
  return missing.length ? `缺少必填参数：${missing.join('、')}` : '';
}
