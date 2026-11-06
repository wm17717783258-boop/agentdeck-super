/**
 * tools/market.js —— `deck_market` 工具（皮肤市场：看货架 / 下单 / 查订单 / 退款 / 支付渠道状态）
 *
 * 为什么市场要成一个工具而不是只做网页按钮：
 *   用户最自然的表达是"给我换套皮肤""这套多少钱""我买的那套怎么没到"。
 *   让模型自己查货架、自己下单，比让用户点网页快；而"点购买"真正要落的账，
 *   和网页按钮走的是同一份 lib/market/** 实现（这条铁律见 docs/NEXI-FINAL-PLAN.md 第 2 节）。
 *
 * 诚实边界（三句话，改代码前先读）：
 *   1. 没配支付渠道时，buy 一律返回 `环境未配` 并指出缺哪个字段——**绝不伪造"支付成功"**。
 *   2. 本机购买只发本机回执（记进 <root>/market/ledger.json），跨机授权仍归 lib/license.js。
 *   3. 密钥、渠道私钥、webhook secret 一律不回显；health 只说"配了/没配"和缺哪一项。
 */

import { normalizeDeps, safeExecute } from './common.js';

const ACTIONS = ['catalog', 'health', 'buy', 'orders', 'refund'];

/** 分 → 「¥18」。整数分是硬约束，这里只做展示，不做四舍五入的生意。 */
function yuan(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return '免费';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(n));
  const whole = Math.floor(abs / 100);
  const rest = abs % 100;
  return rest === 0 ? `${sign}¥${whole}` : `${sign}¥${whole}.${String(rest).padStart(2, '0')}`;
}

/** 订单状态 → 中文（账本里存的是英文 state，别把英文甩给用户）。 */
const ORDER_ZH = { created: '待付款', paid: '已付款', delivered: '已发放', refunded: '已退款' };
const zhOrder = (state) => ORDER_ZH[String(state || '')] || String(state || '未知');

/** 货架一行：拥有 / 在售 / 未上架，三种状态说清楚。 */
function entryLine(entry, index) {
  const id = String(entry.id || '');
  const name = String(entry.name || id || '未命名');
  const state = entry.owned
    ? '已拥有'
    : (Number(entry.price) > 0 ? `${yuan(entry.price)}` : '免费');
  const tail = entry.owned
    ? (entry.active ? '· 正在用' : '· 说「换上」我就换')
    : (Number(entry.price) > 0
      ? (entry.locked === false ? '· 当前档位已包含' : `· 说「买 ${id}」我就下单`)
      : '· 直接说「换上」');
  return `${index + 1}. ${name}（${id}） ${state} ${tail}`;
}

/** 支付渠道状态写成一段人话；缺什么就写什么，不写"请联系管理员"。 */
function healthText(health) {
  const h = health && typeof health === 'object' ? health : {};
  const provider = String(h.provider || '') || '（未配）';
  const lines = [`支付渠道：${provider}`];
  if (h.configured === true) {
    lines.push('状态：已配置，可以真的收款。');
  } else {
    lines.push('状态：未配置 —— 现在点购买不会扣钱，也不会假装扣过。');
    const hint = String(h.hint || h.reason || '').trim();
    if (hint) lines.push(`缺什么：${hint}`);
    if (Array.isArray(h.missing) && h.missing.length) lines.push(`缺的字段：${h.missing.join('、')}`);
    lines.push('怎么配：设置环境变量 AGENTDECK_PAY_PROVIDER=stripe|wechat|alipay，再按对应渠道补密钥；配完重启宿主。');
  }
  const providers = Array.isArray(h.providers) ? h.providers : [];
  if (providers.length) {
    const table = providers.map((p) => `${p.id}${p.configured ? '（已配）' : '（未配）'}`);
    lines.push(`可选渠道：${table.join('、')}`);
  }
  return lines.join('\n');
}

/**
 * 造 `deck_market` 工具。
 * deps.market / deps.billing 任一缺失时，工具仍然存在，只是所有动作给人话（宿主启动是全有全无的）。
 */
export function createMarketTool(deps) {
  const raw = deps && typeof deps === 'object' ? deps : {};
  const d = normalizeDeps(raw);
  const market = raw.market || null;
  const billing = raw.billing || null;

  const rootOf = () => {
    if (d.root) return String(d.root());
    if (d.workspace) return String(d.workspace);
    return String(process.cwd());
  };

  const missing = () => {
    if (market && market.ok !== false) return '';
    const why = market && market.reason ? String(market.reason) : '市场模块没有加载（lib/market/** 缺失或加载失败）';
    return `【deck_market】${why}。皮肤可以手动放进 <工作区>/.agentdeck/skins/ 继续用，市场功能暂时不可用。`;
  };

  return {
    name: 'deck_market',
    description: [
      '皮肤市场：catalog=看货架与价格（默认），health=支付渠道配没配，buy=下单买一套，orders=本机订单，refund=退款。',
      '什么时候用：用户说"有什么皮肤/这套多少钱/给我买那套/我买的那套怎么没到"。',
      '没配支付渠道时 buy 会如实返回「环境未配」并说明缺哪个字段，不会伪造支付成功。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'catalog=货架（默认）；health=支付渠道状态；buy=下单；orders=本机订单；refund=退款。',
        },
        skinId: { type: 'string', description: 'buy 时必填：货架上的皮肤 id（如 premium-aurora）。' },
        orderId: { type: 'string', description: 'refund 时必填：orders 里看到的订单号。' },
      },
      required: [],
    },
    // 宿主契约（§2.8）：每个工具都要自带 { schema, render }；这里产出一段纯文本人话。
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string', description: '给人看的纯文本结果' } },
        required: ['text'],
      },
      render(args, value) {
        const text = typeof value === 'string' ? value : String(value?.text ?? '');
        return [{ type: 'text', text }];
      },
    },
    execute: safeExecute('deck_market', async (args) => {
      const action = String(args.action || 'catalog').toLowerCase();
      if (!ACTIONS.includes(action)) {
        return `【deck_market】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      }

      // ── health：渠道配没配。这一条不依赖 market，模块缺了也要能答 ──────────
      if (action === 'health') {
        let h = null;
        try {
          h = billing && typeof billing.health === 'function' ? billing.health() : null;
        } catch (err) {
          return `【deck_market】读取支付渠道状态失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!h) return '【deck_market】支付抽象层没有加载（lib/billing/** 缺失）：现在只能买免费皮肤。';
        return `【deck_market】\n${healthText(h)}`;
      }

      const gone = missing();
      if (gone) return gone;

      const root = rootOf();

      // ── catalog：货架 ────────────────────────────────────────────────────
      if (action === 'catalog') {
        let cat = null;
        try {
          cat = market.catalog({ root });
        } catch (err) {
          return `【deck_market】读货架失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!cat || cat.ok === false) {
          return `【deck_market】读货架失败：${String(cat?.reason || '未知原因')}`;
        }
        const skins = Array.isArray(cat.skins) ? cat.skins : [];
        if (!skins.length) return '【deck_market】货架是空的：还没有可卖的皮肤。把皮肤包放进 <工作区>/.agentdeck/skins/ 就会出现。';
        const own = skins.filter((s) => s.owned).length;
        const forSale = skins.filter((s) => !s.owned && Number(s.price) > 0).length;
        const head = `【deck_market】货架 ${skins.length} 套（已拥有 ${own} · 在售 ${forSale}）· 当前档位 ${String(cat.tier || 'free')}`;
        return `${head}\n${skins.map(entryLine).join('\n')}`;
      }

      // ── orders：本机订单 ────────────────────────────────────────────────
      if (action === 'orders') {
        let list = null;
        try {
          list = market.orders({ root });
        } catch (err) {
          return `【deck_market】读订单失败：${String(err?.message || err).slice(0, 200)}`;
        }
        const rows = Array.isArray(list?.orders) ? list.orders : Array.isArray(list) ? list : [];
        if (!rows.length) return '【deck_market】本机还没有订单。看中了哪套说「买 <id>」就行。';
        const lines = rows.slice(0, 10).map((o, i) => {
          const when = String(o.createdAt || o.at || '').replace('T', ' ').slice(0, 16);
          const name = String(o.skinName || o.skinId || '');
          return `${i + 1}. ${String(o.id || o.orderId || '')} · ${name} · ${yuan(o.amount)} · ${zhOrder(o.state || o.status)}${when ? ` · ${when}` : ''}`;
        });
        const counts = list?.counts && typeof list.counts === 'object' ? list.counts : null;
        const head = counts
          ? `【deck_market】本机订单 ${rows.length} 笔（待付款 ${counts.created || 0} · 已付款 ${counts.paid || 0} · 已发放 ${counts.delivered || 0} · 已退款 ${counts.refunded || 0}）：`
          : `【deck_market】最近 ${lines.length} 笔订单：`;
        return `${head}\n${lines.join('\n')}`;
      }

      // ── buy：下单 + 确认支付 ────────────────────────────────────────────
      if (action === 'buy') {
        const skinId = String(args.skinId || '').trim();
        if (!skinId) return '【deck_market】买哪一套？给我皮肤 id（先 catalog 看一眼）。';
        const entry = (() => {
          try { return market.entry ? market.entry(skinId, { root }) : null; } catch { return null; }
        })();
        if (entry && entry.ok === false) return `【deck_market】货架上没有 "${skinId}"。`;
        if (entry && entry.owned) return `【deck_market】"${String(entry.name || skinId)}" 你已经有了，不用再买。让 pet_skin activate 换上就行。`;

        let result = null;
        try {
          result = await market.buy({ root, skinId });
        } catch (err) {
          return `【deck_market】下单失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!result || result.ok === false) {
          const reason = String(result?.reason || '未知原因');
          const hint = String(result?.hint || result?.detail || '').trim();
          const orderId = String(result?.order?.id || '');
          if (reason === '环境未配') {
            return [
              `【deck_market】"${skinId}" 现在买不了：支付渠道未配置（环境未配）。`,
              orderId ? `订单 ${orderId} 已建但未付款，记在本机账本里。` : '',
              hint ? `缺什么：${hint}` : '',
              '怎么配：AGENTDECK_PAY_PROVIDER=stripe|wechat|alipay + 对应密钥，配完重启宿主再来。',
              '这条不会扣钱，也没有任何"假装买到了"的记录。',
            ].filter(Boolean).join('\n');
          }
          return `【deck_market】下单没成：${reason}${hint ? `\n${hint}` : ''}`;
        }
        const order = result.order && typeof result.order === 'object' ? result.order : {};
        const state = String(order.state || result.state || '');
        const paid = result.paid === true || state === 'paid' || state === 'delivered';
        const name = String(entry?.name || skinId);
        const orderId = String(order.id || result.id || result.orderId || '');
        if (paid) {
          const code = String(order.delivery?.code || result.code || '');
          return [
            `【deck_market】买到了：${name} · ${yuan(order.amount ?? entry?.price)}`,
            `订单 ${orderId}${code ? `，本机回执 ${code}` : ''}`,
            `现在说「换上 ${skinId}」就能用（pet_skin activate）。`,
          ].join('\n');
        }
        return [
          `【deck_market】下单成功但还没付款：${name} · ${yuan(order.amount ?? entry?.price)}`,
          `订单 ${orderId}`,
          result.payUrl ? `去这里付：${String(result.payUrl)}` : '',
          '付完回来说一声，我确认到账后发放。',
        ].filter(Boolean).join('\n');
      }

      // ── refund：退款 ────────────────────────────────────────────────────
      if (action === 'refund') {
        const orderId = String(args.orderId || '').trim();
        if (!orderId) return '【deck_market】退哪一笔？给我订单号（orders 看一眼）。';
        let result = null;
        try {
          result = await market.refund({ root, orderId });
        } catch (err) {
          return `【deck_market】退款失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!result || result.ok === false) {
          return `【deck_market】退款没成：${String(result?.reason || '未知原因')}${result?.hint ? `\n${String(result.hint)}` : ''}`;
        }
        return `【deck_market】已退款：订单 ${orderId}${result.order?.amount ? ` · ${yuan(result.order.amount)}` : ''}。本机账本已冲正，皮肤退回未拥有状态。`;
      }

      return `【deck_market】不认识的动作 "${action}"。`;
    }),
  };
}

export default createMarketTool;
