/**
 * 测试台（/deck/console）的单元测试。
 *
 * 这一页的意义是「用户能在宿主 GUI 里亲手点一下」，
 * 所以测试要盯着三件事：
 *   ① 表单能解成正确的工具调用（含必填校验、能力拆分）；
 *   ② 只读模式下写动作**在服务端**被拦住（页面置灰只是提示，不是闸门）；
 *   ③ 页面是自包含的（零外链），断网也开得起来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONSOLE_ACTIONS, consolePageHtml, parseConsoleSubmit } from '../lib/console.js';

const form = (obj) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
};

test('测试台：19 个动作覆盖 18 个工具里的主要能力，且每个都指向真工具名', () => {
  const items = CONSOLE_ACTIONS.flatMap((g) => g.items);
  assert.equal(items.length, 19);
  // 工具名必须是 Hub 真有的（这里挑出测试台用到的集合做白名单校验）
  const known = new Set([
    'team_board', 'agent_passport', 'twin_remember', 'twin_recall', 'twin_brief',
    'pet_skin', 'pet_visit', 'deck_meeting', 'deck_automation', 'deck_license', 'deck_room',
  ]);
  for (const it of items) {
    assert.ok(known.has(it.tool), `测试台引用了不存在的工具：${it.tool}`);
    assert.ok(it.id && it.label, '每个动作要有 id 和 label');
  }
  // id 不许重复（表单靠它路由）
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, '动作 id 有重复');
});

test('测试台：表单解成工具调用，留空字段保留动作默认值', () => {
  const r = parseConsoleSubmit(form({ __id: 'board-list' }));
  assert.equal(r.ok, true);
  assert.equal(r.tool, 'team_board');
  assert.deepEqual(r.args, { action: 'list' });

  const r2 = parseConsoleSubmit(form({ __id: 'pp-verify', 'pp-verify__card': 'NEXP1.abc.def' }));
  assert.equal(r2.ok, true);
  assert.equal(r2.args.action, 'verify');
  assert.equal(r2.args.card, 'NEXP1.abc.def');
});

test('测试台：必填项为空时给人话，不放进去看法报错', () => {
  const r = parseConsoleSubmit(form({ __id: 'board-create' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /name/);
  assert.match(r.error, /必填/);

  const r2 = parseConsoleSubmit(form({ __id: 'pp-verify' }));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /card/);
});

test('测试台：能力字段按逗号/空格拆成数组，不留空串', () => {
  const r = parseConsoleSubmit(form({
    __id: 'pp-issue',
    'pp-issue__name': '小犀',
    'pp-issue__capabilities': 'team_board, deck_meeting  twin_recall',
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.args.capabilities, ['team_board', 'deck_meeting', 'twin_recall']);
});

test('测试台：不认识的动作 id 会被拒绝（不猜、不静默当成默认动作）', () => {
  const r = parseConsoleSubmit(form({ __id: 'rm -rf /' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /不认识的测试台动作/);
  assert.equal(r.tool, '');
});

test('测试台：只读模式下写动作在页面上置灰，并写明原因', () => {
  const html = consolePageHtml({ version: '1.8.0', tools: ['team_board'], readOnly: true });
  assert.match(html, /只读模式/);
  // 被拦的动作必须 disabled，且给出理由
  assert.match(html, /class="act blocked"/);
  assert.match(html, /只读模式（mcp\.readOnly=true）下这个动作会改状态，已被拦下/);
  // 读动作不能被禁
  assert.match(html, /看任务板/);
});

test('测试台：非只读模式下没有 blocked 的动作', () => {
  const html = consolePageHtml({ version: '1.8.0', tools: ['team_board'], readOnly: false });
  assert.doesNotMatch(html, /class="act blocked"/);
  assert.doesNotMatch(html, /已被拦下/);
});

test('测试台：页面自包含——零外链、零 CDN、零 fetch（断网也开得起来）', () => {
  const html = consolePageHtml({ version: '1.8.0', tools: ['team_board', 'agent_passport'], readOnly: false });
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/, '不许引用任何外部地址');
  assert.doesNotMatch(html, /<script[^>]+src=/i, '不许引外部脚本');
  assert.doesNotMatch(html, /<link[^>]+href="http/i, '不许引外部样式');
  assert.doesNotMatch(html, /\bfetch\s*\(/, '这一页自己不发请求');
  assert.match(html, /<style>/, '样式内联');
});

test('测试台：结果显示原始返回，且参数与耗时都记下来（证明不是美化过的摘要）', () => {
  const html = consolePageHtml({
    version: '1.8.0',
    tools: ['team_board'],
    readOnly: false,
    result: { id: 'board-list', tool: 'team_board', args: '{"action":"list"}', text: '【team_board】3 个小组', ok: true, ms: 12 },
  });
  assert.match(html, /原始返回/);
  assert.match(html, /\{&quot;action&quot;:&quot;list&quot;\}/);
  assert.match(html, /12ms/);
  assert.match(html, /【team_board】3 个小组/);
});

test('测试台：返回内容里的 HTML 会被转义（不许把工具输出当代码执行）', () => {
  const html = consolePageHtml({
    version: '1.8.0',
    tools: [],
    readOnly: false,
    result: {
      id: 'x', tool: 't', args: '{}', ok: true, ms: 1,
      text: '<img src=x onerror=alert(1)> & <script>bad()</script>',
    },
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /&lt;img src=x/);
});

test('测试台：工具清单原样显示（证明"真有 18 个"不是写死的）', () => {
  const many = ['team_board', 'agent_join', 'agent_passport', 'team_orchestrate', 'super_agent'];
  const html = consolePageHtml({ version: '1.8.0', tools: many, readOnly: false });
  assert.match(html, /本机工具 <b>5<\/b> 个/);
  for (const t of many) assert.ok(html.includes(`<code>${t}</code>`), `清单里该有 ${t}`);
});
