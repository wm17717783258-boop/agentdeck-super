/**
 * tools/market.js —— `deck_market` 工具（皮肤市场：看货架 / 下单 / 查订单 / 退款 / 支付渠道状态）
 *
 * 为什么市场要成一个工具而不是只做网页按钮：
 *   用户最自然的表达是"给我换套皮肤""这套多少钱""我买的那套怎么没到"。
 *   让模型自己查货架、自己下单，比让用户点网页快；而"点购买"真正要落的账，
 *   和网页按钮走的是同一份 lib/market/** 实现（这条铁律见 docs/NEXI-FINAL-PLAN.md 第 2 节）。
 *
 * 本文件与账务核心都在开源侧（1.11.9 起重划边界）。只有三个动作落到闭源层：
 *   themes（主题包）/ invoice（发票）/ reconcile（对账）—— 它们是卖家侧与结算工具。
 * 买、卖、退、查这些买家动作全部开源，所以免费用户能付钱、能拿到皮肤。
 *
 * 诚实边界（三句话，改代码前先读）：
 *   1. 没配支付渠道时，buy 一律返回 `环境未配` 并指出缺哪个字段——**绝不伪造"支付成功"**。
 *   2. 本机购买只发本机回执（记进 <root>/market/ledger.json），跨机授权仍归 lib/license.js。
 *   3. 密钥、渠道私钥、webhook secret 一律不回显；health 只说"配了/没配"和缺哪一项。
 */

import { normalizeDeps, safeExecute } from './common.js';
import { readPayInfo, writePayInfo, payInfoLines, payInfoPath, PAY_KINDS } from '../market/payout.js';
// 主题包 / 发票 / 对账属于闭源商业层（pro/market/**）。
// 开源版没装 Nexi Pro 时，这三个动作统一回一句人话，其余动作（货架/下单/订单/退款）不受影响。
import { loadPro } from '../pro-resolve.js';

/**
 * 闭源层没装时统一的话术。注意这里只覆盖 themes / invoice / reconcile 三件事 ——
 * 买家动作（货架、下单、人工确认、订单、退款）都在开源侧，任何时候都不该走到这里。
 */
const PRO_NEEDED = (what) => `【deck_market】${what}属于卖家侧工具，需要 Nexi Pro（商业层未安装）。`
  + '买皮肤、下单、确认到账、退款、查订单这些都不需要 Pro，照常可用。';

const ACTIONS = ['catalog', 'health', 'buy', 'place', 'confirm', 'orders', 'refund', 'payinfo', 'reconcile', 'invoice', 'themes'];

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

/**
 * 支付渠道状态写成一段人话；缺什么就写什么，不写"请联系管理员"。
 *
 * payPro 是"商业层装没装"：
 *   · 装了但没配 → 教他设 AGENTDECK_PAY_*，设完真能收款；
 *   · 压根没装 → **不许**教他设环境变量，因为没有任何代码读它。
 *     以前不分这两种情况，开源版用户照着设了一圈变量、重启、再买一次还是"未配"，
 *     只会以为插件坏了。宁可直说"在线收款要装商业层，现在走人工更省事"。
 */
function healthText(health, { payPro = true } = {}) {
  const h = health && typeof health === 'object' ? health : {};
  const provider = String(h.provider || '') || '（未配）';
  const purchase = typeof h.purchaseConfigured === 'boolean' ? h.purchaseConfigured : h.configured === true;
  const refund = h.refundConfigured === true;
  const lines = [`支付渠道：${provider}`];
  lines.push(`购买通道：${purchase ? '已配置，可以真的收款。' : '未配置 —— 现在点购买不会扣钱，也不会假装扣过。'}`);
  lines.push(`退款通道：${refund ? '已配置，退款会先经渠道确认。' : '未配置 —— 不会出现“已退款”，订单和皮肤都保持原样。'}`);
  const hint = String(h.hint || h.reason || '').trim();
  if (hint) lines.push(`缺什么：${hint}`);
  if (Array.isArray(h.missing) && h.missing.length) lines.push(`缺的字段：${h.missing.join('、')}`);
  if (!purchase) {
    if (payPro) {
      lines.push('怎么配购买：设置 AGENTDECK_PAY_PROVIDER=stripe|wechat|alipay，再补 AGENTDECK_PAY_URL；配完重启宿主。');
    } else {
      lines.push('怎么配购买：当前装的是开源版，没有在线收款模块 —— 设 AGENTDECK_PAY_* 也不会生效，别白折腾。');
      lines.push('  想自动收款：装 Nexi Pro 商业层后重启；不装也能收钱，走下面的人工渠道。');
    }
  }
  if (!refund) {
    if (payPro) {
      lines.push('怎么配退款：设置 AGENTDECK_PAY_REFUND_URL 指向真实退款接口；没配之前本机只做“拒绝退款”，不做假退款。');
    } else {
      lines.push('怎么配退款：同上，开源版没有在线退款接口；人工退回用 refund + refundRef 登记转账单号。');
    }
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

  /*
   * 工作区路径：**注入的 market 最权威**。
   * market 在构造时就绑定了 root，账本、货架、收款方式全按那个 root 落盘；
   * 如果这里另算一个 root（d.root() 或 process.cwd()），就会出现
   * "货架按 A 目录读、账本写进 B 目录"的错位 —— 测试里表现为跨用例污染，
   * 生产里表现为"明明买了却查不到单"。
   */
  const rootOf = () => {
    if (market && market.ok !== false && typeof market.root === 'string' && market.root) return String(market.root);
    if (d.root) return String(d.root());
    if (d.workspace) return String(d.workspace);
    return String(process.cwd());
  };

  const missing = () => {
    if (market && market.ok !== false) return '';
    const why = market && market.reason
      ? String(market.reason)
      : '皮肤市场模块没有加载';
    return `【deck_market】${why}。已装好的皮肤照常能用（<工作区>/.agentdeck/skins/），只是货架/下单/订单查不了。`;
  };

  return {
    name: 'deck_market',
    description: [
      '皮肤市场：catalog=看货架与价格（默认），health=支付渠道配没配，buy=下单并同步扣款（需在线渠道），place=只下单不扣款（人工转账起点），confirm=人工确认到账后发放（必须带 paymentRef 凭证，可带 licenseKey 附签名授权），orders=本机订单，payinfo=卖家收款方式（人工渠道靠它告诉买家往哪付），refund=退款（带 refundRef 走人工退回），reconcile=拿渠道对账单跟本机订单逐笔勾对（只报差异，不改账），invoice=开发票数据（票面字段，不是税务合规电子发票）。',
      '什么时候用：用户说"有什么皮肤/这套多少钱/给我买那套/我买的那套怎么没到"。',
      '没配支付渠道时 buy 会如实返回「环境未配」并说明缺哪个字段，不会伪造支付成功。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'catalog=货架（默认）；health=支付渠道状态；buy=下单并同步扣款；place=只下单不扣款；confirm=确认到账后发放；orders=本机订单；payinfo=卖家的收款方式；refund=退款（带 refundRef 为人工退回）；reconcile=对账；invoice=发票；themes=主题包。',
        },
        skinId: { type: 'string', description: 'buy / place 时必填：货架上的皮肤 id（如 premium-aurora）。' },
        orderId: { type: 'string', description: 'refund / confirm 时必填：orders 里看到的订单号。orders 带上它=看这一笔的详情（含签名授权码，换设备时用）。' },
        refundRef: { type: 'string', description: 'refund 走人工渠道时填：钱退回买家的转账单号。填了它就不再要求配置在线退款通道；不填则必须配 AGENTDECK_PAY_REFUND_URL。' },
        paymentRef: { type: 'string', description: 'confirm 时必填：转账单号 / 收款备注。人工确认到账的凭证，对账时以它为准；没有凭证就不发货。' },
        remote: { type: 'string', description: 'reconcile：渠道对账单（JSON 数组字符串）。每行 { orderId, amount, state, ref }，字段名也认 out_trade_no/transaction_id/total_amount。' },
        unit: { type: 'string', enum: ['cents', 'yuan'], description: 'reconcile：渠道金额单位，默认 cents（分）。' },
        sub: { type: 'string', enum: ['issue', 'list', 'export'], description: 'invoice：issue=开票（默认）/ list=查 / export=导出 JSON。' },
        titleType: { type: 'string', enum: ['personal', 'company'], description: 'invoice issue：抬头类型，默认 personal。' },
        titleName: { type: 'string', description: 'invoice issue：发票抬头名称。' },
        taxId: { type: 'string', description: 'invoice issue：公司抬头必填税号。' },
        taxRate: { type: 'number', description: 'invoice issue：税率（0.06 = 6%）。不填=未配置，票面按不含税处理并明写。' },
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
          h = market && typeof market.health === 'function'
            ? market.health()
            : (billing && typeof billing.health === 'function' ? billing.health() : null);
        } catch (err) {
          return `【deck_market】读取支付渠道状态失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!h) return '【deck_market】支付渠道模块没有加载：现在只能买免费皮肤，付费下单会如实失败（不会假装扣过钱）。';
        // payPro=false 表示装的是开源版：在线渠道的模块根本不在，别教用户去设环境变量
        const body = healthText(h, { payPro: raw.payPro !== false });
        const purchaseOk = h.purchaseConfigured === true;
        // 没配在线渠道不等于"买不了"：人工渠道（place → 转账 → confirm）本身就可用，
        // 而且它是开源能力。不写这句，用户会以为这功能是坏的。
        const manualNote = purchaseOk
          ? ''
          : [
            '',
            '不过现在就能收钱 —— 走人工渠道，不需要任何商户号：',
            '  1) deck_market action="place" skinId="<皮肤id>"   → 得到订单号与收款备注',
            '  2) 让买家按备注转账，你把转账单号记下来',
            '  3) deck_market action="confirm" orderId="<订单号>" paymentRef="<转账单号>"   → 自动发放',
          ].join('\n');
        return `【deck_market】\n${body}${manualNote}`;
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
      // ── themes：主题包（皮肤 + 音效 + 动作打包卖）─────────────────────
      if (action === 'themes') {
        const themesPro = await loadPro('market/themes.js');
        if (!themesPro.ok) return PRO_NEEDED('主题包');
        const { listThemes, themeHealth, describeTheme } = themesPro.mod;
        const listed = listThemes({ root });
        if (!listed.themes.length) {
          return '【deck_market】没有主题包。可以把自己的包放进 <工作区>/assets/themes/<id>/theme.json。';
        }
        // 已知皮肤 id：用来判断"包里的皮肤素材是不是真的在"——缺了就如实说。
        // 注意：这里必须走市场的 owned 判定，而不是只看付费订单；
        // 免费皮肤、档位权益、本机购买都属于「已拥有」的来源。
        const catalog = (() => {
          try {
            return market && typeof market.catalog === 'function' ? market.catalog({ root }) : null;
          } catch { return null; }
        })();
        const knownSkinIds = Array.isArray(catalog?.skins)
          ? catalog.skins.map((x) => x.id)
          : (() => {
              try {
                const s = raw.skins && typeof raw.skins.listSkins === 'function' ? raw.skins.listSkins({ root }) : null;
                return Array.isArray(s?.skins) ? s.skins.map((x) => x.id) : [];
              } catch { return []; }
            })();
        const ownedSkinIds = (() => {
          if (Array.isArray(catalog?.skins)) return catalog.skins.filter((x) => x.owned).map((x) => x.id);
          try {
            const purchased = market && typeof market.purchases === 'function' ? market.purchases({ root }) : null;
            return Array.isArray(purchased?.skins) ? purchased.skins : [];
          } catch { return []; }
        })();
        const priceOf = (id) => {
          try {
            const all = raw.skins?.listSkins?.({ root })?.skins || [];
            const s = all.find((x) => x.id === id);
            return s ? Math.round(Number(s.price ?? 0) * 100) : 0;
          } catch { return 0; }
        };

        const lines = [`【deck_market】主题包 ${listed.themes.length} 个：`, ''];
        for (const th of listed.themes) {
          const health = themeHealth(th, { knownSkinIds });
          lines.push(describeTheme(th, { skinPriceOf: priceOf, ownedSkinIds }));
          lines.push(health.ok ? '素材：齐' : `素材：缺 ${health.missingSkins.join('、')}`);
          lines.push('');
        }
        if (listed.warnings.length) lines.push(`跳过 ${listed.warnings.length} 个坏包：${listed.warnings.join('；')}`);
        return lines.join('\n');
      }

      if (action === 'orders') {
        let list = null;
        try {
          list = market.orders({ root });
        } catch (err) {
          return `【deck_market】读订单失败：${String(err?.message || err).slice(0, 200)}`;
        }
        const rows = Array.isArray(list?.orders) ? list.orders : Array.isArray(list) ? list : [];
        if (!rows.length) return '【deck_market】本机还没有订单。看中了哪套说「买 <id>」就行。';

        // ── 单笔详情：买完换设备就靠这里把码取回来 ────────────────────────
        // 换机时买家手上必须有一串 ADSK1，而这串码原来只在订单的 delivery 里躺着，
        // 列表不显示、也没有别的入口 → 「我买了，新电脑上怎么用」只能回去翻邮件。
        const wantId = String(args.orderId || args.id || '').trim();
        if (wantId) {
          const one = rows.find((o) => String(o.id || o.orderId || '') === wantId);
          if (!one) {
            const near = rows.slice(0, 3).map((o) => String(o.id || o.orderId || '')).filter(Boolean);
            return `【deck_market】没有这个订单：${wantId}${near.length ? `\n本机最近三笔：${near.join(' / ')}` : ''}`;
          }
          const when = String(one.createdAt || one.at || '').replace('T', ' ').slice(0, 16);
          const name = String(one.skinName || one.skinId || '');
          const code = String(one.delivery?.code || '');
          const lic = String(one.delivery?.licenseKey || '');
          const payRef = String(one.paymentRef || one.note || '');
          const out = [
            `【deck_market】订单 ${String(one.id || '')}`,
            `皮肤：${name} · ${yuan(one.amount)}`,
            `状态：${zhOrder(one.state || one.status)}${when ? ` · ${when}` : ''}`,
            payRef ? `付款凭证：${payRef}` : '',
            code ? `交付码：${code}` : '',
          ].filter(Boolean);
          if (lic) {
            out.push(
              '',
              '签名授权码（换设备就靠它）：',
              lic,
              '',
              `换机用法：在新设备上 deck_license activate key="${lic}"，然后 pet_skin activate ${String(one.skinId || '')}`,
              '这串码请自己留一份（邮件/记事本都行）—— 本机账本换台电脑读不到，码才是跟着你走的东西。',
              '它等于你的收据：别贴到公开群里（别人拿到就能用），要发给卖家核对就单发。',
            );
          } else if (one.state === 'delivered') {
            out.push(
              '',
              '这笔没有带签名授权码：皮肤只在这台机器有效，换设备要重新买。',
              '要跨设备用，让卖家签一张码（签发见 docs/PAY.md），再 deck_market confirm 时带 licenseKey 补记一次。',
            );
          }
          return out.join('\n');
        }

        const lines = rows.slice(0, 10).map((o, i) => {
          const when = String(o.createdAt || o.at || '').replace('T', ' ').slice(0, 16);
          const name = String(o.skinName || o.skinId || '');
          // 有签名码的订单打个标：不然用户根本不知道「这笔能换机」
          const movable = String(o.delivery?.licenseKey || '').startsWith('ADSK1.') ? ' · 可换机' : '';
          return `${i + 1}. ${String(o.id || o.orderId || '')} · ${name} · ${yuan(o.amount)} · ${zhOrder(o.state || o.status)}${movable}${when ? ` · ${when}` : ''}`;
        });
        const counts = list?.counts && typeof list.counts === 'object' ? list.counts : null;
        const head = counts
          ? `【deck_market】本机订单 ${rows.length} 笔（待付款 ${counts.created || 0} · 已付款 ${counts.paid || 0} · 已发放 ${counts.delivered || 0} · 已退款 ${counts.refunded || 0}）：`
          : `【deck_market】最近 ${lines.length} 笔订单：`;
        const movableCount = rows.filter((o) => String(o.delivery?.licenseKey || '').startsWith('ADSK1.')).length;
        const tail = movableCount
          ? `\n\n带「可换机」的订单有授权码：deck_market action="orders" orderId="<订单号>" 就能看到整串（换设备时用）。`
          : '';
        return `${head}\n${lines.join('\n')}${tail}`;
      }

      // ── invoice：开/查/导出**发票数据**（1.10.0）─────────────────────────
      // 注意：这是票面数据，不是税务合规的电子发票——真要开票得走税务平台或让渠道开，那要资质。
      if (action === 'invoice') {
        const invoicePro = await loadPro('market/invoice.js');
        if (!invoicePro.ok) return PRO_NEEDED('发票');
        const { exportInvoices, issueInvoice, listInvoices, renderInvoice } = invoicePro.mod;
        const sub = String(args.sub || args.invoiceAction || 'issue').toLowerCase();
        if (sub === 'issue') {
          const r = issueInvoice({
            root,
            orderId: args.orderId,
            title: { type: args.titleType, name: args.titleName, taxId: args.taxId },
            rate: args.taxRate,
          });
          if (!r.ok) return `【deck_market】开不了票：${r.reason}`;
          const head = r.existed ? '（这张单已经开过，返回原来那张）' : '';
          return `${renderInvoice(r.invoice)}${head ? `\n${head}` : ''}`;
        }
        if (sub === 'list') {
          const got = listInvoices({ root, orderId: args.orderId, limit: args.limit });
          if (!got.invoices.length) return `【deck_market】没有发票${args.orderId ? `（订单 ${args.orderId}）` : ''}。已付订单可以用 invoice 开。`;
          return [`【deck_market】发票 ${got.invoices.length} 张（共 ${got.total} 张）：`,
            ...got.invoices.map((i, n) => `${n + 1}. ${i.no} · ${i.orderId} · ¥${(Number(i.grossCents) / 100).toFixed(2)} · ${i.title?.name || '个人'}`),
          ].join('\n');
        }
        if (sub === 'export') {
          const exp = exportInvoices({ root, orderId: args.orderId });
          return [`【deck_market】导出 ${exp.count} 张发票（JSON，给财务/渠道）：`, '', exp.json].join('\n');
        }
        return `【deck_market】invoice 的子动作只有 issue / list / export，收到的是 "${sub}"。`;
      }

      // ── reconcile：拿渠道对账单跟本机订单逐笔勾对（1.10.0）───────────────
      if (action === 'reconcile') {
        const reconcilePro = await loadPro('market/reconcile.js');
        if (!reconcilePro.ok) return PRO_NEEDED('对账');
        const { reconcile, renderReconcile } = reconcilePro.mod;
        // 对账单来源：args.remote（数组或 JSON 字符串）。不支持去渠道拉——
        // 拉流水要商户号，那是"配齐之后"的事；这里先把勾对本身做对、可验。
        let remote = args.remote;
        if (typeof remote === 'string') {
          try {
            remote = JSON.parse(remote);
          } catch (err) {
            return `【deck_market】对账单 JSON 解析失败：${String(err?.message || err).slice(0, 160)}`;
          }
        }
        let result = null;
        try {
          result = reconcile({ root, remote, unit: String(args.unit || 'cents').toLowerCase() === 'yuan' ? 'yuan' : 'cents' });
        } catch (err) {
          return `【deck_market】对账跑不动：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!result.ok) return `【deck_market】${result.reason}`;
        return renderReconcile(result);
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
              `【deck_market】"${skinId}" 现在没法自动扣款：没有可用的在线收款渠道（环境未配）。`,
              orderId ? `订单 ${orderId} 已建但未付款，记在本机账本里。` : '',
              hint ? `缺什么：${hint}` : '',
              '这条不会扣钱，也没有任何"假装买到了"的记录。',
              '',
              '两条路都能走：',
              '  · 在线收款（需 Nexi Pro）：配 AGENTDECK_PAY_PROVIDER + AGENTDECK_PAY_URL，重启宿主',
              `  · 人工收款（现在就能用）：deck_market action="place" skinId="${skinId}" → 转账 → action="confirm"`,
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

      // ── place：只下单、不扣款（人工转账 / 线下收款的起点）────────────────
      // 为什么要把 buy 拆成 place + confirm：
      //   在线收银台是异步的（给链接 → 用户去付 → 回调才知道结果），
      //   而人工转账连链接都没有。两种场景都不能「点一下就算买到了」。
      if (action === 'place') {
        const skinId = String(args.skinId || '').trim();
        if (!skinId) return '【deck_market】买哪一套？给我皮肤 id（先 catalog 看一眼）。';
        const entry = (() => {
          try { return market.entry ? market.entry(skinId, { root }) : null; } catch { return null; }
        })();
        if (entry && entry.ok === false) return `【deck_market】货架上没有 "${skinId}"。`;
        if (entry && entry.owned) {
          return `【deck_market】"${String(entry.name || skinId)}" 你已经有了，不用再下单。`;
        }
        let placed = null;
        try {
          placed = market.placeOrder({ root, skinId, buyer: args.buyer });
        } catch (err) {
          return `【deck_market】下单失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!placed || placed.ok === false) {
          return `【deck_market】下单没成：${String(placed?.reason || '未知原因')}`;
        }
        const order = placed.order && typeof placed.order === 'object' ? placed.order : {};
        const orderId = String(order.id || '');
        /*
         * 复用已有待付款单时必须说清楚，不能让人以为又开了一张。
         * 这直接影响"转账填哪个备注"——两个备注就是两笔说不清的钱。
         */
        const reused = placed.reused === true;
        const head = reused
          ? `【deck_market】这套你已经有一张待付款单了，直接用它（没有再开新的）：${String(entry?.name || skinId)} · ${yuan(order.amount ?? entry?.price)}`
          : `【deck_market】已下单：${String(entry?.name || skinId)} · ${yuan(order.amount ?? entry?.price)}`;

        /*
         * 收款方式必须跟着订单一起给出去。
         * 只说"按约定方式转账"等于没说 —— 买家不知道往哪付，流程就卡在这里。
         * 没配时不假装：直说还没配，并给一条能立刻照做的命令。
         */
        const info = readPayInfo(root);
        const payLines = payInfoLines(info);
        const payBlock = payLines.length
          ? ['', '收款方式：', ...payLines]
          : [
            '',
            '收款方式：**还没配**（卖家第一次用要先填一次，之后每单都会自动带上）：',
            '  deck_market  action="payinfo"  methods=\'[{"kind":"alipay","account":"你的支付宝账号","name":"收款人"}]\'',
            `  也可以直接写文件：${payInfoPath(root)}`,
          ];

        return [
          head,
          `订单号：${orderId}`,
          `收款备注：MANUAL-${orderId}`,
          ...payBlock,
          '',
          '这是待付款订单，**没有扣任何钱**。按上面的方式转账后，卖家执行：',
          `  deck_market  action="confirm"  orderId="${orderId}"  paymentRef="<转账单号或备注>"`,
          '确认到账才会发放皮肤；不确认就一直挂在「待付款」。',
        ].join('\n');
      }

      // ── payinfo：卖家收款方式（人工渠道能不能真收到钱，全看这一段填没填）──
      if (action === 'payinfo') {
        const root = rootOf();
        // 带 methods 就是写入；不带就是查看
        if (args.methods !== undefined) {
          let methods = args.methods;
          if (typeof methods === 'string') {
            try {
              methods = JSON.parse(methods);
            } catch {
              return '【deck_market】methods 要是 JSON 数组，例如：\n'
                + '  [{"kind":"alipay","account":"you@example.com","name":"张三"}]\n'
                + `  kind 只能是：${PAY_KINDS.map((k) => k.kind).join(' / ')}`;
            }
          }
          if (!Array.isArray(methods)) return '【deck_market】methods 必须是数组（哪怕只有一条）。';
          const wrote = writePayInfo(root, { methods, note: args.note });
          if (!wrote.ok) {
            return `【deck_market】收款方式没存下来：${wrote.reason}`
              + (wrote.rejected ? `（有 ${wrote.rejected} 条格式不对，需要有 kind 和 account）` : '');
          }
          return [
            '【deck_market】收款方式已保存，之后每次下单都会自动带上：',
            ...payInfoLines({ methods: wrote.methods, note: args.note }),
            '',
            `文件：${wrote.path}`,
            '买家转账时备注 MANUAL-<订单号>，你收到后 confirm 就算成交。',
          ].join('\n');
        }

        const info = readPayInfo(root);
        const lines = payInfoLines(info);
        if (!lines.length) {
          return [
            '【deck_market】还没配收款方式 —— 配一次，以后每单都会自动带上，',
            '不配的话买家不知道钱往哪付，人工渠道就卡在第一步。',
            '',
            '  deck_market  action="payinfo"  methods=\'[{"kind":"alipay","account":"you@example.com","name":"张三"}]\'',
            '',
            `  kind 可选：${PAY_KINDS.map((k) => `${k.kind}（${k.label}）`).join('、')}`,
            `  也可以直接写文件：${payInfoPath(root)}`,
          ].join('\n');
        }
        return [
          '【deck_market】当前收款方式：',
          ...lines,
          '',
          `文件：${info.path}${info.updatedAt ? `（${info.updatedAt}）` : ''}`,
          '要改就再跑一次 action="payinfo" methods=...（整份覆盖）。',
        ].join('\n');
      }

      // ── confirm：人工确认到账 → 发放 ────────────────────────────────────
      // 诚实边界：这是**人工记账**，不是渠道自动验证。所以必须带凭证号，
      // 否则账本里留不下可对账的痕迹，事后分不清「真收了」还是「手滑点了」。
      if (action === 'confirm') {
        const orderId = String(args.orderId || '').trim();
        if (!orderId) return '【deck_market】确认哪一笔？给我 orderId（先 orders 看一眼）。';
        const ref = String(args.paymentRef || args.ref || '').trim();
        if (!ref) {
          return '【deck_market】人工确认必须带 paymentRef（转账单号 / 收款备注）。\n'
            + '没有凭证的话，账本就分不清这笔钱到底收没收到，对账时会变成糊涂账。';
        }
        // 人工渠道的 charge：直接认定已收到，把凭证写进订单流水号。
        const manualCharge = async ({ order } = {}) => ({
          ok: true,
          paid: true,
          provider: 'manual',
          ref: `${ref}${order && order.id ? `@${order.id}` : ''}`,
        });
        let done = null;
        try {
          // licenseKey 可选：卖家先签好授权码（ADSK1），确认到账时一起记进订单与账本。
          // 有它这套皮肤就"换机器也认、且伪造不了"；没有也不影响发放（本地凭据照样生效）。
          const signedKey = String(args.licenseKey || '').trim();
          done = await market.confirm({
            root,
            orderId,
            billing: manualCharge,
            ...(signedKey ? { licenseKey: signedKey } : {}),
          });
        } catch (err) {
          return `【deck_market】确认失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!done || done.ok === false) {
          return `【deck_market】确认没成：${String(done?.reason || done?.detail || '未知原因')}`;
        }
        const code = String(done.order?.delivery?.code || done.code || '');
        const storedKey = String(done.order?.delivery?.licenseKey || '');
        return [
          `【deck_market】已确认到账并发放：${orderId}`,
          code ? `本机回执：${code}` : '',
          `凭证：${ref}`,
          storedKey
            ? '签名授权：已随订单存档（这套皮肤换机器也认，伪造不了）。'
            : '提示：这次没附签名授权码 —— 皮肤只在这台机器上有效。要跨设备用，让卖家签一张（签发见 docs/PAY.md），再带 licenseKey 确认一次即可。',
          '说明：这是人工记账，不是渠道自动验证；对账时以这笔 paymentRef 为准。',
        ].filter(Boolean).join('\n');
      }

      // ── refund：退款 ────────────────────────────────────────────────────
      // 人工渠道的对称性：钱能靠"转账 + 人工确认"收进来，就必须能靠
      // "转账退回 + 人工登记"退出去。否则人工渠道只有进没有出，每笔退款都得手改账本。
      // 但凭证仍然强制：没有 refundRef 的"退款"和没有凭证的"到账"一样，都会把账搞乱。
      if (action === 'refund') {
        const orderId = String(args.orderId || '').trim();
        if (!orderId) return '【deck_market】退哪一笔？给我订单号（orders 看一眼）。';
        const refundRef = String(args.refundRef || '').trim();
        const manualRefund = refundRef
          ? {
            id: 'manual',
            refund: async ({ order } = {}) => ({
              ok: true,
              refunded: true,
              provider: 'manual',
              ref: `${refundRef}${order && order.id ? `@${order.id}` : ''}`,
            }),
          }
          : undefined;
        let result = null;
        try {
          result = await market.refund({ root, orderId, billing: manualRefund });
        } catch (err) {
          return `【deck_market】退款失败：${String(err?.message || err).slice(0, 200)}`;
        }
        if (!result || result.ok === false) {
          const code = String(result?.code || '');
          const why = String(result?.reason || '未知原因');
          const detail = String(result?.detail || result?.hint || '');
          if (code === 'refund_unconfigured') {
            return [
              `【deck_market】退款没成：退款通道未配置（${why}）。`,
              '订单仍是已发放，皮肤仍可用；本机没有假装钱已经退回。',
              detail ? `缺什么：${detail}` : '',
              '怎么配：设置 AGENTDECK_PAY_REFUND_URL 指向真实退款接口，配完重启宿主再来。',
              '或者走人工：钱已经转回给买家了的话，带凭证再退一次 —— '
                + `deck_market  action="refund"  orderId="${orderId}"  refundRef="<转账单号>"`,
            ].filter(Boolean).join('\n');
          }
          return [
            `【deck_market】退款没成：${why}${detail ? `\n${detail}` : ''}`,
            '订单仍是已发放，皮肤仍可用；本地账本没有改动。',
          ].join('\n');
        }
        const reset = result.profileReset;
        const resetText = reset && reset.needed
          ? (reset.ok
            ? `当前外观已切回 ${reset.next || 'basic'}。`
            : `当前外观切回 basic 失败：${reset.reason || '档案写入失败'}。`)
          : '';
        return `【deck_market】已退款：订单 ${orderId}${result.order?.amount ? ` · ${yuan(result.order.amount)}` : ''}。渠道流水 ${String(result.channel?.ref || result.refundId || '')}，本机账本已冲正，皮肤授权已收回。${resetText ? `\n${resetText}` : ''}`;
      }

      return `【deck_market】不认识的动作 "${action}"。`;
    }),
  };
}

export default createMarketTool;
