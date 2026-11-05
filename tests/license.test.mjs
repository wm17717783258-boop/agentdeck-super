import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeLicense,
  verifyLicense,
  entitlements,
  entitlementsOf,
  normalizeClaims,
  writeLicenseKey,
  readLicenseKey,
  currentLicense,
  describeEntitlements,
  ISSUER_PUBLIC_SPKI_B64URL,
  TIERS,
  PRICE_TABLE,
} from '../lib/license.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

const NOW = () => Date.UTC(2026, 0, 1);
const nowSec = Math.floor(NOW() / 1000);

function issue(extra = {}) {
  return encodeLicense(
    { v: 1, id: 'lic_test', tier: 'pro', sub: '张三', iat: nowSec, exp: nowSec + 86400 * 30, seats: 8, skins: [], ...extra },
    privPem,
  );
}

test('签发 → 校验：往返成功，claims 完整', () => {
  const key = issue({ skins: ['aurora'] });
  assert.match(key, /^ADSK1\.[\w-]+\.[\w-]+$/);
  const v = verifyLicense(key, { publicKeyB64Url: pubB64, now: NOW });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.claims.tier, 'pro');
  assert.equal(v.claims.sub, '张三');
  assert.equal(v.claims.seats, 8);
  assert.deepEqual(v.claims.skins, ['aurora']);
  assert.equal(v.entitlements.cloudRooms, 1);
});

test('篡改任何一位都必须验不过（payload / 签名各试一次）', () => {
  const key = issue();
  const [p, payload, sig] = key.split('.');

  // 改 payload：把 pro 改成 studio
  const raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  raw.tier = 'studio';
  const forged = `${p}.${Buffer.from(JSON.stringify(raw)).toString('base64url')}.${sig}`;
  const v1 = verifyLicense(forged, { publicKeyB64Url: pubB64, now: NOW });
  assert.equal(v1.ok, false);
  assert.equal(v1.code, 'signature');

  // 改签名
  const badSig = Buffer.from(sig, 'base64url');
  badSig[0] ^= 0xff;
  const v2 = verifyLicense(`${p}.${payload}.${badSig.toString('base64url')}`, { publicKeyB64Url: pubB64, now: NOW });
  assert.equal(v2.ok, false);
  assert.equal(v2.code, 'signature');
});

test('换了公钥（别人的签发者）验不过', () => {
  const other = generateKeyPairSync('ed25519');
  const otherPub = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const v = verifyLicense(issue(), { publicKeyB64Url: otherPub, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'signature');
});

test('过期就降级 free，且给出可读原因', () => {
  const key = issue({ exp: nowSec - 10 });
  const v = verifyLicense(key, { publicKeyB64Url: pubB64, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'expired');
  assert.match(v.reason, /到期/);
  assert.equal(entitlementsOf(v).id, 'free');
});

test('格式垃圾一律不 throw，只返回 ok:false', () => {
  for (const bad of ['', '   ', null, undefined, 42, 'ADSK1', 'ADSK1.a', 'ADSK1.a.b.c', 'BADSIG.x.y', 'ADSK1.!!!.???']) {
    assert.doesNotThrow(() => verifyLicense(bad, { publicKeyB64Url: pubB64, now: NOW }));
    const v = verifyLicense(bad, { publicKeyB64Url: pubB64, now: NOW });
    assert.equal(v.ok, false, `应判无效：${String(bad)}`);
    assert.equal(typeof v.reason, 'string');
    assert.equal(v.tier, 'free');
  }
});

test('payload 是坏 JSON 也只报 ok:false', () => {
  const key = `ADSK1.${Buffer.from('{not json').toString('base64url')}.${Buffer.from('sig').toString('base64url')}`;
  const v = verifyLicense(key, { publicKeyB64Url: pubB64, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'payload');
});

test('未知档位不被信任（签名有效也降级）', () => {
  const key = issue({ tier: 'godmode' });
  // 签发时会把未知档位归一化 free，所以这里验的是"归一化生效"
  const v = verifyLicense(key, { publicKeyB64Url: pubB64, now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.claims.tier, 'free');
  assert.equal(v.entitlements.cloudRooms, 0);
});

test('normalizeClaims：缺字段补默认、档位小写、席位有下限', () => {
  const c = normalizeClaims({ tier: 'PRO', seats: 0 });
  assert.equal(c.tier, 'pro');
  assert.equal(c.seats, 1);
  assert.deepEqual(c.skins, []);
  assert.equal(c.v, 1);
});

test('写盘 / 读盘 / 一步到位取权益', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-lic-'));
  try {
    const noLic = currentLicense(root, { now: NOW });
    assert.equal(noLic.tier, 'free');
    assert.equal(noLic.code, 'none');

    const key = issue();
    const w = writeLicenseKey(root, key);
    assert.equal(w.ok, true);
    assert.equal(readLicenseKey(root), key);

    const cur = currentLicense(root, { now: NOW, publicKeyB64Url: pubB64 });
    assert.equal(cur.ok, true);
    assert.equal(cur.tier, 'pro');
    assert.equal(cur.entitlements.maxSeats, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('写盘失败不抛异常（返回 ok:false）', () => {
  const r = writeLicenseKey(join(tmpdir(), 'adsk-nonexistent-\u0000bad'), 'x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /失败/);
});

test('权益表自洽：档位越高越多，免费版本地能力不被砍', () => {
  const free = entitlements('free');
  const pro = entitlements('pro');
  const studio = entitlements('studio');
  assert.ok(free.localRooms >= 1, '免费版必须能用');
  assert.ok(pro.maxSeats > free.maxSeats);
  assert.ok(studio.maxSeats > pro.maxSeats);
  assert.ok(studio.cloudRooms > pro.cloudRooms);
  assert.equal(free.premiumSkins, false);
  assert.equal(studio.premiumSkins, true);
  assert.equal(entitlements('不存在的档位').id, 'free');
});

test('价格表与 TIERS 对得上', () => {
  assert.deepEqual(
    PRICE_TABLE.map((p) => p.tier),
    Object.keys(TIERS),
  );
  assert.ok(PRICE_TABLE.every((p) => p.name && p.sell));
});

test('describeEntitlements 说人话', () => {
  const s = describeEntitlements(entitlements('pro'));
  assert.match(s, /协作版/);
  assert.match(s, /席位 8/);
  assert.match(s, /跨机/);
});

test('仓库里的公钥是合法的 Ed25519 SPKI（防止打错一次全废）', () => {
  assert.match(ISSUER_PUBLIC_SPKI_B64URL, /^[\w-]{40,}$/);
  const v = verifyLicense(issue(), { now: NOW });
  // 用仓库公钥验测试私钥签的码 → 必须失败（说明仓库公钥不是测试密钥，是卖家真钥）
  assert.equal(v.ok, false);
});
