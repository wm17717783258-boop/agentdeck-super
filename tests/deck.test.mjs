/**
 * 产品主页渲染测试（lib/deck.js）。
 *
 * 这一层测的是「页面怎么画」，不是「业务对不对」——vm 全是假数据，
 * 所以这些用例可以在没有宿主、没有磁盘、没有授权的情况下跑。
 *
 * 重点守的三条：
 *   1) 自包含：一个外部 URL 都不许有（离线/内网也要能开，这是本地优先的底线）
 *   2) 转义：用户可控的字符串（任务标题、宠物名、皮肤名）必须转义干净
 *   3) 空状态：什么都没的时候页面也得像产品，不能是白板或者 undefined
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckPageHtml, __test__ } from '../lib/deck.js';

const { esc, money, ago, num0 } = __test__;

const SPRITE = '<svg viewBox="0 0 64 64"><rect width="64" height="64"/></svg>';

/** 一份"什么都有一点"的 view-model：付费档 + 有任务 + 有皮肤 + 有卡包 + 有宿主 */
function fullVm(over = {}) {
  return {
    version: '1.9.0',
    actPath: '/deck/act',
    license: {
      tier: 'studio',
      label: '工作室版',
      exp: '2027-11-05',
      maxSeats: 30,
      cloudRooms: 20,
      describe: '',
      reason: '',
      path: 'C:/Users/x/.dsh/agentdeck-super/license.key',
    },
    board: {
      totals: { teams: 2, pending: 1, running: 1, done: 3, failed: 0, total: 5 },
      latest: [
        { id: 't1', title: '把 Nexi 发给同事试试', status: 'done', updatedAt: Date.now() - 3600_000 },
        { id: 't2', title: '给桌宠换一套皮肤', status: 'running', updatedAt: Date.now() - 60_000 },
      ],
    },
    pet: {
      name: '小犀',
      skin: 'basic',
      habits: [{ label: '喜欢先看结果', evidence: 7 }],
      tasksDone: 12,
      tasksAdded: 9,
      activeDays: 4,
      memoryCount: 23,
      state: 'idle',
      stateLabel: '发呆中',
    },
    petSprite: SPRITE,
    skins: [
      { id: 'basic', name: '原生', author: '官方', price: 0, currency: 'CNY', owned: true, active: true, preview: SPRITE },
      { id: 'ink', name: '水墨', author: '官方', price: 0, currency: 'CNY', owned: true, active: false, preview: SPRITE },
      { id: 'aurora', name: '极光', author: '官方商店', price: 1900, currency: 'CNY', owned: false, active: false, preview: SPRITE },
    ],
    passport: {
      enabled: true,
      kid: 'kid_7f3a91',
      cards: [{ name: '小犀', agent: 'dsh', capabilities: ['写代码', '查资料', '跑测试', '写文档'] }],
    },
    mcp: {
      hosts: [
        { name: 'Claude Code', installed: true, registered: true, path: '/home/u/.claude.json' },
        { name: 'Cursor', installed: false, registered: false, path: '' },
      ],
    },
    flash: null,
    toolCount: 18,
  quota: {
    tier: 'free',
    tierLabel: '免费版',
    items: [
      { kind: 'rooms', label: '云房间', used: 0, limit: 0, unlimited: false },
      { kind: 'meetings', label: '会议', used: 2, limit: 3, unlimited: false },
      { kind: 'automations', label: '自动化', used: 0, limit: 3, unlimited: false },
      { kind: 'twinEntries', label: '记忆', used: 7, limit: 200, unlimited: false },
      { kind: 'seats', label: '席位', used: 1, limit: 1, unlimited: false },
    ],
    upgradeTo: 'plus',
    upgradeLabel: 'PLUS',
  },
    ...over,
  };
}

// ── 1. 骨架 ─────────────────────────────────────────────────────────────────

test('渲染出完整 HTML 文档', () => {
  const html = deckPageHtml(fullVm());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<\/html>$/);
  assert.match(html, /<title>Nexi 灵犀<\/title>/);
  assert.ok(html.length > 4000, `页面太短了：${html.length}`);
});

test('六块都画出来了：桌宠、任务板、皮肤、卡包、接入、页脚', () => {
  const html = deckPageHtml(fullVm());
  for (const [name, needle] of [
    ['桌宠精灵', SPRITE],
    ['今日统计', '完成任务'],
    ['任务板', '任务板'],
    ['皮肤区', '皮肤'],
    ['卡包', '卡包'],
    ['接入表', '接入其他 Agent'],
    ['页脚', '开发者测试台'],
  ]) {
    assert.ok(html.includes(needle), `少了${name}`);
  }
});

test('品牌栏显示版本号和档位名', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('v1.9.0'));
  assert.ok(html.includes('工作室版'));
  assert.ok(html.includes('到期 2027-11-05'));
});

// ── 2. 自包含（离线可用）────────────────────────────────────────────────────

test('零外部依赖：没有 CDN、外链、fetch、script src', () => {
  const html = deckPageHtml(fullVm());
  assert.equal((html.match(/https?:\/\//g) || []).length, 0, '页面里出现了绝对 URL');
  assert.equal((html.match(/<script/gi) || []).length, 0, '页面里出现了 <script>（应该是纯 HTML+CSS）');
  assert.equal((html.match(/\bfetch\s*\(/g) || []).length, 0, '页面里出现了 fetch(');
  assert.equal((html.match(/<link\b/gi) || []).length, 0, '页面里出现了 <link>（外部样式/字体）');
  assert.equal((html.match(/@import/g) || []).length, 0, 'CSS 里出现了 @import');
});

test('内联 CSS 存在且没有未闭合的 style 标签', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('<style>'));
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.ok(html.includes('</style>'));
});

// ── 3. 转义 ─────────────────────────────────────────────────────────────────

test('任务标题里的 HTML 被转义（不能注入）', () => {
  const html = deckPageHtml(fullVm({
    board: {
      totals: { teams: 1, total: 1, done: 0, running: 0, failed: 0, pending: 1 },
      latest: [{ id: 'x', title: '<img src=x onerror=alert(1)>', status: 'pending', updatedAt: Date.now() }],
    },
  }));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'), '原始标签漏出去了');
});

test('皮肤名 / 宠物名 / 档位名里的引号也转义', () => {
  const html = deckPageHtml(fullVm({
    pet: { ...fullVm().pet, name: '小"犀' },
    license: { ...fullVm().license, label: '工作"室' },
    skins: [{ id: 'evil', name: '<b>免费</b>', author: '"官方"', price: 0, owned: true, active: false, preview: '' }],
  }));
  assert.ok(!html.includes('<b>免费</b>'), '皮肤名没转义');
  assert.ok(html.includes('&lt;b&gt;免费&lt;/b&gt;'));
  assert.ok(html.includes('小&quot;犀'));
});

test('esc() 覆盖五类字符', () => {
  assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

// ── 4. 桌宠五状态 ───────────────────────────────────────────────────────────

test('桌宠五种状态都能渲染出对应的 pill 样式', () => {
  for (const [state, label] of [
    ['idle', '发呆中'], ['working', '干活中'], ['meeting', '开会中'],
    ['visiting', '串门中'], ['sleeping', '睡觉了'],
  ]) {
    const html = deckPageHtml(fullVm({ pet: { ...fullVm().pet, state, stateLabel: label } }));
    assert.ok(html.includes(`state-pill ${state}`), `${state} 状态的样式类没出来`);
    assert.ok(html.includes(label), `${state} 状态的中文没出来`);
  }
});

test('没有桌宠精灵时退化成占位符，不崩', () => {
  const html = deckPageHtml(fullVm({ petSprite: '' }));
  assert.ok(html.includes('sprite-fallback'));
  assert.ok(!html.includes('undefined'));
});

test('没有习惯时给「还在观察你」而不是空列表', () => {
  const html = deckPageHtml(fullVm({ pet: { ...fullVm().pet, habits: [] } }));
  assert.ok(html.includes('还在观察你'));
  assert.ok(!html.includes('undefined'));
});

test('统计数字给的是真实值，缺字段退化成 0', () => {
  const html = deckPageHtml(fullVm({ pet: {} }));
  assert.ok(html.includes('>12<') === false, '空 pet 不该出现 12');
  assert.ok(!/NaN|undefined/.test(html), '页面上出现了 NaN 或 undefined');
});

// ── 5. 任务板 ───────────────────────────────────────────────────────────────

test('任务板显示进度百分比和状态标签', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('完成度 60%'), '5 条 3 完成应该是 60%');
  assert.ok(html.includes('tag done'));
  assert.ok(html.includes('tag running'));
  assert.ok(html.includes('>已完成<'));
});

test('空任务板给出「怎么开始」而不是冷冰冰一句没有', () => {
  const html = deckPageHtml(fullVm({
    board: { totals: { teams: 0, total: 0, done: 0, running: 0, failed: 0, pending: 0 }, latest: [] },
  }));
  assert.ok(html.includes('还没有任务'));
  assert.ok(html.includes('人和 Agent 共用的同一张纸'), '缺少引导文案');
  assert.ok(html.includes('完成度 0%'));
});

test('任务板里有加任务表单且指向 /deck/act', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('name="task-add__title"'));
  assert.ok(html.includes('action="/deck/act"'));
  assert.ok(html.includes('name="__id" value="task-add"'));
});

// ── 6. 皮肤店 ───────────────────────────────────────────────────────────────

test('拥有的皮肤给「换上」，正在用的给「正在用」', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('正在用'));
  assert.ok(html.includes('name="skin-activate__id"'));
});

test('没拥有的皮肤显示价格和「买」按钮，不给「换上」', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('¥19'), '付费皮肤应该显示 ¥19');
  assert.ok(html.includes('name="skin-buy__id"'), '付费皮肤应该给购买按钮（走 deck_market 真下单）');
  assert.ok(html.includes('locked'), '付费皮肤卡片要有 locked 标记');
  assert.ok(!html.includes('skin-state lock'), '价格不该再是纯文本标签，得能点');
});

test('没配支付渠道时，皮肤区明说「不会扣钱」而不是装能买', () => {
  const html = deckPageHtml(fullVm({ pay: { configured: false, provider: '' } }));
  assert.ok(html.includes('环境未配'), '未配渠道要如实写环境未配');
  assert.ok(html.includes('不会扣钱'), '要说清点了不会扣钱');
  assert.ok(!html.includes('真实收款页'), '没配渠道时不许写"会跳到真实收款页"');
});

test('配好支付渠道时，皮肤区说清「收到钱才发皮肤」', () => {
  const html = deckPageHtml(fullVm({ pay: { configured: true, provider: 'stripe' } }));
  assert.ok(html.includes('stripe'));
  assert.ok(html.includes('真实收款页'));
  assert.ok(!html.includes('环境未配'), '配好了就不该再说环境未配');
});

test('没有皮肤时整块不渲染（不留空壳）', () => {
  const html = deckPageHtml(fullVm({ skins: [] }));
  assert.ok(!html.includes('class="skin-grid"'), '空皮肤列表不该渲染出网格容器');
});

// ── 7. 卡包 ─────────────────────────────────────────────────────────────────

test('卡包显示 kid 和已签出的卡的能力', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('kid_7f3a91'));
  assert.ok(html.includes('写代码'));
  assert.ok(html.includes('…'), '能力超过 3 个应该省略');
});

test('没有身份时说明「签第一张卡时自动生成」，不假装有', () => {
  const html = deckPageHtml(fullVm({ passport: { enabled: true, kid: '', cards: [] } }));
  assert.ok(html.includes('签第一张卡时自动生成'));
});

test('通行证模块没加载时整块隐藏', () => {
  const html = deckPageHtml(fullVm({ passport: { enabled: false, kid: '', cards: [] } }));
  assert.ok(!html.includes('卡包'));
});

// ── 8. 接入表 ───────────────────────────────────────────────────────────────

test('宿主状态三态如实显示，不写「全兼容」', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('已接入'));
  assert.ok(html.includes('未安装'));
  assert.ok(!html.includes('全兼容'));
  assert.ok(html.includes('dot ok'));
  assert.ok(html.includes('dot off'));
});

test('已安装未接入是中间态（warn），不是「已接入」', () => {
  const html = deckPageHtml(fullVm({
    mcp: { hosts: [{ name: 'Windsurf', installed: true, registered: false, path: '/x/config.json' }] },
  }));
  assert.ok(html.includes('已安装·未接入'));
  assert.ok(html.includes('dot warn'));
});

test('只在 PATH 上找到 CLI（还没生成配置文件）时说清依据，且是待办黄灯不是完成绿灯', () => {
  // 真机场景：Gemini CLI 装了、`gemini mcp list` 也认，但 ~/.gemini/settings.json
  // 要第一次用才创建。以前这种会被判成「未安装」而漏掉一个宿主；
  // 现在判成已安装，但必须让人看得出依据只是 CLI，而不是配置文件。
  const html = deckPageHtml(fullVm({
    mcp: {
      hosts: [
        { name: 'Gemini CLI', installed: true, registered: false, path: '/u/.gemini/settings.json', detectedBy: 'cli' },
        { name: 'Claude Code', installed: true, registered: true, path: '/u/.claude.json', detectedBy: 'config' },
      ],
    },
  }));
  assert.ok(html.includes('只找到 CLI，还没生成配置文件'), '该说清探测依据');
  assert.ok(html.includes('已安装·未接入'));
  // 已接入那条才是绿灯；只找到 CLI 那条是黄灯
  assert.ok(html.includes('dot ok'));
  assert.ok(html.includes('dot warn'));
  // 有配置文件的宿主不该被贴上"只找到 CLI"的标签
  const codeRow = html.slice(html.indexOf('Claude Code'), html.indexOf('Claude Code') + 260);
  assert.ok(!codeRow.includes('只找到 CLI'), '有配置文件的宿主不该标成只找到 CLI');
});

test('只写了配置、宿主本身没装，也不算「已接入」（黄灯＋写清楚）', () => {
  const html = deckPageHtml(fullVm({
    mcp: { hosts: [{ name: 'Claude Desktop', installed: false, registered: true, path: '/x/claude_desktop_config.json' }] },
  }));
  assert.ok(html.includes('配置已写·宿主未装'));
  assert.ok(!html.includes('已接入'));
  assert.ok(html.includes('dot warn'));
});

// ── 9. 档位 / 升级 ──────────────────────────────────────────────────────────

test('免费档出现升级卡，付费档不出现', () => {
  const freeHtml = deckPageHtml(fullVm({ license: { tier: 'free', label: '免费版', exp: '', path: '/x/lic' } }));
  assert.ok(freeHtml.includes('你现在是免费版'));
  assert.ok(freeHtml.includes('粘贴授权码'));

  const paidHtml = deckPageHtml(fullVm());
  assert.ok(!paidHtml.includes('你现在是免费版'));
});

test('免费档强调「互操作永远免费」，不拿互通做付费墙', () => {
  const html = deckPageHtml(fullVm({ license: { tier: 'free', label: '免费版', exp: '' } }));
  assert.ok(html.includes('互操作永远免费'));
});

// ── 10. 提示条 ──────────────────────────────────────────────────────────────

test('成功后提示条是绿色的 ok', () => {
  const html = deckPageHtml(fullVm({ flash: { ok: true, text: '授权码已写入' } }));
  assert.ok(html.includes('class="ok"'));
  assert.ok(html.includes('授权码已写入'));
});

test('失败后提示条是红色的 bad', () => {
  const html = deckPageHtml(fullVm({ flash: { ok: false, text: '只读模式拦下了' } }));
  assert.ok(html.includes('class="bad"'));
  assert.ok(html.includes('只读模式拦下了'));
});

test('没有提示时不渲染提示条容器', () => {
  const html = deckPageHtml(fullVm({ flash: null }));
  assert.ok(!html.includes('class="ok"'));
  assert.ok(!html.includes('class="bad"'));
});

// ── 11. 工具函数 ────────────────────────────────────────────────────────────

test('money() 分转人民币，0 显示免费', () => {
  assert.equal(money(0), '免费');
  assert.equal(money(1900), '¥19');
  assert.equal(money(1250), '¥12.50');
  assert.equal(money(-5), '免费');
  assert.equal(money(NaN), '免费');
  assert.equal(money(500, 'USD'), '$5');
});

test('ago() 说人话', () => {
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  assert.equal(ago(now - 10_000, now), '刚刚');
  assert.equal(ago(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(ago(now - 3 * 3600_000, now), '3 小时前');
  assert.equal(ago(now - 24 * 3600_000, now), '昨天');
  assert.equal(ago(now - 5 * 24 * 3600_000, now), '5 天前');
  assert.equal(ago(0, now), '—');
});

test('num0() 把脏值都变 0，页面不会出现 NaN', () => {
  assert.equal(num0(undefined), 0);
  assert.equal(num0(null), 0);
  assert.equal(num0('abc'), 0);
  assert.equal(num0(Infinity), 0);
  assert.equal(num0('12'), 12);
  assert.equal(num0(-3), -3);
});

// ── 12. 整体健壮性 ──────────────────────────────────────────────────────────

test('传空对象也能渲染出一个不难看的页面', () => {
  const html = deckPageHtml({});
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('Nexi 灵犀'));
  assert.ok(!/NaN|undefined|\[object Object\]/.test(html));
});

test('完全不带参数也不炸', () => {
  const html = deckPageHtml();
  assert.ok(html.includes('Nexi 灵犀'));
});

test('脏数据不会让渲染抛异常', () => {
  const dirty = {
    license: null,
    board: { totals: 'oops', latest: 'nope' },
    pet: { habits: 'x', tasksDone: {} },
    skins: 'not-an-array',
    passport: { enabled: true, cards: 'x' },
    mcp: { hosts: null },
    petSprite: 123,
    flash: 'weird',
  };
  assert.doesNotThrow(() => deckPageHtml(dirty));
  assert.ok(!/NaN|undefined/.test(deckPageHtml(dirty)));
});

// ── 额度 ─────────────────────────────────────────────────────────────────

test('额度面板画出本机真实用量和这一档的上限', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('>额度<'), '应该有「额度」这一块');
  assert.ok(html.includes('云房间'), '要列云房间');
  assert.ok(html.includes('class="quota"'));
  assert.ok(html.includes('本机真实用量'), '要写清数的是真实用量');
  assert.ok(html.includes('PLUS'), '要给出升级目标档位');
});

test('点名到上限的那一行会被标出来，不假装还有余量', () => {
  const html = deckPageHtml(fullVm());
  assert.ok(html.includes('class="full"'), 'used >= limit 的那一行要有 full 标记');
});

test('最高档时不再劝人升级', () => {
  const html = deckPageHtml(fullVm({
    quota: {
      tier: 'business',
      tierLabel: 'BUSINESS',
      items: [{ kind: 'meetings', label: '会议', used: 3, limit: 0, unlimited: true }],
      upgradeTo: '',
      upgradeLabel: '',
    },
  }));
  assert.ok(html.includes('不限'), '不限额度要写「不限」而不是 0');
  assert.ok(!html.includes('想放开就升到'), '最高档不该再劝升级');
});

test('没有额度数据时整块不渲染（不留空壳）', () => {
  const html = deckPageHtml(fullVm({ quota: null }));
  assert.ok(!html.includes('class="quota"'));
});

// ── 自检（可选模块加载失败）────────────────────────────────────────────────

test('可选模块没加载起来时，把原因摆到页面上，不静默少一块', () => {
  const html = deckPageHtml(fullVm({ issues: ['配额模块加载失败：Cannot find module', '支付渠道加载失败：boom'] }));
  assert.ok(html.includes('>自检<'), '应该有一块「自检」');
  assert.ok(html.includes('配额模块加载失败'), '要写清楚哪块没起来');
  assert.ok(html.includes('其它功能照常'), '要说明不影响其它功能');
  assert.ok(!html.includes('undefined'));
});

test('没有加载问题时整块自检不渲染（正常情况页面不留噪音）', () => {
  const empty = deckPageHtml(fullVm({ issues: [] }));
  assert.ok(!empty.includes('>自检<'));
  const missing = deckPageHtml(fullVm({ issues: null }));
  assert.ok(!missing.includes('>自检<'));
});

test('自检最多摆 6 条，且空串/空白会被过滤掉', () => {
  const many = Array.from({ length: 9 }, (_, i) => `问题 ${i + 1}`);
  const html = deckPageHtml(fullVm({ issues: [...many, '   ', ''] }));
  assert.ok(html.includes('问题 6'));
  assert.ok(!html.includes('问题 7'), '超过 6 条的不显示，避免刷屏');
});

test('皮肤价格是「分」：1800 分要写 ¥18，不能写 ¥0.18', () => {
  const html = deckPageHtml(fullVm({
    skins: [{ id: 'premium-aurora', name: '极光', author: '官方', price: 1800, currency: 'CNY', owned: false, active: false, preview: '' }],
  }));
  assert.ok(html.includes('¥18'), '1800 分 = ¥18');
  assert.ok(!html.includes('¥0.18'), '少除一次 100 就会写成 ¥0.18');
});
