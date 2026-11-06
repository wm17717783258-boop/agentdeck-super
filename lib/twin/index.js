/**
 * Nexi Twin · 工具层（M2）
 *
 * 五个工具，够用且不啰嗦：
 *   twin_remember  记一件事（五类 + 四级可见性）
 *   twin_recall    按关键词/类型/标签召回，带可见性闸门
 *   twin_brief     生成"分身简报"（可只给摘要，也可生成对外版）
 *   twin_forget    删记忆（按 id / 关键词 / 标签 / 全清，清空要 confirm）
 *   twin_habit     习惯提议→确认→拒绝→回滚
 *
 * 设计口径：所有工具都不抛错（走 safeExecute），失败给人话 + 下一步怎么试。
 */

import {
  MEMORY_TYPES,
  TYPE_LABELS,
  VISIBILITIES,
  VISIBILITY_LABELS,
  exportMemory,
  forget,
  readMemory,
  recall,
  remember,
  stats,
} from './memory.js';
import { buildBrief, confirmHabit, proposeHabits, rejectHabit, rollbackHabit } from './context.js';
import { TOOL_OUTPUT, safeExecute } from '../tools/common.js';

const HABIT_ACTIONS = ['propose', 'list', 'confirm', 'reject', 'rollback'];

function typeHint() {
  return MEMORY_TYPES.map((type) => `${type}=${TYPE_LABELS[type]}`).join('、');
}

function visHint() {
  return VISIBILITIES.map((vis) => `${vis}=${VISIBILITY_LABELS[vis]}`).join('、');
}

function fmtItem(item) {
  const tags = item.tags?.length ? ` [${item.tags.join(', ')}]` : '';
  const vis = VISIBILITY_LABELS[item.visibility] || item.visibility;
  return `- ${TYPE_LABELS[item.type] || item.type} · ${vis}${tags}｜${String(item.text).replace(/\n/g, ' ')}`;
}

export function createTwinTools(deps = {}) {
  const root = typeof deps.root === 'function' ? deps.root : () => deps.root || process.cwd();
  const rootOf = () => {
    const value = root();
    return typeof value === 'string' && value.trim() ? value : process.cwd();
  };
  const store = deps.profile || deps.pet || null;
  const board = deps.board || null;

  const tools = [];

  tools.push({
    name: 'twin_remember',
    description: [
      '把一件值得记住的事写进「数字分身」的本地记忆：用户偏好、项目事实、谁是谁、干过什么、聊出来的结论。',
      '什么时候用：用户说"记住…"、你发现一条以后还会用到的约束、或一次任务干完要留结论。',
      `五类：${typeHint()}。`,
      `四级可见性（默认 private，永不出本机）：${visHint()}。`,
      '它只写本机文件，不联网、不上传；重复的同一句会自动合并，不会刷屏。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记的内容，一句话说清（中文原文最好，别改写成书面语）。' },
        type: { type: 'string', enum: MEMORY_TYPES, description: `记忆类型，默认 event。${typeHint()}` },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 6 个，例如 ["报销","财务"]。' },
        visibility: { type: 'string', enum: VISIBILITIES, description: `可见性，默认 private。${visHint()}` },
        source: { type: 'string', description: '谁写的：用户原话写 user，自己推出来的写 agent，工具产出写 tool。' },
        pinned: { type: 'boolean', description: '钉住：清理超量记忆时优先保留它。' },
      },
      required: ['text'],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('twin_remember', async (args, exec) => {
      const written = remember(rootOf(), args, { now: () => Date.now() });
      if (!written.ok) return `【twin_remember】${written.reason}`;
      const item = written.item;
      exec?.logger?.info?.(`记忆已写入 ${item.id}`);
      const lines = [
        `【twin_remember】${written.deduped ? '已合并' : '已记住'}：${item.id}`,
        `类型：${TYPE_LABELS[item.type]}｜可见性：${VISIBILITY_LABELS[item.visibility]}${item.tags.length ? `｜标签：${item.tags.join('、')}` : ''}`,
        `内容：${item.text.replace(/\n/g, ' ')}`,
      ];
      if (written.deduped) lines.push(`说明：${written.reason}`);
      lines.push(`存在：${written.file}`);
      return lines.join('\n');
    }),
  });

  tools.push({
    name: 'twin_recall',
    description: [
      '从数字分身记忆里召回相关的几条：给关键词、给类型、或给标签都行。',
      '可见性闸门：默认 audience=private（本人，全都能看）；要发给别人就先降到 friend / room / public 自己能看的那部分。',
      '什么时候用：动手前先查"用户以前怎么要求的""这个项目有什么约定"，别问第二遍。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，中文原词即可（按字面 + 二元组匹配，不做分词）。' },
        type: { type: 'string', enum: MEMORY_TYPES, description: '只召回某一类。' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤（命中加分，不是硬过滤）。' },
        limit: { type: 'number', description: '最多几条，默认 5，上限 50。' },
        audience: { type: 'string', enum: VISIBILITIES, description: '谁在看：private=本人（默认，全部可见）、friend=好友、room=房间、public=陌生人。' },
        maxVisibility: { type: 'string', enum: VISIBILITIES, description: 'audience 的旧名，等价。' },
        any: { type: 'boolean', description: 'true=不按相关度过滤，直接把可见的几条带出来（"我记了什么"时用）。' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('twin_recall', async (args) => {
      const result = recall(rootOf(), args);
      if (!result.ok) return `【twin_recall】${result.reason}`;
      if (!result.items.length) {
        return [
          '【twin_recall】没找到相关记忆。',
          `现有记忆 ${result.total} 条。可以换更短的关键词，或加 {"any":true} 看最近记了什么。`,
        ].join('\n');
      }
      const lines = [`【twin_recall】命中 ${result.items.length} 条（这个视角能看到 ${result.total} 条）`];
      for (const item of result.items) lines.push(fmtItem(item));
      if (result.hidden) lines.push(`另有 ${result.hidden} 条高于当前视角（${result.audience}），没有带出。`);
      return lines.join('\n');
    }),
  });

  tools.push({
    name: 'twin_brief',
    description: [
      '生成一段「你是我的数字分身」简报：确认过的习惯 + 各类记忆 + 任务板概况，可直接塞进提示词当上下文。',
      '什么时候用：换了个 Agent、换了个宿主、或新开一轮会话，需要快速把这个人的做事方式补齐。',
      'shareable:true 时另给一份可以发给别人的版本（只含非私有记忆）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '每类记忆最多几条，默认 3。' },
        audience: { type: 'string', enum: VISIBILITIES, description: '谁在看：默认 private=本人（全部可见）；对外发就先降到 friend/public。' },
        allowShare: { type: 'boolean', description: '同时生成对外可发摘要。' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('twin_brief', async (args) => {
      const boardSummary = board && typeof board.summary === 'function' ? board.summary() : null;
      const brief = buildBrief({
        root: rootOf(),
        store,
        boardSummary,
        limit: Math.min(10, Math.max(1, Math.floor(Number(args.limit) || 3))),
        maxVisibility: args.audience || args.maxVisibility || 'private',
        allowShare: args.allowShare === true,
      });
      const lines = ['【twin_brief】', brief.text];
      const props = brief.habits?.proposals || [];
      if (props.length) {
        lines.push('', `待确认的习惯候选 ${props.length} 条（用 twin_habit action=confirm 点名）：`);
        props.slice(0, 5).forEach((item, i) => lines.push(`${i + 1}. ${item.label} [${item.key}]`));
      }
      if (brief.shareable) {
        lines.push('', '—— 对外版（只含非私有）——', brief.shareable.note);
        for (const item of brief.shareable.memory) lines.push(`- ${item.text}`);
      }
      return lines.join('\n');
    }),
  });

  tools.push({
    name: 'twin_forget',
    description: [
      '删记忆：按 id 删、按关键词/标签批量删、all:true 清空（必须带 confirm:true）。',
      '什么时候用：用户说"忘了这件事""这些别记""清空记忆"。删之前会先留一份 .bak，防手抖。',
      `导出可以用 action=export（拿到 json 或 md 文本，自己决定发不发）。`,
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['forget', 'export', 'stats'], description: '默认 forget；export=导出；stats=看统计。' },
        id: { type: 'string', description: '按记忆 id 精确删。' },
        query: { type: 'string', description: '按关键词删（召回命中的都删）。' },
        tag: { type: 'string', description: '按标签删。' },
        all: { type: 'boolean', description: 'true=清空全部（必须同时 confirm:true）。' },
        confirm: { type: 'boolean', description: '清空时的二次确认。' },
        format: { type: 'string', enum: ['json', 'md'], description: 'export 的格式，默认 json。' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('twin_forget', async (args) => {
      const base = rootOf();
      const action = String(args.action || 'forget').toLowerCase();
      if (action === 'stats') {
        const info = stats(base);
        const byType = MEMORY_TYPES.map((type) => `${TYPE_LABELS[type]} ${info.byType[type] || 0}`).join('｜');
        const byVis = VISIBILITIES.map((vis) => `${VISIBILITY_LABELS[vis]} ${info.byVisibility[vis] || 0}`).join('｜');
        return [
          `【twin_forget】记忆统计：共 ${info.total} 条`,
          `按类型：${byType}`,
          `按可见性：${byVis}`,
          `文件：${info.file}${info.exists ? '' : '（还没建）'}`,
        ].join('\n');
      }
      if (action === 'export') {
        const exported = exportMemory(base, { format: args.format || 'json' });
        return [`【twin_forget】导出 ${exported.count} 条（${exported.format}）`, '', exported.text].join('\n');
      }
      const removed = forget(base, { ...args, tag: args.tag, tags: args.tag ? [args.tag] : args.tags });
      if (!removed.ok) return `【twin_forget】${removed.reason}`;
      if (!removed.removed) return `【twin_forget】${removed.reason || '没删到东西'}`;
      return `【twin_forget】已删除 ${removed.removed} 条：${(removed.ids || []).join('、')}\n（删前的快照留在同目录 memory.json.bak）`;
    }),
  });

  tools.push({
    name: 'twin_habit',
    description: [
      '桌宠习惯的明面管理：propose=看候选（只读）、confirm=确认（会真正学进画像）、reject=以后别问、rollback=撤回。',
      '自动学习只会"悄悄升级"；这个工具让用户能看见、能点头、能反悔——这是"数字分身进化"必须留的刹车。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: HABIT_ACTIONS, description: 'propose=看候选；confirm=确认；reject=拒绝；rollback=撤回；list=看已确认的。' },
        key: { type: 'string', description: '候选的 key（propose 会给），也可以用候选序号 "1"。' },
        all: { type: 'boolean', description: 'rollback 时 true=撤回全部。' },
        force: { type: 'boolean', description: 'rollback 时 true=连自动学出来的也一起撤。' },
      },
      required: ['action'],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('twin_habit', async (args) => {
      const base = rootOf();
      const action = String(args.action || 'propose').toLowerCase();
      if (!HABIT_ACTIONS.includes(action)) return `【twin_habit】不认识的动作 "${action}"。可用：${HABIT_ACTIONS.join('、')}。`;
      if (action === 'propose' || action === 'list') {
        const result = proposeHabits({ root: base, store });
        if (!result.ok) return `【twin_habit】${result.reason}`;
        const lines = [`【twin_habit】候选 ${result.proposals.length} 条｜已确认 ${result.confirmed.length} 条`];
        result.proposals.slice(0, 10).forEach((item, i) => lines.push(`${i + 1}. ${item.label} [${item.key}]${item.auto ? '（桌宠先记了一笔，等你点头）' : ''}`));
        if (result.confirmed.length) {
          lines.push('', '已确认：');
          for (const item of result.confirmed.slice(0, 10)) lines.push(`- ${item.label} [${item.key}]`);
        }
        lines.push('', result.note);
        return lines.join('\n');
      }
      if (action === 'confirm') {
        const done = confirmHabit({ root: base, store }, args);
        if (!done.ok) return `【twin_habit】${done.reason}`;
        return `【twin_habit】已确认：${done.label}\n置信度 ${done.confidence}｜证据 ${done.evidence} 次\n${done.note}`;
      }
      if (action === 'reject') {
        const done = rejectHabit({ root: base }, args);
        if (!done.ok) return `【twin_habit】${done.reason}`;
        return `【twin_habit】${done.note}`;
      }
      const done = rollbackHabit({ root: base, store }, args);
      if (!done.ok) return `【twin_habit】${done.reason}`;
      return `【twin_habit】${done.note}`;
    }),
  });

  return tools;
}

export const TWIN_TOOL_NAMES = ['twin_remember', 'twin_recall', 'twin_brief', 'twin_forget', 'twin_habit'];

export { MEMORY_TYPES, TYPE_LABELS, VISIBILITIES, VISIBILITY_LABELS, readMemory };
export default { createTwinTools, TWIN_TOOL_NAMES };

