/**
 * tools/license.js —— `deck_license` 工具（档位 / 价格 / 粘贴授权码）
 *
 * 为什么单独一个工具而不是只做命令：
 *   用户常常是"正在跟模型聊天时想起来要升级"，让模型自己能查到档位、能写授权码，
 *   比让用户去翻文档找命令快得多。而 `activate` 只是把一串码写进文件，天然适合工具做。
 *
 * 降级原则：lib/license.js 没加载（老版本装法/文件缺失）时，本工具仍存在，
 * 只是所有动作都返回"按免费版处理"的人话，不抛错——宿主启动是全有全无的。
 */

import { normalizeDeps, safeExecute } from './common.js';

const ACTIONS = ['status', 'plans', 'activate'];

/** 把毫秒时间戳写成 YYYY-MM-DD（到期日给人看）。 */
function fmtDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n < 1e12 ? n * 1000 : n); // claims.exp 是秒，这里两种都兼容
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 当前档位的"值不值"一句话：免费版够用就别劝人花钱。 */
function verdict(tier) {
  if (tier === 'free') return '免费版已够单机全功能使用；需要多台机器一起干活时再升级（协作版起有云房间）。';
  if (tier === 'pro') return '协作版：可以建 1 个云房间，最多 8 台机器进同一个任务板。';
  if (tier === 'studio') return '工作室版：5 个云房间、30 席位、并行 6，付费皮肤全解锁。';
  return '未知档位，按免费版处理。';
}

/** 档位 id → 中文档位名（给用户看的一律用 label，id 只留在结构体里）。 */
function tierLabel(api, tier) {
  const id = String(tier || 'free');
  try {
    const label = api?.entitlements?.(id)?.label;
    if (label) return String(label);
  } catch { /* 权益表坏了就走下面的兜底 */ }
  if (id === 'free') return '免费版';
  if (id === 'pro') return '协作版';
  if (id === 'studio') return '工作室版';
  return id;
}

export function createLicenseTool(deps) {
  const d = normalizeDeps(deps);
  const rootOf = () => {
    // 授权跟人走：优先机级目录（d.licenseRoot），没有才退回工作区（老插件/老测试）
    if (d.licenseRoot) return String(d.licenseRoot());
    if (d.root) return String(d.root());
    return String(d.workspace || process.cwd());
  };

  return {
    name: 'deck_license',
    description: [
      '查询或激活 agentdeck-super 的授权：status=当前档位/到期/席位（默认），plans=三档价格，activate=写入授权码并校验。',
      '什么时候用：用户问"我现在是什么版本/怎么升级/到期了吗"，或者用户把一串授权码贴给你让你启用。',
      '免费版不写授权码也能用全部单机功能；本工具不会因为授权缺失而报错。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'status=看当前档位（默认）；plans=看价格表；activate=写入授权码。',
        },
        key: { type: 'string', description: '授权码（activate 时必填，整串字母数字，不要带引号）。' },
      },
      required: [],
    },
    // 宿主契约（§2.8）：每个工具都要自带 { schema, render }。
    // 这里返回的就是一段纯文本人话，所以 schema 只声明 text，render 原样吐一个 content 块。
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
    execute: safeExecute('deck_license', async (args) => {
      const action = String(args.action || 'status').toLowerCase();
      if (!ACTIONS.includes(action)) {
        return `【deck_license】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      }

      const api = d.license;
      if (!api || typeof api.currentLicense !== 'function') {
        return '【deck_license】授权模块没有加载（lib/license.js 缺失或加载失败），当前一切按免费版处理：单机功能全可用，跨机房间不可用。';
      }
      const root = rootOf();
      // 工具可能在任何页面之前被调用（升级后第一句就是「我现在什么档位」）：
      // 读授权前先让插件补一次工作区→机级的迁移，否则会读机级空目录、当场掉回免费版。
      d.migrateLicense?.();

      if (action === 'plans') {
        const table = Array.isArray(api.PRICE_TABLE) ? api.PRICE_TABLE : [];
        if (!table.length) return '【deck_license】价格表不可用（PRICE_TABLE 缺失）。';
        const lines = table.map((row, i) => {
          const price = `${row.price || ''}${row.per || ''}`;
          return `${i + 1}. ${row.name}${price ? ` — ${price}` : ''}\n   ${row.sell || ''}`;
        });
        return [
          '【deck_license】三档价格',
          ...lines,
          '',
          '怎么买：在 https://agentdeck.dev/pricing（或市场页）付款后会收到一串授权码；拿到后在对话里让我 deck_license activate，或打开 /deck 状态页粘贴。',
          '免费版足够单机用，不要为了"看起来专业"去买——多台机器同一个任务板才需要云房间。',
        ].join('\n');
      }

      if (action === 'activate') {
        const key = String(args.key || '').trim();
        if (!key) return '【deck_license】activate 需要 key：请把收到的授权码整串贴进来（一般在邮件里，以 ADSK1 开头）。';
        const check = typeof api.verifyLicense === 'function' ? api.verifyLicense(key) : { ok: false, reason: '校验器不可用' };
        if (!check || !check.ok) {
          const why = check?.reason || check?.code || '未知原因';
          const nowTier = api.currentLicense(root)?.tier || 'free';
          return `【deck_license】这串授权码没通过校验：${why}。\n授权码**没有**写入（写进去也不会生效），当前仍是 ${tierLabel(api, nowTier)}。\n常见原因：复制时带了空格/换行、码被换行截断、或者这是别的产品的码。`;
        }
        const wrote = typeof api.writeLicenseKey === 'function' ? api.writeLicenseKey(root, key) : { ok: false, reason: '写入器不可用' };
        if (!wrote || !wrote.ok) {
          return `【deck_license】校验通过（${tierLabel(api, check.tier)}），但写授权文件失败：${wrote?.reason || '未知原因'}。\n可以手工把码写进：${api.licensePath ? api.licensePath(root) : '<工作区>/.agentdeck/license/key.txt'}`;
        }
        const lic = api.currentLicense(root);
        const ent = lic?.entitlements || {};
        const exp = fmtDate(lic?.claims?.exp);
        return [
          `【deck_license】授权已启用：${tierLabel(api, lic?.tier || check.tier)}${exp ? `（到期 ${exp}）` : '（长期有效）'}`,
          ent && typeof api.describeEntitlements === 'function' ? `权益：${api.describeEntitlements(ent)}` : '',
          `授权文件：${wrote.path || ''}`,
          '注意：云房间需要重启一次会话才会按新档位放开（插件在启动时读授权）。',
        ].filter(Boolean).join('\n');
      }

      // status
      const lic = api.currentLicense(root) || {};
      const ent = lic.entitlements || {};
      const exp = fmtDate(lic.claims?.exp);
      const seats = lic.claims?.seats ?? ent.maxSeats ?? '';
      let licPath = '';
      try {
        licPath = typeof api.licensePath === 'function' ? String(api.licensePath(root) || '') : '';
      } catch { licPath = ''; }
      const lines = [
        `【deck_license】当前档位：${ent.label || tierLabel(api, lic.tier)}`,
        lic.ok ? `授权状态：有效${lic.claims?.sub ? `（授权给 ${lic.claims.sub}）` : ''}` : `授权状态：${lic.reason || '未激活'}`,
        exp ? `到期：${exp}` : '到期：长期 / 未设置',
        seats !== '' ? `席位上限：${seats}` : '',
        typeof api.describeEntitlements === 'function' ? `权益：${api.describeEntitlements(ent)}` : '',
        licPath ? `授权文件：${licPath}（跟人走：换项目目录不用重新激活）` : '',
        `一句话：${verdict(lic.tier || 'free')}`,
      ].filter(Boolean);
      if (lic.tier === 'free') {
        lines.push('要跨机协作：先 deck_license plans 看价格，付款后 deck_license activate 粘贴授权码。');
      }
      return lines.join('\n');
    }),
  };
}

export default { createLicenseTool };
