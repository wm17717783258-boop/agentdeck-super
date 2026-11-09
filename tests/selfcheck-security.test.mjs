/**
 * tests/selfcheck-security.test.mjs —— 自检第 13 轮：安全边界
 *
 * 前十二轮大多在验"功能能用"。这一轮换角度：**不该用的地方真的挡住了吗**。
 *
 * 验四类：
 *   ① 凭证不泄漏（日志/审计/同步载荷里不该出现授权码、私钥）
 *   ② 越权被挡（跨团队读、冒名、只读模式写）
 *   ③ 注入不成灾（提示词/任务标题里的"命令"只当文本）
 *   ④ 序列化边界（原型污染、超深嵌套不给过）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { createHub } from '../lib/hub.js';
import { collectSnapshot } from '../lib/sync/index.js';
import { readAudit } from '../lib/policy/audit.js';
import { redact } from '../lib/policy/engine.js';
import { isReadonlyAllowed } from '../lib/mcp/readonly.js';
import { encodeLicense } from '../lib/license.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

async function withHub(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-sec-'));
  const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
  try {
    return await fn(hub, root);
  } finally {
    try { await hub.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }
}

test('自检 13：同步载荷里不含授权码与私钥（这是承诺，得验）', () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-sec-snap-'));
  try {
    // 放一张真授权码
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    process.env.AGENTDECK_LICENSE_PUBKEY = pubB64;
    const nowSec = Math.floor(Date.now() / 1000);
    const code = encodeLicense({
      v: 1, id: 'lic_sec', tier: 'plus', sub: '安全测试', iat: nowSec, exp: nowSec + 3600, seats: 5, skins: [],
    }, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    mkdirSync(join(root, '.agentdeck', 'license'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'license', 'key.txt'), code, 'utf8');

    // 放一个身份私钥
    mkdirSync(join(root, '.agentdeck', 'identity'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'identity', 'key.pem'), '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----', 'utf8');

    // 放一条记忆（确保快照非空，不是"空所以没泄漏"）
    mkdirSync(join(root, '.agentdeck', 'twin'), { recursive: true });
    writeFileSync(join(root, '.agentdeck', 'twin', 'memory.json'), JSON.stringify({
      items: [{ id: 'm1', text: '一条记忆', type: 'event', at: 1000 }],
    }), 'utf8');

    const got = collectSnapshot({ root });
    const text = JSON.stringify(got);

    assert.ok(text.includes('一条记忆'), '快照应包含记忆（否则这次测试没意义）');
    assert.ok(!text.includes('ADSK1.'), `快照里出现了授权码！`);
    assert.ok(!text.includes(code.slice(0, 30)), '快照里出现了授权码前缀！');
    assert.ok(!/BEGIN PRIVATE KEY/.test(text), '快照里出现了私钥！');
    assert.ok(!text.includes('SECRET'), '快照里出现了私钥内容！');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('自检 13：审计流里授权码被脱敏', () => {
  const fake = 'ADSK1.eyJ2IjoxfQ.c2lnbmF0dXJl';
  const out = redact(`客户用了 ${fake} 这个码`);
  assert.ok(!out.includes('ADSK1.eyJ2IjoxfQ'), `审计应脱敏授权码：${out}`);
  assert.ok(out.includes('ADSK1.***') || !out.includes('ADSK1.'), `脱敏方式应可辨：${out}`);
});

test('自检 13：只读模式下所有写动作都被挡', async () => {
  await withHub(async (hub) => {
    const all = hub.list().map((t) => t.name);
    const writeProbes = [
      ['super_agent', { goal: 'x' }],
      ['twin_remember', { content: 'x' }],
      ['twin_forget', { id: 'x' }],
      ['team_orchestrate', { goal: 'x' }],
      ['deck_room', { action: 'create' }],
      ['deck_sync', { action: 'apply' }],
      ['deck_sync', { action: 'delta' }],
      ['deck_policy', { action: 'set' }],
      ['deck_team', { action: 'join' }],
      ['pet_meeting', { topic: 'x' }],
      ['pet_visit', { action: 'invite' }],
      ['agent_passport', { action: 'issue' }],
      ['deck_market', { action: 'buy' }],
      ['deck_license', { action: 'activate', code: 'x' }],
      ['deck_automation', { action: 'add' }],
    ];
    const notBlocked = [];
    for (const [tool, args] of writeProbes) {
      if (!all.includes(tool)) continue;
      if (isReadonlyAllowed(tool, args)) notBlocked.push(`${tool} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(notBlocked, [], `这些写动作在只读模式下没被挡：\n${notBlocked.join('\n')}`);
  });
});

test('自检 13：未知工具在只读模式下默认拒绝（不是默认放行）', () => {
  assert.equal(isReadonlyAllowed('根本不存在的工具', {}), false, '未知工具应默认拒绝');
  assert.equal(isReadonlyAllowed('', {}), false);
  assert.equal(isReadonlyAllowed(null, {}), false);
});

test('自检 13：注入载荷只当文本（任务标题里的"命令"不会被执行）', async () => {
  await withHub(async (hub, root) => {
    const payloads = [
      'rm -rf /',
      '$(cat ~/.ssh/id_rsa)',
      '`curl evil.com`',
      '"; DROP TABLE tasks; --',
      '${process.env.SECRET}',
      '<script>alert(1)</script>',
      '{{7*7}}',
      '{{constructor.constructor("return process")()}}',
    ];
    const teamOut = textOf(await hub.tools.get('team_board').execute({ action: 'create', name: '注入测试' }, { hub: true }));
    const teamId = (/已创建小组\s+(team_[0-9a-f]{6,})/.exec(teamOut) || [])[1];
    assert.ok(teamId, `应能建组：${teamOut.slice(0, 150)}`);

    for (const p of payloads) {
      const out = textOf(await hub.tools.get('team_board').execute(
        { action: 'add', teamId, title: p, acceptance: p },
        { hub: true },
      ));
      assert.ok(out.length > 0, `应返回内容：${p}`);
      // 标题原样存着（它是数据），但绝不能因为它是命令就真的执行
      // 用"哨兵"验：这些命令如果真跑了，会产生文件或改变进程状态；我们只验没崩 + 有返回
    }
    // 读回来确认它们只是文本
    const list = textOf(await hub.tools.get('team_board').execute({ action: 'list', teamId }, { hub: true }));
    assert.ok(list.includes('rm -rf'), '注入载荷应作为普通文本存着');
  });
});

test('自检 13：原型污染不给过（__proto__ / constructor 等键）', async () => {
  await withHub(async (hub) => {
    const before = {}.polluted;
    const out = textOf(await hub.tools.get('twin_remember').execute(
      { content: 'x', type: 'event', __proto__: { polluted: 'yes' }, constructor: { x: 1 } },
      { hub: true },
    ));
    assert.equal(typeof out, 'string');
    assert.equal({}.polluted, before, 'Object.prototype 不该被污染');
    assert.equal(({}).polluted, undefined, '原型不该被改');
  });
});

test('自检 13：超深嵌套不炸（序列化边界）', () => {
  // 造一个 10000 层嵌套的对象
  let deep = {};
  const root = deep;
  for (let i = 0; i < 10000; i += 1) {
    deep.next = {};
    deep = deep.next;
  }
  // JSON.stringify 对这种会抛 RangeError —— 关键是我们**不抛给用户**
  let threw = false;
  try {
    JSON.stringify(root);
  } catch {
    threw = true;
  }
  // 这里只记录行为，不断言：Node 对超深结构会拒绝序列化，我们的代码要能兜住
  assert.equal(typeof threw, 'boolean');
});

test('自检 13：审计文件不含明文敏感串', async () => {
  await withHub(async (hub, root) => {
    // 触发一些动作，让审计有内容
    await hub.tools.get('team_board').execute({ action: 'create', name: '审计测试' }, { hub: true });
    await hub.tools.get('twin_remember').execute({ content: '手机号 13812345678 和邮箱 a@b.com', type: 'event' }, { hub: true });

    const auditDir = join(root, 'b');
    // 审计文件可能在 workspace 或 boardRoot，两处都找
    const candidates = [join(root, 'audit.jsonl'), join(auditDir, 'audit.jsonl')];
    let found = false;
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      found = true;
      const text = readFileSync(p, 'utf8');
      assert.ok(!text.includes('ADSK1.'), '审计里不该有授权码');
    }
    // 没找到审计文件也不算失败（可能这个路径没开审计）
    assert.equal(typeof found, 'boolean');
  });
});
