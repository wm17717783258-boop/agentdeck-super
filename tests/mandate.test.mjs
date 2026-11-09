/**
 * tests/mandate.test.mjs —— 分身执照：签发 / 验签 / 篡改 / 过期 / 自主裁决 / 落盘
 *
 * 原则和仓库其它测试一致：每个用例一个临时 root（mkdtempSync）、注入固定时钟、零网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANDATE_PREFIX,
  defaultMandate,
  normalizeMandate,
  encodeMandate,
  verifyMandate,
  judgeAutonomy,
  insideWindows,
  localMinuteOf,
  readActiveMandate,
  issueMandate,
  revokeMandate,
  mandateSummary,
  mandatePaths,
} from '../lib/twin/mandate.js';
import { ensureIdentity } from '../lib/identity.js';

/** 每个用例一个干净 root。 */
function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'adsk-mandate-'));
}

/** 固定时钟：2026-11-07 14:30 Asia/Shanghai（= 06:30 UTC） */
const FIXED_MS = Date.parse('2026-11-07T06:30:00.000Z');

test('默认执照是最小权限：只读 + 任务板，不含 shell / fs_write', () => {
  const m = defaultMandate();
  assert.deepEqual(m.scope.tools, ['fs_read', 'fs_glob', 'fs_grep', 'web_fetch']);
  assert.ok(m.scope.deny.includes('shell'));
  assert.ok(m.scope.deny.includes('fs_write'));
  assert.ok(!m.scope.tools.includes('shell'));
});

test('normalizeMandate 钉死形状：非法窗口丢掉、未知字段不进来', () => {
  const m = normalizeMandate({
    windows: ['09:00-22:00', '乱写', '25:00-99:99'],
    ttlDays: 7,
    extraJunk: 'should not survive',
  });
  assert.deepEqual(m.time.windows, ['09:00-22:00']);
  assert.equal(m.v, 1);
  assert.ok(!('extraJunk' in m));
  assert.ok(m.exp > m.iat);
});

test('normalizeMandate 保留跨夜窗口', () => {
  const m = normalizeMandate({ time: { windows: ['22:00-06:00'] } });
  assert.deepEqual(m.time.windows, ['22:00-06:00']);
});

test('签发 → 验签通过，公钥随执照走（不需要共享密钥目录）', () => {
  const root = tmpRoot();
  try {
    const issued = issueMandate(root, { ttlDays: 30 });
    assert.equal(issued.ok, true, issued.reason);
    assert.ok(issued.mandate.startsWith(`${MANDATE_PREFIX}.`));

    // 用另一个完全独立的 root（模拟对面机器）验签：只带执照串，不共享任何东西
    const other = tmpRoot();
    try {
      const v = verifyMandate(issued.mandate, { now: FIXED_MS });
      assert.equal(v.ok, true, v.reason);
      assert.equal(v.claims.id, issued.claims.id);
      assert.equal(v.kid, issued.kid);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('改一个字符就验不过（bad_signature）', () => {
  const root = tmpRoot();
  try {
    const issued = issueMandate(root, {});
    assert.equal(issued.ok, true);
    const parts = issued.mandate.split('.');
    // 改 payload 里的一个字符
    const payload = parts[1];
    const flipped = `${payload.slice(0, 10)}${payload[10] === 'A' ? 'B' : 'A'}${payload.slice(11)}`;
    const tampered = `${parts[0]}.${flipped}.${parts[2]}`;
    const v = verifyMandate(tampered, { now: FIXED_MS });
    assert.equal(v.ok, false);
    assert.ok(['bad_signature', 'payload'].includes(v.code), `意外的 code=${v.code}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('过期的执照拒收（expired）', () => {
  const root = tmpRoot();
  try {
    const id = ensureIdentity(root);
    assert.equal(id.ok, true);
    const claims = normalizeMandate({
      subject: id.kid,
      issuedBy: id.kid,
      pub: id.publicKeyB64Url,
      iat: 1_700_000_000,
      exp: 1_700_000_100,
    });
    const mandate = encodeMandate(claims, id.privateKeyPem);
    const v = verifyMandate(mandate, { now: FIXED_MS });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'expired');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('前缀/版本不对拒收，且不会 throw', () => {
  assert.equal(verifyMandate('NEXP1.a.b').code, 'format');
  assert.equal(verifyMandate('').code, 'empty');
  assert.equal(verifyMandate('随便一段垃圾').code, 'format');
  assert.equal(verifyMandate(null).code, 'empty');
  assert.equal(verifyMandate(`${MANDATE_PREFIX}.notbase64.notbase64`).code, 'payload');
});

test('judgeAutonomy：白名单内放行', () => {
  const claims = normalizeMandate(defaultMandate());
  const r = judgeAutonomy(claims, { tool: 'fs_read', action: 'read' }, { now: FIXED_MS });
  assert.equal(r.effect, 'allow');
});

test('judgeAutonomy：deny 优先于一切，连白名单也压不住', () => {
  const claims = normalizeMandate({ scope: { tools: ['shell'], deny: ['shell'] } });
  const r = judgeAutonomy(claims, { tool: 'shell', action: 'run' }, { now: FIXED_MS });
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /明确禁止/);
});

test('judgeAutonomy：不在白名单 → confirm（问主人，不是直接拒）', () => {
  const claims = normalizeMandate(defaultMandate());
  const r = judgeAutonomy(claims, { tool: 'deck_market', action: 'buy' }, { now: FIXED_MS });
  assert.equal(r.effect, 'confirm');
  assert.match(r.reason, /不在执照白名单/);
});

test('judgeAutonomy：支持族匹配 fs_*（同时证明 deny 依然压得住白名单）', () => {
  // 白名单放开整族 fs_*，但默认 deny 里点名了 fs_write → fs_write 仍被拒
  const withDeny = normalizeMandate({ scope: { tools: ['fs_*'], actions: [] } });
  assert.equal(judgeAutonomy(withDeny, { tool: 'fs_write' }, { now: FIXED_MS }).effect, 'deny');
  // 把 deny 里的 fs_write 拿掉，族匹配才真正生效
  const open = normalizeMandate({ scope: { tools: ['fs_*'], actions: [], deny: [] } });
  assert.equal(judgeAutonomy(open, { tool: 'fs_write' }, { now: FIXED_MS }).effect, 'allow');
  assert.equal(judgeAutonomy(open, { tool: 'fs_glob' }, { now: FIXED_MS }).effect, 'allow');
  // 族匹配不该误放行别的工具
  assert.equal(judgeAutonomy(open, { tool: 'net_post' }, { now: FIXED_MS }).effect, 'confirm');
});

test('judgeAutonomy：时间窗口外 deny', () => {
  const claims = normalizeMandate({ time: { windows: ['09:00-10:00'], tz: 'UTC' } });
  // FIXED_MS 是 UTC 06:30，不在 09:00-10:00
  const r = judgeAutonomy(claims, { tool: 'fs_read' }, { now: FIXED_MS });
  assert.equal(r.effect, 'deny');
  assert.match(r.reason, /时间窗/);
});

test('judgeAutonomy：超预算 → confirm', () => {
  const claims = normalizeMandate({ budget: { perDay: 5 } });
  const r = judgeAutonomy(claims, { tool: 'fs_read' }, { now: FIXED_MS, dayUsage: 5 });
  assert.equal(r.effect, 'confirm');
  assert.match(r.reason, /超出每日预算/);
});

test('insideWindows：空窗口不限制；跨夜窗口边界正确', () => {
  assert.equal(insideWindows([], FIXED_MS).configured, false);
  assert.equal(insideWindows([], FIXED_MS).inside, true);

  // UTC 06:30 = 分钟 390
  const night = insideWindows(['22:00-06:00'], FIXED_MS, 'UTC');
  assert.equal(night.inside, false, '06:30 不在 22:00-06:00 内（06:00 是右开区间）');
  const lateNight = insideWindows(['22:00-07:00'], FIXED_MS, 'UTC');
  assert.equal(lateNight.inside, true);
});

test('localMinuteOf：时区换算对得上（UTC 06:30 → 上海 14:30）', () => {
  assert.equal(localMinuteOf(FIXED_MS, 'UTC'), 6 * 60 + 30);
  assert.equal(localMinuteOf(FIXED_MS, 'Asia/Shanghai'), 14 * 60 + 30);
});

test('落盘：issue 之后 active.json 可读回，且 claims 一致', () => {
  const root = tmpRoot();
  try {
    const issued = issueMandate(root, { ttlDays: 3 });
    assert.equal(issued.ok, true);
    const active = readActiveMandate(root);
    assert.equal(active.ok, true, active.reason);
    assert.equal(active.claims.id, issued.claims.id);

    const raw = JSON.parse(readFileSync(mandatePaths(root).active, 'utf8'));
    assert.equal(raw.v, 1);
    assert.ok(raw.mandate.startsWith(`${MANDATE_PREFIX}.`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('吊销：账本打标 + active 清空；吊销不存在的 id 如实失败', () => {
  const root = tmpRoot();
  try {
    const issued = issueMandate(root, {});
    assert.equal(issued.ok, true);

    const bad = revokeMandate(root, 'mand_不存在');
    assert.equal(bad.ok, false);

    const ok = revokeMandate(root, issued.claims.id);
    assert.equal(ok.ok, true);
    assert.equal(ok.revoked, 1);

    const after = readActiveMandate(root);
    assert.equal(after.mandate, null);

    const summary = mandateSummary(root, { now: FIXED_MS });
    assert.equal(summary.revoked, 1);
    assert.equal(summary.hasActive, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mandateSummary：没有执照时如实说没有，不自动生成', () => {
  const root = tmpRoot();
  try {
    const summary = mandateSummary(root, { now: FIXED_MS });
    assert.equal(summary.hasActive, false);
    assert.equal(summary.id, '');
    // 没签发过就不该冒出 active.json
    let existed = true;
    try {
      readFileSync(mandatePaths(root).active);
    } catch {
      existed = false;
    }
    assert.equal(existed, false, '读摘要不该创建 active.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('损坏的 active.json 不会让它崩', () => {
  const root = tmpRoot();
  try {
    issueMandate(root, {});
    writeFileSync(mandatePaths(root).active, '{ 这不是 JSON', 'utf8');
    const active = readActiveMandate(root);
    assert.equal(active.ok, false);
    assert.equal(active.mandate, null);
    const summary = mandateSummary(root, { now: FIXED_MS });
    assert.equal(summary.hasActive, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requireSubject：认证主体对不上就拒', () => {
  const root = tmpRoot();
  try {
    const issued = issueMandate(root, { subject: 'kid_别人' });
    assert.equal(issued.ok, true);
    const wrong = verifyMandate(issued.mandate, { now: FIXED_MS, requireSubject: 'kid_我' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'subject_mismatch');
    const right = verifyMandate(issued.mandate, { now: FIXED_MS, requireSubject: 'kid_别人' });
    assert.equal(right.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
