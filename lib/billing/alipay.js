/**
 * lib/billing/alipay.js —— 支付宝开放平台（手机/电脑网站支付）适配器
 *
 * 为什么这个渠道"能真跑"：支付宝是**跳转型**支付——签名参数拼好 URL 让用户跳过去即可，
 * 不需要我们主动调用下单接口。所以 createCheckout 是纯本地计算（RSA2 签名 + 拼 query），
 * 配置了 APPID 和应用私钥就能生成可用的收银台链接。
 *
 * 规范（照着官方文档写，别自己发明）：
 * - 公共参数：app_id / method / format=JSON / charset=utf-8 / sign_type=RSA2 / timestamp / version=1.0
 * - 待签名内容：所有参数（除 sign、sign_type）按 key 升序，k=v 用 & 连接，空值不参与
 * - 签名：RSA-SHA256(应用私钥) → base64，放到 sign 参数
 * - 异步通知：application/x-www-form-urlencoded，验签用**支付宝公钥**，签名内容规则同上
 * - 退款：POST gateway.do，method=alipay.trade.refund；响应要对 alipay_trade_refund_response
 *   这段**原始子串**验签（不是整段 body），所以不能 parse 完再 stringify
 *
 * 没配置就诚实报「环境未配」；配置了但缺公钥导致无法验签时也明确报出来，
 * 绝不"跳过了验签还返回成功"。
 */

import { extractJsonNode, rsaSignBase64, rsaVerifyBase64 } from './sign.js';
import { httpCall, providerMessage, unconfiguredResult, UNCONFIGURED } from './shared.js';
import { assertMinor, minorToYuan, yuanToMinor } from './amount.js';

export const ALIPAY_PROVIDER = 'alipay';
export const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
export const ALIPAY_SIGN_TYPE = 'RSA2';

/** 支付宝要求的时间戳格式：北京时间 yyyy-MM-dd HH:mm:ss（不带时区）。 */
export function alipayTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  // 统一按 UTC+8 输出：支付宝服务端只认北京时间的字面值
  const beijing = new Date(date.getTime() + 8 * 3600 * 1000);
  return (
    `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ` +
    `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`
  );
}

/**
 * 待签名内容：去掉 sign / sign_type，key 升序，k=v 用 & 连接，空值跳过。
 * 这个函数是支付宝整条链路（下单/回调/退款响应）的共同基础，写错一处全盘验签失败。
 */
export function alipaySignContent(params = {}) {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => params[key] != null && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/**
 * @param {object} config
 * @param {string} [config.appId] 应用 APPID
 * @param {string} [config.privateKeyPem] 应用私钥（RSA2）
 * @param {string} [config.alipayPublicKeyPem] 支付宝公钥（验签用，不是应用公钥）
 * @param {string} [config.gateway] 默认 https://openapi.alipay.com/gateway.do
 * @param {string} [config.notifyUrl] 默认异步通知地址
 * @param {string} [config.returnUrl] 默认同步跳转地址
 * @param {string} [config.subject] 默认商品标题
 * @param {object} [deps] { fetchImpl, now }
 */
export function createAlipayAdapter(config = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const appId = String(config.appId || '').trim();
  const privateKeyPem = String(config.privateKeyPem || '').trim();
  const alipayPublicKeyPem = String(config.alipayPublicKeyPem || '').trim();
  const gateway = String(config.gateway || ALIPAY_GATEWAY).trim();
  const configured = Boolean(appId && privateKeyPem);
  const notifyConfigured = Boolean(configured && alipayPublicKeyPem);

  /** 组装公共参数 + 业务参数，并算好 sign。 */
  function buildParams(method, bizContent, extra = {}) {
    const params = {
      app_id: appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: ALIPAY_SIGN_TYPE,
      timestamp: alipayTimestamp(new Date(now())),
      version: '1.0',
      ...extra,
      biz_content: JSON.stringify(bizContent),
    };
    const sign = rsaSignBase64(privateKeyPem, alipaySignContent(params));
    return { ...params, sign };
  }

  return {
    provider: ALIPAY_PROVIDER,

    health() {
      return {
        ok: configured,
        provider: ALIPAY_PROVIDER,
        configured,
        reason: configured ? '' : UNCONFIGURED,
        hint: configured ? '' : '设置 billing.alipay.appId 和应用私钥 privateKeyPem（RSA2）',
        notifyConfigured,
        notifyHint: notifyConfigured ? '' : '回调查验还要 alipayPublicKeyPem（支付宝公钥，不是应用公钥）',
      };
    },

    /**
     * 生成电脑网站支付链接（alipay.trade.page.pay）。纯本地签名，不产生网络请求。
     * 成功 ≠ 已付款：用户还得在支付宝那边真的付钱，结果靠 notify/return 回来。
     */
    createCheckout(args = {}) {
      if (!configured) return unconfiguredResult('设置 billing.alipay.appId 和应用私钥 privateKeyPem（RSA2）');
      const orderId = String(args.orderId || '').trim();
      if (!orderId) return { ok: false, reason: '缺少 orderId（对应 out_trade_no）' };
      const amount = assertMinor(args.amount, 'amount');
      const subject = String(args.subject || config.subject || `订单 ${orderId}`).trim().slice(0, 256);
      const notifyUrl = String(args.notifyUrl || config.notifyUrl || '').trim();
      const returnUrl = String(args.returnUrl || config.returnUrl || '').trim();
      const biz = {
        out_trade_no: orderId,
        total_amount: minorToYuan(amount),
        subject,
        product_code: 'FAST_INSTANT_TRADE_PAY',
      };
      if (args.body) biz.body = String(args.body).slice(0, 128);
      const extra = {};
      if (notifyUrl) extra.notify_url = notifyUrl;
      if (returnUrl) extra.return_url = returnUrl;
      let params;
      try {
        params = buildParams('alipay.trade.page.pay', biz, extra);
      } catch {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          reason: '应用私钥无法解析（privateKeyPem 格式不对）',
          hint: '应用私钥的完整 PEM（PKCS#8 或 PKCS#1 都行）',
        };
      }
      const url = `${gateway}?${new URLSearchParams(params).toString()}`;
      return { ok: true, provider: ALIPAY_PROVIDER, url, code: orderId, raw: params };
    },

    /**
     * 异步通知验签 + 解析。rawBody 是 form-urlencoded 原始串（也接受已解析的对象）。
     */
    verifyWebhook(args = {}) {
      if (!notifyConfigured) {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          signatureOk: false,
          reason: UNCONFIGURED,
          hint: '回调查验需要 billing.alipay.alipayPublicKeyPem（支付宝公钥）',
        };
      }
      const rawBody = args.rawBody;
      let params;
      if (rawBody && typeof rawBody === 'object') {
        params = {};
        for (const [key, value] of Object.entries(rawBody)) params[key] = String(value ?? '');
      } else {
        params = {};
        const text = String(rawBody ?? '');
        for (const [key, value] of new URLSearchParams(text)) params[key] = value;
      }
      if (!params.sign) {
        return { ok: false, provider: ALIPAY_PROVIDER, signatureOk: false, reason: '通知里没有 sign 参数' };
      }
      if (String(params.sign_type || ALIPAY_SIGN_TYPE) !== ALIPAY_SIGN_TYPE) {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          signatureOk: false,
          reason: `只接受 ${ALIPAY_SIGN_TYPE} 签名（收到 ${JSON.stringify(params.sign_type)}）`,
        };
      }
      const matched = rsaVerifyBase64(alipayPublicKeyPem, alipaySignContent(params), params.sign);
      if (!matched) {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          signatureOk: false,
          reason: '通知签名不匹配（支付宝公钥不对，或内容被篡改）',
        };
      }
      if (params.app_id && appId && String(params.app_id) !== appId) {
        return { ok: false, provider: ALIPAY_PROVIDER, signatureOk: true, reason: '通知里的 app_id 与本机配置不一致' };
      }
      let paidAmount = null;
      try {
        paidAmount = params.total_amount ? yuanToMinor(params.total_amount) : null;
      } catch (err) {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          signatureOk: true,
          reason: `通知里的 total_amount 不是合法金额：${String((err && err.message) || err)}`,
        };
      }
      const status = String(params.trade_status || '');
      return {
        ok: true,
        provider: ALIPAY_PROVIDER,
        signatureOk: true,
        event: { id: String(params.notify_id || `alipay:${params.out_trade_no || ''}:${status}`), type: status },
        orderId: params.out_trade_no == null ? null : String(params.out_trade_no),
        paidAmount,
        paid: status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED',
        raw: params,
      };
    },

    /**
     * 退款（alipay.trade.refund）。这是唯一需要网络的一步。
     * 响应必须验签——没有支付宝公钥就无法验签，那就如实报未配，而不是"信任响应"。
     */
    async refund(args = {}) {
      if (!configured) return unconfiguredResult('设置 billing.alipay.appId 和应用私钥 privateKeyPem（RSA2）');
      if (!alipayPublicKeyPem) {
        return unconfiguredResult('退款要校验支付宝响应签名，需要 billing.alipay.alipayPublicKeyPem（支付宝公钥）');
      }
      const orderId = String(args.orderId || '').trim();
      if (!orderId) return { ok: false, provider: ALIPAY_PROVIDER, reason: '缺少 orderId（对应 out_trade_no）' };
      const amount = assertMinor(args.amount, 'amount');
      const biz = {
        out_trade_no: orderId,
        refund_amount: minorToYuan(amount),
      };
      if (args.reason) biz.refund_reason = String(args.reason).slice(0, 256);
      let params;
      try {
        params = buildParams('alipay.trade.refund', biz);
      } catch {
        return { ok: false, provider: ALIPAY_PROVIDER, reason: '应用私钥无法解析（privateKeyPem 格式不对）' };
      }
      const body = new URLSearchParams(params).toString();
      const res = await httpCall(fetchImpl, gateway, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body,
      });
      if (!res.ok) return { ok: false, provider: ALIPAY_PROVIDER, reason: res.reason, detail: res.detail };
      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          reason: `支付宝接口返回 HTTP ${res.status}`,
          httpStatus: res.status,
        };
      }
      let parsed = null;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        return { ok: false, provider: ALIPAY_PROVIDER, reason: '支付宝返回的不是 JSON（可能被网关拦了）' };
      }
      const node = parsed?.alipay_trade_refund_response;
      if (!node || typeof node !== 'object') {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          reason: '支付宝返回格式不对（没有 alipay_trade_refund_response）',
          detail: providerMessage(parsed, ''),
        };
      }
      // 对响应节点原文验签：支付宝的规则是对这段子串的字节签名
      const nodeText = extractJsonNode(res.text, 'alipay_trade_refund_response');
      if (!parsed.sign || !nodeText) {
        return { ok: false, provider: ALIPAY_PROVIDER, reason: '支付宝退款响应缺少签名（sign）' };
      }
      if (!rsaVerifyBase64(alipayPublicKeyPem, nodeText, parsed.sign)) {
        return { ok: false, provider: ALIPAY_PROVIDER, reason: '支付宝退款响应签名校验失败（响应可能被篡改）' };
      }
      if (String(node.code) !== '10000') {
        return {
          ok: false,
          provider: ALIPAY_PROVIDER,
          reason: `支付宝退款失败（${node.code || '无返回码'}）：${node.sub_msg || node.msg || '没有错误说明'}`,
          detail: node,
        };
      }
      return {
        ok: true,
        provider: ALIPAY_PROVIDER,
        refundId: String(node.trade_no || node.out_trade_no || orderId),
        refundFee: node.refund_fee == null ? '' : String(node.refund_fee),
        raw: node,
      };
    },
  };
}
