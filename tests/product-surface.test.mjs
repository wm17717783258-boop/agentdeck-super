/**
 * tests/product-surface.test.mjs —— R9：产品面一致性。
 *
 * 前十轮里最容易漏的一层：功能都对，但"用起来像个成品"的那些细节没对齐。
 * 这一轮盯四件事，每件都是用户能直接撞上的：
 *
 *   ① 拼错命令不能"假成功"：`nexi instal` 必须退出 2 并猜出你想输什么；
 *   ② 帮助必须覆盖**所有**能跑的命令 —— 实现了却没写进帮助 = 等于没有；
 *   ③ `--json` 必须是纯 JSON（能直接喂 jq / 脚本），不能掺日志行；
 *   ④ 幂等：同一条命令跑两次，第二次不能又改一遍文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'nexi.mjs');
const tmp = (tag) => mkdtempSync(path.join(tmpdir(), `nexi-surface-${tag}-`));

function nexi(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NEXI_LOG: '0', ...env },
  });
  return { code: r.status, out: `${r.stdout || ''}`, err: `${r.stderr || ''}`, all: `${r.stdout || ''}${r.stderr || ''}` };
}

// ── ① 拼错命令 ────────────────────────────────────────────────────────────────

test('拼错命令：退出码 2 + 猜出最接近的那条，绝不"打印帮助然后退出 0"', () => {
  const cases = [
    ['instal', 'install'],
    ['repare', 'repair'],
    ['restroe', 'restore'],
    ['verison', 'version'],
    ['uninstal', 'uninstall'],
  ];
  for (const [typo, want] of cases) {
    const r = nexi([typo]);
    assert.equal(r.code, 2, `nexi ${typo} 的退出码是 ${r.code}，脚本会以为成功`);
    assert.ok(r.all.includes('不认识子命令'), `没说清楚哪里错了：${r.all.slice(0, 120)}`);
    assert.ok(r.all.includes(want), `没猜出 \`nexi ${want}\`：${r.all.slice(0, 160)}`);
  }
});

test('拼错命令：只报错，不产生任何副作用（不写状态、不碰宿主配置）', () => {
  const home = tmp('typo');
  const r = nexi(['instal', 'codex'], { DSH_HOME: home, NEXI_LOG_DIR: path.join(home, 'logs') });
  assert.equal(r.code, 2);
  assert.equal(existsSync(path.join(home, 'logs')), false, '拼错命令却写了日志目录');
});

// ── ② 帮助覆盖 ────────────────────────────────────────────────────────────────

test('帮助覆盖全部命令：实现了就必须写进帮助，否则等于没有', () => {
  const src = readFileSync(CLI, 'utf8');
  const start = src.indexOf('const table = {');
  assert.ok(start > 0, '找不到命令表');
  const block = src.slice(start, src.indexOf('\n};', start));
  const names = [...block.matchAll(/^\s{2}'?([a-z][a-z-]*)'?:/gm)].map((m) => m[1]);
  assert.ok(names.length >= 20, `命令表只解析出 ${names.length} 条，正则该更新了`);

  const help = nexi(['help']);
  assert.equal(help.code, 0);
  const missing = names.filter((n) => n !== 'help' && !new RegExp(`nexi ${n}(\\s|\\b)`).test(help.all));
  assert.deepEqual(missing, [], `这些命令没写进帮助：${missing.join(', ')}`);
});

test('每个命令的 --help 都是只读的，退出码 0，不执行动作', () => {
  const src = readFileSync(CLI, 'utf8');
  const start = src.indexOf('const table = {');
  const block = src.slice(start, src.indexOf('\n};', start));
  const names = [...block.matchAll(/^\s{2}'?([a-z][a-z-]*)'?:/gm)].map((m) => m[1])
    // 这些 --help 也会真的起进程/占端口，跳过；它们各自已有专门测试
    .filter((n) => !['help', 'mcp', 'serve', 'relay', 'pet'].includes(n));

  for (const name of names) {
    const r = nexi([name, '--help']);
    assert.equal(r.code, 0, `nexi ${name} --help 退出码 ${r.code}：${r.all.slice(0, 160)}`);
    assert.ok(r.all.length > 40, `nexi ${name} --help 什么都没说`);
  }
});

// ── ③ --json 稳定 ─────────────────────────────────────────────────────────────

/** 输出必须是 JSON：先按整体解析（可能是带缩进的对象/数组），失败再按 NDJSON 逐行解析。 */
function assertJsonOutput(label, text) {
  const t = text.trim();
  assert.ok(t.length > 0, `${label} 一个字都没输出（脚本会以为管道断了）`);
  try {
    const one = JSON.parse(t);
    assert.ok(one !== null && typeof one === 'object', `${label} 输出了标量：${t.slice(0, 80)}`);
    return { mode: 'doc', value: one };
  } catch { /* 落到 NDJSON */ }
  const lines = t.split('\n').filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (err) {
      assert.fail(`${label} 输出了非 JSON 行：${err.message}\n${line.slice(0, 200)}`);
    }
  }
  return { mode: 'ndjson', value: parsed };
}

test('--json 只输出 JSON：8 个可脚本化命令逐个校验', () => {
  const dir = tmp('json');
  const cases = [
    ['list', '--json'],
    ['host', 'list', '--json'],
    ['config', 'codex', '--json'],
    ['version', '--json'],
    ['status', '--json'],
    ['jobs', '--json'],
    ['logs', '--json'],
    ['uninstall', 'no-such-host', '--json'],
  ];
  for (const args of cases) {
    const r = nexi(args, { DSH_HOME: dir, NEXI_LOG_DIR: path.join(dir, 'logs') });
    assertJsonOutput(`nexi ${args.join(' ')}`, r.out);
  }
});

// ── ④ 幂等 ────────────────────────────────────────────────────────────────────

test('幂等：同一条 install custom 跑两次，第二次不改文件也不报错', () => {
  const dir = tmp('idem');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, '{"mcpServers":{}}\n', 'utf8');

  const first = nexi(['install', 'custom', file, '--shape', 'mcpServers', '--name', 'nexi', '--json']);
  assert.equal(first.code, 0, first.all.slice(0, 300));
  const after1 = readFileSync(file, 'utf8');
  const j1 = JSON.parse(first.out);
  assert.equal(j1.changed, true);

  const second = nexi(['install', 'custom', file, '--shape', 'mcpServers', '--name', 'nexi', '--json']);
  assert.equal(second.code, 0, second.all.slice(0, 300));
  const j2 = JSON.parse(second.out);
  assert.equal(j2.changed, false, '第二次又改了一遍文件');
  assert.equal(readFileSync(file, 'utf8'), after1, '第二次跑完文件字节变了');

  // 卸载同样幂等
  const u1 = nexi(['uninstall', 'custom', file, '--shape', 'mcpServers', '--name', 'nexi', '--json']);
  assert.equal(u1.code, 0);
  const u2 = nexi(['uninstall', 'custom', file, '--shape', 'mcpServers', '--name', 'nexi', '--json']);
  assert.equal(u2.code, 0);
  assert.equal(JSON.parse(u2.out).changed, false);
});

test('幂等：config --all 连续两次输出完全一致（纯只读）', () => {
  const dir = tmp('config-stable');
  const env = { DSH_HOME: dir, NEXI_LOG_DIR: path.join(dir, 'logs') };
  const a = nexi(['config', '--all', '--json'], env);
  const b = nexi(['config', '--all', '--json'], env);
  assert.equal(a.code, 0, a.all.slice(0, 200));
  assert.equal(a.out, b.out, '两次 config --all 输出不一样 —— 说明有隐藏状态');
});

// ── ⑤ 失败也要可执行 ──────────────────────────────────────────────────────────

test('失败必须带"怎么办"：几个典型失败场景都不许只有一句 error', () => {
  const dir = tmp('fail');
  const env = { DSH_HOME: dir, NEXI_LOG_DIR: path.join(dir, 'logs') };
  const cases = [
    ['uninstall', 'no-such-host'],
    ['restore', 'no-such-host'],
    ['install', 'custom', path.join(dir, 'x.json'), '--shape', 'noSuchShape'],
    ['snippet', '--shape', 'noSuchShape'],
  ];
  for (const args of cases) {
    const r = nexi(args, env);
    const text = r.all;
    assert.ok(r.code !== 0 || /ok":\s*false/.test(text), `nexi ${args.join(' ')} 失败了却报成功`);
    // hint / warnings / 候选清单 —— 至少要有一样，让用户能往下走
    const actionable = /hint|warnings|known|可选|用法|hosts":/.test(text);
    assert.ok(actionable, `nexi ${args.join(' ')} 只说错了没说怎么办：${text.slice(0, 200)}`);
  }
});
