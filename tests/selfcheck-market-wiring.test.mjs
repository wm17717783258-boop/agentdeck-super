/**
 * 插件入口 → deck_market → 真 HTTP 支付网关 → 交付/退款/发票 的集成回归。
 *
 * 这一条专门防“模块单测传了 http，入口没传”的接线 bug：
 * 真实用户在宿主里装的是 lib/index.js 的 apply()，不是直接调 createMarket()。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { createHub } from '../lib/hub.js';
import { encodeLicense } from '../lib/license.js';

function text(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((b) => (typeof b?.text === 'string' ? b.text : JSON.stringify(b)))
    .join('\n');
}

test('apply 接出的 deck_market 能真发 HTTP，交付后可退款、开票', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexi-market-wire-'));
  const old = {
    provider: process.env.AGENTDECK_PAY_PROVIDER,
    url: process.env.AGENTDECK_PAY_URL,
    refundUrl: process.env.AGENTDECK_PAY_REFUND_URL,
    token: process.env.AGENTDECK_PAY_TOKEN,
  };
  const hits = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      hits.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      if (req.url === '/refund') {
        res.end(JSON.stringify({
          ok: true,
          refunded: true,
          provider: 'test-gateway',
          ref: `TEST-REFUND-${body.refundId || 'unknown'}`,
        }));
        return;
      }
      res.end(JSON.stringify({
        ok: true,
        paid: true,
        provider: 'test-gateway',
        ref: `TEST-${body.orderId || 'unknown'}`,
      }));
    });
  });

  let hub = null;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    process.env.AGENTDECK_PAY_PROVIDER = 'stripe';
    process.env.AGENTDECK_PAY_URL = `http://127.0.0.1:${port}/pay`;
    process.env.AGENTDECK_PAY_REFUND_URL = `http://127.0.0.1:${port}/refund`;
    process.env.AGENTDECK_PAY_TOKEN = 'integration-token';

    hub = await createHub({
      workspace: root,
      boardRoot: root,
      licenseRoot: root,
      config: { automation: { enabled: false } },
      onLog: () => {},
    });

    const bought = text(await hub.call('deck_market', { action: 'buy', skinId: 'premium-aurora' }));
    assert.match(bought, /买到了/, `购买没有打到网关：${bought.slice(0, 300)}`);
    const purchaseHits = hits.filter((hit) => hit.url === '/pay');
    assert.equal(purchaseHits.length, 1, '插件入口没有真的发出支付 POST');
    assert.equal(purchaseHits[0].body.provider, 'stripe');
    assert.equal(purchaseHits[0].body.token, 'integration-token');
    assert.ok(purchaseHits[0].body.orderId && purchaseHits[0].body.amount > 0);

    const orderId = (bought.match(/ord_[0-9a-f]{8,}/i) || [''])[0];
    assert.ok(orderId, `购买结果里没有订单号：${bought.slice(0, 300)}`);

    const orders = text(await hub.call('deck_market', { action: 'orders' }));
    assert.match(orders, new RegExp(orderId), '订单没有落到本机账本');
    assert.match(orders, /已发放/, '订单没有推进到已发放');

    const themes = text(await hub.call('deck_market', { action: 'themes' }));
    assert.match(themes, /极光套装[\s\S]*状态：已拥有/, '买过的主题包必须显示已拥有');

    const skin = text(await hub.call('pet_skin', { action: 'activate', id: 'premium-aurora' }));
    assert.doesNotMatch(skin, /需要授权|没有这个皮肤|买不了/, '付款后皮肤没有解锁');

    const invoice = text(await hub.call('deck_market', {
      action: 'invoice',
      sub: 'issue',
      orderId,
      titleType: 'personal',
      titleName: '集成测试',
    }));
    assert.match(invoice, /【发票】INV-/, '已付款订单开不出票');

    const refunded = text(await hub.call('deck_market', {
      action: 'refund',
      orderId,
    }));
    assert.match(refunded, /已退款/, `退款失败：${refunded.slice(0, 300)}`);
    const refundHits = hits.filter((hit) => hit.url === '/refund');
    assert.equal(refundHits.length, 1, '退款没有真的打到退款接口');
    assert.equal(refundHits[0].body.refundId, `rfd_${orderId}`, '退款号必须稳定可重试');
    assert.ok(refundHits[0].body.paymentRef, '退款请求要带原支付流水号');
    const after = text(await hub.call('deck_market', { action: 'orders' }));
    assert.match(after, /已退款/);
    assert.match(after, /待付款 0/, '退款没有把订单状态冲正');

    const afterSkin = text(await hub.call('pet_skin', { action: 'list' }));
    assert.match(afterSkin, /当前：basic/, '退款后桌宠仍把付费皮肤当作当前外观');
    const afterRender = text(await hub.call('pet_skin', { action: 'render', id: 'premium-aurora' }));
    assert.match(afterRender, /data-placeholder="true"/, '退款后仍能渲出付费皮肤');
    assert.match(afterRender, /此皮肤需授权/, '退款后渲染没有 fail-closed');
    const afterCatalog = text(await hub.call('deck_market', { action: 'catalog' }));
    assert.doesNotMatch(afterCatalog, /极光.*已拥有/, '退款后货架仍显示付费皮肤已拥有');

    // 退款状态必须跨进程/重启仍然成立：档案和新进程都不能把 active 留在付费皮肤上。
    await hub.close();
    hub = await createHub({
      workspace: root,
      boardRoot: root,
      licenseRoot: root,
      config: { automation: { enabled: false } },
      onLog: () => {},
    });
    const restartedSkin = text(await hub.call('pet_skin', { action: 'list' }));
    assert.match(restartedSkin, /当前：basic/, '重启后付费皮肤又回来了');
  } finally {
    if (hub) await hub.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    if (old.provider === undefined) delete process.env.AGENTDECK_PAY_PROVIDER;
    else process.env.AGENTDECK_PAY_PROVIDER = old.provider;
    if (old.url === undefined) delete process.env.AGENTDECK_PAY_URL;
    else process.env.AGENTDECK_PAY_URL = old.url;
    if (old.refundUrl === undefined) delete process.env.AGENTDECK_PAY_REFUND_URL;
    else process.env.AGENTDECK_PAY_REFUND_URL = old.refundUrl;
    if (old.token === undefined) delete process.env.AGENTDECK_PAY_TOKEN;
    else process.env.AGENTDECK_PAY_TOKEN = old.token;
  }
});

test('启动后再激活授权，deck_market 立即按新授权解锁（不读启动时快照）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexi-market-license-'));
  const oldPub = process.env.AGENTDECK_LICENSE_PUBKEY;
  const oldProvider = process.env.AGENTDECK_PAY_PROVIDER;
  const oldUrl = process.env.AGENTDECK_PAY_URL;
  const oldRefund = process.env.AGENTDECK_PAY_REFUND_URL;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const key = encodeLicense({
    v: 1,
    id: 'lic_boot_snapshot',
    tier: 'studio',
    sub: '启动后激活测试',
    iat: nowSec,
    exp: nowSec + 3600,
    seats: 8,
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  let hub = null;
  try {
    process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
    delete process.env.AGENTDECK_PAY_PROVIDER;
    delete process.env.AGENTDECK_PAY_URL;
    delete process.env.AGENTDECK_PAY_REFUND_URL;
    hub = await createHub({
      workspace: root,
      boardRoot: root,
      licenseRoot: root,
      config: { automation: { enabled: false } },
      onLog: () => {},
    });

    const before = text(await hub.call('deck_market', { action: 'catalog' }));
    assert.match(before, /极光.*¥18/, '免费启动时付费皮肤应锁着');

    const activated = text(await hub.call('deck_license', { action: 'activate', key }));
    assert.match(activated, /授权已启用/);

    const after = text(await hub.call('deck_market', { action: 'catalog' }));
    assert.match(after, /极光.*已拥有/, '激活授权后市场仍用启动时的旧授权快照');
    assert.doesNotMatch(after, /极光.*¥18/, '激活授权后货架仍把付费皮肤标成待购');
  } finally {
    if (hub) await hub.close();
    rmSync(root, { recursive: true, force: true });
    if (oldPub === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = oldPub;
    if (oldProvider === undefined) delete process.env.AGENTDECK_PAY_PROVIDER;
    else process.env.AGENTDECK_PAY_PROVIDER = oldProvider;
    if (oldUrl === undefined) delete process.env.AGENTDECK_PAY_URL;
    else process.env.AGENTDECK_PAY_URL = oldUrl;
    if (oldRefund === undefined) delete process.env.AGENTDECK_PAY_REFUND_URL;
    else process.env.AGENTDECK_PAY_REFUND_URL = oldRefund;
  }
});

test('退款收回皮肤时尊重仍然有效的 studio 授权，不误切回 basic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexi-market-refund-license-'));
  const old = {
    pubKey: process.env.AGENTDECK_LICENSE_PUBKEY,
    provider: process.env.AGENTDECK_PAY_PROVIDER,
    url: process.env.AGENTDECK_PAY_URL,
    refundUrl: process.env.AGENTDECK_PAY_REFUND_URL,
    token: process.env.AGENTDECK_PAY_TOKEN,
  };
  const hits = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      hits.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      if (req.url === '/refund') {
        res.end(JSON.stringify({
          ok: true,
          refunded: true,
          provider: 'test-gateway',
          ref: `LICENSE-REFUND-${body.refundId || 'unknown'}`,
        }));
        return;
      }
      res.end(JSON.stringify({
        ok: true,
        paid: true,
        provider: 'test-gateway',
        ref: `LICENSE-PAY-${body.orderId || 'unknown'}`,
      }));
    });
  });

  let hub = null;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const key = encodeLicense({
    v: 1,
    id: 'lic_refund_overlay',
    tier: 'studio',
    sub: '退款覆盖回归',
    iat: nowSec,
    exp: nowSec + 3600,
    seats: 3,
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  try {
    process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    process.env.AGENTDECK_PAY_PROVIDER = 'stripe';
    process.env.AGENTDECK_PAY_URL = `http://127.0.0.1:${port}/pay`;
    process.env.AGENTDECK_PAY_REFUND_URL = `http://127.0.0.1:${port}/refund`;
    process.env.AGENTDECK_PAY_TOKEN = 'refund-overlay-token';

    hub = await createHub({
      workspace: root,
      boardRoot: root,
      licenseRoot: root,
      config: { automation: { enabled: false } },
      onLog: () => {},
    });

    const bought = text(await hub.call('deck_market', { action: 'buy', skinId: 'premium-aurora' }));
    assert.match(bought, /买到了/, bought.slice(0, 300));
    const orderId = (bought.match(/ord_[0-9a-f]{8,}/i) || [''])[0];
    assert.ok(orderId, '购买结果里必须有订单号');

    const activatedLicense = text(await hub.call('deck_license', { action: 'activate', key }));
    assert.match(activatedLicense, /授权已启用/);

    const activatedSkin = text(await hub.call('pet_skin', { action: 'activate', id: 'premium-aurora' }));
    assert.match(activatedSkin, /已经换上/, activatedSkin.slice(0, 300));
    const beforeRefund = text(await hub.call('pet_skin', { action: 'list' }));
    assert.match(beforeRefund, /当前：premium-aurora/);

    const refunded = text(await hub.call('deck_market', { action: 'refund', orderId }));
    assert.match(refunded, /已退款/, `退款失败：${refunded.slice(0, 300)}`);
    assert.doesNotMatch(refunded, /当前外观已切回 basic/, '仍有 studio 授权时不该切回 basic');

    const afterRefund = text(await hub.call('pet_skin', { action: 'list' }));
    assert.match(afterRefund, /当前：premium-aurora/, '有效 studio 授权覆盖退款皮肤时，当前外观必须保留');
    const render = text(await hub.call('pet_skin', { action: 'render', id: 'premium-aurora' }));
    assert.doesNotMatch(render, /data-placeholder="true"/, '被 studio 授权覆盖的皮肤不应退化成占位图');
    assert.doesNotMatch(render, /此皮肤需授权/);

    const refundHits = hits.filter((hit) => hit.url === '/refund');
    assert.equal(refundHits.length, 1, '退款只能打到网关一次');
  } finally {
    if (hub) await hub.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    if (old.pubKey === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = old.pubKey;
    if (old.provider === undefined) delete process.env.AGENTDECK_PAY_PROVIDER;
    else process.env.AGENTDECK_PAY_PROVIDER = old.provider;
    if (old.url === undefined) delete process.env.AGENTDECK_PAY_URL;
    else process.env.AGENTDECK_PAY_URL = old.url;
    if (old.refundUrl === undefined) delete process.env.AGENTDECK_PAY_REFUND_URL;
    else process.env.AGENTDECK_PAY_REFUND_URL = old.refundUrl;
    if (old.token === undefined) delete process.env.AGENTDECK_PAY_TOKEN;
    else process.env.AGENTDECK_PAY_TOKEN = old.token;
  }
});
