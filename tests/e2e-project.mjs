#!/usr/bin/env node
/**
 * 真项目验收：把**两个不同厂商的 Agent**（Claude Code + Codex）拉进同一个任务板，
 * 按角色分工，让它们在一个真实目录里合作写出一个能跑的模块 + 测试，然后真跑测试。
 *
 * 为什么单独做这一条：`e2e-local.mjs` 第 1 步只证明"能起子进程、能解析输出"；
 * 这条证明的是**协同**——建组 → 派活 → 抢占认领 → 干活 → 完成 → 下一棒，
 * 而且产物是可执行的真代码，不是"它说它写好了"。
 *
 *   node tests/e2e-project.mjs            # 跑，产物目录保留并打印路径
 *   node tests/e2e-project.mjs --keep     # 同上（默认就保留，方便自己看）
 *   node tests/e2e-project.mjs --clean    # 跑完删掉产物目录
 *
 * 退出码：0 全部通过 / 1 有环节失败 / 2 本机缺 Agent 跑不了（不算失败，如实标"环境未配"）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgent, resolveCommand } from '../lib/engine/cli.js';
import { createBoard } from '../lib/engine/board.js';

const clean = process.argv.includes('--clean');
// --dry：用一个假的"Agent"（直接写文件）把整条流水线（任务板→断言→证据格式）跑一遍，
// 不花真 token、不装真 Agent。用来改脚本时不烧钱，别把 dry 的产物当验收证据。
const dry = process.argv.includes('--dry');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const startedAt = Date.now();

const lines = [];
function say(text = '') {
  lines.push(text);
  console.log(text);
}
function row(cells, widths) {
  say(`| ${cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ')} |`);
}

// ── 0. 本机能跑哪几个 ──────────────────────────────────────────────────────
const plan = [
  {
    slot: 'A',
    agent: 'claude',
    label: 'Claude Code',
    role: '实现者',
    file: 'math.mjs',
    prompt: [
      'You are one member of a team, working inside the current directory.',
      'Task: create exactly one file named math.mjs.',
      'It must export two functions as ES module named exports:',
      '  add(a, b) -> returns a + b',
      '  mul(a, b) -> returns a * b',
      'Rules: ES module syntax (export function ...), no dependencies, no default export,',
      'no package.json, do not create any other file, do not run any command.',
      'When done, reply with one short line: DONE math.mjs',
    ].join('\n'),
  },
  {
    slot: 'B',
    agent: 'codex',
    label: 'Codex',
    role: '测试者',
    file: 'math.test.mjs',
    prompt: [
      'You are one member of a team, working inside the current directory.',
      'There is already a file math.mjs exporting add(a,b) and mul(a,b) as ES module named exports.',
      'Read it first.',
      'Task: create exactly one new file named math.test.mjs that uses node:test and node:assert/strict',
      'to test add(2,3) === 5, add(-1,1) === 0, mul(2,3) === 6, mul(0,5) === 0.',
      'Rules: import from ./math.mjs, no dependencies, do not modify math.mjs, do not run any command.',
      'When done, reply with one short line: DONE math.test.mjs',
    ].join('\n'),
  },
];

say('# 真项目验收记录：两个异构 Agent 合作写一个能跑的模块');
say();
say(`- 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${new Date().toISOString()}）`);
say(`- 机器：${process.platform} ${process.arch} · Node ${process.version}`);
say(`- 模式：${dry ? '**dry 演练**（假 Agent，只验流水线，不是验收证据）' : '真实 Agent（真起子进程）'}`);
say('- 协作层：`lib/engine/board.js`（真任务板）+ `lib/engine/cli.js`（真起子进程）');
say('- 判据：产物文件真实存在、能被 `import`、`node --test` 真跑通；不看 Agent 自己怎么说');
say();

const available = new Map();
for (const item of plan) {
  const found = dry ? `（dry 桩：${item.agent}）` : resolveCommand(item.agent);
  available.set(item.agent, Boolean(found));
  if (found) item.cmd = found;
}

say('## 0. 本机可用的厂商（不同厂商才算"异构"）');
say();
row(['席位', 'Agent', '角色', '可执行文件', '状态'], [4, 12, 8, 44, 12]);
row(['---', '---', '---', '---', '---'], [4, 12, 8, 44, 12]);
for (const item of plan) {
  row([item.slot, item.label, item.role, item.cmd || '（没装）', item.cmd ? '可用' : '环境未配'], [4, 12, 8, 44, 12]);
}
say();

const usable = plan.filter((p) => p.cmd);
if (usable.length < 2) {
  say(`**结论：跑不了这条验收** —— 只探到 ${usable.length} 个可协作 Agent（需要至少 2 个不同厂商）。`);
  say();
  say('装上任意两个（`claude` / `codex` / `dsh` / `gemini`）再跑一次；这不代表插件有问题。');
  if (!dry) {
    const out = join(process.cwd(), 'docs', 'evidence', `real-project-${stamp}.md`);
    mkdirSync(join(process.cwd(), 'docs', 'evidence'), { recursive: true });
    writeFileSync(out, `${lines.join('\n')}\n`);
    console.log(`\n证据：${out}`);
  }
  process.exit(2);
}

// ── 1. 建组 + 派活（真任务板） ─────────────────────────────────────────────
const workspace = mkdtempSync(join(tmpdir(), 'agentdeck-real-project-'));
say('## 1. 建组与派活（真任务板，不是演练）');
say();
say(`- 工作目录：\`${workspace}\`（干净临时目录，没有 git、没有 package.json）`);
say();

const board = createBoard({ root: join(workspace, '.board') });
const team = board.createTeam({ name: '真项目·数学模块', goal: '两个异构 Agent 合作产出一个带测试的 ES 模块' });
say(`- 团队 \`${team.id}\`：${team.name}`);
say();

const members = new Map();
for (const item of usable) {
  const member = board.addMember(team.id, { name: `${item.label}（${item.role}）`, kind: 'cli', role: item.role, agent: item.agent, cmd: item.cmd });
  members.set(item.agent, member);
  say(`- 成员 \`${member.id}\`：${member.name} → \`${item.cmd}\``);
}
say();

const tasks = new Map();
for (const item of usable) {
  const dep = item.agent === 'codex' ? tasks.get('claude') : null;
  const task = board.addTask(team.id, {
    title: `产出 ${item.file}`,
    context: item.prompt.split('\n')[0],
    assignee: members.get(item.agent).id,
    dependsOn: dep ? [dep.id] : [],
    acceptance: `文件 ${item.file} 存在且通过校验`,
  });
  tasks.set(item.agent, task);
  say(`- 任务 \`${task.id}\`：${task.title}${dep ? `（依赖 \`${dep.id}\` 完成后才轮到我）` : ''}`);
}
say();

// ── 2. 一轮一轮干：认领 → 执行 → 验收 → 完成 ─────────────────────────────
say('## 2. 逐棒执行（认领互斥 + 依赖门控 + 真起子进程）');
say();
row(['#', 'Agent', '认领', '耗时', '退出码', '自述结果', '产物'], [3, 12, 8, 9, 8, 34, 18]);
row(['---', '---', '---', '---', '---', '---', '---'], [3, 12, 8, 9, 8, 34, 18]);

const results = [];
for (const item of plan) {
  if (!usable.includes(item)) continue;
  const task = tasks.get(item.agent);
  const claimed = board.claimTask(team.id, task.id, members.get(item.agent).id);
  if (!claimed) {
    const why = '认领失败（被占或依赖没完成）';
    board.failTask(team.id, task.id, why);
    results.push({ item, ok: false, why });
    row([results.length, item.label, '失败', '-', '-', '认领失败', '-'], [3, 12, 8, 9, 8, 34, 18]);
    continue;
  }
  say();
  say(`> \`${task.id}\` 由 ${item.label} 认领，开始干活……`);
  let run;
  if (dry) {
    const t0 = Date.now();
    if (item.file === 'math.mjs') {
      writeFileSync(join(workspace, 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
    } else {
      writeFileSync(
        join(workspace, 'math.test.mjs'),
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, mul } from './math.mjs';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-1, 1), 0);\n});\n\ntest('mul', () => {\n  assert.equal(mul(2, 3), 6);\n  assert.equal(mul(0, 5), 0);\n});\n",
      );
    }
    run = { rc: 0, out: `DONE ${item.file}`, err: '', ms: Date.now() - t0 };
  } else {
    run = await runAgent(item.agent, item.prompt, { cwd: workspace, timeoutMs: 5 * 60 * 1000 });
  }
  const target = join(workspace, item.file);
  const produced = existsSync(target);
  const lastLine = (run.out || '').trim().split('\n').filter(Boolean).pop() || '';
  let ok = run.rc === 0 && produced;
  let why = '';
  if (run.rc !== 0) why = `退出码 ${run.rc}`;
  else if (!produced) why = '没产出文件';
  if (ok) {
    board.completeTask(team.id, task.id, { output: `${item.label} 产出 ${item.file}` });
  } else {
    board.failTask(team.id, task.id, why);
  }
  results.push({ item, ok, why, run, produced });
  row([results.length, item.label, '成功', `${(run.ms / 1000).toFixed(1)}s`, run.rc, lastLine.slice(0, 32) || '（无输出）', produced ? item.file : '缺失'], [3, 12, 8, 9, 8, 34, 18]);
}

// ── 3. 真验收：能不能 import、测试能不能跑过 ──────────────────────────────
say();
say('## 3. 真验收（这才是"做完了"的判据）');
say();

const checks = [];
function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    detail = String(fn() ?? '');
    ok = true;
  } catch (err) {
    detail = err.message;
  }
  checks.push({ name, ok, detail });
  say(`- ${ok ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`);
}

const mathPath = join(workspace, 'math.mjs');
const testPath = join(workspace, 'math.test.mjs');

check('math.mjs 存在且非空', () => {
  if (!existsSync(mathPath)) throw new Error('文件不存在');
  const size = readFileSync(mathPath, 'utf8').length;
  if (size < 20) throw new Error(`只有 ${size} 字节，像空壳`);
  return `${size} 字节`;
});

// 动态 import 是异步的，单独一段（check() 只管同步断言）
{
  const mod = await import(`file://${mathPath.replace(/\\/g, '/')}?v=${Date.now()}`);
  const okMath = typeof mod.add === 'function' && typeof mod.mul === 'function' && mod.add(2, 3) === 5 && mod.mul(2, 3) === 6;
  checks.push({ name: 'math.mjs 能被真 import 且 add/mul 算得对', ok: okMath, detail: okMath ? `add(2,3)=${mod.add(2, 3)}，mul(2,3)=${mod.mul(2, 3)}` : '导出或结果不对' });
  say(`- ${okMath ? '✅' : '❌'} math.mjs 能被真 import 且 add/mul 算得对${okMath ? `：add(2,3)=${mod.add(2, 3)}，mul(2,3)=${mod.mul(2, 3)}` : '：导出或结果不对'}`);
}

check('math.test.mjs 存在', () => {
  if (!existsSync(testPath)) throw new Error('文件不存在');
  return `${readFileSync(testPath, 'utf8').length} 字节`;
});
say('');

let testOk = false;
let testOut = '';
try {
  testOut = execFileSync(process.execPath, ['--test', 'math.test.mjs'], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
  testOk = /ℹ pass [1-9]/.test(testOut) && !/ℹ fail [1-9]/.test(testOut);
} catch (err) {
  testOut = String(err.stdout || '') + String(err.stdout ? '' : err.message);
  testOk = /ℹ pass [1-9]/.test(testOut) && !/ℹ fail [1-9]/.test(testOut);
}
const passLine = (testOut.match(/ℹ (pass|fail) \d+/g) || []).join(' / ');
checks.push({ name: 'node --test math.test.mjs 真跑通', ok: testOk, detail: passLine || '没解析到结果' });
say(`- ${testOk ? '✅' : '❌'} node --test math.test.mjs 真跑通：${passLine || '没解析到结果'}`);
say('');

// ── 4. 任务板事件流（可审计） ──────────────────────────────────────────────
const events = board.listEvents(team.id);
say('## 4. 任务板事件流（每一步都留痕，可审计）');
say();
row(['#', '事件', '对象', '说明'], [3, 14, 22, 46]);
row(['---', '---', '---', '---'], [3, 14, 22, 46]);
events.slice(0, 24).forEach((e, i) => row([i + 1, e.kind, String(e.taskId || e.memberId || ''), String(e.text || '')], [3, 14, 22, 46]));
say();
say(`共 ${events.length} 条事件。`);
say('');

// ── 5. 结论 ────────────────────────────────────────────────────────────────
const allRunsOk = results.every((r) => r.ok);
const allChecksOk = checks.every((c) => c.ok);
const passCount = checks.filter((c) => c.ok).length;
const totalMs = Date.now() - startedAt;

say('## 5. 结论');
say();
if (allRunsOk && allChecksOk) {
  say(`**通过**：${results.length} 个不同厂商的 Agent（${results.map((r) => r.item.label).join(' + ')}）经任务板分工，`);
  say(`${checks.length} 项验收全过，总耗时 ${(totalMs / 1000).toFixed(1)}s。产物在 \`${workspace}\`。`);
} else {
  say(`**未全通过**：执行 ${results.filter((r) => r.ok).length}/${results.length}，验收 ${passCount}/${checks.length}。`);
  for (const r of results.filter((x) => !x.ok)) say(`- ${r.item.label}：${r.why}`);
  for (const c of checks.filter((x) => !x.ok)) say(`- 验收「${c.name}」失败：${c.detail}`);
}
say();
if (clean) {
  rmSync(workspace, { recursive: true, force: true });
  say(`（已按 --clean 删掉产物目录）`);
} else {
  say('产物留着，可以直接看：');
  say();
  say('```');
  say(`${mathPath}`);
  say(`${testPath}`);
  say('```');
}

if (dry) {
  console.log('\n（dry 演练：不写 docs/evidence，免得把假 Agent 的结果当验收证据）');
  process.exit(allRunsOk && allChecksOk ? 0 : 1);
}

const evidencePath = join(process.cwd(), 'docs', 'evidence', `real-project-${stamp}.md`);
mkdirSync(join(process.cwd(), 'docs', 'evidence'), { recursive: true });
writeFileSync(evidencePath, `${lines.join('\n')}\n`);
console.log(`\n证据：${evidencePath}`);
process.exit(allRunsOk && allChecksOk ? 0 : 1);
