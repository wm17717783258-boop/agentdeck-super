/**
 * lib/billing/amount.js —— 金额一律用「整数分」
 *
 * 为什么死守整数分：
 * - 浮点数 12.34 * 100 = 1233.9999999999998，四舍五入到 1234 只是运气好；0.1 + 0.2 那套问题
 *   在钱上是不能接受的。所以对外 API 的 amount 永远是正整数分，需要元的地方（支付宝、展示）
 *   在边界上一次性转换。
 * - 转换函数拒绝超过两位小数，宁可报错也不静默四舍五入——静默丢钱比崩溃更糟。
 */

/** 是不是合法的正整数分。 */
export function isMinor(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 断言是正整数分；不是就抛 TypeError（编程错误，不是运行期业务失败）。 */
export function assertMinor(amount, label = 'amount') {
  if (!isMinor(amount)) {
    throw new TypeError(`${label} 必须是正整数分（整数、大于 0，例如 1999 表示 19.99 元）；收到 ${JSON.stringify(amount)}`);
  }
  return amount;
}

/** 整数分 → 元字符串，固定两位：1999 → '19.99'。 */
export function minorToYuan(minor) {
  assertMinor(minor);
  const yuan = Math.trunc(minor / 100);
  const fen = minor % 100;
  return `${yuan}.${String(fen).padStart(2, '0')}`;
}

/**
 * 元 → 整数分：'12.34' → 1234。
 * 只接受数字或"最多两位小数"的字符串；不接受千分位、货币符号、科学计数法。
 */
export function yuanToMinor(yuan, label = 'yuan') {
  const text = String(yuan ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new TypeError(`${label} 必须是「元」的十进制写法（最多两位小数，例如 12.34）；收到 ${JSON.stringify(yuan)}`);
  }
  const [whole, frac = ''] = text.split('.');
  const minor = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new TypeError(`${label} 换算成分之后不是正整数（收到 ${JSON.stringify(yuan)}）`);
  }
  return minor;
}
