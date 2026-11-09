/**
 * 跨设备同步（加密 Sync）—— 蓝图的付费触发点之一，之前**完全没做**。
 *
 * 蓝图点名三次：
 *   · 07 模块「跨设备、云长期记忆」= 付费触发点
 *   · 能力表 Payment Hook「跨设备同步与云长期记忆」
 *   · 架构图「Encrypted Sync：跨设备 · 备份 · 恢复」
 *
 * 这一套验四件事：
 *   ① 真的加密（密文里搜不到明文）
 *   ② 对口令才解（错口令、被改过都解不开）
 *   ③ 换台设备真能用（A 机的东西 → B 机读得到）
 *   ④ 是**合并**不是覆盖（B 机原有的东西不许被冲掉）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  MAX_PAYLOAD_BYTES,
  SYNC_MAGIC,
  SYNC_VERSION,
  applySnapshot,
  collectSnapshot,
  deriveKey,
  deviceId,
  packSync,
  unpackSync,
} from '../lib/sync/index.js';
import { createProfileStore } from '../lib/pet/profile.js';
import { activateSkin } from '../lib/pet/skins.js';
import { apply } from '../lib/index.js';

function fresh(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-sync-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** 起真插件实例，拿工具调用入口（写入走真实路径，便于验证"另一台设备读得到"）。 */
async function boot(root) {
  const tools = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: () => null, emit() {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject() {},
    tools: { register(def) { tools.push(def); return () => {}; } },
  };
  await apply(ctx, { workspace: root, boardRoot: root, licenseRoot: root, agents: [] });
  return async (name, args) => {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `工具 ${name} 没注册`);
    const out = await t.execute(args, {});
    return typeof out === 'string' ? out : String(out?.text ?? '');
  };
}

/* ── 1. 口令与密钥 ─────────────────────────────────────────────────────── */

test('口令派生密钥：同一口令 + 同一盐得同一把；不同盐得不同', () => {
  const saltA = Buffer.alloc(16, 1);
  const saltB = Buffer.alloc(16, 2);
  const k1 = deriveKey('我的口令123', saltA);
  const k2 = deriveKey('我的口令123', saltA);
  assert.equal(k1.length, 32);
  assert.ok(k1.equals(k2), '同口令同盐必须得同一把');
  assert.ok(!k1.equals(deriveKey('我的口令123', saltB)), '不同盐该得不同密钥');
  assert.ok(!k1.equals(deriveKey('别的口令123', saltA)), '不同口令该得不同密钥');
  // 太短的口令直接拒（不许"123"这种等于没加密）
  assert.equal(deriveKey('123', saltA), null);
  assert.equal(deriveKey('', saltA), null);
  assert.equal(deriveKey(null, saltA), null);
});

/* ── 2. 打包 = 真加密 ──────────────────────────────────────────────────── */

test('打包：密文里搜不到明文；格式带魔数；条数如实', () => {
  const a = fresh('pack');
  try {
    const store = createProfileStore({ root: a.root });
    activateSkin(store, 'ink', null);
    // 写一条记忆
    const memFile = join(a.root, '.agentdeck', 'twin', 'memory.json');
    mkdirSync(dirname(memFile), { recursive: true });
    writeFileSync(memFile, JSON.stringify({ version: 1, items: [{ id: 'mem_1', type: 'preference', text: '这句是机密内容', visibility: 'private', at: 1, updatedAt: 1, hits: 0 }] }), 'utf8');

    const packed = packSync({ root: a.root, passphrase: '我的口令123' });
    assert.equal(packed.ok, true, packed.reason || '');
    assert.ok(packed.blob.startsWith(`${SYNC_MAGIC}.`), '缺魔数前缀');
    assert.equal(packed.counts.memory, 1);
    // 关键：明文一丝不能出现
    assert.ok(!packed.blob.includes('这句是机密内容'), '密文里出现了明文记忆');
    assert.ok(!packed.blob.includes('我的口令123'), '密文里出现了口令');
    // 就算解码外层（它是 base64 的 JSON），里面也只有密文
    const envelope = JSON.parse(Buffer.from(packed.blob.slice(SYNC_MAGIC.length + 1), 'base64url').toString('utf8'));
    assert.equal(envelope.magic, SYNC_MAGIC);
    assert.equal(envelope.enc.alg, 'aes-256-gcm');
    assert.ok(!JSON.stringify(envelope).includes('这句是机密内容'), '外层信封里泄漏了明文');
  } finally {
    a.done();
  }
});

test('口令太短 / 没有工作区：明确拒绝，不生成半成品', () => {
  const a = fresh('short');
  try {
    const short = packSync({ root: a.root, passphrase: '12345' });
    assert.equal(short.ok, false);
    assert.match(short.reason, /口令太短/);
    assert.equal(short.blob, undefined, '拒绝了还给了内容');

    const noRoot = packSync({ passphrase: '我的口令123' });
    assert.equal(noRoot.ok, false);
    assert.match(noRoot.reason, /工作区/);
  } finally {
    a.done();
  }
});

/* ── 3. 解包：错口令/被改过都解不开 ────────────────────────────────────── */

test('解包：对口令解得开；错口令、改一个字符、版本不对都解不开', () => {
  const a = fresh('unpack');
  try {
    const packed = packSync({ root: a.root, passphrase: '我的口令123' });
    assert.equal(packed.ok, true);

    const ok = unpackSync({ blob: packed.blob, passphrase: '我的口令123' });
    assert.equal(ok.ok, true, ok.reason || '');
    assert.equal(ok.snapshot.v, SYNC_VERSION);

    const wrong = unpackSync({ blob: packed.blob, passphrase: '别的口令123' });
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason, /解不开/);

    // 改密文尾部的字符（仍在 base64url 字母表内）
    const body = packed.blob.slice(SYNC_MAGIC.length + 1);
    const flipped = body.slice(0, -4) + (body.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const tampered = unpackSync({ blob: `${SYNC_MAGIC}.${flipped}`, passphrase: '我的口令123' });
    // 可能解析失败、也可能 GCM 校验失败，但**绝不能成功**
    assert.equal(tampered.ok, false, '改过的内容居然解开了');

    // 不是这个格式
    assert.equal(unpackSync({ blob: '随便一段文字', passphrase: '我的口令123' }).ok, false);
    assert.equal(unpackSync({ blob: '', passphrase: 'x' }).ok, false);
    assert.equal(unpackSync({ blob: `${SYNC_MAGIC}.不是base64`, passphrase: '我的口令123' }).ok, false);
  } finally {
    a.done();
  }
});

/* ── 4. 跨设备：A 机的东西 B 机真能用 ─────────────────────────────────── */

test('跨设备：A 的记忆与皮肤 → 加密传到 B → B 真读得到', async () => {
  const a = fresh('devA');
  const b = fresh('devB');
  try {
    // A 机：写记忆 + 换皮肤
    const callA = await boot(a.root);
    const marker = `跨设备标记${Math.random().toString(36).slice(2, 6)}`;
    await callA('twin_remember', { text: marker, type: 'preference' });
    const storeA = createProfileStore({ root: a.root });
    activateSkin(storeA, 'ink', null);

    // 打包
    const packed = packSync({ root: a.root, passphrase: '我的口令123' });
    assert.equal(packed.ok, true);
    assert.equal(packed.counts.memory >= 1, true);

    // B 机：解开 + 合并
    const opened = unpackSync({ blob: packed.blob, passphrase: '我的口令123' });
    assert.equal(opened.ok, true, opened.reason || '');
    const applied = applySnapshot({ root: b.root, snapshot: opened.snapshot });
    assert.equal(applied.ok, true, applied.reason || '');
    assert.equal(applied.applied.pet, true, '皮肤没同步过来');

    // B 机真读得到
    const callB = await boot(b.root);
    const recalled = await callB('twin_recall', { query: marker, any: true, limit: 5 });
    assert.match(recalled, new RegExp(marker), 'B 机召不回 A 机同步过来的记忆');

    const profileB = JSON.parse(readFileSync(join(b.root, '.agentdeck', 'pet', 'profile.json'), 'utf8'));
    assert.equal(profileB.skins.active, 'ink', 'B 机的皮肤没切成同步过来的那套');
    assert.ok(profileB.skins.owned.includes('ink'), 'owned 里该有这套皮肤');
  } finally {
    a.done();
    b.done();
  }
});

/* ── 5. 是合并不是覆盖 ─────────────────────────────────────────────────── */

test('合并语义：B 机原有的记忆不许被冲掉，两边的都在', async () => {
  const a = fresh('mA');
  const b = fresh('mB');
  try {
    const callA = await boot(a.root);
    const callB = await boot(b.root);
    const fromA = `A机的记忆${Math.random().toString(36).slice(2, 6)}`;
    const fromB = `B机原生的记忆${Math.random().toString(36).slice(2, 6)}`;
    await callA('twin_remember', { text: fromA });
    await callB('twin_remember', { text: fromB });

    const packed = packSync({ root: a.root, passphrase: '我的口令123' });
    const opened = unpackSync({ blob: packed.blob, passphrase: '我的口令123' });
    applySnapshot({ root: b.root, snapshot: opened.snapshot });

    const recalled = await callB('twin_recall', { any: true, limit: 20 });
    assert.match(recalled, new RegExp(fromA), 'A 的没合并进来');
    assert.match(recalled, new RegExp(fromB), 'B 原有的被冲掉了——这不该发生');
  } finally {
    a.done();
    b.done();
  }
});

test('重复合并同一份：幂等（记忆不会变成两条）', async () => {
  const a = fresh('iA');
  const b = fresh('iB');
  try {
    const callA = await boot(a.root);
    const marker = `幂等标记${Math.random().toString(36).slice(2, 6)}`;
    await callA('twin_remember', { text: marker });

    const packed = packSync({ root: a.root, passphrase: '我的口令123' });
    const opened = unpackSync({ blob: packed.blob, passphrase: '我的口令123' });
    const first = applySnapshot({ root: b.root, snapshot: opened.snapshot });
    const n1 = first.applied.memory;
    const second = applySnapshot({ root: b.root, snapshot: opened.snapshot });
    assert.equal(second.applied.memory, n1, `第二次合并把记忆变多了：${n1} → ${second.applied.memory}`);
  } finally {
    a.done();
    b.done();
  }
});

/* ── 6. 快照内容边界 ───────────────────────────────────────────────────── */

test('快照只带"你的东西"：不含授权码、不含身份私钥', () => {
  const a = fresh('scope');
  try {
    // 放一份授权码和一份身份私钥进工作区
    const licDir = join(a.root, '.agentdeck', 'license');
    mkdirSync(licDir, { recursive: true });
    writeFileSync(join(licDir, 'key.txt'), 'ADSK1.这是授权码不该被同步', 'utf8');
    const idDir = join(a.root, '.agentdeck', 'identity');
    mkdirSync(idDir, { recursive: true });
    writeFileSync(join(idDir, 'key.pem'), '这是私钥不该被同步', 'utf8');

    const got = collectSnapshot({ root: a.root });
    assert.equal(got.ok, true);
    const asText = JSON.stringify(got.snapshot);
    assert.ok(!asText.includes('ADSK1.'), '快照里带了授权码');
    assert.ok(!asText.includes('这是私钥不该被同步'), '快照里带了身份私钥');
    // 该带的字段在
    for (const k of ['memory', 'habits', 'automation', 'policy', 'pet']) {
      assert.ok(k in got.snapshot, `快照缺字段 ${k}`);
    }
  } finally {
    a.done();
  }
});

test('applySnapshot 对垃圾快照一律拒绝，不写坏本机', () => {
  const b = fresh('bad');
  try {
    for (const bad of [null, undefined, 'string', 42, {}, { v: 99 }]) {
      const r = applySnapshot({ root: b.root, snapshot: bad });
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 该被拒`);
    }
    // 版本不对也要拒
    assert.equal(applySnapshot({ root: b.root, snapshot: { v: 999 } }).ok, false);
  } finally {
    b.done();
  }
});

/* ── 7. 设备指纹 ───────────────────────────────────────────────────────── */

test('设备指纹：同一工作区稳定，不同工作区不同', () => {
  const a = fresh('d1');
  const b = fresh('d2');
  try {
    const id1 = deviceId({ root: a.root });
    const id2 = deviceId({ root: a.root });
    assert.equal(id1, id2, '同一设备该稳定');
    assert.match(id1, /^dev_[0-9a-f]+$/);
    assert.notEqual(deviceId({ root: b.root }), id1, '不同设备该不同');
    assert.ok(existsSync(join(a.root, '.agentdeck', 'device-id.txt')), '该落盘');
  } finally {
    a.done();
    b.done();
  }
});

/* ── 8. 工具层 ─────────────────────────────────────────────────────────── */

test('deck_sync 工具：info / pack / apply 三个动作都真能用', async () => {
  const a = fresh('tA');
  const b = fresh('tB');
  try {
    const callA = await boot(a.root);
    const marker = `工具层标记${Math.random().toString(36).slice(2, 6)}`;
    await callA('twin_remember', { text: marker });

    const info = await callA('deck_sync', { action: 'info' });
    assert.match(info, /会被带走/);
    assert.match(info, /设备指纹/);
    assert.match(info, /不带走的/);

    const short = await callA('deck_sync', { action: 'pack', passphrase: '123' });
    assert.match(short, /至少 6 位/);

    const packed = await callA('deck_sync', { action: 'pack', passphrase: '我的口令123' });
    assert.match(packed, /已打包/);
    const blob = (packed.match(/NEXISYNC1\.[A-Za-z0-9_-]+/) || [])[0];
    assert.ok(blob, `pack 没给出加密串：${packed.slice(0, 150)}`);
    assert.ok(!packed.includes(marker), '工具输出里出现了明文记忆');

    const callB = await boot(b.root);
    const wrong = await callB('deck_sync', { action: 'apply', blob, passphrase: '错口令999' });
    assert.match(wrong, /解不开/);

    const applied = await callB('deck_sync', { action: 'apply', blob, passphrase: '我的口令123' });
    assert.match(applied, /已合并/);
    assert.match(applied, /不是覆盖/);

    const recalled = await callB('twin_recall', { query: marker, any: true, limit: 5 });
    assert.match(recalled, new RegExp(marker), '工具层同步后 B 读不到');

    // 不认识的子动作
    const bogus = await callA('deck_sync', { action: 'no-such' });
    assert.match(bogus, /不认识的动作/);
  } finally {
    a.done();
    b.done();
  }
});
