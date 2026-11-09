/**
 * tests/acceptance-tooling.test.mjs —— 验收工具链自己的正确性
 *
 * 发布前靠 verify-acceptance.mjs 判断"能不能发"，它算错等于发错。
 * 这里盯三件事：
 *   ① 硬编码的演示路径不许再出现（真机上别人跑不了）
 *   ② 纯 JS 解包替代外部 tar（Windows 中文路径会打不开）
 *   ③ 验收脚本必须能诚实跳过（缺 dsh 时标跳过而不是失败）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEvidenceCounts } from '../tools/lib-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const TOOLS = join(PKG, 'tools');

const SCRIPTS = readdirSync(TOOLS).filter((f) => /^verify-.*\.mjs$/.test(f));

test('验收脚本不再把演示路径写死（D:\\demo 这类）', () => {
  const offenders = [];
  for (const f of SCRIPTS) {
    const src = readFileSync(join(TOOLS, f), 'utf8');
    // 注释也算：换一台电脑时，注释里的绝对路径同样会把维护者带沟里。
    if (/(?:[A-Za-z]:[\\/]{1,2}(?:demo|agentdeck-super)|[A-Za-z]:[\\/]{1,2}demo[\\/])/i.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `这些脚本还写死了本机路径：${offenders.join(', ')}`);
});

test('测试汇总脚本显式枚举 tests 文件，不把 glob 交给 Node', () => {
  const src = readFileSync(join(TOOLS, 'test-summary.mjs'), 'utf8');
  assert.ok(/readdirSync/.test(src), '应该用 readdirSync 枚举测试文件');
  assert.ok(/\.\.\.files/.test(src), '应该把真实文件数组传给 node --test');
  assert.ok(
    /spawnSync\(process\.execPath,\s*\['--test',\s*'--test-concurrency=1',\s*\.\.\.files\]/.test(src),
    'spawn 参数里不能再把 glob 当字面文件名',
  );
});

test('回归门禁也显式枚举 tests 文件，不把 glob 交给 Node', () => {
  const src = readFileSync(join(TOOLS, 'verify-security.mjs'), 'utf8');
  assert.ok(/function expandTests/.test(src), '应该有 expandTests 把模式展开成真实文件');
  assert.ok(/readdirSync/.test(src), '应该用 readdirSync 枚举测试文件');
  assert.ok(/\.\.\.files/.test(src), '应该把真实文件数组传给 node --test');
  assert.ok(
    !/runTest\('tests\/\*\.test\.mjs'\)/.test(src),
    '不能再把 tests/*.test.mjs 作为单个字面参数交给 Node',
  );
});

test('验收总控识别非 PATH 的 dsh（桌面版安装位置）', () => {
  const src = readFileSync(join(TOOLS, 'verify-acceptance.mjs'), 'utf8');
  assert.ok(/AGENT_PRESETS/.test(src), '应该复用 Agent 预设里的额外搜索路径');
  assert.ok(/resolveCommand/.test(src), '应该用 resolveCommand 而不是只查 where');
  assert.ok(/expandNodeTests/.test(src), '应该把 nodeTest glob 展开成真实文件');
});

test('验收脚本不再调系统 tar（改用 lib/untar.js）', () => {
  const offenders = [];
  for (const f of SCRIPTS) {
    const src = readFileSync(join(TOOLS, f), 'utf8');
    if (/spawnSync\(\s*['"`]tar['"`]/.test(src) || /spawn\(\s*['"`]tar['"`]/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `这些脚本还在调外部 tar：${offenders.join(', ')}`);
});

test('verify-portable 不能只验 initialize 就报通过', () => {
  const src = readFileSync(join(TOOLS, 'verify-portable.mjs'), 'utf8');
  assert.ok(/HUB_TOOL_ORDER/.test(src), '应该以真实工具表作为期望值');
  assert.ok(/tools\/list/.test(src), 'initialize 之后必须主动请求 tools/list');
  assert.ok(/expectedTools/.test(src), '应该计算期望工具数');
  assert.ok(
    /count\s*!==\s*expectedTools|count\s*==\s*expectedTools|count\s*<>\s*expectedTools/.test(src),
    '必须比较 tools/list 的工具数量，不能收到 initialize 就结束',
  );
  assert.ok(/initialize 响应缺 serverInfo/.test(src), '仍要检查 initialize 的基本响应');
});

test('verify-acceptance 在缺 dsh 时标「跳过」而不是「失败」', () => {
  const src = readFileSync(join(TOOLS, 'verify-acceptance.mjs'), 'utf8');
  assert.ok(/needsCommand/.test(src), '应该有 needsCommand 前置检查');
  assert.ok(/function hasCommand/.test(src), '应该探测命令是否存在');
  assert.ok(/status: 'skipped'/.test(src), '缺前置时应该标 skipped');
});

test('verify-acceptance 能读证据文件里的计数（不只读 stdout）', () => {
  const src = readFileSync(join(TOOLS, 'verify-acceptance.mjs'), 'utf8');
  assert.ok(/evidenceText/.test(src), '应该读证据文件内容');
  assert.ok(/parseEvidenceCounts/.test(src), '应该调用统一的证据计数解析器');
});

test('verify-acceptance 不会把 stdout 和证据文件里的同一批断言数两遍', () => {
  const src = readFileSync(join(TOOLS, 'verify-acceptance.mjs'), 'utf8');
  assert.ok(
    /const countText = evidenceText\.trim\(\) \? evidenceText : out/.test(src),
    '有证据文本时必须只统计证据，不能把 stdout 和证据拼接后重复计数',
  );
  assert.ok(
    !/haystack = `\$\{out\}\\n\$\{evidenceText\}`/.test(src),
    '不能再把 stdout 和 evidenceText 直接拼接成 haystack',
  );
});

test('证据计数优先认结论句，不把表格和命令回显里的 ✅ 算成断言', () => {
  const m4 = [
    '| claude-code | ✅ | 第 1 条 |',
    '| codex | ✅ | 第 2 条 |',
    '$ nexi approve apr_x → ✅ 已执行',
    '',
    '## 4. 断言',
    '',
    '- ✅ 先建小组',
    '- ✅ 三个进程都连上',
    '- ✅ 审批放行后真执行（回显：✅ 已执行）',
    '',
    '**结论：3 项断言全过——其余都是回显。**',
  ].join('\n');
  assert.deepEqual(parseEvidenceCounts(m4), { pass: 3, fail: 0, source: 'conclusion' });
});

test('证据计数认标准结论：N 项通过，M 项失败', () => {
  const text = [
    '  ✅ 第 1 条（回显里还有 ✅ 不算）',
    '  ✅ 第 2 条',
    '  ✅ 第 3 条',
    '',
    '结论：26 项通过，0 项失败',
  ].join('\n');
  assert.deepEqual(parseEvidenceCounts(text), { pass: 26, fail: 0, source: 'conclusion' });
});

test('证据没有结论时只数断言区的独立断言行', () => {
  const text = [
    '## 3. 过程',
    '命令回显 → ✅ 成功',
    '| 项 | 结果 |',
    '| --- | --- |',
    '| A | ✅ |',
    '',
    '## 4. 断言',
    '- ✅ 只有这一条算',
    '- ❌ 这一条真失败',
    '',
    '## 5. 收摊',
    '收尾回显 ✅ 也不算',
  ].join('\n');
  assert.deepEqual(parseEvidenceCounts(text), { pass: 1, fail: 1, source: 'section' });
});

test('证据写"N 项断言里 M 项没过"时换算真实通过数', () => {
  assert.deepEqual(
    parseEvidenceCounts('**结论：17 项断言里 2 项没过，不算通过。**'),
    { pass: 15, fail: 2, source: 'conclusion' },
  );
});

test('测试日志优先读 pass/fail 汇总，不把测试名里的 ✅ 算成断言', () => {
  const text = [
    '· 结果：tests 1033 / pass 1018 / fail 0 / skipped 15 / 退出码 0',
    '',
    '✔ 证据计数优先认结论句，不把表格和命令回显里的 ✅ 算成断言 (0.446ms)',
  ].join('\n');
  assert.deepEqual(parseEvidenceCounts(text), { pass: 1018, fail: 0, source: 'summary' });
});

test('表格型证据按断言行里的结果计数', () => {
  const text = [
    '## 5. 断言',
    '',
    '| # | 断言 | 结果 | 证据 |',
    '| --- | --- | --- | --- |',
    '| 1 | 页面仍然 200 | ✅ | HTTP 200 |',
    '| 2 | 工具数一致 | ✅ | 23 |',
    '| 3 | 篡改被拒 | ❌ | 被放行 |',
    '',
    '## 6. 收摊',
    '正文回显 ✅ 不算',
  ].join('\n');
  assert.deepEqual(parseEvidenceCounts(text), { pass: 2, fail: 1, source: 'table' });
});

test('verify-acceptance --list 能跑，且列出所有项', () => {
  const r = spawnSync(process.execPath, [join(TOOLS, 'verify-acceptance.mjs'), '--list'], {
    cwd: PKG, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  const text = r.stdout;
  for (const id of ['tests', 'twomachines', 'readonly', 'mandate', 'hosting', 'portable']) {
    assert.ok(text.includes(id), `清单里应该列出 ${id}`);
  }
});

test('只读模式验收脚本不依赖 dsh（能独立跑）', () => {
  const src = readFileSync(join(TOOLS, 'verify-readonly-core.mjs'), 'utf8');
  assert.ok(!/spawn\(\s*['"`]cmd\.exe['"`]/.test(src), '不该起 cmd 去调 dsh');
  assert.ok(/createMcpEngine/.test(src), '应该直接用 MCP 引擎验');
});

test('工具链文件都在（别被清理脚本误删）', () => {
  for (const f of ['verify-acceptance.mjs', 'verify-readonly-core.mjs', 'lib-evidence.mjs', 'pack-clean.mjs', 'pack-trim.mjs']) {
    assert.ok(existsSync(join(TOOLS, f)), `缺 ${f}`);
  }
  assert.ok(existsSync(join(PKG, 'lib', 'untar.js')), '缺 lib/untar.js');
});

test('跨机验收脚本不依赖用户家目录的签发私钥（任何机器都能跑）', () => {
  const src = readFileSync(join(TOOLS, 'verify-crosshost.mjs'), 'utf8');
  // 不许再读 ~/.agentdeck-issuer 的私钥（从没发过码的机器上必然失败）
  assert.ok(
    !/issuer-private\.pem/.test(src),
    '还在依赖 ~/.agentdeck-issuer/issuer-private.pem：换台机器就跑不了',
  );
  assert.ok(/generateKeyPairSync\('ed25519'\)/.test(src), '应该现场生成测试密钥');
  assert.ok(/AGENTDECK_LICENSE_PUBKEY/.test(src), '应该把测试公钥传给子进程和 relay');
});

test('跨机验收脚本走真网络地址（不是 127.0.0.1 走环回）', () => {
  const src = readFileSync(join(TOOLS, 'verify-crosshost.mjs'), 'utf8');
  assert.ok(/lanAddress|networkInterfaces/.test(src), '应该探测局域网地址');
  assert.ok(/NEXI_RELAY_HOST/.test(src), '应该允许用环境变量指定绑哪个地址');
});

test('外部真宿主 e2e 测试必须显式指定地址，不能自动嗅探固定端口', () => {
  for (const file of ['e2e-all-actions.test.mjs', 'e2e-deck-buttons.test.mjs']) {
    const src = readFileSync(join(PKG, 'tests', file), 'utf8');
    assert.ok(/EXPLICIT_BASE/.test(src), `${file} 应该区分显式地址与默认端口`);
    assert.ok(/function skipExternal/.test(src), `${file} 应该有统一的跳过闸门`);
    assert.ok(
      /if \(skipExternal\(t\)\) return;/.test(src) || /if \(!EXPLICIT_BASE\)/.test(src),
      `${file} 没设置地址时必须跳过，不能默认去撞 58399`,
    );
  }
});
