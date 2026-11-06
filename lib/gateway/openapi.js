// SPDX-License-Identifier: Apache-2.0
/**
 * lib/gateway/openapi.js —— OpenAPI 3.1 通用工具网关
 *
 * 为什么要有它：MCP 是「支持 MCP 的客户端才连得上」的协议；企业里大量 Agent 平台
 * （Dify / Coze / 自研工作流）只会读 OpenAPI 文档、按 HTTP 调接口。把宿主注册的
 * 每个工具映射成 `POST /v1/tools/<name>`，它们导入一份 openapi.json 就能用上
 * 这台机器上的全部工具，不用写 MCP 客户端。
 *
 * 设计取舍：
 *   · 文档**完全从 hub.list() 生成**——工具数量随时会变（现在是 18 个，以后不是），
 *     这里绝不硬编码工具名。
 *   · 工具的 parameters 本来就是 JSON Schema，OpenAPI 3.1 的 requestBody 直接吃
 *     JSON Schema，不再翻译一遍（翻译 = 迟早对不上）。
 *   · handleOpenApi 是纯函数：只认 { method, url, body }，返回 { status, headers, body }。
 *     这样单测不用起服务器，挂载层（mountOpenApi）只负责把 Node 的 req/res 喂进来。
 *   · 未配置 / 未知工具都返回结构化错误，不抛 500 崩掉。
 */
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

export const OPENAPI_VERSION = '3.1.0';
export const DEFAULT_TITLE = 'AgentDeck Super 工具网关';
export const DEFAULT_VERSION = '1.0.0';

const TOOL_PATH_PREFIX = '/v1/tools';
const DOC_PATH = '/v1/openapi.json';

/** 工具的 parameters 直接当 schema；没写参数的工具给一个空对象 schema（合法且可导入）。 */
function schemaOf(tool) {
  const parameters = tool?.parameters;
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) return parameters;
  return { type: 'object', properties: {}, additionalProperties: false };
}

/** 描述可能很长（工具说明是给人看的中文段落），summary 只取第一句/第一行。 */
function shortSummary(text, limit = 80) {
  const firstLine = String(text || '').trim().split(/\r?\n/)[0].trim();
  if (!firstLine) return '';
  if (firstLine.length <= limit) return firstLine;
  return `${firstLine.slice(0, limit - 1)}…`;
}

function errorSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      code: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['ok', 'code'],
  };
}

/**
 * 生成 OpenAPI 3.1.0 文档。
 *
 * @param {object} opts
 * @param {object[]} [opts.tools]   工具定义（{name, description, parameters}）；缺省 []（调用方通常传 hub.list()）
 * @param {string} [opts.baseUrl]   对外基地址（scheme://host[:port][/basePath]），写进 servers[0].url
 * @param {string} [opts.title]     文档标题
 * @param {string} [opts.version]   网关版本号（不是 OpenAPI 版本，OpenAPI 版本固定 3.1.0）
 * @param {string} [opts.description]
 * @returns {object} 严格 OpenAPI 3.1.0 对象
 */
export function buildOpenApi({ tools = [], baseUrl = '', title = DEFAULT_TITLE, version = DEFAULT_VERSION, description } = {}) {
  const defs = Array.isArray(tools) ? tools : [];

  /** @type {Record<string, object>} */
  const paths = {};
  for (const tool of defs) {
    const name = String(tool?.name || '').trim();
    if (!name) continue;
    const summary = shortSummary(tool.description) || `调用工具 ${name}`;
    paths[`${TOOL_PATH_PREFIX}/${name}`] = {
      post: {
        operationId: `tool_${name}`,
        summary,
        description: String(tool.description || summary),
        tags: ['tools'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: schemaOf(tool),
            },
          },
        },
        responses: {
          200: {
            description: '工具执行结果（MCP content 块已拼成一段文本）',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    text: { type: 'string' },
                  },
                  required: ['ok', 'text'],
                },
              },
            },
          },
          400: { description: '请求体不是 JSON 对象', content: { 'application/json': { schema: errorSchema() } } },
          401: { description: '缺少 Bearer token 或 token 不匹配', content: { 'application/json': { schema: errorSchema() } } },
          404: { description: '没有这个工具（工具名不在当前注册表里）', content: { 'application/json': { schema: errorSchema() } } },
          500: { description: '工具执行失败（已兜底，不会真的把宿主打崩）', content: { 'application/json': { schema: errorSchema() } } },
        },
      },
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title,
      version,
      description: description || `AgentDeck Super 的 ${defs.length} 个工具，一工具一路径；文档由 hub.list() 实时生成。`,
    },
    servers: [{ url: baseUrl || '/', description: '当前宿主（端口随机时以实际监听地址为准）' }],
    tags: [{ name: 'tools', description: '宿主已注册的全部工具' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: '网关 token（宿主配置里生成；只放请求头，不要写进文档或前端代码）',
        },
      },
    },
    'x-agentdeck-tool-count': Object.keys(paths).length,
  };
}

function methodNotAllowed(method, allow) {
  return {
    status: 405,
    headers: { Allow: allow.join(', ') },
    body: { ok: false, code: 'method_not_allowed', reason: `只接受 ${allow.join(' / ')}（当前 ${method}）` },
  };
}

/**
 * 处理一条网关请求（纯函数，不碰 res）。
 *
 * @param {object} opts
 * @param {object} [opts.hub]       真 hub：用 list() 取工具、call(name,args) 执行
 * @param {object[]} [opts.tools]   也可直接传工具数组（没有 hub 时用它，单测友好）
 * @param {string} [opts.baseUrl]
 * @param {object} [opts.req]       Node req 的最小形状：{ method, url }
 * @param {string|object} [opts.body] 已读出的请求体（挂载层负责读流；纯函数不接受流）
 * @param {string} [opts.basePath]  挂在 /adbp 之类前缀下时传它
 * @returns {Promise<{status:number, headers?:object, body:any}>}
 */
export async function handleOpenApi(options = {}) {
  const { hub, baseUrl = '', basePath = '', req = {}, body } = options;
  const method = String(req?.method || 'GET').toUpperCase();
  const path = stripBase(normalizePath(req?.url || '/'), basePath);

  if (method === 'OPTIONS') return { status: 204, body: null };

  const defs = await resolveTools({ hub, tools: options.tools });

  if (path === DOC_PATH) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(method, ['GET']);
    return {
      status: 200,
      body: buildOpenApi({
        tools: defs,
        baseUrl,
        title: options.title,
        version: options.version,
        description: options.description,
      }),
    };
  }

  const matched = path.match(new RegExp(`^${TOOL_PATH_PREFIX}/([^/]+)$`));
  if (!matched) {
    return {
      status: 404,
      body: {
        ok: false,
        code: 'not_found',
        reason: `网关没有这个路径：${path}`,
        knownPaths: [DOC_PATH, `${TOOL_PATH_PREFIX}/<name>`],
      },
    };
  }

  if (method !== 'POST') return methodNotAllowed(method, ['POST']);

  let name;
  try {
    name = decodeURIComponent(matched[1]);
  } catch {
    name = matched[1];
  }

  const known = defs.map((tool) => String(tool.name));
  if (!known.includes(name)) {
    return {
      status: 404,
      body: {
        ok: false,
        code: 'unknown_tool',
        reason: `没有这个工具：${name}`,
        known,
      },
    };
  }

  let args = {};
  if (body !== undefined && body !== null && body !== '') {
    if (typeof body === 'string') {
      try {
        args = JSON.parse(body);
      } catch {
        return { status: 400, body: { ok: false, code: 'invalid_json', reason: '请求体不是合法 JSON' } };
      }
    } else {
      args = body;
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { status: 400, body: { ok: false, code: 'invalid_args', reason: '请求体必须是 JSON 对象（工具的具名参数）' } };
  }

  try {
    const text = blocksToText(await callTool({ hub, tools: defs, name, args }));
    return { status: 200, body: { ok: true, text } };
  } catch (err) {
    if (err?.code === 'no_such_tool') {
      return { status: 404, body: { ok: false, code: 'unknown_tool', reason: err?.message || String(err), known } };
    }
    return { status: 500, body: { ok: false, code: 'tool_failed', reason: err?.message || String(err) } };
  }
}

/**
 * 把 OpenAPI 网关挂到宿主的 webServer 上。
 *
 * 两条路由（跟 lib/index.js 里 ADBP/状态页同一套 register 接口）：
 *   · exact  `${basePath}/v1/openapi.json`  → 文档
 *   · prefix `${basePath}/v1/tools`         → 单工具调用
 *
 * @param {object} app  webServer：{ register({kind,path,handler}) → disposer }
 * @param {object} opts 同 handleOpenApi，外加 basePath / log
 * @returns {Function} 卸载函数
 */
export function mountOpenApi(app, opts = {}) {
  const basePath = normalizeBase(opts.basePath);
  const handler = async (req, res) => {
    let body;
    const method = String(req?.method || 'GET').toUpperCase();
    if (method === 'POST') {
      try {
        body = await (opts.readBody ? opts.readBody(req) : readBody(req));
      } catch (err) {
        sendJson(res, 413, { ok: false, code: 'payload_too_large', reason: err?.message || String(err) });
        return;
      }
    }
    let result;
    try {
      result = await handleOpenApi({ ...opts, req, body });
    } catch (err) {
      result = { status: 500, body: { ok: false, code: 'gateway_failed', reason: err?.message || String(err) } };
    }
    if (result.status === 204) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
  };

  return mountRoutes(app, [
    { kind: 'exact', path: `${basePath}${DOC_PATH}`, handler },
    { kind: 'prefix', path: `${basePath}${TOOL_PATH_PREFIX}`, handler },
  ], { log: opts.log });
}

/** 任务要求「mountGateway(app, opts) 风格」——本模块的别名，语义就是挂 OpenAPI 网关。 */
export const mountGateway = mountOpenApi;

export default { buildOpenApi, handleOpenApi, mountOpenApi, mountGateway, OPENAPI_VERSION };
