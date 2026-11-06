/**
 * lib/meeting/index.js —— 跨厂商会议：把 Claude / Codex / dsh 各自的意见收进同一份纪要
 *
 * 为什么需要它：
 *   现在每个 Agent 都能连上任务板，但"三个人各说各的"和"开完会有一份能追责的纪要"
 *   是两件事。会议把过程留在盘上：谁提了什么、谁反对、最后怎么定的、拆成了哪几条任务。
 *
 * 目录结构（`<工作区>/.agentdeck/meetings/<会议号>/`）：
 *   meta.json      会议元信息（议题、参与人、状态、决议、任务号）
 *   proposals.jsonl 逐条意见（一行一条，追加写，坏了也只坏一行）
 *   minutes.md     中文会议纪要（人看得懂，也能直接贴给老板）
 *
 * 刻意**不**依赖模型：纪要由真实意见项目符号化汇总而成。
 * 需要模型润色/收敛的地方交给 pet_meeting（它才需要 chat 注入）。
 *
 * 底线：所有函数返回 { ok, ... }；任何 IO 失败都给人话原因，不 throw。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MEETING_DIRNAME = '.agentdeck/meetings';
/** 单条意见上限（防止某个 Agent 贴一整个文件进来）。 */
export const MAX_PROPOSAL_CHARS = 4000;
/** 一次会议最多多少条意见。 */
export const MAX_PROPOSALS = 60;
/** 一次会议最多拆多少条任务。 */
export const MAX_TASKS = 12;
export const STANCES = ['支持', '反对', '补充'];
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

function safeWrite(file, text) {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch { /* mkdir 失败下一步会报出来 */ }
  try {
    writeFileSync(file, text, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function loadMeta(root, id) {
  const file = join(meetingDir(root, id), 'meta.json');
  const meta = readJson(file);
  return meta && meta.id ? meta : null;
}

function saveMeta(root, meta) {
  return safeWrite(join(meetingDir(root, meta.id), 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
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

/** 开一场会。participants 可以是 ['小犀','小鹿'] 或 [{name,vendor,role}]。 */
export function openMeeting({ root, topic, goal, participants, now = () => Date.now() } = {}) {
  const title = str(topic);
  if (!title) return { ok: false, error: '开会得有个议题（参数 topic）。' };
  const id = newMeetingId(Number(now()));
  const list = (Array.isArray(participants) ? participants : [])
    .map((p) => (typeof p === 'string' ? { name: p } : p && typeof p === 'object' ? p : null))
    .filter(Boolean)
    .map((p) => ({
      name: str(p.name, '未署名'),
      vendor: str(p.vendor),
      role: str(p.role, 'participant'),
    }));
  const meta = {
    id,
    topic: title,
    goal: str(goal),
    participants: list,
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
  lines.push('');
  lines.push(`## 发言（${proposals.length} 条）`);
  lines.push('');
  if (!proposals.length) lines.push('（还没有人发言）');
  proposals.forEach((p, i) => {
    const who = `${p.from}${p.vendor ? `｜${vendorLabel(p.vendor)}` : ''}`;
    lines.push(`${i + 1}. **${who}**（${p.stance}）：${p.text}`);
  });
  lines.push('');
  lines.push('## 决议');
  lines.push('');
  lines.push(meta.decision ? meta.decision : '（还没定）');
  if (Array.isArray(meta.tasks) && meta.tasks.length) {
    lines.push('');
    lines.push(`## 拆出的任务（${meta.tasks.length} 条）`);
    lines.push('');
    for (const t of meta.tasks) {
      lines.push(`- ${t.taskId ? `[${t.taskId}] ` : ''}${t.title}${t.role ? `（${t.role}）` : ''}${t.acceptance ? `｜验收：${t.acceptance}` : ''}`);
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
 */
export async function concludeMeeting({ root, meetingId, decision, tasks, addTask, teamId, now = () => Date.now() } = {}) {
  const meta = loadMeta(root, meetingId);
  if (!meta) return { ok: false, error: `没有这场会：${meetingId}` };
  if (meta.status === STATUS_CONCLUDED) return { ok: false, error: '这场会已经结过了（决议不会覆盖，改主意请新开一场）。' };
  const verdict = str(decision);
  if (!verdict) return { ok: false, error: '结会必须给决议（参数 decision）：会开完了总得有个说法。' };

  const proposals = loadProposals(root, meetingId);
  const wanted = (Array.isArray(tasks) ? tasks : []).slice(0, MAX_TASKS)
    .map((t) => (typeof t === 'string' ? { title: t } : t && typeof t === 'object' ? t : null))
    .filter(Boolean)
    .map((t) => ({
      title: str(t.title, '未命名任务'),
      role: str(t.role, 'worker'),
      acceptance: str(t.acceptance) || null,
      taskId: null,
      failed: null,
    }));

  // 先问任务板能不能收：能收就真写进去，写一条记一条 id
  if (typeof addTask === 'function') {
    for (const t of wanted) {
      try {
        const added = await addTask({ title: t.title, role: t.role, acceptance: t.acceptance, teamId, source: 'meeting', meetingId });
        if (added) t.taskId = added?.id ?? added?.task?.id ?? null;
        else t.failed = '任务板没接住';
      } catch (err) {
        t.failed = String(err?.message || err);
      }
    }
  }

  const next = {
    ...meta,
    status: STATUS_CONCLUDED,
    decision: verdict,
    concludedAt: nowIso(now()),
    tasks: wanted.map((t) => ({ title: t.title, role: t.role, acceptance: t.acceptance, taskId: t.taskId })),
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

export default { openMeeting, submitProposal, concludeMeeting, readMinutes, listMeetings, renderMinutes, vendorLabel, meetingsRoot, meetingDir };
