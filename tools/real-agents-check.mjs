#!/usr/bin/env node
/**
 * 真机验证：把本机装着的通用 Agent CLI 一个个真跑一遍
 *
 * 这脚本回答一个问题：**这台机器上，我点一下"让 claude / codex / gemini 一起干活"，真的能动吗？**
 * 它不是 mock，是起真进程、真调模型、真收结果。
 *
 * 用法：node tools/real-agents-check.mjs [--timeout 180] [--prompt "自定义"]
 * 产出：控制台表格 + docs/evidence/real-agents.md（带时间戳，可当验收证据）
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAgents, runAgent } from '../lib/engine/cli.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const TIMEOUT_MS = Number(arg('--timeout', 180)) * 1000;
const TARGETS = String(arg('--only', 'claude,codex,gemini,dsh')).split(',').map((s) => s.trim()).filter(Boolean);
const PROMPT =
  arg('--prompt', '') ||
  'You are being called by an orchestrator as a team member. Reply with exactly one line and nothing else: AGENTDECK_OK followed by your own model/agent name.';

const startedAt = new Date();

/**
 * 这些报错不是插件的问题，是那家 CLI 自己没配登录/凭据。
 * 区分开很重要：否则"环境没配"会被误读成"我们的接入层坏了"。
 */
const AUTH_HINTS = [
  [/Please set an Auth method/i, '这家 CLI 还没登录：先手动跑一次它自己的登录命令'],
  [/GEMINI_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA/i, '设置 GEMINI_API_KEY 环境变量，或跑一次 gemini 的登录'],
  [/ANTHROPIC_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY/i, '设置对应 API key 环境变量，或跑一次该 CLI 的登录'],
  [/not logged in|please (run )?.*login|未登录|请先登录/i, '先在该 CLI 里登录一次'],
  [/\b(401|403)\b|unauthorized|invalid api key|authentication/i, '凭据无效或过期：重新登录/换 key'],
];
function authReason(text) {
  for (const [re, hint] of AUTH_HINTS) if (re.test(text)) return hint;
  return '';
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

console.log('═══ 1. 检测本机 Agent ═══');
let detected = [];
try {
  detected = await detectAgents();
} catch (err) {
  console.log('检测失败：', err?.message || err);
}
const byId = new Map(detected.map((d) => [d.id, d]));
for (const d of detected) {
  console.log(`  ${d.available ? '✓' : '✗'} ${d.id.padEnd(12)} ${d.available ? d.cmd || '' : '（未安装）'} ${d.version ? '· ' + d.version : ''}`);
}

const rows = [];
console.log('\n═══ 2. 一个个真跑（真进程 + 真模型）═══');
for (const id of TARGETS) {
  const det = byId.get(id);
  if (!det || !det.available) {
    console.log(`  - ${id}：没装，跳过`);
    rows.push({ id, status: '未安装', detail: '' });
    continue;
  }
  process.stdout.write(`  → ${id} 开跑… `);
  const t0 = Date.now();
  let res;
  try {
    res = await runAgent(id, PROMPT, { timeoutMs: TIMEOUT_MS });
  } catch (err) {
    res = { rc: -1, out: '', err: err?.message || String(err) };
  }
  const ms = Date.now() - t0;
  const text = String(res.out || '').trim();
  const firstLine = text.split(/\r?\n/).filter(Boolean)[0] || '';
  const matched = /AGENTDECK_OK/i.test(text);
  const auth = res.rc === 0 ? '' : authReason(`${text}\n${res.err || ''}`);
  const status = res.rc === 0 && matched ? '通过' : auth ? '环境未配' : res.rc === 0 ? '有输出但未按格式' : res.timedOut ? '超时' : `退出码 ${res.rc}`;
  console.log(`${status} · ${fmtMs(ms)} · ${auth || firstLine.slice(0, 70) || String(res.err || '').slice(0, 70)}`);
  rows.push({
    id,
    status,
    ms,
    rc: res.rc,
    firstLine,
    outHead: text.slice(0, 600),
    errHead: String(res.err || '').slice(0, 400),
    auth,
    cmd: det.cmd || '',
    version: det.version || '',
  });
}

const pass = rows.filter((r) => r.status === '通过');
const skipped = rows.filter((r) => r.status === '未安装');
const envSkip = rows.filter((r) => r.status === '环境未配');
const failed = rows.filter((r) => r.status !== '通过' && r.status !== '未安装' && r.status !== '环境未配');
const runnable = rows.length - skipped.length;

console.log('\n═══ 3. 结论 ═══');
console.log(`  真跑通过：${pass.length} / ${runnable}（未装 ${skipped.length}，环境未配 ${envSkip.length}）`);
for (const e of envSkip) console.log(`  环境未配：${e.id} → ${e.auth}`);
if (failed.length) for (const f of failed) console.log(`  失败：${f.id} → ${f.status} ${f.errHead ? '· ' + f.errHead.split('\n')[0] : ''}`);

// ── 证据落盘 ───────────────────────────────────────────────────────────────
const dir = join(root, 'docs', 'evidence');
mkdirSync(dir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const file = join(dir, `real-agents-${stamp}.md`);
const lines = [
  `# 真机 Agent 验证记录`,
  ``,
  `- 时间：${startedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${startedAt.toISOString()}）`,
  `- 机器：${process.platform} ${process.arch} · Node ${process.version}`,
  `- 提示词：\`${PROMPT}\``,
  `- 超时：${fmtMs(TIMEOUT_MS)}`,
  ``,
  `## 结论`,
  ``,
  `真跑通过 **${pass.length}** 个（可跑 ${runnable} 个；未安装 ${skipped.length} 个，环境未配 ${envSkip.length} 个）：${pass.map((p) => '`' + p.id + '`').join('、') || '无'}`,
  ``,
  ...(envSkip.length
    ? ['需要用户自己配一次凭据（不是插件问题）：', '', ...envSkip.map((e) => `- \`${e.id}\`：${e.auth}`), '']
    : []),
  ``,
  `| Agent | 结果 | 耗时 | 退出码 | 命令行 | 版本 |`,
  `| --- | --- | --- | --- | --- | --- |`,
  ...rows.map((r) => `| ${r.id} | ${r.status} | ${r.ms ? fmtMs(r.ms) : '—'} | ${r.rc ?? '—'} | \`${r.cmd || '—'}\` | ${r.version || '—'} |`),
  ``,
  `## 原始输出（截断 600 字）`,
  ``,
  ...rows
    .filter((r) => r.outHead || r.errHead)
    .flatMap((r) => [`### ${r.id}`, '', '```', (r.outHead || '').trim() || '(无 stdout)', '```', '', r.errHead ? '```\n' + r.errHead.trim() + '\n```' : '', '']),
];
writeFileSync(file, lines.join('\n'), 'utf8');
console.log(`\n证据已写入：${file}`);
if (failed.length) process.exitCode = 1;
