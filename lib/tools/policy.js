/**
 * lib/tools/policy.js —— `deck_policy` 工具（看规则 / 写规则 / 试判定 / 恢复默认）
 *
 * 为什么工具长这样：
 *   - 策略是"用户自己定的护栏"，所以必须有 show/set 让人看得见、改得动；
 *   - check 是"预演"：用户/模型在真正调危险工具前先问一句"这一步会被拦吗"；
 *   - reset 是后悔药：策略文件写坏了、规则写乱了，一条命令回到默认。
 *
 * 接线状态（1.10.0 起）：**已经接线，deny 会真的拦住工具执行**。
 *   lib/index.js 里每个注册的工具都包了一层 guarded()：执行前先 decide()，
 *   命中 deny 就不调真正的 execute，只回一句【策略拒绝】；要确认的规则必须带 confirm:true；
 *   每次调用都 appendAudit() 记一笔，deck_audit 能翻。
 *   接线本身由 tests/policy-wiring.test.mjs 从宿主工具带里取出 execute 真调来证明，
 *   而不是只测引擎函数算得对。
 *
 * 边界（不许美化）：本工具**自己**不拦任何东西——它只管读写规则。
 * 拦住工具的是 lib/index.js 的 guarded()；如果哪天那层接线被摘掉，这里写的规则
 * 就只是躺在盘上，不会生效。所以别把"写了规则"和"规则生效"当成一回事。
 */

import { normalizeDeps, safeExecute, workspaceRoot, emitSafe, TOOL_OUTPUT } from './common.js';
import {
  decide,
  defaultPolicy,
  describeBudget,
  loadPolicy,
  normalizePolicy,
  recordUsage,
  redactDetails,
  resetPolicy,
  savePolicy,
} from '../policy/engine.js';
import { appendAudit } from '../policy/audit.js';

const ACTIONS = ['show', 'set', 'check', 'reset'];

const EFFECT_LABEL = Object.freeze({ allow: '放行', confirm: '需确认', deny: '拒绝' });

/** 参数里允许的动作名，写错时给人话提示，而不是静默当 show。 */
function normalizeAction(value) {
  const action = String(value || 'show').trim().toLowerCase();
  if (action === 'list') return 'show'; // 顺手兼容 list
  return ACTIONS.includes(action) ? action : '';
}

/** 规则压成一行，show / set 共用。 */
function ruleLine(rule, index, usageEntry) {
  const target = [rule.match?.tool, rule.match?.action].filter(Boolean).join(' / ');
  const budget = describeBudget(rule, usageEntry);
  const bits = [`${index + 1}. [${rule.effect}] ${target || '(未限定)'}`];
  if (budget) bits.push(`预算：${budget}`);
  if (rule.reason) bits.push(`原因：${rule.reason}`);
  return bits.join(' ｜ ');
}

/** 规则结构写给人看的模板（set 不传参时返回）。 */
const RULE_TEMPLATE = '{"id":"no-market-buy","match":{"tool":"deck_market","action":"buy"},"effect":"deny","budget":{"perHour":10,"perDay":100},"reason":"付款前先人工确认"}';

export function createPolicyTool(deps) {
  const d = normalizeDeps(deps);
  const rootOf = () => {
    try {
      if (d.root) return String(d.root());
    } catch {
      // root 句柄自己炸了就退回工作区，别让工具直接失败。
    }
    return String(workspaceRoot(d));
  };

  return {
    name: 'deck_policy',
    description: [
      '查看或修改 agentdeck-super 的动作策略（policy.json）：',
      'show=当前规则与预算用量（默认）；',
      'set=写入规则（rule 单条或 rules 数组，replace:true 表示整份替换）；',
      'check=预演一次工具调用会被放行/需确认/拒绝（可带 record:true 记账并写审计）；',
      'reset=恢复默认（清空规则与计数）。',
      '规则没命中时普通动作放行，付款/删除/发消息/外部写入默认要确认；deny 只能由规则给出。',
      '1.10.0 起已经接线：本插件注册的每个工具在真正执行之前都会过一遍这里写的规则，被 deny 的工具不会被执行（只回一句【策略拒绝】），要确认的动作必须带 confirm:true 才往下走，每次调用都会记一笔审计（deck_audit 能翻）。',
      '不想写规则但想让所有确认级动作都拦下来：设 AGENTDECK_POLICY_STRICT=1，或写入 strict:true（放 set 的 rule 里不带 match 的那种会被拒，请用 replace:true 整份覆盖）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: '要做什么：show / set / check / reset（默认 show）',
        },
        rule: {
          type: 'object',
          description: `一条策略规则，例：${RULE_TEMPLATE}`,
          properties: {
            id: { type: 'string', description: '规则 id（不填自动生成）' },
            match: {
              type: 'object',
              description: '匹配条件，tool / action 至少填一个；支持 * 通配和数组',
              properties: {
                tool: { type: ['string', 'array'], description: '工具名，如 deck_room 或 deck_*' },
                action: { type: ['string', 'array'], description: '动作名，如 buy 或 [buy, refund]' },
              },
            },
            effect: { type: 'string', enum: ['allow', 'confirm', 'deny'], description: '命中后的处理' },
            budget: {
              type: 'object',
              description: '预算：超过就拒绝（只对命中此规则的调用计数）',
              properties: {
                perHour: { type: 'number', description: '每小时最多几次' },
                perDay: { type: 'number', description: '每天最多几次' },
              },
            },
            reason: { type: 'string', description: '给人看的原因' },
          },
          required: ['match', 'effect'],
        },
        rules: {
          type: 'array',
          description: '多条规则；默认按 id 追加/覆盖，replace:true 时整份替换',
          items: { type: 'object' },
        },
        replace: { type: 'boolean', description: 'set 时是否整份替换（默认 false：追加/按 id 覆盖）' },
        tool: { type: 'string', description: 'check：要检查的工具名，如 deck_room' },
        toolAction: { type: 'string', description: 'check：要检查的动作名，如 send' },
        cost: { type: 'number', description: 'check：本次动作消耗的预算次数（默认 1）' },
        record: { type: 'boolean', description: 'check：是否把这次判定记账并写审计（默认 false）' },
        text: { type: 'string', description: '可选：按默认规则脱敏预览一段文本（不会存盘）' },
        teamId: { type: 'string', description: '写审计时归到哪个小组（可选）' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('deck_policy', async (args = {}) => {
      const root = rootOf();
      const action = normalizeAction(args.action);
      if (!action) return `【deck_policy】不认识的动作：${String(args.action)}。可用：${ACTIONS.join(' / ')}。`;

      if (action === 'show') {
        const loaded = loadPolicy(root);
        const p = loaded.policy;
        const lines = [];
        if (!loaded.ok) {
          lines.push(`【deck_policy】策略文件有问题，已按可读部分继续：${(loaded.issues || []).join('；')}`);
        }
        lines.push(`【deck_policy】当前策略：${p.rules.length} 条规则`);
        if (!p.rules.length) {
          lines.push('还没有规则。普通动作默认放行；付款/删除/发消息/外部写入默认要确认。');
        } else {
          p.rules.forEach((rule, i) => lines.push(ruleLine(rule, i, p.usage[rule.id])));
        }
        lines.push(`策略文件：${loaded.file}${loaded.missing ? '（还不存在，第一次 set 时创建）' : ''}`);
        lines.push(`严格模式：${p.strict === true ? '开（AGENTDECK_POLICY_STRICT 或 policy.json 里 strict:true，所有确认级动作都要 confirm:true）' : '关（只有你写的规则才会拦人）'}`);
        lines.push('接线状态：1.10.0 起已生效 —— 本插件注册的工具在真正执行前都会过一遍这里写的规则，被拒的工具不会被执行，每次调用都记一笔 deck_audit。');
        return lines.join('\n');
      }

      if (action === 'set') {
        // strict 属于"整份策略"级的开关，不是一条规则：单独给个入口，省得用户去手改 JSON。
        const onlyStrict = args.rule === undefined && args.rules === undefined && args.strict !== undefined;
        if (onlyStrict) {
          const loaded = loadPolicy(root);
          const saved = savePolicy(root, { ...loaded.policy, strict: args.strict === true });
          if (!saved.ok) return `【deck_policy】严格模式没写进 ${saved.file}：${saved.error}`;
          return `【deck_policy】严格模式已${args.strict === true ? '打开' : '关闭'}（${saved.file}）。${args.strict === true ? '之后所有"要确认"的动作都必须带 confirm:true 才会执行。' : '之后只有你自己写的规则会拦人。'}`;
        }
        const incoming = [];
        if (Array.isArray(args.rules)) incoming.push(...args.rules);
        else if (args.rules !== undefined) return '【deck_policy】rules 必须是数组。';
        if (args.rule && typeof args.rule === 'object') incoming.push(args.rule);
        if (!incoming.length) {
          return `【deck_policy】set 需要 rule（一条）或 rules（数组）。规则长这样：${RULE_TEMPLATE}\n注意：match.tool / match.action 至少填一个，否则会吞掉所有动作，引擎会拒绝。`;
        }

        const loaded = loadPolicy(root);
        const base = loaded.policy;
        const rules = args.replace === true ? [] : base.rules.map((r) => ({ ...r, match: { ...r.match }, budget: { ...r.budget } }));
        const skipped = [];
        let counter = rules.length;
        incoming.forEach((raw, index) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            skipped.push(`第 ${index + 1} 条不是对象`);
            return;
          }
          const candidate = { ...raw };
          if (!String(candidate.id ?? '').trim()) {
            let id;
            do {
              counter += 1;
              id = `rule_${counter}`;
            } while (rules.some((r) => r.id === id));
            candidate.id = id;
          }
          const one = normalizePolicy({ rules: [candidate] });
          if (!one.policy.rules.length) {
            skipped.push(`第 ${index + 1} 条无效：${one.issues.join('；') || '结构不对'}`);
            return;
          }
          const rule = one.policy.rules[0];
          const at = rules.findIndex((r) => r.id === rule.id);
          if (at >= 0) rules[at] = rule;
          else rules.push(rule);
        });

        if (!rules.length) {
          return `【deck_policy】没有写入任何规则：${skipped.join('；') || '没有有效规则'}。`;
        }

        const saved = savePolicy(root, { rules, usage: base.usage });
        if (!saved.ok) {
          return `【deck_policy】规则没有写进 ${saved.file}：${saved.error}${(saved.issues || []).length ? `（${saved.issues.join('；')}）` : ''}`;
        }
        const lines = [`【deck_policy】已写入 ${saved.policy.rules.length} 条规则（本批 ${incoming.length} 条${args.replace === true ? '，整份替换' : ''}）`];
        if (skipped.length) lines.push(`跳过：${skipped.join('；')}`);
        saved.policy.rules.forEach((rule, i) => lines.push(ruleLine(rule, i, saved.policy.usage[rule.id])));
        lines.push(`策略文件：${saved.file}`);
        // 1.10.0 起策略真的接线了：这句话以前写的是「宿主未接线时只是存着，不会真的拦工具」，
        // 那是接线之前的实话；现在 deny 会真拦住工具执行，再留着这句话就是误导。
        lines.push('已生效：从下一次工具调用起，命中 deny 的规则会真的拦住执行（工具不会跑，只回一句【策略拒绝】）；要确认的规则必须带 confirm:true。每次调用都会记一笔审计，deck_audit 能翻。');
        emitSafe(d, 'policy_set', { file: saved.file, count: saved.policy.rules.length });
        return lines.join('\n');
      }

      if (action === 'check') {
        const tool = String(args.tool || '').trim();
        const toolAction = String(args.toolAction ?? args.actionName ?? args.targetAction ?? '').trim();
        const cost = Number(args.cost);
        if (!tool) return '【deck_policy】check 需要 tool（要检查的工具名），例如 tool:"deck_market", toolAction:"buy"。';

        const loaded = loadPolicy(root);
        const now = Date.now();
        const request = { tool, action: toolAction, cost: Number.isFinite(cost) ? cost : undefined };
        const decision = decide(loaded.policy, request, { now });
        const label = EFFECT_LABEL[decision.effect] || decision.effect;

        const lines = [
          `【deck_policy】判定：${label}（${decision.effect}）`,
          `- 动作：${tool}${toolAction ? ` / ${toolAction}` : ''}`,
          `- 依据：${decision.reason}`,
        ];
        const rule = decision.matchedRule;
        if (rule && (rule.budget?.perHour || rule.budget?.perDay)) {
          lines.push(`- 预算：${describeBudget(rule, loaded.policy.usage[rule.id], now) || '无限制'}`);
        }
        lines.push(`- 策略文件：${loaded.file}${loaded.missing ? '（还不存在，按默认策略判定）' : ''}`);

        let recorded = false;
        if (args.record === true) {
          if (decision.effect === 'deny') {
            lines.push('- 记账：没有记（被拒绝的调用没有真正发生，不该占用预算）');
          } else {
            const rec = recordUsage(loaded.policy, request, { now });
            const saved = savePolicy(root, rec.policy);
            if (saved.ok) {
              recorded = true;
              const entry = saved.policy.usage[rec.matchedRuleId || '__default__'];
              lines.push(`- 记账：已记 1 次${rec.matchedRuleId ? `（规则「${rec.matchedRuleId}」）` : '（默认桶）'}，本小时 ${entry?.hour ?? 0} 次 / 今天 ${entry?.day ?? 0} 次`);
            } else {
              lines.push(`- 记账：失败（${saved.error}），判定结果不受影响`);
            }
            const audit = appendAudit(root, {
              ts: new Date(now).toISOString(),
              tool,
              action: toolAction,
              result: decision.effect,
              kind: 'policy/check',
              cost: decision.cost,
              teamId: args.teamId,
              source: 'policy',
              summary: decision.reason,
            });
            if (!audit.ok) lines.push(`- 审计：写 ${audit.file} 失败（${audit.error}）`);
          }
        } else {
          lines.push('- 记账：未记账（record 默认 false，避免重复计数）');
        }

        if (decision.effect === 'deny') {
          // 以前这里写「只在宿主接线后才会真正拦截」——那是接线之前的实话。
          // 1.10.0 起接线了，再写这句就是骗人：用户会以为写了规则没用。
          lines.push('提醒：这条规则**已经生效**——真的去调这个工具会被拦住（工具不会执行，只回一句【策略拒绝】）。');
        }

        if (args.text !== undefined && args.text !== null) {
          const preview = redactDetails(String(args.text));
          lines.push(`- 脱敏预览：${preview.text}`);
          if (preview.hits.length) lines.push(`  （命中规则：${[...new Set(preview.hits)].join('、')}）`);
        }

        emitSafe(d, 'policy_check', {
          tool,
          action: toolAction,
          effect: decision.effect,
          matchedRuleId: decision.matchedRuleId,
          recorded,
        });
        return lines.join('\n');
      }

      // reset
      const reset = resetPolicy(root);
      if (!reset.ok) return `【deck_policy】恢复默认失败：${reset.error}`;
      emitSafe(d, 'policy_reset', { file: reset.file });
      return [
        '【deck_policy】已恢复默认策略：0 条规则、计数清零。',
        `策略文件：${reset.file}`,
        '空策略 = 普通动作放行；付款/删除/发消息/外部写入仍然默认要确认（这是动作分级，不是规则）。',
      ].join('\n');
    }),
  };
}

export default { createPolicyTool };
