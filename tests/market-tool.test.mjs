/**
 * tests/market-tool.test.mjs —— deck_market 工具的对外行为（1.9.0）
 *
 * 这一组测试只关心"用户/模型看到的文字对不对"，不重复测 lib/market/** 的内部实现。
 * 两条铁律在这里各钉一遍：
 *   ① 没配支付渠道时，绝不出现"买到了"这种话，订单停在待付款；
 *   ② 市场模块整个缺失时，工具要能说清缺什么，而不是抛异常或返回 undefined。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMarketTool } from '../lib/tools/market.js';
import { createMarket } from '../lib/market/index.js';

const text = async (tool, args) => {
  const r = await tool.execute(args, {});
  if (r && typeof r === 'object' && typeof r.text === 'string') return r.text;
  return String(r);
};

/**
 * 一个"没配在线渠道"的市场：这是绝大多数用户第一次打开时的真实状态。
 * 注意这里连 pro 都不需要 —— 免费版就该能走到这一步。
 */
function bareMarket() {
  const root = mkdtempSync(join(tmpdir(), 'adsk-mkt-'));
  const market = createMarket({ root, billing: null });
  return { root, market, billing: null };
}

test('deck_market 的工具契约：名字、描述、输出 schema 都对得上', () => {
  const tool = createMarketTool({});
  assert.equal(tool.name, 'deck_market');
  assert.ok(typeof tool.description === 'string' && tool.description.length > 20);
  assert.ok(tool.parameters && tool.parameters.properties && tool.parameters.properties.action);
  const actions = tool.parameters.properties.action.enum;
  for (const a of ['catalog', 'health', 'buy', 'orders', 'refund']) {
    assert.ok(actions.includes(a), `缺动作 ${a}`);
  }
  assert.deepEqual(Object.keys(tool.output.schema.properties), ['text']);
  const blocks = tool.output.render({}, { text: 'hi' });
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, 'hi');
});

test('catalog：列出货架、标出已拥有/在售、带价格和下一步怎么说', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  const out = await text(tool, { action: 'catalog' });
  assert.match(out, /【deck_market】货架 \d+ 套/);
  assert.match(out, /已拥有/);
  assert.match(out, /极光/, '付费皮肤要出现在货架上');
  assert.match(out, /¥18/, '付费皮肤要标出真实价格');
  assert.match(out, /买 premium-aurora/, '要告诉用户具体怎么说才能下单');
});

test('health：没配渠道时如实说未配置，并给出配哪几个环境变量', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  const out = await text(tool, { action: 'health' });
  assert.match(out, /支付渠道/);
  assert.match(out, /未配置|环境未配/);
  assert.match(out, /AGENTDECK_PAY_PROVIDER/);
  assert.doesNotMatch(out, /已配置且可用/, '没配就不许说能用');
});

test('buy：没配渠道时订单停在待付款，绝不谎报"买到了"', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  const out = await text(tool, { action: 'buy', skinId: 'premium-aurora' });
  assert.match(out, /买不了|环境未配/);
  assert.match(out, /待付款|已建但未付款/);
  assert.match(out, /不会扣钱|不伪造|不会假装/);
  assert.doesNotMatch(out, /已拥有|已发放|购买成功/, '没付钱就不许写成功');
});

test('buy：缺 skinId 时直接说缺什么，不去建空订单', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  const out = await text(tool, { action: 'buy' });
  assert.match(out, /skinId|皮肤/);
  const orders = await text(tool, { action: 'orders' });
  assert.match(orders, /没有订单|0 笔/);
});

test('orders：订单按时间正序列出，并给出分状态计数', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  await text(tool, { action: 'buy', skinId: 'premium-aurora' });
  const out = await text(tool, { action: 'orders' });
  assert.match(out, /本机订单 \d+ 笔/);
  assert.match(out, /待付款/);
  assert.match(out, /极光/);
});

test('refund：没付款的订单不给退款，说清原因', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  await text(tool, { action: 'buy', skinId: 'premium-aurora' });
  const list = await text(tool, { action: 'orders' });
  const orderId = (list.match(/ord_[0-9a-z]+/i) || [''])[0];
  assert.ok(orderId, '订单列表里应该能拿到订单号');
  const out = await text(tool, { action: 'refund', orderId });
  assert.match(out, /还没支付|不用退|没有可退/, '未付款的要拒绝退款并说明');
});

test('refund：不给订单号就先问，不瞎退', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  const out = await text(tool, { action: 'refund' });
  assert.match(out, /订单号/);
});

test('不认识的动作：列出可用动作，不静默成功', async () => {
  const { market, billing } = bareMarket();
  const tool = createMarketTool({ market, billing });
  const out = await text(tool, { action: 'steal' });
  assert.match(out, /不认识|未知/);
  assert.match(out, /catalog/);
});

test('市场模块缺失：降级说人话，不抛异常', async () => {
  const tool = createMarketTool({});
  const out = await text(tool, { action: 'catalog' });
  assert.match(out, /市场模块没有加载/);
  assert.match(out, /skins/, '要告诉用户还能手动放皮肤');
});

test('支付层缺失：health 说清"只能买免费皮肤"', async () => {
  const tool = createMarketTool({});
  const out = await text(tool, { action: 'health' });
  assert.match(out, /支付抽象层没有加载|只能买免费皮肤/);
});
