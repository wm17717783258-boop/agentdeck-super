#!/usr/bin/env node
/**
 * verify-pay —— 把「买皮肤 → 真发支付请求 → 到账 → 解锁 → 退款」整条链路真跑一遍。
 *
 * 为什么需要这个脚本：
 *   本机没有商户号，所以页面上点「购买」只会如实说「环境未配」。
 *   但「环境未配」不能证明代码路径是通的——万一 charge 契约写错了，
 *   等真配了商户号才发现，那就太晚。
 *
 * 做法：在 127.0.0.1 上起一个**真的 HTTP 支付网关**（不是 mock 函数），
 *   用 billingFromEnv() 读环境变量拼出渠道适配器，用 fetch 真发 POST 过去，
 *   再检查订单、账本、授权、皮肤渲染、退款。请求真的走了网络栈。
 *
 * 这样能证明的是：只差一个商户号，别的都通了。
 * 不能证明的是：真钱能进账。那条只有真商户号能证明，脚本不会假装。
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = new URL('../', import.meta.url);
const LIB = new URL('lib/', HERE).href;

const { buyNow, confirmPayment, refundOrder, placeOrder, marketLicense, purchasedSkins, listOrders } = await import(
  new URL('market/purchase.js', LIB).href
);
const { readOrders, readLedger } = await import(new URL('market/store.js', LIB).href);
const { checkSkinLicense } = await import(new URL('pet/skins.js', LIB).href);
const { renderSprite } = await import(new URL('pet/skins.js', LIB).href);

const lines = [];
let pass = 0;
let fail = 0;

function ok(name, extra = '') {
  pass += 1;
  lines.push(`  ✔ ${name}${extra ? ` —— ${extra}` : ''}`);
}
function bad(name, extra = '') {
  fail += 1;
  lines.push(`  ✘ ${name}${extra ? ` —— ${extra}` : ''}`);
}
function must(cond, name, extra = '') {
  if (cond) ok(name, extra);
  else bad(name, extra);
}
function head(text) {
  lines.push('');
  lines.push(text);
}

/* ── 假网关：真 HTTP 服务，行为可控 ───────────────────────────────────── */

const gateway = { mode: 'paid', hits: 0, lastBody: null };

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    gateway.hits += 1;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    gateway.lastBody = body;

    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (gateway.mode === 'down') return send(502, { ok: false, reason: '网关 502' });
    if (gateway.mode === 'decline') return send(200, { ok: false, reason: '余额不足' });
    if (!body.orderId || !(body.amount > 0)) return send(400, { ok: false, reason: '订单号或金额不对' });
    return send(200, { ok: true, paid: true, provider: 'localpay', ref: `LOCALPAY-${body.orderId}` });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const payUrl = `http://127.0.0.1:${port}/pay`;

/** 真 fetch 的 http 客户端：billingFromEnv 的 charge() 会用它发请求 */
const httpClient = {
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  },
};

const root = mkdtempSync(join(tmpdir(), 'adbp-pay-'));
const SKIN = 'premium-aurora';

try {
  head('▶ 1. 没配渠道时：如实说环境未配，订单不许变已付');
  {
    const placed = placeOrder({ root, skinId: SKIN });
    must(placed.ok === true, '能下单（本地账本，不碰钱）', placed.ok ? `单号 ${placed.order.id.slice(-8)}` : placed.reason);
    must(placed.ok && placed.order.state === 'created', '订单初始状态是待支付');

    const paid = await confirmPayment({ root, orderId: placed.ok ? placed.order.id : '', billing: undefined });
    must(paid.ok === false, '确认支付失败（没渠道）');
    must(paid.code === 'billing_unconfigured', '失败原因码是 billing_unconfigured', String(paid.code));
    must(/环境未配/.test(String(paid.reason)), '给用户看的是「环境未配」，不是英文报错');

    const after = readOrders(root).doc.orders.find((o) => o.id === placed.order.id);
    must(after && after.state === 'created', '订单仍然是待支付，没有假装收到钱');
    must(!after.payment, '没有 payment 字段（没编造流水号）');
  }

  head('▶ 2. 配上真网关地址后：真发 POST → 真到账 → 真解锁');
  {
    const { billingFromEnv } = await import(new URL('market/purchase.js', LIB).href);
    const env = {
      AGENTDECK_PAY_PROVIDER: 'localpay',
      AGENTDECK_PAY_URL: payUrl,
      AGENTDECK_PAY_TOKEN: 'test-token',
    };
    const built = billingFromEnv(env, { http: httpClient });
    must(built.ok === true, 'billingFromEnv 认出渠道', built.ok ? built.adapter.label : built.detail);
    must(built.ok && built.adapter.configured === true, '适配器标记为已配置');

    const before = gateway.hits;
    const result = await buyNow({ root, skinId: SKIN, billing: built.adapter, http: httpClient });
    must(gateway.hits === before + 1, '网关真的收到了请求', `命中 ${gateway.hits} 次`);
    must(gateway.lastBody && gateway.lastBody.orderId, '请求里带着订单号');
    must(gateway.lastBody && gateway.lastBody.amount > 0, '请求里带着金额（分）', String(gateway.lastBody && gateway.lastBody.amount));

    must(result.ok === true, '购买成功', String(result.code || ''));
    // 状态机：created → paid（收款落盘）→ delivered（皮肤发放落盘）
    must(result.order && result.order.state === 'delivered', '订单推进到已交付', String(result.order && result.order.state));
    must(result.order && result.order.payment && /LOCALPAY-/.test(String(result.order.payment.ref)), '落盘了渠道流水号');
    must(result.code && String(result.code).length > 0, '生成了交付码', String(result.code || ''));

    const ledger = readLedger(root).doc;
    must(Array.isArray(ledger.purchases) && ledger.purchases.some((p) => p.skinId === SKIN), '账本里记了这笔购买');

    const owned = purchasedSkins({ root });
    must(owned.ok && owned.skins.includes(SKIN), '已购列表里有这套皮肤');

    const lic = marketLicense({ root, license: { tier: 'free' } });
    must(lic.ok === true, 'marketLicense 算得出授权');
    // 注意：checkSkinLicense 的 ok 是「检查本身成功」，能不能用看 allowed
    const verdict = checkSkinLicense({ skin: SKIN, license: lic.license, now: Date.now() });
    must(verdict.allowed === true, '授权检查放行（买过就是买过）', String(verdict.reason || ''));

    const sprite = renderSprite({ skin: SKIN, state: 'idle', size: 96, license: lic.license });
    must(typeof sprite === 'string' && sprite.includes('data-skin="premium-aurora"'), '皮肤能真渲染出来');
    must(!/此皮肤需授权/.test(sprite), '不再提示「需授权」');
    must(!/没有这个皮肤/.test(sprite), '也不是「没有这个皮肤」');
  }

  head('▶ 3. 重复确认同一张单：不重复扣款');
  {
    const orders = readOrders(root).doc.orders;
    const paidOrder = orders.find((o) => o.state === 'delivered' || o.state === 'paid');
    const again = await confirmPayment({ root, orderId: paidOrder.id });
    must(again.ok === true && again.already === true, '幂等：第二次确认直接返回已完成');
    const hits = gateway.hits;
    await confirmPayment({ root, orderId: paidOrder.id });
    must(gateway.hits === hits, '没有再发一次扣款请求');
  }

  head('▶ 4. 网关拒绝 / 网关宕机：订单不许变已付');
  {
    // 换一个干净账本：同一个 root 里这套皮肤已经买过了，不能再下单
    const root2 = mkdtempSync(join(tmpdir(), 'adbp-pay2-'));
    try {
      const placed = placeOrder({ root: root2, skinId: SKIN, buyer: 'second' });
      must(placed.ok === true, '在空账本上能下单', placed.ok ? placed.order.id.slice(-8) : String(placed.reason));
      const orderId = placed.ok ? placed.order.id : '';
      const charge = async ({ order }) => httpClient.post(payUrl, { orderId: order.id, amount: order.amount });
      const billing = { id: 'localpay', configured: true, charge };

      gateway.mode = 'decline';
      const declined = await confirmPayment({ root: root2, orderId, billing });
      must(declined.ok === false, '网关说余额不足 → 购买失败');
      must(declined.code === 'charge_failed', '失败码是 charge_failed', String(declined.code));
      must(/余额不足/.test(String(declined.reason)), '把渠道给的原话透出来，不吞掉', String(declined.reason || ''));

      gateway.mode = 'down';
      const down = await confirmPayment({ root: root2, orderId, billing });
      must(down.ok === false, '网关 502 → 购买失败，不猜成功');

      const still = readOrders(root2).doc.orders.find((o) => o.id === orderId);
      must(still && still.state === 'created', '两次失败后订单还是待支付');
      must(!still.payment, '账本里没有编造流水号');
      gateway.mode = 'paid';
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  }

  head('▶ 5. 退款：订单转已退，皮肤收回');
  {
    const orders = readOrders(root).doc.orders;
    const paidOrder = orders.find((o) => o.state === 'delivered' || o.state === 'paid');
    const refunded = refundOrder({ root, orderId: paidOrder.id, reason: '验证脚本' });
    must(refunded.ok === true, '退款记录成功', String(refunded.reason || ''));
    const after = readOrders(root).doc.orders.find((o) => o.id === paidOrder.id);
    must(after && after.state === 'refunded', '订单状态变成已退款');

    const lic = marketLicense({ root, license: { tier: 'free' } });
    const verdict = checkSkinLicense({ skin: SKIN, license: lic.license, now: Date.now() });
    must(verdict.allowed === false, '退款后授权收回（皮肤重新需要购买）');
    must(/需要授权/.test(String(verdict.reason)), '给的理由是「需要授权」', String(verdict.reason || ''));

    const list = listOrders({ root });
    must(list.ok === true && Array.isArray(list.orders), '订单列表读得出来', `${list.orders.length} 单`);
  }

  head('▶ 6. 一眼看穿的事：这些不是「假成功」');
  {
    lines.push('  · 支付请求是真 HTTP POST，走的是 127.0.0.1 上真实监听的端口；');
    lines.push('  · 渠道返回 paid:true 才写 paid，任何异常都保持待支付；');
    lines.push('  · 本机没有商户号时，页面与工具一律回「环境未配」，不会编造已付款。');
  }
} catch (err) {
  bad('脚本本身抛错', err && err.message ? err.message : String(err));
} finally {
  await new Promise((resolve) => server.close(resolve));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

const summary = `结论：${fail === 0 ? '全部通过' : `${fail} 项没过`}（${pass}/${pass + fail}）`;
lines.push('');
lines.push(summary);

const text = [
  '支付链路端到端验证（1.9.0）',
  `时间：${new Date().toISOString()}`,
  `本地网关：127.0.0.1:${port}（真 HTTP，脚本内起停）`,
  `测试根目录：临时目录（跑完已删）`,
  ...lines,
].join('\n');

console.log(text);

const outFile = new URL('docs/evidence/pay-1.9.0.txt', HERE);
try {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(new URL('docs/evidence/', HERE), { recursive: true });
  writeFileSync(outFile, `${text}\n`, 'utf8');
  console.log(`\n[evidence] ${outFile.pathname.replace(/^\//, '')}`);
} catch (err) {
  console.log(`\n[evidence] 写入失败：${err && err.message}`);
}

process.exitCode = fail === 0 ? 0 : 1;
