/**
 * tests/security-attack.test.mjs —— R8：安全攻击面。
 *
 * 前面几轮都在验「正常用户正常用」。这一轮换位置：假设有人**故意**喂坏东西进来，
 * 或者用户的环境本身就是敌意的（路径里有空格、有 `&`、有 `%`）。
 *
 * 六个面，每个面都对应一个真实会发生的场景：
 *   ① 命令注入：Windows 上 .cmd 垫片要过 cmd.exe，参数里一个 `&` 就能挂上第二条命令；
 *   ② 路径遍历：`host rm ../../x` 不该删到注册表目录外面去；
 *   ③ 配置注入：宿主名/命令里塞换行和引号，不能把 YAML/TOML/JSON 结构撑破；
 *   ④ 日志泄密：URL 里的 token、Bearer、sk-、JWT、长十六进制都要洗掉；
 *   ⑤ 自卸载越界：家目录、盘根、家目录上级一律不许删；
 *   ⑥ 锁文件权限：同机其他用户不该看到锁内容。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildWindowsCommandLine, needsCmdShim, quoteWindowsArg, spawnTool, unsafeArgsReason,
} from '../lib/connect/exec.js';
import { adHocHost, installHost, buildSnippet, launchCommand } from '../lib/connect/hosts.js';
import { loadCustomHosts, removeCustomHost, saveCustomHost } from '../lib/connect/registry.js';
import { redactText, logEvent, logsDir } from '../lib/log.js';
import { unsafeReason } from '../lib/selfremove.js';
import { withFileLock, lockPathFor } from '../lib/connect/lock.js';

const IS_WIN = process.platform === 'win32';
const tmp = (tag) => mkdtempSync(path.join(tmpdir(), `nexi-sec-${tag}-`));

// ── ① 命令注入 ────────────────────────────────────────────────────────────────

test('cmd 引号：带空格/引号/元字符的参数会被完整包住，不会被断开', () => {
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('with space'), '"with space"');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('a&b'), '"a&b"');
  assert.equal(quoteWindowsArg('a|b'), '"a|b"');
  assert.equal(quoteWindowsArg('a>b'), '"a>b"');
  assert.equal(quoteWindowsArg('a^b'), '"a^b"');
  // 内部引号按 cmd 的规矩写成两个
  assert.equal(quoteWindowsArg('say "hi"'), '"say ""hi"""');
});

test('cmd 命令行：拼出来的每一段都是独立参数，元字符全在引号里', () => {
  const line = buildWindowsCommandLine(['C:\\a b\\t.cmd', 'mcp', 'add', 'x&calc']);
  assert.equal(line, '"C:\\a b\\t.cmd" mcp add "x&calc"');
  // 关键：`&` 不能出现在任何引号外面，否则 cmd 会把后面当第二条命令
  const outside = line.replace(/"[^"]*"/g, '');
  assert.equal(/[&|<>^]/.test(outside), false, `引号外还有元字符：${outside}`);
});

test('cmd 不可安全转义的参数：直接判 unsafe，不硬拼', () => {
  // 这些字符连引号都挡不住：npm 垫片里的 `%*` 会原样展开，cmd 再解析一遍
  for (const bad of ['a%PATH%b', 'a\nb', 'x&calc', 'x|calc', 'x>y', 'x^y', 'x<y']) {
    assert.ok(unsafeArgsReason([bad]), `没拒绝：${JSON.stringify(bad)}`);
  }
  // 空格和普通引号是可以安全处理的
  assert.equal(unsafeArgsReason(['a b', 'C:\\x"y']), null);
  assert.equal(needsCmdShim('C:\\x\\tool.cmd'), IS_WIN);
  assert.equal(needsCmdShim('C:\\x\\tool.exe'), false);
});

test('真起一个垫片：路径和参数里有空格、路径里有中文也能跑通', {
  skip: !IS_WIN && '垫片只有 Windows 有；POSIX 走直接 exec，没有这层解析',
}, () => {
  const dir = tmp('shim ok'); // 目录名本身也带空格（tmpdir 里通常还有中文用户名）
  const out = path.join(dir, 'argv.txt');
  const shim = path.join(dir, 'probe shim.cmd'); // 脚本名也带空格
  // 垫片里用 %~dp0 而不是写死路径 —— 真实 npm 垫片就是这么写的，
  // 写死中文路径会踩 cmd 的代码页（UTF-8 的 .cmd 被按 GBK 解析）。
  writeFileSync(shim, ['@echo off', 'echo %* > "%~dp0argv.txt"', ''].join('\r\n'), 'utf8');

  const r = spawnTool(shim, ['mcp', 'add', 'my name', dir], { timeout: 20_000 });
  assert.equal(r.via, 'cmd');
  assert.equal(r.code, 0, `垫片没跑起来：${r.out} ${r.err}`);

  const recorded = existsSync(out) ? readFileSync(out, 'utf8') : '';
  // 注意：cmd 的 echo 按控制台代码页（简中是 936）吐字，中文回读到 UTF-8 里是乱码。
  // 这**不影响**参数传递（子进程拿的是 UTF-16 argv），只是回显编码不同。
  // 所以这里断言结构：空格没被切断、每个参数都在自己那对引号里。
  assert.ok(recorded.includes('my name'), `带空格的参数被切断了：${JSON.stringify(recorded)}`);
  assert.ok(/nexi-sec-shim ok-/.test(recorded), `带空格的目录名被切断了：${JSON.stringify(recorded)}`);
  assert.equal((recorded.match(/"/g) || []).length >= 4, true, `引号结构丢了：${JSON.stringify(recorded)}`);
});

test('cmd 命令行：非 ASCII 路径原样保留，不会在拼串时被转成别的编码', () => {
  const p = 'C:\\Users\\王冕\\工作目录\\nexi.mjs';
  const line = buildWindowsCommandLine([p]);
  assert.equal(line, p, `中文被吞或被转义了：${line}`);
  // 带空格的中文路径则要加引号，且引号里内容不变
  const withSpace = buildWindowsCommandLine(['C:\\Users\\王冕\\工作 目录\\nexi.mjs']);
  assert.equal(withSpace, '"C:\\Users\\王冕\\工作 目录\\nexi.mjs"');
});

test('注入尝试：带 & 的参数根本不会交给 shell，marker 不会被创建', {
  skip: !IS_WIN && '只有 Windows 会过 cmd',
}, () => {
  const dir = tmp('shim evil');
  const marker = path.join(dir, 'INJECTED.txt');
  const shim = path.join(dir, 'probe.cmd');
  writeFileSync(shim, ['@echo off', 'exit /b 0', ''].join('\r\n'), 'utf8');

  const evil = `x& echo INJECTED > "${marker}"`;
  const r = spawnTool(shim, ['mcp', 'add', evil], { timeout: 20_000 });
  assert.equal(r.ok, false, '居然照跑了');
  assert.ok(r.unsafe, '没标出这是不安全参数');
  assert.equal(existsSync(marker), false, '注入的命令被执行了！');
});

test('参数里有 % 时：spawnTool 拒跑并说明原因，而不是让 cmd 去展开', () => {
  if (!IS_WIN) return; // 只有 Windows 会过 cmd
  const r = spawnTool('C:\\whatever\\tool.cmd', ['a%PATH%b']);
  assert.equal(r.ok, false);
  assert.ok(r.unsafe, '没标出来不安全');
  assert.match(r.err, /%/, '没说清是哪个字符的问题');
});

// ── ② 路径遍历 ────────────────────────────────────────────────────────────────

test('自定义宿主 id：斜杠、点、绝对路径、大写一律拒绝，写不出注册表目录', () => {
  const dir = tmp('reg');
  const bad = ['../evil', '..\\evil', '/etc/passwd', 'C:\\x', 'A-Upper', 'a', 'con', 'a b', 'a/b'];
  for (const id of bad) {
    const r = saveCustomHost({ id, label: id, shape: 'mcpServers', paths: ['/tmp/x.json'] }, { dir });
    assert.equal(r.ok, false, `id 被接受了：${id}`);
  }
  assert.deepEqual(loadCustomHosts({ dir }).hosts, [], '有东西被写进注册表了');
});

test('host rm 不能越界删除：id 里带 ../ 直接拒绝，外部文件必须还在', () => {
  const dir = tmp('reg-rm');
  const hosts = path.join(dir, 'hosts.d');
  mkdirSync(hosts, { recursive: true });
  const victim = path.join(dir, 'victim.json');
  writeFileSync(victim, '{"important":true}', 'utf8');

  // 从 hosts.d 往上跳两级就能指到 victim.json
  const r = removeCustomHost('../victim', { dir: hosts });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-id');
  assert.equal(existsSync(victim), true, '越界删掉了注册表外面的文件');

  // 正常 id 还是要能删
  writeFileSync(path.join(hosts, 'ok-host.json'), '{}', 'utf8');
  const ok = removeCustomHost('ok-host', { dir: hosts });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(existsSync(path.join(hosts, 'ok-host.json')), false);
});

// ── ③ 配置注入 ────────────────────────────────────────────────────────────────

test('YAML：宿主名里塞换行/冒号/井号，撑不破结构', () => {
  const launch = { command: 'node', args: ['/x/nexi.mjs', 'mcp'], env: {} };
  const evil = 'x\nextensions:\n  pwn:\n    cmd: calc';
  const text = buildSnippet({ shape: 'yaml.extensions', launch, name: evil });
  const lines = text.split('\n');
  // 名字只允许出现在一处，且必须还在 `extensions:` 的缩进里
  const pwn = lines.filter((l) => /^\s*pwn:/.test(l));
  assert.equal(pwn.length, 1, `注入多出了一个 pwn 表：\n${text}`);
  assert.ok(pwn[0].startsWith('    ') || pwn[0].startsWith('  '), `pwn 跑出了缩进：${pwn[0]}`);
  // 名字被当成一个双引号标量，换行变成 \n 转义，不会被折断成新行
  const nameLine = lines.find((l) => l.includes('x\\nextensions'));
  assert.ok(nameLine, `名字没被转义：\n${text}`);
});

test('TOML：命令里带引号和换行，仍是单行合法值', () => {
  const dir = tmp('toml-inject');
  const file = path.join(dir, 'config.toml');
  writeFileSync(file, 'model = "gpt-5"\n', 'utf8');
  const host = adHocHost({ id: 'custom', kind: 'toml', path: file });
  const r = installHost('custom', {
    host,
    path: file,
    launch: { command: 'node"\n[mcp_servers.pwn]\ncommand = "calc', args: [], env: {} },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const text = readFileSync(file, 'utf8');
  const pwnTables = text.split('\n').filter((l) => /^\s*\[mcp_servers\.pwn\]\s*$/.test(l));
  assert.equal(pwnTables.length, 0, `注入出了第二张表：\n${text}`);
  // 每个表头都必须独占一行、成对
  const startCount = text.split('\n').filter((l) => l.includes('# >>> nexi')).length;
  const endCount = text.split('\n').filter((l) => l.includes('# <<< nexi')).length;
  assert.equal(startCount, 1);
  assert.equal(endCount, 1);
});

test('JSON：name 里带引号和花括号，不破坏配置文件结构', () => {
  const dir = tmp('json-inject');
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, '{"mcpServers":{}}\n', 'utf8');
  const host = adHocHost({ id: 'custom', shape: 'mcpServers', path: file });
  const evilName = 'a","b":{}},"x":{"c":"';
  const r = installHost('custom', { host, path: file, name: evilName });
  assert.equal(r.ok, true, JSON.stringify(r));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.keys(data.mcpServers).length, 1, '注入出了额外的 key');
  assert.ok(data.mcpServers[evilName], '名字没有被原样保留');
});

// ── ④ 日志泄密 ────────────────────────────────────────────────────────────────

test('日志脱敏：URL token / Bearer / sk- / JWT / 长十六进制都洗掉', () => {
  const samples = [
    ['https://relay.example/?room=r1&token=abcdef123456', 'abcdef123456'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', 'eyJhbGciOiJIUzI1NiJ9'],
    ['nexi login --token sk-live-ABCDEFGH12345', 'sk-live-ABCDEFGH12345'],
    ['jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP', 'dBjftJeZ4CVP'],
    ['device id 9f8e7d6c5b4a39281706f5e4d3c2b1a0', '9f8e7d6c5b4a39281706f5e4d3c2b1a0'],
  ];
  for (const [text, secret] of samples) {
    const out = redactText(text);
    assert.equal(out.includes(secret), false, `没洗掉 ${secret}：${out}`);
    assert.ok(out.includes('已隐去'), `没说清被隐去了：${out}`);
  }
  // 正常内容不能误伤
  assert.equal(redactText('nexi install codex 完成'), 'nexi install codex 完成');
  assert.equal(redactText('https://example.com/docs'), 'https://example.com/docs');
});

test('日志落盘：写进去的 token 在文件里找不到原文', () => {
  const dir = tmp('log');
  const env = { ...process.env, NEXI_LOG_DIR: dir, NEXI_LOG: '1' };
  logEvent('info', 'pair', {
    note: '连接 https://relay/?room=abc&token=SUPERSECRET123',
    auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaaa.bbbb',
  }, { env });

  const logDir = logsDir(env);
  const names = readdirSync(logDir).filter((n) => /^nexi-\d{8}\.log$/.test(n));
  assert.equal(names.length, 1, `日志没落盘：${readdirSync(logDir).join(',')}`);
  const text = readFileSync(path.join(logDir, names[0]), 'utf8');

  assert.ok(!text.includes('SUPERSECRET123'), 'URL 里的 token 明文进日志了');
  assert.ok(!text.includes('eyJhbGciOiJIUzI1NiJ9.aaaa.bbbb'), 'Bearer 明文进日志了');
  assert.ok(text.includes('已隐去'), '连"隐去过"的痕迹都没有，可能整条都没写');
});

// ── ⑤ 自卸载越界 ──────────────────────────────────────────────────────────────

test('自卸载：家目录、盘根、家目录上级、名字不对的目录一律不删', () => {
  const home = IS_WIN ? 'C:\\Users\\tester' : '/home/tester';
  const cases = [
    [home, '家目录本身'],
    [IS_WIN ? 'C:\\' : '/', '盘根'],
    [path.dirname(home), '家目录上级'],
    [path.join(home, 'Documents'), '名字里没有 nexi'],
  ];
  for (const [target, why] of cases) {
    const r = unsafeReason(target, { home });
    assert.ok(r, `${why}居然被判成可删：${target}`);
  }
  // 正常的安装目录/状态目录要允许
  assert.equal(unsafeReason(path.join(home, 'AppData', 'Local', 'Nexi'), { home }), null);
  assert.equal(unsafeReason(path.join(home, '.dsh', 'agentdeck-super'), { home }), null);
});

// ── ⑥ 锁文件权限 ──────────────────────────────────────────────────────────────

test('锁文件只给自己看：创建后权限不超过 0600', {
  skip: IS_WIN && 'Windows 不看 POSIX mode；等价保护走 ACL',
}, () => {
  const dir = tmp('lock-mode');
  const file = path.join(dir, 'config.json');
  writeFileSync(file, '{}\n', 'utf8');
  const r = withFileLock(file, () => 'ok', { waitMs: 1000 });
  assert.equal(r.lock, 'acquired');
  const lock = lockPathFor(file);
  const mode = statSync(lock).mode & 0o777;
  assert.equal(mode & 0o077, 0, `锁文件对同组/其他人可读：${mode.toString(8)}`);
  chmodSync(lock, 0o600);
});

// ── ⑦ 顺带钉一条：launch 命令不带 shell 元字符也能正常生成 ────────────────────

test('launchCommand：路径里有空格时仍然是一个参数', () => {
  const l = launchCommand({ node: IS_WIN ? 'C:\\Program Files\\nodejs\\node.exe' : '/opt/my node/bin/node' });
  assert.equal(Array.isArray(l.args), true);
  assert.equal(typeof l.command, 'string');
  assert.equal(l.args.includes('mcp'), true, `参数被切碎了：${JSON.stringify(l.args)}`);
});
