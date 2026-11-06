/**
 * lib/pet/activity.js —— 宿主活动 → 桌宠行为事件
 *
 * 桌宠是用户的数字分身，「学习习惯」这件事不能靠用户手动喂数据，得挂在他真实干活的地方：
 * 加任务、领任务、标完成、开会、开工——这些动作一发生，就把事件转成 profile.observe 认的形状。
 *
 * 两条硬规矩：
 *   1. 只转发语义对得上的事件（对不上的返回 skipped，不硬塞，免得习惯全学歪）；
 *   2. 一律不抛错：桌宠学不到习惯是可惜，但绝不能把宿主的主流程带崩。
 *
 * 事件形状见 lib/pet/profile.js 的 normalizeEvent()：
 *   { type, at?, role?, tags?, text?, ms?, id? }
 * 带了 id 的事件天然幂等（同一个 taskId 重复触发只算一次），所以这里尽量给 id。
 */

import { EVENT_TYPES } from './profile.js';

/** 宿主事件名 → 桌宠事件类型（只收语义一致的，其余一律不认） */
export const HOST_MAP = Object.freeze({
  task_add: 'task_added',
  task_added: 'task_added',
  task_done: 'task_done',
  task_completed: 'task_done',
  task_assign: 'task_claimed',
  task_claim: 'task_claimed',
  task_claimed: 'task_claimed',
  chat: 'chat',
  pet_chat: 'chat',
  meeting: 'chat',
  pet_meeting: 'chat',
  team_create: 'session_start',
  team_start: 'session_start',
  super_start: 'session_start',
  session_start: 'session_start',
});

/** 标签里不值得记的词（出现频率高、但说明不了用户擅长什么） */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', '一个', '这个', '那个', '我们', '你们',
  '任务', '工作', '事情', '问题', '一下', '需要', '可以', '然后', '以及', '还有', '完成', '处理',
]);

const MAX_TAGS = 4;
const MAX_TAG_LEN = 16;

/** 从标题/目标里抽几个能代表「在干什么」的标签：sql、test、登录页… */
export function tagsOf(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return [];
  const tokens = raw.toLowerCase().split(/[^\p{L}\p{N}+#._-]+/u);
  const out = [];
  for (const token of tokens) {
    const tag = token.replace(/^[._-]+|[._-]+$/g, '');
    if (!tag || tag.length < 2 || tag.length > MAX_TAG_LEN) continue;
    if (STOP_WORDS.has(tag)) continue;
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 任务板上补一份任务详情（done 事件只有 taskId，标题/角色得自己捞） */
function findTask(board, teamId, taskId) {
  if (!board || !teamId || !taskId) return null;
  try {
    const tasks = board.listTasks(teamId);
    if (!Array.isArray(tasks)) return null;
    return tasks.find((task) => (task?.id ?? task?.taskId) === taskId) || null;
  } catch {
    return null;
  }
}

/**
 * 把一条宿主事件翻成桌宠事件。
 * @param {string} type 宿主 emit 的类型名（task_add / task_done / team_create …）
 * @param {object} [data] 宿主事件体
 * @param {object} [board] 任务板（可选，用来补任务标题）
 * @returns {{ type:string, at:string, role?:string, tags:string[], text?:string, id?:string } | null}
 */
export function petEventOf(type, data = {}, board = null) {
  const mapped = HOST_MAP[String(type || '').toLowerCase()];
  if (!mapped || !EVENT_TYPES.includes(mapped)) return null;
  const body = data && typeof data === 'object' ? data : {};
  const teamId = typeof body.teamId === 'string' ? body.teamId : '';
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  const task = taskId ? findTask(board, teamId, taskId) : null;

  const role = String(body.role || task?.role || '').toLowerCase();
  const title = String(body.title || body.topic || body.goal || task?.title || '');
  const tags = tagsOf(title);
  const at = new Date().toISOString();

  const event = { type: mapped, at, tags };
  if (role) event.role = role;
  if (title) event.text = title.slice(0, 200);
  // 有 taskId 就给 id：同一件事重复触发只算一次（profile.observe 幂等）
  if (taskId) event.id = `${mapped}:${teamId || '-'}:${taskId}`;
  else if (teamId) event.id = `${mapped}:${teamId}:${title.slice(0, 40)}:${at.slice(0, 10)}`;
  return event;
}

/**
 * 记一条宿主活动（宿主事件出口直接调它）。
 *
 * @param {{ store?:object, observe?:Function, board?:object }} target
 * @param {string} type 宿主事件名
 * @param {object} [data] 宿主事件体
 * @returns {{ ok:boolean, skipped?:boolean, reason?:string, event?:object, habit?:object|null }}
 */
export function observeActivity(target, type, data = {}) {
  const sink = target && typeof target === 'object' ? target : {};
  const event = petEventOf(type, data, sink.board);
  if (!event) return { ok: true, skipped: true, reason: '这个事件跟习惯无关，没记' };
  if (!sink.store || typeof sink.observe !== 'function') {
    return { ok: false, reason: '桌宠档案没就绪（store / observe 缺失）', event };
  }
  try {
    const out = sink.observe(sink.store, event);
    return {
      ok: Boolean(out && out.ok),
      skipped: Boolean(out && out.skipped),
      reason: out && out.reason,
      event,
      habit: (out && out.habit) || null,
    };
  } catch (err) {
    return { ok: false, reason: `记活动失败：${err && err.message ? err.message : err}`, event };
  }
}

export default { tagsOf, petEventOf, observeActivity, HOST_MAP };
