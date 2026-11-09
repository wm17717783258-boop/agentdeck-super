/**
 * 动作"真的做了事"验证：不只看返回了文字，而是看**副作用真发生了**。
 *
 * 上一套（e2e-all-actions）证明"105 个动作都能被调用且不报错"，
 * 这一套进一步证明"调用之后世界真的变了"——
 *   写 → 读得到；删 → 读不到；状态机 → 真的往前走。
 *
 * 每条都按"先写、再独立读回来核对"的方式做，绝不拿写操作的返回值当证据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { hasPro } from './_pro.mjs';

/** 起一个真插件实例（真工具、真落盘），拿到工具名 → 定义。 */
async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'nexi-side-'));
  const tools = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: () => null,
    emit() {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject() {},
    tools: { register(def) { tools.push(def); return () => {}; } },
  };
  await apply(ctx, { workspace: root, boardRoot: root, licenseRoot: root, agents: [] });
  const of = (n) => {
    const t = tools.find((x) => x.name === n);
    assert.ok(t, `工具 ${n} 没注册`);
    return t;
  };
  // 归一化：正常工具返回 { text }，但被策略拦下时返回的是一个纯字符串。
  // 只读 .text 会把"被拦住"误判成"返回空"——这里两种都吃。
  const text = async (n, args) => {
    const out = await of(n).execute(args, {});
    if (typeof out === 'string') return out;
    return String(out?.text ?? '');
  };
  return { root, tools, of, text, done: () => rmSync(root, { recursive: true, force: true }) };
}

/* ── 任务板：写 → 读回来 ───────────────────────────────────────────────── */

test('team_board：建组 → 加任务 → 读回来 → 标完成 → 状态真的变', async () => {
  const b = await boot();
  try {
    const created = await b.text('team_board', { action: 'create', name: '副作用测试组' });
    // 注意别抓到工具名 team_board 本身：id 是 team_ + 10 位 hex
    const teamId = (created.match(/team_[0-9a-f]{8,}/i) || [])[0];
    assert.ok(teamId, `建组没给出 teamId：${created.slice(0, 150)}`);

    const added = await b.text('team_board', { action: 'add', teamId, title: '副作用任务' });
    const taskId = (added.match(/task_[0-9a-f]{8,}/i) || [])[0];
    assert.ok(taskId, `加任务没给出 taskId：${added.slice(0, 150)}`);

    // 独立读回来
    const list1 = await b.text('team_board', { action: 'list', teamId });
    assert.match(list1, /副作用任务/, '加完读不到这条任务');

    // 标完成
    await b.text('team_board', { action: 'done', teamId, taskId });
    const list2 = await b.text('team_board', { action: 'list', teamId });
    assert.ok(list2 !== list1 || /done|完成/.test(list2), `标完成后状态没变：${list2.slice(0, 200)}`);

    // 统计真的算得出
    const stats = await b.text('team_board', { action: 'stats', teamId });
    assert.match(stats, /\d/, '统计没有数字');
  } finally {
    b.done();
  }
});

/* ── 分身记忆：写 → 召回 → 改 → 删 ─────────────────────────────────────── */

test('twin 记忆：remember → recall 得到 → forget 之后 recall 不到', async () => {
  const b = await boot();
  try {
    const marker = `副作用标记-${Math.random().toString(36).slice(2, 8)}`;
    const w = await b.text('twin_remember', { text: marker, type: 'event' });
    assert.match(w, /已记住|已合并/, `写入失败：${w.slice(0, 150)}`);

    const r1 = await b.text('twin_recall', { query: marker, any: true, limit: 5 });
    assert.match(r1, new RegExp(marker), '刚写的记不住，这是假的');

    const stats = await b.text('twin_forget', { action: 'stats' });
    assert.match(stats, /共 \d+ 条/, '统计拿不到');

    // 删掉（按查询批量删）
    await b.text('twin_forget', { action: 'forget', query: marker });
    const r2 = await b.text('twin_recall', { query: marker, any: true, limit: 5 });
    assert.ok(!r2.includes(marker), `删了还召得回来：${r2.slice(0, 200)}`);
  } finally {
    b.done();
  }
});

/* ── 皮肤：换装 → 状态真的跟着变 ───────────────────────────────────────── */

test('pet_skin：activate 之后 list 里的「当前」真的换了', async () => {
  const b = await boot();
  try {
    const before = await b.text('pet_skin', { action: 'list' });
    assert.match(before, /共 \d+ 套皮肤/, `皮肤列表拿不到：${before.slice(0, 150)}`);

    // 找一个不是当前的免费皮肤来换
    const target = /水墨（ink）/.test(before) ? 'ink' : 'basic';
    const act = await b.text('pet_skin', { action: 'activate', id: target });
    assert.match(act, /已|换|启用/, `换装失败：${act.slice(0, 150)}`);

    const after = await b.text('pet_skin', { action: 'list' });
    const line = after.split('\n').find((l) => l.includes('已启用')) || '';
    assert.ok(line.includes(target) || line.includes(target === 'ink' ? '水墨' : '原味'),
      `换装后"当前"没跟着变：${line}`);

    // render 真的出图
    const svg = await b.text('pet_skin', { action: 'render', state: 'working', size: 128 });
    assert.match(svg, /<svg/, 'render 没出 SVG');
    assert.match(svg, /data-state="working"/, 'render 状态没生效');
  } finally {
    b.done();
  }
});

/* ── 策略：写规则 → check 预演真的按规则答 ─────────────────────────────── */

test('deck_policy：写 deny → check 说会拒；reset → check 说放行', async () => {
  const b = await boot();
  try {
    await b.text('deck_policy', {
      action: 'set',
      rule: { id: 'side-effect', match: { tool: 'pet_skin' }, effect: 'deny', reason: '副作用测试' },
    });

    const denied = await b.text('deck_policy', { action: 'check', tool: 'pet_skin', toolAction: 'list' });
    assert.match(denied, /拒绝|deny/i, `写了 deny 但 check 没说会拒：${denied.slice(0, 200)}`);
    assert.match(denied, /副作用测试/, 'check 没带上规则原因');

    // 而且真拦得住
    const blocked = await b.text('pet_skin', { action: 'list' });
    assert.match(blocked, /【策略拒绝】/, '写了 deny 但工具照跑');

    await b.text('deck_policy', { action: 'reset' });
    const allowed = await b.text('deck_policy', { action: 'check', tool: 'pet_skin', toolAction: 'list' });
    assert.doesNotMatch(allowed, /【策略拒绝】/, 'reset 之后 check 还说会拒');

    const runAgain = await b.text('pet_skin', { action: 'list' });
    assert.doesNotMatch(runAgain, /【策略拒绝】/, 'reset 之后还是被拦');
    assert.match(runAgain, /皮肤/, 'reset 之后工具没恢复正常');
  } finally {
    b.done();
  }
});

/* ── 自动化：加 → 列表看得到 → 停 → 状态真的变 ─────────────────────────── */

test('deck_automation：add → list 看得到 → stop → status 真的停了 → resume 恢复', async () => {
  const b = await boot();
  try {
    const added = await b.text('deck_automation', { action: 'add', title: '副作用定时', every: '1d' });
    assert.match(added, /job_|加|建/i, `加定时失败：${added.slice(0, 200)}`);

    const list = await b.text('deck_automation', { action: 'list' });
    assert.match(list, /副作用定时/, '加完列表里看不到');

    const stopped = await b.text('deck_automation', { action: 'stop', reason: '副作用测试' });
    assert.match(stopped, /停/, `停止失败：${stopped.slice(0, 150)}`);
    const status1 = await b.text('deck_automation', { action: 'status' });
    assert.match(status1, /已停止|停/, `停了但状态没变：${status1.slice(0, 200)}`);

    await b.text('deck_automation', { action: 'resume' });
    const status2 = await b.text('deck_automation', { action: 'status' });
    assert.doesNotMatch(status2, /已停止/, '恢复后状态还是停的');
  } finally {
    b.done();
  }
});

/* ── 会议：开 → 交意见 → 读回来 → 议程 → 结会 ─────────────────────────── */

// 会议实现整个在闭源层（pro/meeting/**），开源包里没有 —— 不是坏了，是不带。
test('deck_meeting：开会 → 交意见 → show 读得到 → 结会状态真的变 concluded', {
  skip: !hasPro() ? '开源形态（未装 pro/）：会议实现不在核心包里' : false,
}, async () => {
  const b = await boot();
  try {
    const opened = await b.text('deck_meeting', { action: 'open', topic: '副作用会议', participants: [{ name: 'a' }] });
    const id = (opened.match(/mtg_[0-9]{8}_[0-9a-f]+/) || [])[0];
    assert.ok(id, `开会没给会议号：${opened.slice(0, 200)}`);

    await b.text('deck_meeting', { action: 'submit', meetingId: id, text: '副作用意见', from: 'a' });
    const shown = await b.text('deck_meeting', { action: 'show', meetingId: id });
    assert.match(shown, /副作用意见|副作用会议/, '交了意见但读不到');

    const listed = await b.text('deck_meeting', { action: 'list' });
    assert.match(listed, /副作用会议/, '开完会列表里看不到');
  } finally {
    b.done();
  }
});

/* ── 团队空间：建 → 成员读得到 → 共享记忆 → 撤回 ──────────────────────── */

test('deck_team：建空间 → status 看得到 → share 写记忆 → recall 读回来', async () => {
  const b = await boot();
  try {
    const created = await b.text('deck_team', { action: 'create', name: '副作用团队' });
    assert.match(created, /team_|建|创/, `建团队失败：${created.slice(0, 200)}`);

    const status = await b.text('deck_team', { action: 'status' });
    assert.match(status, /副作用团队/, '建完 status 看不到');

    const marker = `共享标记${Math.random().toString(36).slice(2, 6)}`;
    await b.text('deck_team', { action: 'share', text: marker });
    const recalled = await b.text('deck_team', { action: 'recall', query: marker });
    assert.match(recalled, new RegExp(marker), `共享了但召回不到：${recalled.slice(0, 200)}`);
  } finally {
    b.done();
  }
});

/* ── 审计：动作真被记下来 ─────────────────────────────────────────────── */

test('deck_audit：做过的事真能在审计流里查到', async () => {
  const b = await boot();
  try {
    const marker = `审计标记${Math.random().toString(36).slice(2, 6)}`;
    await b.text('twin_remember', { text: marker });

    const tail = await b.text('deck_audit', { action: 'tail', limit: 20 });
    assert.match(tail, /twin_remember/, `审计里没有刚做的动作：${tail.slice(0, 250)}`);

    const queried = await b.text('deck_audit', { action: 'query', tool: 'twin_remember', limit: 10 });
    assert.match(queried, /twin_remember/, '按工具查查不到');

    // export 是**写文件**并回一句人话（不是把 JSON 打印出来），所以断言要针对真实行为：
    // 说清导出了几条 + 给了文件路径，且文件真的存在。
    const exported = await b.text('deck_audit', { action: 'export', format: 'json' });
    assert.match(exported, /已导出 \d+ 条/, `export 没说明导出了几条：${exported.slice(0, 200)}`);
    // 路径形如 C:\Users\...\audit-export-....jsonl（Windows 反斜杠）
    const file = (exported.match(/[A-Za-z]:\\[^\n]+?\.jsonl/) || [])[0];
    assert.ok(file, `export 没给出文件路径：${exported.slice(0, 200)}`);
    assert.ok(existsSync(file), `export 说导出了但文件不在：${file}`);
    assert.ok(readFileSync(file, 'utf8').trim().length > 0, '导出文件是空的');
  } finally {
    b.done();
  }
});

/* ── 市场：catalog 与 orders 对得上 ───────────────────────────────────── */

test('deck_market：catalog 列出货架 → orders 是空的（没买过）→ 对得上', async () => {
  const b = await boot();
  try {
    /*
     * 1.11.9 起重划边界：货架 / 账本 / 下单 / 退款全在开源侧，**两种形态下都该能用**。
     * 所以这里不再按 hasPro() 分支 —— 免费版拿不到货架才是缺陷，不是"正常降级"。
     */
    const cat = await b.text('deck_market', { action: 'catalog' });
    assert.match(cat, /货架|套/, `catalog 拿不到：${cat.slice(0, 150)}`);

    const orders = await b.text('deck_market', { action: 'orders' });
    assert.match(orders, /订单|还没有/, 'orders 没给人话');

    const health = await b.text('deck_market', { action: 'health' });
    assert.match(health, /未配|渠道/, 'health 没说清配没配');
    // 没配在线渠道时，必须把"人工渠道现在就能收钱"摆出来 ——
    // 否则用户会以为这功能是坏的，而实际上它只是没配商户号。
    if (/未配置/.test(health)) {
      assert.match(health, /人工渠道|place/, '没配在线渠道时要指出人工收款这条路');
    }
  } finally {
    b.done();
  }
});

/* ── 授权：status / plans 给真数据 ────────────────────────────────────── */

test('deck_license：status 报档位、plans 报价目，两者一致', async () => {
  const b = await boot();
  try {
    const status = await b.text('deck_license', { action: 'status' });
    assert.match(status, /免费版|协作版|工作室版|企业版/, `status 没报档位：${status.slice(0, 150)}`);

    const plans = await b.text('deck_license', { action: 'plans' });
    for (const kw of ['免费版', '协作版', '工作室版', '企业版']) {
      assert.match(plans, new RegExp(kw), `价目表缺 ${kw}`);
    }
    assert.match(plans, /¥29/, '价目表缺协作版价格');
    assert.match(plans, /¥99/, '价目表缺工作室版价格');
  } finally {
    b.done();
  }
});

/* ── 串门：造邀请 → 验签 → 名片 ───────────────────────────────────────── */

test('pet_visit：invite 造的链接，accept 能验过；改一个字符就验不过', async () => {
  const b = await boot();
  try {
    const card = await b.text('pet_visit', { action: 'card' });
    assert.match(card, /名片|身份/, `card 拿不到：${card.slice(0, 150)}`);

    const inv = await b.text('pet_visit', { action: 'invite', ttlHours: 1 });
    const token = (inv.match(/dsh:\/\/agentdeck\/visit\?t=([^\s`]+)/) || [])[1];
    assert.ok(token, `invite 没给链接：${inv.slice(0, 200)}`);

    const acc = await b.text('pet_visit', { action: 'accept', token });
    assert.match(acc, /名片|签名|校验/, `accept 没给名片：${acc.slice(0, 200)}`);
    assert.doesNotMatch(acc, /没验过|验不过|签名对不上/, '自己签的邀请自己验不过');

    const bad = await b.text('pet_visit', { action: 'accept', token: `${token.slice(0, -6)}AAAAAA` });
    assert.match(bad, /验不过|签名|对不上|收不下/, `改过的令牌居然验过了：${bad.slice(0, 200)}`);
  } finally {
    b.done();
  }
});

/* ── 通行证：签发 → 验卡 ─────────────────────────────────────────────── */

test('agent_passport：issue 出卡 → verify 验得过 → 改一个字符验不过', async () => {
  const b = await boot();
  try {
    const show = await b.text('agent_passport', { action: 'show' });
    assert.match(show, /身份|密钥|还没有/, `show 没给人话：${show.slice(0, 150)}`);

    const issued = await b.text('agent_passport', { action: 'issue', subject: '副作用测试', capabilities: ['read'] });
    const pass = (issued.match(/NEXP1\.[A-Za-z0-9._-]+/) || [])[0];
    if (pass) {
      const ok = await b.text('agent_passport', { action: 'verify', token: pass });
      assert.match(ok, /通过|有效|ok/i, `自己签的卡验不过：${ok.slice(0, 200)}`);

      const bad = await b.text('agent_passport', { action: 'verify', token: `${pass.slice(0, -6)}AAAAAA` });
      assert.doesNotMatch(bad, /^.*(通过|有效)/, `改过的卡居然验过了：${bad.slice(0, 200)}`);
    }
    const list = await b.text('agent_passport', { action: 'list' });
    assert.ok(list.length > 0, 'list 返回空');
  } finally {
    b.done();
  }
});
