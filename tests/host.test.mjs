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

test('默认挂两个路由：/adbp 前缀 + /deck 精确', async () => {
  const b = await boot();
  try {
    assert.ok(routeFor(b.state, 'prefix', '/adbp'), '缺 ADBP 前缀路由');
    assert.ok(routeFor(b.state, 'exact', '/deck'), '缺 /deck 状态页路由');
    assert.equal(b.state.routes.length, 2, `路由多了：${b.state.routes.map((r) => `${r.kind}:${r.path}`).join(',')}`);
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

/* ── 6. 授权激活：整条链路（HTTP → 验签 → 落盘 → 页面/工具生效）───────────── */

test('POST /adbp/deck/license：GET 拒、空码拒、垃圾码拒且不落盘', async () => {
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
