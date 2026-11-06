/**
 * lib/billing/wechat.js —— 微信支付 APIv3（Native 扫码）适配器
 *
 * 真实规范（api.mch.weixin.qq.com）：
 * - 请求头 Authorization: WECHATPAY2-SHA256-RSA2048 mchid="…",nonce_str="…",signature="…",timestamp="…",serial_no="…"
 *   签名内容：METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n，用商户 API 私钥做 RSA-SHA256。
 * - 回调通知：Wechatpay-Timestamp/Nonce/Signature/Serial 四个头，签名内容是
 *   TIMESTAMP\nNONCE\nBODY\n，用**微信平台证书公钥**验签；body 里的 resource 还要用
 *   APIv3 密钥做 AES-256-GCM 解密才能看到 out_trade_no / 金额。
 * - 退款：POST /v3/refund/domestic/refunds，需要原订单总额 total + 退款额 refund。
 *
 * 写不出来的部分（比如查单、平台证书自动下载、服务商模式）不假装成功：
 * 没配置一律 unconfiguredResult；配置了但缺必要参数（total、notify_url）就明确说缺什么。
 * 密钥只在内存里用：不写日志、不进返回值、不落盘。
 */

import { createDecipheriv } from 'node:crypto';
import { rsaSignBase64, rsaVerifyBase64, randomNonce } from './sign.js';
import { headerValue, httpCall, providerMessage, unconfiguredResult, UNCONFIGURED } from './shared.js';
import { assertMinor } from './amount.js';

export const WECHAT_PROVIDER = 'wechat';
export const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';
export const WECHAT_TOLERANCE_SEC = 300;

/** 微信请求签名串：METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n（最后一个换行不能少）。 */
export function wechatSignMessage(method, urlPath, timestamp, nonce, body) {
  return `${String(method).toUpperCase()}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
}

/** 回调验签串：TIMESTAMP\nNONCE\nBODY\n。 */
export function wechatNotifySignMessage(timestamp, nonce, body) {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

/** 拼 Authorization 头（签名已算好）。 */
export function wechatAuthorization({ mchId, serialNo, nonce, timestamp, signature }) {
  return (
    'WECHATPAY2-SHA256-RSA2048 ' +
    `mchid="${mchId}",` +
    `nonce_str="${nonce}",` +
    `signature="${signature}",` +
    `timestamp="${timestamp}",` +
    `serial_no="${serialNo}"`
  );
}

/**
 * AES-256-GCM 解密回调用 resource。
 * @param {{ciphertext: string, nonce: string, associated_data?: string}} resource
 * @param {string} apiV3Key 32 位 APIv3 密钥（按 utf8 直接当 key，不做 base64）
 */
export function decryptWechatResource(resource, apiV3Key) {
  const key = Buffer.from(String(apiV3Key || ''), 'utf8');
  if (key.length !== 32) throw new Error('apiV3Key 必须是 32 位字符串');
  const nonce = String(resource?.nonce || '');
  if (!nonce) throw new Error('resource.nonce 缺失');
  const ciphertext = Buffer.from(String(resource?.ciphertext || ''), 'base64');
  if (ciphertext.length <= 16) throw new Error('resource.ciphertext 太短');
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(tag);
  const aad = resource?.associated_data;
  if (aad != null && aad !== '') decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * @param {object} config
 * @param {string} [config.mchId] 商户号
 * @param {string} [config.appId] 应用（公众号/小程序）appid
 * @param {string} [config.serialNo] 商户 API 证书序列号
 * @param {string} [config.privateKeyPem] 商户 API 私钥（apiclient_key.pem）
 * @param {string} [config.apiV3Key] APIv3 密钥（32 位，回调解密用）
 * @param {string} [config.platformCertPem] 微信支付平台证书（验签用，也接受公钥 PEM）
 * @param {string} [config.notifyUrl] 默认回调地址
 * @param {string} [config.apiBase] 默认 https://api.mch.weixin.qq.com
 * @param {object} [deps] { fetchImpl, now }
 */
export function createWechatAdapter(config = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const mchId = String(config.mchId || '').trim();
  const appId = String(config.appId || '').trim();
  const serialNo = String(config.serialNo || '').trim();
  const privateKeyPem = String(config.privateKeyPem || '').trim();
  const apiV3Key = String(config.apiV3Key || '');
  const platformCertPem = String(config.platformCertPem || '').trim();
  const apiBase = String(config.apiBase || WECHAT_API_BASE).replace(/\/+$/, '');
  const configured = Boolean(mchId && appId && serialNo && privateKeyPem);
  const notifyConfigured = Boolean(apiV3Key.length === 32 && platformCertPem);

  function signedHeaders(method, urlPath, body) {
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomNonce(16);
    const signature = rsaSignBase64(privateKeyPem, wechatSignMessage(method, urlPath, timestamp, nonce, body));
    return {
      authorization: wechatAuthorization({ mchId, serialNo, nonce, timestamp, signature }),
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'agentdeck-super/1 (wechat-api-v3)',
    };
  }

  return {
    provider: WECHAT_PROVIDER,

    health() {
      return {
        ok: configured,
        provider: WECHAT_PROVIDER,
        configured,
        reason: configured ? '' : UNCONFIGURED,
        hint: configured ? '' : '设置 billing.wechat.mchId / appId / serialNo / privateKeyPem（商户 API 证书私钥）',
        notifyConfigured,
        notifyHint: notifyConfigured ? '' : '回调查验还要 apiV3Key（32 位）和 platformCertPem（微信平台证书）',
      };
    },

    /** Native 下单：返回 code_url，前端拿它生成二维码。成功 ≠ 已付款。 */
    async createCheckout(args = {}) {
      if (!configured) {
        return unconfiguredResult('设置 billing.wechat.mchId / appId / serialNo / privateKeyPem（商户 API 证书私钥）');
      }
      const orderId = String(args.orderId || '').trim();
      if (!orderId) return { ok: false, reason: '缺少 orderId（对应 out_trade_no）' };
      const amount = assertMinor(args.amount, 'amount');
      const currency = String(args.currency || 'CNY').toUpperCase();
      if (currency !== 'CNY') {
        return { ok: false, provider: WECHAT_PROVIDER, reason: '微信支付只支持 CNY' };
      }
      const notifyUrl = String(args.notifyUrl || config.notifyUrl || '').trim();
      if (!notifyUrl) {
        return { ok: false, provider: WECHAT_PROVIDER, reason: '缺少 notifyUrl', hint: '微信支付下单必须给回调地址（https 绝对 URL）' };
      }
      const subject = String(args.subject || `订单 ${orderId}`).trim().slice(0, 127);
      const body = JSON.stringify({
        appid: appId,
        mchid: mchId,
        description: subject,
        out_trade_no: orderId,
        notify_url: notifyUrl,
        amount: { total: amount, currency: 'CNY' },
      });
      const urlPath = '/v3/pay/transactions/native';
      let headers;
      try {
        headers = signedHeaders('POST', urlPath, body);
      } catch {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          reason: '商户私钥无法解析（privateKeyPem 格式不对）',
          hint: 'apiclient_key.pem 的完整 PEM，或它里面那串 base64',
        };
      }
      const res = await httpCall(fetchImpl, `${apiBase}${urlPath}`, { method: 'POST', headers, body });
      if (!res.ok) return { ok: false, provider: WECHAT_PROVIDER, reason: res.reason, detail: res.detail };
      if (res.status < 200 || res.status >= 300) {
        const message = providerMessage(res.json, res.text?.slice(0, 200) || '');
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          reason: `微信支付拒单（HTTP ${res.status}）：${message || '没有返回错误说明'}`,
          httpStatus: res.status,
          detail: message,
        };
      }
      const json = res.json || {};
      if (!json.code_url) {
        return { ok: false, provider: WECHAT_PROVIDER, reason: '微信返回里没有 code_url', raw: json };
      }
      return { ok: true, provider: WECHAT_PROVIDER, url: null, code: String(json.code_url), raw: json };
    },

    /**
     * 校验回调：验签（平台证书）→ 解密 resource（APIv3 密钥）→ 抠出订单号/金额/是否成功。
     * 验签不过一律 ok:false 且 signatureOk:false，绝不"先信后查"。
     */
    verifyWebhook(args = {}) {
      if (!notifyConfigured) {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          signatureOk: false,
          reason: UNCONFIGURED,
          hint: '回调查验需要 billing.wechat.apiV3Key（32 位）和 platformCertPem（微信平台证书）',
        };
      }
      const rawBody = String(args.rawBody ?? '');
      const headers = args.headers || {};
      const timestamp = headerValue(headers, 'wechatpay-timestamp');
      const nonce = headerValue(headers, 'wechatpay-nonce');
      const signature = headerValue(headers, 'wechatpay-signature');
      if (!timestamp || !nonce || !signature) {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          signatureOk: false,
          reason: '缺少 Wechatpay-Timestamp / Wechatpay-Nonce / Wechatpay-Signature 请求头',
        };
      }
      const nowSec = Math.floor(now() / 1000);
      const skew = Math.abs(nowSec - Number(timestamp));
      if (!/^\d+$/.test(timestamp) || skew > WECHAT_TOLERANCE_SEC) {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          signatureOk: false,
          reason: `通知时间戳超出 ${WECHAT_TOLERANCE_SEC}s 容差（可能是重放攻击）`,
          timestampSkew: skew,
        };
      }
      const matched = rsaVerifyBase64(platformCertPem, wechatNotifySignMessage(timestamp, nonce, rawBody), signature);
      if (!matched) {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          signatureOk: false,
          reason: '通知签名不匹配（平台证书不对，或内容被篡改）',
        };
      }
      let notification = null;
      try {
        notification = JSON.parse(rawBody);
      } catch {
        return { ok: false, provider: WECHAT_PROVIDER, signatureOk: true, reason: '签名通过，但 body 不是合法 JSON' };
      }
      let resource = null;
      try {
        resource = decryptWechatResource(notification?.resource, apiV3Key);
      } catch (err) {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          signatureOk: true,
          reason: `通知资源解密失败：${String((err && err.message) || err)}`,
          hint: '多半是 apiV3Key 不对（要 32 位、且是当前商户号的）',
        };
      }
      if (resource?.mchid && mchId && String(resource.mchid) !== mchId) {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          signatureOk: true,
          reason: '通知里的 mchid 与本机配置不一致',
        };
      }
      return {
        ok: true,
        provider: WECHAT_PROVIDER,
        signatureOk: true,
        event: { id: String(notification?.id || ''), type: String(notification?.event_type || resource?.trade_state || '') },
        orderId: resource?.out_trade_no == null ? null : String(resource.out_trade_no),
        paidAmount: Number.isInteger(resource?.amount?.total) ? resource.amount.total : null,
        paid: String(resource?.trade_state || '').toUpperCase() === 'SUCCESS',
        raw: { notification: { id: notification?.id, event_type: notification?.event_type }, resource },
      };
    },

    /**
     * 退款。微信 APIv3 的退款金额要同时给"原订单总额 total"和"本次退款 refund"，
     * 缺 total 只能明确报错（微信不给默认值，我们也不能瞎猜）。
     */
    async refund(args = {}) {
      if (!configured) {
        return unconfiguredResult('设置 billing.wechat.mchId / appId / serialNo / privateKeyPem（商户 API 证书私钥）');
      }
      const orderId = String(args.orderId || '').trim();
      if (!orderId) return { ok: false, provider: WECHAT_PROVIDER, reason: '缺少 orderId（对应 out_trade_no）' };
      const amount = assertMinor(args.amount, 'amount');
      const total = args.total ?? args.orderTotal;
      if (!Number.isInteger(total) || total <= 0) {
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          reason: '缺少原订单总额 total',
          hint: '微信退款要同时给原订单总额（total）和退款额（amount），这是它的规范；两者都按整数分',
        };
      }
      if (amount > total) return { ok: false, provider: WECHAT_PROVIDER, reason: '退款金额不能大于原订单总额' };
      const body = JSON.stringify({
        out_trade_no: orderId,
        out_refund_no: String(args.outRefundNo || `r${orderId}${Math.floor(now() / 1000)}`).slice(0, 64),
        ...(args.reason ? { reason: String(args.reason).slice(0, 80) } : {}),
        amount: { refund: amount, total, currency: 'CNY' },
      });
      const urlPath = '/v3/refund/domestic/refunds';
      let headers;
      try {
        headers = signedHeaders('POST', urlPath, body);
      } catch {
        return { ok: false, provider: WECHAT_PROVIDER, reason: '商户私钥无法解析（privateKeyPem 格式不对）' };
      }
      const res = await httpCall(fetchImpl, `${apiBase}${urlPath}`, { method: 'POST', headers, body });
      if (!res.ok) return { ok: false, provider: WECHAT_PROVIDER, reason: res.reason, detail: res.detail };
      if (res.status < 200 || res.status >= 300) {
        const message = providerMessage(res.json, res.text?.slice(0, 200) || '');
        return {
          ok: false,
          provider: WECHAT_PROVIDER,
          reason: `微信退款被拒（HTTP ${res.status}）：${message || '没有返回错误说明'}`,
          httpStatus: res.status,
        };
      }
      const json = res.json || {};
      if (!json.refund_id) {
        return { ok: false, provider: WECHAT_PROVIDER, reason: '微信返回里没有退款单号（refund_id）', raw: json };
      }
      return {
        ok: true,
        provider: WECHAT_PROVIDER,
        refundId: String(json.refund_id),
        status: String(json.status || ''),
        raw: json,
      };
    },
  };
}
