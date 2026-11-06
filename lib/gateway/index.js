// SPDX-License-Identifier: Apache-2.0
/**
 * lib/gateway/index.js —— 网关层统一入口
 *
 * 两个协议面共用同一份 hub 工具表：
 *   · OpenAPI 3.1：`GET /v1/openapi.json` + `POST /v1/tools/<name>`（给只认 HTTP 的平台）
 *   · A2A：`GET /v1/a2a/agent-card.json` + `POST /v1/a2a/message`（给别的 Agent）
 *
 * 组合挂载示例（Lead 在 lib/index.js 里接线时用）：
 *   const dispose = mountGateway(scope.webServer, { hub, basePath: cfg.routePrefix });
 * 两个网关也可以单独挂（mountOpenApi / mountA2A），互不依赖。
 */
import { buildOpenApi, handleOpenApi, mountOpenApi } from './openapi.js';
import { buildAgentCard, handleA2A, mountA2A, parseToolIntent } from './a2a.js';

export { buildOpenApi, handleOpenApi, mountOpenApi };
export { buildAgentCard, handleA2A, mountA2A, parseToolIntent };
export { mountOpenApi as mountOpenApiGateway, mountA2A as mountA2AGateway };
export { OPENAPI_VERSION, DEFAULT_TITLE, DEFAULT_VERSION } from './openapi.js';
export { CARD_PATH, MESSAGE_PATH, DEFAULT_AGENT_NAME } from './a2a.js';

/**
 * 一次挂上两个网关。
 *
 * @param {object} app  webServer：{ register({kind,path,handler}) → disposer }
 * @param {object} [opts] 两边共同的选项（hub / tools / basePath / baseUrl / log …）；
 *                        也可用 opts.openapi / opts.a2a 单独覆盖各自参数
 * @returns {Function} 卸载函数
 */
export function mountGateway(app, opts = {}) {
  const openapiDispose = mountOpenApi(app, opts.openapi ?? opts);
  try {
    const a2aDispose = mountA2A(app, opts.a2a ?? opts);
    return () => {
      openapiDispose();
      a2aDispose();
    };
  } catch (err) {
    // 第二个网关挂失败就把第一个撤掉，别留下半套路由
    try {
      openapiDispose();
    } catch { /* 已尽力 */ }
    throw err;
  }
}

export default {
  buildOpenApi,
  handleOpenApi,
  mountOpenApi,
  buildAgentCard,
  handleA2A,
  mountA2A,
  parseToolIntent,
  mountGateway,
};
