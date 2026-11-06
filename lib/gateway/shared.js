// SPDX-License-Identifier: Apache-2.0
/**
 * lib/gateway/shared.js —— 网关层共用的小工具（读 body、写 JSON、把 MCP content 块拼成文本）
 *
 * 为什么单独一份：OpenAPI 网关和 A2A 网关都要做「读请求体 → 调工具 → 写 JSON」，
 * 复制两遍迟早会漂移（一边限流 1MB、一边不限；一边带 CORS、一边不带）。
 *
 * 边界：这里不建服务器、不碰端口、不读环境变量。挂载动作由调用方传 app 进来，
 * 每个模块只依赖宿主 webServer 的 `register({ kind, path, handler })` 这一条真实接口
 * （见 lib/index.js 里 `scope.webServer.register(route)` 的用法与 lib/mcp/http.js 的同款实现）。
 */

const MAX_BODY_BYTES = 1024 * 1024;

/** 网关是给别的 Agent 调的，跨域是常态；不带 auth 头，token 一律走 Authorization。 */
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
  };
}

/** 统一 JSON 输出：Content-Length 必须自己算，否则某些客户端会一直等连接关闭。 */
export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  };
  if (typeof res.writeHead === 'function') res.writeHead(status, headers);
  else {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader?.(k, v);
  }
  res.end(text);
}

/** 读请求体：超过 1MB 直接拒，别让一个坏客户端把宿主内存吃满。 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > limit) {
        done(reject, new Error(`请求体超过 ${limit} 字节`));
        req.destroy?.();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => done(reject, err));
  });
}

/**
 * 把工具返回值压成一段文本。
 *
 * 三种真实形状都要吃得下：
 *   · MCP content 块数组 `[{type:'text',text}]`（hub.call 的返回）
 *   · 直接字符串
 *   · 工具 execute 的原始对象（有 text 字段就用 text，否则 JSON 序列化——宁可多给，不要吞数据）
 */
export function blocksToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((block) => blocksToText(block)).filter((s) => s !== '').join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.kind === 'string' || typeof value.type === 'string') {
      return typeof value.text === 'string' ? value.text : JSON.stringify(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 工具清单：优先用调用方传的数组，否则问 hub.list()（真 hub 的 list 是同步的，假 hub 允许 async）。 */
export async function resolveTools({ hub, tools } = {}) {
  if (Array.isArray(tools)) return tools.filter((t) => t && typeof t.name === 'string' && t.name.trim());
  if (hub && typeof hub.list === 'function') {
    const listed = await hub.list();
    return Array.isArray(listed) ? listed.filter((t) => t && typeof t.name === 'string' && t.name.trim()) : [];
  }
  return [];
}

/**
 * 调一个工具，返回 MCP content 块（或工具原始返回值）。
 * 有 hub 就走 hub.call（契约里工具永不 throw，这里仍兜底）；只有 tools 数组时直接 execute。
 */
export async function callTool({ hub, tools, name, args }) {
  if (hub && typeof hub.call === 'function') return hub.call(name, args || {});
  const def = (Array.isArray(tools) ? tools : []).find((t) => t?.name === name);
  if (!def) {
    const err = new Error(`没有这个工具：${name}`);
    err.code = 'no_such_tool';
    throw err;
  }
  if (typeof def.execute !== 'function') return [{ type: 'text', text: `工具 ${name} 没有 execute 实现` }];
  return def.execute(args || {}, { hub: true });
}

/** 路径归一化：去掉 query、折叠重复斜杠、去掉尾部斜杠（根路径保留 '/'）。 */
export function normalizePath(url) {
  let path = String(url || '/').split('?')[0].split('#')[0];
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

/** basePath 归一化：'' / '/adbp' 都合法，前后不带多余斜杠。 */
export function normalizeBase(basePath) {
  const text = String(basePath || '').trim();
  if (!text || text === '/') return '';
  return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

/** 请求路径剥掉 basePath（挂到 /adbp/v1/tools 时，网关自己的路由表仍然按 /v1/tools 认）。 */
export function stripBase(path, basePath) {
  const base = normalizeBase(basePath);
  if (!base) return path;
  if (path === base) return '/';
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

/**
 * 按 webServer 的真实接口挂路由。
 *
 * 宿主接口（见 lib/index.js）：`webServer.register({ kind:'prefix'|'exact', path, handler })`
 * 返回 disposer。注册失败只警告，不让整个插件起不来（headless profile 没有 webServer）。
 *
 * @returns {Function} 卸载函数（逐个 dispose，重复调用安全）
 */
export function mountRoutes(app, routes, { log } = {}) {
  if (!app || typeof app.register !== 'function') {
    throw new TypeError('挂载网关需要 webServer 的 register({kind, path, handler}) 接口');
  }
  const disposers = [];
  for (const route of routes) {
    try {
      const dispose = app.register(route);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      log?.warn?.(`网关路由 ${route.path} 挂载失败：${err?.message || err}`);
    }
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch { /* 卸载期失败无所谓 */ }
    }
  };
}
