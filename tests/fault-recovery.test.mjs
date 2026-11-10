/**
 * tests/fault-recovery.test.mjs —— R7：故障注入与恢复。
 *
 * 前面几轮验的是「一切正常时对不对」。这一轮验的是**不正常时会不会把事情弄得更糟**：
 *
 *   ① 半截哨兵（上次写到一半被杀）→ 必须拒绝写第二个块，而不是让文件更乱；
 *   ② 坏备份（备份本身是半截 JSON）→ 回滚必须拒绝，当前好配置一个字节都不能动；
 *   ③ 只读文件 → 报一句人话 + 怎么办，不许抛堆栈，不许留 `.nexi.tmp` 残渣；
 *   ④ 路径中间是文件 → 说"把文件名当目录了"，而不是 EPERM 满天飞；
 *   ⑤ state.json 被截断 → 留证物 + 自愈重建，任务板不能永久变砖；
 *   ⑥ 错误目录本身 → 每个 code 都有 reason/message/hint，能枚举、能照做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  adHocHost, installHost, uninstallHost, repairHost, restoreHost,
} from '../lib/connect/hosts.js';
import { backupFile } from '../lib/connect/backup.js';
import { WRITE_ERRORS, translateWriteError, writeFailureReasons } from '../lib/connect/errors.js';
import { createBoard } from '../lib/engine/board.js';

const SENT_START = '# >>> nexi (managed by nexi install, 删这段即完全移除) >>>';
const SENT_END = '# <<< nexi <<<';
const tmp = (tag) => mkdtempSync(path.join(tmpdir(), `nexi-fault-${tag}-`));

/** 目录里有没有 nexi 留下的临时文件 */
function strayTmp(dir) {
  return readdirSync(dir).filter((n) => n.endsWith('.nexi.tmp'));
}

// ── ① 半截哨兵 ────────────────────────────────────────────────────────────────

test('半截哨兵：只有开始标记时拒绝写入，原文逐字节不变', () => {
  const dir = tmp('torn-start');
  const file = path.join(dir, 'config.toml');
  // 模拟「上次写到一半被 kill」：只有 START，没有 END，块内容也缺
  const original = `# 用户自己的配置\nmodel = "gpt-5"\n\n${SENT_START}\n[mcp_servers.nexi]\ncommand = "node"\n`;
  writeFileSync(file, original, 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const r = installHost('custom', { host, path: file, force: true });

  assert.equal(r.ok, false, '半截哨兵居然装成功了');
  assert.equal(r.reason, 'torn-sentinel', `reason 不对：${r.reason}`);
  assert.ok(
    r.warnings.some((w) => w.includes('不完整的 nexi 哨兵')),
    `没告诉用户发生了什么：${JSON.stringify(r.warnings)}`,
  );
  assert.ok(
    r.warnings.some((w) => w.includes('手工') || w.includes('restore')),
    `没给处理办法：${JSON.stringify(r.warnings)}`,
  );
  assert.equal(readFileSync(file, 'utf8'), original, '文件被动过了');
});

test('半截哨兵：只有结束标记时同样拒绝，不会被当成"已安装"', () => {
  const dir = tmp('torn-end');
  const file = path.join(dir, 'config.toml');
  const original = `# user\n${SENT_END}\n`;
  writeFileSync(file, original, 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const r = installHost('custom', { host, path: file, force: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'torn-sentinel');
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('半截哨兵：整段修好之后能正常装，装完能卸回原文', () => {
  const dir = tmp('torn-fixed');
  const file = path.join(dir, 'config.toml');
  writeFileSync(file, '# user\nmodel = "gpt-5"\n', 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const a = installHost('custom', { host, path: file });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.ok(readFileSync(file, 'utf8').includes(SENT_END), '块没写全');

  const b = uninstallHost('custom', { host, path: file });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(readFileSync(file, 'utf8'), '# user\nmodel = "gpt-5"\n', '没逐字节还原');
});

// ── ② 坏备份 ──────────────────────────────────────────────────────────────────

test('坏备份：备份是半截 JSON 时回滚被拒，当前配置一个字节不动', () => {
  const dir = tmp('bad-backup');
  const file = path.join(dir, 'mcp.json');
  const good = JSON.stringify({ mcpServers: { other: { command: 'keep-me' } } }, null, 2) + '\n';
  writeFileSync(file, good, 'utf8');

  // 手工造一份"坏备份"：名字合法，内容是半截 JSON
  const bad = `${file}.nexi-backup-2026-01-01T00-00-00-000Z.write`;
  writeFileSync(bad, '{"mcpServers": {"oth', 'utf8');

  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
  const r = restoreHost('custom', { host, path: file, to: bad });

  assert.equal(r.ok, false, '坏备份被当成好备份回滚了 —— 这是数据丢失');
  assert.equal(r.reason, 'backup-corrupt', `reason 不对：${r.reason}`);
  assert.ok(String(r.message).includes('备份本身不能用'), `message 不可读：${r.message}`);
  assert.ok(String(r.hint).includes('当前配置'), `hint 没说清风险：${r.hint}`);
  assert.equal(readFileSync(file, 'utf8'), good, '当前配置被坏备份覆盖了');
});

test('坏备份：空备份与顶层是数组的备份都拒绝', () => {
  const dir = tmp('bad-shape');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, '{"mcpServers":{}}\n', 'utf8');
  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });

  const empty = `${file}.nexi-backup-2026-01-01T00-00-00-000Z.write`;
  writeFileSync(empty, '', 'utf8');
  assert.equal(restoreHost('custom', { host, path: file, to: empty }).reason, 'backup-corrupt');

  const arr = `${file}.nexi-backup-2026-01-02T00-00-00-000Z.write`;
  writeFileSync(arr, '[]', 'utf8');
  const r = restoreHost('custom', { host, path: file, to: arr });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'backup-corrupt');
  assert.ok(String(r.message).includes('顶层不是对象'), `message：${r.message}`);
});

test('好备份：同一套流程仍然能正常回滚（拒绝坏备份不等于把所有回滚都关掉）', () => {
  const dir = tmp('good-backup');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: 'x' } } }, null, 2), 'utf8');
  const good = backupFile(file, 'write');
  writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');

  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
  const r = restoreHost('custom', { host, path: file, to: good });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.a.command, 'x');
});

// ── ③ 只读文件 ────────────────────────────────────────────────────────────────

test('只读文件：报 permission-denied + 怎么办，不抛堆栈、不留临时文件', () => {
  const dir = tmp('readonly');
  const file = path.join(dir, 'mcp.json');
  const original = '{"mcpServers":{}}\n';
  writeFileSync(file, original, 'utf8');
  chmodSync(file, 0o444); // Windows 上是只读属性；POSIX 上是 r--r--r--

  try {
    const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
    const r = installHost('custom', { host, path: file, force: true });

    assert.equal(r.ok, false, '只读文件居然写成功了');
    assert.equal(r.reason, 'permission-denied', `reason 不对：${r.reason} ${r.code || ''}`);
    assert.ok(r.code, '没带原始 code，用户没法查');
    assert.ok(String(r.message).includes('写不进去'), `message：${r.message}`);
    assert.ok(String(r.hint).length > 10, `hint 太短：${r.hint}`);
    assert.equal(readFileSync(file, 'utf8'), original, '只读文件内容变了');
    assert.deepEqual(strayTmp(dir), [], `留下了临时文件：${strayTmp(dir)}`);
  } finally {
    chmodSync(file, 0o644);
  }
});

test('只读文件：卸载与回滚也走同一套翻译，不会一半抛异常一半返回', () => {
  const dir = tmp('readonly-un');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: { nexi: { command: 'node' } } }, null, 2), 'utf8');
  const b = backupFile(file, 'write');
  chmodSync(file, 0o444);
  try {
    const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
    const un = uninstallHost('custom', { host, path: file });
    assert.equal(un.ok, false);
    assert.equal(un.reason, 'permission-denied');

    const re = restoreHost('custom', { host, path: file, to: b });
    // 备份内容与当前相同 → 可能被判成"无需改动"；关键是绝不许抛异常
    assert.equal(typeof re.ok, 'boolean');
    if (!re.ok) assert.equal(re.reason, 'permission-denied');
    assert.deepEqual(strayTmp(dir), []);
  } finally {
    chmodSync(file, 0o644);
  }
});

// ── ④ 路径中间是文件 ──────────────────────────────────────────────────────────

test('路径中间是文件：说「把文件名当目录了」，不冒 EPERM 也不建出怪目录', () => {
  const dir = tmp('notdir');
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'i am a file', 'utf8');
  const file = path.join(blocker, 'mcp.json');

  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
  const r = installHost('custom', { host, path: file, force: true });

  assert.equal(r.ok, false, '往文件里建目录居然成功了');
  assert.ok(['path-missing', 'write-failed'].includes(r.reason), `reason：${r.reason}`);
  assert.ok(String(r.hint).length > 5, '没给处理办法');
  assert.equal(readFileSync(blocker, 'utf8'), 'i am a file', '把用户文件覆盖了');
});

// ── ⑤ state.json 截断自愈 ─────────────────────────────────────────────────────

test('state.json 被截断：留证物 + 自愈重建，任务板不会永久变砖', () => {
  const root = tmp('board-corrupt');
  const board = createBoard({ root, pollIntervalMs: 5, lockWaitMs: 2000 });
  board.createTeam({ name: '交付小组', goal: '验证自愈' });
  const stateFile = path.join(root, 'state.json');
  assert.ok(existsSync(stateFile), '任务板根本没落盘');

  // 模拟断电：把文件砍掉一半
  const full = readFileSync(stateFile, 'utf8');
  writeFileSync(stateFile, full.slice(0, Math.floor(full.length / 2)), 'utf8');

  const warns = [];
  const reborn = createBoard({ root, pollIntervalMs: 5, lockWaitMs: 2000, onWarn: (m, d) => warns.push(`${m} ${d || ''}`) });

  // ① 不崩、能读
  assert.deepEqual(reborn.listTeams(), [], '坏文件里的半截数据被当成了真数据');

  // ② 坏文件被留档，而不是被下次写入直接覆盖
  const corrupt = readdirSync(root).filter((n) => n.startsWith('state.json.corrupt-'));
  assert.equal(corrupt.length, 1, `证物数量不对：${corrupt.join(',')}`);
  const evidence = readFileSync(path.join(root, corrupt[0]), 'utf8');
  assert.equal(evidence.length, Math.floor(full.length / 2), '证物内容和坏掉的文件对不上');

  // ③ 告警说清了"留了证物、按空状态重建"
  assert.ok(
    warns.some((w) => w.includes('损坏') && w.includes('重建')),
    `告警没讲清楚：${JSON.stringify(warns)}`,
  );

  // ④ 下一次写入自动重建出合法 JSON
  reborn.createTeam({ name: '重生的队伍', goal: 'g' });
  assert.ok(existsSync(stateFile), '没有重建 state.json');
  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
  const rebuilt = Object.values(parsed.teams || {});
  assert.equal(rebuilt.length, 1, '重建后结构不对');
  assert.equal(rebuilt[0].name, '重生的队伍');
});

test('state.json 是空文件：算「还没写过」，不算损坏，不留证物', () => {
  const root = tmp('board-empty');
  writeFileSync(path.join(root, 'state.json'), '', 'utf8');
  const warns = [];
  const board = createBoard({ root, pollIntervalMs: 5, lockWaitMs: 2000, onWarn: (m) => warns.push(m) });
  assert.deepEqual(board.listTeams(), []);
  assert.deepEqual(readdirSync(root).filter((n) => n.includes('.corrupt-')), [], '空文件被当成损坏了');
  assert.equal(warns.some((w) => w.includes('损坏')), false, `不该告警：${warns.join('|')}`);
});

test('state.json 坏很多次：证物只留最近 3 份，不会把磁盘堆满', () => {
  const root = tmp('board-many');
  for (let i = 0; i < 5; i++) {
    // 每次先弄坏，再让任务板读一次（读 → 留证物 → 按空状态重建），然后再写一次
    writeFileSync(path.join(root, 'state.json'), `{"teams":[{"id":"x${i}"`, 'utf8');
    const b = createBoard({ root, pollIntervalMs: 5, lockWaitMs: 2000, onWarn: () => {} });
    b.createTeam({ name: `t${i}`, goal: 'g' });
  }
  const corrupt = readdirSync(root).filter((n) => n.startsWith('state.json.corrupt-'));
  assert.ok(corrupt.length <= 3, `证物堆到 ${corrupt.length} 份了`);
  assert.ok(corrupt.length >= 1, '一份证物都没留');
});

// ── ⑤b 进程被 kill 之后的残渣 ────────────────────────────────────────────────

test('上次被 kill 留下的半写临时文件：下一次安装顺手清掉，正在写的不动', () => {
  const dir = tmp('stale-tmp');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, '{"mcpServers":{}}\n', 'utf8');

  // 一份"两小时前的残渣"（模拟被 kill / 断电留下的），一份"刚刚的"（可能是别人正在写）
  const stale = path.join(dir, '.99999-deadbeef.nexi.tmp');
  const fresh = path.join(dir, '.88888-cafebabe.nexi.tmp');
  writeFileSync(stale, '{"half":', 'utf8');
  writeFileSync(fresh, '{"half":', 'utf8');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stale, twoHoursAgo, twoHoursAgo);

  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
  const r = installHost('custom', { host, path: file, force: true });
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(existsSync(stale), false, '一小时前的残渣没被清掉');
  assert.equal(existsSync(fresh), true, '把别人正在写的临时文件删了');
});

test('写盘失败不会留下"看起来像配置"的残渣：目录只读时连 tmp 都建不出来', {
  // Windows 的目录只读位不拦创建文件（只影响删除），这条只有 POSIX 语义能验
  skip: process.platform === 'win32' && 'Windows 的目录权限不拦创建，等价场景由只读文件那条覆盖',
}, () => {
  const dir = tmp('no-residue');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, '{"mcpServers":{}}\n', 'utf8');
  chmodSync(dir, 0o555); // 目录只读：连临时文件都建不出来
  try {
    const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
    const r = installHost('custom', { host, path: file, force: true });
    assert.equal(r.ok, false);
    assert.ok(['permission-denied', 'write-failed'].includes(r.reason), r.reason);
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.deepEqual(strayTmp(dir), [], `残留：${strayTmp(dir)}`);
  assert.equal(readFileSync(file, 'utf8'), '{"mcpServers":{}}\n', '原配置被改了');
});

// ── ⑤c 修：把"拒绝写入"变成"一条命令收拾干净" ──────────────────────────────

test('repair：半截哨兵能一条命令清干净，清完 install 就能重装', () => {
  const dir = tmp('repair');
  const file = path.join(dir, 'config.toml');
  const userPart = '# 用户自己的配置\nmodel = "gpt-5"\n';
  writeFileSync(file, `${userPart}\n${SENT_START}\n[mcp_servers.nexi]\ncommand = "node"\n`, 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const r = repairHost('custom', { host, path: file });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, { markers: 1, tables: 1 }, `删的东西不对：${JSON.stringify(r.removed)}`);

  const after = readFileSync(file, 'utf8');
  assert.ok(after.includes('model = "gpt-5"'), '把用户自己的配置删了');
  assert.ok(!after.includes('[mcp_servers.nexi]'), '表没删干净');
  assert.ok(!after.includes(SENT_START), '哨兵没删干净');

  // 清完必须能装
  const ins = installHost('custom', { host, path: file });
  assert.equal(ins.ok, true, `修完还是装不上：${JSON.stringify(ins)}`);
  assert.ok(readFileSync(file, 'utf8').includes(SENT_END), '没写进新块');
});

test('repair --dry-run 一个字节都不写（以前这里把干跑写成了真写）', () => {
  const dir = tmp('repair-dry');
  const file = path.join(dir, 'config.toml');
  const original = `model = "gpt-5"\n${SENT_END}\n`;
  writeFileSync(file, original, 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const r = repairHost('custom', { host, path: file, dryRun: true });
  assert.equal(r.dryRun, true, '没认出这是干跑');
  assert.equal(r.changed, true);
  assert.ok(r.preview.includes('model = "gpt-5"'), '预览内容不对');
  assert.equal(readFileSync(file, 'utf8'), original, '干跑把文件改了');

  // 目录里不许出现备份文件 —— 备份本身就是写盘
  const backups = readdirSync(dir).filter((n) => n.includes('.nexi-backup-'));
  assert.deepEqual(backups, [], `干跑留下了备份：${backups}`);
});

test('repair：本来干净的文件不报 changed，也不产生备份', () => {
  const dir = tmp('repair-clean');
  const file = path.join(dir, 'config.toml');
  const original = 'model = "gpt-5"\n';
  writeFileSync(file, original, 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const r = repairHost('custom', { host, path: file });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'clean');
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.nexi-backup-')), []);
});

test('repair：JSON 宿主不归它管，明确回 not-needed 而不是乱改', () => {
  const dir = tmp('repair-json');
  const file = path.join(dir, 'mcp.json');
  const original = '{"mcpServers":{"nexi":{"command":"node"}}}\n';
  writeFileSync(file, original, 'utf8');

  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
  const r = repairHost('custom', { host, path: file });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'not-needed');
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('repair：文件不存在时不算错（还没装过就是干净的）', () => {
  const dir = tmp('repair-missing');
  const file = path.join(dir, 'nope.toml');
  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const r = repairHost('custom', { host, path: file });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no-config');
  assert.equal(existsSync(file), false, 'repair 凭空造了个文件');
});

test('无哨兵的 TOML（宿主 CLI 自己写的表）也能卸干净 —— 装得进去就必须卸得出来', () => {
  const dir = tmp('cli-table');
  const file = path.join(dir, 'config.toml');
  // 这是 `codex mcp add nexi` 写完之后的真实形态：codex 会把整个 config.toml
  // 重新序列化，把我们的哨兵注释全丢掉，只剩一个裸表。
  const userBefore = '# 用户自己的配置\nmodel = "gpt-5"\n\n[windows]\nsandbox = "unelevated"\n';
  writeFileSync(file, userBefore, 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const withTable = '# 用户自己的配置\nmodel = "gpt-5"\n\n'
    + '[mcp_servers.nexi]\ncommand = \'C:\\node.exe\'\nargs = [\'C:\\nexi.mjs\', "mcp"]\n\n'
    + '[windows]\nsandbox = "unelevated"\n';
  writeFileSync(file, withTable, 'utf8');

  // 以前这里返回 changed:false，条目留在文件里 —— 静默卸不干净
  const un = uninstallHost('custom', { host, path: file });
  assert.equal(un.ok, true, JSON.stringify(un));
  assert.equal(un.changed, true, '无哨兵的表被当成"没装"了');
  assert.equal(un.via, 'table', `走的不是精确删表：${un.via}`);

  const after = readFileSync(file, 'utf8');
  assert.ok(!after.includes('mcp_servers.nexi'), '表还在');
  assert.equal(after, userBefore, `没还原成用户原文：\n${JSON.stringify(after)}`);

  // 再卸一次必须幂等
  const again = uninstallHost('custom', { host, path: file });
  assert.equal(again.changed, false);
  assert.equal(readFileSync(file, 'utf8'), userBefore);
});

test('无哨兵的 TOML：别的 [mcp_servers.xxx] 表不许动', () => {
  const dir = tmp('cli-table-other');
  const file = path.join(dir, 'config.toml');
  const text = '[mcp_servers.nexi]\ncommand = "node"\n\n'
    + '[mcp_servers.other]\ncommand = "other"\nargs = ["--keep"]\n';
  writeFileSync(file, text, 'utf8');

  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  uninstallHost('custom', { host, path: file });
  const after = readFileSync(file, 'utf8');
  assert.ok(!after.includes('mcp_servers.nexi'), 'nexi 表没删');
  assert.ok(after.includes('[mcp_servers.other]'), '把别人的表删了');
  assert.ok(after.includes('--keep'), '把别人的参数删了');
});

// ── ⑥ 错误目录 ────────────────────────────────────────────────────────────────
test('错误目录：每个 code 都有 reason、说人话的 message 和可照做的 hint', () => {
  for (const code of Object.keys(WRITE_ERRORS)) {
    const r = translateWriteError('/tmp/x.json', Object.assign(new Error('boom'), { code }));
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
    assert.notEqual(r.reason, 'write-failed', `${code} 没被归类`);
    assert.ok(r.message.includes('/tmp/x.json'), `${code} 的 message 没带路径`);
    assert.ok(r.message.includes(code), `${code} 的 message 没带 code`);
    assert.ok(r.hint.length >= 8, `${code} 的 hint 太短：${r.hint}`);
    assert.ok(!/\bat .+:\d+:\d+/.test(r.message), `${code} 的 message 里混进了堆栈`);
  }
});

test('错误目录：不认识的 code 也返回结构完整的失败，不抛异常', () => {
  const r = translateWriteError('/tmp/y.json', Object.assign(new Error('外星错误'), { code: 'EWHATEVER' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-failed');
  assert.ok(r.message.includes('EWHATEVER'));
  assert.ok(r.hint.length > 5);
  // 连 error 对象都没有时也不能炸
  const n = translateWriteError('/tmp/z.json', undefined);
  assert.equal(n.ok, false);
  assert.ok(n.message.length > 5);
});

test('错误目录：reason 集合可枚举，供文档与脚本判断', () => {
  const reasons = writeFailureReasons();
  assert.ok(reasons.includes('permission-denied'));
  assert.ok(reasons.includes('disk-full'));
  assert.ok(reasons.includes('path-too-long'));
  assert.ok(reasons.includes('write-failed'));
  assert.equal(new Set(reasons).size, reasons.length, 'reason 有重复');
});
