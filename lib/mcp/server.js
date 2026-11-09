// SPDX-License-Identifier: Apache-2.0
// 这个目录是 MCP 适配层，按 LICENSING.md 用 Apache-2.0：任何宿主都能零成本接入，不必开源自己的代码。
/**
 * MCP（Model Context Protocol）服务端：把本地 Hub 的工具暴露给任何支持 MCP 的宿主。
 *
 * 支持两种传输：
 *   1. stdio（默认）：按行分隔的 JSON-RPC 2.0，MCP 官方 stdio 传输就是这样。
 *      铁律：stdout 只允许出现协议报文，日志一律写 stderr（lib/hub.js 已保证）。
 *   2. Streamable HTTP：由 lib/mcp/http.js 复用同一份 handle()，不重复实现语义。
 *
 * 只实现「说真话」的那部分：不声称支持没实现的 method，未支持的方法按 JSON-RPC 返回 -32601。
 * 工具失败不算协议错误：MCP 里用 isError:true 表达，让模型看到人话。
 */

import { createHub } from '../hub.js';
import { readVersion } from '../version.js';
import { isReadonlyAllowed, readonlyBlockedMessage, filterToolsForReadonly } from './readonly.js';

/** 能接受的协议版本，新的在前；客户端报的版本不认识就退回最新的。 */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INFO = { name: 'nexi', title: 'Nexi 灵犀', version: readVersion() };

/** JSON-RPC 错误码（只用手册里定义的那几个，别自创）。 */
const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * 造一个 MCP 引擎（与传输无关）。
 * @param {{hub: object, log?: object, serverInfo?: object, readOnly?: boolean}} opts
 */
export function createMcpEngine({ hub, log = console, serverInfo = SERVER_INFO, readOnly = false } = {}) {
  let initialized = false;

  const allDefs = () => hub.list();

  const toolsList = () => {
    const defs = readOnly ? filterToolsForReadonly(allDefs()) : allDefs();
    return defs.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters || { type: 'object', properties: {} },
    }));
  };

  /**
   * 处理一条 JSON-RPC 报文，返回响应（通知类返回 null）。
   * @param {any} msg
   */
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return rpcError(msg?.id, ERR.invalidRequest, '不是合法的 JSON-RPC 2.0 报文');
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    // 通知：只处理 initialized，其余静默忽略（协议允许）
    if (isNotification) {
      if (method === 'notifications/initialized') initialized = true;
      return null;
    }

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const version = MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: {
            tools: { listChanged: false },
            // 明确声明不支持 resources/prompts/logging：宁可少说，不可虚报
          },
          serverInfo,
          instructions: readOnly
            ? '本机 Nexi 灵犀（只读模式）：只能看任务板、看分身在记什么、看桌宠名片与皮肤状态。写动作（建组、派活、串门、改画像、跑自动化）在只读模式下不执行。'
            : '本机 Nexi 灵犀：团队/任务板、任意 CLI Agent 编组、跨机房间、桌宠分身与串门、皮肤与授权。所有数据只存本机，除非你主动用房间/串门。',
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: toolsList() });
      case 'tools/call': {
        const name = params?.name;
        if (!name || typeof name !== 'string') {
          return rpcError(id, ERR.invalidParams, 'tools/call 缺 name');
        }
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        // 只读模式：先看这次调用改不改状态，改就直接拒，连工具都不进
        if (readOnly && !isReadonlyAllowed(name, args)) {
          return rpcResult(id, {
            content: [{ type: 'text', text: `错误：${readonlyBlockedMessage(name, args)}` }],
            isError: true,
          });
        }
        try {
          const blocks = await hub.call(name, args);
          const failed = blocks.some((b) => b?.type === 'text' && /^(错误：|❌)/.test(String(b.text || '')));
          return rpcResult(id, { content: blocks, isError: failed || undefined });
        } catch (err) {
          if (err?.code === 'no_such_tool') {
            return rpcError(id, ERR.invalidParams, `没有这个工具：${name}`, { known: err.known });
          }
          log.error?.(`tools/call ${name} 失败：${err?.message || err}`);
          return rpcResult(id, {
            content: [{ type: 'text', text: `错误：工具 ${name} 执行失败 —— ${err?.message || String(err)}` }],
            isError: true,
          });
        }
      }
      // 明确不支持：让客户端知道边界，而不是让它以为能用
      case 'resources/list':
        return rpcResult(id, { resources: [] });
      case 'prompts/list':
        return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, ERR.methodNotFound, `未实现的方法：${method}`);
    }
  }

  return { handle, toolsList, readOnly, get initialized() { return initialized; } };
}

/**
 * stdio 传输：按行读 stdin、按行写 stdout。
 * @param {{hub: object, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, log?: object}} opts
 */
export function startStdio({ hub, input = process.stdin, output = process.stdout, log = console, serverInfo = SERVER_INFO, readOnly = false }) {
  const engine = createMcpEngine({ hub, log, serverInfo, readOnly });
  let buffer = '';
  let queue = Promise.resolve();

  const write = (obj) => {
    output.write(`${JSON.stringify(obj)}\n`);
  };

  const onLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      write(rpcError(null, ERR.parse, '报文不是合法 JSON'));
      return;
    }
    // 串行处理：工具里可能要动文件/起进程，并发跑同一份 board 状态会让结果不可复现
    queue = queue.then(async () => {
      try {
        const reply = await engine.handle(msg);
        if (reply) write(reply);
      } catch (err) {
        log.error?.(`处理报文失败：${err?.message || err}`);
        write(rpcError(msg?.id, ERR.internal, `内部错误：${err?.message || String(err)}`));
      }
    });
  };

  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf('\n');
    }
  });
  input.on('end', () => {
    if (buffer.trim()) onLine(buffer);
    buffer = '';
  });

  return { engine, done: () => queue };
}

/**
 * 一步到位：起 Hub + 跑 stdio。bin/nexi.mjs 用它。
 * @param {object} options createHub() 的参数 + {input, output, log, serverInfo}
 */
export async function serveStdio(options = {}) {
  const { input, output, log = console, serverInfo, readOnly, ...hubOptions } = options;
  // readOnly 既可能来自构造参数，也可能来自宿主配置（hubOptions.config.mcp.readOnly）
  const ro = readOnly ?? Boolean(hubOptions?.config?.mcp?.readOnly);
  const hub = await createHub(hubOptions);
  const server = startStdio({ hub, input, output, log, serverInfo, readOnly: ro });
  return { hub, server };
}

export default serveStdio;

