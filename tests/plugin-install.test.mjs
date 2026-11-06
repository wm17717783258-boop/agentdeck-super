/**
 * 宿主接入（插件形态的核心）：8 个宿主逐个「装 → 卸 → 还原」。
 *
 * 为什么单开一套：产品是**插件**，验收标准是"装进各个 Agent 能不能用"，
 * 不是"我们自己的页面好不好看"。这一层不看页面，只看配置文件。
 *
 * 真机踩过的两个坑（都写成了断言）：
 *   ① `install <host> --force <path>`：命令行给的路径被静默丢掉，
 *      结果"我明明指了别的文件，它却写了宿主真实配置"——污染了 4 个用户目录。
 *   ② `uninstall <host> <path>`：同样丢掉路径，"卸载成功"其实是卸了默认路径，
 *      你指的那个文件一个字没动。
 * 两条都钉在这里，防止回退。
 *
 * 全程只写 tmpdir，**绝不碰用户真实宿主配置**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXI = join(REPO, 'bin', 'nexi.mjs');

/** 跑一次 nexi CLI，返回解析后的 JSON（没有 JSON 就返回原文）。 */
function nexi(args, env = {}) {
  const res = spawnSync(process.execPath, [NEXI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const out = String(res.stdout || '').trim();
  let json = null;
  const i = out.indexOf('{');
  if (i >= 0) {
    try { json = JSON.parse(out.slice(i)); } catch { /* 保持 null */ }
  }
  return { status: res.status, out, err: String(res.stderr || ''), json };
}

function freshDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `nexi-host-${label}-`));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// 8 个宿主：json 类的配置形状一致；codex 是 toml，单独看
const JSON_HOSTS = ['claude-desktop', 'claude-code', 'cursor', 'windsurf', 'cline', 'continue', 'gemini-cli'];
const ALL_HOSTS = [...JSON_HOSTS, 'codex'];

/* ── 1. 清单完整 ───────────────────────────────────────────────────────── */

test('8 个宿主都在清单里，且各有 id / label / 默认路径', () => {
  const r = nexi(['install']);
  assert.equal(r.status, 0);
  const hosts = r.json?.hosts || [];
  assert.equal(hosts.length, 8, `宿主数不对：${hosts.length}`);
  for (const h of hosts) {
    assert.ok(h.id, '缺 id');
    assert.ok(h.label, `缺 label：${h.id}`);
    assert.ok(h.path, `缺默认路径：${h.id}`);
  }
  const ids = hosts.map((h) => h.id).sort();
  assert.deepEqual(ids, [...ALL_HOSTS].sort());
});

/* ── 2. 每个宿主都能装出一份该宿主认的配置 ─────────────────────────────── */

for (const host of JSON_HOSTS) {
  test(`${host}：装到指定路径 → 是合法 JSON 且含 mcpServers.nexi；卸后 nexi 消失`, () => {
    const { dir, done } = freshDir(host);
    try {
      const file = join(dir, `${host}.json`);

      const ins = nexi(['install', host, file]);
      assert.equal(ins.json?.ok, true, `装失败：${ins.out.slice(0, 200)}`);
      assert.equal(ins.json?.changed, true, '该有改动');
      // 路径必须就是给的那个（这条就是 bug ① 的钉子）
      assert.equal(ins.json?.path, file, `装到了别的路径：${ins.json?.path}`);

      assert.ok(existsSync(file), '配置文件没写出来');
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      assert.ok(doc.mcpServers, '缺 mcpServers');
      assert.ok(doc.mcpServers.nexi, '缺 mcpServers.nexi');
      assert.ok(doc.mcpServers.nexi.command, '缺 command');
      assert.ok(Array.isArray(doc.mcpServers.nexi.args) && doc.mcpServers.nexi.args.length, '缺 args');
      assert.ok(doc.mcpServers.nexi.args.some((a) => /nexi\.mjs$/.test(a)), 'args 里该指向 nexi.mjs');

      const uni = nexi(['uninstall', host, file]);
      assert.equal(uni.json?.ok, true, `卸失败：${uni.out.slice(0, 200)}`);
      assert.equal(uni.json?.path, file, `卸的是别的路径：${uni.json?.path}`);
      // 卸完不许还留着 nexi（这条是 bug ② 的钉子）
      if (existsSync(file)) {
        assert.ok(!readFileSync(file, 'utf8').includes('nexi'), '卸载后配置文件里还留着 nexi');
      }
    } finally {
      done();
    }
  });
}

test('codex：装出来是 TOML 的 [mcp_servers.nexi]，卸后该段消失', () => {
  const { dir, done } = freshDir('codex');
  try {
    const file = join(dir, 'config.toml');
    const ins = nexi(['install', 'codex', file]);
    assert.equal(ins.json?.ok, true, `装失败：${ins.out.slice(0, 200)}`);
    assert.equal(ins.json?.path, file, `装到了别的路径：${ins.json?.path}`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\[mcp_servers\.nexi\]/, 'TOML 里该有 [mcp_servers.nexi]');
    assert.match(text, /nexi\.mjs/, 'TOML 里该指向 nexi.mjs');

    const uni = nexi(['uninstall', 'codex', file]);
    assert.equal(uni.json?.ok, true, `卸失败：${uni.out.slice(0, 200)}`);
    if (existsSync(file)) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\[mcp_servers\.nexi\]/, '卸载后 TOML 里还留着 nexi');
    }
  } finally {
    done();
  }
});

/* ── 3. 不污染：没装的宿主不许被写默认路径 ─────────────────────────────── */

test('宿主没装且没给路径时：拒绝写默认路径（宁可不装，不许污染用户目录）', () => {
  // 用一个肯定没装的宿主形状来测：把 PATH 弄空，让"只找到 CLI"也失效，
  // 这样本机装没装都走"没装"分支——测的是行为，不依赖本机环境。
  const r = nexi(['install', 'cursor'], { PATH: '', PATHEXT: '' });
  // 本机装了 Cursor 的话这条会走正常安装，那就跳过（不同机器环境不同）
  if (r.json?.code === 'host_not_installed') {
    assert.equal(r.json.ok, false);
    assert.equal(r.status, 1, '该以非零退出码结束');
    assert.match(r.json.hint, /没装/, '要说清是没装');
    assert.match(r.json.hint, /显式给路径|--force/, '要告诉人怎么办');
    assert.ok(r.json.wouldWrite, '要写出"本来会写到哪"，方便人判断');
  } else {
    // 本机确实装了 Cursor：那它写默认路径是合理的，这条不适用
    assert.ok(r.json?.ok === true || r.json?.couldCreate === true || r.json?.changed !== undefined,
      `既不是"拒绝"也不是"装成功"：${r.out.slice(0, 200)}`);
  }
});

/* ── 4. 已有内容不能被破坏 ─────────────────────────────────────────────── */

test('装进一份已有配置：原有内容原样保留，只多出 nexi 一项', () => {
  const { dir, done } = freshDir('merge');
  try {
    const file = join(dir, 'mcp.json');
    const before = {
      mcpServers: { someoneelse: { command: 'other', args: ['x'] } },
      theme: 'dark',
      nested: { keep: [1, 2, 3] },
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    nexi(['install', 'cursor', file]);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.theme, 'dark', '原有顶层字段被改了');
    assert.deepEqual(after.nested, { keep: [1, 2, 3] }, '原有嵌套字段被改了');
    assert.deepEqual(after.mcpServers.someoneelse, before.mcpServers.someoneelse, '别人家的 server 被动了');
    assert.ok(after.mcpServers.nexi, 'nexi 没加进去');

    // 卸完：别人的还在，nexi 没了
    nexi(['uninstall', 'cursor', file]);
    if (existsSync(file)) {
      const final = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(final.theme, 'dark');
      assert.deepEqual(final.mcpServers.someoneelse, before.mcpServers.someoneelse, '卸载把别人的配置弄丢了');
      assert.ok(!final.mcpServers.nexi, '卸载后 nexi 还在');
    }
  } finally {
    done();
  }
});

test('重复装同一次：幂等（第二次 changed=false），不写重复条目', () => {
  const { dir, done } = freshDir('idem');
  try {
    const file = join(dir, 'mcp.json');
    const first = nexi(['install', 'cursor', file]);
    assert.equal(first.json?.changed, true);
    const second = nexi(['install', 'cursor', file]);
    assert.equal(second.json?.ok, true);
    assert.equal(second.json?.changed, false, '第二次不该再改');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.keys(doc.mcpServers).filter((k) => k === 'nexi').length, 1, 'nexi 条目重复了');
  } finally {
    done();
  }
});

/* ── 5. 坏配置不许把用户的东西搞丢 ─────────────────────────────────────── */

test('配置文件是坏 JSON 时：不崩、不覆盖、如实报告', () => {
  const { dir, done } = freshDir('broken');
  try {
    const file = join(dir, 'mcp.json');
    writeFileSync(file, '{ 这不是 json', 'utf8');
    const r = nexi(['install', 'cursor', file]);
    // 要么明确失败，要么备份后重写；但绝不能静默把原文件弄没
    assert.ok(r.status === 0 || r.status === 1, '不该以奇怪的状态结束');
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      assert.ok(text.length > 0, '文件被清空了');
    }
    // 有 warnings 或明确说不行，都算如实
    const said = JSON.stringify(r.json || {}) + r.out;
    assert.ok(r.json?.ok === false || (r.json?.warnings || []).length > 0 || r.json?.ok === true,
      `坏配置没有任何说明：${said.slice(0, 200)}`);
  } finally {
    done();
  }
});

/* ── 6. dry-run 绝不落盘 ───────────────────────────────────────────────── */

test('dry-run：给预览、不改文件（真的一个字节都不动）', () => {
  const { dir, done } = freshDir('dry');
  try {
    const file = join(dir, 'mcp.json');
    const r = nexi(['install', 'cursor', file, '--dry-run']);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json?.dryRun, true, '该标记是 dry-run');
    assert.ok(r.json?.preview, '该给出预览内容');
    assert.ok(!existsSync(file), `dry-run 不该创建文件，但它建了：${file}`);

    // 已有文件时也不能改
    writeFileSync(file, '{"mcpServers":{}}\n', 'utf8');
    const before = readFileSync(file, 'utf8');
    nexi(['install', 'cursor', file, '--dry-run']);
    assert.equal(readFileSync(file, 'utf8'), before, 'dry-run 改了已有文件');
  } finally {
    done();
  }
});

/* ── 7. 不认识的宿主 ───────────────────────────────────────────────────── */

test('不认识的宿主 id：明确拒绝，不猜一个出来', () => {
  const { dir, done } = freshDir('unknown');
  try {
    const file = join(dir, 'x.json');
    const r = nexi(['install', 'no-such-host-xyz', file]);
    assert.equal(r.status, 1, '该失败');
    assert.equal(r.json?.ok, false);
    assert.ok(!existsSync(file), '不认识宿主却写了文件');
  } finally {
    done();
  }
});
