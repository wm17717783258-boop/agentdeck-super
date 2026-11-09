/**
 * lib/tools/mandate.js —— `twin_mandate` 工具（看执照 / 签发 / 吊销 / 预演自主裁决）
 *
 * 这个工具把 lib/twin/mandate.js 的能力交给用户和模型：
 *   show    看分身现在被授权干什么（默认动作）
 *   issue   签一张执照（不给 scope 就是最小权限默认值）
 *   revoke  吊销一张（本地账本打标 + 清掉 active）
 *   check   预演："这个动作分身能自己干吗？" → allow / confirm / deny
 *
 * 边界（不许美化，和 agent_passport / deck_policy 保持同一套诚实口径）：
 *   - 验签通过只证明"执照没被改过、签发方没换过"，**不证明**"这个分身值得信任"。
 *   - revoke 只标本地账本；执照在别的机器上照样验得过（离线凭证没有吊销中心）。
 *   - 本工具不拦任何东西：真正拦自主行动的是 lib/index.js 的 guarded() + 这里的 judgeAutonomy。
 */

import { normalizeDeps, safeExecute, workspaceRoot, emitSafe, TOOL_OUTPUT } from './common.js';
import {
  MANDATE_PREFIX,
  defaultMandate,
  issueMandate,
  mandatePaths,
  mandateSummary,
  readActiveMandate,
  readMandateLedger,
  revokeMandate,
  judgeAutonomy,
  verifyMandate,
} from '../twin/mandate.js';

const ACTIONS = ['show', 'issue', 'revoke', 'check'];

function normalizeAction(value) {
  const action = String(value || 'show').trim().toLowerCase();
  if (action === 'status' || action === 'list') return 'show';
  return ACTIONS.includes(action) ? action : '';
}

function fmtTime(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 执照范围压成几行人话。 */
function scopeLines(claims) {
  const tools = claims?.scope?.tools || [];
  const actions = claims?.scope?.actions || [];
  const deny = claims?.scope?.deny || [];
  const windows = claims?.time?.windows || [];
  const lines = [
    `工具白名单：${tools.length ? tools.join('、') : '（空，任何工具都要问）'}`,
    `动作白名单：${actions.length ? actions.join('、') : '（空）'}`,
    `明确禁止：${deny.length ? deny.join('、') : '（无）'}`,
    `每日上限：${claims?.budget?.perDay ?? '不限'} 次；单次最长：${claims?.budget?.maxRuntimeMin ?? '不限'} 分钟`,
    `时间窗：${windows.length ? `${windows.join('、')}（${claims?.time?.tz || '本机时区'}）` : '全天'}`,
    `对外可见范围：${(claims?.peerScope?.maySendTo || []).join('、') || '（无）'}`,
  ];
  return lines;
}

export function createMandateTool(deps) {
  const d = normalizeDeps(deps);
  const rootOf = () => {
    try {
      if (d.root) return String(d.root());
    } catch {
      // root 句柄自己炸了退回工作区，别让工具直接失败。
    }
    return String(workspaceRoot(d));
  };

  return {
    name: 'twin_mandate',
    description: [
      '分身执照：规定"数字分身（桌宠）在什么范围内可以自己动手、不用问主人"。',
      'show=看当前执照（默认）；issue=签一张新执照并激活；revoke=吊销；check=预演一个动作会被放行/需确认/拒绝。',
      '默认执照是最小权限：只读工具 + 只写任务板，shell 和 fs_write 在禁止清单里。',
      '自主裁决顺序：明确禁止 > 时间窗 > 预算 > 白名单；白名单外的动作是"回去问主人"（confirm），不是直接拒。',
      '边界：验签只证明执照没被改过，不证明分身值得信任；revoke 只标本地账本，别的机器照样验得过。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'issue', 'revoke', 'check'], description: '要做什么，默认 show。' },
        tools: { type: 'array', items: { type: 'string' }, description: 'issue：工具白名单（支持 fs_* 这种族匹配）。不给就用最小权限默认值。' },
        actions: { type: 'array', items: { type: 'string' }, description: 'issue：动作白名单（如 board_add）。' },
        deny: { type: 'array', items: { type: 'string' }, description: 'issue：明确禁止的工具/动作（优先级最高）。' },
        perDay: { type: 'number', description: 'issue：每日自主行动上限（次数）。' },
        maxRuntimeMin: { type: 'number', description: 'issue：单次自主行动最长分钟数。' },
        windows: { type: 'array', items: { type: 'string' }, description: 'issue：允许自主行动的时间窗，如 ["09:00-22:00"]；跨夜写 ["22:00-06:00"]。' },
        tz: { type: 'string', description: 'issue：时间窗用什么时区，默认 Asia/Shanghai。' },
        ttlDays: { type: 'number', description: 'issue：有效期天数，默认 30，最多 365。' },
        id: { type: 'string', description: 'revoke：要吊销的执照 id。' },
        mandate: { type: 'string', description: 'show/check：要校验的执照串（不给就用本机当前激活的那张）。' },
        tool: { type: 'string', description: 'check：要预演的工具名，如 fs_write。' },
        checkAction: { type: 'string', description: 'check：要预演的动作名，如 board_add。' },
        dayUsage: { type: 'number', description: 'check：假设今天已经用了多少次（算预算够不够）。' },
      },
      required: [],
    },
    execute: safeExecute('twin_mandate', async (args) => {
      const action = normalizeAction(args.action);
      if (!action) return `不认识的动作「${args.action}」。可用：show、issue、revoke、check。`;
      const root = rootOf();

      if (action === 'show') {
        // 带 mandate 参数就校验那一张（不落盘）；不带就看本机当前激活的
        if (typeof args.mandate === 'string' && args.mandate.trim()) {
          const v = verifyMandate(args.mandate);
          if (!v.ok) return `【twin_mandate】这张执照没通过：${v.reason}（code=${v.code}）`;
          return [
            `【twin_mandate】执照有效：${v.claims.id}`,
            `签发方：${v.kid}；主体：${v.claims.subject || '未指定'}`,
            `到期：${fmtTime(v.claims.exp)}`,
            ...scopeLines(v.claims),
          ].join('\n');
        }

        const summary = mandateSummary(root);
        if (!summary.hasActive) {
          return [
            '【twin_mandate】本机还没有生效的执照——分身现在**不会自主行动**（所有事都要你点头）。',
            '要让它在你授权范围内自己干活，用 twin_mandate issue（不给 scope 就是最小权限）。',
            `账本：签过 ${summary.issued} 张，吊销过 ${summary.revoked} 张。`,
          ].join('\n');
        }
        const active = readActiveMandate(root);
        return [
          `【twin_mandate】当前执照：${summary.id}`,
          `主体：${summary.subject || '未指定'}`,
          `到期：${fmtTime(summary.expiresAt)}`,
          `现在能不能自主行动：${summary.insideWindow ? '能（在时间窗内）' : '不能（时间窗外）'}`,
          ...scopeLines(active.claims || defaultMandate()),
          `账本：签过 ${summary.issued} 张，吊销过 ${summary.revoked} 张。`,
          `文件：${summary.file}`,
          '想把范围缩小或扩大，用 twin_mandate issue 重新签一张（新的会替换当前生效的）。',
        ].join('\n');
      }

      if (action === 'issue') {
        const scope = {};
        if (Array.isArray(args.tools)) scope.tools = args.tools;
        if (Array.isArray(args.actions)) scope.actions = args.actions;
        if (Array.isArray(args.deny)) scope.deny = args.deny;
        const input = {};
        if (Object.keys(scope).length) input.scope = scope;
        if (Number.isFinite(Number(args.perDay)) || Number.isFinite(Number(args.maxRuntimeMin))) {
          input.budget = {};
          if (Number.isFinite(Number(args.perDay))) input.budget.perDay = Number(args.perDay);
          if (Number.isFinite(Number(args.maxRuntimeMin))) input.budget.maxRuntimeMin = Number(args.maxRuntimeMin);
        }
        if (Array.isArray(args.windows) || typeof args.tz === 'string') {
          input.time = {};
          if (Array.isArray(args.windows)) input.time.windows = args.windows;
          if (typeof args.tz === 'string' && args.tz.trim()) input.time.tz = args.tz.trim();
        }
        if (Number.isFinite(Number(args.ttlDays))) input.ttlDays = Number(args.ttlDays);

        const issued = issueMandate(root, input);
        if (!issued.ok) return `【twin_mandate】执照没签成：${issued.reason}`;
        emitSafe(d, 'mandate_issued', { id: issued.claims.id, kid: issued.kid });
        return [
          `【twin_mandate】已签发并激活：${issued.claims.id}`,
          `类型：${issued.mandate.slice(0, 24)}…（${MANDATE_PREFIX}，共 ${issued.mandate.length} 字符）`,
          `到期：${fmtTime(issued.claims.exp)}`,
          ...scopeLines(issued.claims),
          '',
          '从这一刻起，分身在这个范围内可以自己动手；超出的会停下来问你。',
          `文件：${issued.file}`,
        ].join('\n');
      }

      if (action === 'revoke') {
        const id = String(args.id || '').trim();
        if (!id) {
          const ledger = readMandateLedger(root);
          const live = ledger.items.filter((x) => !x.revokedAt);
          if (!live.length) return '【twin_mandate】账本里没有生效的执照可以吊销。';
          return [
            '【twin_mandate】revoke 需要 id：给一个要吊销的执照 id。',
            ...live.slice(-5).map((x) => `· ${x.id}（签于 ${fmtTime(x.issuedAt)}，到期 ${fmtTime(x.expiresAt)}）`),
          ].join('\n');
        }
        const done = revokeMandate(root, id);
        if (!done.ok) return `【twin_mandate】吊销没成功：${done.reason}`;
        emitSafe(d, 'mandate_revoked', { id });
        return [
          `【twin_mandate】已吊销 ${id}（本机账本打标 + 清掉当前激活的执照）。`,
          '注意：离线凭证没有吊销中心，这张执照在别人的机器上**照样验得过**；本机不再认它。',
        ].join('\n');
      }

      // check：预演一个动作
      let claims = null;
      if (typeof args.mandate === 'string' && args.mandate.trim()) {
        const v = verifyMandate(args.mandate);
        if (!v.ok) return `【twin_mandate】这张执照没通过，没法据此预演：${v.reason}（code=${v.code}）`;
        claims = v.claims;
      } else {
        const active = readActiveMandate(root);
        if (!active.ok || !active.claims) {
          return '【twin_mandate】本机没有生效的执照，分身不会自主行动——任何动作都要你先点头。先 issue 一张再 check。';
        }
        claims = active.claims;
      }

      const tool = String(args.tool || '').trim();
      const checkAction = String(args.checkAction || '').trim();
      if (!tool && !checkAction) return '【twin_mandate】check 至少要给 tool 或 checkAction 其中一个。';

      const verdict = judgeAutonomy(claims, { tool, action: checkAction }, { dayUsage: Number(args.dayUsage) || 0 });
      const label = verdict.effect === 'allow' ? '可以自己干' : verdict.effect === 'confirm' ? '得先问主人' : '不许干';
      return [
        `【twin_mandate】预演：${tool || checkAction} → ${verdict.effect}（${label}）`,
        `原因：${verdict.reason}`,
        verdict.scopeHit ? `命中：${verdict.scopeHit}` : '',
        '',
        '（这只是预演，不改任何状态。真正执行时由插件在调用前走同一条判定。）',
      ].filter(Boolean).join('\n');
    }),
    output: TOOL_OUTPUT,
  };
}

export default { createMandateTool };
