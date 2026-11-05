/**
 * tools/loop.js —— 自主循环内核（think → act → observe）
 *
 * super_agent 和 team_orchestrate 的"自己干"分支共用这一套。
 * 抽出来的好处：循环的三种病（烧 token、原地打转、异常炸宿主）只需在一个地方治。
 *
 * 治好它们的办法：
 *   · 步数上限，且到顶后要一次"收尾总结"，保证用户一定能看到结论；
 *   · 相同 工具+参数 只跑一次，第二次起直接告诉模型"这一步重复了"；
 *   · 连续 3 轮工具全失败就提前收尾（多半是环境坏了，再跑也是白烧）；
 *   · 所有 invoke/ brain.chat 都包 try/catch，任何异常只记进 errors，不外抛。
 */

import { invoke, schemas, TOOL_NAMES } from '../engine/toolbelt.js';
import { clipText, stableKey, summarizeArgs } from './common.js';

/** 硬顶步数：再复杂的活也不该超过这个数（保护配额）。 */
export const DEFAULT_MAX_STEPS = 25;

/** 单步最多并行执行几个工具调用（模型偶尔一次吐 10 个，全并行会打爆文件句柄）。 */
const MAX_PARALLEL_CALLS = 4;

/**
 * 跑一个自主循环。
 * 返回 { ok, finalText, trace, stopReason, errors }，永不抛错。
 */
export async function chatWithTools({
  brain,
  system,
  user,
  allowed = [],
  ctx = {},
  maxSteps = 12,
  signal,
  onStep,
  maxTokens = 3000,
  temperature = 0.2,
} = {}) {
  const messages = [
    { role: 'system', content: String(system || '') },
    { role: 'user', content: String(user || '') },
  ];
  const trace = [];
  const errors = [];
  const seen = new Set();
  const tools = Array.isArray(allowed) && allowed.length ? schemas(allowed) : undefined;
  const steps = Math.max(1, Math.min(DEFAULT_MAX_STEPS, Number(maxSteps) || 12));

  let finalText = '';
  let stopReason = '';
  let consecutiveFail = 0;
  let fatal = false;

  for (let step = 1; step <= steps; step += 1) {
    if (signal?.aborted) {
      stopReason = '任务被取消（signal aborted）';
      break;
    }

    let res;
    try {
      res = await brain.chat({ messages, tools, temperature, maxTokens, signal });
    } catch (err) {
      fatal = true;
      errors.push(`模型调用失败：${err?.message || err}`);
      stopReason = `模型调用失败：${err?.name || 'Error'}: ${err?.message || err}`;
      break;
    }

    const content = String(res?.content ?? '');
    const calls = Array.isArray(res?.toolCalls) ? res.toolCalls : [];

    if (!calls.length) {
      finalText = content || finalText;
      stopReason = '模型给出最终答复';
      break;
    }

    // 把这一步的"想法"留在对话里，下一步模型才知道自己刚才想干什么
    messages.push({
      role: 'assistant',
      content: content && content.trim() ? content : `（调用工具：${calls.map((c) => c?.name).filter(Boolean).join('、')}）`,
    });

    const batch = calls.slice(0, MAX_PARALLEL_CALLS);
    const started = Date.now();
    const results = await Promise.all(
      batch.map((call) => runOne(call, { ctx, seen, trace, allowed, errors })),
    );
    for (const r of results) messages.push({ role: 'user', content: `【工具结果 ${r.name}】\n${r.text}` });

    const anyOk = results.some((r) => r.ok);
    if (!anyOk) {
      consecutiveFail += 1;
      if (consecutiveFail >= 3) {
        stopReason = '连续 3 轮工具全部失败，提前收尾';
        onStep?.({ step, tools: batch.map((c) => c?.name), ok: false, ms: Date.now() - started });
        break;
      }
    } else {
      consecutiveFail = 0;
    }
    onStep?.({ step, tools: batch.map((c) => c?.name), ok: anyOk, ms: Date.now() - started });

    if (step === steps) stopReason = `达到步数上限（${steps} 步）`;
  }

  // 收尾：只要不是"模型自己给了结论"，就再要一段中文总结，别让用户只看到一堆工具日志
  if (stopReason !== '模型给出最终答复' && !signal?.aborted) {
    try {
      const wrap = await brain.chat({
        messages: [
          ...messages,
          {
            role: 'user',
            content: '请基于以上所有工具结果，用中文给出最终结论：完成了什么、依据是什么（引用真实输出）、还有什么没做完或有风险。不要调用工具。',
          },
        ],
        temperature,
        maxTokens: 1600,
        signal,
      });
      const text = String(wrap?.content ?? '').trim();
      if (text) finalText = text;
    } catch (err) {
      errors.push(`收尾总结失败：${err?.message || err}`);
    }
  }

  const ok = !fatal && !signal?.aborted && Boolean(finalText && finalText.trim());
  return { ok, finalText, trace, stopReason, errors };
}

/** 执行单个工具调用；所有异常都在这里被吃掉。 */
async function runOne(call, { ctx, seen, trace, errors, allowed }) {
  const name = String(call?.name ?? call?.tool ?? call?.tool_name ?? '').trim();
  let args = call?.args ?? call?.arguments ?? call?.parameters ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!name) {
    errors.push('模型返回了一个没有名字的工具调用');
    return { name: '(未知)', ok: false, text: '工具调用缺少 name 字段，已忽略。' };
  }

  // 被拒绝的调用也必须留下痕迹：否则报告里会出现"共 0 步 + 已完成"的自相矛盾，
  // 用户完全看不出模型其实想调一个没授权/不存在的工具。
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(name)) {
    const text = `工具 ${name} 不在本次允许范围内。可用：${allowed.join('、')}`;
    errors.push(`${name}: ${text}`);
    trace.push({ tool: name, args: summarizeArgs(args, 160), ok: false, ms: 0, evidence: '（未授权，已拒绝）' });
    return { name, ok: false, text };
  }

  const key = stableKey(name, args);
  if (seen.has(key)) {
    trace.push({ tool: name, args: summarizeArgs(args, 160), ok: false, ms: 0, evidence: '（与上一步重复，已跳过）' });
    return { name, ok: false, text: '这一步与之前完全相同，已跳过（避免原地打转）。请换一种做法，或直接给结论。' };
  }
  seen.add(key);

  const t0 = Date.now();
  const out = await invoke(name, args, ctx);
  const ms = Date.now() - t0;
  const text = clipText(out?.content ?? '', 12_000);
  const ok = out?.ok !== false;

  // 轨迹只留"人能看懂"的摘要：工具名、参数摘要、耗时、第一条结果
  trace.push({ tool: name, args: summarizeArgs(args, 160), ok, ms, evidence: ok ? firstLine(text) : '' });
  if (!ok) errors.push(`${name}: ${firstLine(text).slice(0, 200)}`);
  return { name, ok, text };
}

function firstLine(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
}

export { TOOL_NAMES };
export default { chatWithTools, DEFAULT_MAX_STEPS };
