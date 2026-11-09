/**
 * lib/pet/meeting.js —— 桌宠主持的站会
 *
 * 一次会议的流程（全部走注入的 chat，测试里可以换成假的模型）：
 *   1. 主持人开场（把议题和参与人摊开）；
 *   2. 逐轮请每位参与者发言（给每个数字分身注入 personaHint + 议题 + 当前纪要摘要）；
 *   3. 主持人收敛：要求模型**只输出一个 JSON 对象**，包含摘要、决议、任务；
 *   4. 把任务逐条写进任务板（依赖只允许指向更早的任务，天然无环）；
 *   5. 生成中文 Markdown 会议纪要。
 *
 * 底线：
 *   - 模型没给出可用结论时，**绝不往任务板上写半成品**，如实返回失败原因；
 *   - 任何一步失败都不 throw，统一返回 { ok, ... }；
 *   - 时间只从注入的 now() 取，测试可复现。
 */

import { randomBytes } from 'node:crypto';

/** 轮次 / 任务数兜底（防止模型或调用方给出离谱数字） */
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 5;
const MIN_TASKS = 1;
const MAX_TASKS = 20;
/** 单条发言保存上限，避免纪要爆炸 */
const MAX_SPEECH_CHARS = 2000;
/** 喂给下一位发言者的纪要摘要上限 */
const MAX_DIGEST_CHARS = 2000;

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function truncate(text, limit) {
  const s = String(text == null ? '' : text);
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** 取一段发言文本：chat 可能返回字符串、{content} 或 {text} */
function textOf(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    if (typeof result.content === 'string') return result.content;
    if (typeof result.text === 'string') return result.text;
  }
  return '';
}

/** 挑一个干净的 JSON 起点：直接解析 / ```json 围栏 / 括号配平扫描 */
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从左到右扫描，摘出所有括号配平的 {...} 片段（跳过字符串里的括号） */
function balancedObjects(text) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length && out.length < 20; i += 1) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < s.length; j += 1) {
      const ch = s[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/** 把各种半成品 JSON 揉成会议结论；形状不对返回 null */
function normalizeConclusion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const summary = str(raw.summary ?? raw.摘要 ?? raw.summaryText);
  let decisions = [];
  if (Array.isArray(raw.decisions)) decisions = raw.decisions.map((item) => str(item)).filter(Boolean);
  else if (typeof raw.decisions === 'string') decisions = [str(raw.decisions)].filter(Boolean);
  else if (Array.isArray(raw.决议)) decisions = raw.决议.map((item) => str(item)).filter(Boolean);

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw.任务) ? raw.任务 : [];
  const tasks = [];
  for (const item of rawTasks) {
    if (!item || typeof item !== 'object') continue;
    const title = str(item.title ?? item.标题);
    if (!title) continue;
    const rawDeps = Array.isArray(item.dependsOn) ? item.dependsOn : Array.isArray(item.依赖) ? item.依赖 : [];
    tasks.push({
      title: truncate(title, 200),
      role: str(item.role ?? item.角色, 'worker'),
      acceptance: str(item.acceptance ?? item.验收),
      dependsOn: rawDeps.map((dep) => (typeof dep === 'number' ? dep : str(dep))).filter((dep) => dep !== '' && dep !== null),
    });
  }

  if (!summary && decisions.length === 0 && tasks.length === 0) return null;
  return { summary, decisions, tasks };
}

/**
 * 从模型回复里抽出会议结论（导出是为了能单独测这段“抽 JSON”的逻辑）。
 * 顺序：严格 JSON → ```json 围栏 → 括号配平扫描。
 *
 * @param {string} text
 * @returns {{ summary:string, decisions:string[], tasks:object[] }|null}
 */
export function extractConclusion(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const direct = tryParseJson(text.trim());
  if (direct) {
    const normalized = normalizeConclusion(direct);
    if (normalized) return normalized;
  }
  const fences = String(text).matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g);
  for (const fence of fences) {
    const parsed = tryParseJson(String(fence[1] || '').trim());
    if (!parsed) continue;
    const normalized = normalizeConclusion(parsed);
    if (normalized) return normalized;
  }
  for (const candidate of balancedObjects(text)) {
    const parsed = tryParseJson(candidate);
    if (!parsed) continue;
    const normalized = normalizeConclusion(parsed);
    if (normalized) return normalized;
  }
  return null;
}

/** 纪要用的发言摘要：谁、第几轮、说了什么（截断） */
function digestOf(transcript, limit = MAX_DIGEST_CHARS) {
  const lines = transcript
    .filter((entry) => entry.phase === 'speech' && entry.ok)
    .map((entry) => `- 第${entry.round}轮 ${entry.speaker.name}：${truncate(entry.text, 220)}`);
  let out = lines.join('\n');
  if (out.length > limit) out = `${out.slice(0, limit - 1)}…`;
  return out || '（还没有人发言）';
}

function escapeMd(text) {
  return String(text == null ? '' : text).replace(/\r?\n/g, ' ').trim();
}

/**
 * @param {{ board:object, chat:Function, log?:Function, now?:Function }} deps
 * @returns {{ ok:boolean, runMeeting?:Function, reason?:string }}
 */
export function createMeeting({ board, chat, log, now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const chatFn = typeof chat === 'function' ? chat : chat && typeof chat.chat === 'function' ? (req) => chat.chat(req) : null;

  const say = (level, message, extra) => {
    if (typeof log !== 'function') return;
    try {
      log(`[meeting/${level}] ${message}${extra ? ` ${extra}` : ''}`);
    } catch {
      // 日志坏了不能把会议带崩
    }
  };

  function usableBoard() {
    if (!board || typeof board !== 'object') return '需要任务板（createBoard 的返回值）';
    if (typeof board.addTask !== 'function') return '任务板缺少 addTask';
    if (typeof board.getTeam !== 'function') return '任务板缺少 getTeam';
    return '';
  }

  /** 统一问模型：返回 { ok, text }，失败只记录不抛 */
  async function ask(purpose, { system, user, signal }) {
    if (!chatFn) return { ok: false, text: '', reason: '没有可用的模型通道' };
    try {
      const result = await chatFn({ messages: [{ role: 'user', content: user }], system, signal });
      const text = textOf(result);
      if (!text.trim()) {
        say('warn', `${purpose} 拿到空回复`);
        return { ok: false, text: '', reason: '模型回复为空' };
      }
      return { ok: true, text: text.trim() };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      say('warn', `${purpose} 失败`, reason);
      return { ok: false, text: '', reason };
    }
  }

  /**
   * 开一次会。
   * @param {{ teamId:string, topic:string, participants?:object[], rounds?:number, maxTasks?:number, signal?:object, host?:object }} opts
   */
  async function runMeeting({ teamId, topic, participants, rounds = 2, maxTasks = 5, signal, host } = {}) {
    const boardProblem = usableBoard();
    if (boardProblem) return { ok: false, reason: boardProblem };
    if (!chatFn) return { ok: false, reason: '开会需要模型通道（chat），当前没有' };

    const subject = str(topic);
    if (!subject) return { ok: false, reason: '会议缺一个议题（topic）' };
    const id = str(teamId);
    if (!id) return { ok: false, reason: '会议缺一个队（teamId）' };

    let team = null;
    try {
      team = board.getTeam(id);
    } catch (err) {
      return { ok: false, reason: `任务板取不到队伍：${err && err.message ? err.message : err}` };
    }
    if (!team) return { ok: false, reason: `任务板上没有这个队：${id}` };

    const roundCount = clampInt(rounds, MIN_ROUNDS, MAX_ROUNDS, 2);
    const taskCap = clampInt(maxTasks, MIN_TASKS, MAX_TASKS, 5);

    // 参与人：调用方给就用，没给就从队伍成员里凑
    let people = [];
    if (Array.isArray(participants)) {
      people = participants
        .filter((p) => p && typeof p === 'object')
        .map((p, index) => ({
          memberId: str(p.memberId ?? p.id, `mem_${index + 1}`),
          name: str(p.name, `成员${index + 1}`),
          role: str(p.role, 'worker'),
          personaHint: str(p.personaHint),
        }));
    }
    if (people.length === 0 && Array.isArray(team.members)) {
      people = team.members.map((m, index) => ({
        memberId: str(m.id, `mem_${index + 1}`),
        name: str(m.name, `成员${index + 1}`),
        role: str(m.kind, 'worker'),
        personaHint: '',
      }));
    }
    if (people.length === 0) return { ok: false, reason: '会议至少要有一个参与人' };

    const hostName = str(host && host.name, '桌宠主持');
    const nowIso = () => {
      try {
        const value = clock();
        const ms = value instanceof Date ? value.getTime() : Number(value);
        return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
      } catch {
        return new Date().toISOString();
      }
    };

    const startedAt = nowIso();
    const meetingId = `meet_${randomBytes(4).toString('hex')}`;
    const transcript = [];

    // ── 1. 主持人开场 ────────────────────────────────────────────────────────
    const opening = await ask('开场', {
      signal,
      system: [
        `你是团队会议的主持人「${hostName}」，代表用户的数字分身。`,
        `本次议题：${subject}`,
        `参与人：${people.map((p) => `${p.name}（${p.role}）`).join('、')}`,
        '请用两三句话开场：点明议题、说明今天要产出什么。不要列清单，不要输出 JSON。',
      ].join('\n'),
      user: '请开场。',
    });
    transcript.push({
      phase: 'opening',
      round: 0,
      speaker: { memberId: 'host', name: hostName, role: 'host' },
      text: truncate(opening.text || `本次会议议题：${subject}。参与人：${people.map((p) => p.name).join('、')}。我们争取产出一份可执行的结论。`, MAX_SPEECH_CHARS),
      ok: opening.ok,
      at: nowIso(),
    });
    if (!opening.ok) say('info', '开场改用本地兜底文案', opening.reason);

    // ── 2. 逐轮发言 ──────────────────────────────────────────────────────────
    for (let round = 1; round <= roundCount; round += 1) {
      for (const person of people) {
        if (signal && signal.aborted) {
          say('info', '会议被取消');
          return { ok: false, reason: '会议已取消', meetingId, transcript };
        }
        const digest = digestOf(transcript);
        const reply = await ask(`${round} 轮 ${person.name} 发言`, {
          signal,
          system: [
            `你是「${person.name}」，在这次团队会议里的角色是「${person.role}」。`,
            person.personaHint ? `你的数字分身画像：${person.personaHint}` : '',
            `本次议题：${subject}`,
            `当前纪要：\n${digest}`,
            '要求：只说这一轮你自己的想法，口语化、2-4 句，别复述别人的话，不要输出代码块，不要编造任务板上没有的事实。',
          ]
            .filter(Boolean)
            .join('\n'),
          user: `第 ${round}/${roundCount} 轮，请发言。`,
        });
        transcript.push({
          phase: 'speech',
          round,
          speaker: { memberId: person.memberId, name: person.name, role: person.role },
          text: reply.ok ? truncate(reply.text, MAX_SPEECH_CHARS) : `（这轮没说话：${reply.reason}）`,
          ok: reply.ok,
          at: nowIso(),
        });
      }
    }

    // ── 3. 主持人收敛（只收严格 JSON） ───────────────────────────────────────
    const roles = [...new Set(people.map((p) => p.role).filter(Boolean))];
    const converge = await ask('收敛结论', {
      signal,
      system: [
        `你是会议主持人「${hostName}」。议题：${subject}`,
        `参与人：${people.map((p) => `${p.name}（${p.role}）`).join('、')}`,
        `会议记录：\n${digestOf(transcript)}`,
        '请给出最终结论。**只输出一个 JSON 对象**，不要任何解释文字、不要代码块围栏。格式：',
        '{"summary":"一句话总结","decisions":["决定1","决定2"],"tasks":[{"title":"任务标题","role":"worker","acceptance":"验收标准","dependsOn":[]}]}',
        `约束：decisions 1-6 条；tasks 最多 ${taskCap} 条，没有任务就给空数组；role 从 ${roles.length ? roles.join('/') : 'worker'} 里选；`,
        'dependsOn 只能写 tasks 数组里排在它前面的任务序号（从 1 开始），没有依赖就写 []。',
      ].join('\n'),
      user: '请输出 JSON。',
    });

    const conclusion = converge.ok ? extractConclusion(converge.text) : null;
    if (!conclusion) {
      say('warn', '模型没有给出可用的会议结论', converge.reason || truncate(converge.text, 120));
      return { ok: false, reason: '模型没有给出可用的会议结论', meetingId, transcript };
    }

    // ── 4. 任务写进任务板（依赖只指向更早的任务） ─────────────────────────────
    let existingIds = [];
    try {
      const existing = typeof board.listTasks === 'function' ? board.listTasks(id) : [];
      existingIds = (Array.isArray(existing) ? existing : []).map((task) => task.id);
    } catch {
      existingIds = [];
    }

    const created = [];
    const byIndex = new Map();
    const byTitle = new Map();
    const knownIds = new Set(existingIds);

    for (const spec of conclusion.tasks.slice(0, taskCap)) {
      const dependsOn = [];
      for (const dep of spec.dependsOn) {
        let resolved = null;
        if (typeof dep === 'number') resolved = byIndex.get(Math.round(dep)) || null;
        else {
          const text = String(dep).trim();
          if (/^\d+$/.test(text)) resolved = byIndex.get(Number(text)) || null;
          else if (knownIds.has(text)) resolved = text;
          else resolved = byTitle.get(text.toLowerCase()) || null;
        }
        if (resolved && !dependsOn.includes(resolved)) dependsOn.push(resolved);
      }

      let task = null;
      try {
        task = board.addTask(id, {
          title: spec.title,
          role: spec.role,
          acceptance: spec.acceptance || null,
          dependsOn,
          context: {
            meetingId,
            topic: subject,
            summary: conclusion.summary,
            from: 'pet_meeting',
          },
        });
      } catch (err) {
        say('warn', '任务没写进任务板', `${spec.title}：${err && err.message ? err.message : err}`);
        continue;
      }
      if (!task || !task.id) continue;
      created.push(task);
      byIndex.set(created.length, task.id);
      byTitle.set(String(task.title || spec.title).toLowerCase(), task.id);
      knownIds.add(task.id);
    }

    if (created.length === 0 && conclusion.tasks.length > 0) {
      return { ok: false, reason: '任务没能写进任务板', meetingId, transcript };
    }

    // ── 5. 纪要 + 事件 ───────────────────────────────────────────────────────
    const minutes = buildMinutes({
      meetingId,
      topic: subject,
      startedAt,
      hostName,
      people,
      rounds: roundCount,
      transcript,
      conclusion,
      created,
    });

    if (typeof board.appendEvent === 'function') {
      try {
        board.appendEvent(id, {
          kind: 'pet/meeting',
          text: `会议「${subject}」结束：${conclusion.decisions.length} 条决议、${created.length} 个任务`,
          meetingId,
          topic: subject,
          tasks: created.map((task) => task.id),
        });
      } catch (err) {
        say('warn', '会议事件没记上', err && err.message ? err.message : err);
      }
    }

    say('info', `会议结束 ${meetingId}`, `决议 ${conclusion.decisions.length} 条 / 任务 ${created.length} 个`);
    return { ok: true, meetingId, minutes, tasks: created, transcript };
  }

  return { ok: true, runMeeting };
}

/** 中文 Markdown 纪要：摘要 → 逐轮亮点 → 最终决议 → 产出任务 */
export function buildMinutes({ meetingId, topic, startedAt, hostName, people, rounds, transcript, conclusion, created }) {
  const lines = [];
  lines.push(`# ${escapeMd(topic)}`);
  lines.push('');
  lines.push(`- 会议号：\`${meetingId}\``);
  if (startedAt) lines.push(`- 时间：${startedAt}`);
  lines.push(`- 主持：${hostName}`);
  lines.push(`- 参与人：${(Array.isArray(people) ? people : []).map((p) => `${escapeMd(p.name)}（${escapeMd(p.role)}）`).join('、')}`);
  lines.push(`- 轮次：${rounds} 轮`);
  lines.push('');
  if (conclusion.summary) {
    lines.push('## 一句话总结');
    lines.push('');
    lines.push(escapeMd(conclusion.summary));
    lines.push('');
  }

  const opening = transcript.find((entry) => entry.phase === 'opening');
  lines.push('## 开场');
  lines.push('');
  lines.push(opening ? escapeMd(opening.text) : '（没有开场）');
  lines.push('');

  for (let round = 1; round <= rounds; round += 1) {
    const speeches = transcript.filter((entry) => entry.phase === 'speech' && entry.round === round);
    if (speeches.length === 0) continue;
    lines.push(`## 第 ${round} 轮`);
    lines.push('');
    for (const entry of speeches) {
      const tag = entry.ok ? '' : '（发言失败）';
      lines.push(`- **${escapeMd(entry.speaker.name)}（${escapeMd(entry.speaker.role)}）**${tag}：${escapeMd(entry.text)}`);
    }
    lines.push('');
  }

  lines.push('## 最终决议');
  lines.push('');
  if (conclusion.decisions.length === 0) lines.push('（这次没有形成明确决议）');
  else for (const [index, decision] of conclusion.decisions.entries()) lines.push(`${index + 1}. ${escapeMd(decision)}`);
  lines.push('');

  lines.push('## 产出任务');
  lines.push('');
  if (!created || created.length === 0) lines.push('（这次没有拆出任务）');
  else {
    for (const task of created) {
      const deps = Array.isArray(task.dependsOn) && task.dependsOn.length ? `，依赖 ${task.dependsOn.map((d) => `\`${d}\``).join('、')}` : '';
      const acceptance = task.acceptance ? `，验收：${escapeMd(task.acceptance)}` : '';
      lines.push(`- \`${task.id}\` ${escapeMd(task.title)}（角色：${escapeMd(task.role)}${acceptance}${deps}）`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export default { createMeeting, extractConclusion, buildMinutes };
