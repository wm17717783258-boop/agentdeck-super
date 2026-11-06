/**
 * 宿主接线验收（Lead 负责）：`lib/index.js` 的 apply(ctx) 到底给宿主挂上了什么。
 *
 * 为什么需要这一层：其它套件测的是「引擎能不能干活」，这一层测的是
 * 「装进 DSH 之后，用户点得到的入口是不是真的存在」——
 * 工具名、工具 output 渲染、/adbp 路由、/deck 状态页、/deck 命令、授权激活。
 *
 * 全部用假 ctx + 假 req/res，不联网、不起真服务器、不碰用户真实授权文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import plugin, { apply, name as pluginName, inject } from '../lib/index.js';
import { encodeLicense, licensePath } from '../lib/license.js';

/* ── 先把机级目录（授权码、桌宠档案）指到临时 DSH_HOME ─────────────────── */

// 1.4.1 起授权码落在机级目录（$DSH_HOME/agentdeck-super/.agentdeck/license/key.txt）。
// 不隔离的话，跑一次测试就会往用户真机上写一条测试授权串。
const fakeDshHome = mkdtempSync(join(tmpdir(), 'adsk-host-dshhome-'));
const savedDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = fakeDshHome;
process.on('exit', () => {
  try {
    rmSync(fakeDshHome, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了，临时目录 */
  }
});
const machineStateRoot = () => join(fakeDshHome, 'agentdeck-super');

/* ── 临时密钥对：只为了把「激活」这条链路跑通，不是卖家的私钥 ─────────────── */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const testPrivPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const testPubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

const nowSec = Math.floor(Date.now() / 1000);

function issuePro(extra = {}) {
  return encodeLicense(
    { v: 1, id: 'lic_host_test', tier: 'pro', sub: '验收用户', iat: nowSec, exp: nowSec + 86400 * 30, seats: 8, skins: [], ...extra },
    testPrivPem,
  );
}

/* ── 假 ctx / 假 req / 假 res ──────────────────────────────────────────── */

function makeCtx() {
  const state = {
    tools: [],
    routes: [],
    commands: [],
    effects: [],
    warns: [],
    infos: [],
    emitted: [],
  };
  const logger = {
    debug() {},
    info: (m) => state.infos.push(String(m)),
    warn: (m) => state.warns.push(String(m)),
    error: (m) => state.warns.push(String(m)),
  };
  const ctx = {
    logger,
    get: () => null,
    emit: (evt, payload) => state.emitted.push({ evt, payload }),
    effect: (fn, label) => {
      state.effects.push({ fn, label });
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: {
      register(def) {
        state.tools.push(def);
        return () => {};
      },
    },
  };
  // 宿主注入：真实 cordis 会等依赖就绪再回调，这里直接给一个带依赖的 scope
  ctx.inject = (services, cb) => {
    const scope = {
      ...ctx,
      webServer: {
        port: 0,
        register(route) {
          state.routes.push(route);
          return () => {};
        },
      },
      commands: {
        register(cmd) {
          state.commands.push(cmd);
          return () => {};
        },
      },
      effect: ctx.effect,
    };
    cb(scope);
  };
  return { ctx, state };
}

function makeReq({ method = 'GET', url = '/deck', headers = {}, body = '' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers,
    on(evt, fn) {
      listeners.set(evt, [...(listeners.get(evt) || []), fn]);
      return req;
    },
    destroy() {},
  };
  // 下一个 tick 喂数据，模拟真实流
  setImmediate(() => {
    if (body) for (const fn of listeners.get('data') || []) fn(Buffer.from(body, 'utf8'));
    for (const fn of listeners.get('end') || []) fn();
    for (const fn of listeners.get('error') || []) fn(new Error('不该有 error'));
  });
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    finished: false,
    writeHead(code, headers) {
      res.statusCode = code;
      Object.assign(res.headers, headers || {});
      return res;
    },
    setHeader(k, v) {
      res.headers[String(k).toLowerCase()] = v;
      return res;
    },
    end(chunk) {
      if (chunk != null) res.body += String(chunk);
      res.finished = true;
      return res;
    },
  };
  return res;
}

/** 起一个插件实例：临时工作区 + 可选配置覆盖。 */
async function boot(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-host-'));
  const { ctx, state } = makeCtx();
  // licenseRoot 默认钉在临时工作区：用例断言 licensePath(root) 时不受机级目录影响。
  // 想验机级行为就显式传 { licenseRoot: '' }（见第 8 组）。
  await apply(ctx, { workspace: root, boardRoot: root, licenseRoot: root, agents: [], ...overrides });
  return { ctx, state, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function routeFor(state, kind, path) {
  return state.routes.find((r) => r.kind === kind && r.path === path) || null;
}

async function call(handler, { method = 'GET', url = '/deck', headers = {}, body = '' } = {}) {
  const res = makeRes();
  await handler(makeReq({ method, url, headers, body }), res);
  return res;
}

/** 有些页面渲染是 async（比如 /visit 要动态 import 串门模块）：等一拍再断言。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function jsonOf(res) {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/* ── 1. 插件自述 ───────────────────────────────────────────────────────── */

test('插件自述：名字 / 依赖 / 默认导出齐全', () => {
  assert.equal(pluginName, 'agentdeck-super');
  assert.deepEqual(inject, ['tools']);
  assert.equal(plugin?.name, 'agentdeck-super');
  assert.equal(typeof plugin?.apply, 'function');

});

/* ── 2. 工具注册 ───────────────────────────────────────────────────────── */

test('apply() 把九件工具都注册进宿主工具带', async () => {
  const b = await boot();
  try {
    const names = b.state.tools.map((t) => t.name);
    const expected = [
      'super_agent', 'team_orchestrate', 'agent_join', 'team_board',
      'deck_license', 'deck_room',
      'pet_visit', 'pet_meeting', 'pet_skin',
      // 1.7 M4：跨厂商会议 + 定时/审批/全局停止
      'deck_meeting', 'deck_automation',
    ];
    for (const want of expected) assert.ok(names.includes(want), `缺工具 ${want}（实际：${names.join('、')}）`);
    assert.equal(new Set(names).size, names.length, '工具名不能重复');
  } finally {
    b.cleanup();
  }
});

test('每个工具都符合宿主契约：参数是 JSON Schema、output.render 出 content 块', async () => {
  const b = await boot();
  try {
    for (const def of b.state.tools) {
      assert.equal(typeof def.description, 'string', `${def.name} 缺 description`);
      assert.ok(def.description.length > 8, `${def.name} 的 description 太短`);
      assert.equal(def.parameters?.type, 'object', `${def.name} 的 parameters 必须是 JSON Schema object`);
      assert.equal(def.output?.schema?.type, 'object', `${def.name} 缺 output.schema`);
      assert.equal(typeof def.output.render, 'function', `${def.name} 缺 output.render`);

      const blocks = def.output.render({}, { text: '样例结果' });
      assert.ok(Array.isArray(blocks) && blocks.length >= 1, `${def.name} 的 render 必须返回至少一个块`);
      assert.equal(blocks[0].type, 'text');
      assert.match(String(blocks[0].text), /样例结果/);
    }
  } finally {
    b.cleanup();
  }
});

test('任何工具拿到怪参数都返回 { text } 而不是抛错', async () => {
  const b = await boot();
  try {
    for (const def of b.state.tools) {
      for (const args of [undefined, null, 'x', 42, { 乱塞: true }]) {
        const out = await def.execute(args, {});
        assert.equal(typeof out, 'object', `${def.name} 对 ${JSON.stringify(args)} 没返回对象`);
        assert.equal(typeof out.text, 'string', `${def.name} 对 ${JSON.stringify(args)} 没返回 text`);
        assert.ok(out.text.length > 0);
      }
    }
  } finally {
    b.cleanup();
  }
});

test('工具名字进了系统提示词以外的所有地方都一致：registered 与工具带对得上', async () => {
  const b = await boot();
  try {
    const names = b.state.tools.map((t) => t.name).sort();
    assert.deepEqual([...names], [...new Set(names)].sort());
    // 注册完不产生任何 warn（warn 意味着某个工具悄悄没挂上）
    const badWarn = b.state.warns.filter((w) => /挂载失败|跳过|不符合宿主契约/.test(w));
    assert.deepEqual(badWarn, [], `不该有挂载告警：${badWarn.join(' | ')}`);
  } finally {
    b.cleanup();
  }
});

/* ── 3. 路由注册 ───────────────────────────────────────────────────────── */

test('默认挂九个路由：五个产品路由 + 四个协议网关路由（OpenAPI 3.1 / A2A）', async () => {
  const b = await boot();
  try {
    assert.ok(routeFor(b.state, 'prefix', '/adbp'), '缺 ADBP 前缀路由');
    assert.ok(routeFor(b.state, 'exact', '/deck'), '缺 /deck 状态页路由');
    // 测试台必须单独挂：/deck 是 exact，/deck/console 到不了它的 handler（踩过这个坑）
    assert.ok(routeFor(b.state, 'exact', '/deck/console'), '缺 /deck/console 测试台路由');
    // 主页上的按钮也是 POST 到独立路径，同样到不了 /deck 的 handler
    assert.ok(routeFor(b.state, 'exact', '/deck/act'), '缺 /deck/act 主页动作路由');
    assert.ok(routeFor(b.state, 'prefix', '/visit'), '缺 /visit 串门落地页路由');
    // 1.10.0：对外协议网关挂在根 /v1 下（不能挂 /adbp 下，那边是 prefix 路由会先吞掉）
    assert.ok(routeFor(b.state, 'exact', '/v1/openapi.json'), '缺 OpenAPI 3.1 文档路由');
    assert.ok(routeFor(b.state, 'prefix', '/v1/tools'), '缺 OpenAPI 单工具调用路由');
    assert.ok(routeFor(b.state, 'exact', '/v1/a2a/agent-card.json'), '缺 A2A agent card 路由');
    assert.ok(routeFor(b.state, 'exact', '/v1/a2a/message'), '缺 A2A message 路由');
    assert.equal(b.state.routes.length, 9, `路由数量不对：${b.state.routes.map((r) => `${r.kind}:${r.path}`).join(',')}`);
  } finally {
    b.cleanup();
  }
});

test('协议网关走真宿主：/v1/openapi.json 的路径数 = 真工具数，A2A skills 同理', async () => {
  const b = await boot();
  try {
    // 真机验收时抓到的 bug：网关问的是 hub.list()，而宿主给的 localHub 当时只有 names()，
    // 于是 /v1/openapi.json 的 paths 是空的、A2A card 的 skills 也是空的——
    // tests/gateway.test.mjs 用的是自己的假 hub（有 list），所以单测全绿、真宿主却是坏的。
    //
    // 这条就用真宿主挂上去的那个 handler 发真请求，堵死这个洞。
    const route = routeFor(b.state, 'exact', '/v1/openapi.json');
    assert.ok(route && typeof route.handler === 'function', '没挂上 OpenAPI 路由');

    const res = await call(route.handler, { method: 'GET', url: '/v1/openapi.json' });
    assert.equal(res.statusCode, 200, `OpenAPI 文档没返回 200：${res.statusCode}`);
    const doc = JSON.parse(res.body);

    const paths = Object.keys(doc.paths || {});
    const toolCount = b.state.tools.length;
    assert.ok(toolCount >= 21, `工具数太少：${toolCount}`);
    assert.equal(paths.length, toolCount,
      `OpenAPI 路径数应等于真工具数（网关没拿到真 hub 的话这里会是 0）：${paths.length} vs ${toolCount}`);
    assert.ok(paths.includes('/v1/tools/twin_remember'), `缺 twin_remember 路径：${paths.slice(0, 5).join(',')}…`);

    // 每个路径都必须对应一个真注册过的工具，不许凭空造
    for (const p of paths) {
      assert.ok(p.startsWith('/v1/tools/'), `路径形状不对：${p}`);
      const name = p.slice('/v1/tools/'.length);
      assert.ok(b.state.tools.some((t) => t.name === name), `文档里有没注册的工具：${name}`);
    }
    // x-agentdeck-tool-count 也要跟得上（它以前会写 0）
    assert.equal(doc['x-agentdeck-tool-count'], toolCount, 'x-agentdeck-tool-count 与真工具数不一致');

    // A2A card 的 skills 走的是同一份 hub，也该是满的
    const cardRoute = routeFor(b.state, 'exact', '/v1/a2a/agent-card.json');
    assert.ok(cardRoute && typeof cardRoute.handler === 'function', '没挂上 A2A 路由');
    const cardRes = await call(cardRoute.handler, { method: 'GET', url: '/v1/a2a/agent-card.json' });
    assert.equal(cardRes.statusCode, 200);
    const card = JSON.parse(cardRes.body);
    assert.ok(Array.isArray(card.skills) && card.skills.length === toolCount,
      `A2A skills 数应等于真工具数：${(card.skills || []).length} vs ${toolCount}`);
  } finally {
    b.cleanup();
  }
});

test('/visit 落地页：拿真邀请函渲染出主人名片；坏链接不 500', async () => {
  const b = await boot();
  try {    const handler = routeFor(b.state, 'prefix', '/visit').handler;
    // 1) 没带 token：给一句人话，不是 500
    const bare = await call(handler, { url: '/visit' });
    await settle();
    assert.equal(bare.statusCode, 200);
    assert.match(String(bare.body || ''), /串门邀请函/);
    // 2) 真邀请函：页面里能看到主人名字 + 有效期
    const { makeInvite } = await import('../lib/pet/visit.js');
    const { createProfileStore } = await import('../lib/pet/profile.js');
    const root = mkdtempSync(join(tmpdir(), 'adsk-visit-'));
    try {
      const store = createProfileStore({ root });
      store.update((draft) => { draft.name = '小犀'; });
      const invite = makeInvite({ profile: store, root, ttlMs: 60 * 60 * 1000 });
      assert.equal(invite.ok, true, invite.reason);
      const res = await call(handler, { url: `/visit?t=${encodeURIComponent(invite.token)}` });
      await settle();
      assert.equal(res.statusCode, 200);
      const html = String(res.body || '');
      assert.match(html, /小犀/, '页面里没出现主人名字');
      assert.match(html, /可以给我派活|只串门/, '页面里没写串门范围');
      assert.match(html, /pet_visit accept/, '页面里没给"没装 DSH 怎么收"的指令');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // 3) 乱填 token：照样 200 人话页
    const junk = await call(handler, { url: '/visit?t=not-a-real-token' });
    await settle();
    assert.equal(junk.statusCode, 200);
    assert.match(String(junk.body || ''), /串门邀请函|邀请已经过期|邀请你去串门/);
  } finally {
    b.cleanup();
  }
});

test('routePrefix 可配：改成 /deck-api 后前缀路由跟着走，/deck 页不变', async () => {
  const b = await boot({ routePrefix: 'deck-api' });
  try {
    assert.ok(routeFor(b.state, 'prefix', '/deck-api'));
    assert.ok(routeFor(b.state, 'exact', '/deck'));
    const res = await call(routeFor(b.state, 'prefix', '/deck-api').handler, { url: '/deck-api/v1/manifest' });
    assert.equal(res.statusCode, 200);
    assert.equal(jsonOf(res)?.protocol, 'adbp');
  } finally {
    b.cleanup();
  }
});

test('挂载器返回 dispose 且调用不抛（热重载/卸载不炸宿主）', async () => {
  const b = await boot();
  try {
    const mountEffect = b.state.effects.find((e) => /routes/.test(String(e.label)));
    assert.ok(mountEffect, '没找到路由挂载 effect');
    const dispose = mountEffect.fn();
    assert.equal(typeof dispose, 'function');
    dispose();
    // 工具清理的 effect 也要能被卸载
    for (const e of b.state.effects) {
      const d = e.fn();
      if (typeof d === 'function') d();
    }
  } finally {
    b.cleanup();
  }
});

/* ── 4. ADBP 端 ────────────────────────────────────────────────────────── */

test('ADBP：GET /v1/manifest 报协议与能力，非端点给人话', async () => {
  const b = await boot();
  try {
    const prefix = routeFor(b.state, 'prefix', '/adbp').handler;
    const man = await call(prefix, { url: '/adbp/v1/manifest' });
    const body = jsonOf(man);
    assert.equal(man.statusCode, 200);
    assert.equal(body?.protocol, 'adbp');
    assert.ok(Array.isArray(body?.capabilities) && body.capabilities.length > 0);

    const notEndpoint = await call(prefix, { url: '/adbp/不重要' });
    assert.ok(notEndpoint.statusCode >= 400);
    assert.match(notEndpoint.body, /不是 ADBP 端点|404|not_found/i);
  } finally {
    b.cleanup();
  }
});

/* ── 5. /deck 状态页 ───────────────────────────────────────────────────── */

test('/deck 状态页：200 + 自包含 HTML（断网也能开，不引外链）', async () => {
  const b = await boot();
  try {
    const res = await call(routeFor(b.state, 'exact', '/deck').handler, { url: '/deck' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(res.body, /agentdeck-super/i);

    // 自包含：除了 127.0.0.1 的本地地址，不许出现任何外链（CDN/字体/图片）
    const external = [...res.body.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi)]
      .map((m) => m[1])
      .filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(u));
    assert.deepEqual(external, [], `状态页引用了外链，断网会瞎：${external.join(',')}`);
  } finally {
    b.cleanup();
  }
});

test('/deck 状态页：把版本/档位/房间/任务板/桌宠/三步引导都写出来', async () => {
  const b = await boot();
  try {
    const res = await call(routeFor(b.state, 'exact', '/deck').handler, { url: '/deck' });
    const html = res.body;
    for (const kw of ['当前档位', '免费版', '房间', '任务板', '桌宠', '下一步三步', '授权码']) {
      assert.ok(html.includes(kw), `状态页缺「${kw}」这一栏`);
    }
    // 有可提交授权码的表单
    assert.match(html, /<form[^>]*method\s*=\s*["']?post/i);
    assert.match(html, /name\s*=\s*["']?key/i);
  } finally {
    b.cleanup();
  }
});

test('/deck 状态页：非 GET 方法给人话，不 500', async () => {
  const b = await boot();
  try {
    const res = await call(routeFor(b.state, 'exact', '/deck').handler, { method: 'POST', url: '/deck' });
    assert.equal(res.statusCode, 405);
    assert.match(res.body, /method_not_allowed|GET \/deck/);
  } finally {
    b.cleanup();
  }
});

test('桌宠学习惯：任务板上加/完成三次同类活，档案里长出习惯，/deck 与 pet_summary 都看得见', async () => {
  // 这条验的是宿主接线（v1.4.7 起）：emit 出口把真实活动翻译给 profile.observe，
  // 不再需要演示脚本手动喂事件。跑通 = 「数字分身自己会学」不是嘴上说说。
  const root = mkdtempSync(join(tmpdir(), 'adsk-host-habit-'));
  const b = await boot({ petRoot: root });
  try {
    const board = b.state.tools.find((t) => t.name === 'team_board');
    assert.ok(board, '缺 team_board 工具');
    const created = await board.execute({ action: 'create', name: '习惯回归组', goal: '让桌宠学三次同类活' }, {});
    const teamId =
      created?.teamId ||
      created?.team?.id ||
      (String(created?.text || '').match(/team_[0-9a-z]{6,}/i) || [])[0];
    assert.ok(teamId, `建组没返回 teamId：${JSON.stringify(created).slice(0, 200)}`);

    for (let i = 1; i <= 3; i += 1) {
      const added = await board.execute({ action: 'add', teamId, title: `修 sql 连接池（第 ${i} 次）`, acceptance: '跑通', role: 'worker' }, {});
      const taskId = (String(added?.text || '').match(/task_[0-9a-z]{6,}/i) || [])[0];
      assert.ok(taskId, `加任务没返回 taskId：${JSON.stringify(added).slice(0, 200)}`);
      await board.execute({ action: 'done', teamId, taskId, output: '改完了' }, {});
    }

    const profileFile = join(root, '.agentdeck', 'pet', 'profile.json');
    assert.ok(existsSync(profileFile), `桌宠档案没落盘：${profileFile}`);
    const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    assert.equal(profile.stats.tasksAdded, 3, '拆任务计数应为 3');
    assert.equal(profile.stats.tasksDone, 3, '完成任务计数应为 3');
    assert.ok(Array.isArray(profile.habits) && profile.habits.length >= 1, '三次同类活应长出至少一条习惯');
    assert.ok(profile.habits.some((h) => /sql/.test(String(h.label))), `习惯标签应带 sql：${JSON.stringify(profile.habits).slice(0, 240)}`);

    const visit = b.state.tools.find((t) => t.name === 'pet_visit');
    assert.ok(visit, '缺 pet_visit 工具');
    const card = await visit.execute({ action: 'card' }, {});
    const cardText = JSON.stringify(card);
    assert.match(cardText, /sql/, '名片应把学到的习惯带出去');

    const res = await call(routeFor(b.state, 'exact', '/deck').handler, { url: '/deck' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /拆出 3 个/, '/deck 应展示拆任务数');
    assert.match(res.body, /完成任务/, '/deck 应展示学到的习惯');
    assert.match(res.body, /只存本机/, '/deck 应说明习惯只存本机');
  } finally {
    b.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('回归：任务板上有任务（标题还很长）时，/deck 与 /adbp 状态页照样 200 不报错', async () => {
  // 曾经的坑：状态页在渲染任务列表时调了一个没定义的 clipText，实机一有任务就 500。
  // 上面的用例都在空板上跑，永远走不到那条分支 —— 这条专门把那条分支逼出来。
  const b = await boot();
  try {
    const board = b.state.tools.find((t) => t.name === 'team_board');
    assert.ok(board, '缺 team_board 工具');
    const created = await board.execute({ action: 'create', name: '状态页回归组', goal: '把渲染路径跑一遍' }, {});
    const teamId =
      created?.teamId ||
      created?.team?.id ||
      (Array.isArray(created?.teams) ? created.teams.at(-1)?.id : null) ||
      (String(created?.text || '').match(/team_[0-9a-z]{6,}/i) || [])[0];
    assert.ok(teamId, `建组没返回 teamId：${JSON.stringify(created).slice(0, 200)}`);

    const longTitle = '这是一条特别特别长的中文任务标题用来把状态页的截断逻辑逼出来看看它到底会不会把整页搞崩';
    const added = await board.execute({ action: 'add', teamId, title: longTitle, acceptance: '页面不 500', role: 'worker' }, {});
    assert.ok(added && typeof added.text === 'string' && added.text.length > 0, '加任务没返回 text');

    for (const [kind, path] of [['exact', '/deck'], ['prefix', '/adbp']]) {
      const route = routeFor(b.state, kind, path);
      assert.ok(route, `没挂路由 ${path}`);
      const res = await call(route.handler, { url: path });
      assert.equal(res.statusCode, 200, `${path} 应 200，实际 ${res.statusCode}：${String(res.body).slice(0, 200)}`);
      assert.ok(
        !/渲染失败|ReferenceError|is not defined|internal_error/i.test(res.body),
        `${path} 渲染报错：${String(res.body).slice(0, 240)}`,
      );
      if (path === '/deck') {
        assert.ok(res.body.includes('这是一条特别特别长'), '/deck 没把任务标题写出来');
        assert.ok(res.body.includes('…'), '/deck 没对长标题做截断');
        assert.ok(res.body.includes('待办'), '/deck 的任务状态应是中文标签');
        // 桌宠要画真皮肤，不能塞占位图糊弄人
        assert.ok(!/aria-label="桌宠占位图"/.test(res.body), '/deck 还在用占位图，没用真皮肤');
        assert.match(res.body, /data-skin="basic"/, '/deck 的桌宠应渲染激活皮肤');
      }
    }
  } finally {
    b.cleanup();
  }
});

test('回归：配置里填了 cloud.relayUrl，/deck 必须认（曾被 normalizeConfig 悄悄吃掉）', async () => {
  // 实机踩过的坑：schema 放行 cloud、normalizeConfig 只挑认识的字段 → relay 地址被丢掉，
  // 用户填了自建 relay 也永远显示「未配置」，跨机房间等于废的。
  const b = await boot({ cloud: { relayUrl: 'http://127.0.0.1:8787/' } });
  try {
    const res = await call(routeFor(b.state, 'exact', '/deck').handler, { url: '/deck' });
    assert.equal(res.statusCode, 200);
    // 末尾斜杠要被规整掉，页面上不该出现双斜杠
    assert.ok(res.body.includes('http://127.0.0.1:8787'), `/deck 没显示 relay 地址：${String(res.body).slice(0, 200)}`);
    assert.ok(!/relay：<span class="muted">未配置/.test(res.body), 'relay 配了却还显示未配置');
  } finally {
    b.cleanup();
  }
});

test('扁平写法 relayUrl 也认（老配置兼容，新写法 cloud.relayUrl 优先）', async () => {
  const flat = await boot({ relayUrl: 'http://10.0.0.9:9000' });
  try {
    const res = await call(routeFor(flat.state, 'exact', '/deck').handler, { url: '/deck' });
    assert.ok(res.body.includes('http://10.0.0.9:9000'), '扁平 relayUrl 没生效');
  } finally {
    flat.cleanup();
  }
  const both = await boot({ cloud: { relayUrl: 'http://new.example:1' }, relayUrl: 'http://old.example:2' });
  try {
    const res = await call(routeFor(both.state, 'exact', '/deck').handler, { url: '/deck' });
    assert.ok(res.body.includes('http://new.example:1'), 'cloud.relayUrl 应优先');
    assert.ok(!res.body.includes('http://old.example:2'), '两处都填时应只用 cloud.relayUrl');
  } finally {
    both.cleanup();
  }
});

test('回归：机级目录已激活工作室版时，deck_room create 不许再说"你是免费版"', async () => {
  // 实机踩过的坑：建云房间的档位判断拿 rootOf()（工作区）去读授权，
  // 而授权文件在机级目录 → 明明激活了，还回一句"这台机器现在是免费版"。
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  process.env.AGENTDECK_LICENSE_PUBKEY = testPubB64;
  const b = await boot({ licenseRoot: '', cloud: { relayUrl: 'http://127.0.0.1:9' } });
  try {
    const keyPath = licensePath(machineStateRoot());
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, issuePro({ tier: 'studio' }), 'utf8');

    const room = b.state.tools.find((t) => t.name === 'deck_room');
    assert.ok(room, '缺 deck_room 工具');
    const out = await room.execute({ action: 'create', name: '回归房间' }, {});
    const body = typeof out === 'string' ? out : String(out?.text ?? JSON.stringify(out));
    assert.ok(!/免费版/.test(body), `被误判成免费版：${body.slice(0, 240)}`);
    // 端口 9 是 discard：一定会连不上，但报的必须是网络错，不是档位错
    assert.match(body, /失败|连不上|不可用|超时|refused|fetch/i, `没有走到网络那一步：${body.slice(0, 240)}`);
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    b.cleanup();
  }
});

/* ── 6. 授权激活：整条链路（HTTP → 验签 → 落盘 → 页面/工具生效）───────────── */test('POST /adbp/deck/license：GET 拒、空码拒、垃圾码拒且不落盘', async () => {
  const b = await boot();
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  process.env.AGENTDECK_LICENSE_PUBKEY = testPubB64;
  try {
    const prefix = routeFor(b.state, 'prefix', '/adbp').handler;

    const byGet = await call(prefix, { url: '/adbp/deck/license' });
    assert.equal(byGet.statusCode, 405);
    assert.equal(jsonOf(byGet)?.ok, false);

    const empty = await call(prefix, {
      method: 'POST', url: '/adbp/deck/license',
      headers: { 'content-type': 'application/json' }, body: '{"key":""}',
    });
    assert.equal(empty.statusCode, 400);
    assert.equal(jsonOf(empty)?.ok, false);

    const garbage = await call(prefix, {
      method: 'POST', url: '/adbp/deck/license',
      headers: { 'content-type': 'application/json' }, body: '{"key":"ADSK1.有货.有货"}',
    });
    assert.equal(garbage.statusCode, 400);
    const g = jsonOf(garbage);
    assert.equal(g?.ok, false);
    assert.ok(String(g?.reason || '').length > 4, '拒绝时必须给中文理由');
    assert.equal(existsSync(licensePath(b.root)), false, '垃圾码不许写盘');
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    b.cleanup();
  }
});

test('POST /adbp/deck/license：有效码 → ok:true + 落盘 + 状态页/工具立刻变档位', async () => {
  const b = await boot();
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  process.env.AGENTDECK_LICENSE_PUBKEY = testPubB64;
  try {
    const prefix = routeFor(b.state, 'prefix', '/adbp').handler;
    const key = issuePro();
    const res = await call(prefix, {
      method: 'POST', url: '/adbp/deck/license',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
    });
    const body = jsonOf(res);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(body?.ok, true);
    assert.equal(body?.tier, 'pro');
    assert.match(String(body?.expiresAt), /^\d{4}-\d{2}-\d{2}T/);

    // 落盘在 licenseRoot 指定的目录（测试里 = 临时工作区；真机默认是机级目录）
    assert.equal(existsSync(licensePath(b.root)), true);
    assert.equal(readFileSync(licensePath(b.root), 'utf8').trim(), key);

    // 状态页立刻反映新档位
    const page = await call(routeFor(b.state, 'exact', '/deck').handler, { url: '/deck?license=ok' });
    assert.match(page.body, /协作版|专业版|付费版/, '状态页没显示已激活的档位');

    // deck_license 工具也能看到
    const tool = b.state.tools.find((t) => t.name === 'deck_license');
    const out = await tool.execute({ action: 'status' }, {});
    assert.match(out.text, /协作版|专业版/);
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    b.cleanup();
  }
});

test('POST /adbp/deck/license：浏览器表单提交走 303 回状态页（不是 JSON）', async () => {
  const b = await boot();
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  process.env.AGENTDECK_LICENSE_PUBKEY = testPubB64;
  try {
    const prefix = routeFor(b.state, 'prefix', '/adbp').handler;
    const res = await call(prefix, {
      method: 'POST', url: '/adbp/deck/license',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `key=${encodeURIComponent(issuePro())}`,
    });
    assert.equal(res.statusCode, 303);
    assert.match(String(res.headers.location), /^\/deck\?license=/);
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    b.cleanup();
  }
});

/* ── 7. /deck 命令 ─────────────────────────────────────────────────────── */

test('/deck 命令：status / help / board 都返回宿主认的 { kind, text }', async () => {
  const b = await boot();
  try {
    const names = b.state.commands.map((c) => c.name);
    assert.ok(names.includes('deck'), `没注册 /deck 命令（实际：${names.join('、')}）`);
    assert.ok(names.includes('agentdeck'), '旧名 /agentdeck 应该保留，升级用户才找得到入口');

    const cmd = b.state.commands.find((c) => c.name === 'deck');
    assert.equal(typeof cmd.handler, 'function');

    const status = cmd.handler({ rawInput: '' });
    assert.equal(status.kind, 'success');
    assert.match(status.text, /agentdeck-super/);
    assert.match(status.text, /免费版|协作版|专业版/);

    const help = cmd.handler({ rawInput: 'help' });
    assert.match(help.text, /\/deck/);
    assert.match(help.text, /ADBP|adbp/);

    const board = cmd.handler({ rawInput: 'board' });
    assert.ok(['success', 'error'].includes(board.kind));
    assert.ok(board.text.length > 0);

    // 怪输入不许抛
    for (const raw of ['license', '不存在的子命令', 'board 多余参数']) {
      const r = cmd.handler({ rawInput: raw });
      assert.ok(typeof r?.text === 'string' && r.text.length > 0, `输入「${raw}」没给出可读回复`);
    }
  } finally {
    b.cleanup();
  }
});

test('/deck license <码>：坏码回错误、好码写盘并提示档位', async () => {
  const b = await boot();
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  process.env.AGENTDECK_LICENSE_PUBKEY = testPubB64;
  try {
    const cmd = b.state.commands.find((c) => c.name === 'deck');
    const bad = cmd.handler({ rawInput: 'license ADSK1.瞎.写' });
    assert.equal(bad.kind, 'error');
    assert.equal(existsSync(licensePath(b.root)), false);

    const good = cmd.handler({ rawInput: `license ${issuePro()}` });
    assert.equal(good.kind, 'success', good.text);
    assert.match(good.text, /协作版|专业版/);
    assert.equal(existsSync(licensePath(b.root)), true);
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    b.cleanup();
  }
});

/* ── 8. 授权码机级化：换项目和升级都不许掉档 ───────────────────────────── */

test('授权码默认落机级目录：换到另一个工作区还是同一个档位', async () => {
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  process.env.AGENTDECK_LICENSE_PUBKEY = testPubB64;
  const key = issuePro();
  const b1 = await boot({ licenseRoot: '' }); // '' = 用机级默认目录
  let b2 = null;
  try {
    const prefix = routeFor(b1.state, 'prefix', '/adbp').handler;
    const res = await call(prefix, {
      method: 'POST',
      url: '/adbp/deck/license',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    assert.equal(res.statusCode, 200, res.body);

    const machineFile = licensePath(machineStateRoot());
    assert.equal(existsSync(machineFile), true, '授权码应落到机级目录');
    assert.equal(readFileSync(machineFile, 'utf8').trim(), key);
    assert.equal(existsSync(licensePath(b1.root)), false, '不该再往工作区里写');

    // 换一个工作区（用户切到别的项目）——同一个 DSH_HOME，档位必须还在
    b2 = await boot({ licenseRoot: '' });
    assert.notEqual(b2.root, b1.root, '两个实例必须是不同工作区');
    const tool = b2.state.tools.find((t) => t.name === 'deck_license');
    const out = await tool.execute({ action: 'status' }, {});
    assert.match(out.text, /协作版|专业版/, `换工作区后掉档了：${out.text}`);

    // 状态页也要如实显示机级路径，用户能自己找到文件
    const page = await call(routeFor(b2.state, 'exact', '/deck').handler, { url: '/deck' });
    assert.match(page.body, /agentdeck-super/, '状态页没显示授权文件位置');
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    b1.cleanup();
    if (b2) b2.cleanup();
    rmSync(machineStateRoot(), { recursive: true, force: true });
  }
});

test('老授权自动从工作区迁到机级：升级不掉档，老文件保留', async () => {
  const saved = process.env.AGENTDECK_LICENSE_PUBKEY;
  process.env.AGENTDECK_LICENSE_PUBKEY = testPubB64;
  const b = await boot({ licenseRoot: '' });
  try {
    const key = issuePro();
    // 模拟 1.4.0 及以前：授权串躺在工作区里
    const wsFile = licensePath(b.root);
    mkdirSync(dirname(wsFile), { recursive: true });
    writeFileSync(wsFile, `${key}\n`, 'utf8');

    const tool = b.state.tools.find((t) => t.name === 'deck_license');
    const out = await tool.execute({ action: 'status' }, {});
    assert.match(out.text, /协作版|专业版/, `升级后不认老授权：${out.text}`);

    const machineFile = licensePath(machineStateRoot());
    assert.equal(existsSync(machineFile), true, '机级目录没生成迁移后的授权');
    assert.equal(readFileSync(machineFile, 'utf8').trim(), key);
    assert.equal(existsSync(wsFile), true, '老文件要留着，别替用户删文件');
  } finally {
    if (saved === undefined) delete process.env.AGENTDECK_LICENSE_PUBKEY;
    else process.env.AGENTDECK_LICENSE_PUBKEY = saved;
    b.cleanup();
    rmSync(machineStateRoot(), { recursive: true, force: true });
  }
});

/* ── 9. 降级：宿主没给服务也不能崩 ─────────────────────────────────────── */

test('精简宿主（没有 webServer/commands/storage）也能起来，只是少几个入口', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adsk-host-min-'));
  try {
    const warns = [];
    const ctx = {
      logger: { debug() {}, info() {}, warn: (m) => warns.push(String(m)), error() {} },
      get: () => null,
      emit() {},
      effect: (fn) => {
        const d = fn();
        return typeof d === 'function' ? d : () => {};
      },
      tools: { register() { return () => {}; } },
      // 注意：这里 inject 直接调用 cb，但 scope 里什么都没有 → 处理器必须自己兜住
      inject: (services, cb) => cb({ effect: () => () => {}, tools: ctx.tools }),
    };
    await apply(ctx, { workspace: root, boardRoot: root, agents: [] });
    // 没有 webServer/commands 时不挂路由，但也不能抛
    assert.equal(warns.filter((w) => /挂载失败/.test(w)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabled:false 时什么都不挂（用户明确关掉就别偷偷加载）', async () => {
  const b = await boot({ enabled: false });
  try {
    assert.deepEqual(b.state.tools, []);
    assert.deepEqual(b.state.routes, []);
    assert.deepEqual(b.state.commands, []);
  } finally {
    b.cleanup();
  }
});
