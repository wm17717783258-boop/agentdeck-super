/**
 * 换一台电脑还能不能用 —— 收钱这条链上最后一个真实场景。
 *
 * A 电脑买完，第二天在公司电脑 B 上装同一个插件。下面这些断言不关心内部实现，
 * 只回答两个问题：
 *   · 买家**该拿到的**能不能拿到（否则他会来骂人）；
 *   · 没付钱的人**不该拿到的**能不能白拿（否则卖家白干）。
 *
 * 这里用两个独立 root 模拟两台电脑：各自一份 market 目录、各自一把封印密钥。
 * 现实里这两把密钥天然不同（没人会把隐藏密钥文件跟着账本一起拷）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { createMarket } from '../lib/market/index.js';
import { createMarketTool } from '../lib/tools/market.js';
import * as license from '../lib/license.js';

const SKIN = 'premium-nebula';        // 买了、并且卖家签了码的那套
const LOCAL_SKIN = 'premium-aurora';  // 买了、但没签码（只在本机有效）

/**
 * 签发密钥：有真密钥就用真的（顺带验证它跟内置公钥配对），
 * 没有就临时造一对并注入环境变量 —— 但不能因为缺私钥就让测试挂掉。
 */
function issuerPrivateKey() {
  const pem = join(homedir(), '.agentdeck-issuer', 'issuer-private.pem');
  if (existsSync(pem)) return readFileSync(pem, 'utf8');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.AGENTDECK_LICENSE_PUBKEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function sign(claims) {
  const nowSec = Math.floor(Date.now() / 1000);
  return license.encodeLicense({ tier: 'free', iat: nowSec, exp: nowSec + 365 * 86400, ...claims }, issuerPrivateKey());
}

/** 一台"电脑"：root + 市场 + 授权工具 */
function machine(tag) {
  const root = mkdtempSync(join(tmpdir(), `adsk-xdev-${tag}-`));
  const market = createMarket({ root, billing: null });
  const tool = createMarketTool({ market, billing: null });
  return {
    root,
    market,
    paths: market.paths,
    run: (args) => tool.execute(args, {}),
    entry: (id) => market.catalog().skins.find((s) => s.id === id),
    warnings: () => market.catalog().warnings || [],
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const text = (r) => (r && typeof r === 'object' && typeof r.text === 'string' ? r.text : String(r ?? ''));
const orderIdOf = (text) => (String(text).match(/ord_[A-Za-z0-9_-]+/) || [])[0] || '';

/** 在 A 上完整买一套：下单 → 人工确认（可带签码） */
async function buyOn(A, skinId, licenseKey = '') {
  const placed = orderIdOf(text(await A.run({ action: 'place', skinId })));
  assert.ok(placed, '下单没拿到订单号');
  const conf = await A.run({
    action: 'confirm',
    orderId: placed,
    paymentRef: `TEST-${placed}`,
    ...(licenseKey ? { licenseKey } : {}),
  });
  return { orderId: placed, confirm: text(conf) };
}

test('只带那串码换机器：新电脑能用，没签码的那套仍然锁着', async () => {
  const A = machine('a');
  const B = machine('b');
  try {
    const code = sign({ sub: '买家', skins: [SKIN] });
    await buyOn(A, SKIN, code);
    await buyOn(A, LOCAL_SKIN); // 没签码

    assert.equal(A.entry(SKIN)?.owned, true, 'A 上买完必须能用');
    assert.equal(B.entry(SKIN)?.owned, false, 'B 是干净设备，一开始必须锁着');

    // 换机的正路：把码写进 B 的授权文件（对应 deck_license activate）
    const put = license.writeLicenseKey(B.root, code);
    assert.equal(put.ok !== false, true, '写授权文件失败');

    assert.equal(B.entry(SKIN)?.owned, true, 'B 只用这串码就该能用');
    assert.equal(B.entry(SKIN)?.grantedBy, 'signed', '来源要标成签名授权');
    assert.equal(B.entry(LOCAL_SKIN)?.owned, false, '授权码是点名的，不能顺带解锁别套');
  } finally {
    A.done();
    B.done();
  }
});

test('把 A 的账本拷到 B：本机凭据不采信，但夹在里面的签名码照认', async () => {
  const A = machine('a');
  const B = machine('b');
  try {
    const code = sign({ sub: '买家', skins: [SKIN] });
    await buyOn(A, SKIN, code);
    await buyOn(A, LOCAL_SKIN);

    // 先让 B 有自己的封印密钥（真实换机时 B 早就在用了）
    B.market.catalog();

    // 用户最常见的误解：把 market 目录里的两份 JSON 拷过去
    mkdirSync(join(B.root, 'market'), { recursive: true });
    for (const f of ['ledger.json', 'orders.json']) {
      const src = join(A.root, 'market', f);
      if (existsSync(src)) writeFileSync(join(B.root, 'market', f), readFileSync(src));
    }

    assert.equal(
      B.entry(LOCAL_SKIN)?.owned,
      false,
      '拷文件不能把"纯本机凭据"带过去（封印对不上就不采信）',
    );
    assert.ok(
      B.warnings().some((w) => /封印/.test(w)),
      `必须明确报警，实际：${JSON.stringify(B.warnings())}`,
    );
    // 那套带码的会解锁 —— 解锁它的是签名，不是"文件被当成真的了"
    assert.equal(B.entry(SKIN)?.owned, true, '账本里夹着的那串真码，到哪都有效');
    assert.equal(B.entry(SKIN)?.grantedBy, 'signed', '来源必须是签名，不能是本地购买记录');
  } finally {
    A.done();
    B.done();
  }
});

test('伪造的码在换机场景下也过不去（改签名 / 改范围 / 过期 / 别人签的）', async () => {
  const A = machine('a');
  const B = machine('b');
  try {
    const code = sign({ sub: '买家', skins: [SKIN] });
    await buyOn(A, SKIN, code);

    const [prefix, payloadB64, sig] = code.split('.');
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    const flipped = Buffer.from(sig, 'base64url');
    flipped[0] ^= 0xff;

    const others = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const nowSec = Math.floor(Date.now() / 1000);
    const bad = {
      改签名: `${prefix}.${payloadB64}.${flipped.toString('base64url')}`,
      改范围: `${prefix}.${Buffer.from(JSON.stringify({ ...claims, skins: ['*'] })).toString('base64url')}.${sig}`,
      过期: license.encodeLicense(
        { tier: 'free', sub: '过期', iat: nowSec - 7200, exp: nowSec - 3600, skins: [SKIN] },
        issuerPrivateKey(),
      ),
      别人签的: license.encodeLicense(
        { tier: 'free', sub: '别人', iat: nowSec, exp: nowSec + 86400, skins: [SKIN] },
        others,
      ),
    };

    for (const [name, key] of Object.entries(bad)) {
      assert.equal(license.verifyLicense(key).ok, false, `${name} 的码居然验过了`);
      license.writeLicenseKey(B.root, key);
      assert.equal(B.entry(SKIN)?.owned, false, `${name} 的码居然在 B 上解锁了`);
    }

    // 真码没被这几次折腾搞坏
    license.writeLicenseKey(B.root, code);
    assert.equal(B.entry(SKIN)?.owned, true, '真码仍然有效');
  } finally {
    A.done();
    B.done();
  }
});

test('订单详情能取回整串码（换设备时唯一的凭据，不能让用户去翻邮件）', async () => {
  const A = machine('a');
  try {
    const code = sign({ sub: '买家', skins: [SKIN] });
    const { orderId } = await buyOn(A, SKIN, code);

    const list = text(await A.run({ action: 'orders' }));
    assert.match(list, /可换机/, '列表要给带码的订单打标，否则用户不知道哪笔能换机');
    assert.match(list, /orderId/, '要告诉用户怎么看到整串码');

    const detail = text(await A.run({ action: 'orders', orderId }));
    assert.ok(detail.includes(code), '详情里必须是完整可复制的授权码');
    assert.match(detail, /deck_license activate/, '要给出换机后怎么用');
    assert.match(detail, /自己留一份/, '要提醒用户码才是跟着人走的东西');
  } finally {
    A.done();
  }
});

test('没签码的订单：详情直说只在这台机器有效，不装作能换机', async () => {
  const A = machine('a');
  try {
    const { orderId } = await buyOn(A, LOCAL_SKIN);
    const detail = String((await A.run({ action: 'orders', orderId }))?.text ?? '');
    assert.match(detail, /只在这台机器有效/, '必须如实说边界');
    assert.doesNotMatch(detail, /ADSK1\./, '没有码就不能凭空显示一串码');
    assert.match(detail, /docs\/PAY\.md/, '要指给用户卖家怎么签码');
  } finally {
    A.done();
  }
});
