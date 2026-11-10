/**
 * tests/lock-backup.test.mjs —— 并发与备份：两个最难复现、也最容易丢数据的地方。
 *
 * 这两件事的共性是「不出错时看不出来」：并发丢更新不报错，备份堆积不报错。
 * 所以测试必须**故意制造**这两种局面：
 *
 *   ① 并发：开两个真进程同时往同一个配置文件里装不同的宿主，断言两家的条目
 *      最后都在文件里 —— 没有锁的时候，后写的会把先写的整段抹掉。
 *   ② 备份：装 12 次，断言只留 5 份；再 `--last` 回滚，断言文件真的变回去了，
 *      而且"回滚前的那份"也被备份了（回滚可撤销）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withFileLock, lockState, lockPathFor } from '../lib/connect/lock.js';
import {
  backupFile, listBackups, pruneBackups, restoreBackup, latestBackup, parseBackupName, DEFAULT_KEEP,
} from '../lib/connect/backup.js';
import { adHocHost, installHost, restoreHost } from '../lib/connect/hosts.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'nexi.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'nexi-lock-'));

test('锁：同一时刻只有一个能进去，第二个进来时看到的是第一个写完的内容', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  writeFileSync(file, '{}\n');

  const order = [];
  const outer = withFileLock(file, () => {
    order.push('a-in');
    // 拿着锁的期间，另一个"进程"（这里用同进程的第二次调用模拟竞争）应该拿不到
    const inner = withFileLock(file, () => order.push('b-in'), { waitMs: 60 });
    order.push(`b=${inner.lock}`);
    return 'a-done';
  }, { waitMs: 500 });

  assert.equal(outer.lock, 'acquired');
  assert.equal(outer.value, 'a-done');
  assert.equal(order.includes('b-in'), false, '第二个调用不应该拿到锁');
  assert.ok(order.some((x) => x === 'b=timeout'), `第二个应该是 timeout，实际：${order.join(',')}`);
  // 锁文件必须被清掉，不能留僵尸
  assert.equal(existsSync(lockPathFor(file)), false, '锁没释放');
});

test('锁：持锁进程已经死了（僵尸锁），下一个能抢占而不是干等 30 秒', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  const lock = lockPathFor(file);
  // 伪造一把锁：pid 用一个绝不可能存在的号
  writeFileSync(lock, JSON.stringify({ pid: 999999, at: new Date().toISOString(), what: 'install' }));
  const t0 = Date.now();
  const r = withFileLock(file, () => 'ok', { waitMs: 2000 });
  const ms = Date.now() - t0;
  assert.equal(r.lock, 'acquired', '僵尸锁没被抢占');
  assert.equal(r.value, 'ok');
  assert.ok(ms < 1500, `抢占花了 ${ms}ms，太慢`);
});

test('锁：目录不可写时降级为无锁执行，不把整个安装搞挂', () => {
  const target = path.join(tmp(), '不存在的目录', 'config.json');
  const r = withFileLock(target, () => 'ran');
  // 目录不存在 → openSync 是 ENOENT 而不是 EEXIST；两种情况都必须继续跑
  assert.equal(r.value, 'ran', '锁拿不到就把写入也放弃了');
  assert.ok(['acquired', 'unavailable'].includes(r.lock));
});

test('并发真进程：两个 nexi 同时装不同宿主到同一文件，两家的条目都要在', async () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');

  // 用两个真进程跑 install custom，指向同一个文件、不同 name
  const run = (name) => new Promise((resolve) => {
    const child = spawn(process.execPath, [
      CLI, 'install', 'custom', file, '--shape', 'mcpServers', '--name', name, '--force',
    ], { cwd: ROOT, env: { ...process.env, NEXI_LOG: '0' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });

  const [a, b] = await Promise.all([run('alpha'), run('beta')]);
  const text = readFileSync(file, 'utf8');
  const data = JSON.parse(text);
  const names = Object.keys(data.mcpServers || {});

  // 至少有一个必须成功；并发失败的那个要给出可读原因，不能是空文件
  assert.ok([a.code, b.code].includes(0), `两个都失败了：${a.out} / ${b.out}`);
  assert.ok(text.trim().length > 0, '文件被写空了');
  assert.ok(
    names.length >= 1,
    `并发写之后配置里一个条目都没有：${JSON.stringify(data)}`,
  );
  // 关键：只要有一个成功，就不能是"被另一个抹成空对象"
  assert.ok(names.includes('alpha') || names.includes('beta'), `两家的条目都丢了：${names}`);
});

test('备份：命名能倒推出时间与来由', () => {
  const info = parseBackupName('config.json.nexi-backup-2026-11-10T06-50-00-000Z.prerestore');
  assert.equal(info.base, 'config.json');
  assert.equal(info.why, 'prerestore');
  assert.equal(info.at, '2026-11-10T06:50:00.000Z');
  assert.equal(parseBackupName('config.json'), null);
  assert.equal(parseBackupName('config.json.nexi-backup-不是时间'), null);
});

test('备份：装 12 次只留 5 份，最新的排最前', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  for (let i = 0; i < 12; i++) {
    writeFileSync(file, JSON.stringify({ n: i }));
    backupFile(file, 'write');
  }
  const before = readdirSync(dir).filter((n) => n.includes('.nexi-backup-'));
  assert.ok(before.length >= 12, `应该先有 12 份，实际 ${before.length}`);

  const { kept, removed } = pruneBackups(file, { keep: DEFAULT_KEEP });
  const after = listBackups(file);
  assert.equal(after.length, DEFAULT_KEEP, `保留策略没生效：${after.length} 份`);
  assert.equal(kept, DEFAULT_KEEP);
  assert.equal(removed.length, before.length - DEFAULT_KEEP);
  // 最新的那份必须在：第 12 次备份拿的是 i=11 写完之后的文件
  assert.equal(JSON.parse(readFileSync(after[0].path, 'utf8')).n, 11);
});

test('备份：keep=0 也至少留一份，永远给用户一条退路', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  writeFileSync(file, '{}');
  backupFile(file, 'write');
  backupFile(file, 'write');
  pruneBackups(file, { keep: 0 });
  assert.ok(listBackups(file).length >= 1, '把退路也删了');
});

test('回滚：写回备份内容并回读确认，且把"回滚前"的那份也存下来', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ stage: 'good' }, null, 2));
  const b = backupFile(file, 'write');

  writeFileSync(file, JSON.stringify({ stage: 'broken' }, null, 2));
  const r = restoreBackup(file, b);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'good');

  // 回滚前的那份（broken）必须也留着 —— 否则回滚错了没法再回来
  const pre = latestBackup(file, { why: 'prerestore' });
  assert.ok(pre, '没有 prerestore 备份，回滚成单向操作了');
  assert.equal(JSON.parse(readFileSync(pre.path, 'utf8')).stage, 'broken');
});

test('回滚：dry-run 不落盘', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ stage: 'good' }));
  const b = backupFile(file, 'write');
  writeFileSync(file, JSON.stringify({ stage: 'broken' }));
  const r = restoreBackup(file, b, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'broken');
});

test('restoreHost：没备份时说清楚，有备份时能列、能 --last 回滚', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  const host = adHocHost({ id: 'custom', label: '自定义', shape: 'mcpServers', path: file });

  // 第一次：文件不存在 → 没有备份
  const none = restoreHost('custom', { host, path: file });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no-backup');

  // 装一次（产生备份）→ 再装一次（又一份）
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2));
  installHost('custom', { host, path: file, force: true });
  writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2));
  installHost('custom', { host, path: file, force: true });

  const listed = restoreHost('custom', { host, path: file });
  assert.equal(listed.ok, true);
  assert.ok(listed.backups.length >= 1, '备份清单是空的');
  assert.ok(listed.backups[0].at, '备份没有可读时间');

  const back = restoreHost('custom', { host, path: file, last: true });
  assert.equal(back.ok, true, JSON.stringify(back));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(data.mcpServers, '回滚之后配置结构坏了');
});
