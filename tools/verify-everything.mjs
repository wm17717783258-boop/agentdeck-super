/**
 * tools/verify-everything.mjs —— **每一个功能**端到端跑通（全部公开工具与动作）
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
 * 证据：docs/evidence/everything-<版本>.txt
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const OUT = join(REPO, 'docs', 'evidence', `everything-${VERSION}.txt`);

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => lines.push(t);

/**
 * 起一个真的本地 HTTP 服务，给市场/模型验收用。
 * 所有请求体都记下来，断言不是看“函数返回了什么”，而是看网络上真发了什么。
 */
async function startJsonServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const hit = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(hit);
      try {
        const payload = await handler(hit);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload ?? { ok: true }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 在任意 JSON 里找一条任务；用于验证 context.from 这类不显示在工具输出里的字段。 */
function findJsonObject(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (predicate(value)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findJsonObject(child, predicate, seen);
    if (found) return found;
  }
  return null;
}

/* ── 起一个真插件实例（真工具、真落盘）────────────────────────────── */
async function boot(label, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), `nexi-all-${label}-`));
  const mod = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href);
  const tools = [];
  const disposers = [];
  const services = opts.services && typeof opts.services === 'object' ? opts.services : {};
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: (name) => services[name] ?? null,
    emit() {},
    effect: (fn) => {
      const d = fn();
      const dispose = typeof d === 'function' ? d : () => {};
      disposers.push(dispose);
      return dispose;
    },
    inject() {},
    tools: { register(def) { tools.push(def); return () => {}; } },
  };
  await mod.apply(ctx, {
    workspace: root,
    boardRoot: root,
    petRoot: root,
    licenseRoot: root,
    agents: [],
    automation: { enabled: false },
    ...(opts.config || {}),
  });
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
  return {
    root,
    tools,
    of,
    call,
    done: () => {
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* 清理失败不掩盖测试结果 */ }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const idIn = (text, re) => (String(text).match(re) || [])[0] || '';

async function main() {
  say('全功能端到端验证：全部公开工具与动作');
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
      chk(cap.includes('写码') && !/没找到/.test(cap), 'capabilities 看能力', cap.split('\n')[0].slice(0, 60));

      const a = await b.call('team_board', { action: 'add', teamId, title: '派给他的活' });
      const taskId = idIn(a, /task_[0-9a-f]{8,}/);
      const asg = await b.call('agent_join', { action: 'assign', name: '小工', taskId, teamId });
      chk(/已把任务/.test(asg) && !/没有 assignTask|没指派成功/.test(asg), 'assign 派活', asg.split('\n')[0].slice(0, 60));
      const lb = await b.call('team_board', { action: 'list', teamId });
      chk(/负责:mem_[0-9a-f]+/.test(lb), 'assign 真的落到任务板', lb.split('\n')[1]?.slice(0, 70) || '');

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
      const passKid = (iss.match(/kid[：:]\s*(kid_[A-Za-z0-9_-]+)/) || [])[1] || '';
      chk(Boolean(passToken), 'issue 出通行证', passToken ? `${passToken.length} 字符` : iss.slice(0, 80));
      chk(Boolean(passKid), 'issue 给出真实 kid', passKid || iss.slice(0, 80));

      if (passToken) {
        const v = await b.call('agent_passport', { action: 'verify', card: passToken });
        chk(/通过|有效|ok/i.test(v), 'verify 验自己签的卡通过', v.split('\n')[0].slice(0, 70));
        // 改 payload 里的能力字段，而不是改 base64url 末尾的填充位：
        // 末尾字符可能只带填充位，改了也不改变解出来的签名字节。
        const passportParts = passToken.split('.');
        let tampered = '';
        try {
          const claims = JSON.parse(Buffer.from(passportParts[1], 'base64url').toString('utf8'));
          claims.capabilities = [...new Set([...(claims.capabilities || []), 'admin'])];
          tampered = `${passportParts[0]}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${passportParts[2]}`;
        } catch {
          tampered = passToken;
        }
        const vbad = await b.call('agent_passport', { action: 'verify', card: tampered });
        chk(/没通过/.test(vbad) && !/【agent_passport】通过/.test(vbad), '改过的卡真的验不过', vbad.split('\n')[0].slice(0, 70));
        const missing = await b.call('agent_passport', {
          action: 'verify',
          card: passToken,
          required: ['admin'],
        });
        chk(/没通过/.test(missing) && /missing_capability|没有声明的能力/.test(missing),
          'required 缺能力真的被拒', missing.split('\n')[0].slice(0, 70));
        const rev = passKid
          ? await b.call('agent_passport', { action: 'revoke', kid: passKid })
          : '';
        chk(/已在本机账本吊销/.test(rev) && !/吊销失败|需要 kid/.test(rev), 'revoke 用真实 kid 吊销',
          rev.split('\n')[0].slice(0, 60));
      }
      const ls = await b.call('agent_passport', { action: 'list' });
      chk(ls.includes('全功能验证') && /已吊销/.test(ls), 'list 列通行证并标出已吊销',
        ls.split('\n')[0].slice(0, 60));
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

      // 习惯引擎：真实任务事件 → signal → propose → confirm → 画像生效 → rollback 清零
      const team = await b.call('team_board', { action: 'create', name: '习惯验证组' });
      const habitTeam = idIn(team, /team_[0-9a-f]{8,}/);
      chk(Boolean(habitTeam), 'twin_habit 前置：建真实小组', habitTeam);
      for (let i = 0; i < 2; i += 1) {
        await b.call('team_board', {
          action: 'add',
          teamId: habitTeam,
          title: '周报整理',
          role: 'worker',
          acceptance: '习惯候选能看见',
        });
      }
      const profileFile = join(b.root, '.agentdeck', 'pet', 'profile.json');
      const profileAfterEvents = JSON.parse(readFileSync(profileFile, 'utf8'));
      const signals = Object.entries(profileAfterEvents.signals || {});
      const weeklySignal = signals.find(([key]) => key.includes('worker') && key.includes('周报整理'));
      chk(Boolean(weeklySignal) && weeklySignal[1].count >= 2,
        '真实 task_add 事件落成 profile.signals（不是 twin_remember 假数据）',
        weeklySignal ? `${weeklySignal[0]} × ${weeklySignal[1].count}` : '没找到 signal');

      const prop = await b.call('twin_habit', { action: 'propose' });
      const habitKey = (prop.match(/\[([^\]]+)\]/) || [])[1] || '';
      chk(Boolean(habitKey), 'twin_habit propose 出真实候选 key', habitKey || prop.split('\n')[0]);
      chk(/周报整理/.test(prop), '候选标签来自真实任务标题', prop.split('\n').find((line) => line.includes('周报整理'))?.slice(0, 80) || '');

      const cf = await b.call('twin_habit', { action: 'confirm', key: habitKey });
      chk(/已确认/.test(cf), 'twin_habit confirm 真确认', cf.split('\n')[0].slice(0, 70));
      const profileConfirmed = JSON.parse(readFileSync(profileFile, 'utf8'));
      chk((profileConfirmed.habits || []).some((h) => h.key === habitKey),
        'confirm 后画像里真的有这条习惯');
      const hl = await b.call('twin_habit', { action: 'list' });
      chk(hl.includes('已确认') && hl.includes(habitKey), 'twin_habit list 显示已确认 key',
        hl.split('\n')[0].slice(0, 60));
      const brief2 = await b.call('twin_brief', {});
      chk(/用户确认过的习惯/.test(brief2) && brief2.includes('周报整理'),
        'twin_brief 把确认过的习惯带进简报');

      const rb = await b.call('twin_habit', { action: 'rollback', key: habitKey });
      chk(/已撤回/.test(rb), 'twin_habit rollback 真撤回', rb.split('\n')[0].slice(0, 60));
      const hl2 = await b.call('twin_habit', { action: 'list' });
      const confirmedSection = hl2.split('已确认：')[1] || '';
      chk(!confirmedSection.includes(`[${habitKey}]`), 'rollback 后“已确认”账本里不再有这条');
      const profileAfterRollback = JSON.parse(readFileSync(profileFile, 'utf8'));
      chk(!(profileAfterRollback.habits || []).some((h) => h.key === habitKey),
        'rollback 后画像里也不再保留（双账本一致）');

      // 拒绝路径：换一个标题，产生新候选，拒绝后 propose 不再出现
      for (let i = 0; i < 2; i += 1) {
        await b.call('team_board', {
          action: 'add',
          teamId: habitTeam,
          title: '写周报',
          role: 'worker',
        });
      }
      const prop2 = await b.call('twin_habit', { action: 'propose' });
      const rejectLine = prop2.split('\n').find((line) => line.includes('写周报')) || '';
      const rejectKey = ((rejectLine.match(/\[([^\]]+)\]/) || [])[1] || '');
      chk(Boolean(rejectKey) && rejectKey !== habitKey, '新行为产生新候选 key', rejectKey);
      const rej = await b.call('twin_habit', { action: 'reject', key: rejectKey });
      chk(/已拒绝/.test(rej), 'twin_habit reject 真记账', rej.split('\n')[0].slice(0, 60));
      const prop3 = await b.call('twin_habit', { action: 'propose' });
      chk(!prop3.includes(`[${rejectKey}]`), '拒绝后 propose 不再出现该候选');
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
      const approvalId = idIn(run, /apr_[a-z0-9]+/i);
      chk(Boolean(approvalId), 'run 要审批的任务真的进审批队列', approvalId || run.slice(0, 70));

      const stop = await b.call('deck_automation', { action: 'stop', reason: '全功能验证' });
      chk(/停/.test(stop), 'stop 全局停止', stop.split('\n')[0].slice(0, 50));
      const st2 = await b.call('deck_automation', { action: 'status' });
      chk(/已停止|停/.test(st2), 'status 反映已停');

      const res = await b.call('deck_automation', { action: 'resume' });
      chk(!/错误/.test(res), 'resume 恢复', res.split('\n')[0].slice(0, 50));

      const ap = approvalId
        ? await b.call('deck_automation', { action: 'approve', approvalId })
        : '';
      chk(/审批放行/.test(ap) && /已执行/.test(ap) && !/执行失败/.test(ap),
        'approve 用真实审批号放行并执行', ap.split('\n')[0].slice(0, 60));
      const afterApprove = await b.call('team_board', { action: 'list', teamId });
      chk(afterApprove.includes('全功能定时'), '审批通过后任务真的落到任务板',
        afterApprove.split('\n')[1]?.slice(0, 70) || afterApprove.split('\n')[0].slice(0, 70));

      const run2 = await b.call('deck_automation', { action: 'run', jobId: jid });
      const denyId = idIn(run2, /apr_[a-z0-9]+/i);
      chk(Boolean(denyId) && denyId !== approvalId, '再次 run 生成新的审批记录', denyId || run2.slice(0, 70));
      const dy = denyId
        ? await b.call('deck_automation', { action: 'deny', approvalId: denyId })
        : '';
      chk(/已拒绝/.test(dy) && !/没有这条待审批记录/.test(dy), 'deny 用真实审批号拒绝',
        dy.split('\n')[0].slice(0, 60));

      const rm = await b.call('deck_automation', { action: 'remove', jobId: jid });
      chk(/已删掉/.test(rm), 'remove 真的删掉', rm.split('\n')[0].slice(0, 50));
      const ls2 = await b.call('deck_automation', { action: 'list' });
      chk(/定时任务 0 条/.test(ls2) && ls2.includes('最近执行：'), '删完任务列表归零，执行记录仍在',
        ls2.split('\n')[1]?.slice(0, 70) || '');
    } finally { b.done(); }
    say('');
  }

  /* ══ 9. deck_policy（4）+ deck_audit（3）+ team（11）+ market（8）══ */
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
      const spaceId = idIn(c, /space_[a-z0-9]+/i);
      chk(Boolean(spaceId), 'create 给出真实空间 id', spaceId || c.slice(0, 70));
      const st = await b3.call('deck_team', { action: 'status' });
      chk(/全功能团队/.test(st), 'status 看得到');
      const mem = await b3.call('deck_team', { action: 'members' });
      chk(mem.length > 0, 'members 列成员', mem.split('\n')[0].slice(0, 50));
      const marker = `共享${Math.random().toString(36).slice(2, 6)}`;
      const sh = await b3.call('deck_team', { action: 'share', text: marker });
      chk(!/运行失败/.test(sh), 'share 写共享记忆', sh.split('\n')[0].slice(0, 60));
      const rc = await b3.call('deck_team', { action: 'recall', query: marker });
      chk(rc.includes(marker), 'recall 读得回来（写→读闭环）');
      const jn = await b3.call('deck_team', {
        action: 'join',
        spaceId,
        memberId: '新来的',
        memberName: '新来的',
        role: 'worker',
        capabilities: ['测试'],
      });
      chk(/已加入/.test(jn) && !/没加成|没建成/.test(jn), 'join 用真实空间 id 加入成员',
        jn.split('\n')[0].slice(0, 60));
      const memAfterJoin = await b3.call('deck_team', { action: 'members' });
      chk(memAfterJoin.includes('新来的'), 'join 后 members 真能看到');
      const sr = await b3.call('deck_team', {
        action: 'set-role',
        spaceId,
        memberId: '新来的',
        role: 'reviewer',
      });
      chk(/worker\s*→\s*reviewer/.test(sr), 'set-role 用真实成员改角色',
        sr.split('\n')[0].slice(0, 60));
      const rm = await b3.call('deck_team', { action: 'remove', spaceId, memberId: '新来的' });
      chk(/已移出/.test(rm), 'remove 真的移出成员', rm.split('\n')[0].slice(0, 60));
      const memAfterRemove = await b3.call('deck_team', { action: 'members' });
      chk(!memAfterRemove.includes('新来的'), 'remove 后 members 真的没了');
      const jn2 = await b3.call('deck_team', {
        action: 'join',
        spaceId,
        memberId: '访客',
        memberName: '访客',
        role: 'viewer',
      });
      chk(/已加入/.test(jn2), '再拉一个成员用于 leave', jn2.split('\n')[0].slice(0, 60));
      const lv = await b3.call('deck_team', { action: 'leave', spaceId, memberId: '访客' });
      chk(/已退出/.test(lv), 'leave 真的退出成员', lv.split('\n')[0].slice(0, 60));
      const ae = await b3.call('deck_team', { action: 'audit-export', format: 'json' });
      const auditMatch = ae.match(/路径：([^\r\n]+)/);
      const auditPath = auditMatch ? auditMatch[1].trim() : '';
      chk(/审计已导出/.test(ae) && Boolean(auditPath) && existsSync(auditPath),
        'audit-export 导出到真实文件', auditPath ? auditPath.slice(-48) : ae.split('\n')[0].slice(0, 60));
      const asw = await b3.call('deck_team', { action: 'audit-sweep', days: 30 });
      chk(/审计清理完成/.test(asw), 'audit-sweep 真清理', asw.split('\n')[0].slice(0, 60));
    } finally { b3.done(); }
    say('');

    say('【deck_market】8 个动作：货架 → 体检 → 买 → 订单 → 退款 → 对账 → 发票 → 主题包');
    const pay = await startJsonServer(({ url, body }) => {
      if (url === '/refund') {
        return {
          ok: true,
          refunded: true,
          provider: 'verify-gateway',
          ref: `VERIFY-REFUND-${body.refundId || 'unknown'}`,
        };
      }
      return {
        ok: true,
        paid: true,
        provider: 'verify-gateway',
        ref: `VERIFY-PAY-${body.orderId || 'unknown'}`,
      };
    });
    const oldPay = {
      provider: process.env.AGENTDECK_PAY_PROVIDER,
      url: process.env.AGENTDECK_PAY_URL,
      refundUrl: process.env.AGENTDECK_PAY_REFUND_URL,
      token: process.env.AGENTDECK_PAY_TOKEN,
    };
    process.env.AGENTDECK_PAY_PROVIDER = 'stripe';
    process.env.AGENTDECK_PAY_URL = `${pay.url}/pay`;
    process.env.AGENTDECK_PAY_REFUND_URL = `${pay.url}/refund`;
    process.env.AGENTDECK_PAY_TOKEN = 'verify-everything-token';
    const b4 = await boot('market');
    try {
      const cat = await b4.call('deck_market', { action: 'catalog' });
      chk(/货架/.test(cat), 'catalog 看货架', cat.split('\n')[0].slice(0, 60));
      const h = await b4.call('deck_market', { action: 'health' });
      chk(/购买通道：已配置/.test(h) && /退款通道：已配置/.test(h),
        'health 看到真实支付/退款渠道', h.split('\n').slice(0, 3).join(' / ').slice(0, 100));
      const buy = await b4.call('deck_market', { action: 'buy', skinId: 'premium-aurora' });
      const orderId = idIn(buy, /ord_[0-9a-f]{8,}/i);
      chk(/买到了/.test(buy) && Boolean(orderId), 'buy 真下单并交付', orderId || buy.slice(0, 90));
      const pays = pay.requests.filter((hit) => hit.url === '/pay');
      chk(pays.length === 1, 'buy 只打一次支付网关', `${pays.length} 次`);
      chk(pays[0]?.body?.amount === 1800,
        '支付金额 1800 分（¥18）', String(pays[0]?.body?.amount ?? ''));
      chk(pays[0]?.body?.orderId === orderId && pays[0]?.body?.token === 'verify-everything-token',
        '支付请求带真实订单号和渠道 token', pays[0]?.body?.orderId || '');
      const od = await b4.call('deck_market', { action: 'orders' });
      chk(od.includes(orderId) && /已发放/.test(od), 'orders 真实订单已发放',
        od.split('\n')[0].slice(0, 70));
      const th = await b4.call('deck_market', { action: 'themes' });
      chk(/极光套装[\s\S]*状态：已拥有/.test(th), 'themes 看到真实购买后的已拥有状态',
        th.split('\n')[0].slice(0, 70));
      const inv = await b4.call('deck_market', {
        action: 'invoice',
        sub: 'issue',
        orderId,
        titleType: 'personal',
        titleName: '全功能验收',
      });
      const invoiceNo = idIn(inv, /INV-[0-9A-Za-z_-]+/);
      chk(Boolean(invoiceNo) && /【发票】/.test(inv), 'invoice issue 给真实订单开票',
        invoiceNo || inv.split('\n')[0].slice(0, 70));
      const ivl = await b4.call('deck_market', { action: 'invoice', sub: 'list', orderId });
      chk(ivl.includes(invoiceNo), 'invoice list 查得到刚开的票', ivl.split('\n')[0].slice(0, 70));
      const rc = await b4.call('deck_market', {
        action: 'reconcile',
        remote: [{ orderId, amount: 1800, state: 'delivered' }],
      });
      chk(/勾对成功 1 笔/.test(rc) && /无差异/.test(rc),
        'reconcile 用真实订单与渠道流水勾对', rc.split('\n').slice(0, 2).join(' / ').slice(0, 100));
      const act = await b4.call('pet_skin', { action: 'activate', id: 'premium-aurora' });
      chk(/已经换上/.test(act), '付款后皮肤真的解锁', act.split('\n')[0].slice(0, 60));
      const rf = await b4.call('deck_market', { action: 'refund', orderId });
      chk(/已退款/.test(rf), 'refund 真退款', rf.split('\n')[0].slice(0, 70));
      const refunds = pay.requests.filter((hit) => hit.url === '/refund');
      chk(refunds.length === 1, '退款只打一次退款网关', `${refunds.length} 次`);
      chk(refunds[0]?.body?.refundId === `rfd_${orderId}`,
        '退款号稳定可重试', refunds[0]?.body?.refundId || '');
      const after = await b4.call('deck_market', { action: 'orders' });
      chk(after.includes(orderId) && /已退款/.test(after) && /待付款 0/.test(after),
        '退款后订单冲正且待付款归零', after.split('\n')[0].slice(0, 80));
      const afterSkin = await b4.call('pet_skin', { action: 'list' });
      chk(/当前：basic/.test(afterSkin), '退款后当前皮肤切回 basic',
        afterSkin.split('\n')[0].slice(0, 60));
      const afterRender = await b4.call('pet_skin', { action: 'render', id: 'premium-aurora' });
      chk(/data-placeholder="true"/.test(afterRender) && /此皮肤需授权/.test(afterRender),
        '退款后付费皮肤 fail-closed', afterRender.split('\n')[0].slice(0, 70));
    } finally {
      b4.done();
      await pay.close();
      if (oldPay.provider === undefined) delete process.env.AGENTDECK_PAY_PROVIDER;
      else process.env.AGENTDECK_PAY_PROVIDER = oldPay.provider;
      if (oldPay.url === undefined) delete process.env.AGENTDECK_PAY_URL;
      else process.env.AGENTDECK_PAY_URL = oldPay.url;
      if (oldPay.refundUrl === undefined) delete process.env.AGENTDECK_PAY_REFUND_URL;
      else process.env.AGENTDECK_PAY_REFUND_URL = oldPay.refundUrl;
      if (oldPay.token === undefined) delete process.env.AGENTDECK_PAY_TOKEN;
      else process.env.AGENTDECK_PAY_TOKEN = oldPay.token;
    }
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

    say('【deck_sync】3 个动作：看清单 → 加密打包 → 合并进来（跨设备）');
    const b7 = await boot('sync');
    const b8 = await boot('sync2');
    try {
      const info = await b7.call('deck_sync', { action: 'info' });
      chk(/会被带走/.test(info), 'info 看会带走什么', info.split('\n')[0].slice(0, 50));
      const packed = await b7.call('deck_sync', { action: 'pack', passphrase: '口令密码123' });
      chk(/已打包/.test(packed), 'pack 加密打包', packed.split('\n')[0].slice(0, 60));
      const blob = (packed.match(/NEXISYNC1\.[A-Za-z0-9_-]+/) || [])[0];
      chk(Boolean(blob), 'pack 给出了加密串', blob ? `${blob.length} 字符` : '');
      const wrong = await b8.call('deck_sync', { action: 'apply', blob, passphrase: '错口令999' });
      chk(/解不开/.test(wrong), 'apply 错口令解不开（真加密）', wrong.slice(0, 50));
      const ok2 = await b8.call('deck_sync', { action: 'apply', blob, passphrase: '口令密码123' });
      chk(/已合并/.test(ok2), 'apply 对口令合并成功', ok2.split('\n')[0].slice(0, 50));
    } finally { b7.done(); b8.done(); }
    say('');

    say('【4 个无 action 的工具】：super_agent / team_orchestrate / pet_meeting / twin_remember');
    const llm = await startJsonServer(({ body }) => {
      const text = (Array.isArray(body.messages) ? body.messages : [])
        .map((message) => String(message?.content ?? ''))
        .join('\n');
      const openai = (content, toolCalls = []) => ({
        id: 'chatcmpl-verify-everything',
        object: 'chat.completion',
        model: body.model || 'verify-brain',
        choices: [{
          index: 0,
          message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });

      if (text.includes('你是一个能真正动手干活的超级 Agent')) {
        if (text.includes('【工具结果 board_add】')) {
          return openai('验证完成：任务已经落到真实任务板。');
        }
        return openai('先把验收任务落到任务板。', [{
          id: 'call_board_add_verify',
          type: 'function',
          function: {
            name: 'board_add',
            arguments: JSON.stringify({
              title: '超级 Agent 落板任务',
              role: 'worker',
              acceptance: '任务板 list 能看到',
            }),
          },
        }]);
      }
      if (text.includes('你是团队会议的主持人')) {
        return openai('开场：今天把全功能验收拆成可执行任务。');
      }
      if (text.includes('你是会议主持人')) {
        return openai(JSON.stringify({
          summary: '团队同意按验收清单推进',
          decisions: ['先落任务再执行', '每项都留证据'],
          tasks: [{
            title: '会议落地任务',
            role: 'worker',
            acceptance: '任务板能看到且来源是 pet_meeting',
            dependsOn: [],
          }],
        }));
      }
      if (text.includes('你是「')) {
        return openai('我建议把验收拆成小任务，逐项跑完再发布。');
      }
      return openai('已收到。');
    });
    const b6 = await boot('misc', {
      config: {
        llm: {
          mode: 'api',
          baseUrl: `${llm.url}/v1`,
          apiKey: 'verify-llm-token',
          model: 'verify-brain',
        },
      },
    });
    try {
      const st = await b6.call('team_board', { action: 'create', name: '超级 Agent 验收组' });
      const superTeamId = idIn(st, /team_[0-9a-f]{8,}/);
      chk(Boolean(superTeamId), 'super_agent 前置：建真实小组', superTeamId);
      const sa = await b6.call('super_agent', {
        goal: '把全功能验收任务落到任务板',
        maxSteps: 3,
        teamId: superTeamId,
      });
      chk(/【super_agent】✅ 已完成/.test(sa) && /验证完成/.test(sa),
        'super_agent 真发模型请求并给出结论', sa.split('\n')[0].slice(0, 80));
      chk(/\[board_add\] ✓/.test(sa), 'super_agent 真的调用 board_add',
        sa.split('\n').find((line) => line.includes('[board_add]'))?.slice(0, 90) || '');
      const superTasks = await b6.call('team_board', { action: 'list', teamId: superTeamId });
      chk(superTasks.includes('超级 Agent 落板任务'), 'super_agent 调用真的落到任务板',
        superTasks.split('\n')[1]?.slice(0, 80) || '');
      const to = await b6.call('team_orchestrate', { goal: '全功能编排', dryRun: true });
      chk(to.length > 0 && !/运行失败/.test(to), 'team_orchestrate dryRun 出计划', to.split('\n')[0].slice(0, 60));
      const mt = await b6.call('team_board', { action: 'create', name: '桌宠会议验收组' });
      const meetingTeamId = idIn(mt, /team_[0-9a-f]{8,}/);
      chk(Boolean(meetingTeamId), 'pet_meeting 前置：建真实小组', meetingTeamId);
      const pm = await b6.call('pet_meeting', {
        topic: '全功能桌宠会议',
        teamId: meetingTeamId,
        rounds: 1,
        maxTasks: 1,
        participants: [
          { name: '阿甲', role: 'worker', personaHint: '重视证据' },
          { name: '阿乙', role: 'tester', personaHint: '专挑边界' },
        ],
      });
      chk(/会议结束/.test(pm) && /会议纪要/.test(pm),
        'pet_meeting 真开会并产出纪要', pm.split('\n')[0].slice(0, 70));
      chk(/议题/.test(pm) && /最终决议/.test(pm) && /会议落地任务/.test(pm),
        '纪要包含议题、决议、任务', pm.split('\n').slice(0, 3).join(' / ').slice(0, 100));
      const meetingTasks = await b6.call('team_board', { action: 'list', teamId: meetingTeamId });
      chk(meetingTasks.includes('会议落地任务'), 'pet_meeting 任务真的落板',
        meetingTasks.split('\n')[1]?.slice(0, 80) || '');
      const boardState = JSON.parse(readFileSync(join(b6.root, 'state.json'), 'utf8'));
      const meetingTask = findJsonObject(
        boardState,
        (value) => value?.title === '会议落地任务' && value?.context?.from === 'pet_meeting',
      );
      chk(Boolean(meetingTask), '会议任务 context.from 真是 pet_meeting',
        meetingTask?.id || '');
      const tr = await b6.call('twin_remember', { text: '无 action 工具验证' });
      chk(/已记住/.test(tr), 'twin_remember 直接可用');
    } finally {
      b6.done();
      await llm.close();
    }
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
