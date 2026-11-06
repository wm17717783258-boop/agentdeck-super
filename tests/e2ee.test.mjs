/**
 * 1.10.0 私密串门端到端加密：邀请函带 X25519 公钥 → 协商共享密钥 → 便签正文走 AES-256-GCM。
 *
 * 为什么必须有：邀请链接和便签 JSON 都是要经过人手/微信传的。1.10.0 之前只有 Ed25519
 * **签名**（证明"没被改过"），正文是**明文**——路上谁看见谁能读。这条套件证明的是
 * "别人看不到"，而且失败方式必须是**明确拒收**，不许悄悄退化成当明文处理。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_PLAINTEXT_BYTES,
  aadOf,
  deriveSharedKey,
  fingerprint,
  loadBoxKey,
  openSealed,
  sameFingerprint,
  sealJson,
} from '../lib/pet/e2ee.js';
import { acceptInvite, makeInvite, makeNote, readInviteToken, receiveNote } from '../lib/pet/visit.js';
import { petTools } from '../lib/pet/index.js';

const PROFILE_A = { name: '王冕', pet: '小犀', skills: ['写代码'], bio: '甲机' };
const PROFILE_B = { name: '李工', pet: '阿墨', skills: ['数据'], bio: '乙机' };

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-e2ee-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** 假任务板：只记调用，不碰真实状态。addTask 必须是同步返回 {id}。 */
function fakeBoard() {
  const calls = [];
  return {
    calls,
    listTeams: () => [{ id: 'team_a' }],
    addTask(teamId, payload) {
      calls.push({ teamId, payload });
      return { id: `task_${calls.length}` };
    },
  };
}

/* ── 1. 密钥与协商 ─────────────────────────────────────────────────────── */

test('每台机器一把 X25519 身份：落盘、可复用、两台机器不共用', () => {
  const a = freshRoot('key-a');
  const b = freshRoot('key-b');
  try {
    const ka = loadBoxKey(a.root);
    assert.equal(ka.ok, true);
    assert.equal(ka.created, true, '第一次该是新生成的');
    assert.equal(ka.pub.length > 20, true);

    const again = loadBoxKey(a.root);
    assert.equal(again.existing, true, '第二次该读回同一把');
    assert.equal(again.pub, ka.pub, '公钥必须稳定（不然对方的密文全废）');

    const kb = loadBoxKey(b.root);
    assert.notEqual(kb.pub, ka.pub, '两台机器不能共用一把加密身份');

    // 私钥只在本机，公钥里不含私钥
    const file = JSON.parse(readFileSync(join(a.root, '.agentdeck', 'pet', 'box-key.json'), 'utf8'));
    assert.equal(file.alg, 'x25519');
    assert.ok(file.priv && file.priv !== file.pub);
    assert.equal(file.priv, ka.priv);
  } finally {
    a.done();
    b.done();
  }
});

test('双方协商出同一把 32 字节密钥；第三方协商出的是别的', () => {
  const a = freshRoot('dh-a');
  const b = freshRoot('dh-b');
  const c = freshRoot('dh-c');
  try {
    const ka = loadBoxKey(a.root);
    const kb = loadBoxKey(b.root);
    const kc = loadBoxKey(c.root);

    const ab = deriveSharedKey({ myPriv: ka.priv, theirPub: kb.pub });
    const ba = deriveSharedKey({ myPriv: kb.priv, theirPub: ka.pub });
    assert.equal(ab.length, 32);
    assert.ok(ab.equals(ba), '两边必须算出一模一样的密钥');

    const ca = deriveSharedKey({ myPriv: kc.priv, theirPub: ka.pub });
    assert.ok(!ca.equals(ab), '第三方不能算出同一把');

    // 公钥乱写要老实返回 null，不能抛
    assert.equal(deriveSharedKey({ myPriv: ka.priv, theirPub: '不是公钥' }), null);
    assert.equal(deriveSharedKey({ myPriv: 'bad', theirPub: kb.pub }), null);
    assert.equal(deriveSharedKey({}), null);
  } finally {
    a.done();
    b.done();
    c.done();
  }
});

/* ── 2. 封/解 本体 ─────────────────────────────────────────────────────── */

test('封了能解、换 AAD 解不开、错密钥解不开、密文被改解不开', () => {
  const a = freshRoot('seal-a');
  const b = freshRoot('seal-b');
  const c = freshRoot('seal-c');
  try {
    const ka = loadBoxKey(a.root);
    const kb = loadBoxKey(b.root);
    const kc = loadBoxKey(c.root);
    const key = deriveSharedKey({ myPriv: ka.priv, theirPub: kb.pub });
    const aad = aadOf({ id: 'note_1', kind: 'ask', fromKid: ka.pub, toKid: kb.pub });

    const sealed = sealJson({ title: '秘密标题', acceptance: '秘密验收' }, key, aad);
    assert.equal(sealed.ok, true);
    assert.equal(sealed.sealed.alg, 'aes-256-gcm');
    assert.ok(sealed.sealed.iv && sealed.sealed.ct && sealed.sealed.tag);

    // 正常解得开
    const ok = openSealed(sealed.sealed, key, aad);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value, { title: '秘密标题', acceptance: '秘密验收' });

    // 明文一个都不该出现在密文里
    const asText = JSON.stringify(sealed.sealed);
    assert.ok(!asText.includes('秘密标题'), '密文里不该出现明文标题');
    assert.ok(!asText.includes('秘密验收'), '密文里不该出现明文验收标准');

    // 换 AAD（等于有人把便签头改了）→ 解不开
    const wrongAad = openSealed(sealed.sealed, key, aadOf({ id: 'note_OTHER', kind: 'ask', fromKid: ka.pub, toKid: kb.pub }));
    assert.equal(wrongAad.ok, false);

    // 第三方密钥 → 解不开
    const cKey = deriveSharedKey({ myPriv: kc.priv, theirPub: ka.pub });
    assert.equal(openSealed(sealed.sealed, cKey, aad).ok, false);

    // 篡改密文 → 解不开（GCM 认证标签会拦住）
    const bitFlip = { ...sealed.sealed, ct: `${sealed.sealed.ct.slice(0, -2)}AA` };
    assert.equal(openSealed(bitFlip, key, aad).ok, false);
    const tagFlip = { ...sealed.sealed, tag: sealed.sealed.tag.split('').reverse().join('') };
    assert.equal(openSealed(tagFlip, key, aad).ok, false);
  } finally {
    a.done();
    b.done();
    c.done();
  }
});

test('openSealed 对任何垃圾输入都返回 ok:false，绝不抛异常', () => {
  const key = Buffer.alloc(32, 7);
  for (const junk of [null, undefined, 'string', 42, [], {}, { v: 99 }, { v: 1, alg: 'rot13' }, { v: 1, alg: 'aes-256-gcm' }]) {
    const r = openSealed(junk, key, '');
    assert.equal(r.ok, false, `垃圾输入 ${JSON.stringify(junk)} 不该成功`);
    assert.equal(typeof r.reason, 'string');
  }
  // 密钥长度不对也拒
  assert.equal(openSealed({ v: 1, alg: 'aes-256-gcm', iv: 'AA', ct: 'AA', tag: 'AA' }, Buffer.alloc(16), '').ok, false);
});

test('正文超上限直接拒（不给"巨型密文撑爆接收方"留口子）', () => {
  const key = Buffer.alloc(32, 3);
  const huge = { text: 'x'.repeat(MAX_PLAINTEXT_BYTES + 100) };
  const r = sealJson(huge, key, '');
  assert.equal(r.ok, false);
  assert.match(r.reason, /太大/);
});

/* ── 3. 指纹 ───────────────────────────────────────────────────────────── */

test('指纹稳定、双方一样、不同公钥不一样', () => {
  const a = freshRoot('fp-a');
  const b = freshRoot('fp-b');
  try {
    const ka = loadBoxKey(a.root);
    const kb = loadBoxKey(b.root);
    const fa1 = fingerprint(ka.pub);
    const fa2 = fingerprint(ka.pub);
    assert.equal(fa1, fa2, '同一个公钥指纹必须稳定');
    assert.equal(fa1.length, 8);
    assert.notEqual(fingerprint(kb.pub), fa1);
    assert.equal(sameFingerprint(fa1, fa1), true);
    assert.equal(sameFingerprint(fa1, fingerprint(kb.pub)), false);
    assert.equal(sameFingerprint('', ''), false, '空指纹不算相等');
    assert.equal(fingerprint(''), '');
  } finally {
    a.done();
    b.done();
  }
});

/* ── 4. 整条链路：邀请 → 密文便签 → 收下解密 ──────────────────────────── */

test('端到端：邀请函带加密公钥，便签真加密，对方真解得开并落任务', () => {
  const a = freshRoot('full-a');
  const b = freshRoot('full-b');
  try {
    // 甲机发邀请
    const invite = makeInvite({ profile: PROFILE_A, root: a.root, scope: 'visit', ttlMs: 3600000 });
    assert.equal(invite.ok, true);
    assert.ok(invite.box, '邀请函必须带上加密公钥');
    assert.ok(invite.boxFp, '还要带指纹，方便人眼比对');

    // 邀请函令牌里真的带着 box（不是只在返回值里）
    const read = readInviteToken(invite.token, { root: b.root });
    assert.equal(read.ok, true);
    assert.equal(read.box, invite.box, 'box 必须进令牌本体');
    assert.equal(read.boxFp, invite.boxFp, '指纹也要进令牌');

    // 乙机收下邀请，拿到甲机的 box
    const accepted = acceptInvite({
      token: invite.token,
      profile: PROFILE_B,
      root: b.root,
      http: { post: async () => ({ ok: true, status: 200 }) },
    });
    assert.equal(accepted.ok, true);

    // 乙机造一张**密文**求助便签，收件人是甲机
    const made = makeNote({
      profile: PROFILE_B,
      kind: 'ask',
      root: b.root,
      to: '王冕',
      payload: {
        title: '这份报表的口径对不上',
        acceptance: '10 月的账能对上',
        role: 'worker',
        recipientBox: invite.box,
      },
    });
    assert.equal(made.ok, true);
    assert.equal(made.encrypted, true, '给了对方公钥就该真加密');
    assert.ok(made.note.enc, '便签里必须有密文字段');
    assert.equal(made.note.payload, undefined, '加密之后不许再带明文 payload');

    // 明文一个字都不该在便签里
    const wire = JSON.stringify(made.note);
    assert.ok(!wire.includes('这份报表的口径对不上'), '线上传的便签里不该出现明文标题');
    assert.ok(!wire.includes('10 月的账能对上'), '线上传的便签里不该出现明文验收标准');
    assert.ok(made.note.box, '发件人公钥要带上，否则对方协商不了');
    assert.ok(made.note.toBox, '收件人公钥要带上，明确这是给谁的');

    // 甲机收下：真解开、真落任务
    const board = fakeBoard();
    const got = receiveNote({ note: made.note, board, teamId: 'team_a', root: a.root });
    assert.equal(got.ok, true, `甲机没解开：${got.reason || ''}`);
    assert.equal(got.decrypted, true, '要如实报告"这是解密来的"');
    assert.equal(board.calls.length, 1);
    assert.equal(board.calls[0].payload.title, '这份报表的口径对不上');
    assert.equal(board.calls[0].payload.acceptance, '10 月的账能对上');
    assert.equal(got.guest, '李工');
  } finally {
    a.done();
    b.done();
  }
});

/* ── 5. 失败方式必须是"明确拒收" ───────────────────────────────────────── */

test('密文便签：本机没有对应密钥 → 明确拒收，绝不退化成当明文处理', () => {
  const a = freshRoot('fail-a');
  const b = freshRoot('fail-b');
  const c = freshRoot('fail-c');
  try {
    const invite = makeInvite({ profile: PROFILE_A, root: a.root, scope: 'visit', ttlMs: 3600000 });
    const made = makeNote({
      profile: PROFILE_B, kind: 'ask', root: b.root, to: '王冕',
      payload: { title: '机密标题', role: 'worker', recipientBox: invite.box },
    });
    assert.equal(made.encrypted, true);

    // 丙机（第三方）收到这张便签：没参与过协商，本机也没建过加密身份 → 明确拒收
    const board = fakeBoard();
    const cGot = receiveNote({ note: made.note, board, teamId: 'team_a', root: c.root });
    assert.equal(cGot.ok, false, '第三方不该解得开');
    assert.equal(cGot.code, 'no_box_key', '第三方连密钥都没有，该说清楚是"没有密钥"');
    assert.equal(board.calls.length, 0, '解不开就一条任务都不许落');

    // 本机根本没身份密钥：也要明确说清楚，而不是崩
    const bare = freshRoot('fail-bare');
    try {
      const bareGot = receiveNote({ note: made.note, board, teamId: 'team_a', root: bare.root });
      assert.equal(bareGot.ok, false);
      assert.equal(bareGot.code, 'no_box_key');
      assert.equal(board.calls.length, 0);
    } finally {
      bare.done();
    }

    // 改了密文再发：解不开
    const tampered = { ...made.note, enc: { ...made.note.enc, ct: `${made.note.enc.ct.slice(0, -2)}ZZ` } };
    const tGot = receiveNote({ note: tampered, board, teamId: 'team_a', root: a.root });
    assert.equal(tGot.ok, false);
    assert.equal(board.calls.length, 0);
    // 把 id 改了（AAD 会变）：解不开
    const idChanged = { ...made.note, id: 'note_forged' };
    const iGot = receiveNote({ note: idChanged, board, teamId: 'team_a', root: a.root });
    assert.equal(iGot.ok, false);
    assert.equal(board.calls.length, 0);

    // 密文便签但没带 box：明确拒，不是猜
    const noBox = { ...made.note };
    delete noBox.box;
    const nGot = receiveNote({ note: noBox, board, teamId: 'team_a', root: a.root });
    assert.equal(nGot.ok, false);
    assert.match(nGot.reason, /没带发件人的加密公钥/);
  } finally {
    a.done();
    b.done();
    c.done();
  }
});

test('第三方有密钥但密钥不对：报 cannot_decrypt，且一条任务都不落', () => {
  const a = freshRoot('wrong-a');
  const b = freshRoot('wrong-b');
  const c = freshRoot('wrong-c');
  try {
    const invite = makeInvite({ profile: PROFILE_A, root: a.root, scope: 'visit', ttlMs: 3600000 });
    const made = makeNote({
      profile: PROFILE_B, kind: 'ask', root: b.root, to: '王冕',
      payload: { title: '只给甲的机密', role: 'worker', recipientBox: invite.box },
    });
    assert.equal(made.encrypted, true);

    // 丙机先建好自己的加密身份（所以它有 box-key，不会走 no_box_key 那条）
    const kc = loadBoxKey(c.root);
    assert.equal(kc.ok, true, '丙机得先有身份，这条才测的是"密钥不对"');

    const board = fakeBoard();
    const cGot = receiveNote({ note: made.note, board, teamId: 'team_a', root: c.root });
    assert.equal(cGot.ok, false, '密钥不对就该解不开');
    assert.equal(cGot.code, 'cannot_decrypt', `该报 cannot_decrypt，实际 ${cGot.code}`);
    assert.match(cGot.reason, /解不开/);
    assert.equal(board.calls.length, 0, '解不开时一条任务都不许落');

    // 而且不能泄漏任何明文（报错里也不许带标题）
    assert.ok(!JSON.stringify(cGot).includes('只给甲的机密'), '报错里不该泄漏明文标题');
  } finally {
    a.done();
    b.done();
    c.done();
  }
});

/* ── 6. 兼容：老明文便签照样收 ────────────────────────────────────────── */

test('没给 recipientBox 就是明文便签（明确标注），老明文便签照样收得下', () => {
  const a = freshRoot('plain-a');
  try {
    // 不给 recipientBox → 明文，但要如实说明原因
    const made = makeNote({
      profile: PROFILE_A, kind: 'ask', root: a.root, to: '李工',
      payload: { title: '明文求助', role: 'worker' },
    });
    assert.equal(made.ok, true);
    assert.equal(made.encrypted, false);
    assert.equal(made.enc.encrypted, false);
    assert.match(made.enc.reason, /recipientBox/);
    assert.ok(made.note.payload, '明文便签当然要带 payload');
    assert.equal(made.note.enc, undefined);

    // 收下明文便签：照常落任务，decrypted=false
    const board = fakeBoard();
    const got = receiveNote({ note: made.note, board, teamId: 'team_a', root: a.root });
    assert.equal(got.ok, true);
    assert.equal(got.decrypted, false);
    assert.equal(board.calls[0].payload.title, '明文求助');

    // 手写一张 v1 老便签（连 box 字段都没有）：也要收得下
    const board2 = fakeBoard();
    const legacy = {
      v: 1, kind: 'ask', id: 'note_legacy', from: { name: '老王' },
      at: new Date().toISOString(), to: '李工',
      payload: { title: '一年前的便签', role: 'worker' },
    };
    const got2 = receiveNote({ note: legacy, board: board2, teamId: 'team_a', root: a.root });
    assert.equal(got2.ok, true, `老明文便签该照收：${got2.reason || ''}`);
    assert.equal(board2.calls[0].payload.title, '一年前的便签');
  } finally {
    a.done();
  }
});

test('对方公钥是垃圾时：如实说明没加密，而不是崩或假装加密', () => {
  const a = freshRoot('badbox');
  try {
    const made = makeNote({
      profile: PROFILE_A, kind: 'ask', root: a.root,
      payload: { title: '试试', role: 'worker', recipientBox: '这不是公钥' },
    });
    assert.equal(made.ok, true);
    assert.equal(made.encrypted, false, '协商不出来就不该硬说加密了');
    assert.match(made.enc.reason, /不合法|协商不出/);
    assert.ok(made.note.payload, '退化成明文时要照常带 payload，否则便签就废了');
  } finally {
    a.done();
  }
});

/* ── 7. 落盘痕迹 ───────────────────────────────────────────────────────── */

test('串门流水里记下"这条是加密的"，事后查得出来', () => {
  const a = freshRoot('log-a');
  const b = freshRoot('log-b');
  try {
    const invite = makeInvite({ profile: PROFILE_A, root: a.root, scope: 'visit', ttlMs: 3600000 });
    makeNote({
      profile: PROFILE_B, kind: 'ask', root: b.root, to: '王冕',
      payload: { title: '带标记的', role: 'worker', recipientBox: invite.box },
    });
    const logFile = join(b.root, '.agentdeck', 'pet', 'visits.log');
    const rows = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const out = rows.find((r) => r.event === 'note-out');
    assert.ok(out, '没记下这条便签的流水');
    assert.equal(out.encrypted, true, '流水里要标明这是加密便签');

    // 明文那条要标 false，不能一律写 true
    makeNote({ profile: PROFILE_B, kind: 'ask', root: b.root, payload: { title: '明文的', role: 'worker' } });
    const rows2 = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const outs = rows2.filter((r) => r.event === 'note-out');
    assert.equal(outs.length, 2);
    assert.equal(outs[1].encrypted, false);
  } finally {
    a.done();
    b.done();
  }
});

/* ── 8. 工具层：模型真的能用上加密 ─────────────────────────────────────── */

test('pet_visit 工具层：accept 给出 box，ask 带 box 出密文，receive 解得开', async () => {
  const a = freshRoot('tool-a');
  const b = freshRoot('tool-b');
  try {
    // 甲机：造邀请（工具层）
    const toolA = petTools({ root: () => a.root, pet: { name: '王冕', pet: '小犀' } })
      .find((t) => t.name === 'pet_visit');
    const toolB = petTools({ root: () => b.root, pet: { name: '李工', pet: '阿墨' } })
      .find((t) => t.name === 'pet_visit');
    assert.ok(toolA && toolB, 'pet_visit 没注册');
    assert.ok(toolA.parameters.properties.box, '工具参数里要有 box');

    const invText = String((await toolA.execute({ action: 'invite', ttlHours: 2 }, {}))?.text);
    assert.match(invText, /加密公钥/, 'invite 输出里要告诉人加密公钥');
    const token = (invText.match(/dsh:\/\/agentdeck\/visit\?t=([^\s\`]+)/) || [])[1];
    assert.ok(token, 'invite 该给出链接');

    // 乙机：收下邀请（工具层）→ 输出里带 box
    const accText = String((await toolB.execute({ action: 'accept', token }, {}))?.text);
    assert.match(accText, /加密：对方给了便签加密公钥/, `accept 输出该提示加密公钥：${accText.slice(0, 300)}`);
    const box = (accText.match(/box="([^"]+)"/) || [])[1];
    assert.ok(box, 'accept 输出里要能直接抄到 box 值');

    // 乙机：造一张带 box 的求助便签（工具层）→ 输出说已加密
    const askText = String((await toolB.execute({ action: 'ask', title: '机密求助', box }, {}))?.text);
    assert.match(askText, /已加密：AES-256-GCM/, `ask 该说已加密：${askText.slice(0, 300)}`);
    assert.doesNotMatch(askText, /这是明文/, '不该同时说是明文');
    // 明文标题不该出现在线上传的那段 JSON 里
    const jsonPart = askText.slice(askText.indexOf('```json'));
    assert.ok(!jsonPart.includes('机密求助'), '工具输出的 JSON 里不该出现明文标题');

    // 甲机：收下（工具层）→ 说清是解密来的
    // 注意：要取 ```json 围栏**内部**那一段，不能从头找第一个 '{'（围栏标记后面还有别的花括号）
    const fenced = askText.slice(askText.indexOf('```json') + '```json'.length);
    const bodyJson = fenced.slice(fenced.indexOf('{'), fenced.indexOf('\n```'));
    const noteJson = JSON.parse(bodyJson);
    const boardCalls = [];
    const toolA2 = petTools({
      root: () => a.root,
      pet: { name: '王冕', pet: '小犀' },
      board: {
        listTeams: () => [{ id: 'team_x' }],
        addTask(teamId, payload) { boardCalls.push({ teamId, payload }); return { id: 'task_from_b' }; },
      },
    }).find((t) => t.name === 'pet_visit');

    const recvText = String((await toolA2.execute({ action: 'receive', note: noteJson, teamId: 'team_x' }, {}))?.text);
    assert.match(recvText, /加密便签，已在本机解密/, `receive 该说清是解密来的：${recvText}`);
    assert.match(recvText, /task_from_b/);
    assert.equal(boardCalls.length, 1);
    assert.equal(boardCalls[0].payload.title, '机密求助', '解密后标题要正确落进任务板');
  } finally {
    a.done();
    b.done();
  }
});

test('pet_visit 工具层：解不开时说清是加密便签、不让明文退化成静默成功', async () => {
  const a = freshRoot('toolfail-a');
  const b = freshRoot('toolfail-b');
  const c = freshRoot('toolfail-c');
  try {
    const toolA = petTools({ root: () => a.root, pet: { name: '王冕', pet: '小犀' } }).find((t) => t.name === 'pet_visit');
    const toolB = petTools({ root: () => b.root, pet: { name: '李工', pet: '阿墨' } }).find((t) => t.name === 'pet_visit');
    const invText = String((await toolA.execute({ action: 'invite' }, {}))?.text);
    const token = (invText.match(/dsh:\/\/agentdeck\/visit\?t=([^\s\`]+)/) || [])[1];
    const accText = String((await toolB.execute({ action: 'accept', token }, {}))?.text);
    const box = (accText.match(/box="([^"]+)"/) || [])[1];
    const askText = String((await toolB.execute({ action: 'ask', title: '不该被外人看到', box }, {}))?.text);
    const noteJson = JSON.parse(askText.slice(askText.indexOf('```json')).replace('```json', '').split('```')[0].trim());

    // 丙机（没密钥）收：明确拒
    const calls = [];
    const toolC = petTools({
      root: () => c.root,
      pet: { name: '路人', pet: '小白' },
      board: { listTeams: () => [{ id: 'team_z' }], addTask(t, p) { calls.push(p); return { id: 'x' }; } },
    }).find((t) => t.name === 'pet_visit');
    const cText = String((await toolC.execute({ action: 'receive', note: noteJson, teamId: 'team_z' }, {}))?.text);
    assert.match(cText, /加密便签，本机没能解开/, `该明说是加密便签解不开：${cText}`);
    assert.equal(calls.length, 0, '解不开不许落任务');
    assert.ok(!cText.includes('不该被外人看到'), '失败文案里不该泄漏明文');
  } finally {
    a.done();
    b.done();
    c.done();
  }
});
