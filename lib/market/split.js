/**
 * lib/market/split.js —— 80/20 分账（创作者 / 平台）
 *
 * 为什么单独一层：
 *   分账是最容易出现「少一分钱」的地方。这里只用整数分和整数比例（basis points），
 *   一次乘除算清楚，**不做浮点累加**；平台那份用「总额 - 创作者」补齐，
 *   保证 creator + platform 恒等于 total，永远不差分。
 *
 * 比例用基点（bps）：8000 = 80%，2000 = 20%。要调成 7:3 只要改 creatorBps=7000。
 */

/** 创作者默认分成（基点）：80% */
export const CREATOR_SHARE_BPS = 8000;
/** 平台默认抽成（基点）：20% */
export const PLATFORM_SHARE_BPS = 10000 - CREATOR_SHARE_BPS;
/** 比例满格 */
export const TOTAL_BPS = 10000;

/**
 * 整数乘除，四舍五入到整数（BigInt 算，绝不经过浮点）。
 * @param {number} value 被乘数（整数）
 * @param {number} mul 乘数（整数）
 * @param {number} div 除数（正整数）
 * @returns {number}
 */
function mulDivRound(value, mul, div) {
  const product = BigInt(value) * BigInt(mul);
  const d = BigInt(div);
  const q = product / d;
  const r = product % d;
  // 余数过半就进一（等价于 Math.round，但全程整数）
  return Number(r * 2n >= d ? q + 1n : q);
}

/**
 * 把一笔钱按基点拆成两半，恒等式：creator + platform === total。
 * @param {number} amountCents 金额（整数分，必须 > 0）
 * @param {{ creatorBps?: number }} [opts]
 * @returns {{ ok:true, total:number, creator:number, platform:number, creatorBps:number,
 *   platformBps:number, currency:'CNY' } | { ok:false, reason:string }}
 */
export function splitCents(amountCents, { creatorBps = CREATOR_SHARE_BPS } = {}) {
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents) || !Number.isInteger(amountCents)) {
    return { ok: false, reason: `金额必须是整数分（收到 ${String(amountCents)}），不接受小数或字符串` };
  }
  if (amountCents <= 0) {
    return { ok: false, reason: `金额必须大于 0 分（收到 ${amountCents}）` };
  }
  if (typeof creatorBps !== 'number' || !Number.isInteger(creatorBps) || creatorBps < 0 || creatorBps > TOTAL_BPS) {
    return { ok: false, reason: `分成比例必须是 0~10000 的整数基点（收到 ${String(creatorBps)}）` };
  }
  const creator = mulDivRound(amountCents, creatorBps, TOTAL_BPS);
  // 平台那份用减法补齐，永远不会出现 1440 + 361 = 1801 这种差分
  const platform = amountCents - creator;
  return {
    ok: true,
    total: amountCents,
    creator,
    platform,
    creatorBps,
    platformBps: TOTAL_BPS - creatorBps,
    currency: 'CNY',
  };
}

/**
 * 对一张订单分账（订单里的 amount 已经是整数分）。
 * @param {{ amount?:number }} order
 * @param {{ creatorBps?: number }} [opts]
 */
export function splitOrder(order, opts = {}) {
  const amount = order && typeof order === 'object' ? order.amount : undefined;
  return splitCents(amount, opts);
}

/**
 * 校验一组分账是否自洽（读盘后、展示前都可以过一遍）。
 * @param {Array<{amount?:number, creator?:{amount?:number}, platform?:{amount?:number}}>} entries
 * @returns {{ ok:boolean, total:number, creator:number, platform:number, broken:number }}
 */
export function verifySplits(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let total = 0;
  let creator = 0;
  let platform = 0;
  let broken = 0;
  for (const item of list) {
    const amount = item && Number.isInteger(item.amount) ? item.amount : NaN;
    const c = item && item.creator && Number.isInteger(item.creator.amount) ? item.creator.amount : NaN;
    const p = item && item.platform && Number.isInteger(item.platform.amount) ? item.platform.amount : NaN;
    if (!Number.isInteger(amount) || !Number.isInteger(c) || !Number.isInteger(p) || c + p !== amount) {
      broken += 1;
      continue;
    }
    total += amount;
    creator += c;
    platform += p;
  }
  return { ok: broken === 0, total, creator, platform, broken };
}
