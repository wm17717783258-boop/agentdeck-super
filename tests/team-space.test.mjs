/**
 * tests/team-space.test.mjs —— 团队空间最小闭环（共享记忆 / 成员权限 / 审计导出）
 *
 * 这一组测试钉的是「不许糊弄」的几条：
 *   ① 席位满了必须真拒绝（seats_exhausted），文件里不能偷偷多出一个人；
 *   ② 共享记忆带 expiresAt，过期后 recall 一定查不到；
 *   ③ private 记忆只有作者本人可见，成员被移除时连带清掉；
 *   ④ 审计是 JSONL，一行一条，token/secret 落盘前打码，空结果导出不写空文件；
 *   ⑤ space.json 损坏时所有入口都不抛异常，能按 code 说明白并留档重建。
 *
 * 隔离：每个用例一个临时目录，不碰网络、不碰真实工作区。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SPACE_ROLES,
  DEFAULT_SEATS,
  UNIMPLEMENTED,
  seatLimit,
  spacePath,
  teamDir,
  readSpace,
  createSpace,
  joinSpace,
  leaveSpace,
  removeMember,
  listMembers,
  setRole,
  shareMemory,
  recallTeamMemory,
  pruneExpiredMemory,
  spaceStatus,
} from '../lib/team/space.js';
import {
  auditPath,
  appendTeamAudit,
  readAudit,
  exportAudit,
  retentionSweep,
  auditStats,
  toCsv,
  redact,
} from '../lib/team/audit.js';
import { createDeckTeamTool, createTeamTool } from '../lib/tools/team.js';

const newRoot = () => mkdtempSync(join(tmpdir(), 'adsk-team-'));
const DAY = 86400_000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

const text = async (tool, args) => {
  const r = await tool.execute(args, {});
  if (r && typeof r === 'object' && typeof r.text === 'string') return r.text;
  return String(r);
};

// ── 席位 ────────────────────────────────────────────────────────────────

test('seatLimit：从 license 的各种形状里读座位，读不到才退回默认 3', () => {
  assert.equal(DEFAULT_SEATS, 3);
  assert.equal(seatLimit(null), 3);
  assert.equal(seatLimit(undefined), 3);
  assert.equal(seatLimit(5), 5, '直接给数字');
  assert.equal(seatLimit({ claims: { seats: 8 } }), 8, '授权码 claims.seats 优先');
  assert.equal(seatLimit({ entitlements: { maxSeats: 30 } }), 30, '档位权益 maxSeats');
  assert.equal(seatLimit({ seats: 2 }), 2);
  assert.equal(seatLimit({ claims: { seats: 0 }, entitlements: { maxSeats: 8 } }), 8, 'claims 非法要看权益');
  assert.equal(seatLimit({ claims: { seats: 99999 } }), 200, '离谱值夹到硬上限');
  assert.equal(seatLimit({ nonsense: true }), 3);
  // 传给整个 license 模块命名空间也能用（Lead 接线时最省事）
  const mod = { currentLicense: () => ({ ok: true, tier: 'plus', entitlements: { maxSeats: 8 } }) };
  assert.equal(seatLimit(mod), 8);
  const broken = { currentLicense: () => { throw new Error('boom'); } };
  assert.equal(seatLimit(broken), 3, '模块抛错也不许炸');
});

test('createSpace：写 <root>/team/space.json，房主自动占 1 席且是 lead', () => {
  const root = newRoot();
  const res = createSpace({ root, name: '支付重构', ownerId: 'wang', now: T0 });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.space.seats.total, 3);
  assert.equal(res.space.seats.used, 1);
  assert.equal(res.space.members.length, 1);
  assert.equal(res.space.members[0].role, 'lead');
  assert.equal(res.space.members[0].id, 'wang');
  assert.deepEqual(res.space.sharedMemory, []);
  assert.equal(res.space.policy.allowGuest, true);

  const file = spacePath(root);
  assert.ok(existsSync(file), '空间文件必须真的落盘');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.id, res.space.id);
  assert.deepEqual(Object.keys(onDisk).sort(), ['createdAt', 'id', 'members', 'name', 'ownerId', 'policy', 'seats', 'sharedMemory']);
});

test('createSpace：已存在就不覆盖（幂等，保住用户数据）', () => {
  const root = newRoot();
  const a = createSpace({ root, name: 'A', ownerId: 'wang', now: T0 });
  const b = createSpace({ root, name: 'B', ownerId: 'other', now: T0 + 1000 });
  assert.equal(b.ok, true);
  assert.equal(b.created, false);
  assert.equal(b.space.id, a.space.id);
  assert.equal(b.space.name, 'A', '第二次调用不许改名');
});

test('createSpace：席位来自 license，不写死', () => {
  const root = newRoot();
  const res = createSpace({ root, name: '大组', ownerId: 'wang', license: { claims: { seats: 5 } } });
  assert.equal(res.space.seats.total, 5);
  const r2 = newRoot();
  const res2 = createSpace({ root: r2, name: '小组', ownerId: 'w', license: { entitlements: { maxSeats: 2 } } });
  assert.equal(res2.space.seats.total, 2);
});

// ── 成员与席位闸门 ──────────────────────────────────────────────────────

test('joinSpace：满员时真拒绝，文件里不会偷偷多出人', () => {
  const root = newRoot();
  createSpace({ root, name: '3 席', ownerId: 'a' }); // total 3, used 1
  assert.equal(joinSpace({ root, member: { id: 'b' } }).ok, true);
  assert.equal(joinSpace({ root, member: { id: 'c' } }).ok, true);
  assert.equal(listMembers({ root }).seats.used, 3);

  const res = joinSpace({ root, member: { id: 'd', name: '第四人' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'seats_exhausted');
  assert.equal(res.seats.used, 3);
  assert.equal(res.seats.total, 3);
  // 关键：失败不能留下副作用
  const onDisk = JSON.parse(readFileSync(spacePath(root), 'utf8'));
  assert.equal(onDisk.members.length, 3);
  assert.equal(onDisk.members.some((m) => m.id === 'd'), false);
});

test('joinSpace：重复加入幂等，不吃席位', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  joinSpace({ root, member: { id: 'b', name: '老王' } });
  const again = joinSpace({ root, member: { id: 'b', name: '老王' } });
  assert.equal(again.ok, true);
  assert.equal(again.existing, true);
  assert.equal(again.seats.used, 2);
});

test('joinSpace：没建空间时给 no_space，不凭空造文件', () => {
  const root = newRoot();
  const res = joinSpace({ root, member: { id: 'b' } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_space');
  assert.equal(existsSync(spacePath(root)), false);
});

test('joinSpace：缺 member id 直接拒绝（不生成 anonymous 幽灵成员）', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  const res = joinSpace({ root, member: {} });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'bad_member');
  assert.equal(listMembers({ root }).members.length, 1);
});

test('leaveSpace：退出释放席位；房主不许退出', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  joinSpace({ root, member: { id: 'b', role: 'worker' } });
  const left = leaveSpace({ root, memberId: 'b' });
  assert.equal(left.ok, true);
  assert.equal(left.seats.used, 1);

  const owner = leaveSpace({ root, memberId: 'a' });
  assert.equal(owner.ok, false);
  assert.equal(owner.code, 'owner_cannot_leave');
  assert.equal(listMembers({ root }).members.length, 1);
});

// ── 角色 ────────────────────────────────────────────────────────────────

test('setRole：能改、能拒绝乱写、能拒绝把最后一个 lead 降级', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  joinSpace({ root, member: { id: 'b' } });
  assert.deepEqual(SPACE_ROLES, ['lead', 'worker', 'reviewer', 'viewer']);

  const ok = setRole({ root, memberId: 'b', role: 'reviewer' });
  assert.equal(ok.ok, true);
  assert.equal(ok.from, 'worker');
  assert.equal(ok.to, 'reviewer');
  assert.equal(listMembers({ root }).members.find((m) => m.id === 'b').role, 'reviewer');

  const bad = setRole({ root, memberId: 'b', role: 'god' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_role');

  const last = setRole({ root, memberId: 'a', role: 'viewer' });
  assert.equal(last.ok, false);
  assert.equal(last.code, 'last_lead');
  assert.equal(listMembers({ root }).members.find((m) => m.id === 'a').role, 'lead');

  // 有第二个 lead 之后允许降级
  setRole({ root, memberId: 'b', role: 'lead' });
  assert.equal(setRole({ root, memberId: 'a', role: 'worker' }).ok, true);
});

test('removeMember：移除成员并连带清掉他的 private 记忆，team 知识保留', () => {
  const root = newRoot();
  const sp = createSpace({ root, name: 'x', ownerId: 'a', now: T0 });
  joinSpace({ root, member: { id: 'b' } });
  shareMemory({ root, text: '接口按 v2 走', scope: 'team', source: 'b', authorId: 'b', now: T0 });
  shareMemory({ root, text: '我的草稿：先改 lib/foo.js', scope: 'private', authorId: 'b', now: T0 });
  shareMemory({ root, text: '组长的笔记', scope: 'private', authorId: 'a', now: T0 });

  const res = removeMember({ root, memberId: 'b' });
  assert.equal(res.ok, true);
  assert.equal(res.clearedPrivate, 1, '只清他自己的 private');
  const space = readSpace({ root }).space;
  assert.equal(space.sharedMemory.length, 2);
  assert.equal(space.sharedMemory.some((e) => e.authorId === 'b' && e.scope === 'private'), false);
  assert.equal(space.sharedMemory.some((e) => e.authorId === 'b' && e.scope === 'team'), true);
  assert.equal(space.sharedMemory.some((e) => e.authorId === 'a'), true);

  const owner = removeMember({ root, memberId: 'a' });
  assert.equal(owner.ok, false);
  assert.equal(owner.code, 'owner_cannot_leave');
  assert.equal(sp.ok, true);
});

// ── 共享记忆 ────────────────────────────────────────────────────────────

test('shareMemory：带 ttlDays 就有 expiresAt，过期后 recall 一定查不到', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a', now: T0 });
  const shared = shareMemory({ root, text: '今天决定用 SQLite', source: 'standup', ttlDays: 1, now: T0 });
  assert.equal(shared.ok, true);
  assert.equal(shared.entry.expiresAt, new Date(T0 + DAY).toISOString());
  assert.equal(shared.entry.scope, 'team');
  assert.equal(shared.entry.source, 'standup');

  const fresh = recallTeamMemory({ root, now: T0 + 1000 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.items[0].text, '今天决定用 SQLite');

  const later = recallTeamMemory({ root, now: T0 + 2 * DAY });
  assert.equal(later.items.length, 0, '过期条目不许出现');
  assert.equal(later.filtered.expired, 1);
  // 过滤发生在读取时，不靠写盘清理
  assert.equal(readSpace({ root }).space.sharedMemory.length, 1);

  const pruned = pruneExpiredMemory({ root, now: T0 + 2 * DAY });
  assert.equal(pruned.ok, true);
  assert.equal(pruned.pruned, 1);
  assert.equal(readSpace({ root }).space.sharedMemory.length, 0);
});

test('shareMemory：不填 ttlDays 就是永不过期（expiresAt 为 null）', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  const r = shareMemory({ root, text: '长期结论' });
  assert.equal(r.entry.expiresAt, null);
  assert.equal(recallTeamMemory({ root, now: T0 + 3650 * DAY }).items.length, 1);
});

test('shareMemory：空文本拒绝、超长截断并标注', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  assert.equal(shareMemory({ root, text: '   ' }).code, 'empty_text');
  const long = shareMemory({ root, text: 'x'.repeat(5000) });
  assert.equal(long.ok, true);
  assert.ok(long.entry.text.length < 5000);
  assert.match(long.entry.text, /已截断/);
  assert.match(long.entry.text, /5000 字/);
});

test('recallTeamMemory：private 只有作者本人能查到，别人查不到', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  joinSpace({ root, member: { id: 'b' } });
  shareMemory({ root, text: '团队共识：周五发版', scope: 'team', authorId: 'a' });
  shareMemory({ root, text: '私密：我在评估离职', scope: 'private', authorId: 'b' });

  const asA = recallTeamMemory({ root, viewerId: 'a' });
  assert.equal(asA.items.length, 1);
  assert.equal(asA.items[0].text, '团队共识：周五发版');
  assert.equal(asA.filtered.private, 1, '别人的 private 被挡掉');

  const asB = recallTeamMemory({ root, viewerId: 'b' });
  assert.equal(asB.items.length, 2);

  // 没给 viewerId → 最保守：只给 team 范围
  const anon = recallTeamMemory({ root });
  assert.equal(anon.items.length, 1);
  assert.equal(anon.items[0].scope, 'team');
});

test('recallTeamMemory：关键词过滤 text/source/tags，且按时间新的在前', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a', now: T0 });
  shareMemory({ root, text: '数据库选 SQLite', source: 'a', now: T0 });
  shareMemory({ root, text: '前端用 Vite', source: 'b', tags: ['sqlite', '构建'], now: T0 + 1000 });

  const byText = recallTeamMemory({ root, query: '数据库' });
  assert.equal(byText.items.length, 1);
  assert.match(byText.items[0].text, /SQLite/);

  const byTag = recallTeamMemory({ root, query: '构建' });
  assert.equal(byTag.items.length, 1);
  assert.match(byTag.items[0].text, /Vite/);

  const all = recallTeamMemory({ root });
  assert.equal(all.items.length, 2);
  assert.ok(Date.parse(all.items[0].createdAt) >= Date.parse(all.items[1].createdAt), '新的在前');
});

test('recallTeamMemory：空间不存在返回 no_space 而不是空数组糊弄', () => {
  const root = newRoot();
  const res = recallTeamMemory({ root });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'no_space');
  assert.deepEqual(res.items, []);
});

// ── 状态 ────────────────────────────────────────────────────────────────

test('spaceStatus：席位/成员角色分布/记忆分类/政策一次说清', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a', license: { claims: { seats: 4 } }, now: T0 });
  joinSpace({ root, member: { id: 'b', role: 'reviewer' } });
  shareMemory({ root, text: 'team 一条', now: T0 });
  shareMemory({ root, text: 'private 一条', scope: 'private', authorId: 'b', now: T0 });
  shareMemory({ root, text: '过期一条', ttlDays: 1, now: T0 });

  const st = spaceStatus({ root, now: T0 + 2 * DAY });
  assert.equal(st.ok, true);
  assert.deepEqual(st.seats, { total: 4, used: 2, free: 2, limitFromLicense: 3 });
  assert.equal(st.members.total, 2);
  assert.equal(st.members.byRole.lead, 1);
  assert.equal(st.members.byRole.reviewer, 1);
  assert.equal(st.memory.team, 1);
  assert.equal(st.memory.private, 1);
  assert.equal(st.memory.expired, 1);
  assert.equal(st.policy.auditRetentionDays, 180);
});

// ── 审计 ────────────────────────────────────────────────────────────────

test('appendTeamAudit：一行一条 JSONL，字段齐全，timestamp 双轨', () => {
  const root = newRoot();
  appendTeamAudit({ root, spaceId: 's1', actorId: 'a', action: 'member.join', detail: { memberId: 'b' }, now: T0 });
  appendTeamAudit({ root, spaceId: 's1', actorId: 'a', action: 'memory.share', detail: { scope: 'team' }, now: T0 + 1000 });
  appendTeamAudit({ root, spaceId: 's2', actorId: 'z', action: 'member.join', now: T0 + 2000 });

  const lines = readFileSync(auditPath(root), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.equal(first.spaceId, 's1');
  assert.equal(first.actorId, 'a');
  assert.equal(first.action, 'member.join');
  assert.equal(first.at, T0);
  assert.equal(first.ts, new Date(T0).toISOString());
  assert.deepEqual(first.detail, { memberId: 'b' });

  assert.equal(readAudit({ root }).total, 3);
  assert.equal(readAudit({ root, spaceId: 's1' }).total, 2);
  assert.equal(readAudit({ root, spaceId: 's1', from: T0 + 500 }).total, 1);
  assert.equal(readAudit({ root, spaceId: 's1', to: T0 + 500 }).total, 1);
});

test('appendTeamAudit：token/secret 落盘前打码，绝不写进日志', () => {
  const root = newRoot();
  appendTeamAudit({
    root,
    spaceId: 's1',
    action: 'license.activate',
    detail: { licenseKey: 'ADSK1-SECRET-VALUE', token: 'dsh_invite_abcdef', nested: { apiKey: 'sk-123', keep: 'ok' } },
  });
  const raw = readFileSync(auditPath(root), 'utf8');
  assert.equal(raw.includes('ADSK1-SECRET-VALUE'), false, '授权串不许进审计');
  assert.equal(raw.includes('dsh_invite_abcdef'), false, 'token 不许进审计');
  assert.equal(raw.includes('sk-123'), false);
  assert.match(raw, /\[redacted\]/);
  assert.match(raw, /ok/);
  // redact 本身也要能处理 Bearer 头
  assert.equal(redact('Authorization: Bearer abcdef1234567890xyz'), 'Authorization: Bearer [redacted]');
  assert.equal(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } }).a.b.c.d.e, '[深度截断]');
});

test('appendTeamAudit：坏行只跳过不炸，读的时候计数', () => {
  const root = newRoot();
  appendTeamAudit({ root, spaceId: 's1', action: 'a', now: T0 });
  const file = auditPath(root);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{半截 JSON\n`, 'utf8');
  const got = readAudit({ root });
  assert.equal(got.ok, true);
  assert.equal(got.total, 1);
  assert.equal(got.skipped, 1);
});

test('exportAudit：csv 导出带表头、真落盘、行数对得上', () => {
  const root = newRoot();
  appendTeamAudit({ root, spaceId: 's1', actorId: 'a', action: 'member.join', detail: { memberId: 'b' }, now: T0 });
  appendTeamAudit({ root, spaceId: 's1', actorId: 'a', action: 'memory.share', detail: { text: '带,逗号"和引号' }, now: T0 + 1 });

  const res = exportAudit({ root, spaceId: 's1', format: 'csv', now: T0 + 10 });
  assert.equal(res.ok, true);
  assert.equal(res.written, true);
  assert.equal(res.count, 2);
  assert.equal(res.format, 'csv');
  assert.ok(existsSync(res.path), '导出文件必须存在');
  assert.match(res.path, /audit-export-.*\.csv$/);

  const csv = readFileSync(res.path, 'utf8');
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'ts,spaceId,actorId,action,detail');
  assert.equal(lines.length, 3);
  assert.match(csv, /member\.join/);
  assert.match(csv, /""/, 'detail 里的引号要转义成双引号');

  // JSON 导出同样能落地且可解析
  const js = exportAudit({ root, spaceId: 's1', format: 'json', now: T0 + 20 });
  assert.equal(js.count, 2);
  const parsed = JSON.parse(readFileSync(js.path, 'utf8'));
  assert.equal(parsed.count, 2);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.spaceId, 's1');
});

test('exportAudit：0 条时不写空文件（也不谎报路径）', () => {
  const root = newRoot();
  const res = exportAudit({ root, spaceId: 'nobody', now: T0 });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.equal(res.written, false);
  assert.equal(res.path, '');
  const files = existsSync(teamDir(root)) ? readdirSync(teamDir(root)) : [];
  assert.equal(files.some((f) => f.startsWith('audit-export-')), false, '不许留空壳文件');
});

test('retentionSweep：按保留期删旧行、留新行，返回删除条数', () => {
  const root = newRoot();
  appendTeamAudit({ root, spaceId: 's1', action: 'old1', now: T0 });
  appendTeamAudit({ root, spaceId: 's1', action: 'old2', now: T0 + 1000 });
  appendTeamAudit({ root, spaceId: 's1', action: 'fresh', now: T0 + 30 * DAY });
  appendTeamAudit({ root, spaceId: 's2', action: 'other-space-old', now: T0 });

  const res = retentionSweep({ root, spaceId: 's1', days: 7, now: T0 + 30 * DAY });
  assert.equal(res.ok, true);
  assert.equal(res.removed, 2, '只删本空间且早于保留期的');
  assert.equal(res.kept, 2, '保留的是 fresh + 另一个空间的行');

  const left = readAudit({ root }).entries.map((e) => e.action).sort();
  assert.deepEqual(left, ['fresh', 'other-space-old'], '别的空间的行不动');

  const bad = retentionSweep({ root, spaceId: 's1', days: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_days');

  const stats = auditStats({ root, spaceId: 's1' });
  assert.equal(stats.total, 1);
  assert.equal(stats.byAction.fresh, 1);
  assert.equal(auditStats({ root, spaceId: 'nope' }).total, 0);
});

// ── 损坏文件 ────────────────────────────────────────────────────────────

test('space.json 损坏：所有入口都返回 code，不抛异常；重建时留档坏文件', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  const file = spacePath(root);
  writeFileSync(file, '{ "id": "space_1", "members": [', 'utf8');

  const read = readSpace({ root });
  assert.equal(read.ok, false);
  assert.equal(read.code, 'corrupt');
  assert.equal(read.space, null);

  const members = listMembers({ root });
  assert.equal(members.ok, false);
  assert.equal(members.code, 'corrupt');
  assert.deepEqual(members.members, []);

  assert.equal(joinSpace({ root, member: { id: 'b' } }).code, 'corrupt');
  assert.equal(shareMemory({ root, text: 'x' }).code, 'corrupt');
  assert.equal(spaceStatus({ root }).code, 'corrupt');
  assert.equal(setRole({ root, memberId: 'a', role: 'lead' }).code, 'corrupt');

  // 重建：坏文件改名留档，新空间干净可用
  const rebuilt = createSpace({ root, name: '重建组', ownerId: 'a' });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.created, true);
  assert.equal(rebuilt.recovered, true);
  assert.ok(existsSync(rebuilt.corruptBackup), '坏文件必须留档，不能静默删除');
  assert.match(rebuilt.corruptBackup, /space\.corrupt-.*\.json$/);
  assert.equal(readSpace({ root }).ok, true);
  assert.equal(listMembers({ root }).members.length, 1);
});

test('space.json 形状不对（JSON 合法但缺字段）也算损坏', () => {
  const root = newRoot();
  createSpace({ root, name: 'x', ownerId: 'a' });
  writeFileSync(spacePath(root), JSON.stringify({ hello: 'world' }), 'utf8');
  const read = readSpace({ root });
  assert.equal(read.ok, false);
  assert.equal(read.code, 'corrupt');
  assert.match(read.reason, /关键字段/);
});

test('toCsv：对象 detail 序列化成 JSON，坏输入不炸', () => {
  const csv = toCsv([{ ts: 'T', spaceId: 's', actorId: 'a', action: 'x', detail: { k: 1 } }]);
  assert.equal(csv.split('\n').length, 2);
  assert.ok(csv.includes('"{""k"":1}"'), `对象 detail 要序列化并转义，实际：${csv}`);
  assert.equal(toCsv([]).split('\n').length, 1);
  assert.equal(toCsv(null).split('\n').length, 1);
});

// ── deck_team 工具 ──────────────────────────────────────────────────────

test('deck_team 工具契约：名字/描述/动作枚举/输出 schema', () => {
  const tool = createDeckTeamTool({});
  assert.equal(tool.name, 'deck_team');
  assert.ok(tool.description.length > 40);
  const actions = tool.parameters.properties.action.enum;
  for (const a of ['create', 'join', 'leave', 'remove', 'members', 'set-role', 'share', 'recall', 'audit-export', 'audit-sweep', 'status']) {
    assert.ok(actions.includes(a), `缺动作 ${a}`);
  }
  assert.deepEqual(Object.keys(tool.output.schema.properties), ['text']);
  assert.deepEqual(tool.output.schema.required, ['text']);
  assert.equal(tool.output.render({}, { text: 'hi' })[0].text, 'hi');
  assert.ok(Number(tool.timeoutMs) > 0);
  // 老的 team_orchestrate 没被挤掉（Lead 的接线表还指着它）
  const old = createTeamTool({});
  assert.equal(old.name, 'team_orchestrate');
  assert.ok(old.parameters.properties.goal);
});

test('deck_team：没空间时 status 说人话并如实列出未实现能力', async () => {
  const root = newRoot();
  const tool = createDeckTeamTool({ root: () => root });
  const out = await text(tool, { action: 'status' });
  assert.match(out, /还没有团队空间/);
  assert.match(out, /建一个团队/);
  assert.match(out, /sso/);
  assert.match(out, /scim/);
  assert.match(out, /private-deploy/);
  assert.deepEqual(UNIMPLEMENTED, ['sso', 'scim', 'private-deploy']);
});

test('deck_team：create → join → members，席位满时明确拒绝', async () => {
  const root = newRoot();
  const tool = createDeckTeamTool({ root: () => root, license: { claims: { seats: 3 } } });

  const created = await text(tool, { action: 'create', name: '支付重构', ownerId: 'wang' });
  assert.match(created, /团队空间已创建/);
  assert.match(created, /1\/3 已用/);

  const joined = await text(tool, { action: 'join', memberId: 'laowang', memberName: '老王', role: 'reviewer', capabilities: ['node'] });
  assert.match(joined, /已加入/);
  assert.match(joined, /2\/3 已用/);

  const full = await text(tool, { action: 'join', memberId: 'c' });
  assert.match(full, /3\/3 已用/);
  const over = await text(tool, { action: 'join', memberId: 'd' });
  assert.match(over, /没加进去/);
  assert.match(over, /满了/);
  assert.doesNotMatch(over, /已加入/, '满了就不许说加入成功');

  const list = await text(tool, { action: 'members' });
  assert.match(list, /3 人/);
  assert.match(list, /laowang/);
  assert.match(list, /评审/);
  assert.match(list, /房主/);
  assert.doesNotMatch(list, /d（/, '被拒的人不许出现在成员表里');
});

test('deck_team：share / recall / set-role / leave 串起来是闭环', async () => {
  const root = newRoot();
  const tool = createDeckTeamTool({ root: () => root });
  await text(tool, { action: 'create', name: 'x', ownerId: 'wang' });
  await text(tool, { action: 'join', memberId: 'b', role: 'worker' });

  const shared = await text(tool, { action: 'share', text: '发版前必须跑全量测试', source: 'standup', ttlDays: 3 });
  assert.match(shared, /已记住/);
  assert.match(shared, /过期/);

  const recalled = await text(tool, { action: 'recall', query: '测试' });
  assert.match(recalled, /命中 1 条/);
  assert.match(recalled, /发版前必须跑全量测试/);

  const none = await text(tool, { action: 'recall', query: '不存在的词' });
  assert.match(none, /没有匹配/);

  const role = await text(tool, { action: 'set-role', memberId: 'b', role: 'reviewer' });
  assert.match(role, /worker → reviewer/);

  const left = await text(tool, { action: 'leave', memberId: 'b' });
  assert.match(left, /已退出/);
  assert.match(left, /1\/3 已用/);

  const ownerLeave = await text(tool, { action: 'leave', memberId: 'wang' });
  assert.match(ownerLeave, /房主不能退出/);
});

test('deck_team：审计有留痕，audit-export 真给出文件与条数', async () => {
  const root = newRoot();
  const tool = createDeckTeamTool({ root: () => root });
  await text(tool, { action: 'create', name: 'x', ownerId: 'wang' });
  await text(tool, { action: 'join', memberId: 'b' });
  await text(tool, { action: 'share', text: '结论：用 SQLite' });

  const stats = auditStats({ root });
  assert.ok(stats.total >= 3, `审计应记录 create/join/share，实际 ${stats.total}`);
  assert.equal(stats.byAction['space.create'], 1);
  assert.equal(stats.byAction['member.join'], 1);
  assert.equal(stats.byAction['memory.share'], 1);

  const exported = await text(tool, { action: 'audit-export', format: 'csv' });
  assert.match(exported, /审计已导出/);
  assert.match(exported, /3 条/);
  assert.match(exported, /audit-export-.*\.csv/);

  const swept = await text(tool, { action: 'audit-sweep', days: 30 });
  assert.match(swept, /审计清理完成/);
  assert.match(swept, /删除 0 条/);
});

test('deck_team：status 把席位/记忆/审计/未实现能力一次说清', async () => {
  const root = newRoot();
  const tool = createDeckTeamTool({ root: () => root, license: { claims: { seats: 5 } } });
  await text(tool, { action: 'create', name: '工作室', ownerId: 'wang' });
  await text(tool, { action: 'join', memberId: 'b', role: 'reviewer' });
  await text(tool, { action: 'share', text: '团队共识', scope: 'team' });
  await text(tool, { action: 'share', text: '私密笔记', scope: 'private' });

  const out = await text(tool, { action: 'status' });
  assert.match(out, /工作室/);
  assert.match(out, /2\/5 已用/);
  assert.match(out, /成员：2 人/);
  assert.match(out, /team 1 条/);
  assert.match(out, /private 1 条/);
  assert.match(out, /审计：\d+ 条/);
  assert.match(out, /保留 180 天/);
  assert.match(out, /未实现/);
  assert.match(out, /sso、scim、private-deploy/);
});

test('deck_team：空间文件损坏时工具不抛异常，提示可重建', async () => {
  const root = newRoot();
  await text(createDeckTeamTool({ root: () => root }), { action: 'create', name: 'x', ownerId: 'a' });
  writeFileSync(spacePath(root), 'not json at all', 'utf8');
  const tool = createDeckTeamTool({ root: () => root });
  const out = await text(tool, { action: 'status' });
  assert.match(out, /看不了状态|空间文件坏了/);
  assert.match(out, /重建/);
  const joined = await text(tool, { action: 'join', memberId: 'b' });
  assert.match(joined, /没加成/);
});

test('deck_team：不认识的动作列出可用动作，不静默成功', async () => {
  const root = newRoot();
  const tool = createDeckTeamTool({ root: () => root });
  const out = await text(tool, { action: 'steal' });
  assert.match(out, /不认识/);
  assert.match(out, /audit-export/);
});

test('deck_team：execute 永不抛异常（连奇怪的入参也不）', async () => {
  const root = newRoot();
  const tool = createDeckTeamTool({ root: () => root });
  for (const args of [undefined, null, 'x', [], { action: null }, { action: 'join' }, { action: 'share', text: null }, { action: 'set-role', memberId: null }]) {
    const r = await tool.execute(args, {});
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.length > 0);
  }
});
