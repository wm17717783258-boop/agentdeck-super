/**
 * lib/pet/index.js —— 桌宠层总装（= 用户的数字分身）
 *
 * 四块拼起来才是一只完整的桌宠：
 *   profile（记住我）→ skins（我长什么样）→ meeting（替我开会）→ visit（替我串门）
 *
 * 本文件只做两件额外的事：
 *   1. createPetLayer({ root, board, chat, log })：把这些模块按同一个 root/时钟拼好；
 *   2. petTools(deps)：交给宿主三个**纯描述符**工具（pet_visit / pet_meeting / pet_skin）。
 *      不 import 任何宿主 API、不自己注册、execute 永不抛错，永远返回 { text }。
 *
 * 依赖只有 node 内置 + lib/pet 自己；授权（lib/license.js）用**动态 import** 取，
 * 拿不到就按免费版处理——桌宠不能因为授权模块缺失就整个装不上。
 */

import { createProfileStore, defaultProfile, normalizeProfile, observe, summarize, profilePath } from './profile.js';
import {
  BUILTIN_SKINS,
  SKIN_STATES,
  STATE_LABELS,
  activateSkin,
  checkSkinLicense,
  listSkins,
  renderSprite,
} from './skins.js';
import { createMeeting } from './meeting.js';
import { createVisitHost, makeInvite, makeNote, profileCard, readVisitLog, receiveNote } from './visit.js';

/** 本层对外提供的工具名（固定，宿主按名字注册） */
export const PET_TOOL_NAMES = ['pet_visit', 'pet_meeting', 'pet_skin'];

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 宿主传进来的 root 可能是字符串、函数或 {root} */
function rootOf(deps = {}) {
  const raw = deps.root ?? deps.workspace ?? deps.workspaceRoot;
  if (typeof raw === 'function') {
    try {
      return str(raw());
    } catch {
      return '';
    }
  }
  if (typeof raw === 'string') return str(raw);
  if (raw && typeof raw === 'object') return str(raw.root ?? raw.path ?? raw.dir);
  return '';
}

function clockOf(deps = {}) {
  return typeof deps.now === 'function' ? deps.now : null;
}

/** chat 可能是函数，也可能是 brain 对象 */
function chatFnOf(deps = {}) {
  if (typeof deps.chat === 'function') return deps.chat;
  if (deps.chat && typeof deps.chat.chat === 'function') return (args) => deps.chat.chat(args);
  if (deps.brain && typeof deps.brain.chat === 'function') return (args) => deps.brain.chat(args);
  return null;
}

/** 拿得到档案仓就用给的；给的是裸档案就落一次盘；都没有就按 root 新建 */
function storeOf(deps = {}, root = '') {
  const given = deps.profile;
  if (given && typeof given.get === 'function' && typeof given.update === 'function') return given;
  if (!root) return null;
  const store = createProfileStore({ root, now: clockOf(deps) || undefined });
  if (isPlainObject(given) && typeof given.name === 'string') {
    const written = store.write(normalizeProfile(given, clockOf(deps) || undefined));
    if (!written || !written.ok) return store; // 写不进去也照样能读默认档案
  }
  return store;
}

/** 授权信息：动态 import，失败一律按免费版 */
async function licenseInfo(root) {
  const free = { license: { ok: false, tier: 'free', claims: null }, tier: 'free', note: '授权模块没加载，按免费版处理' };
  try {
    const mod = await import('../license.js');
    const api = mod && typeof mod.currentLicense === 'function' ? mod : mod && mod.default;
    if (!api || typeof api.currentLicense !== 'function') return free;
    const license = api.currentLicense(root);
    if (!license || typeof license !== 'object') return free;
    return { license, tier: license.ok ? str(license.tier, 'free') : 'free', note: '' };
  } catch (err) {
    return { ...free, note: `授权模块读取失败（${err && err.message ? err.message : err}），按免费版处理` };
  }
}

// ── 文本排版小工具（工具输出全是中文人话）────────────────────────────────

function cardLines(card, title) {
  const habits = Array.isArray(card.habitsTop3) && card.habitsTop3.length
    ? card.habitsTop3.map((habit) => `${habit.label}（${Math.round(num(habit.confidence) * 100)}%）`).join('、')
    : '还没养成习惯';
  const can = Array.isArray(card.capabilities) && card.capabilities.length ? card.capabilities.join('、') : '聊天、记笔记';
  return [
    `【${title}】${card.name}`,
    `皮肤：${card.petSkin}`,
    `拿手习惯：${habits}`,
    `能帮忙：${can}`,
  ];
}

function parseNoteInput(raw) {
  if (isPlainObject(raw)) return { ok: true, note: raw };
  const text = str(raw);
  if (!text) return { ok: false, reason: '得给我一张便签（note 对象或 JSON 字符串）' };
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!isPlainObject(parsed)) return { ok: false, reason: '便签得是一个 JSON 对象' };
    return { ok: true, note: parsed };
  } catch {
    return { ok: false, reason: '便签 JSON 解析不出来' };
  }
}

async function pickTeamId(board, explicit) {
  const wanted = str(explicit);
  if (wanted) return { ok: true, teamId: wanted };
  if (!board || typeof board !== 'object') return { ok: false, reason: '宿主没有任务板，收不了便签' };
  let teams = [];
  try {
    teams = typeof board.listTeams === 'function' ? await board.listTeams() : [];
  } catch {
    teams = [];
  }
  if (Array.isArray(teams) && teams.length === 1) return { ok: true, teamId: String(teams[0].id) };
  if (Array.isArray(teams) && teams.length > 1) return { ok: false, reason: `任务板上有 ${teams.length} 个队，请用 teamId 指定收便签的队` };
  return { ok: false, reason: '任务板上还没有队，先建个队再收便签' };
}

function fmtTime(value) {
  const text = str(value);
  if (!text) return '—';
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return text;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── 总装 ────────────────────────────────────────────────────────────────

/**
 * 把四块拼成一层。
 * @param {{ root?:string, board?:object, chat?:Function|object, log?:Function, http?:object, now?:Function, profile?:object }} deps
 * @returns {object} ok:false 时只带 reason（缺 root 是硬伤，其余都能降级）
 */
export function createPetLayer(deps = {}) {
  const root = rootOf(deps);
  if (!root) return { ok: false, reason: '桌宠层需要工作区路径（root）' };

  const now = clockOf(deps);
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const board = deps.board || null;
  const chat = chatFnOf(deps);
  const store = storeOf(deps, root);
  if (!store) return { ok: false, reason: `桌宠档案仓建不起来：${root}` };

  const meeting = createMeeting({ board, chat, log, now });
  const visit = createVisitHost({ profile: store, board, log, root, http: deps.http || null, now });

  const layer = {
    ok: true,
    root,
    /** 档案仓（get / update / write / read） */
    profile: store,
    /** 开会：{ ok, runMeeting } */
    meeting,
    /** 串门：{ ok, card, makeInvite, acceptInvite, makeNote, receiveNote, readLog } */
    visit,
    /** 五种状态的中文名 */
    states: { ...STATE_LABELS },
    /** 我的名片（只有能见人的字段） */
    card: () => profileCard(store),
    /** 现在的画像摘要（给人看的文本） */
    summarize: () => {
      try {
        return summarize(store);
      } catch (err) {
        return { ok: false, reason: `画像摘要失败：${err && err.message ? err.message : err}` };
      }
    },
    /** 皮肤：列表 / 换装 / 出图 */
    skins: {
      list: (opts = {}) => listSkins({ root, ...opts }),
      check: (skin, license) => checkSkinLicense({ skin, license, root, now }),
      activate: (id, license) => activateSkin(store, id, license),
      render: (opts = {}) => renderSprite({ now, ...opts }),
    },
    /** 记一笔观察（转给 profile.observe） */
    observe: (event) => observe(store, event),
    /** 三个工具描述符（已绑好本层依赖） */
    tools: () => petTools({ root, profile: store, board, chat, log, http: deps.http || null, now }),
  };
  return layer;
}

// ── 工具描述符 ──────────────────────────────────────────────────────────

/** 本地版 safeExecute：execute 永不抛错，永远 { text } */
function toolExecute(name, fn) {
  return async (args, exec) => {
    try {
      return { text: String(await fn(isPlainObject(args) ? args : {}, exec || {})) };
    } catch (err) {
      return { text: `【${name}】运行失败：${err && err.message ? err.message : err}` };
    }
  };
}

function buildVisitTool(deps) {
  const root = rootOf(deps);
  return {
    name: 'pet_visit',
    description: [
      '桌宠串门：生成邀请函、收邀请、互留便签。',
      'action=card 看自己的名片；invite 生成一条 dsh://agentdeck/visit 邀请链接；accept 收下别人的邀请（需要 token）；gift 送礼物便签；ask 留求助便签（会变成一条任务）；receive 把收到的便签落到任务板；log 看最近的串门记录。',
      '跨机器全靠你把返回的链接/便签 JSON 复制给对方，本工具不会自己联网、不会开服务。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['card', 'invite', 'accept', 'gift', 'ask', 'receive', 'log'], description: '要做什么，默认 card。' },
        ttlHours: { type: 'number', description: 'invite：邀请有效期（小时），默认 24，最多 720。' },
        scope: { type: 'string', enum: ['visit', 'work'], description: 'invite：visit=只串门（默认），work=可以给我派活。' },
        reply: { type: 'string', description: 'invite：可选的回执地址（http/https），对方收下时会把名片回给你。' },
        token: { type: 'string', description: 'accept：邀请链接里的凭证（t= 后面那一串）。' },
        expectedScope: { type: 'string', enum: ['visit', 'work'], description: 'accept：只接受这个范围的邀请。' },
        message: { type: 'string', description: 'gift：附言。' },
        skin: { type: 'string', description: 'gift：送哪套皮肤（id）。' },
        title: { type: 'string', description: 'ask：求助标题（会变成任务标题）。' },
        acceptance: { type: 'string', description: 'ask：验收标准。' },
        role: { type: 'string', description: 'ask：希望谁来接（worker / tester / reviewer…）。' },
        note: { type: 'string', description: 'ask / receive：补充说明；receive 时也可以直接给便签对象。' },
        to: { type: 'string', description: 'gift / ask：写给谁。' },
        teamId: { type: 'string', description: 'receive：落到哪个队（只有一个队时可省略）。' },
        limit: { type: 'number', description: 'log：看最近几条，默认 10。' },
      },
      required: [],
    },
    execute: toolExecute('pet_visit', async (args) => {
      const action = str(args.action, 'card').toLowerCase();
      const store = storeOf(deps, root);
      if (!store) return '【pet_visit】没有工作区路径，桌宠档案读不出来。';
      const host = createVisitHost({ profile: store, board: deps.board || null, root, log: () => {}, http: deps.http || null, now: clockOf(deps) });

      if (action === 'card') {
        const card = profileCard(store);
        if (!card.ok) return `【pet_visit】名片造不出来：${card.reason}`;
        return [...cardLines(card.card, 'pet_visit 我的名片'), '', '把这张名片给朋友看就够了——它不含任何原始记录。'].join('\n');
      }

      if (action === 'invite') {
        const hours = Math.min(720, Math.max(1, num(args.ttlHours, 24)));
        const invite = makeInvite({
          profile: store,
          ttlMs: Math.round(hours * 60 * 60 * 1000),
          scope: str(args.scope, 'visit'),
          reply: args.reply,
          root,
          now: clockOf(deps),
        });
        if (!invite.ok) return `【pet_visit】邀请函没造出来：${invite.reason}`;
        return [
          `【pet_visit】邀请函好了（${invite.scope === 'work' ? '可以派活' : '只串门'}，${fmtTime(invite.exp)} 前有效）`,
          invite.url,
          '',
          '把上面这条链接发给朋友，对方在自己的会话里用 pet_visit accept 收下即可。',
          invite.reply ? `对方收下后会把名片回执到：${invite.reply}` : '想自动换名片的话，可以用 reply 参数给一个 http 回执地址。',
        ].join('\n');
      }

      if (action === 'accept') {
        const token = str(args.token) || extractTokenFromUrl(args.url);
        if (!token) return '【pet_visit】accept 需要 token：把邀请链接里 t= 后面那一串贴进来。';
        const accepted = host.acceptInvite({ token, expectedScope: str(args.expectedScope) || undefined });
        if (!accepted.ok) return `【pet_visit】这张邀请收不下：${accepted.reason}`;
        const lines = [
          ...cardLines(accepted.hostCard, 'pet_visit 主人的名片'),
          '',
          accepted.verified ? '签名：本机签发，校验通过' : `签名：${accepted.verifyNote}`,
          accepted.handshake === 'exchange'
            ? '握手：已经把你的名片递回去了'
            : accepted.handshake === 'sent'
              ? '握手：名片递出去了，回执没等到'
              : accepted.handshake === 'failed'
                ? `握手：名片没递出去（${accepted.handshakeError || '对方没应答'}），但不影响这次串门`
                : '握手：这次没联网，名片靠你自己转给对方',
          `有效期到：${fmtTime(accepted.exp)}`,
          accepted.logged ? '已记进串门记录（.agentdeck/pet/visits.log）' : '串门记录没落盘（没有工作区路径）',
        ];
        return lines.join('\n');
      }

      if (action === 'gift') {
        if (!str(args.message) && !str(args.skin)) return '【pet_visit】礼物便签得带点东西：一句话（message）或者一套皮肤（skin）。';
        const made = makeNote({ profile: store, kind: 'gift', payload: { message: str(args.message), skin: str(args.skin) }, to: args.to, root, now: clockOf(deps) });
        if (!made.ok) return `【pet_visit】礼物便签没造出来：${made.reason}`;
        return [
          '【pet_visit】礼物便签好了，把下面这段 JSON 复制给对方，让对方用 pet_visit receive 收下：',
          '```json',
          JSON.stringify(made.note, null, 2),
          '```',
        ].join('\n');
      }

      if (action === 'ask') {
        if (!str(args.title)) return '【pet_visit】求助便签得有个标题。';
        const made = makeNote({
          profile: store,
          kind: 'ask',
          payload: { title: str(args.title), acceptance: str(args.acceptance), role: str(args.role, 'worker'), note: str(args.note) },
          to: args.to,
          root,
          now: clockOf(deps),
        });
        if (!made.ok) return `【pet_visit】求助便签没造出来：${made.reason}`;
        return [
          '【pet_visit】求助便签好了，把下面这段 JSON 复制给对方，让对方用 pet_visit receive 收下（会落成一条任务）：',
          '```json',
          JSON.stringify(made.note, null, 2),
          '```',
        ].join('\n');
      }

      if (action === 'receive') {
        const parsed = parseNoteInput(args.note ?? args.payload);
        if (!parsed.ok) return `【pet_visit】${parsed.reason}`;
        const team = await pickTeamId(deps.board || null, args.teamId);
        if (!team.ok) return `【pet_visit】${team.reason}`;
        const received = host.receiveNote({ note: parsed.note, teamId: team.teamId });
        if (!received.ok) return `【pet_visit】便签没接住：${received.reason}`;
        return received.kind === 'ask'
          ? `【pet_visit】收下了 ${received.guest} 的求助，已落成任务 ${received.taskId}（队：${team.teamId}）。`
          : `【pet_visit】收下了 ${received.guest} 的礼物，已记一条事件。`;
      }

      if (action === 'log') {
        const limit = Math.min(100, Math.max(1, num(args.limit, 10)));
        const log = readVisitLog({ root, limit });
        if (!log.ok) return `【pet_visit】串门记录读不出来：${log.reason}`;
        if (!log.entries.length) return '【pet_visit】还没有串门记录。';
        const lines = log.entries.map((entry) => {
          const who = str(entry.guest) || str(entry.host) || '—';
          const tail = entry.event === 'accept' ? `（${entry.verified ? '本机验签' : '跨机器'}）` : '';
          return `· ${fmtTime(entry.at)} ${entry.event} ${who}${tail}`;
        });
        return ['【pet_visit】最近的串门记录', ...lines].join('\n');
      }

      return `【pet_visit】不认识的动作 "${action}"。可用：card、invite、accept、gift、ask、receive、log。`;
    }),
  };
}

/** 从 dsh:// 链接里抠出 token */
function extractTokenFromUrl(raw) {
  const text = str(raw);
  if (!text) return '';
  const match = text.match(/[?&]t=([^&\s]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function buildMeetingTool(deps) {
  return {
    name: 'pet_meeting',
    description: [
      '让桌宠替你开一场团队会议：主持人开场 → 每个成员带着自己的画像轮流发言 → 收敛成严格 JSON 的结论 → 决议写成中文纪要、任务直接进任务板。',
      '什么时候用：用户说"开个会/讨论一下/帮我把这件事拆成任务"，或者一个目标需要多个角色一起拆解时。',
      '依赖宿主的 chat 能力；没有模型时如实失败，不会往任务板里塞半成品。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '在哪个队开会（只有一个队时可省略）。' },
        topic: { type: 'string', description: '会议议题（必填）。' },
        rounds: { type: 'number', description: '发言轮次，1~5，默认 2。' },
        maxTasks: { type: 'number', description: '最多拆出几个任务，1~20，默认 5。' },
        participants: {
          type: 'array',
          description: '参与人（可选）。不给就用队伍成员。每人 { memberId, name, role, personaHint }。',
          items: {
            type: 'object',
            properties: {
              memberId: { type: 'string' },
              name: { type: 'string' },
              role: { type: 'string' },
              personaHint: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
      required: ['topic'],
    },
    execute: toolExecute('pet_meeting', async (args) => {
      const topic = str(args.topic);
      if (!topic) return '【pet_meeting】得先给个议题（topic）。';
      const board = deps.board || null;
      const chat = chatFnOf(deps);
      if (!chat) return '【pet_meeting】宿主没有提供模型（chat），开不了会。桌宠可以继续记住你的习惯，但替不了你发言。';
      if (!board) return '【pet_meeting】宿主没有任务板，会议结论没地方落。';
      const team = await pickTeamId(board, args.teamId);
      if (!team.ok) return `【pet_meeting】${team.reason}`;

      const meeting = createMeeting({ board, chat, log: typeof deps.log === 'function' ? deps.log : () => {}, now: clockOf(deps) });
      const result = await meeting.runMeeting({
        teamId: team.teamId,
        topic,
        participants: Array.isArray(args.participants) ? args.participants : undefined,
        rounds: num(args.rounds, 2),
        maxTasks: num(args.maxTasks, 5),
      });
      if (!result.ok) return `【pet_meeting】会没开成：${result.reason}`;

      const taskLines = result.tasks.map((task, i) => {
        const deps = Array.isArray(task.dependsOn) && task.dependsOn.length ? `（依赖 ${task.dependsOn.join('、')}）` : '';
        return `${i + 1}. ${task.id} ${task.title} [${task.role || 'worker'}]${deps}`;
      });
      return [
        `【pet_meeting】会议结束：${result.meetingId}`,
        `议题：${topic}`,
        `落了 ${result.tasks.length} 个任务到队 ${team.teamId}：`,
        taskLines.length ? taskLines.join('\n') : '（这次没有拆出任务）',
        '',
        '—— 会议纪要 ——',
        result.minutes,
      ].join('\n');
    }),
  };
}

function buildSkinTool(deps) {
  const root = rootOf(deps);
  return {
    name: 'pet_skin',
    description: [
      '桌宠外观：列皮肤、查授权、换皮肤、看五种状态。',
      'action=list 列出可用皮肤（默认）；activate 换装（id=皮肤 id 或中文名）；states 看 idle/working/meeting/visiting/sleeping 五种状态；render 出一张 SVG 字符串（给宿主/界面用）。',
      '免费皮肤永远可用；付费皮肤没有授权会明确拒绝并报价，绝不偷偷换成别的皮肤。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'activate', 'states', 'render'], description: '要做什么，默认 list。' },
        id: { type: 'string', description: 'activate / render：皮肤 id 或名字（如 basic / 霓虹）。' },
        state: { type: 'string', enum: ['idle', 'working', 'meeting', 'visiting', 'sleeping'], description: 'render：状态，默认 idle。' },
        size: { type: 'number', description: 'render：边长像素，24~512，默认 96。' },
      },
      required: [],
    },
    execute: toolExecute('pet_skin', async (args) => {
      const action = str(args.action, 'list').toLowerCase();
      const store = storeOf(deps, root);
      const info = await licenseInfo(root);
      const lic = info.license;

      if (action === 'states') {
        const lines = SKIN_STATES.map((state) => `· ${state}：${STATE_LABELS[state] || state}`);
        return ['【pet_skin】桌宠的五种状态', ...lines].join('\n');
      }

      if (action === 'list') {
        const listed = listSkins({ root, license: lic });
        if (!listed.ok) return '【pet_skin】皮肤列不出来。';
        const active = store ? str((store.get() || {}).skins && (store.get() || {}).skins.active, 'basic') : 'basic';
        const lines = listed.skins.map((skin, i) => {
          const tags = [skin.premium ? `¥${skin.price || 0}` : '免费', skin.id === active ? '已启用' : '', skin.locked ? '未解锁' : ''].filter(Boolean);
          return `${i + 1}. ${skin.name}（${skin.id}）${tags.join(' · ')}${skin.source === 'local' ? ' · 第三方' : ''}`;
        });
        const out = [`【pet_skin】共 ${listed.skins.length} 套皮肤（当前：${active}）`, ...lines];
        if (info.note) out.push(`授权：${info.note}`);
        out.push('用法：pet_skin activate id=霓虹 换皮肤；pet_skin states 看五种状态。');
        if (listed.warnings.length) out.push(`注意：${listed.warnings.slice(0, 3).join('；')}`);
        return out.join('\n');
      }

      if (action === 'activate') {
        if (!store) return '【pet_skin】没有工作区路径，换不了皮肤（档案存不下来）。';
        const wanted = str(args.id);
        if (!wanted) return '【pet_skin】activate 需要 id：给个皮肤 id 或名字（pet_skin list 能看到）。';
        const listed = listSkins({ root, license: lic });
        const found = listed.skins.find((skin) => skin.id === wanted || skin.name === wanted);
        if (!found) return `【pet_skin】没有这套皮肤：${wanted}。可用：${listed.skins.map((skin) => skin.id).join('、')}`;
        const verdict = checkSkinLicense({ skin: found, license: lic, root, now: clockOf(deps) });
        const result = activateSkin(store, found.id, lic);
        if (!result.ok) return `【pet_skin】没换成：${result.reason || verdict.reason || '未知原因'}${found.premium ? `（这套是付费皮肤，需要 studio 档或单独购买）` : ''}`;
        return `【pet_skin】已经换上「${found.name}」。`;
      }

      if (action === 'render') {
        const listed = listSkins({ root, license: lic });
        const wanted = str(args.id) || 'basic';
        const found = listed.skins.find((skin) => skin.id === wanted || skin.name === wanted);
        if (!found) return `【pet_skin】没有这套皮肤：${wanted}`;
        const state = str(args.state, 'idle');
        const svg = renderSprite({ skin: found, state, size: num(args.size, 96), license: lic, now: clockOf(deps) });
        return `【pet_skin】「${found.name}」在 ${state}（${STATE_LABELS[state] || state}）状态下的 SVG（${svg.length} 字节）：\n${svg}`;
      }

      return `【pet_skin】不认识的动作 "${action}"。可用：list、activate、states、render。`;
    }),
  };
}

/**
 * 三个工具描述符（纯描述符：宿主自己注册，本层不 import 任何宿主 API）。
 * @param {{ root?:string|Function, profile?:object, board?:object, chat?:Function|object, log?:Function, http?:object, now?:Function }} deps
 * @returns {object[]} 固定三个：pet_visit / pet_meeting / pet_skin
 */
export function petTools(deps = {}) {
  try {
    return [buildVisitTool(deps || {}), buildMeetingTool(deps || {}), buildSkinTool(deps || {})];
  } catch (err) {
    // 描述符要么三个一起给，要么一个都别给（宿主注册一半反而更乱）
    const reason = `桌宠工具没造出来：${err && err.message ? err.message : err}`;
    return ['pet_visit', 'pet_meeting', 'pet_skin'].map((name) => ({
      name,
      description: reason,
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ text: `【${name}】${reason}` }),
    }));
  }
}

export { BUILTIN_SKINS, SKIN_STATES, STATE_LABELS };
export { defaultProfile, observe, summarize, profilePath };

export default {
  createPetLayer,
  petTools,
  PET_TOOL_NAMES,
  BUILTIN_SKINS,
  SKIN_STATES,
  STATE_LABELS,
};
