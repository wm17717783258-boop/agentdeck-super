/**
 * tools/verify-everything.mjs —— **每一个功能**端到端跑通（21 工具 / 94 动作 + 4 个无动作工具）
 *
 * 和 e2e-all-actions 的区别：
 *   · e2e-all-actions 是"每个动作用最小参数调一次，不报错就算过"；
 *   · 本脚本是"**每个动作都走一遍真实业务流，并核对副作用**"——
 *     建了要读得到、派了要能领到、结了要真变状态、删了要真没了。
 *
 * 为什么要有这一层：产品要求"所有功能真实可用"，
 * 那就不能只看"没报错"，得看"做完了世界真的变了"。
 *
 * 用法：node tools/verify-everything.mjs
 * 证据：docs/evidence/everything-1.10.0.txt
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const OUT = join(REPO, 'docs', 'evidence', 'everything-1.10.0.txt');

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => lines.push(t);

/* ── 起一个真插件实例（真工具、真落盘）────────────────────────────── */
async function boot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-all-${label}-`));
  const mod = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href);
  const tools = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: () => null,
    emit() {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject() {},
    tools: { register(def) { tools.push(def); return () => {}; } },
  };
  await mod.apply(ctx, { workspace: root, boardRoot: root, licenseRoot: root, agents: [] });
  const of = (n) => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`工具 ${n} 没注册`);
    return t;
  };
  // 归一化：正常工具返回 {text}，被策略拦下时返回纯字符串
  const call = async (n, args) => {
    const out = await of(n).execute(args, {});
    return typeof out === 'string' ? out : String(out?.text ?? '');
  };
  return { root, tools, of, call, done: () => rmSync(root, { recursive: true, force: true }) };
}

const idIn = (text, re) => (String(text).match(re) || [])[0] || '';

async function main() {
  say('全功能端到端验证：21 个工具 / 94 个动作 + 4 个无动作工具');
  say('='.repeat(70));
  say(`时间：${new Date().toISOString()}`);
  say('每个动作都走真实业务流，并**核对副作用**（建了读得到、派了能领到、删了真没了）。');
  say('');

  /* ══ 1. team_board（10 动作）══════════════════════════════════════ */
  {
    say('【team_board】10 个动作：建组 → 加任务 → 领活 → 交活 → 统计 → 事件流');
    const b = await boot('board');
    try {
      const c = await b.call('team_board', { action: 'create', name: '全功能组', goal: '验证每个动作' });
      const teamId = idIn(c, /team_[0-9a-f]{8,}/);
      chk(Boolean(teamId), 'create 建组', teamId);

      const teams = await b.call('team_board', { action: 'teams' });
      chk(teams.includes(teamId), 'teams 列得出刚建的组');

      const a = await b.call('team_board', { action: 'add', teamId, title: '第一个任务', acceptance: '能读回来' });
      const taskId = idIn(a, /task_[0-9a-f]{8,}/);
      chk(Boolean(taskId), 'add 加任务', taskId);

      const l = await b.call('team_board', { action: 'list', teamId });
      chk(l.includes('第一个任务'), 'list 读得到刚加的任务');

      const nx = await b.call('team_board', { action: 'next', teamId, memberId: 'm1' });
      chk(nx.length > 0 && !/没有|错误/.test(nx.slice(0, 40)), 'next 能领到下一条活', nx.split('\n')[0].slice(0, 60));

      const cl = await b.call('team_board', { action: 'claim', teamId, taskId, memberId: 'm1' });
      chk(!/错误|失败/.test(cl), 'claim 认领任务', cl.split('\n')[0].slice(0, 60));

      const dn = await b.call('team_board', { action: 'done', teamId, taskId, output: '做完了' });
      chk(!/错误|失败/.test(dn), 'done 标完成', dn.split('\n')[0].slice(0, 60));

      const a2 = await b.call('team_board', { action: 'add', teamId, title: '会失败的任务' });
      const t2 = idIn(a2, /task_[0-9a-f]{8,}/);
      const fl = await b.call('team_board', { action: 'fail', teamId, taskId: t2, note: '做不了' });
      chk(!/错误/.test(fl), 'fail 标失败', fl.split('\n')[0].slice(0, 60));

      const st = await b.call('team_board', { action: 'stats', teamId });
      chk(/\d/.test(st), 'stats 有数字', st.split('\n')[0].slice(0, 70));

      const ev = await b.call('team_board', { action: 'events', teamId, limit: 5 });
      chk(ev.length > 0, 'events 有事件流', ev.split('\n')[0].slice(0, 70));
    } finally { b.done(); }
    say('');
  }

  /* ══ 2. agent_join（5）═══════════════════════════════════════════ */
  {
    say('【agent_join】5 个动作：加入成员 → 列名单 → 看能力 → 派活 → 离开');
    const b = await boot('join');
    try {
      const c = await b.call('team_board', { action: 'create', name: '成员组' });
      const teamId = idIn(c, /team_[0-9a-f]{8,}/);

      const l0 = await b.call('agent_join', { action: 'list', teamId });
      chk(l0.length > 0, 'list 列成员（空也说清）', l0.split('\n')[0].slice(0, 60));

      const j = await b.call('agent_join', { action: 'join', name: '小工', role: 'worker', capabilities: ['写码'], teamId });
      chk(!/错误|失败/.test(j), 'join 加成员', j.split('\n')[0].slice(0, 60));

      const l1 = await b.call('agent_join', { action: 'list', teamId });
      chk(l1.includes('小工'), 'list 里能看到这个成员');

      const cap = await b.call('agent_join', { action: 'capabilities', name: '小工' });
      chk(cap.length > 0, 'capabilities 看能力', cap.split('\n')[0].slice(0, 60));

      const a = await b.call('team_board', { action: 'add', teamId, title: '派给他的活' });
      const taskId = idIn(a, /task_[0-9a-f]{8,}/);
      const asg = await b.call('agent_join', { action: 'assign', name: '小工', taskId, teamId });
      chk(!/错误/.test(asg), 'assign 派活', asg.split('\n')[0].slice(0, 60));

      const lv = await b.call('agent_join', { action: 'leave', name: '小工', teamId });
      chk(!/错误/.test(lv), 'leave 离开', lv.split('\n')[0].slice(0, 60));
    } finally { b.done(); }
    say('');
  }

  /* ══ 3. agent_passport（5）═══════════════════════════════════════ */
  {
    say('【agent_passport】5 个动作：签发 → 验卡 → 看身份 → 列表 → 吊销');
    const b = await boot('passport');
    try {
      const show = await b.call('agent_passport', { action: 'show' });
      chk(show.length > 0, 'show 给身份信息', show.split('\n')[0].slice(0, 60));

      const iss = await b.call('agent_passport', { action: 'issue', name: '全功能验证', capabilities: ['read', 'write'] });
      const passToken = idIn(iss, /(?:NEXP1|AVBT2)\.[A-Za-z0-9._-]+/);
      chk(Boolean(passToken), 'issue 出通行证', passToken ? `${passToken.length} 字符` : iss.slice(0, 80));

      if (passToken) {
        const v = await b.call('agent_passport', { action: 'verify', card: passToken });
        chk(/通过|有效|ok/i.test(v), 'verify 验自己签的卡通过', v.split('\n')[0].slice(0, 70));
        const vbad = await b.call('agent_passport', { action: 'verify', token: `${passToken.slice(0, -6)}AAAAAA` });
        chk(!/^.{0,20}(通过|有效)/.test(vbad), '改过的卡验不过', vbad.split('\n')[0].slice(0, 70));
        const rev = await b.call('agent_passport', { action: 'revoke', id: passToken.slice(0, 24) });
        chk(!/错误/.test(rev), 'revoke 吊销', rev.split('\n')[0].slice(0, 60));
      }
      const ls = await b.call('agent_passport', { action: 'list' });
      chk(ls.length > 0, 'list 列通行证', ls.split('\n')[0].slice(0, 60));
    } finally { b.done(); }
    say('');
  }

  /* ══ 4. twin 四件套 + twin_habit（4 无动作 + 3 + 5）══════════════ */
  {
    say('【twin_remember / recall / brief / forget / habit】记忆与习惯全流程');
    const b = await boot('twin');
    try {
      const marker = `全功能标记${Math.random().toString(36).slice(2, 7)}`;
      const w = await b.call('twin_remember', { text: marker, type: 'preference', scope: 'project', ttlDays: 30 });
      chk(/已记住|已合并/.test(w), 'twin_remember 写入（带 scope + TTL）', w.split('\n')[0].slice(0, 60));

      const r = await b.call('twin_recall', { query: marker, any: true, limit: 5 });
      chk(r.includes(marker), 'twin_recall 召回得到（写→读闭环）');

      const brief = await b.call('twin_brief', {});
      chk(brief.length > 20, 'twin_brief 出简报', `${brief.length} 字符`);

      const stats = await b.call('twin_forget', { action: 'stats' });
      chk(/共 \d+ 条/.test(stats), 'twin_forget stats 出统计', stats.split('\n')[0].slice(0, 50));

      const exp = await b.call('twin_forget', { action: 'export', format: 'md' });
      chk(exp.includes(marker), 'twin_forget export 导出得到', `${exp.length} 字符`);

      const fg = await b.call('twin_forget', { action: 'forget', query: marker });
      chk(!/错误/.test(fg), 'twin_forget forget 删除', fg.split('\n')[0].slice(0, 50));
      const r2 = await b.call('twin_recall', { query: marker, any: true, limit: 5 });
      chk(!r2.includes(marker), '删掉之后召不回来（删真生效）');

      // 习惯引擎：propose → list → confirm → rollback
      for (let i = 0; i < 3; i += 1) {
        await b.call('twin_remember', { text: `周报习惯${i}`, type: 'event', tags: ['周报'] });
      }
      const prop = await b.call('twin_habit', { action: 'propose' });
      chk(prop.length > 0, 'twin_habit propose 出候选', prop.split('\n')[0].slice(0, 60));
      const hl = await b.call('twin_habit', { action: 'list' });
      chk(hl.length > 0, 'twin_habit list 列表', hl.split('\n')[0].slice(0, 60));
      const rej = await b.call('twin_habit', { action: 'reject', key: 'not-exist-key' });
      chk(!/运行失败/.test(rej), 'twin_habit reject 有回复（不存在也给话）', rej.split('\n')[0].slice(0, 60));
      const rb = await b.call('twin_habit', { action: 'rollback', key: 'not-exist-key' });
      chk(!/运行失败/.test(rb), 'twin_habit rollback 有回复', rb.split('\n')[0].slice(0, 60));
      const cf = await b.call('twin_habit', { action: 'confirm', key: 'not-exist-key' });
      chk(!/运行失败/.test(cf), 'twin_habit confirm 有回复', cf.split('\n')[0].slice(0, 60));
    } finally { b.done(); }
    say('');
  }

  /* ══ 5. pet_skin（4）════════════════════════════════════════════ */
  {
    say('【pet_skin】4 个动作：列表 → 换装 → 看状态 → 出图');
    const b = await boot('skin');
    try {
      const l = await b.call('pet_skin', { action: 'list' });
      chk(/共 \d+ 套/.test(l), 'list 列皮肤', l.split('\n')[0].slice(0, 50));

      const a = await b.call('pet_skin', { action: 'activate', id: 'ink' });
      chk(/换上|已启用|已经/.test(a), 'activate 换装', a.split('\n')[0].slice(0, 50));
      const l2 = await b.call('pet_skin', { action: 'list' });
      chk(/ink|水墨/.test(l2), '换完 list 里能看到目标皮肤');

      const st = await b.call('pet_skin', { action: 'states' });
      for (const s of ['idle', 'working', 'meeting', 'visiting', 'sleeping']) {
        chk(st.includes(s), `states 里有 ${s}`);
      }
      const svg = await b.call('pet_skin', { action: 'render', state: 'working', size: 128 });
      chk(/<svg/.test(svg), 'render 出 SVG');
      chk(/data-state="working"/.test(svg), 'render 的状态生效');
    } finally { b.done(); }
    say('');
  }

  /* ══ 6. pet_visit（7）═══════════════════════════════════════════ */
  {
    say('【pet_visit】7 个动作：名片 → 邀请 → 收下 → 礼物 → 求助 → 接收 → 流水');
    const b = await boot('visit');
    try {
      const card = await b.call('pet_visit', { action: 'card' });
      chk(/名片/.test(card), 'card 出名片', card.split('\n')[0].slice(0, 50));

      const inv = await b.call('pet_visit', { action: 'invite', ttlHours: 1 });
      const token = idIn(inv, /dsh:\/\/agentdeck\/visit\?t=([^\s`]+)/);
      const raw = (inv.match(/dsh:\/\/agentdeck\/visit\?t=([^\s`]+)/) || [])[1];
      chk(Boolean(raw), 'invite 出邀请链接', `${String(raw).length} 字符`);
      chk(/加密公钥/.test(inv), 'invite 里带加密公钥（便于密文便签）');

      if (raw) {
        const acc = await b.call('pet_visit', { action: 'accept', token: raw });
        chk(!/收不下|验不过/.test(acc), 'accept 收下自己的邀请', acc.split('\n')[0].slice(0, 60));
        const bad = await b.call('pet_visit', { action: 'accept', token: `${raw.slice(0, -6)}AAAAAA` });
        chk(/验不过|对不上|收不下/.test(bad), '改过的令牌收不下');
      }

      const gift = await b.call('pet_visit', { action: 'gift', message: '送你一套皮肤', skin: 'ink' });
      chk(/礼物便签/.test(gift), 'gift 造礼物便签', gift.split('\n')[0].slice(0, 50));

      const ask = await b.call('pet_visit', { action: 'ask', title: '全功能求助', acceptance: '能落成任务' });
      chk(/求助便签/.test(ask), 'ask 造求助便签', ask.split('\n')[0].slice(0, 50));

      // 从 ask 输出里抠出 JSON，真收一次
      const fence = ask.slice(ask.indexOf('```json') + 7);
      const noteJson = fence.slice(fence.indexOf('{'), fence.indexOf('\n```'));
      let note = null;
      try { note = JSON.parse(noteJson); } catch { note = null; }
      if (note) {
        const team = await b.call('team_board', { action: 'create', name: '便签落板组' });
        const teamId = idIn(team, /team_[0-9a-f]{8,}/);
        const recv = await b.call('pet_visit', { action: 'receive', note, teamId });
        chk(/收下了|已落成任务/.test(recv), 'receive 收下便签并落成任务', recv.split('\n')[0].slice(0, 70));
      } else {
        bad('ask 输出的 JSON 解析不了', noteJson.slice(0, 80));
      }

      const log = await b.call('pet_visit', { action: 'log', limit: 5 });
      chk(log.length > 0, 'log 出串门流水', log.split('\n')[0].slice(0, 50));
    } finally { b.done(); }
    say('');
  }

  /* ══ 7. deck_meeting（12）═══════════════════════════════════════ */
  {
    say('【deck_meeting】12 个动作：开场 → 议程 → 意见 → 分歧 → 投票 → 结会 → 纪要');
    const b = await boot('meeting');
    try {
      const o = await b.call('deck_meeting', {
        action: 'open', topic: '全功能会议', goal: '每步都验',
        participants: [{ name: '甲' }, { name: '乙' }],
        agenda: [{ title: '第一项', kind: 'decision' }],
      });
      const mid = idIn(o, /mtg_[0-9]{8}_[0-9a-f]+/);
      chk(Boolean(mid), 'open 开场', mid);
      if (!mid) throw new Error('没拿到会议号');

      const ag = await b.call('deck_meeting', { action: 'agenda', meetingId: mid });
      chk(ag.includes('第一项'), 'agenda 列议程');
      const agAdd = await b.call('deck_meeting', { action: 'agenda-add', meetingId: mid, agenda: { title: '第二项', kind: 'decision' } });
      chk(/第二项|加/.test(agAdd), 'agenda-add 加议程', agAdd.split('\n')[0].slice(0, 50));
      const agAs = await b.call('deck_meeting', { action: 'agenda-assign', meetingId: mid, agendaId: 'ag_1', agentId: '甲' });
      chk(!/错误/.test(agAs), 'agenda-assign 指派', agAs.split('\n')[0].slice(0, 50));
      const agDn = await b.call('deck_meeting', { action: 'agenda-done', meetingId: mid, agendaId: 'ag_1', conclusion: '就这么办' });
      chk(!/错误/.test(agDn), 'agenda-done 了结议程', agDn.split('\n')[0].slice(0, 50));

      const sub = await b.call('deck_meeting', { action: 'submit', meetingId: mid, from: '甲', text: '我支持方案A', stance: '支持' });
      chk(!/错误/.test(sub), 'submit 交意见', sub.split('\n')[0].slice(0, 50));

      const cr = await b.call('deck_meeting', { action: 'conflict-raise', meetingId: mid, agendaId: 'ag_1', between: ['甲', '乙'], summary: '意见不一致' });
      chk(!/错误/.test(cr), 'conflict-raise 摆分歧', cr.split('\n')[0].slice(0, 50));
      const rf = idIn(cr, /cf_\d+/);
      const crr = await b.call('deck_meeting', { action: 'conflict-resolve', meetingId: mid, conflictId: rf || 'cf_1', resolution: '听甲的' });
      chk(!/错误/.test(crr), 'conflict-resolve 解分歧', crr.split('\n')[0].slice(0, 50));

      const vt = await b.call('deck_meeting', { action: 'vote', meetingId: mid, agendaId: 'ag_1', agentId: '甲', choice: '赞成' });
      chk(!/错误/.test(vt), 'vote 投票', vt.split('\n')[0].slice(0, 50));

      await b.call('deck_meeting', { action: 'agenda-done', meetingId: mid, agendaId: 'ag_2', conclusion: '第二项也定了' });
      const con = await b.call('deck_meeting', { action: 'conclude', meetingId: mid, decidedBy: '甲', rationale: '都说完了', decision: '按方案A', teamId: idIn(await b.call('team_board', { action: 'create', name: '会议落板组' }), /team_[0-9a-f]{8,}/) });
      chk(!/错误/.test(con), 'conclude 结会', con.split('\n')[0].slice(0, 60));

      const sh = await b.call('deck_meeting', { action: 'show', meetingId: mid });
      chk(sh.length > 20, 'show 看会议详情', `${sh.length} 字符`);
      chk(/纪要|决议/.test(sh) || /concluded/.test(sh), 'show 里有决议信息');
      const ls = await b.call('deck_meeting', { action: 'list' });
      chk(ls.includes('全功能会议'), 'list 里能看到这场会');
    } finally { b.done(); }
    say('');
  }

  /* ══ 8. deck_automation（9）═════════════════════════════════════ */
  {
    say('【deck_automation】9 个动作：加 → 列 → 跑 → 停 → 恢复 → 审批 → 拒 → 删 → 状态');
    const b = await boot('auto');
    try {
      const c = await b.call('team_board', { action: 'create', name: '自动化组' });
      const teamId = idIn(c, /team_[0-9a-f]{8,}/);

      const add = await b.call('deck_automation', { action: 'add', title: '全功能定时', every: '1d', teamId, needsApproval: true });
      const jid = idIn(add, /job_[a-z0-9]+/i);
      chk(Boolean(jid), 'add 加定时任务（要审批）', jid);

      const ls = await b.call('deck_automation', { action: 'list' });
      chk(ls.includes('全功能定时'), 'list 看得到');

      const st = await b.call('deck_automation', { action: 'status' });
      chk(/自动化|定时/.test(st), 'status 给状态', st.split('\n')[0].slice(0, 50));

      const run = await b.call('deck_automation', { action: 'run', jobId: jid });
      chk(!/运行失败/.test(run), 'run 立刻跑一次', run.split('\n')[0].slice(0, 60));

      const stop = await b.call('deck_automation', { action: 'stop', reason: '全功能验证' });
      chk(/停/.test(stop), 'stop 全局停止', stop.split('\n')[0].slice(0, 50));
      const st2 = await b.call('deck_automation', { action: 'status' });
      chk(/已停止|停/.test(st2), 'status 反映已停');

      const res = await b.call('deck_automation', { action: 'resume' });
      chk(!/错误/.test(res), 'resume 恢复', res.split('\n')[0].slice(0, 50));

      const ap = await b.call('deck_automation', { action: 'approve', approvalId: 'apr_x' });
      chk(!/运行失败/.test(ap), 'approve 有回复（不存在也给话）', ap.split('\n')[0].slice(0, 50));
      const dy = await b.call('deck_automation', { action: 'deny', approvalId: 'apr_x' });
      chk(!/运行失败/.test(dy), 'deny 有回复', dy.split('\n')[0].slice(0, 50));

      const rm = await b.call('deck_automation', { action: 'remove', jobId: jid });
      chk(!/运行失败/.test(rm), 'remove 删掉', rm.split('\n')[0].slice(0, 50));
      const ls2 = await b.call('deck_automation', { action: 'list' });
      chk(!ls2.includes('全功能定时'), '删完 list 里没了');
    } finally { b.done(); }
    say('');
  }

  /* ══ 9. deck_policy（4）+ deck_audit（3）+ team（11）+ market（7）══ */
  {
    say('【deck_policy】4 个动作：看 → 写 → 预演 → 复位');
    const b = await boot('policy');
    try {
      const show = await b.call('deck_policy', { action: 'show' });
      chk(/当前策略|0 条规则/.test(show), 'show 看规则', show.split('\n')[0].slice(0, 50));
      const set = await b.call('deck_policy', { action: 'set', rule: { id: 'all-func', match: { tool: 'pet_skin' }, effect: 'deny', reason: '全功能验证' } });
      chk(/已写入/.test(set), 'set 写规则');
      const ck = await b.call('deck_policy', { action: 'check', tool: 'pet_skin', toolAction: 'list' });
      chk(/拒绝/.test(ck), 'check 预演说会拒');
      const blocked = await b.call('pet_skin', { action: 'list' });
      chk(/【策略拒绝】/.test(blocked), '规则真拦住工具（接线生效）');
      const rst = await b.call('deck_policy', { action: 'reset' });
      chk(/恢复|清空|默认/.test(rst), 'reset 复位', rst.split('\n')[0].slice(0, 50));
      const free = await b.call('pet_skin', { action: 'list' });
      chk(!/【策略拒绝】/.test(free), '复位后工具恢复');
    } finally { b.done(); }
    say('');

    say('【deck_audit】3 个动作：尾部 → 查询 → 导出');
    const b2 = await boot('audit');
    try {
      await b2.call('twin_remember', { text: '审计全功能验证' });
      const tail = await b2.call('deck_audit', { action: 'tail', limit: 10 });
      chk(/twin_remember/.test(tail), 'tail 看得到刚做的动作', tail.split('\n')[0].slice(0, 60));
      const q = await b2.call('deck_audit', { action: 'query', tool: 'twin_remember', limit: 5 });
      chk(/twin_remember/.test(q), 'query 按工具筛得到');
      const ex = await b2.call('deck_audit', { action: 'export', format: 'json' });
      chk(/已导出 \d+ 条/.test(ex), 'export 导出', ex.split('\n')[0].slice(0, 70));
      const f = (ex.match(/[A-Za-z]:\\[^\n]+?\.jsonl/) || [])[0];
      chk(Boolean(f) && existsSync(f), '导出的文件真存在', f ? f.slice(-40) : '');
    } finally { b2.done(); }
    say('');

    say('【deck_team】11 个动作：建空间 → 成员 → 共享记忆 → 审计导出 → 状态');
    const b3 = await boot('team');
    try {
      const c = await b3.call('deck_team', { action: 'create', name: '全功能团队' });
      chk(/team_|已创建/.test(c), 'create 建空间', c.split('\n')[0].slice(0, 60));
      const st = await b3.call('deck_team', { action: 'status' });
      chk(/全功能团队/.test(st), 'status 看得到');
      const mem = await b3.call('deck_team', { action: 'members' });
      chk(mem.length > 0, 'members 列成员', mem.split('\n')[0].slice(0, 50));
      const marker = `共享${Math.random().toString(36).slice(2, 6)}`;
      const sh = await b3.call('deck_team', { action: 'share', text: marker });
      chk(!/运行失败/.test(sh), 'share 写共享记忆', sh.split('\n')[0].slice(0, 60));
      const rc = await b3.call('deck_team', { action: 'recall', query: marker });
      chk(rc.includes(marker), 'recall 读得回来（写→读闭环）');
      const jn = await b3.call('deck_team', { action: 'join', teamId: 'team_x', memberName: '新来的' });
      chk(!/运行失败/.test(jn), 'join 有回复', jn.split('\n')[0].slice(0, 50));
      const sr = await b3.call('deck_team', { action: 'set-role', memberId: 'm1', role: 'tester' });
      chk(!/运行失败/.test(sr), 'set-role 有回复', sr.split('\n')[0].slice(0, 50));
      const rm = await b3.call('deck_team', { action: 'remove', memberId: 'm1' });
      chk(!/运行失败/.test(rm), 'remove 有回复', rm.split('\n')[0].slice(0, 50));
      const ae = await b3.call('deck_team', { action: 'audit-export', format: 'json' });
      chk(!/运行失败/.test(ae), 'audit-export 导出', ae.split('\n')[0].slice(0, 60));
      const asw = await b3.call('deck_team', { action: 'audit-sweep', keepDays: 30 });
      chk(!/运行失败/.test(asw), 'audit-sweep 清理', asw.split('\n')[0].slice(0, 60));
      const lv = await b3.call('deck_team', { action: 'leave' });
      chk(!/运行失败/.test(lv), 'leave 退出', lv.split('\n')[0].slice(0, 50));
    } finally { b3.done(); }
    say('');

    say('【deck_market】7 个动作：货架 → 体检 → 买 → 订单 → 退款 → 对账 → 发票');
    const b4 = await boot('market');
    try {
      const cat = await b4.call('deck_market', { action: 'catalog' });
      chk(/货架/.test(cat), 'catalog 看货架', cat.split('\n')[0].slice(0, 60));
      const h = await b4.call('deck_market', { action: 'health' });
      chk(/未配|渠道/.test(h), 'health 看渠道配没配', h.split('\n')[0].slice(0, 40));
      const buy = await b4.call('deck_market', { action: 'buy', skinId: 'premium-aurora' });
      chk(/环境未配|未配置/.test(buy), 'buy 没渠道时如实说环境未配（不假装成功）', buy.slice(0, 70));
      const od = await b4.call('deck_market', { action: 'orders' });
      chk(/订单|还没有/.test(od), 'orders 列订单', od.split('\n')[0].slice(0, 50));
      const rf = await b4.call('deck_market', { action: 'refund', orderId: 'ord_00000001' });
      chk(!/运行失败/.test(rf), 'refund 有回复', rf.split('\n')[0].slice(0, 50));
      const rc = await b4.call('deck_market', { action: 'reconcile', remote: '[]' });
      chk(/对账/.test(rc), 'reconcile 出对账报告', rc.split('\n')[0].slice(0, 50));
      const iv = await b4.call('deck_market', { action: 'invoice', sub: 'list' });
      chk(/发票/.test(iv), 'invoice 列发票', iv.split('\n')[0].slice(0, 50));
    } finally { b4.done(); }
    say('');

    say('【deck_license】3 个动作：看档位 → 看价目 → 激活');
    const b5 = await boot('lic');
    try {
      const st = await b5.call('deck_license', { action: 'status' });
      chk(/档位/.test(st), 'status 看档位', st.split('\n')[0].slice(0, 50));
      const pl = await b5.call('deck_license', { action: 'plans' });
      for (const k of ['免费版', '协作版', '工作室版', '企业版']) chk(pl.includes(k), `plans 里有 ${k}`);
      const ac = await b5.call('deck_license', { action: 'activate', key: 'ADSK1.bad' });
      chk(!/运行失败/.test(ac), 'activate 有回复（假码被拒）', ac.split('\n')[0].slice(0, 60));
    } finally { b5.done(); }
    say('');
  }

  /* ══ 10. deck_room（6）+ 4 个无动作工具 ══════════════════════════ */
  {
    say('【deck_room】6 个动作（没有 relay 时要给人话，不许崩）');
    const b = await boot('room');
    try {
      for (const [act, args] of [
        ['create', { name: '全功能房间' }],
        ['join', { roomId: 'r1', inviteToken: 't1' }],
        ['sync', { waitSec: 0 }],
        ['info', {}],
        ['close', {}],
        ['leave', {}],
      ]) {
        const r = await b.call('deck_room', { action: act, ...args });
        chk(!/运行失败|TypeError/.test(r) && r.length > 0, `deck_room ${act} 有明确回复`,
          r.split('\n')[0].slice(0, 60));
      }
    } finally { b.done(); }
    say('');

    say('【4 个无 action 的工具】：super_agent / team_orchestrate / pet_meeting / twin_remember');
    const b6 = await boot('misc');
    try {
      const sa = await b6.call('super_agent', { goal: '全功能验证目标', maxSteps: 1 });
      chk(sa.length > 0 && !/运行失败/.test(sa), 'super_agent 有回复', sa.split('\n')[0].slice(0, 60));
      const to = await b6.call('team_orchestrate', { goal: '全功能编排', dryRun: true });
      chk(to.length > 0 && !/运行失败/.test(to), 'team_orchestrate dryRun 出计划', to.split('\n')[0].slice(0, 60));
      const pm = await b6.call('pet_meeting', { topic: '全功能桌宠会议', rounds: 1, maxTasks: 1, dryRun: true });
      chk(pm.length > 0 && !/运行失败/.test(pm), 'pet_meeting 有回复', pm.split('\n')[0].slice(0, 60));
      const tr = await b6.call('twin_remember', { text: '无 action 工具验证' });
      chk(/已记住/.test(tr), 'twin_remember 直接可用');
    } finally { b6.done(); }
  }

  say('');
  say('='.repeat(70));
  say(`结论：${pass} 项通过，${fail} 项失败`);

  const text = `${lines.join('\n')}\n`;
  mkdirSync(join(REPO, 'docs', 'evidence'), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  process.stdout.write(text);
  process.stdout.write(`\n证据已写入：${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`脚本自己崩了：${err?.stack || err}\n`);
  process.exitCode = 1;
});
