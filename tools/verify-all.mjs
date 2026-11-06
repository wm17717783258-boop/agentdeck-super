/**
 * tools/verify-all.mjs —— 一条命令跑完所有验收证据
 *
 * 为什么需要它：证据散在 6 个脚本里，发版时靠人记「这次该跑哪几个」，
 * 迟早会漏一个（1.7.4 就漏过：改完代码只跑了 gate，没重跑 readonly）。
 *
 * 这个脚本只做三件事：
 *   1. 依次跑每个验收脚本，各自把证据写进 docs/evidence/<名字>-<版本>.txt；
 *   2. 汇总成一张表（过了几个 / 失败几个 / 耗时 / 证据文件字节数）；
 *   3. 任何一个红了 → 退出码 1，并且**不覆盖**已有的好证据（脚本自己负责写）。
 *
 * 用法：
 *   node tools/verify-all.mjs                 # 全跑
 *   node tools/verify-all.mjs --only passport,recovery
 *   node tools/verify-all.mjs --list
 *   node tools/verify-all.mjs --no-record     # 只体检，不写证据文件
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const argv = process.argv.slice(2);
const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
const NO_RECORD = argv.includes('--no-record');

/** 每个验收脚本：名字 / 命令 / 它负责写哪份证据 / 大概要多久 */
const SUITES = [
  {
    id: 'gate',
    what: '全量回归（663 条单测）+ 红队 11 条',
    cmd: ['tools/verify-security.mjs'],
    evidence: [`gate-${ver}.txt`, `security-redteam-${ver}.txt`],
    slow: true,
  },
  {
    id: 'readonly',
    what: 'MCP 只读模式（21→17 工具、五类写动作全拒）',
    cmd: ['tools/verify-readonly.mjs'],
    evidence: [`readonly-${ver}.txt`],
  },
  {
    id: 'passport',
    what: 'Agent 通行证（跨进程签发/验卡/篡改/kid 钉/只读）',
    cmd: ['tools/verify-passport.mjs', '--pkg', '.'],
    evidence: [`passport-${ver}.txt`],
  },
  {
    id: 'mcp-http',
    what: 'Streamable HTTP MCP（两个只会 fetch 的客户端接管全部工具）',
    cmd: ['tools/verify-mcp-http.mjs'],
    evidence: [`mcp-http-${ver}.txt`, `mcp-http-${ver}.jsonl`],
  },
  {
    id: 'recovery',
    what: '门槛 ⑦：断网 / 崩溃 / 升级 / 迁移四类各演一遍',
    cmd: ['tools/verify-recovery.mjs', '--pkg', '.'],
    evidence: [`recovery-${ver}.txt`],
  },
  {
    id: 'console',
    what: '测试台 /deck/console：真宿主里点按钮 = 真调工具、真写盘（含只读服务端拦截）',
    cmd: ['tools/verify-console.mjs', '--pkg', '.'],
    evidence: [`console-${ver}.txt`],
  },
  {
    id: 'pay',
    what: '支付链路端到端：真 HTTP 网关 → 到账 → 解锁 → 幂等 → 退款收回（含「环境未配」诚实失败）',
    cmd: ['tools/verify-pay.mjs'],
    evidence: [`pay-${ver}.txt`],
  },
  {
    id: 'visit',
    what: '两个真人 / 两台机器 / 两个 Agent 跨进程真串一次门（邀请→验签→回卡→求助便签→落任务）',
    cmd: ['tools/verify-visit.mjs'],
    evidence: [`visit-2user-${ver}.txt`],
  },
  {
    id: 'meeting',
    what: '三个 Agent 真开一场会：意见→分歧→投票→决议→落任务（含治理闸门反例）',
    cmd: ['tools/verify-meeting.mjs'],
    evidence: [`meeting-3agent-${ver}.txt`],
  },
  {
    id: 'installed',
    what: '在"真装进 profile 的那份"上重放越权攻击（需要已经装好）',
    cmd: ['tools/verify-installed-security.mjs'],
    evidence: [`installed-security-${ver}.txt`],
    optional: true,   // profile 里没装就能跳过，不算失败
  },
  {
    id: 'hosts',
    what: '8 宿主认证矩阵（会写真实宿主配置再回滚，慢）',
    cmd: ['bin/nexi.mjs', 'verify-host', '--all', '--record'],
    evidence: [`hosts-${ver}.txt`],
    optional: true,   // 默认不在全跑里；它动真宿主配置，单独跑更合适
  },
];

const only = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

if (argv.includes('--list')) {
  console.log('可跑的验收：');
  for (const s of SUITES) console.log(`  ${s.id.padEnd(10)} ${s.what}${s.optional ? '（可选，默认跳过）' : ''}`);
  process.exit(0);
}

const picked = SUITES.filter((s) => (only ? only.includes(s.id) : !s.optional));
const results = [];

console.log(`Nexi 灵犀 —— 全量验收（版本 ${ver}）`);
console.log(`仓库：${PKG}`);
console.log(`要跑：${picked.map((s) => s.id).join(' → ')}`);
console.log('');

for (const s of picked) {
  const t0 = Date.now();
  console.log(`▶ ${s.id} —— ${s.what}`);
  const args = [...s.cmd];
  if (!NO_RECORD && !args.includes('--record') && args.some((a) => a.endsWith('.mjs'))) args.push('--record');
  const r = spawnSync(process.execPath, args.map((a) => (a.includes('/') ? join(PKG, a) : a)), {
    cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 900000,
  });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').slice(-6).join('\n');
  console.log(tail.split('\n').map((l) => `   ${l}`).join('\n'));

  const files = s.evidence.map((f) => {
    const p = join(PKG, 'docs', 'evidence', f);
    return { f, exists: existsSync(p), size: existsSync(p) ? statSync(p).size : 0 };
  });
  const badEvidence = files.filter((f) => !f.exists || f.size === 0);
  // 证据里出现 ❌ 就不许当成功——这是全局规矩
  const hasFailMark = files.some((f) => {
    if (!f.exists) return false;
    return readFileSync(join(PKG, 'docs', 'evidence', f.f), 'utf8').includes('❌');
  });

  const ok = r.status === 0 && badEvidence.length === 0 && !hasFailMark;
  console.log(`   → ${ok ? '通过' : '失败'}，耗时 ${took}s${hasFailMark ? '（证据里出现 ❌）' : ''}${badEvidence.length ? `（缺证据：${badEvidence.map((b) => b.f).join(', ')}）` : ''}`);
  console.log('');
  results.push({ id: s.id, ok, took, status: r.status, files });
}

const pass = results.filter((x) => x.ok).length;
console.log('='.repeat(72));
console.log(`汇总：${pass}/${results.length} 通过`);
for (const x of results) {
  const ev = x.files.map((f) => `${f.f}${f.exists ? ` (${f.size}B)` : ' ❌缺失'}`).join(' + ');
  console.log(`  ${x.ok ? '✅' : '❌'} ${x.id.padEnd(10)} ${String(x.took).padStart(6)}s  exit=${x.status}  ${ev}`);
}
if (pass !== results.length) {
  console.log('');
  console.log('有验收没过 —— 不许发版（见内部发布检查表的五关）。');
}
process.exitCode = pass === results.length ? 0 : 1;
