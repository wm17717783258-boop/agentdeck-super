/**
 * tests/logs.test.mjs —— 结构化运行日志。
 *
 * 这条链路的用处只有一个：用户说"它坏了"时，我不用再让他复制终端。
 * 所以测三件事：**写进去、能读出来、别把密钥写进去**。
 * 顺带锁住"日志坏了不能把主流程带崩"（目录不可写时返回 null 而不是抛）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_BYTES, clearLogs, dayStamp, formatEntry, logEvent, logFileFor, logsDir, readTail,
} from '../lib/log.js';

const CLI = join(import.meta.dirname, '..', 'bin', 'nexi.mjs');

function tmpLogDir() {
  return mkdtempSync(join(tmpdir(), 'nexi-logs-'));
}

test('写一条就有一行 JSONL：ts / level / event / pid 都在', () => {
  const dir = tmpLogDir();
  const env = { NEXI_LOG_DIR: dir };
  const entry = logEvent('warn', 'unit', { cmd: 'doctor', ok: false }, { env });
  assert.ok(entry, '没写进去');
  assert.equal(existsSync(logFileFor(dayStamp(), env)), true);
  const { entries } = readTail({ lines: 10, env });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'warn');
  assert.equal(entries[0].event, 'unit');
  assert.equal(entries[0].cmd, 'doctor');
  assert.equal(entries[0].ok, false);
  assert.ok(entries[0].ts && entries[0].pid);
});

test('NEXI_LOG=0 关掉：一条都不写（不联网、不落盘）', () => {
  const dir = tmpLogDir();
  const env = { NEXI_LOG_DIR: dir, NEXI_LOG: '0' };
  assert.equal(logEvent('info', 'unit', {}, { env }), null);
  assert.equal(readdirSync(dir).length, 0);
});

test('密钥不落盘：token / secret / sha256 只留长度', () => {
  const dir = tmpLogDir();
  const env = { NEXI_LOG_DIR: dir };
  logEvent('info', 'unit', { token: 'abcd1234', sha256: 'f'.repeat(64), note: 'ok' }, { env });
  const [e] = readTail({ lines: 1, env }).entries;
  assert.equal(e.token, '[8 字符]');
  assert.equal(e.sha256, '[64 字符]');
  assert.equal(e.note, 'ok');
});

test('超长字段截断，不会把整段 JSON 灌进日志', () => {
  const dir = tmpLogDir();
  const env = { NEXI_LOG_DIR: dir };
  logEvent('info', 'unit', { body: 'x'.repeat(1000) }, { env });
  const [e] = readTail({ lines: 1, env }).entries;
  assert.ok(e.body.length < 400, `没截断：${e.body.length}`);
  assert.match(e.body, /共 1000 字符/);
});

test('超过 5 MB 轮转成 .1（日志是排障用的，不是档案）', () => {
  const dir = tmpLogDir();
  const env = { NEXI_LOG_DIR: dir };
  const file = logFileFor(dayStamp(), env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${'x'.repeat(MAX_BYTES + 10)}\n`, 'utf8');
  logEvent('info', 'after-rotate', {}, { env });
  const names = readdirSync(dir).sort();
  assert.ok(names.includes(`${`nexi-${dayStamp()}.log`}.1`), `没轮转：${names.join(',')}`);
  const [e] = readTail({ lines: 1, env }).entries;
  assert.equal(e.event, 'after-rotate', '轮转后新条目写进了旧文件？');
});

test('readTail 只取最后 N 条，顺序是从旧到新', () => {
  const dir = tmpLogDir();
  const env = { NEXI_LOG_DIR: dir };
  for (let i = 0; i < 5; i += 1) logEvent('info', `e${i}`, {}, { env });
  const { entries } = readTail({ lines: 2, env });
  assert.deepEqual(entries.map((e) => e.event), ['e3', 'e4']);
});

test('clearLogs 清空；formatEntry 输出人话', () => {
  const dir = tmpLogDir();
  const env = { NEXI_LOG_DIR: dir };
  logEvent('info', 'x', { cmd: 'doctor' }, { env });
  assert.equal(clearLogs(env).removed, 1);
  assert.equal(readdirSync(dir).length, 0);
  const line = formatEntry({ ts: '2026-11-10T06:00:00.000Z', level: 'info', event: 'cli', cmd: 'host', ms: 12 });
  assert.match(line, /2026-11-10 06:00:00/);
  assert.match(line, /INFO/);
  assert.match(line, /cmd=host/);
});

test('目录不可写也不抛（只读盘上主流程照样能跑）', () => {
  const env = { NEXI_LOG_DIR: join(tmpLogDir(), 'a.txt') };
  // 把"目录"建成文件：mkdir 必失败，logEvent 必须吞掉
  writeFileSync(env.NEXI_LOG_DIR, 'not a dir');
  assert.equal(logEvent('info', 'x', {}, { env }), null);
});

test('CLI：nexi logs --json 输出可解析的 JSON 行，--dir 只给目录', () => {
  const dir = tmpLogDir();
  const env = { ...process.env, NEXI_LOG_DIR: dir };
  logEvent('info', 'seeded', { cmd: 'test' }, { env });

  const json = spawnSync(process.execPath, [CLI, 'logs', '--json', '--tail', '5'], { encoding: 'utf8', env });
  assert.equal(json.status, 0, json.stderr);
  const parsed = json.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(parsed.some((e) => e.event === 'seeded'), `没读到预置日志：${json.stdout}`);

  const where = spawnSync(process.execPath, [CLI, 'logs', '--dir'], { encoding: 'utf8', env });
  assert.equal(where.status, 0, where.stderr);
  assert.equal(JSON.parse(where.stdout).dir, logsDir(env));
});
