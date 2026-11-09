/**
 * 市场凭据的「不可伪造」测试 —— 1.11.9 把付费皮肤从「自愿付费」拉回来这一层。
 *
 * 三件事必须同时成立，缺一条这个市场就是摆设：
 *   1. 买了能用（否则买家骂人）；
 *   2. 手改文件不能白拿（否则卖家白干）；
 *   3. 退款后真的收回（否则「买完就退」成了免费下载）。
 *
 * 断言都对着**产品行为**（货架上的 owned / grantedBy / warnings），
 * 不对着内部字段 —— 内部结构以后可以变，"能不能用"不行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { createMarket } from '../lib/market/index.js';
import { encodeLicense } from '../lib/license.js';
import { writeLicenseKey } from '../lib/license.js';
import { createMarketStore } from '../lib/market/store.js';

const SKIN = 'premium-aurora';
const PRICE_CENTS = 1800;

/** 人工渠道：确认时直接认定到账（和 deck_market 的 confirm 走同一条路） */
const manualCharge = async ({ order } = {}) => ({
  ok: true,
  paid: true,
  provider: 'manual',
  ref: `MANUAL-TEST@${order && order.id}`,
});

function shop() {
  const root = mkdtempSync(join(tmpdir(), 'adsk-integrity-'));
  const market = createMarket({ root, billing: null });
  return {
    root,
    market,
    store: market.store,
    paths: market.paths,
    entry: () => market.catalog().skins.find((s) => s.id === SKIN),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 只读一次货架，顺带把 warnings 拿出来 */
function shelf(market) {
  const catalog = market.catalog();
  const entry = catalog.skins.find((s) => s.id === SKIN);
  return { catalog, entry, warnings: catalog.warnings || [] };
}

/** 卖家侧签发一张只含这套皮肤的授权（私钥不在仓库里，读本机 issuer 目录） */
function issueSkinKey({ skins = [SKIN], days = 365 } = {}) {
  const pem = join(homedir(), '.agentdeck-issuer', 'issuer-private.pem');
  const priv = readFileSync(pem, 'utf8');
  const nowSec = Math.floor(Date.now() / 1000);
  return encodeLicense({ tier: 'free', sub: 'integrity-test', iat: nowSec, exp: nowSec + days * 86400, skins }, priv);
}

// ---------------------------------------------------------------------------
// 一、封印：改文件不再等于买过
// ---------------------------------------------------------------------------

test('买完之后：解锁、来源是「本机购买」、账本带封印', async () => {
  const s = shop();
  try {
    assert.equal(s.entry().owned, false, '没买之前必须是锁着的');

    const placed = s.market.placeOrder({ skinId: SKIN });
    assert.equal(placed.ok, true, placed.reason);
    assert.equal(placed.amount, PRICE_CENTS);
    const conf = await s.market.confirm({ orderId: placed.order.id, billing: manualCharge });
    assert.equal(conf.ok, true, conf.reason);

    const after = s.entry();
    assert.equal(after.owned, true, '付了钱必须能用');
    assert.equal(after.grantedBy, 'local', '来源应标成「本机购买凭据」');

    const raw = JSON.parse(readFileSync(s.paths.ledgerFile, 'utf8'));
    assert.match(String(raw.seal), /^hmac-sha256:[0-9a-f]{64}$/, '账本必须带 HMAC 封印');
    assert.equal(raw.purchases[0].amount, PRICE_CENTS, '购买行要记金额，交叉核对靠它');
  } finally {
    s.done();
  }
});

test('手改账本塞一条购买：不再解锁，而且明说原因', async () => {
  const s = shop();
  try {
    const placed = s.market.placeOrder({ skinId: SKIN });
    await s.market.confirm({ orderId: placed.order.id, billing: manualCharge });

    // 攻击者视角：往 purchases 里加一条（这正是修复前能解锁的那一招）
    const raw = JSON.parse(readFileSync(s.paths.ledgerFile, 'utf8'));
    raw.purchases.push({
      skinId: SKIN,
      orderId: 'ord_00000000',
      at: new Date().toISOString(),
      amount: PRICE_CENTS,
      code: 'SKIN-FORGED',
      refundedAt: null,
    });
    writeFileSync(s.paths.ledgerFile, JSON.stringify(raw, null, 2), 'utf8');

    const { entry, warnings } = shelf(s.market);
    assert.equal(entry.owned, false, '封印对不上时，整份账本里的本地购买凭据都不该采信');
    assert.ok(
      warnings.some((w) => /封印|改过|不采信/.test(w)),
      `必须明确报警，实际 warnings：${JSON.stringify(warnings)}`,
    );
  } finally {
    s.done();
  }
});

test('全新设备上直接伪造一份账本：交叉核对会拦住（没有已发放订单）', () => {
  const s = shop();
  try {
    s.market.catalog(); // 先让目录/密钥初始化
    const fake = {
      v: 1,
      updatedAt: new Date().toISOString(),
      purchases: [{
        skinId: SKIN,
        orderId: 'ord_00000000',
        at: new Date().toISOString(),
        amount: PRICE_CENTS,
        code: 'SKIN-FORGED',
        refundedAt: null,
      }],
      entries: [],
    };
    writeFileSync(s.paths.ledgerFile, JSON.stringify(fake, null, 2), 'utf8');

    const { entry, warnings } = shelf(s.market);
    assert.equal(entry.owned, false, '没有对应已发放订单的购买记录不能算数');
    assert.ok(
      warnings.some((w) => /找不到对应的已发放订单|未计入/.test(w)),
      `要说清为什么不算，实际：${JSON.stringify(warnings)}`,
    );
  } finally {
    s.done();
  }
});

test('老账本（盖章之前写的）仍然能用：不能因为升级把人买过的东西弄丢', async () => {
  const s = shop();
  try {
    // 先用正常流程买一次，拿到一份正确的 orders.json（带封印）与真实购买行
    const placed = s.market.placeOrder({ skinId: SKIN });
    await s.market.confirm({ orderId: placed.order.id, billing: manualCharge });
    const ledger = JSON.parse(readFileSync(s.paths.ledgerFile, 'utf8'));

    // 模拟「1.11.9 之前的账本」：内容正确，但整份文件没有 seal 字段
    const old = { ...ledger };
    delete old.seal;
    writeFileSync(s.paths.ledgerFile, JSON.stringify(old, null, 2), 'utf8');

    const { entry } = shelf(s.market);
    assert.equal(entry.owned, true, '老账本没有封印但订单对得上，必须继续认');
  } finally {
    s.done();
  }
});

test('封印是幂等的：连续写十次不会把自己写成「被篡改」', async () => {
  const s = shop();
  try {
    const store = createMarketStore({ root: s.root });
    for (let i = 0; i < 10; i += 1) {
      const wrote = store.updateLedger((doc) => {
        doc.updatedAt = new Date().toISOString();
        return doc;
      });
      assert.equal(wrote.ok, true, wrote.reason);
    }
    const read = store.readLedger();
    assert.notEqual(read.integrity.status, 'tampered', '自己写的账本不该被判成篡改');
    assert.equal(read.integrity.status, 'ok', `连续写之后封印应该仍然匹配，实际 ${read.integrity.status}`);
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------------------
// 二、签名授权：这一条伪造不了
// ---------------------------------------------------------------------------

test('换一台干净设备，只贴授权码就能解锁（不依赖任何订单）', async () => {
  const s = shop();
  try {
    assert.equal(s.entry().owned, false, '贴码之前必须锁着');
    const key = issueSkinKey();
    const put = writeLicenseKey(s.root, key);
    assert.equal(put && put.ok !== false, true, '写授权文件失败');

    const { entry } = shelf(s.market);
    assert.equal(entry.owned, true, '有效授权码应该直接解锁');
    assert.equal(entry.grantedBy, 'signed', '来源要标成签名授权，不能含糊成「档位自带」');
  } finally {
    s.done();
  }
});

test('伪造的授权码：改签名 / 改 payload 都过不去，货架保持锁着', () => {
  const s = shop();
  try {
    const good = issueSkinKey();
    const [prefix, payload, sig] = good.split('.');
    const sigBuf = Buffer.from(sig, 'base64url');
    sigBuf[0] ^= 0xff;
    const badSig = `${prefix}.${payload}.${sigBuf.toString('base64url')}`;

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.skins = ['*'];
    const badPayload = `${prefix}.${Buffer.from(JSON.stringify(claims), 'base64url').toString('base64url')}.${sig}`;

    for (const [name, key] of [['改签名', badSig], ['改 payload', badPayload]]) {
      writeLicenseKey(s.root, key);
      const { entry } = shelf(s.market);
      assert.equal(entry.owned, false, `${name} 的码居然解锁了`);
    }
  } finally {
    s.done();
  }
});

test('卖家确认到账时附上授权码：订单与账本都留档，货架标成签名授权', async () => {
  const s = shop();
  try {
    const key = issueSkinKey();
    const placed = s.market.placeOrder({ skinId: SKIN });
    const conf = await s.market.confirm({ orderId: placed.order.id, billing: manualCharge, licenseKey: key });
    assert.equal(conf.ok, true, conf.reason);
    assert.equal(conf.order.delivery.licenseKey, key, '订单里要存下签名授权');

    const ledger = JSON.parse(readFileSync(s.paths.ledgerFile, 'utf8'));
    const row = ledger.purchases.find((p) => p.orderId === placed.order.id);
    assert.equal(row.licenseKey, key, '账本里也要存一份（备份账本就能带走授权）');

    const { entry } = shelf(s.market);
    assert.equal(entry.owned, true);
    assert.equal(entry.grantedBy, 'signed', '有签名授权时应优先标成 signed');
  } finally {
    s.done();
  }
});

test('授权码写错不阻塞到账：钱真付了就给货，只是不把它当签名凭据', async () => {
  const s = shop();
  try {
    const placed = s.market.placeOrder({ skinId: SKIN });
    const conf = await s.market.confirm({
      orderId: placed.order.id,
      billing: manualCharge,
      licenseKey: 'ADSK1.bm90LWEtcmVhbC1wYXlsb2Fk.bm90LWEtcmVhbC1zaWc',
    });
    assert.equal(conf.ok, true, `坏码不该让确认失败：${conf.reason}`);

    const lic = s.market.license();
    assert.deepEqual(lic.signed, [], '坏码不能混进 signedSkins');
    assert.equal(s.entry().owned, true, '本机购买凭据仍然有效（钱是真的付了）');
    assert.equal(s.entry().grantedBy, 'local');
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------------------
// 三、退款要真的收回
// ---------------------------------------------------------------------------

test('退款之后：本机凭据和签名凭据一起失效（不能退钱还留皮肤）', async () => {
  const s = shop();
  try {
    const key = issueSkinKey();
    const placed = s.market.placeOrder({ skinId: SKIN });
    await s.market.confirm({ orderId: placed.order.id, billing: manualCharge, licenseKey: key });
    assert.equal(s.entry().owned, true, '先确认买完是能用的');

    const refundBilling = {
      id: 'manual',
      refund: async ({ order, refundId } = {}) => ({
        ok: true,
        refunded: true,
        provider: 'manual',
        refundId,
        ref: `MANUAL-REFUND@${order && order.id}`,
      }),
    };
    const refunded = await s.market.refund({ orderId: placed.order.id, billing: refundBilling, reason: '测试退款' });
    assert.equal(refunded.ok, true, refunded.reason);

    const { entry, catalog } = shelf(s.market);
    assert.equal(entry.owned, false, '退了款还能用，等于免费拿皮肤');
    assert.deepEqual(catalog.signed, [], '退款后签名凭据必须一并作废');
    assert.deepEqual(catalog.purchased, [], '退款后本机凭据必须收回');
  } finally {
    s.done();
  }
});
