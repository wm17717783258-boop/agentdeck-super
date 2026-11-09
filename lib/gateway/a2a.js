// SPDX-License-Identifier: Apache-2.0
/**
 * lib/gateway/a2a.js —— A2A（Agent-to-Agent）网关：Agent Card + message/send
 *
 * 为什么要有它：OpenAPI 网关是「人类平台按文档调工具」，A2A 是「另一个 Agent 按
 * Agent Card 发现并调用这个 Agent」。两者共用同一份 hub 工具表，但协议面不同：
 *   · GET  /v1/a2a/agent-card.json   → Agent Card（能力声明，skills 由工具列表生成）
 *   · POST /v1/a2a/message           → JSON-RPC 2.0 `message/send`，文本里带工具意图
 *
 * 意图格式（两条都支持，因为不同 Agent 生成的习惯不一样）：
 *   · `tool:deck_license {"action":"status"}`   ← 显式前缀，最不容易误匹配
 *   · `deck_license {"action":"status"}`        ← 纯工具名 + JSON 参数
 *   · 纯文本里出现工具名（如「帮我 team_board 列一下」）→ 取最长的工具名兜底匹配
 *
 * 跟 openapi.js 一样：不硬编码工具名、不建服务器、不打印任何 token；
 * handleA2A 是纯函数（req 只取 method/url，body 由挂载层读好传进来）。
 */
import { randomUUID } from 'node:crypto';

import {
  blocksToText,
  callTool,
  mountRoutes,
  normalizeBase,
  normalizePath,
  readBody,
  resolveTools,
  sendJson,
  stripBase,
} from './shared.js';

export const DEFAULT_AGENT_NAME = 'AgentDeck Super';
export const CARD_PATH = '/v1/a2a/agent-card.json';
export const MESSAGE_PATH = '/v1/a2a/message';
const MAX_TEXT_CHARS = 20000;

function skillOf(tool) {
  const name = String(tool?.name || '').trim();
  return {
    id: name,
    name,
    description: String(tool?.description || `调用工具 ${name}`).trim(),
  };
}

/**
 * 生成 A2A Agent Card。
 *
 * @param {object} opts
 * @param {string} [opts.name]          Agent 名字（默认 AgentDeck Super）
 * @param {string} [opts.description]   一句话介绍
 * @param {string} [opts.url]           本 Agent 的 A2A 入口基地址
 * @param {string} [opts.version]       版本号
 * @param {object[]} [opts.skills]      显式给 skills（不给就从 tools 生成）
 * @param {object[]} [opts.tools]       工具定义（{name, description}）
 */
export function buildAgentCard({
  name = DEFAULT_AGENT_NAME,
  description = '本机 DSH 宿主暴露的工具集合：每个工具就是一个 skill，按 message/send 调用。',
  url = '',
  version = '1.0.0',
  skills,
  tools = [],
} = {}) {
  const skillList = Array.isArray(skills)
    ? skills
    : (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool && typeof tool.name === 'string' && tool.name.trim())
      .map(skillOf);

  return {
    name,
    description,
    url,
    version,
    capabilities: { streaming: false },
    skills: skillList,
  };
}

/** 从 message.parts 里取第一段文本；兼容 part.kind / part.type 两种写法。 */
export function firstTextPart(message) {
  if (typeof message === 'string') return message.trim();
  if (!message || typeof message !== 'object') return '';
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const isText = part.kind === 'text' || part.type === 'text';
    if (isText && typeof part.text === 'string' && part.text.trim()) return part.text.trim();
  }
  return '';
}

/**
 * 从一段文本里解析出「调哪个工具、带什么参数」。
 *
 * @param {string} text
 * @param {string[]} names 当前注册的工具名
 * @returns {{ok:true, name:string, args:object} | {ok:false, code?:number, reason:string, known?:string[]}}
 */
export function parseToolIntent(text, names = []) {
  const known = (Array.isArray(names) ? names : []).map(String).filter(Boolean);
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, code: -32602, reason: '消息里没有文本段', known };
  if (!known.length) return { ok: false, code: -32601, reason: '没有匹配的工具', known };

  let candidate = '';
  let rest = '';
  // 显式写法（tool: 前缀 / 纯工具名开头）要求参数写清楚；散文里捞出来的工具名允许不写参数。
  let explicit = false;

  // 1) 显式前缀：tool:NAME ...
  const prefixed = raw.match(/^tool\s*:\s*([A-Za-z0-9_.-]+)\s*([\s\S]*)$/i);
  if (prefixed) {
    candidate = prefixed[1];
    rest = prefixed[2];
    explicit = true;
  } else {
    // 2) 纯工具名开头：NAME {...}
    const first = raw.match(/^([A-Za-z0-9_.-]+)\s*([\s\S]*)$/);
    if (first && known.includes(first[1])) {
      candidate = first[1];
      rest = first[2];
      explicit = true;
    } else {
      // 3) 兜底：文本里出现的工具名，取最长的（越具体越不容易撞），从首次出现处切参数
      const hit = known.filter((name) => raw.includes(name)).sort((a, b) => b.length - a.length)[0];
      if (hit) {
        candidate = hit;
        rest = raw.slice(raw.indexOf(hit) + hit.length);
      }
    }
  }

  if (!candidate || !known.includes(candidate)) {
    return { ok: false, code: -32601, reason: '没有匹配的工具', known };
  }

  rest = rest.trim();
  let args = {};
  // 参数可以写在工具名后面任意位置（允许「工具名 参数 JSON」这种自然写法），
  // 从第一个 '{' 到最后一个 '}' 之间当 JSON 解析。
  const braceStart = rest.indexOf('{');
  if (braceStart >= 0) {
    const braceEnd = rest.lastIndexOf('}');
    const jsonText = braceEnd > braceStart ? rest.slice(braceStart, braceEnd + 1) : rest.slice(braceStart);
    try {
      args = JSON.parse(jsonText);
    } catch {
      return { ok: false, code: -32602, reason: `工具 ${candidate} 的参数不是合法 JSON`, known };
    }
  } else if (rest && explicit) {
    return {
      ok: false,
      code: -32602,
      reason: `工具 ${candidate} 后面的参数必须是 JSON 对象（例如 {"action":"status"}）`,
      known,
    };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: -32602, reason: '工具参数必须是 JSON 对象', known };
  }
  return { ok: true, name: candidate, args };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error } };
}

function methodNotAllowed(method, allow) {
  return {
    status: 405,
    headers: { Allow: allow.join(', ') },
    body: {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: `这个端点只接受 ${allow.join(' / ')}（当前 ${method}）` },
    },
  };
}

/**
 * 处理一条 A2A 请求（纯函数）。
 *
 * @param {object} opts
 * @param {object} [opts.hub]          真 hub（list/call）
 * @param {object[]} [opts.tools]      或直接给工具数组
 * @param {object} [opts.card]         自定义 Agent Card（默认按工具列表生成）
 * @param {object} [opts.req]          { method, url }
 * @param {string|object} [opts.body]  已读出的请求体
 * @param {string} [opts.basePath]
 * @returns {Promise<{status:number, headers?:object, body:any}>}
 */
export async function handleA2A(options = {}) {
  const { hub, basePath = '', req = {}, body } = options;
  const method = String(req?.method || 'GET').toUpperCase();
  const path = stripBase(normalizePath(req?.url || '/'), basePath);

  if (method === 'OPTIONS') return { status: 204, body: null };

  const defs = await resolveTools({ hub, tools: options.tools });

  if (path === CARD_PATH) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(method, ['GET']);
    const card = options.card || buildAgentCard({
      name: options.name,
      description: options.description,
      url: options.url || options.baseUrl || '',
      version: options.version,
      skills: options.skills,
      tools: defs,
    });
    return { status: 200, body: card };
  }

  if (path !== MESSAGE_PATH) {
    return {
      status: 404,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32601,
          message: `网关没有这个路径：${path}`,
          data: { knownPaths: [CARD_PATH, MESSAGE_PATH] },
        },
      },
    };
  }

  if (method !== 'POST') return methodNotAllowed(method, ['POST']);

  let msg;
  if (typeof body === 'string') {
    try {
      msg = JSON.parse(body);
    } catch {
      return rpcError(null, -32700, '报文不是合法 JSON');
    }
  } else {
    msg = body;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, '请求必须是单条 JSON-RPC 2.0 消息（这个端点不支持批量）');
  }
  if (msg.jsonrpc !== '2.0') return rpcError(msg.id, -32600, 'jsonrpc 必须是 "2.0"');
  if (msg.method !== 'message/send') {
    return rpcError(msg.id, -32601, `不支持的方法：${msg.method}（A2A 这一版只实现 message/send）`);
  }

  const text = firstTextPart(msg.params?.message).slice(0, MAX_TEXT_CHARS);
  if (!text) {
    return rpcError(msg.id, -32602, 'params.message.parts 里没有文本段（需要 {kind:"text", text:"…"}）');
  }

  const intent = parseToolIntent(text, defs.map((tool) => String(tool.name)));
  if (!intent.ok) {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: {
          code: intent.code || -32601,
          message: intent.reason,
          data: { known: intent.known || [] },
        },
      },
    };
  }

  try {
    const resultText = blocksToText(await callTool({ hub, tools: defs, name: intent.name, args: intent.args }));
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        result: {
          kind: 'task',
          id: `task-${randomUUID()}`,
          status: { state: 'completed' },
          artifacts: [{ parts: [{ kind: 'text', text: resultText }] }],
          metadata: { tool: intent.name },
        },
      },
    };
  } catch (err) {
    return rpcError(msg.id, -32603, `工具执行失败：${err?.message || String(err)}`, { tool: intent.name });
  }
}

/**
 * 把 A2A 网关挂到宿主的 webServer 上（跟 OpenAPI 网关同一套 register 接口）。
 *
 * @param {object} app  webServer：{ register({kind,path,handler}) → disposer }
 * @param {object} opts 同 handleA2A，外加 basePath / log
 * @returns {Function} 卸载函数
 */
export function mountA2A(app, opts = {}) {
  const basePath = normalizeBase(opts.basePath);
  const handler = async (req, res) => {
    let body;
    const method = String(req?.method || 'GET').toUpperCase();
    if (method === 'POST') {
      try {
        body = await readBody(req);
      } catch (err) {
        sendJson(res, 413, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err?.message || String(err) },
        });
        return;
      }
    }
    let result;
    try {
      result = await handleA2A({ ...opts, req, body });
    } catch (err) {
      result = rpcError(null, -32603, `A2A 网关内部错误：${err?.message || String(err)}`);
    }
    if (result.status === 204) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
  };

  return mountRoutes(app, [
    { kind: 'exact', path: `${basePath}${CARD_PATH}`, handler },
    { kind: 'exact', path: `${basePath}${MESSAGE_PATH}`, handler },
  ], { log: opts.log });
}

/** 任务要求「mountGateway(app, opts) 风格」——本模块的别名，语义就是挂 A2A 网关。 */
export const mountGateway = mountA2A;

export default { buildAgentCard, handleA2A, mountA2A, mountGateway, parseToolIntent };
