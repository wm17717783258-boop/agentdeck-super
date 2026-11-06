// SPDX-License-Identifier: Apache-2.0
// 这个目录是 MCP 适配层，按 LICENSING.md 用 Apache-2.0：任何宿主都能零成本接入，不必开源自己的代码。
/**
 * lib/mcp/readonly.js —— MCP 只读模式（readOnly）
 *
 * 为什么要有：把 Nexi 接到别人的机器、或接进一个你不敢完全信任的模型时，
 * "能读不能改"是唯一说得清楚的边界。这里不是说一句"建议别写"，而是
 * ① tools/list 里直接不广告写工具；② tools/call 真的拒掉，返回 isError。
 *
 * 判定粒度到 action：像 team_board 这种一个工具管十来个动作的，
 * 只读模式下 list/stats/events/teams 放行，add/done/claim/next/create 一律拒。
 *
 * 铁律：不在表里的工具 = 不放行（默认拒绝，不默认放行）。
 */

/** 只读模式下允许的 action；'all' 表示整个工具都能用。 */
export const READONLY_ALLOWED = {
  team_board: ['list', 'stats', 'events', 'teams'],
  agent_join: ['list', 'capabilities'],
  // 通行证：看身份、验卡、看账本都是纯读；issue/revoke 会写盘，只读模式下不出现
  agent_passport: ['show', 'verify', 'list'],
  deck_room: ['info'],
  deck_license: ['status', 'plans'],
  pet_visit: ['card', 'log'],
  pet_skin: ['list', 'states', 'render'],
  twin_recall: 'all',
  twin_brief: 'all',
  twin_forget: ['stats'],
  twin_habit: ['propose', 'list'],
  deck_meeting: ['show', 'list'],
  deck_automation: ['list', 'status'],
  // 市场：看货架/查渠道/查自己的订单都是纯读；buy/refund 会动钱和账本，只读模式下不出现
  deck_market: ['catalog', 'health', 'orders', 'reconcile'],
  // 1.10 跨设备同步：pack/info 是纯读（打包只在内存里加密，不落盘）；apply 会写本机 → 不出现。
  deck_sync: ['pack', 'info'],
  // 1.10 团队空间/策略/审计：成员名单、看规则、预演判定、翻审计都是纯读；
  // join/leave/remove/set-role/share/recall/set/reset/export 一律不出现。
  deck_team: ['members', 'status'],
  deck_policy: ['show', 'check'],
  deck_audit: ['tail', 'query'],
  // 以下工具在只读模式下整体不可用（没有只读动作可言）：
  // team_orchestrate / super_agent / pet_meeting / twin_remember
};

/** action 缺省时，工具自己会走哪个分支——按它来判断，别一律当写操作。 */
const DEFAULT_ACTION = {
  team_board: 'list',
  agent_join: 'list',
  // 工具的真实缺省动作是 issue（会写盘），所以这里必须写 issue：
  // 写成 show 会让"不带 action 的调用"在只读模式下被放行，然后真的签一张卡出去。
  agent_passport: 'issue',
  deck_room: 'info',
  deck_license: 'status',
  pet_visit: 'card',
  pet_skin: 'list',
  twin_forget: 'forget',
  twin_habit: 'propose',
  deck_meeting: 'list',
  deck_automation: 'status',
  deck_market: 'catalog',
  deck_sync: 'info',
  // 1.10：缺省动作都选纯读的那个，免得"不带 action"在只读模式下被误放行又误拒。
  deck_team: 'status',
  deck_policy: 'show',
  deck_audit: 'tail',
};

function actionOf(tool, args) {
  const raw = args && typeof args === 'object' ? args.action : undefined;
  const value = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : DEFAULT_ACTION[tool] || '';
  return value;
}

/** 这一次调用在只读模式下放不放行 */
export function isReadonlyAllowed(tool, args) {
  const rule = READONLY_ALLOWED[tool];
  if (!rule) return false;
  if (rule === 'all') return true;
  return rule.includes(actionOf(tool, args));
}

/** 拒掉时给模型看的人话（写清楚"为什么"和"怎么办"） */
export function readonlyBlockedMessage(tool, args) {
  const rule = READONLY_ALLOWED[tool];
  const action = actionOf(tool, args);
  const head = `只读模式（mcp.readOnly=true）：${tool}${action ? ` action=${action}` : ''} 会改状态，这里不执行。`;
  if (!rule) {
    return `${head}这个工具在只读模式下整体关闭；要用请让宿主进程把 mcp.readOnly 关掉再重连。`;
  }
  return `${head}只读模式下它只放行：${rule.join(' / ')}。`;
}

/**
 * 只读模式下该广告哪些工具：整体可用的照原样；部分可用的在描述里标明只剩哪些；
 * 一个动作都不剩的直接不出现——宁可少说，不可虚报。
 */
export function filterToolsForReadonly(defs) {
  const out = [];
  for (const def of defs) {
    const rule = READONLY_ALLOWED[def.name];
    if (rule === 'all') {
      out.push(def);
      continue;
    }
    if (Array.isArray(rule) && rule.length) {
      out.push({ ...def, description: `${def.description}（只读模式：仅 ${rule.join('/')} 可用）` });
    }
  }
  return out;
}

export function readonlyToolNames(defs) {
  return filterToolsForReadonly(defs).map((d) => d.name);
}

export default { READONLY_ALLOWED, isReadonlyAllowed, readonlyBlockedMessage, filterToolsForReadonly, readonlyToolNames };
