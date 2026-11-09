/**
 * lib/billing/shared.js —— 三个渠道适配器共用的小工具
 *
 * 这里只放"任何渠道都一样"的东西：未配置的统一文案、大小写不敏感的取 header、
 * 发一次 HTTP 并尽量解析 JSON（网络错也不抛，转成结构化结果）。
 * 各渠道的签名规则、字段名差异都留在自己的文件里。
 */

/** 「没配密钥」的统一 reason。产品文案就这一句，日志、UI、测试都认它。 */
export const UNCONFIGURED = '环境未配';

/** 未配置时的 hint：告诉用户缺什么，而不是让他去翻文档。 */
export const DEFAULT_HINT = '配置 billing.provider 后再试';

/** 未配置的标准失败结构：ok:false + 人话 reason + 下一步该干嘛。 */
export function unconfiguredResult(hint = DEFAULT_HINT, extra = {}) {
  return { ok: false, reason: UNCONFIGURED, hint, ...extra };
}

/** 取 header：兼容对象大小写差异（Node 的 headers 是小写，测试/手写可能是 Stripe-Signature）。 */
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== want) continue;
    if (Array.isArray(value)) return value.length ? String(value[0]) : '';
    return value == null ? '' : String(value);
  }
  return '';
}

/**
 * 发一次 HTTP 请求，把"网络层"和"业务层"分开：
 * - 返回 {ok:true, status, json, text} 只要拿到了响应（2xx/4xx/5xx 都算拿到）
 * - 返回 {ok:false, reason, detail} 只有连不上/超时/被 abort
 * 业务层（2xx 才能算成功）由调用方判断，这样错误文案能带渠道自己的措辞。
 */
export async function httpCall(fetchImpl, url, options = {}) {
  const fetch = fetchImpl || globalThis.fetch;
  if (typeof fetch !== 'function') {
    return { ok: false, reason: '当前 Node 没有 fetch（需要 Node 18+）', detail: 'no-fetch' };
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: true, status: res.status, json, text };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message)));
    return {
      ok: false,
      reason: aborted ? `请求超时（>${timeoutMs}ms）` : '连不上支付网关',
      detail: String((err && err.message) || err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 渠道返回的错误体里抠一句人话（Stripe 是 error.message，微信/支付宝是 message/code）。 */
export function providerMessage(json, fallback = '') {
  if (!json || typeof json !== 'object') return fallback;
  const candidates = [
    json?.error?.message,
    json?.error_description,
    json?.message,
    json?.sub_msg,
    json?.err_code_des,
    json?.detail,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return fallback;
}
