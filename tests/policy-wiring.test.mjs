/**
 * 策略门控 + 审计流的**接线验收**：证明 lib/index.js 真的把 decide()/recordUsage()/appendAudit()
 * 接到了工具调用链上 —— 而不是只写了一个能跑的引擎库。
 *
 * 这层为什么必须有：lib/policy/*.js 自己的单测只证明「判定函数算得对」，
 * 只有从宿主工具带里把 definition.execute 拿出来真调一次，才能证明
 * 「规则 deny 之后工具真的不执行」「审计里真的多了一行」。
 *
 * 全部用假 ctx + 临时工作区，不联网、不碰用户真实授权文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

/* ── 假 ctx：只需要 tools / logger / effect / emit ──────────────────────── */

function makeCtx() {
  const state = { tools: [], warns: [], infos: [], effects: [] };
  const ctx = {
    logger: {
      debug() {},
      info: (m) => state.infos.push(String(m)),
      warn: (m) => state.warns.push(String(m)),
      error: (m) => state.warns.push(String(m)),
    },
    get: () => null,
    emit() {},
    effect: (fn) => {
      state.effects.push(fn);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    // 没有 webServer / commands：路由和斜杠命令都跳过，不影响工具带
    inject() {},
    tools: {
      register(def) {
        state.tools.push(def);
        return () => {};
      },
    },
  };
  return { ctx, state };
}

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'adsk-policy-wiring-'));
  const { ctx, state } = makeCtx();
  await apply(ctx, { workspace: root, boardRoot: root, licenseRoot: root, agents: [] });
  const tool = (name) => {
    const found = state.tools.find((t) => t.name === name);
    assert.ok(found, `工具 ${name} 没注册，接线断言无从谈起`);
    return found;
  };
  return {
    root,
    state,
    tool,
    auditFile: join(root, 'audit.jsonl'),
    policyFile: join(root, 'policy.json'),
    /** 直接读审计行（没有文件就是空数组） */
    auditLines() {
      if (!existsSync(this.auditFile)) return [];
      return readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 工具 execute 可能回字符串、也可能回 {text}；统一取文本。 */
const asText = (out) => (typeof out === 'string' ? out : String(out?.text ?? ''));

/* ── 1. 基线：没规则时工具照常跑 ───────────────────────────────────────── */

test('没有策略规则时工具正常运行，审计里留下一条 ok', async () => {
  const b = await boot();
  try {
    const text = asText(await b.tool('deck_license').execute({ action: 'status' }, {}));
    assert.match(text, /免费版|协作版|工作室版/, `授权状态没渲染出来：${text.slice(0, 120)}`);

    const lines = b.auditLines();
    const one = lines.find((r) => r.tool === 'deck_license');
    assert.ok(one, `审计里没有 deck_license 的记录：${JSON.stringify(lines)}`);
    assert.equal(one.result, 'ok');
    assert.equal(one.action, 'status');
    assert.ok(typeof one.ts === 'string' && one.ts.length > 0, '审计记录缺时间戳');
  } finally {
    b.cleanup();
  }
});

/* ── 2. 硬拦截：规则 deny —— 工具真的不执行 ────────────────────────────── */

test('规则 deny 之后：工具不执行、返回【策略拒绝】、审计记 denied', async () => {
  const b = await boot();
  try {
    const pol = b.tool('deck_policy');
    const setRes = asText(await pol.execute({
      action: 'set',
      rule: { id: 'block-license', match: { tool: 'deck_license' }, effect: 'deny', reason: '验收：先别读授权' },
    }, {}));
    assert.match(setRes, /写入|已写入|规则/, `规则没写进去：${setRes.slice(0, 200)}`);
    assert.ok(existsSync(b.policyFile), 'policy.json 没落盘');

    const text = asText(await b.tool('deck_license').execute({ action: 'status' }, {}));
    assert.match(text, /【策略拒绝】/, `没被拦住：${text.slice(0, 200)}`);
    assert.match(text, /验收：先别读授权/, '拒绝原因没透出来');
    assert.doesNotMatch(text, /免费版|协作版|工作室版/, '被拒的调用不该拿到工具真实输出');

    const denied = b.auditLines().filter((r) => r.tool === 'deck_license' && r.result === 'denied');
    assert.equal(denied.length, 1, `审计里 denied 记录数量不对：${JSON.stringify(b.auditLines())}`);
  } finally {
    b.cleanup();
  }
});

/* ── 3. 解除：reset 之后又能用 ─────────────────────────────────────────── */

test('deck_policy reset 之后同一个工具立刻恢复可用', async () => {
  const b = await boot();
  try {
    const pol = b.tool('deck_policy');
    await pol.execute({ action: 'set', rule: { id: 'block-license', match: { tool: 'deck_license' }, effect: 'deny' } }, {});
    assert.match(asText(await b.tool('deck_license').execute({ action: 'status' }, {})), /【策略拒绝】/);

    const resetRes = asText(await pol.execute({ action: 'reset' }, {}));
    assert.match(resetRes, /恢复|清空|默认/, `reset 没生效：${resetRes.slice(0, 160)}`);

    const text = asText(await b.tool('deck_license').execute({ action: 'status' }, {}));
    assert.match(text, /免费版|协作版|工作室版/, `reset 之后还是被拦：${text.slice(0, 160)}`);
  } finally {
    b.cleanup();
  }
});

/* ── 4. 二次确认：显式 confirm 规则要 confirm:true ─────────────────────── */

test('显式 confirm 规则：不带 confirm:true 不执行，带上才执行', async () => {
  const b = await boot();
  try {
    const pol = b.tool('deck_policy');
    await pol.execute({
      action: 'set',
      rule: { id: 'ask-skin', match: { tool: 'pet_skin', action: 'activate' }, effect: 'confirm', reason: '换装请本人点头' },
    }, {});

    const blocked = asText(await b.tool('pet_skin').execute({ action: 'activate', id: 'nio' }, {}));
    assert.match(blocked, /【需要确认】/, `没要求确认：${blocked.slice(0, 200)}`);
    assert.match(blocked, /confirm:true/, '提示里得告诉人怎么确认');
    assert.match(blocked, /换装请本人点头/, '确认原因没透出来');

    const ok = asText(await b.tool('pet_skin').execute({ action: 'activate', id: 'nio', confirm: true }, {}));
    assert.match(ok, /霓虹|nio/i, `带了 confirm:true 还是没换装：${ok.slice(0, 200)}`);
    assert.doesNotMatch(ok, /【需要确认】/);
  } finally {
    b.cleanup();
  }
});

/* ── 5. 动作分级：strict 才强制，默认不打断日常动作 ────────────────────── */

test('strict 关闭时（默认）删除类动作照常执行；strict 打开才强制确认', async () => {
  const b = await boot();
  try {
    const twin = b.tool('twin_forget');
    const before = asText(await twin.execute({ action: 'forget' }, {}));
    assert.doesNotMatch(before, /【需要确认】/, `默认不该拦删除类动作：${before.slice(0, 160)}`);

    process.env.AGENTDECK_POLICY_STRICT = '1';
    try {
      const strictOut = asText(await twin.execute({ action: 'forget' }, {}));
      assert.match(strictOut, /【需要确认】/, `strict 打开后没强制确认：${strictOut.slice(0, 160)}`);
    } finally {
      delete process.env.AGENTDECK_POLICY_STRICT;
    }
  } finally {
    b.cleanup();
  }
});

/* ── 6. 记账：预算型规则能累计用量 ─────────────────────────────────────── */

test('预算规则：perDay 用满之后真的拒绝（记账落在 policy.json 里）', async () => {
  const b = await boot();
  try {
    const pol = b.tool('deck_policy');
    await pol.execute({
      action: 'set',
      rule: { id: 'license-budget', match: { tool: 'deck_license' }, effect: 'allow', budget: { perDay: 2 }, reason: '验收：一天只许看两次' },
    }, {});

    assert.match(asText(await b.tool('deck_license').execute({ action: 'status' }, {})), /免费版|协作版|工作室版/);
    assert.match(asText(await b.tool('deck_license').execute({ action: 'status' }, {})), /免费版|协作版|工作室版/);

    const third = asText(await b.tool('deck_license').execute({ action: 'status' }, {}));
    assert.match(third, /【策略拒绝】/, `超出预算没被拒：${third.slice(0, 200)}`);
    assert.match(third, /2|两次|预算/, '拒绝文案里得说清是哪条预算');

    const saved = JSON.parse(readFileSync(b.policyFile, 'utf8'));
    assert.ok(saved.usage && typeof saved.usage === 'object', 'policy.json 里没有用量记录');
  } finally {
    b.cleanup();
  }
});
