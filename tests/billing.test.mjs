/**
 * tests/billing.test.mjs —— 支付抽象层的验收测试
 *
 * 测试策略（不碰真实资金、不碰真实商户号）：
 * - 签名/验签：本地生成 RSA 密钥对，用**独立实现**（直接 node:crypto 的 createSign/createHmac）
 *   造签名，再让 lib/billing 里的实现去验，避免"自己验自己"的假绿。
 * - 网络：起本地假网关（127.0.0.1:0），通过 config.apiBase / config.gateway 指过去，
 *   断言真实发出的 method / path / headers / body，而不是 mock 掉 fetch。
 * - 幂等：真的写 $DSH_HOME 下的临时目录，跨实例重新加载账本验证"重启也不重复发货"。
 * - 没有商户号这件事本身也要被测：未配置时四个方法必须结构化失败，不许抛、不许假成功。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCipheriv,
  createHmac,
  createSign,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';

import {
  createBilling,
  createEventStore,
  createAlipayAdapter,
  createStripeAdapter,
  eventsFile,
  minorToYuan,
  yuanToMinor,
  assertMinor,
} from '../lib/billing/index.js';

// ---------------------------------------------------------------------------
// 基础设施：临时目录、RSA 密钥、独立签名实现、假网关
// ---------------------------------------------------------------------------

const TEMP_DIRS = [];

function tempRoot(label = 'bill') {
  const dir = mkdtempSync(path.join(os.tmpdir(), `adsk-${label}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
});

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

const WX_MERCHANT = makeKeyPair();
const WX_PLATFORM = makeKeyPair();
const ALI_APP = makeKeyPair();
const ALI_PLATFORM = makeKeyPair();

const WX_MCH_ID = '1900000109';
const WX_APP_ID = 'wxd678efh567hg6787';
const WX_SERIAL = '5157F09EFDC096DE15EBE81A47057A7232F1B8E1';
const WX_API_V3_KEY = 'abcdefghijklmnopqrstuvwxyz012345';
const WX_NOTIFY_URL = 'https://example.com/wx/notify';

const ALI_APP_ID = '2021000000000001';

const STRIPE_SECRET = 'sk_test_fake_abc123';
const STRIPE_WEBHOOK_SECRET = 'whsec_test_fake_xyz';

/** 独立实现：HMAC-SHA256 hex（Stripe 回调签名）。 */
function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** 独立实现：RSA-SHA256 base64（微信/支付宝签名）。 */
function signRsa(privatePem, message) {
  const signer = createSign('RSA-SHA256');
  signer.update(message, 'utf8');
  return signer.sign(privatePem, 'base64');
}

/** 独立实现：RSA-SHA256 验签。 */
function verifyRsa(publicPem, message, signature) {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(message, 'utf8');
  return verifier.verify(publicPem, String(signature || ''), 'base64');
}

/** 起一个假支付网关：记录每个请求（method/url/headers/body），按 responder 回复。 */
async function fakeServer(responder) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(request);
      let reply;
      try {
        reply = responder({ ...request, index: requests.length });
      } catch (err) {
        reply = { status: 500, json: { error: { message: String(err && err.message) } } };
      }
      const status = reply?.status ?? 200;
      const payload = reply?.text != null ? reply.text : JSON.stringify(reply?.json ?? {});
      res.writeHead(status, { 'content-type': reply?.contentType || 'application/json' });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// Stripe 相关构造器
// ---------------------------------------------------------------------------

function stripeBilling(root, options = {}, deps = {}) {
  const { stripe = {}, onPaid } = options;
  return createBilling(
    {
      provider: 'stripe',
      root,
      stripe: { secretKey: STRIPE_SECRET, webhookSecret: STRIPE_WEBHOOK_SECRET, ...stripe },
      ...(onPaid ? { onPaid } : {}),
    },
    deps,
  );
}

function stripeSessionEvent(overrides = {}) {
  return {
    id: 'evt_1',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        client_reference_id: 'order_1',
        metadata: { orderId: 'order_1' },
        amount_total: 1999,
        currency: 'cny',
        payment_status: 'paid',
      },
    },
    ...overrides,
  };
}

function stripeHeader(rawBody, { secret = STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000), extraV1 } = {}) {
  const v1 = hmacHex(secret, `${t}.${rawBody}`);
  return extraV1 ? `t=${t},v1=${extraV1},v1=${v1}` : `t=${t},v1=${v1}`;
}

async function stripeWebhook(billing, event, headerOptions) {
  const rawBody = JSON.stringify(event);
  return billing.verifyWebhook({
    headers: { 'stripe-signature': stripeHeader(rawBody, headerOptions) },
    rawBody,
  });
}

// ---------------------------------------------------------------------------
// 微信相关构造器
// ---------------------------------------------------------------------------

function wechatBilling(root, overrides = {}) {
  return createBilling({
    provider: 'wechat',
    root,
    wechat: {
      mchId: WX_MCH_ID,
      appId: WX_APP_ID,
      serialNo: WX_SERIAL,
      privateKeyPem: WX_MERCHANT.privatePem,
      apiV3Key: WX_API_V3_KEY,
      platformCertPem: WX_PLATFORM.publicPem,
      notifyUrl: WX_NOTIFY_URL,
      ...overrides,
    },
  });
}

/** 解析 WECHATPAY2-SHA256-RSA2048 头里的 k="v" 字段。 */
function parseWechatAuth(header) {
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(String(header)))) out[match[1]] = match[2];
  return out;
}

/** 构造一个真实的微信回调通知（resource 用 APIv3 密钥 AES-256-GCM 加密）。 */
function wechatNotifyBody({
  apiV3Key = WX_API_V3_KEY,
  orderId = 'order_wx_1',
  total = 100,
  tradeState = 'SUCCESS',
  eventId = 'evt-wx-1',
  resourceNonce = 'abcdefghijkl',
  associatedData = 'transaction',
} = {}) {
  const plaintext = JSON.stringify({
    mchid: WX_MCH_ID,
    appid: WX_APP_ID,
    out_trade_no: orderId,
    transaction_id: '4200001234202411051234567890',
    trade_state: tradeState,
    amount: { total, currency: 'CNY', payer_total: total },
  });
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(resourceNonce, 'utf8'));
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
  return JSON.stringify({
    id: eventId,
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, nonce: resourceNonce, associated_data: associatedData },
  });
}

function wechatNotifyHeaders(body, { timestamp = Math.floor(Date.now() / 1000), nonce = 'notifynonce123' } = {}) {
  return {
    'Wechatpay-Timestamp': String(timestamp),
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signRsa(WX_PLATFORM.privatePem, `${timestamp}\n${nonce}\n${body}\n`),
    'Wechatpay-Serial': WX_SERIAL,
  };
}

// ---------------------------------------------------------------------------
// 支付宝相关构造器
// ---------------------------------------------------------------------------

function alipayBilling(root, overrides = {}) {
  return createBilling({
    provider: 'alipay',
    root,
    alipay: {
      appId: ALI_APP_ID,
      privateKeyPem: ALI_APP.privatePem,
      alipayPublicKeyPem: ALI_PLATFORM.publicPem,
      notifyUrl: 'https://example.com/ali/notify',
      returnUrl: 'https://example.com/ali/return',
      ...overrides,
    },
  });
}

/** 独立实现支付宝待签名串：去 sign/sign_type、空值、升序、k=v& 连接。 */
function alipayContent(params) {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => params[key] != null && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function alipayNotifyBody(overrides = {}) {
  const params = {
    app_id: ALI_APP_ID,
    notify_id: 'notify-1',
    out_trade_no: 'order_ali_1',
    total_amount: '12.34',
    trade_status: 'TRADE_SUCCESS',
    charset: 'utf-8',
    version: '1.0',
    ...overrides,
  };
  params.sign_type = 'RSA2';
  params.sign = signRsa(ALI_PLATFORM.privatePem, alipayContent(params));
  return new URLSearchParams(params).toString();
}

/** 构造支付宝退款响应：sign 覆盖 alipay_trade_refund_response 节点原文。 */
function alipayRefundResponse(node = {}, { tamperFee } = {}) {
  const signedNode = {
    code: '10000',
    msg: 'Success',
    trade_no: '2024110522001440000000000001',
    out_trade_no: 'order_ali_1',
    refund_fee: '5.00',
    ...node,
  };
  const signedText = JSON.stringify(signedNode);
  const sign = signRsa(ALI_PLATFORM.privatePem, signedText);
  const bodyText = tamperFee
    ? JSON.stringify({ ...signedNode, refund_fee: tamperFee })
    : signedText;
  return `{"alipay_trade_refund_response":${bodyText},"sign":"${sign}"}`;
}

// ---------------------------------------------------------------------------
// 1｜没有配置：四个方法全部如实失败
// ---------------------------------------------------------------------------

test('未配置 provider：四个方法都如实失败，不抛异常', async () => {
  const billing = createBilling({ root: tempRoot() });
  assert.equal(billing.provider, null);

  const health = billing.health();
  assert.equal(health.ok, false);
  assert.equal(health.configured, false);
  assert.equal(health.reason, '环境未配');
  assert.match(health.hint, /billing\.provider/);

  const checkout = await billing.createCheckout({ orderId: 'order_1', amount: 1999 });
  assert.equal(checkout.ok, false);
  assert.equal(checkout.reason, '环境未配');
  assert.match(checkout.hint, /billing\.provider/);
  assert.equal(checkout.url, undefined);

  const webhook = await billing.verifyWebhook({ headers: {}, rawBody: '{}' });
  assert.equal(webhook.ok, false);
  assert.equal(webhook.signatureOk, false);
  assert.equal(webhook.reason, '环境未配');

  const refund = await billing.refund({ orderId: 'order_1', amount: 1999 });
  assert.equal(refund.ok, false);
  assert.equal(refund.reason, '环境未配');
});

test('未知 provider：明确说不支持，并列出可选值', async () => {
  const billing = createBilling({ provider: 'paypal', root: tempRoot() });
  assert.equal(billing.provider, 'paypal');

  const health = billing.health();
  assert.equal(health.ok, false);
  assert.equal(health.configured, false);
  assert.equal(health.reason, '不支持的 provider');
  assert.match(health.hint, /stripe/);
  assert.match(health.hint, /wechat/);
  assert.match(health.hint, /alipay/);

  const checkout = await billing.createCheckout({ orderId: 'o1', amount: 100 });
  assert.equal(checkout.ok, false);
  assert.equal(checkout.reason, '不支持的 provider');
  const refund = await billing.refund({ orderId: 'o1', amount: 100 });
  assert.equal(refund.ok, false);
  assert.equal(refund.reason, '不支持的 provider');
});

test('manual 渠道：只给人工指令，绝不声称已收款', async () => {
  const billing = createBilling({ provider: 'manual', root: tempRoot() });
  const health = billing.health();
  assert.equal(health.ok, true);
  assert.equal(health.provider, 'manual');
  assert.equal(health.configured, true);
  assert.equal(health.mode, 'offline');

  const checkout = await billing.createCheckout({ orderId: 'order_manual_1', amount: 500 });
  assert.equal(checkout.ok, true);
  assert.equal(checkout.provider, 'manual');
  assert.equal(checkout.url, null);
  assert.equal(checkout.code, 'MANUAL-order_manual_1');
  assert.match(checkout.raw.note, /不是支付链接/);

  const webhook = await billing.verifyWebhook({ headers: {}, rawBody: '' });
  assert.equal(webhook.ok, false);
  assert.equal(webhook.signatureOk, false);
  assert.match(webhook.reason, /没有 webhook/);

  const refund = await billing.refund({ orderId: 'order_manual_1', amount: 500 });
  assert.equal(refund.ok, false);
  assert.match(refund.reason, /人工处理/);
});

// ---------------------------------------------------------------------------
// 2｜金额：整数分是硬规则
// ---------------------------------------------------------------------------

test('金额一律整数分：非法金额结构化失败，换算函数拒绝三位小数', async () => {
  assert.equal(minorToYuan(1999), '19.99');
  assert.equal(minorToYuan(1), '0.01');
  assert.equal(minorToYuan(100), '1.00');
  assert.equal(yuanToMinor('12.34'), 1234);
  assert.equal(yuanToMinor('0.01'), 1);
  assert.equal(yuanToMinor(0.1), 10);
  assert.throws(() => minorToYuan(0), /正整数分/);
  assert.throws(() => yuanToMinor('12.345'), /两位小数|十进制/);
  assert.throws(() => yuanToMinor('-1'), /十进制/);
  assert.throws(() => assertMinor(12.5), TypeError);

  const billing = stripeBilling(tempRoot());
  for (const amount of [12.5, 0, -100, '1999', null]) {
    const result = await billing.createCheckout({
      orderId: 'order_1',
      amount,
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
    });
    assert.equal(result.ok, false, `amount=${JSON.stringify(amount)} 必须失败`);
    assert.match(result.reason, /正整数分/);
  }

  // 适配器层直接调用会抛 TypeError（编程错误），外层 API 负责转成结构化失败
  const direct = createStripeAdapter({ secretKey: STRIPE_SECRET });
  await assert.rejects(
    direct.createCheckout({
      orderId: 'order_1',
      amount: 12.5,
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
    }),
    /正整数分/,
  );
});

// ---------------------------------------------------------------------------
// 3｜密钥不回显
// ---------------------------------------------------------------------------

test('密钥不回显：health / 结果 / 账本里都不出现明文密钥', async () => {
  const root = tempRoot();
  const billing = stripeBilling(root);
  const healthText = JSON.stringify(billing.health());
  assert.ok(!healthText.includes(STRIPE_SECRET), 'health 里不能出现 secretKey');
  assert.ok(!healthText.includes(STRIPE_WEBHOOK_SECRET), 'health 里不能出现 webhookSecret');

  const wxHealthText = JSON.stringify(
    wechatBilling(tempRoot()).health(),
  );
  assert.ok(!wxHealthText.includes(WX_MERCHANT.privatePem.slice(30, 90)), 'health 里不能出现微信私钥');

  const aliHealthText = JSON.stringify(alipayBilling(tempRoot()).health());
  assert.ok(!aliHealthText.includes(ALI_APP.privatePem.slice(30, 90)), 'health 里不能出现支付宝私钥');

  const event = stripeSessionEvent();
  const result = await stripeWebhook(billing, event);
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes(STRIPE_WEBHOOK_SECRET), 'webhook 结果里不能出现 webhookSecret');

  const file = path.join(root, 'billing', 'events.json');
  const savedText = readFileSync(file, 'utf8');
  assert.ok(!savedText.includes(STRIPE_SECRET));
  assert.ok(!savedText.includes(STRIPE_WEBHOOK_SECRET));
});

// ---------------------------------------------------------------------------
// 4｜Stripe：未配置 / 下单 / 回调 / 退款
// ---------------------------------------------------------------------------

test('Stripe 未配置：health、下单、回调、退款全部诚实失败', async () => {
  const billing = createBilling({ provider: 'stripe', root: tempRoot() });
  const health = billing.health();
  assert.equal(health.ok, false);
  assert.equal(health.provider, 'stripe');
  assert.equal(health.configured, false);
  assert.equal(health.reason, '环境未配');
  assert.match(health.hint, /secretKey/);

  const checkout = await billing.createCheckout({ orderId: 'o1', amount: 100 });
  assert.equal(checkout.ok, false);
  assert.equal(checkout.reason, '环境未配');

  const webhook = await billing.verifyWebhook({ headers: {}, rawBody: '{}' });
  assert.equal(webhook.ok, false);
  assert.equal(webhook.signatureOk, false);
  assert.equal(webhook.reason, '环境未配');
  assert.match(webhook.hint, /webhookSecret/);

  const refund = await billing.refund({ orderId: 'o1', amount: 100 });
  assert.equal(refund.ok, false);
  assert.equal(refund.reason, '环境未配');
});

test('Stripe 下单：真的发出 checkout.sessions 请求（Bearer + 幂等键 + 整数分）', async (t) => {
  const server = await fakeServer(() => ({
    json: { id: 'cs_test_123', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
  }));
  t.after(() => server.close());

  const billing = stripeBilling(tempRoot(), { stripe: { apiBase: server.base } });
  const result = await billing.createCheckout({
    orderId: 'order_1',
    amount: 1999,
    currency: 'CNY',
    subject: '托管额度 20 元',
    successUrl: 'https://example.com/ok',
    cancelUrl: 'https://example.com/cancel',
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'stripe');
  assert.equal(result.code, 'cs_test_123');
  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
  assert.ok(!JSON.stringify(result).includes(STRIPE_SECRET));

  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/checkout/sessions');
  assert.equal(request.headers.authorization, `Bearer ${STRIPE_SECRET}`);
  assert.equal(request.headers['idempotency-key'], 'order_1');
  assert.match(request.headers['content-type'], /application\/x-www-form-urlencoded/);

  const form = new URLSearchParams(request.body);
  assert.equal(form.get('mode'), 'payment');
  assert.equal(form.get('client_reference_id'), 'order_1');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '1999');
  assert.equal(form.get('line_items[0][price_data][currency]'), 'cny');
  assert.equal(form.get('line_items[0][price_data][product_data][name]'), '托管额度 20 元');
  assert.equal(form.get('success_url'), 'https://example.com/ok');
  assert.equal(form.get('cancel_url'), 'https://example.com/cancel');
  assert.equal(form.get('metadata[orderId]'), 'order_1');
});

test('Stripe 下单失败：把网关错误翻成人话带回来，不泄露密钥', async (t) => {
  const server = await fakeServer(() => ({
    status: 402,
    json: { error: { message: 'Your card was declined.', type: 'card_error' } },
  }));
  t.after(() => server.close());

  const billing = stripeBilling(tempRoot(), { stripe: { apiBase: server.base } });
  const result = await billing.createCheckout({
    orderId: 'order_1',
    amount: 1999,
    successUrl: 'https://example.com/ok',
    cancelUrl: 'https://example.com/cancel',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 402/);
  assert.match(result.reason, /declined/);
  assert.equal(result.httpStatus, 402);
  assert.ok(!JSON.stringify(result).includes(STRIPE_SECRET));

  const missingUrl = await billing.createCheckout({ orderId: 'order_2', amount: 100 });
  assert.equal(missingUrl.ok, false);
  assert.match(missingUrl.reason, /successUrl/);
});

test('Stripe 回调：签名正确才认，解析订单号/金额/是否付款', async () => {
  const billing = stripeBilling(tempRoot());
  const event = stripeSessionEvent();
  const result = await stripeWebhook(billing, event);

  assert.equal(result.ok, true);
  assert.equal(result.signatureOk, true);
  assert.equal(result.event.id, 'evt_1');
  assert.equal(result.event.type, 'checkout.session.completed');
  assert.equal(result.orderId, 'order_1');
  assert.equal(result.paidAmount, 1999);
  assert.equal(result.paid, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.eventId, 'evt_1');
});

test('Stripe 回调：过期时间戳按重放拒绝，不认签名', async () => {
  const billing = stripeBilling(tempRoot());
  const rawBody = JSON.stringify(stripeSessionEvent());
  const result = await billing.verifyWebhook({
    headers: { 'stripe-signature': stripeHeader(rawBody, { t: Math.floor(Date.now() / 1000) - 400 }) },
    rawBody,
  });
  assert.equal(result.ok, false);
  assert.equal(result.signatureOk, false);
  assert.match(result.reason, /容差/);
  assert.ok(result.timestampSkew >= 400);
});

test('Stripe 回调：body 被篡改 / 缺签名头 都拒绝', async () => {
  const billing = stripeBilling(tempRoot());
  const original = JSON.stringify(stripeSessionEvent());
  const signature = stripeHeader(original);

  const tampered = JSON.stringify(stripeSessionEvent({
    data: { object: { ...stripeSessionEvent().data.object, amount_total: 1 } },
  }));
  const tamperedResult = await billing.verifyWebhook({
    headers: { 'stripe-signature': signature },
    rawBody: tampered,
  });
  assert.equal(tamperedResult.ok, false);
  assert.equal(tamperedResult.signatureOk, false);
  assert.match(tamperedResult.reason, /签名不匹配/);

  const missing = await billing.verifyWebhook({ headers: {}, rawBody: original });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /Stripe-Signature/);

  const malformed = await billing.verifyWebhook({ headers: { 'stripe-signature': 'v2=oops' }, rawBody: original });
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /格式不对/);
});

test('Stripe 回调：多个 v1 里有一个对就通过（密钥轮换期）', async () => {
  const billing = stripeBilling(tempRoot());
  const rawBody = JSON.stringify(stripeSessionEvent());
  const result = await billing.verifyWebhook({
    headers: { 'stripe-signature': stripeHeader(rawBody, { extraV1: 'deadbeef' }) },
    rawBody,
  });
  assert.equal(result.ok, true);
  assert.equal(result.signatureOk, true);
});

test('Stripe 回调：未付款事件 paid:false，不触发 onPaid', async () => {
  let calls = 0;
  const billing = stripeBilling(tempRoot(), { onPaid: () => { calls += 1; } });
  const event = stripeSessionEvent({
    id: 'evt_unpaid',
    data: {
      object: { ...stripeSessionEvent().data.object, payment_status: 'unpaid' },
    },
  });
  const result = await stripeWebhook(billing, event);
  assert.equal(result.ok, true);
  assert.equal(result.signatureOk, true);
  assert.equal(result.paid, false);
  assert.equal(result.duplicate, false);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 5｜幂等：同一事件只处理一次
// ---------------------------------------------------------------------------

test('幂等：同一事件重复投递只处理一次，onPaid 只触发一次，账本落盘', async () => {
  const root = tempRoot();
  let calls = 0;
  const billing = stripeBilling(root, { onPaid: () => { calls += 1; } });
  const event = stripeSessionEvent();
  const rawBody = JSON.stringify(event);
  const headers = { 'stripe-signature': stripeHeader(rawBody) };

  const first = await billing.verifyWebhook({ headers, rawBody });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.idempotency, 'first');
  assert.equal(calls, 1);

  const second = await billing.verifyWebhook({ headers, rawBody });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.idempotency, 'duplicate');
  assert.equal(second.firstSeenAt, first.firstSeenAt ?? second.firstSeenAt);
  assert.equal(calls, 1, '重复投递不能再触发 onPaid');

  const file = path.join(root, 'billing', 'events.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].id, 'evt_1');
  assert.equal(saved.events[0].orderId, 'order_1');
  assert.equal(saved.events[0].amount, 1999);
  assert.equal(saved.events[0].type, 'checkout.session.completed');

  const dirEntries = readdirSync(path.join(root, 'billing'));
  assert.deepEqual(dirEntries, ['events.json'], '原子写不能留下 .tmp 残渣');
});

test('幂等：换一个实例（同 root）也认账本，重启不重复发货', async () => {
  const root = tempRoot();
  const rawBody = JSON.stringify(stripeSessionEvent());
  const headers = { 'stripe-signature': stripeHeader(rawBody) };

  const firstBilling = stripeBilling(root);
  const first = await firstBilling.verifyWebhook({ headers, rawBody });
  assert.equal(first.duplicate, false);

  let calls = 0;
  const secondBilling = stripeBilling(root, { onPaid: () => { calls += 1; } });
  const second = await secondBilling.verifyWebhook({ headers, rawBody });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(calls, 0);
  assert.equal(secondBilling.events.size, 1);
});

test('账本损坏/缺失时不崩：当空账本继续，且能自愈重写', async () => {
  const root = tempRoot();
  const file = path.join(root, 'billing', 'events.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{ this is not json', 'utf8');

  const store = createEventStore({ file });
  assert.equal(store.size, 0);
  assert.match(store.loadError, /JSON|property name|Unexpected/i);

  const claim = store.claim('evt_recovered', { orderId: 'order_1', amount: 100 });
  assert.equal(claim.ok, true);
  assert.equal(claim.duplicate, false);

  const reloaded = createEventStore({ file });
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.has('evt_recovered'), true);
  assert.equal(reloaded.loadError, '');
});

test('DSH_HOME 决定账本默认路径（不碰真实 ~/.dsh）', () => {
  const root = tempRoot('home');
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const billing = createBilling({ provider: 'manual' });
    assert.equal(billing.eventsFile, path.join(root, 'billing', 'events.json'));
    assert.equal(eventsFile(root), path.join(root, 'billing', 'events.json'));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
});

// ---------------------------------------------------------------------------
// 6｜Stripe 退款
// ---------------------------------------------------------------------------

test('Stripe 退款：缺 paymentIntentId 明说缺什么；给了就真的发 /v1/refunds', async (t) => {
  const server = await fakeServer(() => ({ json: { id: 're_123', status: 'succeeded' } }));
  t.after(() => server.close());

  const billing = stripeBilling(tempRoot(), { stripe: { apiBase: server.base } });

  const missing = await billing.refund({ orderId: 'order_1', amount: 500 });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /paymentIntentId/);
  assert.equal(server.requests.length, 0, '缺关键信息时不该空打网络请求');

  const result = await billing.refund({
    orderId: 'order_1',
    amount: 500,
    paymentIntentId: 'pi_123',
    reason: 'requested_by_customer',
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'stripe');
  assert.equal(result.refundId, 're_123');
  assert.equal(result.status, 'succeeded');

  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request.url, '/v1/refunds');
  assert.equal(request.headers.authorization, `Bearer ${STRIPE_SECRET}`);
  const form = new URLSearchParams(request.body);
  assert.equal(form.get('payment_intent'), 'pi_123');
  assert.equal(form.get('amount'), '500');
  assert.equal(form.get('reason'), 'requested_by_customer');
  assert.equal(form.get('metadata[orderId]'), 'order_1');
});

// ---------------------------------------------------------------------------
// 7｜微信支付
// ---------------------------------------------------------------------------

test('微信未配置：诚实报未配，不假装下单', async () => {
  const billing = createBilling({ provider: 'wechat', root: tempRoot() });
  const health = billing.health();
  assert.equal(health.ok, false);
  assert.equal(health.provider, 'wechat');
  assert.equal(health.configured, false);
  assert.equal(health.reason, '环境未配');
  assert.match(health.hint, /mchId/);

  const checkout = await billing.createCheckout({ orderId: 'o1', amount: 100 });
  assert.equal(checkout.ok, false);
  assert.equal(checkout.reason, '环境未配');

  const refund = await billing.refund({ orderId: 'o1', amount: 100, total: 100 });
  assert.equal(refund.ok, false);
  assert.equal(refund.reason, '环境未配');
});

test('微信下单：APIv3 签名可被商户公钥验证，金额是整数分', async (t) => {
  const server = await fakeServer(() => ({ json: { code_url: 'weixin://wxpay/bizpayurl?pr=abc123' } }));
  t.after(() => server.close());

  const billing = wechatBilling(tempRoot(), { apiBase: server.base });
  const result = await billing.createCheckout({ orderId: 'order_wx_1', amount: 100, subject: '托管额度' });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'wechat');
  assert.equal(result.code, 'weixin://wxpay/bizpayurl?pr=abc123');
  assert.equal(result.url, null);

  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v3/pay/transactions/native');
  assert.match(request.headers.authorization, /^WECHATPAY2-SHA256-RSA2048 /);

  const auth = parseWechatAuth(request.headers.authorization);
  assert.equal(auth.mchid, WX_MCH_ID);
  assert.equal(auth.serial_no, WX_SERIAL);
  assert.ok(auth.nonce_str && auth.nonce_str.length > 0);
  const message = `POST\n/v3/pay/transactions/native\n${auth.timestamp}\n${auth.nonce_str}\n${request.body}\n`;
  assert.equal(verifyRsa(WX_MERCHANT.publicPem, message, auth.signature), true, '请求签名必须能被商户公钥验证');

  const body = JSON.parse(request.body);
  assert.equal(body.appid, WX_APP_ID);
  assert.equal(body.mchid, WX_MCH_ID);
  assert.equal(body.out_trade_no, 'order_wx_1');
  assert.equal(body.description, '托管额度');
  assert.equal(body.notify_url, WX_NOTIFY_URL);
  assert.equal(body.amount.total, 100);
  assert.equal(body.amount.currency, 'CNY');
  assert.ok(!JSON.stringify(result).includes(WX_MERCHANT.privatePem.slice(30, 90)));
});

test('微信下单：金额/币种/回调地址/网关报错 都是人话', async (t) => {
  let reply = { json: { code_url: 'weixin://wxpay/bizpayurl?pr=abc123' } };
  const server = await fakeServer(() => reply);
  t.after(() => server.close());

  const billing = wechatBilling(tempRoot(), { apiBase: server.base });

  const badAmount = await billing.createCheckout({ orderId: 'o1', amount: 1.5 });
  assert.equal(badAmount.ok, false);
  assert.match(badAmount.reason, /正整数分/);
  assert.equal(server.requests.length, 0, '入参不合法时不该空打网络请求');

  const badCurrency = await billing.createCheckout({ orderId: 'o1', amount: 100, currency: 'USD' });
  assert.equal(badCurrency.ok, false);
  assert.match(badCurrency.reason, /只支持 CNY/);

  const noNotify = wechatBilling(tempRoot(), { apiBase: server.base, notifyUrl: '' });
  const missingNotify = await noNotify.createCheckout({ orderId: 'o1', amount: 100 });
  assert.equal(missingNotify.ok, false);
  assert.match(missingNotify.reason, /notifyUrl/);
  assert.equal(server.requests.length, 0);

  reply = { status: 403, json: { code: 'SIGN_ERROR', message: '签名错误' } };
  const gatewayError = await billing.createCheckout({ orderId: 'o1', amount: 100 });
  assert.equal(gatewayError.ok, false);
  assert.match(gatewayError.reason, /HTTP 403/);
  assert.match(gatewayError.reason, /签名错误/);
  assert.equal(gatewayError.httpStatus, 403);
  assert.equal(server.requests.length, 1);
});

test('微信回调：验签 + AES-GCM 解密；篡改/过期/密钥错/商户号错都拒绝', async () => {
  const billing = wechatBilling(tempRoot());
  const body = wechatNotifyBody();
  const result = await billing.verifyWebhook({ headers: wechatNotifyHeaders(body), rawBody: body });

  assert.equal(result.ok, true);
  assert.equal(result.signatureOk, true);
  assert.equal(result.event.id, 'evt-wx-1');
  assert.equal(result.orderId, 'order_wx_1');
  assert.equal(result.paidAmount, 100);
  assert.equal(result.paid, true);

  const tampered = await billing.verifyWebhook({
    headers: wechatNotifyHeaders(body),
    rawBody: body.replace('TRANSACTION.SUCCESS', 'TRANSACTION.FAILED'),
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.signatureOk, false);
  assert.match(tampered.reason, /签名不匹配/);

  const expired = await billing.verifyWebhook({
    headers: wechatNotifyHeaders(body, { timestamp: Math.floor(Date.now() / 1000) - 400 }),
    rawBody: body,
  });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /容差/);

  const wrongKey = wechatBilling(tempRoot(), { apiV3Key: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
  const decryptFail = await wrongKey.verifyWebhook({ headers: wechatNotifyHeaders(body), rawBody: body });
  assert.equal(decryptFail.ok, false);
  assert.equal(decryptFail.signatureOk, true);
  assert.match(decryptFail.reason, /解密失败/);

  const wrongMch = wechatBilling(tempRoot(), { mchId: '1900000999' });
  const mchFail = await wrongMch.verifyWebhook({ headers: wechatNotifyHeaders(body), rawBody: body });
  assert.equal(mchFail.ok, false);
  assert.equal(mchFail.signatureOk, true);
  assert.match(mchFail.reason, /mchid/);

  const noPlatformKey = wechatBilling(tempRoot(), { platformCertPem: '' });
  const notConfigured = await noPlatformKey.verifyWebhook({ headers: {}, rawBody: body });
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.reason, '环境未配');
  assert.match(notConfigured.hint, /platformCertPem/);
});

test('微信退款：必须给原订单总额 total，给了就真的发 /v3/refund/domestic/refunds', async (t) => {
  const server = await fakeServer(() => ({
    json: { refund_id: '5030000000202411051234567890', status: 'PROCESSING' },
  }));
  t.after(() => server.close());

  const billing = wechatBilling(tempRoot(), { apiBase: server.base });

  const missingTotal = await billing.refund({ orderId: 'order_wx_1', amount: 100 });
  assert.equal(missingTotal.ok, false);
  assert.match(missingTotal.reason, /总额/);
  assert.equal(server.requests.length, 0);

  const result = await billing.refund({ orderId: 'order_wx_1', amount: 100, total: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'wechat');
  assert.equal(result.refundId, '5030000000202411051234567890');
  assert.equal(result.status, 'PROCESSING');

  const request = server.requests[0];
  assert.equal(request.url, '/v3/refund/domestic/refunds');
  const auth = parseWechatAuth(request.headers.authorization);
  const message = `POST\n/v3/refund/domestic/refunds\n${auth.timestamp}\n${auth.nonce_str}\n${request.body}\n`;
  assert.equal(verifyRsa(WX_MERCHANT.publicPem, message, auth.signature), true);
  const body = JSON.parse(request.body);
  assert.equal(body.out_trade_no, 'order_wx_1');
  assert.equal(body.amount.refund, 100);
  assert.equal(body.amount.total, 100);
});

// ---------------------------------------------------------------------------
// 8｜支付宝
// ---------------------------------------------------------------------------

test('支付宝未配置：诚实报未配，不生成假链接', async () => {
  const billing = createBilling({ provider: 'alipay', root: tempRoot() });
  const health = billing.health();
  assert.equal(health.ok, false);
  assert.equal(health.provider, 'alipay');
  assert.equal(health.configured, false);
  assert.equal(health.reason, '环境未配');
  assert.match(health.hint, /appId/);

  const checkout = await billing.createCheckout({ orderId: 'o1', amount: 100 });
  assert.equal(checkout.ok, false);
  assert.equal(checkout.reason, '环境未配');
  assert.equal(checkout.url, undefined);

  const refund = await billing.refund({ orderId: 'o1', amount: 100 });
  assert.equal(refund.ok, false);
  assert.equal(refund.reason, '环境未配');
});

test('支付宝下单：本地 RSA2 签名链接，参数可被应用公钥验证', async () => {
  const billing = alipayBilling(tempRoot());
  const result = await billing.createCheckout({ orderId: 'order_ali_1', amount: 1234, subject: '托管额度' });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'alipay');
  assert.match(result.url, /^https:\/\/openapi\.alipay\.com\/gateway\.do\?/);
  assert.equal(result.code, 'order_ali_1');

  const url = new URL(result.url);
  const params = Object.fromEntries(url.searchParams.entries());
  assert.equal(params.app_id, ALI_APP_ID);
  assert.equal(params.method, 'alipay.trade.page.pay');
  assert.equal(params.sign_type, 'RSA2');
  assert.equal(params.charset, 'utf-8');
  assert.ok(params.sign);
  assert.equal(verifyRsa(ALI_APP.publicPem, alipayContent(params), params.sign), true, 'URL 里的 sign 必须被应用公钥验证通过');

  const biz = JSON.parse(params.biz_content);
  assert.equal(biz.out_trade_no, 'order_ali_1');
  assert.equal(biz.total_amount, '12.34');
  assert.equal(biz.subject, '托管额度');
  assert.equal(biz.product_code, 'FAST_INSTANT_TRADE_PAY');
  assert.equal(params.notify_url, 'https://example.com/ali/notify');
  assert.equal(params.return_url, 'https://example.com/ali/return');
});

test('支付宝回调：验签通过才认；篡改、app_id 不符、未付款都按规则处理', async () => {
  const billing = alipayBilling(tempRoot());

  const body = alipayNotifyBody();
  const result = await billing.verifyWebhook({ headers: {}, rawBody: body });
  assert.equal(result.ok, true);
  assert.equal(result.signatureOk, true);
  assert.equal(result.event.id, 'notify-1');
  assert.equal(result.orderId, 'order_ali_1');
  assert.equal(result.paidAmount, 1234);
  assert.equal(result.paid, true);

  const tamperedBody = alipayNotifyBody().replace('total_amount=12.34', 'total_amount=9999.00');
  const tampered = await billing.verifyWebhook({ headers: {}, rawBody: tamperedBody });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.signatureOk, false);
  assert.match(tampered.reason, /签名不匹配/);

  const wrongApp = await billing.verifyWebhook({
    headers: {},
    rawBody: alipayNotifyBody({ app_id: '2021000000009999' }),
  });
  assert.equal(wrongApp.ok, false);
  assert.equal(wrongApp.signatureOk, true);
  assert.match(wrongApp.reason, /app_id/);

  const waiting = await billing.verifyWebhook({
    headers: {},
    rawBody: alipayNotifyBody({ trade_status: 'WAIT_BUYER_PAY' }),
  });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.paid, false);

  const noPublicKey = alipayBilling(tempRoot(), { alipayPublicKeyPem: '' });
  const notConfigured = await noPublicKey.verifyWebhook({ headers: {}, rawBody: body });
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.reason, '环境未配');
  assert.match(notConfigured.hint, /alipayPublicKeyPem/);
});

test('支付宝退款：响应节点验签；篡改响应、业务失败都如实报错', async (t) => {
  const server = await fakeServer(({ body }) => {
    const refundAmount = new URLSearchParams(body).get('biz_content');
    assert.ok(refundAmount);
    return { text: alipayRefundResponse() };
  });
  t.after(() => server.close());

  const billing = alipayBilling(tempRoot(), { gateway: server.base });

  const missingKey = alipayBilling(tempRoot(), { gateway: server.base, alipayPublicKeyPem: '' });
  const notConfigured = await missingKey.refund({ orderId: 'order_ali_1', amount: 500 });
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.reason, '环境未配');
  assert.match(notConfigured.hint, /alipayPublicKeyPem/);

  const result = await billing.refund({ orderId: 'order_ali_1', amount: 500, reason: '用户申请' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'alipay');
  assert.equal(result.refundId, '2024110522001440000000000001');
  assert.equal(result.refundFee, '5.00');

  const request = server.requests[0];
  const form = Object.fromEntries(new URLSearchParams(request.body).entries());
  assert.equal(form.method, 'alipay.trade.refund');
  assert.equal(form.app_id, ALI_APP_ID);
  assert.ok(form.sign);
  assert.equal(verifyRsa(ALI_APP.publicPem, alipayContent(form), form.sign), true, '退款请求签名必须被应用公钥验证');
  const biz = JSON.parse(form.biz_content);
  assert.equal(biz.out_trade_no, 'order_ali_1');
  assert.equal(biz.refund_amount, '5.00');
  assert.equal(biz.refund_reason, '用户申请');
});

test('支付宝退款：响应被篡改必须失败，业务失败要带原始码', async (t) => {
  let reply = alipayRefundResponse({}, { tamperFee: '9999.00' });
  const server = await fakeServer(() => ({ text: reply }));
  t.after(() => server.close());

  const billing = alipayBilling(tempRoot(), { gateway: server.base });

  const tampered = await billing.refund({ orderId: 'order_ali_1', amount: 500 });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /签名校验失败/);

  reply = alipayRefundResponse({ code: '20000', msg: 'Business Failed', sub_msg: '交易不存在' });
  const businessFail = await billing.refund({ orderId: 'order_ali_1', amount: 500 });
  assert.equal(businessFail.ok, false);
  assert.match(businessFail.reason, /交易不存在/);
  assert.match(businessFail.reason, /20000/);
});
