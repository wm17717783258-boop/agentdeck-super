#!/usr/bin/env node
/**
 * 端到端自检（不开宿主、不烧模型额度、不联网）—— 一条命令证明"这套东西真能跑"
 *
 *   node tests/e2e-local.mjs
 *
 * 覆盖五条主链路：
 *   ① 通用 Agent 接入：按各 CLI 的参数模板真起子进程、真解析输出（用 fake-agent 顶替模型）
 *   ② 任务板：建组 → 派活 → 抢占式认领 → 完成 → 事件流
 *   ③ 授权：签一张真凭证 → 落盘激活 → 读回 → 权益生效
 *   ④ 跨机协同：起真 relay → 房主建房 → 客人凭邀请进房 → 任务双向流转
 *   ⑤ 降级：relay 不可达时本地照常干活
 *
 * 任何一步失败不影响其他步骤，最后统一汇总；有失败则退出码 1。
 * 结果同时写进 docs/evidence/e2e-local-<时间戳>.md，可作为发布前的验收记录。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

import { createBoard } from '../lib/engine/board.js';
import { runAgent } from '../lib/engine/cli.js';
import { encodeLicense, currentLicense, writeLicenseKey, entitlements, verifyLicense } from '../lib/license.js';
import { createRoomClient } from '../lib/room.js';
import { startRelayServer } from '../tools/relay-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(root, 'tests', 'fixtures', 'fake-agent.mjs');
const startedAt = new Date();
const results = [];

async function step(id, title, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ id, title, ok: true, ms: Date.now() - t0, detail: detail || '' });
    console.log(`  ✓ ${id}. ${title}${detail ? ` — ${detail}` : ''}  (${Date.now() - t0}ms)`);
    return true;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    results.push({ id, title, ok: false, ms: Date.now() - t0, detail: msg });
    console.log(`  ✗ ${id}. ${title} — ${msg}  (${Date.now() - t0}ms)`);
    return false;
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// 临时工作区（模拟一台新机器）
const wsA = mkdtempSync(join(tmpdir(), 'adsk-e2e-a-'));
const wsB = mkdtempSync(join(tmpdir(), 'adsk-e2e-b-'));
const relayDir = mkdtempSync(join(tmpdir(), 'adsk-e2e-relay-'));

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const nowSec = Math.floor(Date.now() / 1000);

let relay = null;
let boardA = null;
let boardB = null;
let teamA = null;
let roomId = null;

console.log('\n═══ AgentDeck Super · 端到端自检 ═══');
console.log(`  工作区 A：${wsA}`);
console.log(`  工作区 B：${wsB}\n`);

// ── ① 通用 Agent 接入 ─────────────────────────────────────────────────────

await step('1', '通用 Agent 接入：真起子进程 + 解析各家输出格式', async () => {
  const cases = [
    { name: 'claude 风格（JSON 结果 + 前置日志噪音）', args: [FAKE, '--mode', 'claude'], mode: 'claude' },
    { name: 'codex 风格（纯文本 + tokens used）', args: [FAKE, '--mode', 'codex'], mode: 'codex' },
    { name: 'dsh 风格（NDJSON 事件流）', args: [FAKE, '--mode', 'dsh'], mode: 'dsh' },
  ];
  const got = [];
  for (const c of cases) {
    const spec = { id: 'custom', cmd: process.execPath, args: c.args, transport: 'cli' };
    const res = await runAgent(spec, `你好-${c.mode}`, { timeoutMs: 20000 });
    assert(res.rc === 0, `${c.name} 退出码 ${res.rc}：${res.err || ''}`);
    const text = String(res.out || '');
    assert(/FAKE\[p\]/.test(text), `${c.name} 没有解析出回复正文，原始输出：${text.slice(0, 200)}`);
    assert(text.includes(`你好-${c.mode}`), `${c.name} 提示词没送进去`);
    got.push(c.mode);
  }
  return `${got.length} 种输出格式全部解析成功（${got.join(' / ')}）`;
});

// ── ② 任务板 ──────────────────────────────────────────────────────────────

await step('2', '任务板：建组 → 加成员 → 派活 → 抢占认领 → 完成 → 事件流', async () => {
  boardA = createBoard({ root: wsA });
  teamA = boardA.createTeam({
    name: '发布小分队',
    goal: '把 1.4.0 发出去',
    members: [
      { name: 'claude', kind: 'cli' },
      { name: 'codex', kind: 'cli' },
    ],
  });
  assert(teamA.id, '建组没有返回 id');
  const teamId = teamA.id;

  const t1 = boardA.addTask(teamId, { title: '写发布说明', role: 'worker', acceptance: '能贴到市场页' });
  const t2 = boardA.addTask(teamId, { title: '跑回归测试', role: 'tester' });
  assert(t1.id && t2.id, '加任务失败');

  // 抢占式认领：第二次认领必须失败（防重复派活）
  assert(boardA.claimTask(teamId, t1.id, 'claude') === true, '第一次认领应该成功');
  assert(boardA.claimTask(teamId, t1.id, 'codex') === false, '已被认领的任务不该被别人抢走');

  boardA.completeTask(teamId, t1.id, { summary: '发布说明已写好', by: 'claude' });
  const tasks = boardA.listTasks(teamId, {});
  assert(tasks.length === 2, `应该有 2 个任务，实际 ${tasks.length}`);
  const done = boardA.listTasks(teamId, { status: 'done' });
  assert(done.length === 1 && done[0].id === t1.id, '完成状态不对');

  const events = boardA.listEvents(teamId, 0);
  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ['team/create', 'member/join', 'task/add', 'task/claim']) {
    assert(kinds.has(k), `事件流缺少 ${k}`);
  }
  return `2 个任务、${events.length} 条事件、认领互斥生效`;
});

// ── ③ 授权 ────────────────────────────────────────────────────────────────

await step('3', '授权：签真凭证 → 校验 → 篡改必拒 → 落盘 → 权益生效', async () => {
  const claims = { v: 1, id: 'lic_e2e', tier: 'pro', sub: '端到端测试', iat: nowSec, exp: nowSec + 86400 * 30, seats: 8 };
  const key = encodeLicense(claims, privPem);
  assert(/^ADSK1\./.test(key), '凭证格式不对');

  // 伪造/篡改必须被拒（这条比"能验过"更重要：它决定授权能不能被白嫖）
  const tampered = key.slice(0, -4) + 'AAAA';
  assert(verifyLicense(tampered, { publicKeyB64Url: pubB64 }).ok === false, '篡改后的凭证居然通过了');
  assert(verifyLicense(key, { publicKeyB64Url: pubB64 }).ok === true, '合法凭证没通过');

  // 落盘 → 读回（用同一把公钥验证，等价于宿主里的真实链路）
  writeLicenseKey(wsA, key);
  const lic = currentLicense(wsA, { publicKeyB64Url: pubB64 });
  assert(lic.ok === true, `落盘后读不回来：${lic.reason}`);
  assert(lic.tier === 'pro', `档位不对：${lic.tier}`);
  const ent = entitlements(lic.tier);
  assert(ent.cloudRooms > 0 && ent.maxSeats > 0, '权益字段没生效');

  // 真签发链路：用真实签发私钥签一张，再用插件里烧死的公钥验（证明两者是同一对）
  const issuerKeyPath = process.env.ADSK_ISSUER_KEY || join(process.env.USERPROFILE || '', '.agentdeck-issuer', 'issuer-private.pem');
  let realNote = '（跳过真签发：本机没有签发私钥）';
  if (existsSync(issuerKeyPath)) {
    const realKey = encodeLicense({ v: 1, id: 'lic_real', tier: 'studio', sub: '真签发验证', iat: nowSec, exp: nowSec + 86400 * 365 }, readFileSync(issuerKeyPath, 'utf8'));
    const real = verifyLicense(realKey); // 不传公钥 = 用插件内置的正式公钥
    assert(real.ok === true, `真签发的凭证被插件拒了（公钥与私钥不配对）：${real.reason}`);
    assert(real.tier === 'studio', `真签发档位不对：${real.tier}`);
    realNote = '真签发链路已验（studio 档）';
  }
  return `档位 ${lic.tier}，云房间 ${ent.cloudRooms}、席位 ${ent.maxSeats}、并行 ${ent.parallel}；${realNote}`;
});

// ── ④ 跨机协同 ────────────────────────────────────────────────────────────

await step('4', '跨机协同：真 relay + 真建房 + 真邀请 + 任务双向流转', async () => {
  relay = await startRelayServer({ port: 0, dataDir: relayDir, publicKeyB64Url: pubB64, quiet: true });
  // 房主的授权：本地已经是 pro（relay 那边按同一把公钥验真签）
  const ownerKey = encodeLicense({ v: 1, id: 'lic_e2e_room', tier: 'pro', sub: '端到端测试', iat: nowSec, exp: nowSec + 86400 * 30 }, privPem);
  const ownerLic = { ...currentLicense(wsA, { publicKeyB64Url: pubB64 }), ok: true, tier: 'pro', key: ownerKey };

  const owner = createRoomClient({ relayUrl: relay.url, root: wsA, board: boardA, teamId: teamA.id, license: ownerLic });
  const created = await owner.createRoom({ name: '端到端联调房' });
  assert(created.ok, `建房失败：${created.reason}`);
  roomId = created.room.roomId;
  assert(/^dsh:\/\/agentdeck\/join\?room=/.test(created.inviteUrl), '邀请链接格式不对');

  // 另一台"机器"：独立工作区 + 独立任务板，凭邀请进房（客人不需要授权）
  boardB = createBoard({ root: wsB });
  const teamB = boardB.createTeam({ name: '外包组', goal: '接活' });
  const guest = createRoomClient({ relayUrl: relay.url, root: wsB, board: boardB, teamId: teamB.id, license: null });
  const joined = await guest.joinRoom({ inviteUrl: created.inviteUrl, member: { name: '同事小张' } });
  assert(joined.ok, `进房失败：${joined.reason}`);
  assert(joined.members.length === 2, `房间里应有 2 人，实际 ${joined.members.length}`);

  // 房主派活 → 推上去
  const ownerTask = boardA.addTask(teamA.id, { title: '把落地页改一版', role: 'worker' });
  const pushed = await owner.publishLocalTasks();
  assert(pushed.ok, `推送失败：${pushed.reason}`);

  // 客人拉下来 → 在自己的板子上看到 → 认领并做掉
  const pulled = await guest.pull();
  assert(pulled.ok, `拉取失败：${pulled.reason}`);
  const guestTasks = boardB.listTasks(teamB.id, {});
  assert(guestTasks.length >= 1, `客人那边没收到任务（applied=${pulled.applied}）`);
  const gt = guestTasks.find((t) => t.title === '把落地页改一版');
  assert(gt, '收到的任务标题对不上');
  assert(boardB.claimTask(teamB.id, gt.id, '同事小张'), '客人认领失败');
  const ref = guest.refFor(gt.id);
  await guest.push([{ kind: 'task/claim', payload: { ...ref, memberName: '同事小张' } }]);
  await guest.push([{ kind: 'task/done', payload: { ...ref, summary: '落地页新版已上线', memberName: '同事小张' } }]);

  // 房主拉回来 → 看到自己派出去的活被客人做完了
  const back = await owner.pull();
  assert(back.ok, `房主拉取失败：${back.reason}`);
  const finalTask = boardA.listTasks(teamA.id, {}).find((t) => t.id === ownerTask.id);
  assert(finalTask.status === 'done', `房主侧任务状态应为 done，实际 ${finalTask.status}`);
  assert(finalTask.assignee === '同事小张', `房主侧执行人应为"同事小张"，实际 ${finalTask.assignee}`);

  // 幂等：再拉一次不产生重复
  await guest.pull();
  assert(boardB.listTasks(teamB.id, {}).length === guestTasks.length, '重复同步产生了重复任务');

  return `房间 ${roomId.slice(0, 8)}…，2 人，任务跨机器往返一次，幂等通过`;
});

// ── ⑤ 降级 ────────────────────────────────────────────────────────────────

await step('5', '降级：relay 不可达时本地照常干活', async () => {
  const wsC = mkdtempSync(join(tmpdir(), 'adsk-e2e-c-'));
  const boardC = createBoard({ root: wsC });
  const teamC = boardC.createTeam({ name: '断网组', goal: '离线也能干' });
  const offline = createRoomClient({
    relayUrl: 'http://127.0.0.1:1',
    root: wsC,
    board: boardC,
    teamId: teamC.id,
    license: null,
  });
  const r = await offline.createRoom({ name: '连不上' });
  assert(r.ok === false, 'relay 不可达居然报告成功');
  assert(/连不上 relay|没有配置|不含云房间|授权码/.test(r.reason), `错误信息不是人话：${r.reason}`);
  const t = boardC.addTask(teamC.id, { title: '离线也能记一笔' });
  assert(t.id, '离线时任务板坏了');
  const done = boardC.completeTask(teamC.id, t.id, { summary: '线下干完了', by: '本地' });
  assert(done, '离线时无法完成任务');
  rmSync(wsC, { recursive: true, force: true });
  return `返回「${r.reason}」，本地任务板正常记活并完成`;
});

// ── 收尾 + 汇总 ───────────────────────────────────────────────────────────

if (relay) await relay.close();
for (const d of [wsA, wsB, relayDir]) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
}

const pass = results.filter((r) => r.ok);
const fail = results.filter((r) => !r.ok);
console.log(`\n═══ 汇总：${pass.length}/${results.length} 步通过 ═══`);
for (const r of fail) console.log(`  ✗ ${r.id}. ${r.title}：${r.detail}`);

const dir = join(root, 'docs', 'evidence');
mkdirSync(dir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const file = join(dir, `e2e-local-${stamp}.md`);
writeFileSync(
  file,
  [
    '# 端到端自检记录',
    '',
    `- 时间：${startedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `- 平台：${process.platform} ${process.arch} · Node ${process.version}`,
    `- 结论：**${pass.length}/${results.length} 步通过**`,
    '',
    '| # | 链路 | 结果 | 耗时 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.ok ? '✅ 通过' : '❌ 失败'} | ${r.ms}ms | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 160)} |`),
    '',
    fail.length ? '## 失败详情\n\n' + fail.map((r) => `### ${r.id}. ${r.title}\n\n\`\`\`\n${r.detail}\n\`\`\``).join('\n\n') : '全部通过。',
  ].join('\n'),
  'utf8',
);
console.log(`证据：${file}`);
if (fail.length) process.exit(1);

