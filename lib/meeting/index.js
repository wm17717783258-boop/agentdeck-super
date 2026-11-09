/**
 * lib/meeting/index.js —— 跨厂商会议：把 Claude / Codex / dsh 各自的意见收进同一份纪要
 *
 * 为什么需要它：
 *   现在每个 Agent 都能连上任务板，但"三个人各说各的"和"开完会有一份能追责的纪要"
 *   是两件事。会议把过程留在盘上：谁提了什么、谁反对、最后怎么定的、拆成了哪几条任务。
 *
 * 目录结构（`<工作区>/.agentdeck/meetings/<会议号>/`）：
 *   meta.json      会议元信息（议题、参与人、议程、冲突、投票、状态、决议、任务号）
 *   proposals.jsonl 逐条意见（一行一条，追加写，坏了也只坏一行）
 *   minutes.md     中文会议纪要（人看得懂，也能直接贴给老板）
 *
 * 刻意**不**依赖模型：纪要由真实意见项目符号化汇总而成。
 * 需要模型润色/收敛的地方交给 pet_meeting（它才需要 chat 注入）。
 *
 * 补齐的四件（1.9）：议程（agenda）、冲突（conflict）、投票（vote）、裁决（decision）。
 * 裁决落成 meta.decision = { decidedBy, rationale, chosen, conflictsResolved, at }；
 * 老会议那句纯文本决议仍是字符串，读的时候用 decisionText()/decisionRecordOf() 区分。
 * 语义底线：没有 rationale（为什么这么定）就不许结会；议程项没结论就列进 unresolved 拦住。
 * 老会议（open 时没给议程）保留原行为，免得把已经在用的调用方全部打死。
 *
 * 底线：所有函数返回 { ok, ... }；任何 IO 失败都给人话原因，不 throw。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MEETING_DIRNAME = '.agentdeck/meetings';
/** 单条意见上限（防止某个 Agent 贴一整个文件进来）。 */
export const MAX_PROPOSAL_CHARS = 4000;
/** 一次会议最多多少条意见。 */
export const MAX_PROPOSALS = 60;
/** 一次会议最多拆多少条任务。 */
export const MAX_TASKS = 12;
/** 一次会议最多几项议程 / 几条冲突登记（防止把议程当备忘录刷）。 */
export const MAX_AGENDA = 24;
export const MAX_CONFLICTS = 40;
/** 单个 agent 能声明的能力上限。 */
export const MAX_CAPABILITIES = 12;
export const STANCES = ['支持', '反对', '补充'];
/** 投票选项：赞成 / 反对 / 弃权；调用方也可以传别的词（原样计数）。 */
export const VOTE_CHOICES = ['赞成', '反对', '弃权'];
export const AGENDA_STATUS = ['open', 'resolved'];
export const CONFLICT_STATUS = ['open', 'resolved'];
export const STATUS_OPEN = 'open';
export const STATUS_CONCLUDED = 'concluded';

const VENDOR_LABEL = {
  claude: 'Claude',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  dsh: 'DSH',
  gemini: 'Gemini',
  cursor: 'Cursor',
  human: '人',
};

export function vendorLabel(vendor) {
  const key = String(vendor || '').toLowerCase();
  return VENDOR_LABEL[key] || String(vendor || '未知');
}

function str(v, fallback = '') {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : fallback;
}

function nowIso(nowMs) {
  return new Date(Number(nowMs)).toISOString();
}

export function meetingsRoot(root) {
  return join(String(root || process.cwd()), MEETING_DIRNAME);
}

export function meetingDir(root, id) {
  return join(meetingsRoot(root), String(id || ''));
}

/** 会议号：按天可读 + 随机后缀，撞不了也一眼看得出日期。 */
export function newMeetingId(nowMs = Date.now()) {
  const d = new Date(Number(nowMs));
  const p = (n) => String(n).padStart(2, '0');
  return `mtg_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${randomBytes(3).toString('hex')}`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 破坏性写入一律"先写 .tmp 再 rename"：进程半路被杀时，读者要么看到旧文件、
 * 要么看到新文件，绝不会读到写了一半的 meta.json（撕裂 0 次）。
 */
function safeWrite(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 清不掉临时文件也不该掩盖真实错误 */ }
    return { ok: false, error: String(err?.message || err) };
  }
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 能力归一：小写去空白、去重、限量，方便跨厂商对同一件事用不同写法。 */
export function normalizeCapabilities(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，、\s]+/) : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const cap = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!cap || seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap.slice(0, 40));
    if (out.length >= MAX_CAPABILITIES) break;
  }
  return out;
}

/** 参与者：字符串 / {name,vendor,role,capabilities} 都收，统一成同一形状。 */
function normalizeParticipants(participants) {
  return (Array.isArray(participants) ? participants : [])
    .map((p) => (typeof p === 'string' ? { name: p } : p && typeof p === 'object' ? p : null))
    .filter(Boolean)
    .map((p) => ({
      name: str(p.name, '未署名'),
      vendor: str(p.vendor),
      role: str(p.role, 'participant'),
      capabilities: normalizeCapabilities(p.capabilities ?? p.capability),
    }));
}

/** 议程项：标题必填，owner/minutes 可选；id 由调用方或本模块给。 */
function normalizeAgendaItem(item, fallbackId) {
  const src = typeof item === 'string' ? { title: item } : item && typeof item === 'object' ? item : null;
  if (!src) return null;
  const title = str(src.title);
  if (!title) return null;
  return {
    id: str(src.id, fallbackId),
    title,
    owner: str(src.owner) || null,
    capability: str(src.capability) || null,
    assignedVia: str(src.assignedVia) || null,
    minutes: Number.isFinite(Number(src.minutes)) ? Math.max(0, num(src.minutes)) : null,
    status: AGENDA_STATUS.includes(str(src.status)) ? str(src.status) : 'open',
    conclusion: str(src.conclusion) || null,
    createdAt: str(src.createdAt) || null,
    resolvedAt: str(src.resolvedAt) || null,
    resolvedBy: str(src.resolvedBy) || null,
  };
}

/** 下一个可用编号：ag_1、ag_2…（已有 id 绝不覆盖，重开会话也不会撞）。 */
function nextId(prefix, existing) {
  const used = new Set((Array.isArray(existing) ? existing : []).map((x) => str(x?.id)));
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

/** 读出来的 meta 一律补齐新字段：老会议文件没有 agenda/conflicts/votes 也能直接用。 */
function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || !meta.id) return null;
  const agenda = (Array.isArray(meta.agenda) ? meta.agenda : [])
    .map((item, i) => normalizeAgendaItem(item, `ag_${i + 1}`))
    .filter(Boolean);
  const conflicts = (Array.isArray(meta.conflicts) ? meta.conflicts : [])
    .filter((c) => c && typeof c === 'object' && str(c.id))
    .map((c) => ({
      id: str(c.id),
      agendaId: str(c.agendaId) || null,
      between: (Array.isArray(c.between) ? c.between : []).map((x) => str(x)).filter(Boolean).slice(0, 2),
      summary: str(c.summary),
      status: CONFLICT_STATUS.includes(str(c.status)) ? str(c.status) : 'open',
      resolution: str(c.resolution) || null,
      raisedAt: str(c.raisedAt) || null,
      raisedBy: str(c.raisedBy) || null,
      resolvedAt: str(c.resolvedAt) || null,
      resolvedBy: str(c.resolvedBy) || null,
    }));
  const votes = (Array.isArray(meta.votes) ? meta.votes : [])
    .filter((v) => v && typeof v === 'object' && str(v.agendaId) && str(v.agentId))
    .map((v) => ({
      agendaId: str(v.agendaId),
      agentId: str(v.agentId),
      choice: str(v.choice, '弃权'),
      at: str(v.at) || null,
      revoted: Boolean(v.revoted),
      previous: str(v.previous) || null,
    }));
  return {
    ...meta,
    participants: normalizeParticipants(meta.participants),
    agenda,
    conflicts,
    votes,
    decision: normalizeDecision(meta.decision),
    tasks: Array.isArray(meta.tasks) ? meta.tasks : [],
    taskIds: Array.isArray(meta.taskIds) ? meta.taskIds : [],
  };
}

/**
 * 决议字段兼容两种形态：
 *   · 1.9 起的裁决：{ decidedBy, rationale, chosen, conflictsResolved }
 *   · 1.8 老会议的纯文本决议：'就按今天说的办'
 * 脏数据（对象里没 chosen / 不是字符串也不是对象）一律当"还没定"，不猜。
 */
function normalizeDecision(value) {
  if (typeof value === 'string') return str(value) || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const chosen = str(value.chosen);
  if (!chosen) return null;
  return {
    decidedBy: str(value.decidedBy) || null,
    rationale: str(value.rationale) || null,
    chosen,
    conflictsResolved: (Array.isArray(value.conflictsResolved) ? value.conflictsResolved : []).map((x) => str(x)).filter(Boolean),
  };
}

/** 裁决记录：meta.decision 是对象时才算有；老会议的纯文本决议返回 null。 */
export function decisionRecordOf(meta) {
  const d = meta && typeof meta === 'object' ? meta.decision : null;
  return d && typeof d === 'object' && !Array.isArray(d) ? normalizeDecision(d) : null;
}

/** 决议正文：裁决对象取 chosen，老会议就是那段文本；没定返回空串。 */
export function decisionText(meta) {
  const d = meta && typeof meta === 'object' ? meta.decision : null;
  if (typeof d === 'string') return str(d);
  const record = decisionRecordOf(meta);
  return record ? record.chosen : '';
}

function loadMeta(root, id) {
  const file = join(meetingDir(root, id), 'meta.json');
  return normalizeMeta(readJson(file));
}

function saveMeta(root, meta) {
  return safeWrite(join(meetingDir(root, meta.id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

/** 有议程 = 走新流程（裁决/议程校验）；没议程 = 老会议，行为与 1.8 完全一致。 */
export function isGoverned(meta) {
  return Array.isArray(meta?.agenda) && meta.agenda.length > 0;
}

/** 议程里还没结论的那些（结会前必须清空）。 */
export function unresolvedAgenda(meta) {
  return (Array.isArray(meta?.agenda) ? meta.agenda : [])
    .filter((item) => !item.conclusion || item.status !== 'resolved')
    .map((item) => ({ id: item.id, title: item.title, owner: item.owner }));
}

function findAgenda(meta, agendaId) {
  const id = str(agendaId);
  return id ? meta.agenda.find((a) => a.id === id) || null : null;
}

/** 投票统计：票数分布 + 谁投了什么（一人一票，重复投票已覆盖）。 */
export function tallyVotes(votes, agendaId) {
  const list = (Array.isArray(votes) ? votes : []).filter((v) => !agendaId || v.agendaId === agendaId);
  const byChoice = {};
  for (const v of list) byChoice[v.choice] = (byChoice[v.choice] || 0) + 1;
  return {
    total: list.length,
    byChoice,
    voters: list.map((v) => v.agentId),
    detail: list.map((v) => ({ agentId: v.agentId, choice: v.choice, revoted: Boolean(v.revoted) })),
  };
}

function votesReply(meta, agendaId) {
  const tally = tallyVotes(meta.votes, agendaId);
  return { ok: true, agendaId: agendaId || null, votes: meta.votes.filter((v) => !agendaId || v.agendaId === agendaId), tally };
}

function loadProposals(root, id) {
  const file = join(meetingDir(root, id), 'proposals.jsonl');
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 开一场会。participants 可以是 ['小犀','小鹿'] 或 [{name,vendor,role,capabilities}]。 */
export function openMeeting({ root, topic, goal, participants, agenda, now = () => Date.now() } = {}) {
  const title = str(topic);
  if (!title) return { ok: false, error: '开会得有个议题（参数 topic）。' };
  const id = newMeetingId(Number(now()));
  const list = normalizeParticipants(participants);
  const items = (Array.isArray(agenda) ? agenda : [])
    .slice(0, MAX_AGENDA)
    .map((item, i) => normalizeAgendaItem(item, `ag_${i + 1}`))
    .filter(Boolean)
    .map((item) => ({ ...item, createdAt: item.createdAt || nowIso(now()) }));
  const meta = {
    id,
    topic: title,
    goal: str(goal),
    participants: list,
    agenda: items,
    conflicts: [],
    votes: [],
    createdAt: nowIso(now()),
    status: STATUS_OPEN,
    decision: null,
    concludedAt: null,
    taskIds: [],
  };
  const saved = saveMeta(root, meta);
  if (!saved.ok) return { ok: false, error: `会议目录建不出来：${saved.error}` };
  safeWrite(join(meetingDir(root, id), 'proposals.jsonl'), '');
  return { ok: true, meeting: meta, dir: meetingDir(root, id) };
}

/** 收一条意见：谁（from/vendor）、什么态度（stance）、说了什么（text）。 */
export function submitProposal({ root, meetingId, from, vendor, stance, text, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结会了，不再收意见（要补充请新开一场）。' };
  const body = str(text);
  if (!body) return { ok: false, error: '意见是空的（参数 text）。' };
  const existing = loadProposals(root, meetingId);
  if (existing.length >= MAX_PROPOSALS) return { ok: false, error: `这场会已经 ${MAX_PROPOSALS} 条意见了，先结会吧。` };
  const who = str(from, '匿名');
  const record = {
    id: `pp_${randomBytes(3).toString('hex')}`,
    at: nowIso(now()),
    from: who,
    vendor: str(vendor),
    stance: STANCES.includes(str(stance)) ? str(stance) : '补充',
    text: body.length > MAX_PROPOSAL_CHARS ? `${body.slice(0, MAX_PROPOSAL_CHARS - 1)}…` : body,
  };
  try {
    appendFileSync(join(meetingDir(root, meetingId), 'proposals.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: `意见写盘失败：${String(err?.message || err)}` };
  }
  // 第一次发言的人自动进参与人名单（跨厂商协作时没人去手工维护名单）
  if (!meta.participants.some((p) => p.name === who)) {
    meta.participants.push({ name: who, vendor: record.vendor, role: 'participant' });
    saveMeta(root, meta);
  }
  return { ok: true, proposal: record, count: existing.length + 1 };
}

/** 读一场会的当前状态（工具/状态页用）：坏文件返回 ok:false，绝不抛。 */
export function getMeeting({ root, meetingId } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId || '（没给会议号）'}` };
  return { ok: true, meeting: meta };
}

/** 追加议程项：open 时只给了个大概，就靠它一条条补齐。 */
export function addAgenda({ root, meetingId, agenda, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结会了，不再加议程（要改请新开一场）。' };
  const raw = (Array.isArray(agenda) ? agenda : agenda ? [agenda] : []).slice(0, MAX_AGENDA);
  if (!raw.length) return { ok: false, error: '议程是空的（参数 agenda）：至少给一条 {title}。' };
  const added = [];
  for (const it of raw) {
    if (meta.agenda.length >= MAX_AGENDA) break;
    const item = normalizeAgendaItem(it, nextId('ag', meta.agenda));
    if (!item) continue;
    meta.agenda.push({ ...item, createdAt: nowIso(now()) });
    added.push(meta.agenda[meta.agenda.length - 1]);
  }
  if (!added.length) return { ok: false, error: '议程项得有标题（title）。' };
  const saved = saveMeta(root, meta);
  if (!saved.ok) return { ok: false, error: `会议元信息写盘失败：${saved.error}` };
  return { ok: true, added, agenda: meta.agenda };
}

/**
 * 按能力给议程项派 owner。
 * 池子 = 会议参与人（open 时带 capabilities）+ 宿主登记成员（工具层传 agents）。
 * 匹配不到就明确说 no_match —— 不猜、不硬塞一个"看起来合适"的人。
 */
export function assignAgenda({ root, meetingId, agendaId, capability, agentId, agents, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结会了，不再改分工。' };
  const item = findAgenda(meta, agendaId);
  if (!item) {
    return {
      ok: false,
      code: 'no_agenda',
      error: agendaId ? `议程里没有这一项：${agendaId}` : '得给 agendaId（不知道就先 action:"agenda" 看一眼）。',
    };
  }
  const pool = [
    ...meta.participants.map((p) => ({ name: p.name, capabilities: normalizeCapabilities(p.capabilities) })),
    ...(Array.isArray(agents) ? agents : []).map((a) => ({
      name: str(a?.name ?? a?.id),
      capabilities: normalizeCapabilities(a?.capabilities ?? a?.capability),
    })),
  ].filter((a) => a.name);
  const explicit = str(agentId);
  if (explicit) {
    const hit = pool.find((a) => a.name.toLowerCase() === explicit.toLowerCase());
    if (!hit) return { ok: false, code: 'no_match', agentId: explicit, error: `名单里没有这个 agent：${explicit}` };
    item.owner = hit.name;
    item.capability = null;
    item.assignedVia = 'agentId';
  } else {
    const want = normalizeCapabilities(capability)[0] || '';
    if (!want) return { ok: false, code: 'no_match', error: '得给 capability（或者直接给 agentId）。' };
    const hit = pool.find((a) => a.capabilities.includes(want));
    if (!hit) {
      const roster = pool.length ? pool.map((a) => `${a.name}（${a.capabilities.join('、') || '没标能力'}）`).join('；') : '名单是空的';
      return { ok: false, code: 'no_match', capability: want, error: `没人认领「${want}」这项能力：${roster}` };
    }
    item.owner = hit.name;
    item.capability = want;
    item.assignedVia = 'capability';
  }
  const saved = saveMeta(root, meta);
  if (!saved.ok) return { ok: false, error: `会议元信息写盘失败：${saved.error}` };
  return { ok: true, agenda: item, owner: item.owner, matchedBy: item.assignedVia, agendaId: item.id };
}

/** 给某一项议程写结论。结会前每一项都得有它，否则 conclude 会被 unresolved 拦住。 */
export function resolveAgendaItem({ root, meetingId, agendaId, conclusion, by, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结会了，结论不再改。' };
  const item = findAgenda(meta, agendaId);
  if (!item) return { ok: false, code: 'no_agenda', error: agendaId ? `议程里没有这一项：${agendaId}` : '得给 agendaId。' };
  const body = str(conclusion);
  if (!body) return { ok: false, code: 'conclusion_required', error: '议程项得有结论（conclusion）：开会不是聊天，得落到一句话。' };
  item.status = 'resolved';
  item.conclusion = body;
  item.resolvedAt = nowIso(now());
  item.resolvedBy = str(by) || null;
  const saved = saveMeta(root, meta);
  if (!saved.ok) return { ok: false, error: `会议元信息写盘失败：${saved.error}` };
  return { ok: true, agenda: item, unresolved: unresolvedAgenda(meta) };
}

/** 登记冲突：同一议程项上两份互相矛盾的提案，由调用方显式点名，不靠猜。 */
export function raiseConflict({ root, meetingId, agendaId, between, summary, by, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结会了，冲突不再登记。' };
  const item = findAgenda(meta, agendaId);
  if (!item) return { ok: false, code: 'no_agenda', error: agendaId ? `议程里没有这一项：${agendaId}` : '冲突要挂在某项议程上（agendaId）。' };
  const pair = (Array.isArray(between) ? between : []).map((x) => str(x)).filter(Boolean);
  if (pair.length !== 2) return { ok: false, code: 'invalid_between', error: '冲突得说清是谁跟谁（between:[甲,乙]）。' };
  if (pair[0].toLowerCase() === pair[1].toLowerCase()) return { ok: false, code: 'invalid_between', error: '冲突双方不能是同一个。' };
  const why = str(summary);
  if (!why) return { ok: false, code: 'summary_required', error: '冲突得写清争的是什么（summary）。' };
  if (meta.conflicts.length >= MAX_CONFLICTS) return { ok: false, error: `这场会已经登记 ${MAX_CONFLICTS} 条冲突了，先了结一些。` };
  const conflict = {
    id: nextId('cf', meta.conflicts),
    agendaId: item.id,
    between: [pair[0], pair[1]],
    summary: why,
    status: 'open',
    resolution: null,
    raisedAt: nowIso(now()),
    raisedBy: str(by) || null,
    resolvedAt: null,
    resolvedBy: null,
  };
  meta.conflicts.push(conflict);
  const saved = saveMeta(root, meta);
  if (!saved.ok) return { ok: false, error: `会议元信息写盘失败：${saved.error}` };
  return { ok: true, conflict, conflicts: meta.conflicts };
}

/** 了结一条冲突：必须写清怎么了的，不能只把状态改成 resolved。 */
export function resolveConflict({ root, meetingId, conflictId, resolution, by, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结会了，冲突不再改。' };
  const id = str(conflictId);
  const conflict = id ? meta.conflicts.find((c) => c.id === id) : null;
  if (!conflict) return { ok: false, code: 'no_conflict', error: id ? `没有这条冲突：${id}` : '得给 conflictId。' };
  const body = str(resolution);
  if (!body) return { ok: false, code: 'resolution_required', error: '了结冲突得写清怎么解决的（resolution）。' };
  conflict.status = 'resolved';
  conflict.resolution = body;
  conflict.resolvedAt = nowIso(now());
  conflict.resolvedBy = str(by) || null;
  const saved = saveMeta(root, meta);
  if (!saved.ok) return { ok: false, error: `会议元信息写盘失败：${saved.error}` };
  return { ok: true, conflict, conflicts: meta.conflicts };
}

/**
 * 投票：一人一票。同一个人对同一项议程再投一次，覆盖旧票并标 revoted:true，
 * 让"改票"这件事在纪要里看得见（不是悄悄换个数）。
 */
export function castVote({ root, meetingId, agendaId, agentId, choice, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结会了，票不作数了。' };
  const item = findAgenda(meta, agendaId);
  if (!item) return { ok: false, code: 'no_agenda', error: agendaId ? `议程里没有这一项：${agendaId}` : '投票要指定议程项（agendaId）。' };
  const who = str(agentId);
  if (!who) return { ok: false, code: 'agent_required', error: '投票得说清是谁投的（agentId）。' };
  const picked = str(choice);
  if (!picked) return { ok: false, code: 'choice_required', error: '投票得有选项（choice：赞成/反对/弃权）。' };
  const old = meta.votes.find((v) => v.agendaId === item.id && v.agentId.toLowerCase() === who.toLowerCase());
  const revoted = Boolean(old);
  const previous = revoted ? old.choice : null;
  if (old) {
    old.previous = old.choice;
    old.choice = picked.slice(0, 40);
    old.at = nowIso(now());
    old.revoted = true;
  } else {
    meta.votes.push({
      agendaId: item.id,
      agentId: who,
      choice: picked.slice(0, 40),
      at: nowIso(now()),
      revoted: false,
      previous: null,
    });
  }
  const saved = saveMeta(root, meta);
  if (!saved.ok) return { ok: false, error: `会议元信息写盘失败：${saved.error}` };
  const reply = votesReply(meta, item.id);
  return { ...reply, ok: true, revoted, previous, agentId: who, choice: picked.slice(0, 40) };
}

/** 看票：不投，只统计（按议程项）。 */
export function listVotes({ root, meetingId, agendaId } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  return votesReply(meta, str(agendaId) || null);
}

/** 生成中文纪要（纯函数式拼装，方便测试直接比对内容）。 */
export function renderMinutes(meta, proposals) {
  const lines = [];
  lines.push(`# 会议纪要：${meta.topic}`);
  lines.push('');
  lines.push(`- 会议号：${meta.id}`);
  lines.push(`- 开会时间：${meta.createdAt}`);
  if (meta.goal) lines.push(`- 目标：${meta.goal}`);
  const people = (meta.participants || []).map((p) => `${p.name}${p.vendor ? `（${vendorLabel(p.vendor)}）` : ''}`);
  lines.push(`- 参与：${people.length ? people.join('、') : '（没人登记）'}`);
  lines.push(`- 状态：${meta.status === STATUS_CONCLUDED ? '已结会' : '进行中'}`);
  const agenda = Array.isArray(meta.agenda) ? meta.agenda : [];
  if (agenda.length) {
    const done = agenda.filter((a) => a.status === 'resolved' && a.conclusion).length;
    lines.push(`- 议程：${agenda.length} 项（已结论 ${done} 项）`);
  }
  lines.push('');
  if (agenda.length) {
    lines.push(`## 议程（${agenda.length} 项）`);
    lines.push('');
    for (const a of agenda) {
      const owner = a.owner ? `（${a.owner}${a.capability ? `｜${a.capability}` : ''}）` : '（待认领）';
      const mark = a.status === 'resolved' && a.conclusion ? '✅ 已结论' : '🟡 未结论';
      lines.push(`- [${a.id}] ${a.title} ${owner} — ${mark}`);
      if (a.conclusion) lines.push(`  - 结论：${a.conclusion}`);
    }
    lines.push('');
  }
  lines.push(`## 发言（${proposals.length} 条）`);
  lines.push('');
  if (!proposals.length) lines.push('（还没有人发言）');
  proposals.forEach((p, i) => {
    const who = `${p.from}${p.vendor ? `｜${vendorLabel(p.vendor)}` : ''}`;
    lines.push(`${i + 1}. **${who}**（${p.stance}）：${p.text}`);
  });
  lines.push('');
  const conflicts = Array.isArray(meta.conflicts) ? meta.conflicts : [];
  if (conflicts.length) {
    const open = conflicts.filter((c) => c.status !== 'resolved').length;
    lines.push(`## 冲突（${conflicts.length} 条${open ? `，${open} 条未了结` : ''}）`);
    lines.push('');
    for (const c of conflicts) {
      const who = c.between.length ? c.between.join(' vs ') : '（没说双方）';
      const tail = c.status === 'resolved'
        ? `已了结${c.resolution ? `：${c.resolution}` : ''}`
        : '未了结';
      lines.push(`- [${c.id}] ${c.agendaId ? `[${c.agendaId}] ` : ''}${who}：${c.summary} — ${tail}`);
    }
    lines.push('');
  }
  const votes = Array.isArray(meta.votes) ? meta.votes : [];
  if (votes.length) {
    lines.push('## 投票');
    lines.push('');
    const byAgenda = new Map();
    for (const v of votes) {
      if (!byAgenda.has(v.agendaId)) byAgenda.set(v.agendaId, []);
      byAgenda.get(v.agendaId).push(v);
    }
    for (const [agendaId, list] of byAgenda) {
      const tally = tallyVotes(list, agendaId);
      const dist = Object.entries(tally.byChoice).map(([k, n]) => `${k} ${n}`).join('、');
      lines.push(`- [${agendaId}] 共 ${tally.total} 票：${dist}`);
    }
    lines.push('');
  }
  lines.push('## 决议');
  lines.push('');
  lines.push(decisionText(meta) || '（还没定）');
  const record = decisionRecordOf(meta);
  if (record) {
    if (record.decidedBy) lines.push('', `- 拍板：${record.decidedBy}`);
    if (record.rationale) lines.push(`- 理由：${record.rationale}`);
    if (Array.isArray(record.conflictsResolved) && record.conflictsResolved.length) {
      lines.push(`- 了结的冲突：${record.conflictsResolved.join('、')}`);
    }
  }
  if (Array.isArray(meta.tasks) && meta.tasks.length) {
    lines.push('');
    lines.push(`## 拆出的任务（${meta.tasks.length} 条）`);
    lines.push('');
    for (const t of meta.tasks) {
      lines.push(`- ${t.taskId ? `[${t.taskId}] ` : ''}${t.title}${t.role ? `（${t.role}）` : ''}${t.acceptance ? `｜验收：${t.acceptance}` : ''}${t.fromAgendaId ? `｜来自议程：${t.fromAgendaId}` : ''}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('由 Nexi 灵犀（agentdeck-super）自动记录：每一条意见都来自真实的 Agent 进程，原样保留，不改写。');
  return `${lines.join('\n')}\n`;
}

/**
 * 结会：定下决议 + 拆任务进任务板 + 落 minutes.md。
 * board 可选：没有任务板时纪要照样生成，任务只在纪要里列出来（如实告知，不假装写进板子）。
 *
 * 裁决（1.9）：开会时给了议程的会（"受议程管"），结会必须同时给
 *   decidedBy（谁拍的板，用户/lead）+ rationale（为什么这么定），且每一项议程都得有结论；
 *   缺理由就拒绝 —— 没有理由的裁决不算裁决，不许补默认值糊过去。
 *   没给议程的老会议保持原有行为；但只要显式写了裁决字段，就必须成对补齐。
 */
export async function concludeMeeting({
  root,
  meetingId,
  decision,
  tasks,
  addTask,
  teamId,
  decidedBy,
  rationale,
  conflictsResolved,
  now = () => Date.now(),
} = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结过了（决议不会覆盖，改主意请新开一场）。' };
  const verdict = str(decision);
  if (!verdict) return { ok: false, code: 'decision_required', error: '结会必须给决议（参数 decision）：会开完了总得有个说法。' };
  const by = str(decidedBy);
  const why = str(rationale);
  if (isGoverned(meta)) {
    if (!by) return { ok: false, code: 'decidedby_required', error: '结会必须写清谁拍的板（decidedBy：用户或 lead 的身份）。' };
    if (!why) return { ok: false, code: 'rationale_required', error: '结会必须写清为什么这么定（rationale）：没有理由的裁决不算裁决。' };
    const pending = unresolvedAgenda(meta);
    if (pending.length) {
      return {
        ok: false,
        code: 'agenda_unresolved',
        unresolved: pending,
        error: `还有 ${pending.length} 项议程没结论：${pending.map((p) => `[${p.id}] ${p.title}`).join('、')}（先把每项的结论写出来再结会）。`,
      };
    }
  } else if (by && !why) {
    return { ok: false, code: 'rationale_required', error: '写了拍板人（decidedBy）就得写清为什么（rationale）。' };
  } else if (why && !by) {
    return { ok: false, code: 'decidedby_required', error: '写了理由（rationale）就得写清谁拍的板（decidedBy）。' };
  }

  // 冲突：只承认真的了结过的；把未了结的写进 conflictsResolved 属于谎报，直接拒
  const listed = (Array.isArray(conflictsResolved) ? conflictsResolved : []).map((x) => str(x)).filter(Boolean);
  const unknown = listed.filter((id) => !meta.conflicts.some((c) => c.id === id));
  if (unknown.length) return { ok: false, code: 'no_conflict', error: `冲突号对不上：${unknown.join('、')}` };
  const stillOpen = listed.filter((id) => meta.conflicts.find((c) => c.id === id)?.status !== 'resolved');
  if (stillOpen.length) {
    return {
      ok: false,
      code: 'conflict_open',
      error: `这些冲突还没了结（先用 conflict-resolve 写清怎么解决的，别直接算进了结）：${stillOpen.join('、')}`,
    };
  }
  const resolvedIds = [...new Set([
    ...meta.conflicts.filter((c) => c.status === 'resolved').map((c) => c.id),
    ...listed,
  ])];
  const openConflicts = meta.conflicts
    .filter((c) => c.status !== 'resolved')
    .map((c) => ({ id: c.id, agendaId: c.agendaId, summary: c.summary }));

  const proposals = loadProposals(root, meetingId);
  const wanted = [];
  for (const t of (Array.isArray(tasks) ? tasks : []).slice(0, MAX_TASKS)) {
    const spec = typeof t === 'string' ? { title: t } : t && typeof t === 'object' ? t : null;
    if (!spec) continue;
    const fromAgendaId = str(spec.fromAgendaId);
    if (fromAgendaId && !meta.agenda.some((a) => a.id === fromAgendaId)) {
      return { ok: false, code: 'no_agenda', error: `任务指向的议程项不存在：${fromAgendaId}` };
    }
    wanted.push({
      title: str(spec.title, '未命名任务'),
      role: str(spec.role, 'worker'),
      acceptance: str(spec.acceptance) || null,
      // 只有一项议程时就不用调用方逐条标了，直接挂上去——追溯得到才叫拆任务
      fromAgendaId: fromAgendaId || (meta.agenda.length === 1 ? meta.agenda[0].id : null),
      taskId: null,
      failed: null,
    });
  }

  // 先问任务板能不能收：能收就真写进去，写一条记一条 id
  if (typeof addTask === 'function') {
    for (const t of wanted) {
      try {
        const added = await addTask({
          title: t.title,
          role: t.role,
          acceptance: t.acceptance,
          teamId,
          fromAgendaId: t.fromAgendaId,
          source: 'meeting',
          meetingId,
        });
        if (added) t.taskId = added?.id ?? added?.task?.id ?? null;
        else t.failed = '任务板没接住';
      } catch (err) {
        t.failed = String(err?.message || err);
      }
    }
  }

  const concludedAt = nowIso(now());
  // 两种形态：有拍板人 + 理由 → 裁决对象 decision = { decidedBy, rationale, chosen, conflictsResolved }；
  // 老会议只给了一句决议文本 → 保持纯字符串，跟 1.8 一样。
  const decisionValue = by && why
    ? { decidedBy: by, rationale: why, chosen: verdict, conflictsResolved: resolvedIds }
    : verdict;
  const next = {
    ...meta,
    status: STATUS_CONCLUDED,
    decision: decisionValue,
    decidedBy: by || null,
    rationale: why || null,
    concludedAt,
    tasks: wanted.map((t) => ({
      title: t.title,
      role: t.role,
      acceptance: t.acceptance,
      fromAgendaId: t.fromAgendaId,
      taskId: t.taskId,
    })),
    taskIds: wanted.map((t) => t.taskId).filter(Boolean),
  };
  const savedMeta = saveMeta(root, next);
  if (!savedMeta.ok) return { ok: false, error: `会议元信息写盘失败：${savedMeta.error}` };
  const minutes = renderMinutes(next, proposals);
  const savedMinutes = safeWrite(join(meetingDir(root, meetingId), 'minutes.md'), minutes);
  if (!savedMinutes.ok) return { ok: false, error: `纪要写盘失败：${savedMinutes.error}` };
  return {
    ok: true,
    meeting: next,
    minutes,
    minutesFile: join(meetingDir(root, meetingId), 'minutes.md'),
    proposals: proposals.length,
    tasksCreated: wanted.filter((t) => t.taskId).length,
    tasksFailed: wanted.filter((t) => t.failed).map((t) => ({ title: t.title, why: t.failed })),
    boardUsed: typeof addTask === 'function',
    decisionRecord: decisionRecordOf(next),
    conflictsResolved: resolvedIds,
    openConflicts,
  };
}

/** 读一场会的纪要文本（没有纪要时用当前状态现拼一份）。 */
export function readMinutes({ root, meetingId } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  const file = join(meetingDir(root, meetingId), 'minutes.md');
  try {
    return { ok: true, meta, text: readFileSync(file, 'utf8') };
  } catch {
    return { ok: true, meta, text: renderMinutes(meta, loadProposals(root, meetingId)) };
  }
}

/** 列所有会议（新的在前）。 */
export function listMeetings({ root } = {}) {
  const dir = meetingsRoot(root);
  if (!existsSync(dir)) return { ok: true, meetings: [] };
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { ok: true, meetings: [] };
  }
  const meetings = names
    .map((id) => loadMeta(root, id))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { ok: true, meetings };
}

export default {
  openMeeting,
  submitProposal,
  addAgenda,
  assignAgenda,
  resolveAgendaItem,
  raiseConflict,
  resolveConflict,
  castVote,
  listVotes,
  tallyVotes,
  getMeeting,
  isGoverned,
  unresolvedAgenda,
  decisionRecordOf,
  decisionText,
  concludeMeeting,
  readMinutes,
  listMeetings,
  renderMinutes,
  vendorLabel,
  meetingsRoot,
  meetingDir,
};
