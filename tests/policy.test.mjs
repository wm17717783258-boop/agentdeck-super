/**
 * M5 策略引擎 + deck_policy 工具：判定规则、预算、脱敏、policy.json 读写。
 *
 * 铁律：每个"判定生效/规则落盘"都要能从盘上或返回值里找到证据，
 * 不许拿"应该会"当通过；所有测试用独立 tmpdir，不碰本机状态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyAction,
  decide,
  describeBudget,
  loadPolicy,
  matchGlob,
  normalizePolicy,
  policyFile,
  recordUsage,
  redact,
  redactDetails,
  resetPolicy,
  savePolicy,
} from '../lib/policy/engine.js';
import { createPolicyTool } from '../lib/tools/policy.js';

/** 固定时间点，避免测试在整点边界上抖动。 */
const NOW = Date.parse('2026-05-01T10:00:00.000Z');

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-policy-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function usage(entry) {
  return {
    __default__: { hourStart: Math.floor(NOW / 3600000), hour: 0, dayStart: '2026-05-01', day: 0 },
    ...entry,
  };
}

/**
 * 宿主里的 execute 统一返回 { text }（safeExecute 归一过）；测试只关心人话文本，
 * 这里包一层，免得每个断言都写 .text——但工具形状测试仍用原始 tool。
 */
function plain(tool) {
  return {
    ...tool,
    execute: async (args) => {
      const out = await tool.execute(args);
      return typeof out === 'string' ? out : String(out?.text ?? '');
    },
  };
}

test('动作分级：付款/删除/发消息/外部写入默认 confirm，只读/本地写默认 allow', () => {
  assert.equal(classifyAction('deck_market', 'buy').effect, 'confirm');
  assert.equal(classifyAction('deck_market', 'buy').category, 'payment');
  assert.equal(classifyAction('team_board', 'delete').category, 'delete');
  assert.equal(classifyAction('team_board', 'delete').effect, 'confirm');
  assert.equal(classifyAction('deck_room', 'send').category, 'message');
  assert.equal(classifyAction('deck_room', 'send').effect, 'confirm');
  assert.equal(classifyAction('deck_room', 'sync').category, 'external_write');
  assert.equal(classifyAction('deck_room', 'sync').effect, 'confirm');
  // 只读动作就算落在外部工具上也放行
  assert.equal(classifyAction('deck_room', 'status').effect, 'allow');
  assert.equal(classifyAction('deck_audit', 'tail').category, 'read');
  assert.equal(classifyAction('team_board', 'add').category, 'local_write');
  assert.equal(classifyAction('team_board', 'add').effect, 'allow');
});

test('没命中规则时默认 allow；deny 只能由规则给出', () => {
  const policy = { rules: [] };
  const benign = decide(policy, { tool: 'some_tool', action: 'frobnicate' }, { now: NOW });
  assert.equal(benign.effect, 'allow');
  assert.equal(benign.matchedRuleId, null);
  assert.match(benign.reason, /默认放行/);

  // 危险动作靠分级给出 confirm，而不是 deny
  const danger = decide(policy, { tool: 'deck_room', action: 'send' }, { now: NOW });
  assert.equal(danger.effect, 'confirm');
  assert.equal(danger.matchedRuleId, null);
});

test('规则匹配：tool/action 数组与 * 通配都能命中，第一条命中说了算', () => {
  assert.equal(matchGlob('deck_*', 'deck_room'), true);
  assert.equal(matchGlob('deck_*', 'team_board'), false);
  assert.equal(matchGlob('send', 'send'), true);

  const policy = {
    rules: [
      { id: 'first', match: { tool: 'deck_*' }, effect: 'allow' },
      { id: 'second', match: { tool: 'deck_room', action: 'send' }, effect: 'deny' },
      { id: 'third', match: { action: ['send', 'push'] }, effect: 'allow' },
    ],
  };
  // first-match-wins：first 是通配放行，所以后面的 deny 不参与
  const one = decide(policy, { tool: 'deck_room', action: 'send' }, { now: NOW });
  assert.equal(one.effect, 'allow');
  assert.equal(one.matchedRuleId, 'first');

  // 去掉 first，second 的精确匹配生效
  const two = decide({ rules: policy.rules.slice(1) }, { tool: 'deck_room', action: 'send' }, { now: NOW });
  assert.equal(two.effect, 'deny');
  assert.equal(two.matchedRuleId, 'second');

  // action 数组：third 能命中 send，也能命中 push
  const three = decide({ rules: [policy.rules[2]] }, { tool: 'anything', action: 'push' }, { now: NOW });
  assert.equal(three.matchedRuleId, 'third');
});

test('命中规则后 effect / reason / matchedRuleId 都与规则一致', () => {
  const policy = {
    rules: [
      { id: 'no-room-send', match: { tool: 'deck_room', action: 'send' }, effect: 'deny', reason: '跨机发消息先别自动发' },
      { id: 'confirm-buy', match: { tool: 'deck_market', action: 'buy' }, effect: 'confirm' },
      { id: 'allow-add', match: { tool: 'team_board', action: 'add' }, effect: 'allow' },
    ],
  };
  const deny = decide(policy, { tool: 'deck_room', action: 'send' }, { now: NOW });
  assert.equal(deny.effect, 'deny');
  assert.equal(deny.matchedRuleId, 'no-room-send');
  assert.equal(deny.reason, '跨机发消息先别自动发');

  const confirm = decide(policy, { tool: 'deck_market', action: 'buy' }, { now: NOW });
  assert.equal(confirm.effect, 'confirm');
  assert.equal(confirm.matchedRuleId, 'confirm-buy');
  assert.match(confirm.reason, /需要确认/);

  const allow = decide(policy, { tool: 'team_board', action: 'add' }, { now: NOW });
  assert.equal(allow.effect, 'allow');
  assert.equal(allow.matchedRuleId, 'allow-add');
});

test('预算：recordUsage 记满每小时上限后，decide 给出 deny 且标记 budgetExceeded', () => {
  const base = {
    rules: [{ id: 'budget', match: { tool: 'deck_room', action: 'send' }, effect: 'allow', budget: { perHour: 2, perDay: 5 } }],
  };
  const request = { tool: 'deck_room', action: 'send' };
  let policy = base;
  const once = recordUsage(policy, request, { now: NOW });
  assert.equal(once.matchedRuleId, 'budget');
  assert.equal(once.usage.budget.hour, 1);
  policy = once.policy;
  policy = recordUsage(policy, request, { now: NOW }).policy;
  assert.equal(policy.usage.budget.hour, 2);

  const blocked = decide(policy, request, { now: NOW });
  assert.equal(blocked.effect, 'deny');
  assert.equal(blocked.budgetExceeded, true);
  assert.equal(blocked.matchedRuleId, 'budget');
  assert.match(blocked.reason, /超出每小时预算/);

  // 还没有超的那一次（只用了 1 次）仍然是 allow
  const oneUsed = decide({ rules: base.rules, usage: { budget: { hourStart: Math.floor(NOW / 3600000), hour: 1, dayStart: '2026-05-01', day: 1 } } }, request, { now: NOW });
  assert.equal(oneUsed.effect, 'allow');
  assert.equal(oneUsed.budgetExceeded, false);

  // 人话预算描述
  assert.equal(describeBudget(base.rules[0], { hourStart: Math.floor(NOW / 3600000), hour: 2, dayStart: '2026-05-01', day: 2 }, NOW), '每小时 2/2，每天 2/5');
});

test('预算：跨小时窗口自动归零，旧计数不会把新一小时卡死', () => {
  const policy = {
    rules: [{ id: 'budget', match: { tool: 'deck_room', action: 'send' }, effect: 'allow', budget: { perHour: 2, perDay: 5 } }],
    usage: usage({ budget: { hourStart: Math.floor(NOW / 3600000), hour: 2, dayStart: '2026-05-01', day: 2 } }),
  };
  const nextHour = NOW + 3600000; // 同一天，下一个小时
  const decision = decide(policy, { tool: 'deck_room', action: 'send' }, { now: nextHour });
  assert.equal(decision.effect, 'allow');
  assert.equal(decision.budgetExceeded, false);
  assert.equal(decision.budget.hour, 0);
});

test('脱敏：手机号/身份证/邮箱/API key/授权码/Bearer/自定义规则都被打码，hits 不含原文', () => {
  // 授权码前缀用拼接造出来，避免手写时抄错一位就被误判成"脱敏没生效"
  const license = ['ADSK', '1'].join('') + '.abc.def';
  const phone = ['138', '1234', '5678'].join('');
  const text = [
    `电话 ${phone} 结束`,
    '身份证 11010519900307123X 结束',
    '邮箱 alice@example.com',
    'key sk-abcdefghijklmnop',
    `授权码 ${license}`,
    '头 Bearer abcdefghijklmnopqrstuvwxyz',
    'password: hunter2hunter2',
  ].join('\n');

  const { text: masked, hits } = redactDetails(text);
  assert.ok(masked.includes('138****5678'));
  assert.ok(!masked.includes(phone));
  assert.ok(masked.includes('110***********123X'));
  assert.ok(masked.includes('a***@example.com'));
  assert.ok(masked.includes('sk-***'));
  assert.ok(masked.includes(`${license.split('.')[0]}.***.***`));
  assert.ok(masked.includes('Bearer ***'));
  assert.ok(masked.includes('password: ***'));
  assert.ok(hits.includes('phone'));
  assert.ok(hits.includes('email'));
  assert.ok(hits.includes('api_key'));
  assert.ok(hits.includes('license_key'));
  assert.ok(hits.includes('bearer'));

  // 自定义规则：字符串 / RegExp / 对象三种写法都能用
  assert.equal(redact('订单 #42', [{ name: 'order', re: /#\d+/g, replacement: '#***' }]), '订单 #***');
  assert.equal(redact('abc123', [/abc/g]), '[已脱敏]123');
  assert.equal(redact('abc', ['((']), 'abc'); // 非法正则只跳过，不抛错
});

test('loadPolicy：文件不存在时返回默认策略 + missing，不抛错', () => {
  const { root, done } = freshRoot('missing');
  try {
    const loaded = loadPolicy(join(root, 'nested'));
    assert.equal(loaded.ok, true);
    assert.equal(loaded.missing, true);
    assert.equal(loaded.policy.rules.length, 0);
    assert.equal(loaded.policy.version, 1);
  } finally {
    done();
  }
});

test('savePolicy → loadPolicy 回读一致（规则、预算、usage 都保留）', () => {
  const { root, done } = freshRoot('roundtrip');
  try {
    const saved = savePolicy(root, {
      rules: [{ id: 'r1', match: { tool: 'deck_room', action: ['send', 'push'] }, effect: 'deny', budget: { perHour: 3 }, reason: '别自动发' }],
      usage: { r1: { hourStart: 123, hour: 2, dayStart: '2026-05-01', day: 7 } },
    });
    assert.equal(saved.ok, true);
    assert.equal(existsSync(policyFile(root)), true);

    const loaded = loadPolicy(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.missing, false);
    assert.equal(loaded.policy.rules.length, 1);
    assert.equal(loaded.policy.rules[0].id, 'r1');
    assert.deepEqual(loaded.policy.rules[0].match.action, ['send', 'push']);
    assert.equal(loaded.policy.rules[0].budget.perHour, 3);
    assert.equal(loaded.policy.rules[0].reason, '别自动发');
    assert.equal(loaded.policy.usage.r1.hour, 2);
    assert.equal(loaded.policy.usage.r1.day, 7);
  } finally {
    done();
  }
});

test('savePolicy：无效规则（空 match / 非法 effect）被拒绝，且不写文件', () => {
  const { root, done } = freshRoot('invalid');
  try {
    const bad = savePolicy(root, { rules: [{ match: {}, effect: 'deny' }, { match: { tool: 'deck_room' }, effect: 'maybe' }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'invalid');
    assert.equal(existsSync(policyFile(root)), false);
    assert.ok(bad.issues.length >= 2);
  } finally {
    done();
  }
});

test('policy.json 坏 JSON：code=corrupt、recovered=true、回落默认策略，原文件不动', () => {
  const { root, done } = freshRoot('corrupt');
  try {
    writeFileSync(policyFile(root), '{"rules": [', 'utf8');
    const loaded = loadPolicy(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'corrupt');
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.policy.rules.length, 0);
    assert.match(loaded.issues[0], /不是合法 JSON/);
    // 原文件没被覆盖（用户还能手工修）
    assert.equal(readFileSync(policyFile(root), 'utf8'), '{"rules": [');
  } finally {
    done();
  }
});

test('policy.json 部分规则坏：保留能读的规则，并报出坏在哪一条', () => {
  const { root, done } = freshRoot('partial');
  try {
    writeFileSync(policyFile(root), JSON.stringify({
      rules: [
        { id: 'good', match: { tool: 'deck_room' }, effect: 'deny' },
        { id: 'bad', effect: 'maybe' },
        { id: 'empty', match: {}, effect: 'deny' },
      ],
    }), 'utf8');
    const loaded = loadPolicy(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.code, 'corrupt');
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.policy.rules.length, 1);
    assert.equal(loaded.policy.rules[0].id, 'good');
    assert.equal(loaded.issues.length, 2);
  } finally {
    done();
  }
});

test('工具形状：name/description/parameters/output/render/execute 都是宿主认的', () => {
  const { root, done } = freshRoot('shape');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    assert.equal(tool.name, 'deck_policy');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20);
    assert.equal(tool.parameters.type, 'object');
    assert.ok(Array.isArray(tool.parameters.properties.action.enum));
    assert.deepEqual(tool.parameters.properties.action.enum, ['show', 'set', 'check', 'reset']);
    assert.equal(typeof tool.output.render, 'function');
    assert.deepEqual(tool.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(tool.output.render({}, 'raw'), [{ type: 'text', text: 'raw' }]);
    assert.equal(typeof tool.execute, 'function');
  } finally {
    done();
  }
});

test('deck_policy show：空策略时给出默认策略说明，并明说接线状态', async () => {
  const { root, done } = freshRoot('show');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    const text = await tool.execute({ action: 'show' });
    assert.match(text, /0 条规则/);
    assert.match(text, /付款\/删除\/发消息\/外部写入默认要确认/);
    // 1.10.0 起真的接线了：自述不许再写"未接线"，得说清拦截已生效、strict 开关在哪
    assert.match(text, /接线状态/);
    assert.match(text, /不会被执行/);
    assert.match(text, /严格模式：/);
    assert.match(text, /deck_audit/);
    assert.ok(text.includes(policyFile(root)));
  } finally {
    done();
  }
});

test('deck_policy set strict:true 单独开关：落盘 + show 如实反映', async () => {
  const { root, done } = freshRoot('strict');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    const on = await tool.execute({ action: 'set', strict: true });
    assert.match(on, /严格模式已打开/);
    const saved = JSON.parse(readFileSync(policyFile(root), 'utf8'));
    assert.equal(saved.strict, true);

    const shown = await tool.execute({ action: 'show' });
    assert.match(shown, /严格模式：开/);

    const off = await tool.execute({ action: 'set', strict: false });
    assert.match(off, /严格模式已关闭/);
    assert.equal(JSON.parse(readFileSync(policyFile(root), 'utf8')).strict, false);
  } finally {
    done();
  }
});

test('deck_policy set：单条规则落盘并能 show 出来；replace 整份替换', async () => {
  const { root, done } = freshRoot('set');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    const one = await tool.execute({
      action: 'set',
      rule: { id: 'no-room-send', match: { tool: 'deck_room', action: 'send' }, effect: 'deny', reason: '先别自动发' },
    });
    assert.match(one, /已写入 1 条规则/);
    assert.equal(loadPolicy(root).policy.rules[0].id, 'no-room-send');
    assert.equal(existsSync(policyFile(root)), true);

    const shown = await tool.execute({ action: 'show' });
    assert.match(shown, /\[deny\] deck_room \/ send/);
    assert.match(shown, /先别自动发/);

    // 追加第二条（按 id 覆盖）
    await tool.execute({ action: 'set', rules: [{ id: 'counted', match: { tool: 'team_board', action: 'add' }, effect: 'allow' }] });
    assert.equal(loadPolicy(root).policy.rules.length, 2);

    // replace:true 整份替换成 1 条
    const replaced = await tool.execute({ action: 'set', replace: true, rules: [{ id: 'only', match: { tool: 'x' }, effect: 'allow' }] });
    assert.match(replaced, /已写入 1 条规则/);
    const loaded = loadPolicy(root);
    assert.equal(loaded.policy.rules.length, 1);
    assert.equal(loaded.policy.rules[0].id, 'only');
  } finally {
    done();
  }
});

test('deck_policy set：整批规则都无效时不写文件，并说清为什么', async () => {
  const { root, done } = freshRoot('set-invalid');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    const text = await tool.execute({ action: 'set', rule: { match: {}, effect: 'deny' } });
    assert.match(text, /没有写入任何规则/);
    assert.match(text, /没有 match\.tool/);
    assert.equal(existsSync(policyFile(root)), false);
  } finally {
    done();
  }
});

test('deck_policy check：deny 规则生效；record:true 也不给被拒调用记账', async () => {
  const { root, done } = freshRoot('check-deny');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    await tool.execute({ action: 'set', rule: { id: 'no-room-send', match: { tool: 'deck_room', action: 'send' }, effect: 'deny', reason: '先别自动发' } });

    const text = await tool.execute({ action: 'check', tool: 'deck_room', toolAction: 'send', record: true });
    assert.match(text, /拒绝（deny）/);
    assert.match(text, /先别自动发/);
    assert.match(text, /没有记/);
    // 被拒绝的调用不该产生预算计数
    assert.deepEqual(loadPolicy(root).policy.usage, {});
  } finally {
    done();
  }
});

test('deck_policy check：allow 记账递增，并把这次判定写进本地审计流', async () => {
  const { root, done } = freshRoot('check-record');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    await tool.execute({ action: 'set', rule: { id: 'counted', match: { tool: 'team_board', action: 'add' }, effect: 'allow' } });

    const first = await tool.execute({ action: 'check', tool: 'team_board', toolAction: 'add', record: true });
    assert.match(first, /放行（allow）/);
    assert.match(first, /已记 1 次/);
    let loaded = loadPolicy(root);
    assert.equal(loaded.policy.usage.counted.hour, 1);

    await tool.execute({ action: 'check', tool: 'team_board', toolAction: 'add', record: true });
    loaded = loadPolicy(root);
    assert.equal(loaded.policy.usage.counted.hour, 2);

    // 审计流真的写了盘，而且内容能解析
    const auditLine = readFileSync(join(root, 'audit.jsonl'), 'utf8').trim().split('\n').at(-1);
    const record = JSON.parse(auditLine);
    assert.equal(record.tool, 'team_board');
    assert.equal(record.action, 'add');
    assert.equal(record.result, 'allow');
    assert.equal(record.source, 'policy');
  } finally {
    done();
  }
});

test('deck_policy check：带 text 时给脱敏预览，不打原文', async () => {
  const { root, done } = freshRoot('check-redact');
  const phone = ['138', '1234', '5678'].join('');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    const text = await tool.execute({
      action: 'check',
      tool: 'team_board',
      toolAction: 'add',
      text: `电话 ${phone}，邮箱 alice@example.com`,
    });
    assert.ok(text.includes('138****5678'));
    assert.ok(text.includes('a***@example.com'));
    assert.ok(!text.includes(phone));
    assert.match(text, /命中规则：phone/);
  } finally {
    done();
  }
});

test('deck_policy reset：规则与计数一起清空', async () => {
  const { root, done } = freshRoot('reset');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    await tool.execute({ action: 'set', rule: { id: 'counted', match: { tool: 'team_board', action: 'add' }, effect: 'allow' } });
    await tool.execute({ action: 'check', tool: 'team_board', toolAction: 'add', record: true });
    assert.equal(loadPolicy(root).policy.usage.counted.hour, 1);

    const text = await tool.execute({ action: 'reset' });
    assert.match(text, /已恢复默认策略/);
    const loaded = loadPolicy(root);
    assert.equal(loaded.policy.rules.length, 0);
    assert.deepEqual(loaded.policy.usage, {});
  } finally {
    done();
  }
});

test('deck_policy set 的输出不许再写"未接线/只是存着"——那是接线之前的实话，现在是误导', async () => {
  const { root, done } = freshRoot('wired-msg');
  try {
    const tool = plain(createPolicyTool({ root: () => root }));
    const text = await tool.execute({ action: 'set', rule: { id: 'r1', match: { tool: 'pet_skin' }, effect: 'deny' } });
    // 必须说清"已生效"
    assert.match(text, /已生效/);
    assert.match(text, /真的拦住执行/);
    // 不许再出现接线之前的说法
    assert.doesNotMatch(text, /未接线/);
    assert.doesNotMatch(text, /只是存着/);
    assert.doesNotMatch(text, /不会真的拦/);
  } finally {
    done();
  }
});

test('deck_policy 文件头自述不许再说"本工具只做判定、不会拦截"', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/tools/policy.js', import.meta.url), 'utf8');
  assert.match(src, /已经接线/, '文件头该写清 1.10.0 起已接线');
  assert.doesNotMatch(src, /本工具只做"判定"，它不会拦截任何工具调用/,
    '那句是接线之前的说明，留着会让人以为写了规则也不生效');
});
