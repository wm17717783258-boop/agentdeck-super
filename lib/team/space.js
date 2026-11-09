/**
 * lib/team/space.js —— 团队空间（共享记忆 + 成员 + 角色 + 席位）
 *
 * 为什么要有这一层：前面 8 个模块都是「一个人 + 一堆 Agent」，
 * 团队空间要回答的是「一群人 + 一堆 Agent」里那个最朴素的问题：
 *   谁在这个团队里？他是什么角色？他能看到哪些共享记忆？还能进几个人？
 * 所以这个文件的全部状态只有一个 JSON：`<root>/team/space.json`。
 *
 * 三条铁律（改代码前先读）：
 *   1. **席位是真闸门**：满了就 `{ ok:false, code:'seats_exhausted' }`，
 *      绝不"先加进去再说"。席位上限从 license 读（读不到才退回默认 3），不写死。
 *   2. **private 记忆不外泄**：别人分享的 private 条目，除了作者本人，
 *      谁查（recall）都看不见；调用方没给 viewerId 时按"最保守"处理——只给 team 范围。
 *   3. **坏文件不炸**：space.json 损坏/半截时所有函数返回 `{ ok:false, code:'corrupt' }`，
 *      一个异常都不往外抛（宿主里抛一次就是整个工具挂掉）。
 *
 * 写入一律 `.tmp` + rename（原子）：中途掉电不会留下半截 JSON。
 * 时间统一用 ISO 字符串存盘、epoch 毫秒参与比较，两者都在字段里，方便审计和测试。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 团队角色。注意：这是「人」的角色，和 engine/roles.js 的 Agent 角色不是一回事。 */
export const SPACE_ROLES = ['lead', 'worker', 'reviewer', 'viewer'];

/** 角色中文名（report 里给用户看，别把英文 key 甩出去）。 */
export const ROLE_LABELS = { lead: '组长', worker: '执行', reviewer: '评审', viewer: '只读' };

/** 读不到 license 时默认几个座位：3（免费版就是 3 席，符合产品定价）。 */
export const DEFAULT_SEATS = 3;

/** 席位硬上限：防止授权串里塞个 999999 把内存撑爆。 */
export const MAX_SEATS = 200;

export const TEAM_DIR = 'team';
export const SPACE_FILE = 'space.json';

/** 一轮最多接受多少条共享记忆，防止某个 Agent 刷屏把空间撑爆。 */
export const MAX_MEMORY_ENTRIES = 2000;

/** 单条共享记忆最长多少字（超出截断并标注，不是静默丢弃）。 */
export const MAX_MEMORY_CHARS = 4000;

// ── 路径 ────────────────────────────────────────────────────────────────

/** `<root>/team` */
export function teamDir(root) {
  return join(String(root || process.cwd()), TEAM_DIR);
}

/** `<root>/team/space.json` */
export function spacePath(root) {
  return join(teamDir(root), SPACE_FILE);
}

// ── 小工具 ──────────────────────────────────────────────────────────────

const str = (v) => (v == null ? '' : String(v)).trim();

/** now 参数允许是数字/日期/函数，统一成 epoch 毫秒。 */
function nowMs(now) {
  try {
    if (typeof now === 'function') return nowMs(now());
    if (now instanceof Date) return now.getTime();
    const n = Number(now);
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  } catch {
    return Date.now();
  }
}

const iso = (ms) => new Date(ms).toISOString();

/** 短路返回用的失败工厂：code 是给程序判断的，reason 是给人看的。 */
const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

/** 席位夹取：读到的值多离谱都要能落地成一个整数。 */
function clampSeats(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_SEATS;
  return Math.max(1, Math.min(MAX_SEATS, v));
}

/**
 * 从各种形状的「授权」里读出座位数（读不到返回 DEFAULT_SEATS）。
 *
 * 为什么这么宽容：调用方可能直接给数字、给 license 校验结果
 * `{ ok, tier, entitlements, claims }`、给 TIERS 里的权益对象、或者给
 * lib/license.js 的整个模块命名空间。团队空间不该因为传参形状不同就炸。
 * 优先级：显式数字 > claims.seats（用户买过的席位）> entitlements.maxSeats（档位上限）> 3
 */
export function seatLimit(license) {
  try {
    if (license == null) return DEFAULT_SEATS;
    if (typeof license === 'number') return clampSeats(license);
    if (typeof license === 'string') {
      const n = Number(license);
      return Number.isFinite(n) ? clampSeats(n) : DEFAULT_SEATS;
    }
    if (typeof license !== 'object') return DEFAULT_SEATS;

    // lib/license.js 模块命名空间：现算一次当前授权
    if (typeof license.currentLicense === 'function') {
      try {
        return seatLimit(license.currentLicense());
      } catch {
        return DEFAULT_SEATS;
      }
    }
    // 直接给了 claims（授权码里的真相）
    if (license.claims && typeof license.claims === 'object') {
      const s = Number(license.claims.seats);
      if (Number.isFinite(s) && s > 0) return clampSeats(s);
    }
    // 直接给了 seats 字段
    const direct = Number(license.seats);
    if (Number.isFinite(direct) && direct > 0) return clampSeats(direct);
    // 档位权益
    if (license.entitlements && typeof license.entitlements === 'object') {
      const s = Number(license.entitlements.maxSeats);
      if (Number.isFinite(s) && s > 0) return clampSeats(s);
    }
    const maxSeats = Number(license.maxSeats);
    if (Number.isFinite(maxSeats) && maxSeats > 0) return clampSeats(maxSeats);
    return DEFAULT_SEATS;
  } catch {
    return DEFAULT_SEATS;
  }
}

// ── 落盘 / 读盘 ─────────────────────────────────────────────────────────

/**
 * 原子写空间文件：先写 `<file>.tmp` 再 rename。
 * 失败不抛，返回 { ok:false, code:'write_failed' }（比如目录只读）。
 */
export function writeSpace(root, space) {
  const file = spacePath(root);
  try {
    mkdirSync(teamDir(root), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(space, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (err) {
    return fail('write_failed', `写空间文件失败：${err?.message || err}`);
  }
}

/** 空间形状校验：只要关键字段不对就当损坏，宁可报错也不带着半截数据跑。 */
function looksLikeSpace(v) {
  return Boolean(v && typeof v === 'object' && typeof v.id === 'string' && Array.isArray(v.members));
}

/**
 * 读空间。
 * @returns {{ok:true, space:object}|{ok:false, code:string, reason:string, space:null}}
 *   code: 'no_space'（还没建）/ 'corrupt'（文件坏了）/ 'read_failed'（权限等）
 */
export function readSpace({ root } = {}) {
  const file = spacePath(root);
  if (!existsSync(file)) return fail('no_space', '还没有团队空间', { space: null });
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return fail('read_failed', `读空间文件失败：${err?.message || err}`, { space: null });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail('corrupt', `空间文件不是合法 JSON：${err?.message || err}`, { space: null });
  }
  if (!looksLikeSpace(parsed)) return fail('corrupt', '空间文件缺少关键字段（id/members）', { space: null });
  return { ok: true, space: normalizeSpace(parsed) };
}

/** 补齐老版本/手改文件缺的字段，保证下游拿到的形状永远一致。 */
function normalizeSpace(space) {
  const s = space && typeof space === 'object' ? space : {};
  const members = Array.isArray(s.members) ? s.members.filter((m) => m && typeof m.id === 'string') : [];
  const total = clampSeats(s.seats?.total);
  return {
    id: String(s.id),
    name: str(s.name) || '未命名团队',
    createdAt: str(s.createdAt) || iso(Date.now()),
    ownerId: str(s.ownerId) || members[0]?.id || '',
    // seats.used 永远按 members 长度现算：存着的旧数字可能是手改的，信不过
    seats: { total, used: members.length },
    members: members.map((m) => ({
      id: String(m.id),
      name: str(m.name) || String(m.id),
      role: SPACE_ROLES.includes(m.role) ? m.role : 'worker',
      capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(str).filter(Boolean) : [],
      joinedAt: str(m.joinedAt) || iso(Date.now()),
    })),
    sharedMemory: Array.isArray(s.sharedMemory) ? s.sharedMemory.filter((e) => e && typeof e.text === 'string') : [],
    policy: {
      auditRetentionDays: Number.isFinite(Number(s.policy?.auditRetentionDays))
        ? Math.max(1, Math.floor(Number(s.policy.auditRetentionDays)))
        : 180,
      allowGuest: s.policy?.allowGuest !== false,
    },
  };
}

/** 读-改-写一条龙：返回 { ok, space } 或失败；写盘失败直接返回，不假装成功。 */
function mutate({ root }, fn) {
  const got = readSpace({ root });
  if (!got.ok) return got;
  const space = got.space;
  const result = fn(space);
  if (result && result.ok === false) return result;
  const written = writeSpace(root, space);
  if (!written.ok) return written;
  return { ok: true, space, path: written.path, ...(result?.extra || {}) };
}

// ── 建 / 查 ─────────────────────────────────────────────────────────────

/**
 * 建空间。已存在就原样返回（`created:false`），不覆盖用户数据。
 * 文件损坏时会先把坏文件改名留档（`space.corrupt-<ts>.json`）再重建，
 * 并把 `recovered:true` 如实写进返回，绝不悄悄把坏文件删了。
 */
export function createSpace({ root, name, ownerId, license, seats, now } = {}) {
  try {
    const existing = readSpace({ root });
    if (existing.ok) return { ok: true, created: false, space: existing.space, path: spacePath(root) };

    const t = nowMs(now);
    let recovered = false;
    let corruptBackup = '';
    if (existing.code === 'corrupt' || existing.code === 'read_failed') {
      // 留档而不是删除：用户的团队数据可能只是想手工救回来
      const file = spacePath(root);
      const backup = join(teamDir(root), `space.corrupt-${t}.json`);
      try {
        renameSync(file, backup);
        recovered = true;
        corruptBackup = backup;
      } catch {
        // 连改名都失败（只读目录）→ 直接返回失败，不硬写覆盖
        return fail('write_failed', `空间文件损坏且无法留档：${existing.reason}`);
      }
    }

    const owner = str(ownerId) || 'owner';
    const total = seats != null ? clampSeats(seats) : seatLimit(license);
    const space = {
      id: `space_${t.toString(36)}${randomUUID().slice(0, 6)}`,
      name: str(name) || '我的团队',
      createdAt: iso(t),
      ownerId: owner,
      seats: { total, used: 1 },
      members: [
        { id: owner, name: str(name) ? `${str(name)}·组长` : '组长', role: 'lead', capabilities: [], joinedAt: iso(t) },
      ],
      sharedMemory: [],
      policy: { auditRetentionDays: 180, allowGuest: true },
    };
    const written = writeSpace(root, space);
    if (!written.ok) return written;
    return { ok: true, created: true, space, path: written.path, recovered, corruptBackup };
  } catch (err) {
    return fail('internal', `建空间时出错：${err?.message || err}`);
  }
}

/** 取空间（不存在就 undefined，方便调用方 `if (!getSpace(...))`）。 */
export function getSpace({ root } = {}) {
  const got = readSpace({ root });
  return got.ok ? got.space : null;
}

/** 空间是否匹配给定 spaceId（没给 spaceId 视为匹配：单空间场景下省事）。 */
function idMatches(space, spaceId) {
  const want = str(spaceId);
  if (!want) return true;
  return want === space.id;
}

/** 统一的「取空间 + 校验 id」前置检查。 */
function loadSpace({ root, spaceId } = {}) {
  const got = readSpace({ root });
  if (!got.ok) return got;
  if (!idMatches(got.space, spaceId)) {
    return fail('space_mismatch', `空间 id 不匹配：期望 ${got.space.id}，收到 ${spaceId}`, { space: got.space });
  }
  return got;
}

// ── 成员 / 席位 ─────────────────────────────────────────────────────────

/** 成员对外形状（不含任何内部字段，也别把 capabilities 丢了）。 */
function memberView(m) {
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    roleLabel: ROLE_LABELS[m.role] || m.role,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities.slice() : [],
    joinedAt: m.joinedAt,
  };
}

/** 席位数：total 用空间里存的（建空间时按 license 定），used 现算。 */
export function seatUsage(space) {
  const total = clampSeats(space?.seats?.total);
  const used = Array.isArray(space?.members) ? space.members.length : 0;
  return { total, used, free: Math.max(0, total - used) };
}

/**
 * 加人。席位满 → `{ ok:false, code:'seats_exhausted' }`，**不加**。
 * 同 id 重复加入 → `{ ok:true, existing:true }`，不吃席位（幂等，重试安全）。
 * @param {{ root:string, spaceId?:string, member?:object, id?:string, name?:string,
 *           role?:string, capabilities?:string[], license?:object, now?:number }} o
 */
export function joinSpace({ root, spaceId, member, id, name, role, capabilities, license, now } = {}) {
  return mutate({ root }, (space) => {
    if (!idMatches(space, spaceId)) {
      return fail('space_mismatch', `空间 id 不匹配：期望 ${space.id}，收到 ${spaceId}`);
    }
    const spec = member && typeof member === 'object' ? member : {};
    const mid = str(spec.id ?? spec.memberId ?? id);
    if (!mid) return fail('bad_member', '缺少成员 id（member.id 或 id 参数）');

    // 授权档位可能中途升级/降级：给了 license 就顺手刷新总席位（不小于已用人数）
    if (license != null) {
      const refreshed = seatLimit(license);
      if (refreshed > 0) space.seats.total = Math.max(space.members.length, refreshed);
    }

    const dup = space.members.find((m) => m.id === mid);
    if (dup) return { ok: true, extra: { member: memberView(dup), existing: true, seats: seatUsage(space) } };

    const use = seatUsage(space);
    if (use.used + 1 > use.total) {
      return fail('seats_exhausted', `席位已满（${use.used}/${use.total}）：这是授权档位上限，不是 bug`, {
        seats: use,
      });
    }

    const wantRole = str(role ?? spec.role) || 'worker';
    const m = {
      id: mid,
      name: str(spec.name ?? spec.memberName ?? name) || mid,
      role: SPACE_ROLES.includes(wantRole) ? wantRole : 'worker',
      capabilities: Array.isArray(spec.capabilities ?? capabilities)
        ? (spec.capabilities ?? capabilities).map(str).filter(Boolean)
        : [],
      joinedAt: iso(nowMs(now)),
    };
    space.members.push(m);
    return { ok: true, extra: { member: memberView(m), existing: false, seats: seatUsage(space) } };
  });
}

/**
 * 内部：把人从空间里摘掉，并清掉他自己的 private 共享记忆。
 * team 范围的记忆保留（那是团队知识，不随人走）。
 */
function dropMember(space, memberId, { protectOwner = true } = {}) {
  const mid = str(memberId);
  if (!mid) return fail('bad_member', '缺少成员 id');
  const idx = space.members.findIndex((m) => m.id === mid);
  if (idx < 0) return fail('no_member', `空间里没有成员 ${mid}`, { seats: seatUsage(space) });
  if (protectOwner && space.ownerId === mid) {
    return fail('owner_cannot_leave', '房主不能退出或移除（先把 lead 角色交给别人，或重建空间）');
  }
  space.members.splice(idx, 1);
  const before = space.sharedMemory.length;
  space.sharedMemory = space.sharedMemory.filter((e) => !(e.scope === 'private' && e.authorId === mid));
  const clearedPrivate = before - space.sharedMemory.length;
  return { ok: true, extra: { removed: mid, clearedPrivate, seats: seatUsage(space) } };
}

/** 退出空间（房主受保护，见 dropMember）。 */
export function leaveSpace({ root, spaceId, memberId } = {}) {
  return mutate({ root }, (space) => {
    if (!idMatches(space, spaceId)) return fail('space_mismatch', `空间 id 不匹配：${spaceId}`);
    return dropMember(space, memberId);
  });
}

/** 移除成员（管理员动作，语义同 leaveSpace，单独导出便于审计区分动作名）。 */
export function removeMember({ root, spaceId, memberId } = {}) {
  return mutate({ root }, (space) => {
    if (!idMatches(space, spaceId)) return fail('space_mismatch', `空间 id 不匹配：${spaceId}`);
    return dropMember(space, memberId);
  });
}

/** 列成员 + 席位用量。空间没建 → `{ ok:false, code:'no_space', members: [] }`。 */
export function listMembers({ root, spaceId } = {}) {
  const got = loadSpace({ root, spaceId });
  if (!got.ok) return { ...got, members: [] };
  return {
    ok: true,
    spaceId: got.space.id,
    members: got.space.members.map(memberView),
    seats: seatUsage(got.space),
  };
}

/**
 * 改角色。
 * 拒绝两种越权：角色名不认识（`bad_role`）、把最后一个 lead 降级（`last_lead`）。
 */
export function setRole({ root, spaceId, memberId, role } = {}) {
  const want = str(role);
  if (!SPACE_ROLES.includes(want)) {
    return fail('bad_role', `角色只能是 ${SPACE_ROLES.join('/')}，收到 "${want || '空'}"`);
  }
  return mutate({ root }, (space) => {
    if (!idMatches(space, spaceId)) return fail('space_mismatch', `空间 id 不匹配：${spaceId}`);
    const m = space.members.find((x) => x.id === str(memberId));
    if (!m) return fail('no_member', `空间里没有成员 ${memberId}`);
    const leads = space.members.filter((x) => x.role === 'lead');
    if (m.role === 'lead' && want !== 'lead' && leads.length <= 1) {
      return fail('last_lead', '至少要留一个 lead：先把别人升成 lead，再改这个');
    }
    const from = m.role;
    m.role = want;
    return { ok: true, extra: { member: memberView(m), from, to: want } };
  });
}

// ── 共享记忆 ────────────────────────────────────────────────────────────

/** 记忆条目过期判断：没 expiresAt 就是永不过期。 */
function isExpired(entry, t) {
  if (!entry?.expiresAt) return false;
  const at = Date.parse(entry.expiresAt);
  if (!Number.isFinite(at)) return false;
  return at <= t;
}

/**
 * 写一条共享记忆。
 * @param {{ root:string, spaceId?:string, text:string, scope?:'team'|'private',
 *           source?:string, ttlDays?:number, actorId?:string, memberId?:string,
 *           tags?:string[], now?:number }} o
 * @returns 成功 `{ ok:true, entry }`；过期/超量/空文本都有明确 code。
 */
export function shareMemory({
  root, spaceId, text, scope, source, ttlDays, actorId, memberId, authorId, tags, now,
} = {}) {
  const body = str(text);
  if (!body) return fail('empty_text', '共享记忆不能是空文本');
  const clipped = body.length > MAX_MEMORY_CHARS
    ? `${body.slice(0, MAX_MEMORY_CHARS)}\n…（已截断，原文 ${body.length} 字）`
    : body;
  const wantScope = str(scope).toLowerCase() === 'private' ? 'private' : 'team';

  return mutate({ root }, (space) => {
    if (!idMatches(space, spaceId)) return fail('space_mismatch', `空间 id 不匹配：${spaceId}`);
    if (space.sharedMemory.length >= MAX_MEMORY_ENTRIES) {
      return fail('memory_full', `共享记忆已达上限 ${MAX_MEMORY_ENTRIES} 条，先清理再写`);
    }
    const t = nowMs(now);
    const days = Number(ttlDays);
    const hasTtl = Number.isFinite(days) && days > 0;
    const entry = {
      id: `mem_${t.toString(36)}${randomUUID().slice(0, 6)}`,
      authorId: str(authorId ?? actorId ?? memberId) || 'anonymous',
      scope: wantScope,
      text: clipped,
      source: str(source) || 'unknown',
      tags: Array.isArray(tags) ? tags.map(str).filter(Boolean).slice(0, 20) : [],
      ttlDays: hasTtl ? days : null,
      createdAt: iso(t),
      expiresAt: hasTtl ? iso(t + days * 86400_000) : null,
    };
    space.sharedMemory.push(entry);
    return { ok: true, extra: { entry } };
  });
}

/** 记忆对某个观察者是否可见：team 人人可见；private 只有作者本人可见。 */
function visibleTo(entry, viewerId) {
  if (entry.scope !== 'private') return true;
  return Boolean(viewerId) && entry.authorId === viewerId;
}

/** 关键词匹配：text / source / tags 任意命中即可（大小写不敏感）。 */
function matchesQuery(entry, q) {
  if (!q) return true;
  const hay = `${entry.text}\n${entry.source || ''}\n${(entry.tags || []).join(' ')}`.toLowerCase();
  return hay.includes(q);
}

/**
 * 召回共享记忆。
 * 过滤器：`spaceId` 匹配 → 未过期 → 可见（team 全见 / private 仅作者）→ 关键词。
 * 没给 `viewerId` 时**只返回 team 范围**（最保守，不猜"我是谁"）。
 * @returns {{ok:true, spaceId:string, items:object[], hits:number, filtered:{expired:number,private:number}}}
 */
export function recallTeamMemory({ root, spaceId, query, viewerId, limit, now } = {}) {
  const got = loadSpace({ root, spaceId });
  if (!got.ok) return { ...got, items: [], hits: 0 };
  const t = nowMs(now);
  const q = str(query).toLowerCase();
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 50;

  let expired = 0;
  let hidden = 0;
  const items = [];
  for (const entry of got.space.sharedMemory) {
    if (isExpired(entry, t)) {
      expired += 1;
      continue;
    }
    if (!visibleTo(entry, str(viewerId))) {
      hidden += 1;
      continue;
    }
    if (!matchesQuery(entry, q)) continue;
    items.push({ ...entry });
  }
  // 新的在前：召回时"刚说的"通常最相关
  items.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return {
    ok: true,
    spaceId: got.space.id,
    items: items.slice(0, cap),
    hits: Math.min(items.length, cap),
    totalMatched: items.length,
    filtered: { expired, private: hidden },
  };
}

/** 清掉已过期的记忆（写盘；返回清了多少条）。 */
export function pruneExpiredMemory({ root, spaceId, now } = {}) {
  return mutate({ root }, (space) => {
    if (!idMatches(space, spaceId)) return fail('space_mismatch', `空间 id 不匹配：${spaceId}`);
    const t = nowMs(now);
    const before = space.sharedMemory.length;
    space.sharedMemory = space.sharedMemory.filter((e) => !isExpired(e, t));
    return { ok: true, extra: { pruned: before - space.sharedMemory.length, kept: space.sharedMemory.length } };
  });
}

// ── 状态 ────────────────────────────────────────────────────────────────

/** 团队空间总览（工具 `status` 用；也方便 Lead 接线到状态页）。 */
export function spaceStatus({ root, spaceId, license, now } = {}) {
  const got = loadSpace({ root, spaceId });
  if (!got.ok) return got;
  const space = got.space;
  const t = nowMs(now);
  const byRole = {};
  for (const r of SPACE_ROLES) byRole[r] = 0;
  for (const m of space.members) byRole[m.role] = (byRole[m.role] || 0) + 1;
  const teamMem = space.sharedMemory.filter((e) => e.scope !== 'private' && !isExpired(e, t)).length;
  const privateMem = space.sharedMemory.filter((e) => e.scope === 'private' && !isExpired(e, t)).length;
  const expiredMem = space.sharedMemory.filter((e) => isExpired(e, t)).length;
  return {
    ok: true,
    space: {
      id: space.id,
      name: space.name,
      createdAt: space.createdAt,
      ownerId: space.ownerId,
    },
    seats: { ...seatUsage(space), limitFromLicense: seatLimit(license) },
    members: { total: space.members.length, byRole },
    memory: { team: teamMem, private: privateMem, expired: expiredMem, total: space.sharedMemory.length },
    policy: { ...space.policy },
  };
}

/** 该 API 版本里明确没做的企业能力——工具和文档都拿这份清单当唯一真相源。 */
export const UNIMPLEMENTED = ['sso', 'scim', 'private-deploy'];

export default {
  SPACE_ROLES,
  ROLE_LABELS,
  DEFAULT_SEATS,
  MAX_SEATS,
  UNIMPLEMENTED,
  teamDir,
  spacePath,
  seatLimit,
  seatUsage,
  readSpace,
  writeSpace,
  createSpace,
  getSpace,
  joinSpace,
  leaveSpace,
  removeMember,
  listMembers,
  setRole,
  shareMemory,
  recallTeamMemory,
  pruneExpiredMemory,
  spaceStatus,
};
