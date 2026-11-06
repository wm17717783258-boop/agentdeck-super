#!/usr/bin/env node
/**
 * tools/verify-security.mjs —— 红队回归 + 全量回归，落证据
 *
 * 干两件事，只干这两件：
 *   1. 跑 tests/security-redteam.test.mjs，原始 TAP 存进 docs/evidence/security-redteam-<ver>.txt
 *   2. 跑全量 tests/*.test.mjs，计数存进 docs/evidence/gate-<ver>.txt
 *
 * 证据文件里只写"这次真跑出来的东西"：命令、Node 版本、通过/失败数、原始输出尾巴。
 * 断言失败就以非 0 退出，绝不写一份好看的假证据。
 *
 * 跑法：node tools/verify-security.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EVID = join(ROOT, 'docs', 'evidence');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const HOME = join(process.env.TEMP || tmpdir(), 'adsk-home-security');

/** 跑一条 node --test，返回「计数 + 原始输出」 */
function runTest(pattern, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const started = Date.now();
  const out = spawnSync(process.execPath, ['--test', '--test-concurrency=1', pattern], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  const text = `${out.stdout || ''}${out.stderr || ''}`;
  const num = (label) => {
    const m = new RegExp(`^\\u2139 ${label} (\\d+)$`, 'm').exec(text) || new RegExp(`^# ${label} (\\d+)$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    pattern,
    code: out.status,
    signal: out.signal || '',
    secs: ((Date.now() - started) / 1000).toFixed(1),
    tests: num('tests'),
    pass: num('pass'),
    fail: num('fail'),
    skipped: num('skipped'),
    text,
  };
}

/** 只留跑得过的断言行 + 失败详情，别把 3 万行 TAP 全塞进证据 */
function concise(text, { keep = 400 } = {}) {
  const lines = text.split(/\r?\n/);
  const picked = lines.filter((line) => /^(✔|✖|not ok|ℹ (tests|pass|fail|skipped|cancelled)|\s+AssertionError|\s+Error:)/.test(line));
  const head = picked.slice(0, keep);
  const tail = lines.slice(-40);
  return { head, tail };
}

function stamp(run, extra = [], title = '') {
  const { head, tail } = concise(run.text);
  return [
    `# ${title}`.trimEnd(),
    '',
    `· 时间：${new Date().toISOString()}（本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`,
    `· 版本：agentdeck-super ${VERSION}`,
    `· Node：${process.version} / ${process.platform}-${process.arch}`,
    `· 命令：node --test --test-concurrency=1 "${run.pattern}"（cwd=${ROOT}，DSH_HOME=${HOME}）`,
    `· 结果：tests ${run.tests} / pass ${run.pass} / fail ${run.fail} / skipped ${run.skipped} / 退出码 ${run.code}（${run.secs}s）`,
    '',
    ...extra,
    '──────────────── 断言明细 ────────────────',
    ...head,
    '',
    '──────────────── 原始输出尾部（末 40 行）────────────────',
    ...tail,
    '',
  ].join('\n');
}

const security = runTest('tests/security-redteam.test.mjs');
const gate = runTest('tests/*.test.mjs');

mkdirSync(EVID, { recursive: true });

const securityFile = join(EVID, `security-redteam-${VERSION}.txt`);
const gateFile = join(EVID, `gate-${VERSION}.txt`);

writeFileSync(
  securityFile,
  stamp(security, [
    '## 这轮红队覆盖什么',
    '',
    '① 恶意记忆条目诱导外部写入（记忆里的命令会不会被执行）',
    '② 房间/远程令牌越权读别的团队任务板（ADBP 令牌跨团队）',
    '③ 串门令牌越界（scope=visit 的邀请函去换 work 权限）',
    '④ 记忆可见性绕过（public / friend 视角能不能看到 private）',
    '⑤ 过期令牌 / 篡改令牌 / 冒名成员（签名与身份两条线）',
    '',
    '## 本轮真发现并修掉的两个洞（在 lib/engine/adbp.js）',
    '',
    '· 洞 1 跨团队越权读：`GET /adbp/v1/state?teamId=<别人的队>` 原本直接用 query 里的 teamId，',
    '  任何一张合法令牌都能读别的团队的任务板。修法：query.teamId 与令牌团队不一致 → 403 forbidden，',
    '  响应里不回显别人的 teamId 和任务内容。',
    '· 洞 2 冒名：`/tasks?memberId=`、`/result`、`/chat` 原本允许请求体里的 memberId 覆盖令牌身份，',
    '  可以替别人领活、交活、发言。修法：memberId 必须等于令牌里的成员 → 否则 403，不传则按令牌算。',
    '',
    '两处都留了"正常路仍然通"的正向断言，避免把功能一起堵死。',
    '',
  ], `红队用例：注入与越权 · agentdeck-super ${VERSION}`),
  'utf8',
);

writeFileSync(
  gateFile,
  stamp(gate, [
    '## 这是什么',
    '',
    '全量回归（含 12 个测试文件里的全部用例，含 server 启动、MCP stdio 与 Streamable HTTP、',
    '桌宠、记忆、会议、自动化、ADBP、安装器等）。串行跑，避免端口和全局状态串味。',
    '',
  ], `全量回归闸门 · agentdeck-super ${VERSION}`),
  'utf8',
);

console.log(`[security] tests ${security.tests} / pass ${security.pass} / fail ${security.fail} → ${securityFile}`);
console.log(`[gate]     tests ${gate.tests} / pass ${gate.pass} / fail ${gate.fail} → ${gateFile}`);

if (security.code !== 0 || gate.code !== 0 || (security.fail ?? 1) !== 0 || (gate.fail ?? 1) !== 0) {
  console.error('[security] 有失败，证据照实落盘，别改数字');
  process.exitCode = 1;
}
