/**
 * tools/identity.js —— `agent_passport` 工具（Agent 通行证 v1）
 *
 * 为什么值得一个独立工具：方案里的 Agent 护照是"我把这个 Agent 借给你/加进你的小组"时
 * 唯一能拿出来的凭证。没有它，"能力"就只是 `agent_join capabilities` 里的一行标签，
 * 谁都能自称会干十件事。有了它，卡上的能力清单是签过名的，改一个字就验不过。
 *
 * 五个动作：issue=签发 / verify=验卡 / show=看本机身份 / list=看已签发的卡 / revoke=本地吊销。
 * 所有动作都**永不 throw**：没身份、没卡、文件坏了，都返回人话。
 */

import { normalizeDeps, safeExecute, TOOL_OUTPUT } from './common.js';
import {
  DEFAULT_TTL_DAYS,
  identitySummary,
  issuePassport,
  readPassports,
  revokePassport,
  verifyPassport,
} from '../identity.js';

const ACTIONS = ['issue', 'verify', 'show', 'list', 'revoke'];

/** 秒/毫秒都兼容地写成 YYYY-MM-DD HH:mm（凭证类时间一律给人看，不给人算）。 */
function fmtTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

export function createPassportTool(deps) {
  const d = normalizeDeps(deps);
  const rootOf = () => {
    // 身份跟人走（和授权同一个根）：换项目目录不该换身份
    if (d.licenseRoot) return String(d.licenseRoot());
    if (d.root) return String(d.root());
    return String(d.workspace || process.cwd());
  };

  return {
    name: 'agent_passport',
    description: [
      'Agent 通行证（Ed25519 能力卡）：issue=给本机签一张卡（声明会干什么、到哪一层、多久有效），',
      'verify=验一张卡（可只接受某个 kid，可要求必须含某几项能力），show=看本机身份与 kid，',
      'list=看已签发的卡，revoke=本地吊销。',
      '什么时候用：把 Agent 加进别人的小组/借给别人用之前，先 issue 一张；收到别人的卡时 verify 一下。',
      '诚实边界：验签只证明"卡没被改过、kid 与公钥对得上、在有效期内"，不证明"操作者就是那个人"。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'issue=签发（默认）；verify=验卡；show=本机身份；list=已签发列表；revoke=本地吊销。',
        },
        name: { type: 'string', description: 'issue：这张卡给谁（Agent/桌宠名），例如 小犀。' },
        agent: { type: 'string', description: 'issue：Agent 类型，例如 dsh / claude-code / codex / cursor。' },
        host: { type: 'string', description: 'issue：跑在哪个宿主里（可选，给人看）。' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'issue：声明的能力（工具名或自定义能力标签），例如 ["team_board","pet_visit"]。也接受逗号分隔字符串。',
        },
        tier: { type: 'string', description: 'issue：卡上记录的合作档位（默认本机当前档位）。' },
        ttlDays: { type: 'number', description: `issue：有效期天数（默认 ${DEFAULT_TTL_DAYS}，上限 365）。` },
        card: { type: 'string', description: 'verify：要验的卡（NEXP1.xxx.yyy 整串，别带引号）。' },
        kid: { type: 'string', description: 'verify/revoke：只接受这个签发者（kid_ 开头），或要吊销的 kid/nonce。' },
        required: {
          type: 'array',
          items: { type: 'string' },
          description: 'verify：卡上必须包含的能力，缺一个就算不通过。',
        },
        nonce: { type: 'string', description: 'revoke：按卡序号吊销（psp_ 开头），和 kid 二选一。' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('agent_passport', async (args) => {
      const action = String(args.action || 'issue').toLowerCase();
      if (!ACTIONS.includes(action)) {
        return `【agent_passport】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      }
      const root = rootOf();

      if (action === 'show') {
        const s = identitySummary(root, { create: false });
        if (s.missing) {
          return [
            '【agent_passport】本机还没有身份密钥：第一次 action=issue 时会当场生成一对 Ed25519 密钥（只在本机）。',
            `位置：${s.keyPath}`,
            `已有卡：${s.passports} 张`,
          ].join('\n');
        }
        if (!s.ok) return `【agent_passport】本机身份不可用：${s.reason}\n检查目录权限：${s.keyPath}`;
        return [
          '【agent_passport】本机身份',
          `kid：${s.kid}`,
          `公钥：${s.publicKey.slice(0, 24)}…（整串在 ${s.storePath.replace(/passports\.json$/, 'pub.txt')}）`,
          `私钥：${s.keyPath}（只在本机，不随卡发送；泄露了就把这个文件和已发的卡一起作废）`,
          `已签发：${s.passports} 张（有效 ${s.active} 张）`,
          s.created ? '刚生成本机密钥对：这是这台机器的第一次。' : '',
          '把 kid 报给对方，对方 verify 时带上 kid 就能确认"还是那台机器"。',
        ].filter(Boolean).join('\n');
      }

      if (action === 'list') {
        const store = readPassports(root);
        if (!store.cards.length) {
          return '【agent_passport】本机还没签过卡。要签一张：agent_passport action=issue name=小犀 capabilities=["team_board","pet_visit"]';
        }
        const rows = store.cards.slice().reverse().map((c, i) => {
          const exp = fmtTime(c.expiresAt);
          const caps = Array.isArray(c.capabilities) && c.capabilities.length ? c.capabilities.join('/') : '（没声明能力）';
          const rev = c.revokedAt ? `｜已吊销 ${String(c.revokedAt).slice(0, 10)}` : '';
          return `${i + 1}. ${c.name || '未命名'}（${c.agent || 'agent'}${c.host ? ` @ ${c.host}` : ''}）到期 ${exp || '长期'}｜能力 ${caps}${rev}`;
        });
        return [
          `【agent_passport】已签发 ${store.cards.length} 张（新的在前）`,
          ...rows,
          '',
          '吊销是**本地账本**打标：卡本身在别人机器上仍然验得过（离线凭证没有吊销中心），所以要真作废，得让对方把已存的卡删掉。',
        ].join('\n');
      }

      if (action === 'revoke') {
        const key = String(args.kid || args.nonce || '').trim();
        if (!key) return '【agent_passport】revoke 需要 kid 或 nonce：先 list 看一眼要吊销哪张。';
        const out = revokePassport(root, key);
        if (!out.ok) return `【agent_passport】吊销失败：${out.reason}`;
        return `【agent_passport】已在本机账本吊销 ${out.revoked} 张（${key}）。\n注意：对方机器上已存的卡仍然验证得过——离线凭证没有吊销中心。要真正作废，请让对方删掉那张卡。`;
      }

      if (action === 'verify') {
        const card = String(args.card || '').trim();
        if (!card) return '【agent_passport】verify 需要 card：把对方给的 NEXP1.xxx.yyy 整串贴进来。';
        const check = verifyPassport(card, {
          kid: String(args.kid || '').trim() || undefined,
          requiredCapabilities: parseList(args.required),
        });
        if (!check.ok) {
          return [
            `【agent_passport】没通过：${check.reason}（code=${check.code}）`,
            '没通过就当"这张卡不能作为凭证"，不要用它来放宽权限。',
          ].join('\n');
        }
        const c = check.claims;
        const caps = c.capabilities.length ? c.capabilities.join('、') : '（没声明能力）';
        return [
          '【agent_passport】通过：卡没被改过，签名与 kid 对得上',
          `持卡人：${c.name || '未命名'}（${c.agent || 'agent'}${c.host ? ` @ ${c.host}` : ''}）`,
          `kid：${check.kid}`,
          `能力：${caps}`,
          `档位：${c.tier}${c.seats ? `（${c.seats} 席）` : ''}`,
          `有效期：${fmtTime(c.iat)} → ${fmtTime(c.exp)}`,
          '注意：这只证明卡本身是真的、没被改；不证明坐在键盘前的是谁。要确认"还是那台机器"，下次带上 kid 再验一次。',
        ].join('\n');
      }

      // issue
      const name = String(args.name || '').trim();
      if (!name) return '【agent_passport】issue 需要 name：这张卡给谁（例如 小犀 / 小鹿）。';
      const lic = d.license?.currentLicense?.(root) || {};
      const caps = parseList(args.capabilities);
      const out = issuePassport(root, {
        name,
        agent: String(args.agent || 'dsh'),
        host: String(args.host || d.cfg?.host || ''),
        capabilities: caps,
        tier: String(args.tier || lic.tier || 'free'),
        seats: Number(lic.claims?.seats || lic.entitlements?.maxSeats || 0),
        ttlDays: Number(args.ttlDays || DEFAULT_TTL_DAYS),
      });
      if (!out.ok) return `【agent_passport】签发失败：${out.reason}`;
      const c = out.claims;
      return [
        `【agent_passport】已签发：${c.name}（${c.agent}）`,
        `kid：${out.kid}`,
        `能力：${c.capabilities.length ? c.capabilities.join('、') : '（没声明能力，这张卡只证明身份）'}`,
        `有效期：${fmtTime(c.iat)} → ${fmtTime(c.exp)}`,
        `账本：${out.path}`,
        '',
        '整串卡（发给对方，对方 agent_passport action=verify 就能验）：',
        out.card,
      ].join('\n');
    }),
  };
}

export default { createPassportTool };
