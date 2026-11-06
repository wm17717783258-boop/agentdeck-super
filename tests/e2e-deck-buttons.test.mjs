/**
 * /deck 页面按钮真点：9 个表单逐个 POST，看 303 之后带回来的那句话说得到底对不对。
 *
 * 为什么要有这一层：页面上的按钮是用户唯一的入口。
 * "工具能调"不等于"按钮能用"——按钮走的是另一条路（POST 表单 → 303 → ?done=/?failed=）。
 * 这一层把每个按钮真按一遍，并且核对话术是否和真实结果一致（不许"点失败了还说成功"）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.NEXI_E2E_BASE || 'http://127.0.0.1:58399';

/** 按一个按钮：POST 表单 → 拿 303 的 Location → 解析出 done/failed 那句话。 */
async function press(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  const loc = res.headers.get('location') || '';
  const pick = (k) => {
    const m = loc.match(new RegExp(`[?&]${k}=([^&]*)`));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  };
  const url = new URL(loc || `${BASE}/deck`, BASE);
  return { status: res.status, location: loc, done: pick('done'), failed: pick('failed'), license: url.searchParams.get('license') };
}

const BUTTONS = [
  { name: '桌宠状态', path: '/deck/act', body: '__id=pet-state', expect: /皮肤|状态|发呆|干活/i },
  { name: '我的名片', path: '/deck/act', body: '__id=passport-card', expect: /名片|身份|桌宠/ },
  { name: '今日简报', path: '/deck/act', body: '__id=twin-brief', expect: /简报|分身|任务|记忆/ },
  { name: '串门邀请', path: '/deck/act', body: '__id=visit-invite', expect: /邀请|dsh:\/\// },
  { name: '加任务', path: '/deck/act', body: '__id=task-add&task-add__title=%E7%9C%9F%E7%82%B9%E6%B5%8B%E8%AF%95%E4%BB%BB%E5%8A%A1', expect: /任务|加/ },
  { name: '换上 basic', path: '/deck/act', body: '__id=skin-activate&skin-activate__id=basic', expect: /皮肤|原味|换上|启用/ },
  { name: '换上 ink', path: '/deck/act', body: '__id=skin-activate&skin-activate__id=ink', expect: /皮肤|水墨|换上|启用/ },
  { name: '买 ¥18', path: '/deck/act', body: '__id=skin-buy&skin-buy__id=premium-aurora', expect: /环境未配|未配置|渠道|¥/ },
  { name: '激活授权码（假码）', path: '/adbp/deck/license', body: 'key=ADSK1-bad', licenseExpect: 'bad' },
];

test('真宿主可达（不可达则整套跳过）', async (t) => {
  try {
    const r = await fetch(`${BASE}/deck`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    t.skip(`${BASE} 不可达`);
  }
});

for (const btn of BUTTONS) {
  test(`按钮「${btn.name}」真按一次：303 回来，且带回的话是对的`, async (t) => {
    let reachable = true;
    try {
      await fetch(`${BASE}/deck`, { signal: AbortSignal.timeout(5000) });
    } catch { reachable = false; }
    if (!reachable) { t.skip(`${BASE} 不可达`); return; }

    const r = await press(btn.path, btn.body);
    assert.equal(r.status, 303, `该 303 重定向，实际 ${r.status}（location=${r.location}）`);

    if (btn.licenseExpect) {
      assert.equal(r.license, btn.licenseExpect, `授权结果不对：${r.license}`);
      return;
    }

    // 不许"点了报失败"
    assert.ok(!r.failed, `按钮报失败了：${r.failed}`);
    assert.ok(r.done, `按钮没有带回任何结果（location=${r.location}）`);
    // 带回的话必须说清做了什么（用工具真实输出，不是空壳）
    assert.match(r.done, btn.expect, `带回的话跟预期对不上：「${r.done}」`);
    // 不许把异常塞进成功文案里
    assert.doesNotMatch(r.done, /运行失败|TypeError|undefined|\[object/);
  });
}

test('不认识的按钮 id：如实报错，不静默当成功', async (t) => {
  let reachable = true;
  try { await fetch(`${BASE}/deck`, { signal: AbortSignal.timeout(5000) }); } catch { reachable = false; }
  if (!reachable) { t.skip(`${BASE} 不可达`); return; }

  const r = await press('/deck/act', '__id=no-such-action-xyz');
  assert.equal(r.status, 303);
  assert.ok(r.failed, '不认识的按钮该报失败');
  assert.match(r.failed, /不认识/, `失败原因该说清：${r.failed}`);
});

test('按钮失败文案有长度上限（不许把整个内脏塞进 URL）', async (t) => {
  let reachable = true;
  try { await fetch(`${BASE}/deck`, { signal: AbortSignal.timeout(5000) }); } catch { reachable = false; }
  if (!reachable) { t.skip(`${BASE} 不可达`); return; }

  const r = await press('/deck/act', '__id=no-such-action-xyz');
  if (r.failed) assert.ok(r.failed.length <= 240, `失败文案太长（${r.failed.length}）：会被 URL 截断`);
});

test('「加任务」按钮在有多个小组时也要能加上（真机 bug：多于 1 个组就静默失败）', async (t) => {
  // 真机踩到的：页面上没有"选组"这一步，而机器上会越攒越多组。
  // 之前的实现只在"恰好 1 个组"时才自动补 teamId，多于 1 个就留空 →
  // 按钮回一句"当前没有绑定小组"，点了等于没点。真实用户一定会遇到。
  let reachable = true;
  try { await fetch(`${BASE}/deck`, { signal: AbortSignal.timeout(5000) }); } catch { reachable = false; }
  if (!reachable) { t.skip(`${BASE} 不可达`); return; }

  const marker = `按钮加的任务${Math.random().toString(36).slice(2, 6)}`;
  const r = await press('/deck/act', `__id=task-add&task-add__title=${encodeURIComponent(marker)}`);
  assert.equal(r.status, 303);
  assert.ok(!r.failed, `按钮报失败了：${r.failed}`);
  // 按钮的回执只说"已添加任务 <id>"（不回声标题，这是设计如此），
  // 所以要验的是**任务真的落盘了**——拿 id 回去查，标题对得上才算数。
  assert.match(r.done, /已添加任务|task_/, `按钮没真的加上任务：${r.done}`);
  assert.doesNotMatch(r.done, /没有绑定小组/, '又回到"没有绑定小组"了——多于 1 个组时必须自动选一个');

  const taskId = (r.done.match(/task_[0-9a-f]{8,}/) || [])[0];
  assert.ok(taskId, `回执里没有任务 id：${r.done}`);

  // 用 teams 列出所有组，逐个查，找到这条任务并核对标题
  const teamsRes = await fetch(`${BASE}/v1/tools/team_board`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'teams' }), signal: AbortSignal.timeout(20000),
  }).then((x) => x.json());
  const ids = [...String(teamsRes?.text || '').matchAll(/team_[0-9a-f]{8,}/g)].map((m) => m[0]);
  assert.ok(ids.length, `没列出任何小组：${String(teamsRes?.text || '').slice(0, 150)}`);

  let found = false;
  for (const teamId of ids) {
    const listRes = await fetch(`${BASE}/v1/tools/team_board`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list', teamId }), signal: AbortSignal.timeout(20000),
    }).then((x) => x.json());
    const text = String(listRes?.text || '');
    if (text.includes(taskId) && text.includes(marker)) { found = true; break; }
  }
  assert.ok(found, `按钮说加上了 ${taskId}，但翻遍所有小组都找不到标题为「${marker}」的任务`);
});
