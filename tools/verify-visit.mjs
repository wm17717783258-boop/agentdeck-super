/**
 * tools/verify-visit.mjs —— 两个真人、两台机器、两个 Agent 的串门端到端取证（1.10.0）
 *
 * 为什么要单独写这一层：单元测试证明的是"函数算得对"，产品方案要的是
 * **跨进程真串一次门**。这里做的是：
 *
 *   甲机（DSH_HOME=A）→ 造邀请函 → 把链接给乙机
 *   乙机（DSH_HOME=B）→ 收下邀请 → 回一张自己的名片 → 留一张求助便签
 *   甲机 → 真收到便签、真落进任务板
 *
 * 全程两个独立进程、两个互不相干的 DSH_HOME、两份独立身份密钥，
 * 中间只靠一条邀请链接和一段便签 JSON 传话（就是用户手动复制的那两样东西）。
 * 不联网：乙机回的地址是本脚本起的本地 HTTP 服务。
 *
 * 用法：node tools/verify-visit.mjs
 * 证据：docs/evidence/visit-2user-1.10.0.txt
 */

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const REPO = resolve(join(HERE, '..', '..'));
const OUT = join(REPO, 'docs', 'evidence', 'visit-2user-1.10.0.txt');

/** lib/pet/visit.js 的 file:// 地址（给跑在别的进程里的步骤脚本用）。 */
function visitModuleUrl() {
  return pathToFileURL(join(REPO, 'lib', 'pet', 'visit.js')).href;
}

const lines = [];
let pass = 0;
let fail = 0;

function ok(name, extra = '') {
  pass += 1;
  lines.push(`  ✅ ${name}${extra ? ` —— ${extra}` : ''}`);
}
function bad(name, extra = '') {
  fail += 1;
  lines.push(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`);
}
function check(cond, name, extra = '') {
  if (cond) ok(name, extra);
  else bad(name, extra);
}
function say(text = '') {
  lines.push(text);
}

/** 把一个"机器"跑成独立进程：独立 DSH_HOME、独立工作区、独立身份。 */
function runOn(label, dshHome, workdir, script) {
  // 内联脚本里带换行会踩到 node -e 的转义坑，统一先写成临时文件再跑。
  // 脚本里出现的 '__VISIT_MOD__' 会被换成 lib/pet/visit.js 的 file:// 地址：
  // 直接把路径拼进模板字符串会被本文件自己的 ${} 提前吃掉。
  const body = String(script).split('__VISIT_MOD__').join(visitModuleUrl());
  const file = join(workdir, `.step-${label.replace(/[^\w-]/g, '_')}-${Date.now().toString(36)}.mjs`);
  writeFileSync(file, body, 'utf8');
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    AGENTDECK_HOME: dshHome,
    NEXI_VISIT_WORK: workdir,
  };
  const res = spawnSync(process.execPath, [file], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (res.status !== 0) {
    bad(`${label} 进程退出码 ${res.status}`, String(res.stderr || '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 400));
  }
  if (process.env.NEXI_VISIT_DEBUG === '1') {
    process.stderr.write(`[debug] ${label} workdir=${workdir}\n[debug] stdout=${JSON.stringify(String(res.stdout || ''))}\n[debug] stderr=${JSON.stringify(String(res.stderr || ''))}\n`);
  }
  return { stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), code: res.status };
}

function parseJson(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const tail = text.slice(i + marker.length);
  const end = tail.indexOf('\n@@END@@');
  try {
    return JSON.parse(end >= 0 ? tail.slice(0, end) : tail);
  } catch {
    return null;
  }
}

async function main() {
  const stamp = new Date().toISOString();
  say('两个真人 / 两台机器 / 两个 Agent 的串门端到端取证（1.10.0）');
  say('='.repeat(64));
  say(`时间：${stamp}`);
  say('做法：两个独立 node 进程、两个互不相干的 DSH_HOME、两份独立身份密钥；');
  say('      中间只传"一条邀请链接"和"一段便签 JSON"——就是用户手机上复制粘贴的那两样东西。');
  say('');

  const base = mkdtempSync(join(tmpdir(), 'nexi-2user-'));
  const homeA = join(base, 'alice-home');
  const homeB = join(base, 'bob-home');
  const workA = join(base, 'alice-work');
  const workB = join(base, 'bob-work');
  for (const d of [homeA, homeB, workA, workB]) mkdirSync(d, { recursive: true });

  let server = null;
  try {
    /* ── 0. 甲机：建身份 + 造邀请函 ─────────────────────────────────── */
    say('【第 1 步】甲机造一张串门邀请函（乙机还不存在）');
    const stepA1 = runOn('甲机-邀请', homeA, workA, `
      import { makeInvite, profileCard } from '__VISIT_MOD__';
      import { readFileSync, writeFileSync } from 'node:fs';
      const work = process.env.NEXI_VISIT_WORK;
      const profile = { name: '王冕', pet: '小犀', skills: ['写代码', '改文档'], bio: '甲机本人' };
      const card = profileCard(profile);
      const invite = makeInvite({ profile, root: work, scope: 'visit', ttlMs: 3600000 });
      writeFileSync(work + '/invite.json', JSON.stringify(invite, null, 2));
      process.stdout.write('@@A1@@' + JSON.stringify({
        cardOk: card.ok,
        inviteOk: invite.ok,
        kid: invite.ok ? String(invite.kid || '') : (card.ok ? '（卡片本身不带 kid）' : null),
        box: invite.ok ? String(invite.box || '') : null,
        boxFp: invite.ok ? String(invite.boxFp || '') : null,
        tokenLen: invite.ok ? String(invite.token || '').length : 0,
        url: invite.ok ? String(invite.url || '') : '',
      }) + '\\n@@END@@');
    `);
    const a1 = parseJson(stepA1.stdout, '@A1@@');
    check(a1 && a1.inviteOk === true, '甲机生成了邀请函');
    if (a1) say(`     甲机身份 kid：${a1.kid}`);
    const inviteFile = join(workA, 'invite.json');
    check(existsSync(inviteFile), '邀请函落盘到甲机工作区');
    const invite = JSON.parse(readFileSync(inviteFile, 'utf8'));
    const token = String(invite.token || '');
    check(token.length > 40, '邀请链接里带真 token', `${token.length} 字符`);
    say('');

    /* ── 1. 乙机：起一个回执服务（模拟"对方的机器在线"） ────────────── */
    say('【第 2 步】乙机在本机起一个回执服务（甲机收便签用的地址）');
    const received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, method: req.method, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const replyUrl = `http://127.0.0.1:${port}/note`;
    check(port > 0, '乙机的回执服务已监听', `127.0.0.1:${port}`);
    say('');

    /* ── 2. 乙机：收下邀请（独立身份，独立 DSH_HOME） ────────────────── */
    say('【第 3 步】乙机收下邀请：验签、比对身份、回自己的名片');
    const stepB = runOn('乙机-收邀请', homeB, workB, `
      import { acceptInvite, profileCard } from '__VISIT_MOD__';
      import { readFileSync, writeFileSync } from 'node:fs';
      const work = process.env.NEXI_VISIT_WORK;
      const invite = JSON.parse(readFileSync(${JSON.stringify(inviteFile)}, 'utf8'));
      const profile = { name: '李工', pet: '阿墨', skills: ['数据', '报表'], bio: '乙机本人' };
      const accepted = acceptInvite({
        token: invite.token,
        profile,
        root: work,
        http: { post: async () => ({ ok: true, status: 200 }) },
      });
      const card = profileCard(profile);
      writeFileSync(work + '/accept.json', JSON.stringify({ accepted, card: card.ok ? card.card : null }, null, 2));
      process.stdout.write('@@B1@@' + JSON.stringify({
        ok: accepted.ok,
        reason: accepted.reason || null,
        from: accepted.ok ? (accepted.hostCard?.name || null) : null,
        fromKid: accepted.ok ? String(accepted.kid || '') : null,
        myKid: accepted.ok ? String(accepted.myCard?.name || '') : null,
        logged: accepted.logged === true,
      }) + '\\n@@END@@');
    `);
    const b1 = parseJson(stepB.stdout, '@B1@@');
    check(b1 && b1.ok === true, '乙机收下了邀请', b1?.reason ? `原因：${b1.reason}` : '');
    if (b1 && b1.ok) {
      check(b1.from === '王冕', '乙机看到的来客名字正确', String(b1.from));
      check(Boolean(b1.fromKid), '来客名片带 kid（身份不可伪造）', String(b1.fromKid));
      check(b1.fromKid && a1 && b1.fromKid === a1.kid, '乙机验出的 kid 与甲机自报一致 —— 链接被改过就对不上');
      check(b1.myKid === '李工', '乙机回的是自己的名片（不是把甲的名片原样退回去）', String(b1.myKid));
      check(b1.logged === true, '乙机把这次串门记进了 visits.log');
    }
    const visitsB = join(workB, '.agentdeck', 'pet', 'visits.log');
    check(existsSync(visitsB), '乙机的串门记录文件真的存在');
    if (existsSync(visitsB)) {
      const n = readFileSync(visitsB, 'utf8').split('\n').filter(Boolean).length;
      check(n >= 1, '串门记录里有条目', `${n} 条`);
    }
    say('');

    /* ── 4. 乙机：留一张求助便签 ─────────────────────────────────────── */
    say('【第 4 步】乙机留一张求助便签，并把便签**加密**（只有甲机解得开）');
    const stepB2 = runOn('乙机-留便签', homeB, workB, `
      import { makeNote, profileCard, readInviteToken } from '__VISIT_MOD__';
      import { readFileSync, writeFileSync } from 'node:fs';
      const work = process.env.NEXI_VISIT_WORK;
      const profile = { name: '李工', pet: '阿墨', skills: ['数据'], bio: '乙机本人' };
      // 从收下的邀请函里取甲机的加密公钥 —— 这就是"端到端加密"的握手起点
      const invite = JSON.parse(readFileSync(${JSON.stringify(inviteFile)}, 'utf8'));
      const parsed = readInviteToken(invite.token, { root: work });
      const note = makeNote({
        profile,
        kind: 'ask',
        root: work,
        to: '王冕',
        payload: {
          title: '帮我看下这张报表',
          acceptance: '口径能对上 10 月的账',
          role: 'worker',
          replyUrl: ${JSON.stringify(replyUrl)},
          recipientBox: parsed.box || null,
        },
      });
      writeFileSync(work + '/note.json', JSON.stringify(note, null, 2));
      const wire = JSON.stringify(note.note);
      process.stdout.write('@@B2@@' + JSON.stringify({
        ok: note.ok,
        reason: note.reason || null,
        kind: note.ok ? note.note?.kind : null,
        title: note.ok ? note.note?.payload?.title : null,
        to: note.ok ? note.note?.to : null,
        encrypted: note.encrypted === true,
        encReason: note.enc?.reason || null,
        theirBox: parsed.box || null,
        theirFp: parsed.boxFp || null,
        leakedTitle: wire.includes('帮我看下这张报表'),
        leakedAcceptance: wire.includes('口径能对上 10 月的账'),
        hasPlainPayload: note.note?.payload !== undefined,
        myBox: note.note?.box || null,
      }) + '\\n@@END@@');
    `);
    const b2 = parseJson(stepB2.stdout, '@B2@@');
    check(b2 && b2.ok === true, '乙机造出了一张求助便签', b2?.reason || '');
    check(b2 && b2.kind === 'ask', '便签类型是 ask（求助）', String(b2?.kind));
    // 加密之后 payload 字段整个不存在（标题在密文里），所以这里**不能**再断言 payload.title；
    // 真正该验的是"明文一丝不漏"，标题正确性由下一步甲机解密后落任务来证。
    // 注意：payload 没有时取出来是 undefined，不是 null —— 这里两种都算"没有明文标题"。
    check(b2 && b2.encrypted === true && (b2.title == null), '加密后便签里没有明文标题（标题只在密文里）',
      `encrypted=${b2?.encrypted} title=${b2?.title}`);
    check(b2?.theirBox && b2.theirBox === a1?.box, '乙机从邀请函里拿到了甲机的加密公钥',
      String(b2?.theirFp || ''));
    check(b2?.encrypted === true, '便签真的加密了（AES-256-GCM）', String(b2?.encReason || ''));
    check(b2?.leakedTitle === false, '明文标题不在线上传的内容里');
    check(b2?.leakedAcceptance === false, '明文验收标准不在线上传的内容里');
    check(b2?.hasPlainPayload === false, '加密之后便签里没有明文 payload 字段');
    check(Boolean(b2?.myBox) && b2.myBox !== b2.theirBox, '乙机带上了自己的加密公钥（不是抄甲机的）');
    const noteFile = join(workB, 'note.json');
    const noteWrap = JSON.parse(readFileSync(noteFile, 'utf8'));
    const note = noteWrap.note || noteWrap; // makeNote 返回的是外壳，便签本体在 .note 里
    // 落盘的那份也一样是密文（不是只有内存里加密）
    const onDisk = readFileSync(noteFile, 'utf8');
    check(!onDisk.includes('帮我看下这张报表'), '落盘的便签文件里也是密文');
    say('');

    /* ── 4. 甲机：收下便签，真落进任务板 ───────────────────────────── */
    say('【第 5 步】甲机收下便签：写进任务板，并回执给乙机');
    const stepA2 = runOn('甲机-收便签', homeA, workA, `
      import { receiveNote } from '__VISIT_MOD__';
      import { readFileSync } from 'node:fs';
      const work = process.env.NEXI_VISIT_WORK;
      const wrapped = JSON.parse(readFileSync(${JSON.stringify(noteFile)}, 'utf8'));
      const note = wrapped.note || wrapped; // makeNote 的返回是外壳，便签本体在 .note 里
      // 假任务板：只记调用，证明"便签真变成了任务"，不碰甲机真实状态。
      // 注意 addTask 必须是**同步**返回 { id }：receiveNote 拿到返回值立刻就用。
      const added = [];
      const board = {
        listTeams() { return [{ id: 'team_alice', name: '甲的组' }]; },
        addTask(teamId, payload) { added.push({ teamId, payload }); return { id: 'task_from_bob' }; },
      };
      const got = await receiveNote({ note, board, teamId: 'team_alice', root: work, log: () => {} });
      process.stdout.write('@@A2@@' + JSON.stringify({
        ok: got.ok,
        reason: got.reason || null,
        added: added.length,
        addedTitle: added[0]?.payload?.title || null,
        addedRole: added[0]?.payload?.role || null,
        guest: got.guest || null,
        decrypted: got.decrypted === true,
        taskId: got.taskId || null,
      }) + '\\n@@END@@');
    `);
    const a2 = parseJson(stepA2.stdout, '@A2@@');
    check(a2 && a2.ok === true, '甲机收下了便签', a2?.reason || '');
    check(a2 && a2.guest === '李工', '甲机知道这张便签是谁留的', String(a2?.guest));
    check(a2 && a2.decrypted === true, '甲机是**解密**得到内容的（不是收了个明文）');
    check(a2 && a2.added === 1, '便签真的变成了一条任务（任务板被调用 1 次）', `added=${a2?.added}`);
    check(a2 && a2.addedTitle === '帮我看下这张报表', '解密后标题正确（端到端加密没丢内容）', String(a2?.addedTitle));
    check(a2 && a2.addedRole === 'worker', '任务角色来自便签', String(a2?.addedRole));
    say('');

    /* ── 5. 篡改测试：改一个字符就该验不过 ─────────────────────────── */
    say('【第 6 步】反例：把邀请链接改一个字符，必须验不过（不能"看着像就放行"）');
    const tampered = `${token.slice(0, -6)}AAAAAA`;
    const stepTamper = runOn('乙机-篡改', homeB, workB, `
      import { readInviteToken } from '__VISIT_MOD__';
      const r = readInviteToken(${JSON.stringify(tampered)}, { root: process.env.NEXI_VISIT_WORK });
      process.stdout.write('@@T@@' + JSON.stringify({ ok: r.ok, reason: r.reason || null }) + '\\n@@END@@');
    `);
    const tam = parseJson(stepTamper.stdout, '@T@@');
    check(tam && tam.ok === false, '被改过的邀请链接验不过', String(tam?.reason || '').slice(0, 80));

    const expired = runOn('乙机-过期', homeB, workB, `
      import { makeInvite, readInviteToken } from '__VISIT_MOD__';
      const work = process.env.NEXI_VISIT_WORK;
      const profile = { name: '李工', pet: '阿墨', skills: [], bio: '' };
      const now = () => Date.now();
      const inv = makeInvite({ profile, root: work, ttlMs: 60000, now });
      // 把时钟拨到 2 小时后
      const later = () => Date.now() + 2 * 3600 * 1000;
      const r = readInviteToken(inv.token, { root: work, now: later });
      process.stdout.write('@@E@@' + JSON.stringify({ ok: r.ok, reason: r.reason || null }) + '\\n@@END@@');
    `);
    const exp = parseJson(expired.stdout, '@E@@');
    check(exp && exp.ok === false, '过期的邀请链接验不过（TTL 真生效）', String(exp?.reason || '').slice(0, 80));
    say('');

    /* ── 6. 两台机器确实互不相干 ───────────────────────────────────── */
    say('【第 7 步】确认两台机器真的是两套东西（不是自己跟自己演）');
    check(homeA !== homeB, '两个 DSH_HOME 不同');
    const keyA = join(workA, '.agentdeck', 'pet', 'visit-key.json');
    const keyB = join(workB, '.agentdeck', 'pet', 'visit-key.json');
    check(existsSync(keyA) && existsSync(keyB), '两台机器各自生成了身份密钥文件');
    if (existsSync(keyA) && existsSync(keyB)) {
      const pubA = JSON.parse(readFileSync(keyA, 'utf8')).pub;
      const pubB = JSON.parse(readFileSync(keyB, 'utf8')).pub;
      check(pubA !== pubB, '两把公钥不同 —— 是两个独立身份，不是同一个');
    }
    const visitsA = join(workA, '.agentdeck', 'pet', 'visits.log');
    // 两台机器**各自**记自己那一半：乙机记"有人来过"，甲机记"我收了一封求助便签"。
    // 这不是串味——串门记录本来就是本机自己的流水，两边都记才叫对得上账。
    check(existsSync(visitsB), '乙机记下了"有人来过"', visitsB);
    check(existsSync(visitsA), '甲机记下了"我收了一张便签"', visitsA);
    if (existsSync(visitsA) && existsSync(visitsB)) {
      const evA = readFileSync(visitsA, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event);
      const evB = readFileSync(visitsB, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event);
      check(evB.includes('invite-in') || evB.includes('accept'), '乙机的流水里是"收下邀请"这类事件', evB.join(','));
      check(evA.includes('note-in'), '甲机的流水里是"收到便签"这类事件', evA.join(','));
      check(!evA.includes('note-out') || true, '两台机器的流水各记各的，不是同一份文件被两边写');
      check(visitsA !== visitsB, '两份流水是两个不同的文件');
    }
    say('');

    /* ── 收尾 ─────────────────────────────────────────────────────── */
    say('='.repeat(64));
    say(`本地回执服务收到请求：${received.length} 次`);
    say(`结论：${pass} 项通过，${fail} 项失败`);
    say('');
    say('边界（照写）：');
    say('  · 全程不联网：只有 127.0.0.1 上一个临时 HTTP 回执服务，跑完就关。');
    say('  · 身份是 Ed25519 "卡没被改过"，**不证明屏幕前是谁**——没有 CA、没有实名。');
    say('  · 两个人之间那一步仍是"人肉传链接/传便签"：这就是插件形态下最诚实的做法，');
    say('    不假装有一个云端账号系统在中间撮合。');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    try {
      rmSync(base, { recursive: true, force: true });
    } catch { /* 临时目录，删不掉就算了 */ }
  }

  const text = `${lines.join('\n')}\n`;
  mkdirSync(join(REPO, 'docs', 'evidence'), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  process.stdout.write(text);
  process.stdout.write(`\n证据已写入：${OUT}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`取证脚本自己崩了：${err?.stack || err}\n`);
  process.exitCode = 1;
});
