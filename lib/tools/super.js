/**
 * tools/super.js —— 暴露给宿主的 `super_agent` 工具（真正干活的自主循环）
 *
 * 契约（docs/CONTRACTS.md 2.8）：createSuperTool(deps) => { name, description, parameters, execute }
 *
 * 它是整个插件的心脏：用户丢一句"帮我把这个项目跑起来"，宿主把它当一次工具调用，
 * 它内部则跑一个 think → act → observe 的循环，自己读文件、改文件、跑命令、查网页，
 * 直到能给出结论或步数用尽。
 *
 * 三条硬约束：
 *   1) 步数上限（默认 12，硬顶 25）——防止模型自我循环把 token 烧光；
 *   2) 同一个工具+同样的参数第二次出现就直接判定为"原地打转"，跳过并记进轨迹；
 *   3) execute 永不抛错：宿主侧一个异常就可能让整个会话崩，所以最外层兜住一切。
 */

import { chatWithTools, DEFAULT_MAX_STEPS } from './loop.js';
import { TOOL_PROTOCOL_PROMPT } from '../engine/llm.js';
import {
  buildToolCtx,
  clipText,
  emitSafe,
  normalizeDeps,
  requireFields,
  safeExecute,
  TOOL_OUTPUT,
  workspaceRoot,
} from './common.js';

/** 默认允许的工具集合（agent_run 只在宿主能派活时才出现）。 */
const BASE_TOOLS = [
  'fs_list',
  'fs_read',
  'fs_write',
  'fs_patch',
  'fs_glob',
  'fs_grep',
  'shell',
  'web_fetch',
  'http_request',
  'board_add',
  'board_list',
  'board_done',
  'ask_user',
];

export function createSuperTool(deps) {
  const d = normalizeDeps(deps);
  return {
    name: 'super_agent',
    description: [
      '让超级 Agent 自主完成一件真实工作（读/写文件、执行命令、查资料、更新任务板），不需要你先拆步骤。',
      '什么时候用：用户给了一个需要动手的目标（"修好这个 bug""把项目跑起来""查一下这个库怎么用并写个示例"），',
      '而你要的是一份带执行轨迹的结果报告。只想看计划不执行，请用 team_orchestrate 并传 dryRun:true。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '要完成的目标，写清背景和期望结果（越具体越好）。',
        },
        context: {
          type: 'string',
          description: '已知信息/约束/相关文件路径（可选）。',
        },
        workspace: {
          type: 'string',
          description: '工作区绝对路径（可选，默认用插件配置的工作区）。',
        },
        maxSteps: {
          type: 'number',
          description: `最多执行多少步思考-行动循环，默认 12，上限 ${DEFAULT_MAX_STEPS}。`,
        },
        tools: {
          type: 'array',
          description: '限制可用工具（可选，例如 ["fs_read","shell"]）。',
          items: { type: 'string' },
        },
        teamId: {
          type: 'string',
          description: '把执行过程记录到哪个小组的任务板（可选）。',
        },
      },
      required: ['goal'],
    },
    execute: safeExecute('super_agent', async (args, exec) => {
      const bad = requireFields(args, ['goal']);
      if (bad) return `【super_agent】${bad}`;
      if (!d.brain || typeof d.brain.chat !== 'function') {
        return '【super_agent】当前没有可用的大脑（模型通道未就绪）。请检查：宿主是否提供了 llm 服务，或是否配置了 baseUrl/apiKey/cliAgent。';
      }

      const root = args.workspace ? String(args.workspace) : workspaceRoot(d, exec);
      const maxSteps = Math.max(1, Math.min(DEFAULT_MAX_STEPS, Number(args.maxSteps) || 12));
      const allowed = pickTools(args.tools, Boolean(d.runAgent));
      const ctx = buildToolCtx({ deps: d, toolCtx: exec, teamId: args.teamId });
      ctx.root = root;

      emitSafe(d, 'super_start', { goal: args.goal, root, maxSteps, tools: allowed });

      const system = buildSystemPrompt({ root, allowed, mode: d.brain?.mode, hasTeam: Boolean(args.teamId) });
      const user = [
        `【目标】${args.goal}`,
        args.context ? `【已知信息】\n${args.context}` : '',
        '',
        '请开始工作。需要信息就调用工具，不要凭空猜测文件内容和命令输出。做完后给出中文结论。',
      ]
        .filter(Boolean)
        .join('\n');

      const result = await chatWithTools({
        brain: d.brain,
        system,
        user,
        allowed,
        ctx,
        maxSteps,
        signal: exec?.signal,
        onStep: (step) => emitSafe(d, 'super_step', { goal: args.goal, ...step }),
      });

      const report = renderReport({ goal: args.goal, root, result });
      emitSafe(d, 'super_done', { goal: args.goal, ok: result.ok, steps: result.trace.length, stopReason: result.stopReason });
      return report;
    }),
    // 宿主侧渲染：execute 返回 { text: 报告 }，这里兜住字符串/对象两种形态
    output: TOOL_OUTPUT,
    timeoutMs: 10 * 60 * 1000,
  };
}

/** 只保留工具带里真实存在、且本次允许的名字。 */
function pickTools(requested, hasDispatch) {
  const base = hasDispatch ? [...BASE_TOOLS, 'agent_run'] : BASE_TOOLS;
  if (!Array.isArray(requested) || !requested.length) return base;
  const set = new Set(requested.map((t) => String(t)));
  const picked = base.filter((t) => set.has(t));
  return picked.length ? picked : base;
}

/** 超级 Agent 的人格与纪律。 */
function buildSystemPrompt({ root, allowed, mode, hasTeam }) {
  const lines = [
    '你是一个能真正动手干活的超级 Agent（agentdeck-super）。',
    `工作区根目录：${root}（所有文件操作都必须在这个目录内）。`,
    `运行平台：${process.platform}；当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。`,
    '',
    '【工作方式】',
    '1. 先搞清楚现状再动手：不确定文件结构就 fs_list，不确定内容就 fs_read，不确定引用就 fs_grep。',
    '2. 改代码优先用 fs_patch 做精确替换；只有新建文件或整体重写才用 fs_write。',
    '3. 每次修改后要自证：跑测试/跑命令/再读一遍，并把实际输出作为证据。',
    '4. 绝不编造工具结果、文件内容或命令输出；没跑过就说没跑过。',
    '5. 一条命令超时就换思路，别反复重试同一条命令。',
    '6. 需要用户拍板的关键选择（删除数据、花钱、改线上）才用 ask_user。',
    hasTeam ? '7. 这件活如果更适合派给小组里更专业的成员，可以调用 agent_run 派活，并把它返回的结果当证据。' : '',
    '',
    '【输出纪律】',
    '· 中间过程不要长篇大论，把话留到最后；',
    '· 结束时用中文给结论：做了什么、证据是什么、还有什么没做完/有风险。',
  ];
  if (allowed.includes('agent_run')) lines.push('· 派活时把背景、交付物、验收标准一次写全，别让成员猜。');
  if (mode === 'cli') {
    lines.push('', '【重要】当前模型通道是本机 CLI，不能直接调用工具，必须使用下面的文本协议：', TOOL_PROTOCOL_PROMPT);
  }
  return lines.filter((l) => l !== '').join('\n');
}

function renderReport({ goal, root, result }) {
  const { ok, finalText, trace, stopReason, errors } = result;
  const head = ok ? '✅ 已完成' : '⚠️ 未完全完成';
  const parts = [
    `【super_agent】${head}`,
    `目标：${goal}`,
    `工作区：${root}`,
  ];
  if (finalText && finalText.trim()) parts.push('', `【结论】\n${clipText(finalText.trim(), 6000)}`);
  parts.push('', `【执行轨迹】共 ${trace.length} 步`);
  if (trace.length) {
    parts.push(
      trace
        .map((t, i) => `${i + 1}. [${t.tool}]${t.ok ? ' ✓' : ' ✗'} ${t.ms}ms${t.note ? ` — ${t.note}` : ''}${t.args ? `\n   参数：${t.args}` : ''}`)
        .join('\n'),
    );
  } else {
    parts.push('（没有执行任何工具调用）');
  }
  const evidence = trace.filter((t) => t.ok && t.evidence).slice(-3);
  if (evidence.length) parts.push('', `【关键证据】\n${evidence.map((t) => `· ${t.tool}: ${t.evidence}`).join('\n')}`);
  if (errors && errors.length) parts.push('', `【遇到的问题】\n${errors.map((e) => `· ${e}`).join('\n')}`);
  parts.push('', `【结束原因】${stopReason || '模型给出最终答复'}`);
  return parts.join('\n');
}

export default { createSuperTool };
