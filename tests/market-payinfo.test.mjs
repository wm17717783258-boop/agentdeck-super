/**
 * 人工收款能不能真的收到钱 —— 全看这一段。
 *
 * 技术链路（下单/确认/发放）早就有测试了，但那条链路的第一个动作是"买家转账"。
 * 如果下单时没告诉买家往哪转，"转账"就永远发不出去 —— 这不是技术故障，
 * 是流程断了，而且不会有任何报错。所以这里专门测"话有没有说到位"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { createMarket } from '../lib/market/index.js';
import { createMarketTool } from '../lib/tools/market.js';
import { readPayInfo, writePayInfo, payInfoPath } from '../lib/market/payout.js';

function shop() {
  const root = mkdtempSync(join(tmpdir(), 'adsk-payinfo-'));
  const market = createMarket({ root, billing: null });
  const tool = createMarketTool({ market, billing: null });
  const say = async (args) => {
    const r = await tool.execute(args, {});
    return r && typeof r === 'object' && typeof r.text === 'string' ? r.text : String(r);
  };
  return { root, market, tool, say, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('还没配收款方式时：下单要直说没配，并给一条能照做的命令', async () => {
  const s = shop();
  try {
    const out = await s.say({ action: 'place', skinId: 'premium-jade' });
    assert.match(out, /订单号：ord_/, '下单本身必须成功（收款方式缺失不该阻塞下单）');
    assert.match(out, /还没配/, '必须说清收款方式还没配');
    assert.match(out, /action="payinfo"/, '要给出配置命令，不能只说"去配一下"');
    assert.match(out, /MANUAL-ord_/, '转账备注格式必须写出来');
  } finally {
    s.done();
  }
});

test('配一次之后：订单自动带上收款方式（买家照着就能转）', async () => {
  const s = shop();
  try {
    const saved = await s.say({
      action: 'payinfo',
      methods: '[{"kind":"alipay","account":"seller@example.com","name":"王老板"}]',
    });
    assert.match(saved, /已保存/);
    assert.match(saved, /seller@example\.com/, '保存后要回显，否则用户不知道存进去的是什么');

    const out = await s.say({ action: 'place', skinId: 'premium-nebula' });
    assert.match(out, /收款方式：/);
    assert.match(out, /支付宝/, '要写清是什么方式，不能只甩一个账号');
    assert.match(out, /seller@example\.com/);
    assert.match(out, /王老板/);
  } finally {
    s.done();
  }
});

test('查看收款方式：没配时说怎么配，配了就说是什么', async () => {
  const s = shop();
  try {
    const empty = await s.say({ action: 'payinfo' });
    assert.match(empty, /还没配/);
    assert.match(empty, /kind 可选/);

    await s.say({ action: 'payinfo', methods: '[{"kind":"wechat","account":"wx_seller"}]' });
    const got = await s.say({ action: 'payinfo' });
    assert.match(got, /微信支付/);
    assert.match(got, /wx_seller/);
    assert.match(got, /文件：/, '要告诉用户存在哪，方便自己改');
  } finally {
    s.done();
  }
});

test('非法输入一律挡住，并说清怎么改', async () => {
  const s = shop();
  try {
    const notJson = await s.say({ action: 'payinfo', methods: 'not-json' });
    assert.match(notJson, /JSON 数组/, '非 JSON 要给出正确格式的示例');

    const badKind = await s.say({ action: 'payinfo', methods: '[{"kind":"bitcoin","account":"x"}]' });
    assert.match(badKind, /格式不对|至少给一条/, '不认识的 kind 不能默默存下来');

    const noAccount = await s.say({ action: 'payinfo', methods: '[{"kind":"alipay"}]' });
    assert.match(noAccount, /格式不对|至少给一条/, '没有账号等于没配，必须挡住');

    const notArray = await s.say({ action: 'payinfo', methods: '{"kind":"alipay","account":"x"}' });
    assert.match(notArray, /必须是数组/);
  } finally {
    s.done();
  }
});

test('收款方式文件写坏了：按"还没配"处理，不崩也不吞掉别人的文件', () => {
  const s = shop();
  try {
    const file = payInfoPath(s.root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ 这不是 JSON', 'utf8');

    const info = readPayInfo(s.root);
    assert.equal(info.ok, true, '读坏了也该返回 ok（降级成空，不能抛）');
    assert.deepEqual(info.methods, []);
    assert.ok(info.warnings.some((w) => /不是合法 JSON/.test(w)), '要说明为什么没读到');
    // 原文件不能被动过 —— 也许是用户手动编辑到一半
    assert.equal(readFileSync(file, 'utf8'), '{ 这不是 JSON');
  } finally {
    s.done();
  }
});

test('最多 5 条：超出的丢掉，重复的合并', () => {
  const s = shop();
  try {
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'bank', account: `acct-${i}` }));
    const wrote = writePayInfo(s.root, { methods: many });
    assert.equal(wrote.ok, true, wrote.reason);
    assert.equal(wrote.methods.length, 5, '超过 5 条要截断（面板里塞不下，也没必要）');

    const dup = writePayInfo(s.root, {
      methods: [
        { kind: 'alipay', account: 'a@b.c' },
        { kind: 'alipay', account: 'a@b.c' },
      ],
    });
    assert.equal(dup.methods.length, 1, '同 kind 同账号不该存两条');

    // 落到文件里的字段必须是白名单，多出来的不进去
    const raw = JSON.parse(readFileSync(payInfoPath(s.root), 'utf8'));
    for (const one of raw.methods) {
      assert.deepEqual(
        Object.keys(one).sort(),
        ['account', 'kind', 'label', 'name', 'note'],
        `收款方式里混进了不认识的字段：${Object.keys(one).join(',')}`,
      );
    }
  } finally {
    s.done();
  }
});

test('note 会跟着订单一起给买家（比如"务必备注订单号"）', async () => {
  const s = shop();
  try {
    await s.say({
      action: 'payinfo',
      methods: '[{"kind":"alipay","account":"seller@example.com"}]',
      note: '转账请备注订单号，否则对不上账',
    });
    const out = await s.say({ action: 'place', skinId: 'premium-ember' });
    assert.match(out, /转账请备注订单号/);
  } finally {
    s.done();
  }
});
