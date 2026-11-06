/**
 * 全功能真机遍历：21 个工具 / 94 个动作，逐个真调一次。
 *
 * 为什么要有这一层：其它套件是"挑重点测"，这一层是"一个都不漏"。
 * 产品的验收标准是"每个功能都能真用"，那就得每个动作都真跑一遍，
 * 把「不认识的动作」「报错了」「返回空」这类问题一次性全捞出来。
 *
 * 判定标准（每个动作三条都要满足）：
 *   ① 不抛异常、不返回 "运行失败"
 *   ② 返回非空文本
 *   ③ **不是"不认识的动作"** —— 参数写错导致的"不认识"说明动作表跟实现对不上，
 *      那是真 bug；参数写对但仍然"不认识"更糟。
 *
 * 需要真宿主在跑：默认 http://127.0.0.1:58399，可用 NEXI_E2E_BASE 覆盖。
 * 起不来就跳过（不算失败），避免 CI 里没宿主时红一片。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.NEXI_E2E_BASE || 'http://127.0.0.1:58399';

/** 每个动作的"能跑通"参数。故意给最小可用值：动作本身能被执行到就算过。 */
const CASES = {
  team_board: {
    list: {}, add: { title: '遍历测试任务' }, done: { taskId: 'task_probe' }, fail: { taskId: 'task_probe' },
    claim: { taskId: 'task_probe' }, next: {}, stats: {}, events: { limit: 3 },
    create: { name: '遍历测试组' }, teams: {},
  },
  agent_join: { list: {}, join: { agent: 'dsh', name: '遍历成员' }, leave: { name: '遍历成员' }, assign: { name: '遍历成员', taskId: 'task_probe' }, capabilities: { name: '遍历成员' } },
  agent_passport: { show: {}, list: {}, verify: { token: 'NEXP1.bad.bad' }, issue: { subject: '遍历测试', capabilities: ['read'] }, revoke: { id: 'lic_probe' } },
  deck_room: { create: { name: '遍历房间' }, info: {}, sync: { waitSec: 0 }, close: {}, leave: {}, join: { roomId: 'room_probe', inviteToken: 'bad' } },
  deck_license: { status: {}, plans: {}, activate: { key: 'ADSK1-bad-key' } },
  pet_visit: { card: {}, invite: { ttlHours: 1 }, accept: { token: 'bad.token' }, gift: { message: '遍历礼物' }, ask: { title: '遍历求助' }, receive: { note: {} }, log: { limit: 2 } },
  pet_skin: { list: {}, activate: { id: 'nio' }, states: {}, render: { state: 'idle', size: 96 } },
  twin_remember: { text: '遍历测试记一条' },
  twin_recall: { any: true, limit: 2 },
  twin_brief: {},
  twin_forget: { forget: { all: true, confirm: true }, export: { format: 'json' }, stats: {} },
  twin_habit: { propose: {}, list: {}, confirm: { key: 'probe' }, reject: { key: 'probe' }, rollback: { key: 'probe' } },
  deck_meeting: {
    open: { topic: '遍历测试会议' }, list: {}, show: { meetingId: 'mtg_probe' }, agenda: { meetingId: 'mtg_probe' },
    submit: { meetingId: 'mtg_probe', text: '遍历意见' }, 'agenda-add': { meetingId: 'mtg_probe', title: '遍历议题' },
    'agenda-assign': { meetingId: 'mtg_probe', agendaId: 'ag_1', agentId: 'dsh' },
    'agenda-done': { meetingId: 'mtg_probe', agendaId: 'ag_1', conclusion: '遍历结论' },
    'conflict-raise': { meetingId: 'mtg_probe', agendaId: 'ag_1', between: ['a', 'b'], summary: '遍历分歧' },
    'conflict-resolve': { meetingId: 'mtg_probe', conflictId: 'cf_1', resolution: '遍历裁定' },
    vote: { meetingId: 'mtg_probe', agendaId: 'ag_1', agentId: 'dsh', choice: '赞成' },
    conclude: { meetingId: 'mtg_probe' },
  },
  deck_automation: {
    add: { title: '遍历任务', every: '1d' }, list: {}, remove: { jobId: 'job_probe' }, run: { jobId: 'job_probe' },
    approve: { approvalId: 'apr_probe' }, deny: { approvalId: 'apr_probe' }, stop: { reason: '遍历测试' },
    resume: {}, status: {},
  },
  deck_market: { catalog: {}, health: {}, buy: { skinId: 'premium-aurora' }, orders: {}, refund: { orderId: 'ord_probe00' }, reconcile: { remote: '[]' }, invoice: { sub: 'list' } },
  deck_team: {
    create: { name: '遍历团队' }, status: {}, members: {}, leave: {}, remove: { memberId: 'm1' },
    'set-role': { memberId: 'm1', role: 'worker' }, share: { text: '遍历共享' }, recall: { query: '遍历' },
    'audit-export': { format: 'json' }, 'audit-sweep': { keepDays: 30 }, join: { teamId: 'team_probe' },
  },
  deck_policy: { show: {}, set: { rule: { id: 'probe', match: { tool: 'pet_skin' }, effect: 'allow' } }, check: { tool: 'pet_skin', toolAction: 'list' }, reset: {} },
  deck_audit: { tail: { limit: 3 }, query: { tool: 'pet_skin', limit: 3 }, export: { format: 'json' } },
  super_agent: { goal: '遍历测试目标', maxSteps: 1 },
  team_orchestrate: { goal: '遍历测试编排', plan: [{ id: 't1', title: '遍历子任务', role: 'worker' }], dryRun: true },
  pet_meeting: { topic: '遍历测试桌宠会议', rounds: 1, maxTasks: 1 },
};

let reachable = false;

async function callTool(name, args) {
  const res = await fetch(`${BASE}/v1/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args ?? {}),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, text: String(json?.text ?? ''), isError: Boolean(json?.isError) };
}

test('真宿主可达（不可达则整套跳过）', async () => {
  // 宿主可能正在重启（真机跑验收时会撞上）：重试几次，别把"正在重启"当成"坏了"。
  // 实在连不上就整套 skip —— 外部依赖不该让回归变红。
  for (let i = 0; i < 3 && !reachable; i += 1) {
    try {
      const res = await fetch(`${BASE}/v1/openapi.json`, { signal: AbortSignal.timeout(8000) });
      reachable = res.ok;
    } catch {
      reachable = false;
      if (i < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!reachable) {
    console.log(`  [skip] ${BASE} 不可达 —— 想跑这套先起宿主`);
    return;
  }
  const doc = await (await fetch(`${BASE}/v1/openapi.json`)).json();
  const n = Object.keys(doc.paths || {}).length;
  assert.ok(n >= 21, `工具数该 >= 21，实际 ${n}`);
});

test('21 个工具 / 94 个动作逐个真调：不崩、不空、不是"不认识的动作"', async (t) => {
  if (!reachable) {
    t.skip(`${BASE} 不可达`);
    return;
  }

  const problems = [];
  const worked = [];
  let total = 0;

  for (const [tool, actions] of Object.entries(CASES)) {
    for (const [action, args] of Object.entries(actions)) {
      total += 1;
      const payload = action === undefined ? args : { action, ...args };
      let r;
      try {
        r = await callTool(tool, payload);
      } catch (err) {
        problems.push(`${tool}.${action} 抛异常：${err?.message || err}`);
        continue;
      }
      const text = r.text;

      if (r.status !== 200) { problems.push(`${tool}.${action} HTTP ${r.status}`); continue; }
      if (/运行失败|TypeError|ReferenceError|is not a function|Cannot read/.test(text)) {
        problems.push(`${tool}.${action} 运行出错：${text.slice(0, 120)}`);
        continue;
      }
      if (!text.trim()) { problems.push(`${tool}.${action} 返回空文本`); continue; }
      if (/不认识的动作|不认识的子动作/.test(text)) {
        // 参数写对了却说"不认识" = 动作表跟实现对不上，这是真 bug
        problems.push(`${tool}.${action} 声称不认识这个动作：${text.slice(0, 140)}`);
        continue;
      }
      worked.push(`${tool}.${action}`);
    }
  }

  console.log(`  真调了 ${total} 个动作，${worked.length} 个正常返回`);
  if (problems.length) {
    console.log(`  ❌ 有问题的 ${problems.length} 个：`);
    for (const p of problems) console.log(`     - ${p}`);
  }
  assert.deepEqual(problems, [], `有 ${problems.length} 个动作没跑通`);
  assert.ok(total >= 90, `覆盖的动作数太少：${total}`);
});

test('每个动作都能被 schema 广告出来（动作表与实现一致）', async (t) => {
  if (!reachable) {
    t.skip(`${BASE} 不可达`);
    return;
  }
  // 反向检查：CASES 里写的动作，必须都在该工具自己广告的 action 枚举里；
  // 少一个就说明"文档说的动作"和"真能用的动作"对不上。
  const problems = [];
  for (const [tool, actions] of Object.entries(CASES)) {
    for (const action of Object.keys(actions)) {
      const r = await callTool(tool, { action });
      // 拿 schema 里的枚举：用一个假动作试探报错文案里的"可用：..."更好，但这里直接看枚举
      const probe = await fetch(`${BASE}/v1/tools/${tool}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"__probe__"}',
      }).then((x) => x.json()).catch(() => null);
      const listed = String(probe?.text || '').match(/可用[：:]\s*([^。\n]+)/);
      if (listed && !listed[1].includes(action)) {
        problems.push(`${tool}.${action} 不在它自己广告的动作表里（说的是：${listed[1].slice(0, 80)}）`);
      }
    }
  }
  if (problems.length) console.log('  ❌ ' + problems.join('\n     '));
  assert.deepEqual(problems, []);
});
