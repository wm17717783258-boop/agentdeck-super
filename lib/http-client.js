/**
 * lib/http-client.js —— 支付渠道用的最小 HTTP 客户端
 *
 * 为什么单独放一层：
 *   - 市场模块故意不自己联网，只接受注入的 { post(url, body) }；
 *   - 插件入口在配置了真实渠道时，需要把这个最小客户端注进去；
 *   - 所有网络错误都翻译成结构化失败，绝不让异常冒到工具层。
 *
 * 这个客户端只做 POST + JSON，不读环境变量、不打印 token、不跟随重定向。
 */

const DEFAULT_TIMEOUT_MS = 15000;

function errText(err) {
  return String((err && err.message) || err || '未知网络错误');
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 测试注入用；生产使用全局 fetch
 * @param {number} [opts.timeoutMs]
 * @returns {{ post: (url: string, body: object) => Promise<object> }}
 */
export function createHttpClient({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    async post(url, body) {
      const target = String(url || '').trim();
      if (!/^https?:\/\//i.test(target)) {
        return { ok: false, reason: '支付地址必须是 http:// 或 https:// URL' };
      }
      if (typeof fetchImpl !== 'function') {
        return { ok: false, reason: '当前运行环境没有 fetch，无法发支付请求' };
      }

      let res;
      try {
        const init = {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body && typeof body === 'object' ? body : {}),
          redirect: 'error',
        };
        if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          init.signal = AbortSignal.timeout(timeoutMs);
        }
        res = await fetchImpl(target, init);
      } catch (err) {
        return { ok: false, reason: `支付请求发不出去：${errText(err)}` };
      }

      const raw = await res.text().catch(() => '');
      const parsed = safeJson(raw);
      if (!res.ok) {
        const detail = parsed && typeof parsed.reason === 'string' ? `：${parsed.reason}` : '';
        return {
          ok: false,
          reason: `支付网关返回 HTTP ${res.status}${detail}`,
          status: res.status,
          body: parsed,
        };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: '支付网关没有返回 JSON 对象（无法确认收款）', status: res.status };
      }
      return parsed;
    },
  };
}

export default createHttpClient;
