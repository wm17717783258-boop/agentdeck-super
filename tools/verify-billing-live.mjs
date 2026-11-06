/**
 * tools/verify-billing-live.mjs —— 支付适配器"真的能发出可用的 Stripe 请求"验证
 *
 * 要解决的问题：真实商户号我们没有，但**代码路径对不对**可以独立验证。
 * 做法：起一个本地 HTTP 服务器，**严格照 Stripe 的在线 API 形状**应答
 *      （POST /v1/checkout/sessions → 返回 id/url；POST /v1/refunds → 返回 id/status），
 *      然后把适配器指过去。
 *
 * 这样验的是：
 *   · 请求是不是打到正确的路径、带正确的方法和鉴权头；
 *   · 表单字段是不是 Stripe 认的那几个（mode/line_items/success_url…）；
 *   · 返回的收银台 URL 能不能拿去让用户点；
 *   · 退款、webhook 验签、幂等这几条链路对不对。
 *
 * 验不了（照写）：
 *   · Stripe 那边是不是真扣了钱 —— 那需要真 key。所以门槛⑥仍然开着。
 *
 * 用法：node tools/verify-billing-live.mjs
 * 证据：docs/evidence/billing-live-1.10.0.txt
 */

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const OUT = join(REPO, 'docs', 'evidence', 'billing-live-1.10.0.txt');

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const say = (t = '') => lines.push(t);

/** 一个"照 Stripe 形状"应答的本地服务器，并记录收到的每一个请求。 */
function fakeStripe() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      seen.push({
        method: req.method,
        url: req.url,
        auth: String(req.headers.authorization || ''),
        contentType: String(req.headers['content-type'] || ''),
        form: Object.fromEntries(form.entries()),
        raw: body,
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') {
        res.end(JSON.stringify({
          id: 'cs_test_local_1',
          object: 'checkout.session',
          url: 'https://checkout.stripe.com/c/pay/cs_test_local_1',
          payment_status: 'unpaid',
          amount_total: Number(form.get('line_items[0][price_data][unit_amount]') || 0),
          currency: form.get('line_items[0][price_data][currency]') || 'cny',
          metadata: { orderId: form.get('metadata[orderId]') || '' },
        }));
        return;
      }
      if (req.url === '/v1/refunds') {
        res.end(JSON.stringify({ id: 're_test_local_1', object: 'refund', status: 'succeeded', amount: 1800 }));
        return;
      }
      if (req.url?.startsWith('/v1/checkout/sessions/')) {
        res.end(JSON.stringify({ id: 'cs_test_local_1', object: 'checkout.session', payment_status: 'paid', payment_intent: 'pi_test_local_1' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route ${req.url}` } }));
    });
  });
  return { server, seen };
}

async function main() {
  say('支付适配器真机验证（照 Stripe 在线 API 形状应答的本地服务器）');
  say('='.repeat(66));
  say(`时间：${new Date().toISOString()}`);
  say('要验的是"代码路径对不对"，不是"Stripe 真扣没扣钱"——后者需要真 key。');
  say('');

  const fake = fakeStripe();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  const webhookSecret = 'whsec_local_test_1234567890';

  const mod = await import(pathToFileURL(join(REPO, 'lib', 'billing', 'index.js')).href);
  chk(typeof mod.createBilling === 'function', 'billing 模块可加载');

  const billing = mod.createBilling({
    provider: 'stripe',
    stripe: { secretKey: 'sk_test_local', webhookSecret, apiBase: base },
  });

  /* ── 1. health ───────────────────────────────────────────────── */
  say('【第 1 步】配置体检');
  const health = billing.health();
  chk(health?.ok === true, 'health 报已配置', JSON.stringify(health).slice(0, 120));
  chk(health?.provider === 'stripe', 'provider 是 stripe');

  const unconfigured = mod.createBilling({});
  chk(unconfigured.health().ok === false, '没配 provider 时 health 如实报未配置');
  chk(/环境未配|未配置/.test(String(unconfigured.health().reason || '')), '未配置的原因说得清',
    String(unconfigured.health().reason || '').slice(0, 60));

  /* ── 2. 发起支付 ─────────────────────────────────────────────── */
  say('');
  say('【第 2 步】发起支付（POST /v1/checkout/sessions）');
  const created = await billing.createCheckout({
    orderId: 'ord_billingtest01',
    amount: 1800,
    currency: 'cny',
    subject: '极光皮肤',
    successUrl: 'http://127.0.0.1:58399/deck?paid=1',
    cancelUrl: 'http://127.0.0.1:58399/deck?paid=0',
  });
  chk(created?.ok === true, '发起支付成功', created?.reason || '');
  chk(Boolean(created?.url), '拿到了收银台 URL（用户点这个去付）', String(created?.url || '').slice(0, 60));

  const req1 = fake.seen.find((s) => s.url === '/v1/checkout/sessions');
  chk(Boolean(req1), '请求真的发到了 /v1/checkout/sessions');
  chk(req1?.method === 'POST', '用的是 POST', String(req1?.method));
  chk(/^Bearer sk_test_local$/.test(req1?.auth || ''), '带上了 Bearer 鉴权头', String(req1?.auth));
  chk(/form-urlencoded/.test(req1?.contentType || ''), 'Content-Type 是表单（Stripe 要这个）', String(req1?.contentType));
  chk(req1?.form?.mode === 'payment', 'mode=payment', String(req1?.form?.mode));
  chk(req1?.form?.['line_items[0][price_data][unit_amount]'] === '1800',
    '金额按"分"传过去（Stripe 用最小货币单位）', String(req1?.form?.['line_items[0][price_data][unit_amount]']));
  chk(req1?.form?.['line_items[0][price_data][currency]'] === 'cny', '币种 cny',
    String(req1?.form?.['line_items[0][price_data][currency]']));
  chk(req1?.form?.['metadata[orderId]'] === 'ord_billingtest01', '带上了 orderId（对账要用）',
    String(req1?.form?.['metadata[orderId]']));

  /* ── 3. 缺参数要拒 ───────────────────────────────────────────── */
  say('');
  say('【第 3 步】参数不齐时必须拒，不许发出半个请求');
  const before = fake.seen.length;
  const noUrl = await billing.createCheckout({ orderId: 'x', amount: 100 });
  chk(noUrl?.ok === false, '缺回跳地址 → 拒绝', String(noUrl?.reason || '').slice(0, 60));
  const zero = await billing.createCheckout({ orderId: 'x', amount: 0, successUrl: 'http://x', cancelUrl: 'http://y' });
  chk(zero?.ok === false, '金额 0 → 拒绝', String(zero?.reason || '').slice(0, 60));
  chk(fake.seen.length === before, '这两次拒绝都没发出真请求（没浪费一次调用）');

  /* ── 4. Webhook 验签 ────────────────────────────────────────── */
  say('');
  say('【第 4 步】Webhook 验签（假的签名必须拒）');
  const payload = JSON.stringify({
    id: 'evt_local_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_local_1', payment_status: 'paid', metadata: { orderId: 'ord_billingtest01' } } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const goodSig = createHmac('sha256', webhookSecret).update(`${ts}.${payload}`).digest('hex');
  const goodHeader = `t=${ts},v1=${goodSig}`;

  // 找 webhook 处理入口（不同版本可能叫 parseWebhook / handleWebhook / verifyWebhook）
  const hookFn = billing.verifyWebhook || billing.handleWebhook || billing.parseWebhook || mod.handleWebhook;
  if (typeof hookFn === 'function') {
    const good = await hookFn({ rawBody: payload, headers: { 'stripe-signature': goodHeader } });
    chk(good?.ok === true, '真签名验过', JSON.stringify(good).slice(0, 100));

    const badSig = await hookFn({ rawBody: payload, headers: { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` } });
    chk(badSig?.ok === false, '假签名拒绝', String(badSig?.reason || '').slice(0, 60));

    const tampered = await hookFn({ rawBody: payload.replace('ord_billingtest01', 'ord_evil01'), headers: { 'stripe-signature': goodHeader } });
    chk(tampered?.ok === false, '改了内容签名就对不上', String(tampered?.reason || '').slice(0, 60));
  } else {
    bad('找不到 webhook 验签入口', Object.keys(billing).join(','));
  }

  /* ── 5. 退款 ─────────────────────────────────────────────────── */
  say('');
  say('【第 5 步】退款（POST /v1/refunds）');
  const refundFn = billing.refund || billing.createRefund;  // 真实方法名是 refund
  if (typeof refundFn === 'function') {
    const refunded = await refundFn({ orderId: 'ord_billingtest01', paymentIntentId: 'pi_test_local_1', amount: 1800 });
    chk(refunded?.ok === true, '退款成功', String(refunded?.reason || ''));
    const req2 = fake.seen.find((s) => s.url === '/v1/refunds');
    chk(Boolean(req2), '请求发到了 /v1/refunds');
    chk(req2?.form?.payment_intent === 'pi_test_local_1', '带上了原支付流水号（退对那笔）',
      String(req2?.form?.payment_intent));
  } else {
    bad('找不到退款入口', Object.keys(billing).join(','));
  }

  /* ── 6. 渠道不可达时不许假装成功 ────────────────────────────── */
  say('');
  say('【第 6 步】渠道挂了必须如实失败，绝不许假装付款成功');
  const deadBilling = mod.createBilling({
    provider: 'stripe',
    stripe: { secretKey: 'sk_test_local', webhookSecret, apiBase: 'http://127.0.0.1:1' },
  });
  const dead = await deadBilling.createCheckout({
    orderId: 'ord_dead', amount: 1800, successUrl: 'http://x', cancelUrl: 'http://y',
  });
  chk(dead?.ok === false, '渠道连不上 → 结构化失败', String(dead?.reason || '').slice(0, 70));
  chk(dead?.paid !== true, '没有把 paid 设成 true（这条最要紧）');

  await new Promise((r) => fake.server.close(r));

  say('');
  say('='.repeat(66));
  say(`结论：${pass} 项通过，${fail} 项失败`);
  say('');
  say('边界（照写）：');
  say('  · 验的是**代码路径**：请求打到哪、字段对不对、鉴权头有没有、失败怎么处理。');
  say('  · **没有验**"Stripe 那边真扣了钱"——那需要真 key。所以门槛⑥仍然开着。');
  say('  · 换成真 key 只改配置（AGENTDECK_PAY_PROVIDER / AGENTDECK_PAY_SECRET），代码一行不动。');

  const text = `${lines.join('\n')}\n`;
  mkdirSync(join(REPO, 'docs', 'evidence'), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  process.stdout.write(text);
  process.stdout.write(`\n证据已写入：${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`脚本自己崩了：${err?.stack || err}\n`);
  process.exitCode = 1;
});
