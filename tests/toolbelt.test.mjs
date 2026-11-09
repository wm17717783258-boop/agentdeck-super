/**
 * toolbelt + 四个工具定义的测试。
 *
 * 为什么把四工具（super_agent / team_orchestrate / agent_join / team_board）也塞在这个文件里：
 * 本轮的写入白名单只允许 tests/{llm,toolbelt,roles}.test.mjs 三个文件，
 * 不新开文件是最省事的合规做法；而且它们的契约风险（output.render 缺了会崩、execute 会抛）
 * 跟"工具带"是同一类问题，放一起反而更好查。
 *
 * 纪律（CONTRACTS §4）：只用假大脑/临时目录/注入的 fetch，
 * 绝不联网、绝不调真模型、绝不 spawn 真 CLI。shell 工具用 node 自身跑无害命令。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TOOLS,
  TOOL_NAMES,
  TOOLBELT_INFO,
  schemas,
  toolCatalog,
  invoke,
  makeCtx,
  resolveInside,
  inspectCommand,
  htmlToText,
  globToRegExp,
  clip,
} from '../lib/engine/toolbelt.js';
import { createSuperTool } from '../lib/tools/super.js';
import { createTeamTool } from '../lib/tools/team.js';
import { createJoinTool } from '../lib/tools/join.js';
import { createBoardTool } from '../lib/tools/board.js';

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

/** 临时工作区：每个 test 一份，结束后清理（避免测试互相污染）。 */
async function tmpRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-toolbelt-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 造一个工作区 ctx；extra 用来注入 fetch / board / runAgent / ask 等测试缝。 */
function ctxOf(root, extra = {}) {
  return makeCtx({ root, ...extra });
}

/** 直接调工具，顺手断言返回形状（永远 { ok, content } 且 content 是字符串）。 */
async function call(name, args, ctx) {
  const out = await invoke(name, args, ctx);
  assert.equal(typeof out, 'object', `invoke(${name}) 应返回对象`);
  assert.equal(typeof out.content, 'string', `invoke(${name}) 的 content 应是字符串`);
  return out;
}

/** 假大脑：按剧本依次回放，最后一条会一直重复（方便测"多步循环"）。 */
function fakeBrain(replies) {
  const calls = [];
  let i = 0;
  return {
    mode: 'host',
    calls,
    async chat(payload) {
      calls.push(payload);
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (typeof r === 'function') return r(payload);
      if (r instanceof Error) throw r;
      return r;
    },
    models() {
      return ['fake-model'];
    },
  };
}

/** 假任务板：内存版，接口名与 plugin-core 的 board.js 对齐。 */
function fakeBoard() {
  let seq = 0;
  const tasks = [];
  const members = [];
  const events = [];
  return {
    tasks,
    members,
    events,
    addTask(teamId, t) {
      const task = { id: `t${(seq += 1)}`, status: 'pending', dependsOn: [], ...t };
      tasks.push(task);
      return task;
    },
    listTasks(teamId, filter = {}) {
      return tasks.filter((t) => !filter?.status || t.status === filter.status);
    },
    getTeam(teamId) {
      return { id: teamId, name: '测试小组', goal: '把测试跑绿' };
    },
    stats() {
      return {
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'done').length,
        failed: tasks.filter((t) => t.status === 'failed').length,
        running: 0,
        pending: tasks.filter((t) => t.status === 'pending').length,
      };
    },
    completeTask(teamId, id, info) {
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new Error('没有这条任务');
      Object.assign(t, { status: 'done', output: info?.output });
      return t;
    },
    failTask(teamId, id, reason) {
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new Error('没有这条任务');
      Object.assign(t, { status: 'failed', note: reason });
      return t;
    },
    addMember(teamId, m) {
      const member = { id: `m${members.length + 1}`, ...m };
      members.push(member);
      return member;
    },
    listMembers() {
      return members;
    },
    removeMember(teamId, id) {
      const idx = members.findIndex((m) => m.id === id);
      if (idx >= 0) members.splice(idx, 1);
      return true;
    },
    assignTask(teamId, taskId, memberId) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) throw new Error('没有这条任务');
      t.assignee = memberId;
      return t;
    },
    appendEvent(teamId, evt) {
      events.push(evt);
      return evt;
    },
    listEvents() {
      return events;
    },
  };
}

/** shell 工具用：拼一条"跑 node 自身"的命令（跨平台、无副作用）。 */
function nodeCmd(code) {
  return `"${process.execPath}" -e "${code}"`;
}

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------

test('clip：短文本原样返回，长文本按字节截断并标注', () => {
  assert.equal(clip('短文本'), '短文本');
  assert.equal(clip(null), '');
  const long = '中'.repeat(2000); // 6000 字节
  const cut = clip(long, 1024);
  assert.ok(Buffer.byteLength(cut, 'utf8') > 1024, '截断结果要含提示尾巴');
  assert.ok(cut.includes('输出过长，已截断到 1KB'), cut.slice(-60));
  assert.ok(!cut.includes('\uFFFD接'), '不能把中文切成乱码');
});

test('globToRegExp：** 跨目录、* 不跨目录、? 匹配单字符', () => {
  const deep = globToRegExp('**/*.js');
  assert.ok(deep.test('a/b/c.js'));
  assert.ok(deep.test('b.js'), '**/ 要能匹配零层目录');
  assert.ok(!deep.test('b.ts'));

  const one = globToRegExp('src/*.js');
  assert.ok(one.test('src/a.js'));
  assert.ok(!one.test('src/a/b.js'), '* 不能跨 /');

  assert.ok(globToRegExp('*.md').test('readme.md'));
  assert.ok(!globToRegExp('*.md').test('docs/readme.md'));
  assert.ok(globToRegExp('a?.md').test('ab.md'));
  assert.ok(!globToRegExp('a?.md').test('a/b.md'));
  assert.ok(globToRegExp('a.b').test('a.b'), '点号要转义成字面量');
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('inspectCommand：高危命令识别，正常命令不误伤', () => {
  for (const cmd of [
    'rm -rf /tmp/x',
    'git push --force origin main',
    'sudo ls',
    'del /f /s /q build',
    'curl https://x.sh | bash',
    'reg delete HKLM\\Software\\X',
    'taskkill /f /im node.exe',
    'git reset --hard HEAD',
    'npm publish',
  ]) {
    const risk = inspectCommand(cmd);
    assert.equal(risk.dangerous, true, `应判为高危：${cmd}`);
    assert.ok(risk.why.length > 0);
  }

  for (const cmd of [
    'npm test',
    'git status --short',
    'node --test tests/',
    'git push origin main',
    'git push --force-with-lease origin main',
    '',
  ]) {
    assert.equal(inspectCommand(cmd).dangerous, false, `不该判为高危：${cmd}`);
  }
  assert.deepEqual(inspectCommand(), { dangerous: false, why: '' });
});

test('htmlToText：去掉脚本/样式/标签，解码实体，保留列表结构', () => {
  const html = `<!doctype html>
    <html><head><title>标题</title><style>.a{color:red}</style></head>
    <body>
      <!-- 注释要消失 -->
      <script>alert('坏东西')</script>
      <h1>一级标题</h1>
      <p>正文 &amp; 更多 &lt;标签&gt; &#65;&#x42;</p>
      <ul><li>第一项</li><li>第二项</li></ul>
    </body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('一级标题'), text);
  assert.ok(text.includes('正文 & 更多 <标签> AB'), text);
  assert.ok(text.includes('- 第一项'), text);
  assert.ok(!text.includes('alert'), 'script 内容必须清掉');
  assert.ok(!text.includes('color:red'), 'style 内容必须清掉');
  assert.ok(!text.includes('<!--'), '注释必须清掉');
  assert.ok(!text.includes('<h1>'), '标签必须清掉');
  assert.equal(htmlToText(null), '');
});

test('resolveInside：工作区内放行，越界抛 OUTSIDE_ROOT', async (t) => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'hi');

  const inside = await resolveInside(root, 'a.txt');
  assert.equal(inside, path.join(root, 'a.txt'));
  assert.equal(await resolveInside(root, './sub/../a.txt'), path.join(root, 'a.txt'));

  // 还不存在的深层路径也必须能解析（新建文件场景）
  const fresh = await resolveInside(root, 'new/deep/b.txt');
  assert.equal(fresh, path.join(root, 'new', 'deep', 'b.txt'));

  await assert.rejects(
    () => resolveInside(root, '../evil.txt'),
    (err) => {
      assert.equal(err.code, 'OUTSIDE_ROOT');
      assert.match(err.message, /路径越界/);
      return true;
    },
  );
});

test('makeCtx：root 绝对化，log 兜底成函数，board/teamId 有默认值', () => {
  const a = makeCtx({ root: '.' });
  assert.equal(path.isAbsolute(a.root), true);
  assert.equal(a.board, null);
  assert.equal(a.teamId, '');
  assert.equal(typeof a.log, 'function');
  a.log('不应该炸');

  const seen = [];
  const b = makeCtx({ root: 'x', log: (msg) => seen.push(msg), teamId: 'T1', board: { addTask() {} } });
  b.log('hello');
  assert.deepEqual(seen, ['hello']);
  assert.equal(b.teamId, 'T1');

  // 传 logger 对象也要能用（宿主有时给的是 {warn/info}）
  const buf = [];
  const c = makeCtx({ root: '.', log: { info: (m) => buf.push(m) } });
  c.log('走 logger');
  assert.equal(buf.length, 1);
  assert.ok(buf[0].includes('走 logger'));
});

test('schemas / toolCatalog / TOOL_NAMES：14 个工具，可按需筛选', () => {
  assert.equal(TOOL_NAMES.length, 14);
  assert.deepEqual(TOOL_NAMES, Object.keys(TOOLS));
  assert.equal(TOOLBELT_INFO.count, 14);
  assert.equal(TOOLBELT_INFO.platform, process.platform);

  const all = schemas();
  assert.equal(all.length, 14);
  for (const s of all) {
    assert.equal(s.type, 'function');
    assert.equal(typeof s.function.name, 'string');
    assert.equal(typeof s.function.description, 'string');
    assert.equal(s.function.parameters.type, 'object');
    assert.ok(TOOLS[s.function.name].description.length > 10, '描述要够模型看懂');
  }

  const pick = schemas(['fs_read', 'shell', '不存在的工具']);
  assert.deepEqual(pick.map((s) => s.function.name), ['fs_read', 'shell']);

  const catalog = toolCatalog(['fs_read']);
  assert.equal(catalog.split('\n').length, 1);
  assert.match(catalog, /^- fs_read：/);
});

// ---------------------------------------------------------------------------
// 2. invoke 的容错边界
// ---------------------------------------------------------------------------

test('invoke：未知工具/坏 JSON/非对象参数都给中文提示，不抛错', async (t) => {
  const root = await tmpRoot(t);
  const ctx = ctxOf(root);

  const unknown = await call('nope', {}, ctx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.content, /没有名为 "nope" 的工具/);
  assert.ok(unknown.content.includes('fs_read'), '要顺手告诉模型有哪些工具');

  const badJson = await call('fs_read', '{不是 JSON', ctx);
  assert.equal(badJson.ok, false);
  assert.match(badJson.content, /不是合法 JSON/);

  const arrArgs = await call('fs_read', ['a'], ctx);
  assert.equal(arrArgs.ok, false);
  assert.match(arrArgs.content, /必须是对象（收到 数组）/);

  const numArgs = await call('fs_read', 42, ctx);
  assert.match(numArgs.content, /必须是对象（收到 number）/);

  // 工具内部抛错（这里是路径越界）也要被翻译成人话
  const outside = await call('fs_read', { path: '../secret.txt' }, ctx);
  assert.equal(outside.ok, false);
  assert.ok(outside.content.includes('安全策略'), outside.content);
  assert.match(outside.content, /路径越界/);
});

// ---------------------------------------------------------------------------
// 3. 文件类工具
// ---------------------------------------------------------------------------

test('fs_list：列文件带大小，列子目录带斜杠，读不了的目录给人话', async (t) => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'x');

  const one = await call('fs_list', {}, ctxOf(root));
  assert.equal(one.ok, true);
  assert.match(one.content, /^目录：\.（深度 1）/);
  assert.ok(one.content.includes('a.txt  (5B)'), one.content);
  assert.ok(one.content.includes('sub/'), one.content);
  assert.ok(!one.content.includes('sub/b.txt'), '默认只看一层');

  const two = await call('fs_list', { depth: 2 }, ctxOf(root));
  assert.match(two.content, /sub[\\/]b\.txt/, two.content);

  const missing = await call('fs_list', { path: 'nope' }, ctxOf(root));
  assert.ok(missing.content.includes('读不了'), missing.content);

  // 越界目录直接拒绝
  const outside = await call('fs_list', { path: '..' }, ctxOf(root));
  assert.equal(outside.ok, false);
});

test('fs_read：带行号，超长提示用 offset 继续读，空参提示缺 path', async (t) => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'l.txt'), '第一行\n第二行\n第三行\n');

  const all = await call('fs_read', { path: 'l.txt' }, ctxOf(root));
  assert.equal(all.ok, true);
  assert.match(all.content, /^文件：l\.txt（共 \d+ 行，/);
  assert.match(all.content, /1\| 第一行/);
  assert.match(all.content, /2\| 第二行/);

  const part = await call('fs_read', { path: 'l.txt', offset: 2, limit: 1 }, ctxOf(root));
  assert.ok(!part.content.includes('第一行'), part.content);
  assert.ok(part.content.includes('第二行'), part.content);
  assert.match(part.content, /继续读请用 offset=3/);

  const noPath = await call('fs_read', {}, ctxOf(root));
  assert.equal(noPath.ok, false);
  assert.match(noPath.content, /缺少 path/);
});

test('fs_write：自动建目录、可追加；缺 content 时拒绝', async (t) => {
  const root = await tmpRoot(t);
  const ctx = ctxOf(root);

  const w = await call('fs_write', { path: 'deep/dir/x.txt', content: 'abc' }, ctx);
  assert.equal(w.ok, true);
  assert.match(w.content, /已写入 deep[\\/]dir[\\/]x\.txt/);
  assert.equal(await fs.readFile(path.join(root, 'deep', 'dir', 'x.txt'), 'utf8'), 'abc');

  const a = await call('fs_write', { path: 'deep/dir/x.txt', content: 'def', append: true }, ctx);
  assert.match(a.content, /已追加/);
  assert.equal(await fs.readFile(path.join(root, 'deep', 'dir', 'x.txt'), 'utf8'), 'abcdef');

  const bad = await call('fs_write', { path: 'y.txt' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.content, /缺少 content/);

  const outside = await call('fs_write', { path: '../y.txt', content: 'x' }, ctx);
  assert.equal(outside.ok, false);
});

test('fs_patch：唯一匹配才改，多处/找不到都拒绝，all:true 全改', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'p.txt');
  await fs.writeFile(file, 'alpha beta\nbeta gamma\n');
  const ctx = ctxOf(root);

  const one = await call('fs_patch', { path: 'p.txt', old: 'alpha', new: 'ALPHA' }, ctx);
  assert.equal(one.ok, true);
  assert.match(one.content, /已修改 p\.txt：替换 1 处/);
  assert.equal(await fs.readFile(file, 'utf8'), 'ALPHA beta\nbeta gamma\n');

  const multi = await call('fs_patch', { path: 'p.txt', old: 'beta', new: 'B' }, ctx);
  assert.equal(multi.ok, false);
  assert.match(multi.content, /原文出现了 2 次/);

  const all = await call('fs_patch', { path: 'p.txt', old: 'beta', new: 'B', all: true }, ctx);
  assert.equal(all.ok, true);
  assert.match(all.content, /替换 2 处/);
  assert.equal(await fs.readFile(file, 'utf8'), 'ALPHA B\nB gamma\n');

  const miss = await call('fs_patch', { path: 'p.txt', old: '不存在', new: 'x' }, ctx);
  assert.equal(miss.ok, false);
  assert.match(miss.content, /没找到要替换的原文/);

  const noOld = await call('fs_patch', { path: 'p.txt', old: '', new: 'x' }, ctx);
  assert.match(noOld.content, /缺少 old/);
});

test('fs_glob / fs_grep：找得到、找不到、正则写错都有话说', async (t) => {
  const root = await tmpRoot(t);
  await fs.mkdir(path.join(root, 'a'));
  await fs.writeFile(path.join(root, 'a', 'b.js'), 'const x = 1;\n');
  await fs.writeFile(path.join(root, 'c.txt'), 'nothing\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'alpha\nTODO: 修一下\n');
  const ctx = ctxOf(root);

  const glob = await call('fs_glob', { pattern: '**/*.js' }, ctx);
  assert.equal(glob.ok, true);
  assert.match(glob.content, /匹配 "\*\*\/\*\.js" 的文件（1 个）/);
  assert.ok(glob.content.includes('a/b.js'), glob.content);

  const miss = await call('fs_glob', { pattern: '**/*.rs' }, ctx);
  assert.match(miss.content, /没有匹配/);

  const grep = await call('fs_grep', { pattern: 'TODO' }, ctx);
  assert.equal(grep.ok, true);
  assert.match(grep.content, /命中 1 条/);
  assert.ok(grep.content.includes('notes.txt:2: TODO: 修一下'), grep.content);

  const withInclude = await call('fs_grep', { pattern: 'alpha', include: '*.txt' }, ctx);
  assert.match(withInclude.content, /命中 1 条/);

  const none = await call('fs_grep', { pattern: 'zzz-不存在' }, ctx);
  assert.match(none.content, /没有命中/);

  const badRe = await call('fs_grep', { pattern: '[' }, ctx);
  assert.equal(badRe.ok, false);
  assert.match(badRe.content, /正则写错了/);
});

// ---------------------------------------------------------------------------
// 4. shell
// ---------------------------------------------------------------------------

test('shell：正常命令返回退出码与 stdout，cwd 生效', async (t) => {
  const root = await tmpRoot(t);
  const out = await call('shell', { command: nodeCmd("console.log('shell-ok')") }, ctxOf(root));
  assert.equal(out.ok, true, out.content);
  assert.match(out.content, /退出码=0/);
  assert.ok(out.content.includes('shell-ok'), out.content);
  assert.match(out.content, /耗时=\d+ms/);

  // 相对 cwd 要落到工作区子目录里
  await fs.mkdir(path.join(root, 'sub2'));
  const cwdCmd = process.platform === 'win32' ? 'echo %CD%' : 'echo "$PWD"';
  const inSub = await call('shell', { command: cwdCmd, cwd: 'sub2' }, ctxOf(root));
  assert.equal(inSub.ok, true, inSub.content);
  assert.ok(inSub.content.includes('sub2'), inSub.content);

  // 越界 cwd 必须拒绝（不能借 shell 逃出工作区）
  const escape = await call('shell', { command: 'echo hi', cwd: '..' }, ctxOf(root));
  assert.equal(escape.ok, false);
});

test('shell：非零退出码算失败，但仍返回完整信息', async (t) => {
  const root = await tmpRoot(t);
  const out = await call('shell', { command: nodeCmd('process.exit(3)') }, ctxOf(root));
  assert.equal(out.ok, false);
  assert.match(out.content, /退出码=3/);
});

test('shell：高危命令不传 confirm 直接拦截，缺 command 也不炸', async (t) => {
  const root = await tmpRoot(t);
  const ctx = ctxOf(root);

  const blocked = await call('shell', { command: 'rm -rf /' }, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.content, /已拦截高危命令/);
  assert.match(blocked.content, /confirm:true/);

  const noCmd = await call('shell', {}, ctx);
  assert.equal(noCmd.ok, false);
  assert.match(noCmd.content, /缺少 command/);
});

// ---------------------------------------------------------------------------
// 5. 网络（全部用注入的假 fetch，不联网）
// ---------------------------------------------------------------------------

test('web_fetch：HTML 洗成正文；失败状态仍给出状态码和片段；非 http 拒绝', async (t) => {
  const root = await tmpRoot(t);
  const okFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => '<html><head><style>.a{}</style></head><body><h1>文档标题</h1><p>正文 &amp; 说明</p></body></html>',
  });

  const good = await call('web_fetch', { url: 'https://example.com/doc' }, ctxOf(root, { fetch: okFetch }));
  assert.equal(good.ok, true);
  assert.match(good.content, /网址：https:\/\/example\.com\/doc/);
  assert.match(good.content, /状态：200/);
  assert.ok(good.content.includes('文档标题'), good.content);
  assert.ok(good.content.includes('正文 & 说明'), good.content);
  assert.ok(!good.content.includes('<h1>'), '不该把标签原样返回');

  const badFetch = async () => ({
    ok: false,
    status: 500,
    headers: { get: () => 'text/plain' },
    text: async () => '服务器炸了',
  });
  const bad = await call('web_fetch', { url: 'https://example.com/boom' }, ctxOf(root, { fetch: badFetch }));
  assert.equal(bad.ok, false);
  assert.match(bad.content, /状态：500（请求失败）/);
  assert.ok(bad.content.includes('服务器炸了'), bad.content);

  const notHttp = await call('web_fetch', { url: 'file:///etc/passwd' }, ctxOf(root, { fetch: okFetch }));
  assert.equal(notHttp.ok, false);
  assert.match(notHttp.content, /只支持 http\/https/);

  const noUrl = await call('web_fetch', {}, ctxOf(root, { fetch: okFetch }));
  assert.match(noUrl.content, /缺少 url/);
});

test('http_request：POST 会把方法/请求体/content-type 传下去', async (t) => {
  const root = await tmpRoot(t);
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      text: async () => '{"created":true}',
    };
  };

  const out = await call('http_request', {
    url: 'https://api.example.com/items',
    method: 'post',
    body: '{"a":1}',
  }, ctxOf(root, { fetch: fakeFetch }));

  assert.equal(out.ok, true);
  assert.match(out.content, /POST https:\/\/api\.example\.com\/items/);
  assert.match(out.content, /状态：201/);
  assert.ok(out.content.includes('created'), out.content);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.body, '{"a":1}');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');

  const noUrl = await call('http_request', {}, ctxOf(root, { fetch: fakeFetch }));
  assert.match(noUrl.content, /缺少 url/);
});

// ---------------------------------------------------------------------------
// 6. 任务板 / 派活 / 问用户
// ---------------------------------------------------------------------------

test('board_add / board_list / board_done：读写任务板', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();
  const ctx = ctxOf(root, { board, teamId: 'team-1' });

  const add = await call('board_add', { title: '写 README', role: 'scribe', acceptance: 'README 有安装说明' }, ctx);
  assert.equal(add.ok, true);
  assert.match(add.content, /已加入任务板/);
  assert.ok(add.content.includes('写 README'), add.content);
  assert.ok(add.content.includes('验收=README 有安装说明'), add.content);
  assert.equal(board.events.length, 1, '加任务要写事件流');
  assert.equal(board.events[0].kind, 'task_add');

  const list = await call('board_list', {}, ctx);
  assert.equal(list.ok, true);
  assert.ok(list.content.includes('小组：测试小组（team-1）'), list.content);
  assert.match(list.content, /统计：总 1 · 完成 0/);
  assert.ok(list.content.includes('[t1] (pending) 写 README'), list.content);

  const done = await call('board_done', { taskId: 't1', output: 'README 写好了' }, ctx);
  assert.equal(done.ok, true);
  assert.match(done.content, /已更新任务 t1：完成/);
  assert.equal(board.tasks[0].status, 'done');

  const failed = await call('board_done', { taskId: 't1', ok: false, note: '验收不通过' }, ctx);
  assert.match(failed.content, /已更新任务 t1：失败/);
  assert.equal(board.tasks[0].status, 'failed');

  const filtered = await call('board_list', { status: 'failed' }, ctx);
  assert.ok(filtered.content.includes('写 README'), filtered.content);

  const noId = await call('board_done', {}, ctx);
  assert.match(noId.content, /缺少 taskId/);
});

test('board_*：没有 board / 没有 teamId 都给人话，不抛错', async (t) => {
  const root = await tmpRoot(t);
  const noBoard = await call('board_list', {}, ctxOf(root));
  assert.equal(noBoard.ok, false);
  assert.match(noBoard.content, /任务板不可用/);

  const noTeam = await call('board_list', {}, ctxOf(root, { board: fakeBoard() }));
  assert.equal(noTeam.ok, false);
  assert.match(noTeam.content, /还没有加入任何小组/);

  const addNoTitle = await call('board_add', {}, ctxOf(root, { board: fakeBoard(), teamId: 'T' }));
  assert.match(addNoTitle.content, /缺少 title/);
});

test('agent_run：派给成功能拿到输出，未知成员/没派活能力都拒绝', async (t) => {
  const root = await tmpRoot(t);
  const dispatched = [];
  const runAgent = async (member, prompt, opts) => {
    dispatched.push({ member, prompt, opts });
    return { rc: 0, out: '我把函数补上了', ms: 12 };
  };
  const ctx = ctxOf(root, {
    registry: [{ id: 'a1', name: 'claude', role: 'worker', agent: 'claude' }],
    runAgent,
  });

  const okOut = await call('agent_run', { member: 'claude', prompt: '补测试', expect: '测试全绿' }, ctx);
  assert.equal(okOut.ok, true);
  assert.match(okOut.content, /成员 claude 执行完毕：成功/);
  assert.ok(okOut.content.includes('我把函数补上了'), okOut.content);
  assert.equal(dispatched.length, 1);
  assert.ok(dispatched[0].prompt.includes('【期望产出】测试全绿'), dispatched[0].prompt);
  assert.equal(dispatched[0].opts.cwd, root);

  const failCtx = ctxOf(root, {
    registry: [{ id: 'a1', name: 'claude' }],
    runAgent: async () => ({ rc: 2, err: '编译失败', ms: 3 }),
  });
  const bad = await call('agent_run', { member: 'a1', prompt: 'x' }, failCtx);
  assert.equal(bad.ok, false);
  assert.match(bad.content, /失败\(rc=2\)/);
  assert.ok(bad.content.includes('编译失败'), bad.content);

  const unknown = await call('agent_run', { member: 'nobody', prompt: 'x' }, ctx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.content, /没找到成员「nobody」/);

  const noRunner = await call('agent_run', { member: 'claude', prompt: 'x' }, ctxOf(root, {
    registry: [{ id: 'a1', name: 'claude' }],
  }));
  assert.match(noRunner.content, /没有注入派活能力/);

  const noPrompt = await call('agent_run', { member: 'claude' }, ctx);
  assert.match(noPrompt.content, /缺少 prompt/);
});

test('ask_user：有交互通道走通道，没有就写事件流并给建议', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();

  const answered = await call('ask_user', { question: '用 A 还是 B？', options: ['A', 'B'] }, ctxOf(root, {
    board,
    teamId: 'T1',
    ask: async () => 'B',
  }));
  assert.equal(answered.ok, true);
  assert.match(answered.content, /用户回答：B/);
  assert.equal(board.events[0].kind, 'ask_user');
  assert.equal(board.events.at(-1).kind, 'ask_reply');

  const noChannel = await call('ask_user', { question: '要删库吗？' }, ctxOf(root));
  assert.equal(noChannel.ok, true, '没通道也不该算失败');
  assert.match(noChannel.content, /没有提供交互通道/);
  assert.ok(noChannel.content.includes('要删库吗？'), noChannel.content);

  const noQuestion = await call('ask_user', {}, ctxOf(root));
  assert.equal(noQuestion.ok, false);
  assert.match(noQuestion.content, /缺少 question/);
});

// ---------------------------------------------------------------------------
// 7. 四个工具定义：契约（output.render / execute 不抛）与主流程
// ---------------------------------------------------------------------------

/** 只造工具，不依赖任何真实服务：用于契约与容错检查。 */
function makeAllTools() {
  return {
    superTool: createSuperTool({}),
    teamTool: createTeamTool({}),
    joinTool: createJoinTool({}),
    boardTool: createBoardTool({}),
  };
}

test('四个工具定义：名字/参数/render 齐全，render 输出宿主认的 content 块', () => {
  const { superTool, teamTool, joinTool, boardTool } = makeAllTools();
  const defs = [superTool, teamTool, joinTool, boardTool];
  assert.deepEqual(defs.map((d) => d.name), ['super_agent', 'team_orchestrate', 'agent_join', 'team_board']);

  for (const def of defs) {
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 30, `${def.name} 描述要够模型选工具`);
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.execute, 'function');
    assert.equal(typeof def.output, 'object', `${def.name} 缺 output，宿主 render 会崩`);
    assert.equal(typeof def.output.render, 'function');
    assert.equal(typeof def.output.schema, 'object');
    assert.ok(Number(def.timeoutMs) > 0, `${def.name} 要有 timeoutMs`);

    // render 必须返回 [{ type:'text', text:string }]，且要同时吃得下对象和纯字符串
    const fromObj = def.output.render({}, { text: '报告正文' });
    assert.deepEqual(fromObj, [{ type: 'text', text: '报告正文' }]);
    const fromStr = def.output.render({}, '纯字符串结果');
    assert.deepEqual(fromStr, [{ type: 'text', text: '纯字符串结果' }]);
    const fromNull = def.output.render({}, null);
    assert.equal(fromNull[0].type, 'text');
    assert.equal(typeof fromNull[0].text, 'string');
  }

  // 必填项：super/team 要 goal，join/board 全可选（默认 list）
  assert.deepEqual(superTool.parameters.required, ['goal']);
  assert.deepEqual(teamTool.parameters.required, ['goal']);
  assert.deepEqual(joinTool.parameters.required, []);
  assert.deepEqual(boardTool.parameters.required, []);
});

test('四个工具定义：不管传什么鬼参数，execute 都不抛错、都返回 { text }', async () => {
  const { superTool, teamTool, joinTool, boardTool } = makeAllTools();
  const weird = [undefined, null, {}, { goal: '' }, { action: 'nonsense' }, { goal: 'x', plan: 'bad-json' }, 'oops', 42];
  for (const def of [superTool, teamTool, joinTool, boardTool]) {
    for (const args of weird) {
      const res = await def.execute(args, {});
      assert.equal(typeof res, 'object', `${def.name} 的 execute 必须返回对象`);
      assert.equal(typeof res.text, 'string', `${def.name} 必须返回 { text }`);
    }
    // exec 第二参是脏数据也不能崩
    const res = await def.execute({ goal: 'x' }, { logger: { warn() {} }, signal: undefined });
    assert.equal(typeof res.text, 'string');
  }
});

test('super_agent：一句话就给出带结论/轨迹的报告', async (t) => {
  const root = await tmpRoot(t);
  const brain = fakeBrain([{ content: '结论：项目结构正常，没有需要修的地方。', toolCalls: [] }]);
  const tool = createSuperTool({ brain, workspace: root });

  const res = await tool.execute({ goal: '看看这个项目有没有问题' }, {});
  assert.ok(res.text.includes('【super_agent】✅ 已完成'), res.text);
  assert.ok(res.text.includes('【结论】'), res.text);
  assert.ok(res.text.includes('项目结构正常'), res.text);
  assert.match(res.text, /【执行轨迹】共 0 步/);
  assert.match(res.text, /【结束原因】模型给出最终答复/);
  assert.equal(brain.calls.length, 1);
  assert.equal(brain.calls[0].messages[0].role, 'system');
  assert.ok(brain.calls[0].messages[1].content.includes('看看这个项目有没有问题'));
  assert.ok(Array.isArray(brain.calls[0].tools) && brain.calls[0].tools.length > 0, '要真的把工具给模型');
});

test('super_agent：真的会去调工具，轨迹和证据都写进报告', async (t) => {
  const root = await tmpRoot(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  const brain = fakeBrain([
    { content: '先看看目录', toolCalls: [{ name: 'fs_list', args: { path: '.' }, id: 'c1' }] },
    { content: '结论：目录里只有一个 a.txt。', toolCalls: [] },
  ]);
  const tool = createSuperTool({ brain, workspace: root });

  const res = await tool.execute({ goal: '看目录' }, {});
  assert.match(res.text, /【执行轨迹】共 1 步/);
  assert.ok(res.text.includes('[fs_list] ✓'), res.text);
  assert.ok(res.text.includes('【关键证据】'), res.text);
  assert.ok(res.text.includes('a.txt'), res.text);
  assert.ok(res.text.includes('目录里只有一个 a.txt'), res.text);
  assert.equal(brain.calls.length, 2);
  assert.equal(brain.calls[1].messages.at(-1).role, 'user', '工具结果要作为 user 消息回灌');
  assert.ok(brain.calls[1].messages.at(-1).content.includes('a.txt'));
});

test('super_agent：越权工具被拦、模型调用失败也不崩', async (t) => {
  const root = await tmpRoot(t);
  const brain = fakeBrain([
    { content: '', toolCalls: [{ name: 'shell', args: { command: 'echo hi' }, id: 'c1' }] },
    { content: '结论：工具被限制了，我改用读文件。', toolCalls: [] },
  ]);
  const tool = createSuperTool({ brain, workspace: root });

  const res = await tool.execute({ goal: '跑个命令', tools: ['fs_read'] }, {});
  assert.match(res.text, /【执行轨迹】共 1 步/, '被拒绝的调用也要留在轨迹里');
  assert.ok(res.text.includes('[shell] ✗'), res.text);
  assert.ok(res.text.includes('【遇到的问题】'), res.text);
  assert.ok(res.text.includes('不在本次允许范围内'), res.text);

  const broken = createSuperTool({ brain: fakeBrain([new Error('模型 503')]), workspace: root });
  const bad = await broken.execute({ goal: '随便做点啥' }, {});
  assert.ok(bad.text.includes('⚠️ 未完全完成'), bad.text);
  assert.ok(bad.text.includes('模型调用失败'), bad.text);

  const noBrain = createSuperTool({ workspace: root });
  const none = await noBrain.execute({ goal: 'x' }, {});
  assert.ok(none.text.includes('当前没有可用的大脑'), none.text);
});

test('team_orchestrate：dryRun 只出计划、不执行', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();
  const tool = createTeamTool({ board, workspace: root });

  const res = await tool.execute({
    goal: '把测试跑到全绿',
    dryRun: true,
    plan: [
      { id: 't1', title: '写单元测试', role: 'tester', acceptance: 'node --test tests/ 全绿', dependsOn: [] },
      { id: 't2', title: '修失败用例', role: 'worker', acceptance: '没有失败用例', dependsOn: ['t1'] },
    ],
  }, {});

  assert.ok(res.text.includes('【team_orchestrate】计划'), res.text);
  assert.ok(res.text.includes('写单元测试'), res.text);
  assert.ok(res.text.includes('依赖 t1'), res.text);
  assert.ok(res.text.includes('（dryRun：只出计划，未执行任何任务'), res.text);
  assert.equal(board.tasks.length, 0, 'dryRun 不能往任务板写东西');
});

test('team_orchestrate：模型拆解 → 落板 → 并行执行 → 过闸，全流程通过', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();
  const plan = JSON.stringify([
    { id: 't1', title: '出方案', role: 'architect', acceptance: '有方案文档', dependsOn: [] },
    { id: 't2', title: '实现方案', role: 'worker', acceptance: '代码跑通', dependsOn: ['t1'] },
  ]);
  const brain = fakeBrain([
    { content: plan, toolCalls: [] },
    (payload) => {
      const user = String(payload.messages.at(-1).content);
      return { content: user.includes('出方案') ? '方案：先写 A 再写 B' : '实现完成，命令 exit 0', toolCalls: [] };
    },
  ]);
  const tool = createTeamTool({ brain, board, workspace: root, cfg: { teamId: 'team-9' } });

  const res = await tool.execute({ goal: '把功能做出来' }, {});
  assert.ok(res.text.includes('【team_orchestrate】计划'), res.text);
  assert.ok(res.text.includes('【执行结果】全部通过（2/2）'), res.text);
  assert.ok(res.text.includes('方案：先写 A 再写 B'), res.text);
  assert.ok(res.text.includes('实现完成'), res.text);
  assert.equal(board.tasks.length, 2, '两条任务都要落板');
  assert.equal(board.tasks.every((x) => x.status === 'done'), true, '过闸后要回写完成状态');
  assert.ok(board.events.some((e) => e.kind === 'task_done'), '完成事件要写进事件流');
});

test('team_orchestrate：没有成员也没有模型时，明确报失败而不是假装成功', async (t) => {
  const root = await tmpRoot(t);
  const tool = createTeamTool({ workspace: root });

  const res = await tool.execute({
    goal: '写个文档',
    plan: [{ id: 't1', title: '写 README', role: 'scribe', acceptance: '有 README' }],
  }, {});

  assert.ok(res.text.includes('【执行结果】'), res.text);
  assert.ok(res.text.includes('失败/跳过 1'), res.text);
  assert.ok(res.text.includes('【失败任务与建议】'), res.text);
  assert.ok(res.text.includes('没有可用成员'), res.text);

  const noGoal = await tool.execute({}, {});
  assert.ok(noGoal.text.includes('缺少必填参数：goal'), noGoal.text);

  const emptyPlan = await tool.execute({ goal: 'x', plan: [] }, {});
  assert.ok(emptyPlan.text.includes('计划里没有有效任务'), emptyPlan.text);

  const noBrain = await tool.execute({ goal: 'x' }, {});
  assert.ok(noBrain.text.includes('没有可用的大脑'), noBrain.text);
});

test('team_orchestrate：派活优先给角色匹配的成员，并把验收带进指令', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();
  const sent = [];
  const runAgent = async (member, prompt, opts) => {
    sent.push({ member, prompt, opts });
    return { rc: 0, out: '测试写完了，4 个用例全绿', ms: 9 };
  };
  const tool = createTeamTool({
    board,
    workspace: root,
    registry: [{ id: 'w1', name: 'claude-tester', role: 'tester', agent: 'claude' }],
    runAgent,
    cfg: { teamId: 'team-1' },
  });

  const res = await tool.execute({
    goal: '补测试',
    plan: [{ id: 't1', title: '写单元测试', role: 'tester', acceptance: '4 个用例全绿' }],
  }, {});

  assert.equal(sent.length, 1, '应派给 tester 成员');
  assert.equal(sent[0].member.name, 'claude-tester');
  assert.ok(sent[0].prompt.includes('【验收标准】4 个用例全绿'), sent[0].prompt);
  assert.ok(res.text.includes('全部通过（1/1）'), res.text);
  assert.ok(res.text.includes('claude-tester'), res.text);
});

test('team_orchestrate：任务板里 agent_join 加入的成员也能被按角色选中', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();
  const sent = [];
  const runAgent = async (member, prompt) => {
    sent.push({ member, prompt });
    return { rc: 0, out: '任务板成员完成了', ms: 7 };
  };
  const join = createJoinTool({ board, workspace: root });
  const joined = await join.execute({
    action: 'join',
    teamId: 'team-board',
    name: '任务板测试员',
    role: 'tester',
    agent: 'codex',
    capabilities: ['测试'],
  }, {});
  assert.match(joined.text, /已加入小组 team-board/, joined.text);

  const tool = createTeamTool({ board, workspace: root, runAgent });
  const res = await tool.execute({
    goal: '把任务板成员接进编排',
    teamId: 'team-board',
    plan: [{ id: 't1', title: '跑一遍测试', role: 'tester', acceptance: '有测试输出' }],
  }, {});

  assert.equal(sent.length, 1, '任务板成员应被选中，不能只看 registry');
  assert.equal(sent[0].member.name, '任务板测试员');
  assert.ok(res.text.includes('任务板成员完成了'), res.text);
});

test('agent_join：list / join / capabilities / 不认识的动作', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();
  const tool = createJoinTool({
    board,
    workspace: root,
    registry: [{ id: 'w1', name: 'claude-worker', role: 'worker', agent: 'claude', capabilities: ['node'] }],
  });

  const list = await tool.execute({ action: 'list', teamId: 'team-1' }, {});
  assert.ok(list.text.includes('成员列表（小组 team-1）：共 1 人'), list.text);
  assert.ok(list.text.includes('claude-worker'), list.text);
  assert.match(list.text, /角色分布：worker×1/);

  const join = await tool.execute({
    action: 'join',
    teamId: 'team-1',
    name: 'codex-worker',
    role: 'architect',
    agent: 'codex',
    capabilities: ['python', '写文档'],
  }, {});
  assert.ok(join.text.includes('已加入小组 team-1'), join.text);
  assert.ok(join.text.includes('codex-worker'), join.text);
  assert.ok(join.text.includes('python、写文档'), join.text);
  assert.equal(board.members.length, 1);

  const caps = await tool.execute({ action: 'capabilities', name: 'claude-worker' }, {});
  assert.ok(caps.text.includes('成员：claude-worker'), caps.text);
  assert.ok(caps.text.includes('node'), caps.text);

  const missing = await tool.execute({ action: 'capabilities', name: 'nobody' }, {});
  assert.ok(missing.text.includes('没找到成员 "nobody"'), missing.text);

  const bad = await tool.execute({ action: '乱来' }, {});
  assert.ok(bad.text.includes('不认识的动作 "乱来"'), bad.text);

  const noName = await tool.execute({ action: 'join', teamId: 'team-1' }, {});
  assert.ok(noName.text.includes('join 需要 name'), noName.text);

  const empty = createJoinTool({ workspace: root });
  const none = await empty.execute({ action: 'list' }, {});
  assert.ok(none.text.includes('还没有登记任何成员'), none.text);
});

test('team_board：list / add / done / fail / 没 board / 不认识的动作', async (t) => {
  const root = await tmpRoot(t);
  const board = fakeBoard();
  const tool = createBoardTool({ board, workspace: root });

  const add = await tool.execute({ action: 'add', teamId: 'team-1', title: '写安装说明', role: 'scribe' }, {});
  assert.ok(add.text.includes('已添加任务 t1'), add.text);
  assert.ok(add.text.includes('写安装说明'), add.text);

  const list = await tool.execute({ action: 'list', teamId: 'team-1' }, {});
  assert.ok(list.text.includes('小组 team-1 任务（1 条'), list.text);
  assert.ok(list.text.includes('写安装说明'), list.text);

  const done = await tool.execute({ action: 'done', teamId: 'team-1', taskId: 't1', output: '写完了' }, {});
  assert.ok(done.text.includes('已标记完成'), done.text);
  assert.equal(board.tasks[0].status, 'done');

  const fail = await tool.execute({ action: 'fail', teamId: 'team-1', taskId: 't1', note: '验收不通过' }, {});
  assert.ok(fail.text.includes('已标记失败'), fail.text);
  assert.ok(fail.text.includes('验收不通过'), fail.text);
  assert.equal(board.tasks[0].status, 'failed');

  const stats = await tool.execute({ action: 'stats', teamId: 'team-1' }, {});
  assert.ok(stats.text.includes('统计'), stats.text);

  const bad = await tool.execute({ action: 'boom' }, {});
  assert.ok(bad.text.includes('不认识的动作 "boom"'), bad.text);

  const noBoard = createBoardTool({ workspace: root });
  const none = await noBoard.execute({ action: 'list' }, {});
  assert.ok(none.text.includes('没有注入任务板服务'), none.text);

  const noTeam = await tool.execute({ action: 'list' }, {});
  assert.ok(noTeam.text.includes('没有绑定小组'), noTeam.text);

  const noTitle = await tool.execute({ action: 'add', teamId: 'team-1' }, {});
  assert.ok(noTitle.text.includes('缺少必填参数：title'), noTitle.text);

  const noId = await tool.execute({ action: 'done', teamId: 'team-1' }, {});
  assert.ok(noId.text.includes('缺少必填参数：taskId'), noId.text);
});

test('工具带里的工具名与工具清单一致（防止改名漏改文档）', () => {
  for (const name of ['fs_list', 'fs_read', 'fs_write', 'fs_patch', 'fs_glob', 'fs_grep', 'shell', 'web_fetch', 'http_request', 'board_add', 'board_list', 'board_done', 'agent_run', 'ask_user']) {
    assert.ok(TOOL_NAMES.includes(name), `工具带缺少 ${name}`);
    assert.equal(typeof TOOLS[name].run, 'function');
    assert.equal(TOOLS[name].schema.type, 'object');
  }
});
