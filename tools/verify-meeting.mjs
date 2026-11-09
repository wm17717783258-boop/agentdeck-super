/**
 * tools/verify-meeting.mjs —— 三个 Agent 真开一场会，并真的落出任务
 *
 * 产品方案里"桌宠开会、自动落任务"要的不是一张示意图，而是：
 *   三个不同厂商的 Agent（claude / codex / dsh）各自独立进程、各自独立 DSH_HOME，
 *   各交一条意见 → 有分歧就摆到台面 → 投票 → 出决议 → 决议真的变成任务。
 *
 * 这里三个 Agent 是三个真的 node 进程，各自往同一个项目工作区的提案流水里
 * 追加自己那一条（就是"三台机器连到同一个项目"的形态）；
 * 开会/结会走的是**真的 deck_meeting 工具**，不是直接调底层函数——
 * 这样连"工具这一层有没有把参数接对"一起验了。
 *
 * 用法：node tools/verify-meeting.mjs
 * 证据：docs/evidence/meeting-3agent-<版本>.txt
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const REPO = resolve(join(HERE, '..', '..'));
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const OUT = join(REPO, 'docs', 'evidence', `meeting-3agent-${VERSION}.txt`);

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const check = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => lines.push(t);

const modUrl = (rel) => pathToFileURL(join(REPO, ...rel.split('/'))).href;

/** 让一个 Agent 在自己的进程 + 自己的 DSH_HOME 里干一件事。 */
function runAgent(label, dshHome, workdir, script) {
  const body = String(script)
    .split('__MEETING_MOD__').join(modUrl('lib/meeting/index.js'))
    .split('__TOOL_MOD__').join(modUrl('lib/meeting/tool.js'));
  const file = join(workdir, `.agent-${label}-${Date.now().toString(36)}.mjs`);
  writeFileSync(file, body, 'utf8');
  const res = spawnSync(process.execPath, [file], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: dshHome, AGENTDECK_HOME: dshHome, NEXI_MEETING_ROOT: workdir, NEXI_AGENT: label },
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
  });
  if (res.status !== 0) {
    bad(`${label} 进程退出码 ${res.status}`, String(res.stderr || '').trim().split('\n').slice(0, 2).join(' | ').slice(0, 300));
  }
  if (process.env.NEXI_VISIT_DEBUG === '1') {
    process.stderr.write(`[debug] ${label} stdout=${JSON.stringify(String(res.stdout || '').slice(0, 400))}\n[debug] stderr=${JSON.stringify(String(res.stderr || '').slice(0, 400))}\n`);
  }
  return { stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

function parseJson(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const tail = text.slice(i + marker.length);
  const end = tail.indexOf('\n@@END@@');
  try {
    return JSON.parse(end >= 0 ? tail.slice(0, end) : tail);
  } catch {
    return null;
  }
}

/** deck_meeting 工具是 async 的；把它包成"跑一次、把可读文本带回来"。 */
const TOOL_CALL = `
import { createMeetingTool } from '__TOOL_MOD__';
const root = process.env.NEXI_MEETING_ROOT;
const board = {
  calls: [],
  async listTeams() { return [{ id: 'team_pub', name: '发布组' }]; },
  async addTask(teamId, payload) { board.calls.push({ teamId, payload }); return { id: 'task_' + (board.calls.length + 100) }; },
};
const tool = createMeetingTool({ root: () => root, board, workspace: root });
`;

async function main() {
  say('三个 Agent 真开一场会并落出任务');
  say('='.repeat(64));
  say(`时间：${new Date().toISOString()}`);
  say('做法：claude / codex / dsh 三个 Agent 各跑一个独立 node 进程、各自独立 DSH_HOME，');
  say('      连到同一个项目工作区；意见真写进提案流水，开会/结会走真的 deck_meeting 工具。');
  say('');

  const base = mkdtempSync(join(tmpdir(), 'nexi-meeting-'));
  const root = join(base, 'shared-project');
  mkdirSync(root, { recursive: true });
  const homes = {
    claude: join(base, 'home-claude'),
    codex: join(base, 'home-codex'),
    dsh: join(base, 'home-dsh'),
  };
  for (const h of Object.values(homes)) mkdirSync(h, { recursive: true });

  try {
    /* ── 1. 开场：走真 deck_meeting 工具 ───────────────────────────── */
    say('【第 1 步】开场：议题 + 两条议程 + 三个参会 Agent（走真 deck_meeting 工具）');
    const openStep = runAgent('dsh-host', homes.dsh, root, `
      ${TOOL_CALL}
      const out = await tool.execute({ action: 'open',
        topic: '把发布流程自动化',
        goal: '产出一份能直接执行的任务清单',
        participants: [
          { name: 'claude', vendor: 'claude', capabilities: ['审查', '安全'] },
          { name: 'codex', vendor: 'codex', capabilities: ['写码', '重构'] },
          { name: 'dsh', vendor: 'dsh', capabilities: ['落地', '验收'] },
        ],
        agenda: [ { title: '谁来写发布脚本', kind: 'decision' }, { title: '回滚怎么办', kind: 'decision' } ],
      }, { logger: { info() {}, warn() {} } });
      const text = typeof out === 'string' ? out : out.text;
      // 会议号形如 mtg_20261106_a1b2c3 —— 下划线也要吃掉，别只抓到日期那一段
      const id = (text.match(/mtg_[0-9]{8}_[0-9a-f]+/) || [null])[0];
      process.stdout.write('@@OPEN@@' + JSON.stringify({ text: text.slice(0, 500), id }) + '\\n@@END@@');
    `);
    const opened = parseJson(openStep.stdout, '@OPEN@@');
    check(opened && /deck_meeting/.test(opened.text || ''), 'deck_meeting open 有回复', (opened?.text || '').slice(0, 120));
    const meetingId = opened?.id;
    check(Boolean(meetingId), '拿到了会议号', String(meetingId));
    if (!meetingId) throw new Error('没拿到会议号，后面没法继续');
    say(`     会议号：${meetingId}`);
    say('');

    /* ── 2. 三个 Agent 各自交意见 ─────────────────────────────────── */
    say('【第 2 步】三个 Agent 各自独立进程提交意见（真写进提案流水）');
    const proposals = [
      { agent: 'claude', stance: '补充', text: '发布脚本必须能在 CI 里跑，每一步都要有超时；密钥不许进仓库。' },
      { agent: 'codex', stance: '支持', text: '我来写脚本：一条命令跑完测试→打包→上传，失败自动回滚到上一个版本。' },
      { agent: 'dsh', stance: '支持', text: '我负责验收：拿一份真实发布的包跑一遍，把每步耗时和日志记进证据。' },
    ];
    for (const p of proposals) {
      const step = runAgent(p.agent, homes[p.agent], root, `
        import { submitProposal } from '__MEETING_MOD__';
        const r = submitProposal({
          root: process.env.NEXI_MEETING_ROOT,
          meetingId: ${JSON.stringify(meetingId)},
          from: process.env.NEXI_AGENT,
          vendor: process.env.NEXI_AGENT,
          stance: ${JSON.stringify(p.stance)},
          text: ${JSON.stringify(p.text)},
        });
        process.stdout.write('@@P@@' + JSON.stringify({ ok: r.ok, error: r.error || null }) + '\\n@@END@@');
      `);
      const got = parseJson(step.stdout, '@P@@');
      check(got && got.ok === true, `${p.agent} 的意见提交成功`, got?.error || '');
    }
    const proposalsFile = join(root, '.agentdeck', 'meetings', meetingId, 'proposals.jsonl');
    check(existsSync(proposalsFile), '提案流水文件真的落盘了');
    if (existsSync(proposalsFile)) {
      const rows = readFileSync(proposalsFile, 'utf8').split('\n').filter(Boolean);
      check(rows.length === 3, '流水里正好三条意见（三个 Agent 各一条）', `${rows.length} 条`);
      const vendors = rows.map((r) => JSON.parse(r).vendor).sort();
      check(JSON.stringify(vendors) === JSON.stringify(['claude', 'codex', 'dsh']),
        '三条意见来自三个不同厂商（不是同一个 Agent 自说自话）', vendors.join('、'));
    }
    say('');

    /* ── 3. 摆分歧 ───────────────────────────────────────────────── */
    say('【第 3 步】摆出真实分歧：回滚到哪一版，两边意见不一致');
    const conflictStep = runAgent('dsh-host', homes.dsh, root, `
      import { raiseConflict } from '__MEETING_MOD__';
      const r = raiseConflict({
        root: process.env.NEXI_MEETING_ROOT,
        meetingId: ${JSON.stringify(meetingId)},
        agendaId: 'ag_2',
        between: ['codex', 'claude'],
        summary: '回滚到上一版还是上一个 release tag：codex 要快，claude 要确定性',
        by: 'dsh',
      });
      process.stdout.write('@@C@@' + JSON.stringify({ ok: r.ok, error: r.error || null, id: r.conflict?.id || null }) + '\\n@@END@@');
    `);
    const conflict = parseJson(conflictStep.stdout, '@C@@');
    check(conflict && conflict.ok === true, '分歧被摆到台面上了', conflict?.error || '');
    const conflictId = conflict?.id || 'cf_1';
    say(`     冲突号：${conflictId}`);
    say('');

    /* ── 4. 投票 + 解分歧 ────────────────────────────────────────── */
    say('【第 4 步】三个 Agent 投票（2 赞成 / 1 反对），并把分歧裁定掉');
    for (const v of [
      { agent: 'claude', choice: '赞成' },
      { agent: 'codex', choice: '反对' },
      { agent: 'dsh', choice: '赞成' },
    ]) {
      const step = runAgent(v.agent, homes[v.agent], root, `
        import { castVote } from '__MEETING_MOD__';
        const r = castVote({
          root: process.env.NEXI_MEETING_ROOT,
          meetingId: ${JSON.stringify(meetingId)},
          agendaId: 'ag_2',
          agentId: process.env.NEXI_AGENT,
          choice: ${JSON.stringify(v.choice)},
        });
        process.stdout.write('@@V@@' + JSON.stringify({ ok: r.ok, error: r.error || null }) + '\\n@@END@@');
      `);
      const got = parseJson(step.stdout, '@V@@');
      check(got && got.ok === true, `${v.agent} 投了「${v.choice}」`, got?.error || '');
    }

    const tallyStep = runAgent('dsh-host', homes.dsh, root, `
      import { getMeeting, tallyVotes } from '__MEETING_MOD__';
      const got = getMeeting({ root: process.env.NEXI_MEETING_ROOT, meetingId: ${JSON.stringify(meetingId)} });
      const meta = got.meeting || got;
      const t = tallyVotes(meta?.votes || [], 'ag_2');
      process.stdout.write('@@T@@' + JSON.stringify({ ok: Boolean(meta), tally: t, votes: (meta?.votes || []).length }) + '\\n@@END@@');
    `);
    const tally = parseJson(tallyStep.stdout, '@T@@');
    check(tally && tally.votes === 3, '三张票都落盘了', `${tally?.votes} 张`);
    if (tally?.tally) {
      const t = tally.tally;
      const by = t.byChoice || {};
      check(by['赞成'] === 2 && by['反对'] === 1, '计票结果正确：2 赞成 / 1 反对', JSON.stringify(t).slice(0, 160));
      check(Array.isArray(t.voters) && t.voters.length === 3, '三位投票人都记了名', (t.voters || []).join('、'));
    }

    const resolveStep = runAgent('dsh-host', homes.dsh, root, `
      import { resolveConflict } from '__MEETING_MOD__';
      const r = resolveConflict({
        root: process.env.NEXI_MEETING_ROOT,
        meetingId: ${JSON.stringify(meetingId)},
        conflictId: ${JSON.stringify(conflictId)},
        resolution: '按 claude 的意见：回滚到上一个 release tag，多花 40 秒换确定性',
        by: 'dsh',
      });
      process.stdout.write('@@R@@' + JSON.stringify({ ok: r.ok, error: r.error || null }) + '\\n@@END@@');
    `);
    const resolved = parseJson(resolveStep.stdout, '@R@@');
    check(resolved && resolved.ok === true, '分歧已裁定（写了怎么了的，不是只改状态）', resolved?.error || '');
    say('');

    /* ── 5. 逐项了结议程（治理闸门要求：有议程没结论就不许结会） ──── */
    say('【第 5 步】逐项了结议程 —— 这一步是治理闸门逼出来的：');
    say('        先故意在"议程没结论"时结会一次，看它是否真会拦住；再逐项补上结论。');

    // 5a. 反例：议程没了结时结会，必须被拦住
    const prematureStep = runAgent('dsh-host', homes.dsh, root, `
      ${TOOL_CALL}
      const out = await tool.execute({
        action: 'conclude',
        meetingId: ${JSON.stringify(meetingId)},
        decidedBy: 'dsh',
        rationale: '想早点收工',
        decision: '直接结束',
        teamId: 'team_pub',
        tasks: [{ title: '不该出现的任务', role: 'worker' }],
      }, { logger: { info() {}, warn() {} } });
      const text = typeof out === 'string' ? out : out.text;
      process.stdout.write('@@PRE@@' + JSON.stringify({ text: text.slice(0, 400), boardCalls: board.calls.length }) + '\\n@@END@@');
    `);
    const pre = parseJson(prematureStep.stdout, '@PRE@@');
    check(pre && /还有 2 项议程没结论/.test(pre.text || ''), '议程没结论时结会被拦住（治理闸门真生效）',
      (pre?.text || '').slice(0, 100));
    check(pre && pre.boardCalls === 0, '被拦住时一条任务都没落（没有半成品副作用）', `任务板调用 ${pre?.boardCalls} 次`);

    // 5b. 逐项写结论
    for (const item of [
      { id: 'ag_1', conclusion: 'codex 写脚本，claude 出安全约束清单，dsh 验收' },
      { id: 'ag_2', conclusion: '回滚到上一个 release tag（投票 2:1 通过）' },
    ]) {
      const step = runAgent('dsh-host', homes.dsh, root, `
        import { resolveAgendaItem } from '__MEETING_MOD__';
        const r = resolveAgendaItem({
          root: process.env.NEXI_MEETING_ROOT,
          meetingId: ${JSON.stringify(meetingId)},
          agendaId: ${JSON.stringify(item.id)},
          conclusion: ${JSON.stringify(item.conclusion)},
          by: 'dsh',
        });
        process.stdout.write('@@AG@@' + JSON.stringify({ ok: r.ok, error: r.error || null, id: ${JSON.stringify(item.id)} }) + '\\n@@END@@');
      `);
      const got = parseJson(step.stdout, '@AG@@');
      check(got && got.ok === true, `议程 ${item.id} 已写出结论`, got?.error || '');
    }
    say('');

    /* ── 6. 结会 + 落任务：走真 deck_meeting 工具 ─────────────────── */
    say('【第 6 步】结会：出决议，并把决议真的变成任务（走真 deck_meeting 工具）');
    const concludeStep = runAgent('dsh-host', homes.dsh, root, `
      ${TOOL_CALL}
      const out = await tool.execute({
        action: 'conclude',
        meetingId: ${JSON.stringify(meetingId)},
        decidedBy: 'dsh',
        rationale: '三人意见已收敛：脚本由 codex 写，安全约束按 claude，验收由 dsh 做',
        decision: '按 claude 的安全约束 + codex 的脚本方案执行',
        teamId: 'team_pub',
        conflictsResolved: [${JSON.stringify(conflictId)}],
        tasks: [
          { title: '写发布脚本（含超时与密钥隔离）', role: 'worker', acceptance: '一条命令跑完测试→打包→上传' },
          { title: '做一次真机发布演练', role: 'tester', acceptance: '拿真实发布包跑通并留下日志' },
        ],
      }, { logger: { info() {}, warn() {} } });
      const text = typeof out === 'string' ? out : out.text;
      process.stdout.write('@@K@@' + JSON.stringify({ text: text.slice(0, 900), boardCalls: board.calls.map((c) => c.payload.title) }) + '\\n@@END@@');
    `);
    const concluded = parseJson(concludeStep.stdout, '@K@@');
    check(concluded && /结会了/.test(concluded.text || ''), '结会成功', (concluded?.text || '').slice(0, 140));
    check(concluded && (concluded.boardCalls || []).length === 2, '决议真的变成了 2 条任务（任务板被调用 2 次）',
      (concluded?.boardCalls || []).join('、'));
    check(concluded && (concluded.boardCalls || []).includes('写发布脚本（含超时与密钥隔离）'), '任务标题来自决议');
    check(concluded && /拍板：dsh/.test(concluded.text || ''), '决议记了是谁拍的板');
    check(concluded && /了结的冲突/.test(concluded.text || ''), '结会时把已了结的冲突列了出来');
    say('');

    /* ── 7. 落盘复核：不信内存里的返回值 ─────────────────────────── */
    say('【第 7 步】重新读回会议目录，逐项对账（不信内存里的返回值）');
    const dir = join(root, '.agentdeck', 'meetings', meetingId);
    const metaFile = join(dir, 'meta.json');
    check(existsSync(metaFile), 'meta.json 真的在盘上');
    if (existsSync(metaFile)) {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      check(meta.topic === '把发布流程自动化', '议题存对了', meta.topic);
      check(meta.participants.length === 3, '参会人存对了', `${meta.participants.length} 人`);
      check(meta.status === 'concluded', '状态存对了', meta.status);
      check(meta.conflicts.length === 1 && meta.conflicts[0].status === 'resolved', '分歧及其裁定都存对了');
      check(meta.votes.length === 3, '三张票存对了', `${meta.votes.length} 张`);
      check(meta.decision && meta.decision.decidedBy === 'dsh', '决议记录结构完整');
      check((meta.tasks || []).length === 2, '两条任务记在会议里', `${(meta.tasks || []).length} 条`);
      check((meta.tasks || []).every((t) => t.taskId), '每条任务都拿到了任务板返回的 id',
        (meta.tasks || []).map((t) => t.taskId).join('、'));
      check(meta.concludedAt && !Number.isNaN(Date.parse(meta.concludedAt)), '结会时间落盘');
    }
    check(existsSync(join(dir, 'minutes.md')), '会议纪要文件真的写出来了');
    if (existsSync(join(dir, 'minutes.md'))) {
      const minutes = readFileSync(join(dir, 'minutes.md'), 'utf8');
      check(minutes.includes('把发布流程自动化'), '纪要里有议题');
      check(minutes.includes('写发布脚本'), '纪要里有落出的任务');
      check(minutes.includes('claude') && minutes.includes('codex') && minutes.includes('dsh'), '纪要里有三个 Agent 的名字');
    }
    say('');

    /* ── 8. 三台机器确实互不相干 ─────────────────────────────────── */
    say('【第 8 步】确认三个 Agent 真的是三套环境');
    check(homes.claude !== homes.codex && homes.codex !== homes.dsh, '三个 DSH_HOME 两两不同');
    const rows = readFileSync(proposalsFile, 'utf8').split('\n').filter(Boolean);
    check(rows.length === 3, '三个 Agent 各写各的一条，没有互相覆盖', `${rows.length} 条`);
    say('');

    say('='.repeat(64));
    say(`结论：${pass} 项通过，${fail} 项失败`);
    say('');
    say('边界（照写）：');
    say('  · 三个 Agent 是三个真进程、三份独立环境；但它们的"意见"是本脚本写死的，');
    say('    不是三个大模型真的在辩论——要真模型辩论得接 API key，那是另一件事，这里不冒充。');
    say('  · 会议数据落在共享工作区（同一个项目目录），形态是"多台机器连同一个项目"，');
    say('    不是云端多人实时会议。');
  } finally {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch { /* 临时目录 */ }
  }

  const text = `${lines.join('\n')}\n`;
  mkdirSync(join(REPO, 'docs', 'evidence'), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  process.stdout.write(text);
  process.stdout.write(`\n证据已写入：${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`取证脚本自己崩了：${err?.stack || err}\n`);
  process.exitCode = 1;
});
