/**
 * lib/twin/mandate.js —— 分身执照 v1（主人授权数字分身"能自己干什么"）
 *
 * 解决什么：桌宠要"24 小时替主人干活"，就必须回答一个绕不开的问题——
 *   它凭什么敢自己动手？动手之前谁批准了？越界了怎么办？
 * 现有 deck_policy 管的是"这次工具调用允不允许"，管不了"这个分身有没有资格自作主张"。
 * 执照补的就是这一层：一张**由主人自己签发给自己的分身**的离线 Ed25519 授权状。
 *
 * 格式：`NEXM1.<b64url(payload)>.<b64url(sig)>`
 *   - 复用 lib/identity.js 的同一套密钥基础（ensureIdentity / kidOfPublicKey）
 *   - 公钥随执照走，任何机器离线可验，不需要共享密钥目录、不需要联网
 *   - 默认执照是**最小权限**：只读工具 + 只写任务板；要扩大必须主人显式签发
 *
 * 诚实边界（必须写进对外文案）：
 *   - 验签通过 = 执照没被改过、签发方没换过、在有效期内。**不等于**"这个分身值得信任"。
 *   - 没有 CA、没有在线吊销中心：revoke 只标本地账本，执照在别的机器上照样验得过。
 *   - 所以对外只说"授权范围可验证、可审计、可吊销（本地）"，不说"安全的自主 Agent"。
 *
 * 为什么是"主人签给分身"而不是"平台签给用户"：
 *   平台签的执照等于平台替用户做主；主人签的执照才是**用户控制自己分身**的正确形态，
 *   也符合开源版的定位——离线、可自持、不经服务端。
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureIdentity, identityPaths, kidOfPublicKey } from '../identity.js';

export const MANDATE_PREFIX = 'NEXM1';
export const MANDATE_VERSION = 1;
export const DEFAULT_TTL_DAYS = 30;
/** 影子默认天数：执照本身默认 30 天，避免"发一次永久有效"。 */
const MAX_TOOLS = 64;
const MAX_WINDOWS = 8;

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64uDecode(str) {
  return Buffer.from(String(str), 'base64url');
}

/**
 * 默认执照：最小权限。
 * 只给只读工具 + 任务板写；不碰 shell、不发消息、不花钱、不越出工作区。
 * 这是"新装用户第一次生成执照"时该拿到的东西，也是所有降级路径的终点。
 */
export function defaultMandate() {
  return {
    scope: {
      tools: ['fs_read', 'fs_glob', 'fs_grep', 'web_fetch'],
      actions: ['board_add', 'board_done', 'twin_remember', 'twin_recall'],
      deny: ['shell', 'http_request', 'fs_write', 'fs_patch'],
    },
    budget: { perDay: 50, maxRuntimeMin: 30 },
    time: { windows: ['09:00-22:00'], tz: 'Asia/Shanghai' },
    peerScope: { maySendTo: ['room', 'friend'], never: ['public'] },
    escalate: {
      when: ['write_outside_workspace', 'spend_over_budget', 'new_peer'],
      to: ['desktop'],
    },
  };
}

/** 执照目录：跟着人走（和身份同一个根），不放工作区。 */
export function mandateDir(root) {
  const idp = identityPaths(root);
  return join(idp.dir, 'mandates');
}

export function mandatePaths(root) {
  const dir = mandateDir(root);
  return { dir, active: join(dir, 'active.json'), ledger: join(dir, 'ledger.json') };
}

function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    if (mode) chmodSync(tmp, mode);
  } catch {
    // Windows 上 chmod 基本是空操作；失败不影响功能。
  }
  renameSync(tmp, file);
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function uniqStrings(list, { max = 64, maxLen = 80 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (!s) continue;
    if (s.length > maxLen) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** "HH:MM" → 分钟数；非法返回 null。 */
function parseClock(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 支持的窗口写法：'09:00-22:00'（同日）与 '22:00-06:00'（跨夜）。非法项直接丢弃。 */
function normalizeWindows(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_WINDOWS) break;
    const m = /^([0-2]?\d:[0-5]\d)\s*-\s*([0-2]?\d:[0-5]\d)$/.exec(String(item || '').trim());
    if (!m) continue;
    const start = parseClock(m[1]);
    const end = parseClock(m[2]);
    if (start === null || end === null) continue;
    out.push(`${m[1]}-${m[2]}`);
  }
  return out;
}

/** 把外部输入钉成固定形状（字段固定、顺序固定），保证签名可复现。 */
export function normalizeMandate(input = {}) {
  const base = defaultMandate();
  const nowSec = Math.floor(Number(input.iat) || Date.now() / 1000);
  const ttlDays = Math.max(1, Math.min(365, Math.floor(Number(input.ttlDays) || DEFAULT_TTL_DAYS)));
  const expIn = Math.floor(Number(input.exp) || 0);

  const scopeIn = input.scope && typeof input.scope === 'object' ? input.scope : {};
  const budgetIn = input.budget && typeof input.budget === 'object' ? input.budget : {};
  const timeIn = input.time && typeof input.time === 'object' ? input.time : {};
  const peerIn = input.peerScope && typeof input.peerScope === 'object' ? input.peerScope : {};
  const escIn = input.escalate && typeof input.escalate === 'object' ? input.escalate : {};

  const perDay = Math.max(0, Math.floor(Number(budgetIn.perDay)));
  const maxRuntimeMin = Math.max(0, Math.floor(Number(budgetIn.maxRuntimeMin)));
  const perDayOut = Number.isFinite(perDay) && budgetIn.perDay !== undefined ? perDay : base.budget.perDay;
  const runtimeOut = Number.isFinite(maxRuntimeMin) && budgetIn.maxRuntimeMin !== undefined
    ? maxRuntimeMin
    : base.budget.maxRuntimeMin;

  return {
    v: MANDATE_VERSION,
    id: str(input.id, `mand_${Math.random().toString(16).slice(2, 10)}`),
    subject: str(input.subject),
    issuedBy: str(input.issuedBy),
    scope: {
      tools: Array.isArray(scopeIn.tools) ? uniqStrings(scopeIn.tools, { max: MAX_TOOLS }) : [...base.scope.tools],
      actions: Array.isArray(scopeIn.actions) ? uniqStrings(scopeIn.actions, { max: MAX_TOOLS }) : [...base.scope.actions],
      deny: Array.isArray(scopeIn.deny) ? uniqStrings(scopeIn.deny, { max: MAX_TOOLS }) : [...base.scope.deny],
    },
    budget: { perDay: perDayOut, maxRuntimeMin: runtimeOut },
    time: {
      windows: normalizeWindows(timeIn.windows !== undefined ? timeIn.windows : input.windows),
      tz: str(timeIn.tz, base.time.tz),
    },
    peerScope: {
      maySendTo: Array.isArray(peerIn.maySendTo) ? uniqStrings(peerIn.maySendTo, { max: 16 }) : [...base.peerScope.maySendTo],
      never: Array.isArray(peerIn.never) ? uniqStrings(peerIn.never, { max: 16 }) : [...base.peerScope.never],
      acceptInvitesFrom: Array.isArray(peerIn.acceptInvitesFrom) ? uniqStrings(peerIn.acceptInvitesFrom, { max: 64 }) : [],
    },
    escalate: {
      when: Array.isArray(escIn.when) ? uniqStrings(escIn.when, { max: 16 }) : [...base.escalate.when],
      to: Array.isArray(escIn.to) ? uniqStrings(escIn.to, { max: 8 }) : [...base.escalate.to],
    },
    iat: nowSec,
    exp: expIn > 0 ? expIn : nowSec + ttlDays * 86400,
    nonce: str(input.nonce, `mnd_${Math.random().toString(36).slice(2, 10)}`),
    pub: str(input.pub),
  };
}

/** 签名用的规范串：字段顺序写死，任何一端改顺序都会验签失败（故意的）。 */
function canonicalMandate(m) {
  return JSON.stringify([
    m.v,
    m.id,
    m.subject,
    m.issuedBy,
    m.scope.tools,
    m.scope.actions,
    m.scope.deny,
    m.budget.perDay,
    m.budget.maxRuntimeMin,
    m.time.windows,
    m.time.tz,
    m.peerScope.maySendTo,
    m.peerScope.never,
    m.peerScope.acceptInvitesFrom,
    m.escalate.when,
    m.escalate.to,
    m.iat,
    m.exp,
    m.nonce,
    m.pub,
  ]);
}

/** 签发一张执照（用本机私钥）。返回 `NEXM1.<payload>.<sig>`。 */
export function encodeMandate(claims, privateKeyPem) {
  const m = normalizeMandate(claims);
  const sig = cryptoSign(null, Buffer.from(canonicalMandate(m)), privateKeyPem);
  return `${MANDATE_PREFIX}.${b64uEncode(JSON.stringify(m))}.${b64uEncode(sig)}`;
}

/**
 * 校验一张执照。**永不 throw**。
 * @param {string} mandate `NEXM1.xxx.yyy`
 * @param {{ now?:number, skewSec?:number, kid?:string, requireSubject?:string }} [opts]
 * @returns {{ ok:boolean, claims?:object, kid?:string, reason?:string, code?:string }}
 */
export function verifyMandate(mandate, opts = {}) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  try {
    if (typeof mandate !== 'string' || !mandate.trim()) return fail('empty', '没有执照内容');
    const raw = mandate.trim().replace(/\s+/g, '');
    const parts = raw.split('.');
    if (parts.length !== 3) return fail('format', `执照格式不对（应为 ${MANDATE_PREFIX}.payload.sig）`);
    if (parts[0] !== MANDATE_PREFIX) return fail('format', `执照前缀不是 ${MANDATE_PREFIX}`);

    let claims;
    try {
      claims = JSON.parse(b64uDecode(parts[1]).toString('utf8'));
    } catch {
      return fail('payload', '执照内容读不出来（不是合法 JSON 或 base64 被截断）');
    }
    if (!claims || typeof claims !== 'object') return fail('payload', '执照内容不是对象');
    if (Number(claims.v) !== MANDATE_VERSION) return fail('version', `不认识的执照版本 ${claims.v}`);
    if (!claims.pub) return fail('payload', '执照里没有公钥（pub），无法验签');

    let pub;
    try {
      pub = createPublicKey({ key: b64uDecode(claims.pub), format: 'der', type: 'spki' });
    } catch {
      return fail('payload', '执照里的公钥解析失败');
    }

    const expectKid = kidOfPublicKey(b64uDecode(claims.pub));
    if (opts.kid && String(opts.kid) !== expectKid) {
      return fail('kid_mismatch', `这张执照不是 ${opts.kid} 签发的（实际 ${expectKid}）`);
    }

    const sigOk = cryptoVerify(
      null,
      Buffer.from(canonicalMandate(normalizeMandate(claims))),
      pub,
      b64uDecode(parts[2]),
    );
    if (!sigOk) return fail('bad_signature', '签名对不上：执照被改过，或者不是这台机器签的');

    const nowMs = Number(opts.now) || Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const skew = Math.max(0, Number(opts.skewSec) || 0);
    if (Number(claims.exp) && nowSec > Number(claims.exp) + skew) {
      return fail('expired', `执照已过期（到期 ${new Date(Number(claims.exp) * 1000).toISOString().slice(0, 10)}）`);
    }

    if (opts.requireSubject) {
      const want = String(opts.requireSubject);
      if (String(claims.subject || '') !== want) {
        return fail('subject_mismatch', `这张执照不是发给 ${want} 的（实际 ${claims.subject || '未指定'}）`);
      }
    }

    return { ok: true, claims: normalizeMandate(claims), kid: expectKid };
  } catch (err) {
    return fail('internal', `${err?.name || 'Error'}: ${err?.message || err}`);
  }
}

// ── 自主裁决：把"分身想自己干一件事"翻译成 allow / confirm / deny ──────────

/**
 * 判断某个动作（tool + action）在执照范围内是什么待遇。
 *
 * 判定顺序（重要，别改）：
 *   1. deny 命中 → deny（用户明确禁止 > 一切）
 *   2. 时间窗口外 → deny（到点了就歇着）
 *   3. 预算超了 → confirm（想接着干，问主人）
 *   4. 工具不在白名单 → confirm（默认不来硬的：进审批队列而不是直接拒）
 *   5. 通过 → allow
 *
 * 为什么"不在白名单"是 confirm 而不是 deny：
 *   分身碰到没见过的事，正确行为是回去问主人，而不是当成错误丢掉这个机会。
 *   deny 只保留给"用户明确写进 deny 的东西"。
 *
 * @param {object} claims verifyMandate 出来的 claims（或 normalizeMandate 结果）
 * @param {{ tool?:string, action?:string, cost?:number }} request
 * @param {{ now?:number, dayUsage?:number }} [options]
 * @returns {{ effect:'allow'|'confirm'|'deny', reason:string, scopeHit:string|null }}
 */
export function judgeAutonomy(claims, request = {}, options = {}) {
  const m = normalizeMandate(claims);
  const tool = String(request.tool ?? '').trim().toLowerCase();
  const action = String(request.action ?? '').trim().toLowerCase();
  const cost = Math.max(1, Math.round(Number(request.cost) || 1));
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();

  const inList = (list, value) => Array.isArray(list) && list.some((p) => {
    const pat = String(p).toLowerCase();
    if (!pat) return false;
    if (pat === value) return true;
    // 支持 `deck_*` / `fs_*` 这种族匹配
    const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(value);
  });

  // 1) deny 优先
  const deniedBy = [tool, action].find((v) => v && inList(m.scope.deny, v));
  if (deniedBy) {
    return { effect: 'deny', reason: `主人明确禁止「${deniedBy}」：分身不许自主执行`, scopeHit: deniedBy };
  }

  // 2) 时间窗口
  const win = insideWindows(m.time.windows, now, m.time.tz);
  if (win.configured && !win.inside) {
    return {
      effect: 'deny',
      reason: `不在允许的时间窗内（${m.time.windows.join('、')} ${m.time.tz}）：分身现在不自主行动`,
      scopeHit: 'time',
    };
  }

  // 3) 预算
  const used = Math.max(0, Math.floor(Number(options.dayUsage) || 0));
  if (m.budget.perDay > 0 && used + cost > m.budget.perDay) {
    return {
      effect: 'confirm',
      reason: `超出每日预算（上限 ${m.budget.perDay} 次，已用 ${used} 次，本次 ${cost} 次）：要主人点头`,
      scopeHit: 'budget',
    };
  }

  // 4) 白名单
  const toolOk = tool && inList(m.scope.tools, tool);
  const actionOk = action && inList(m.scope.actions, action);
  if (!toolOk && !actionOk) {
    return {
      effect: 'confirm',
      reason: `「${tool || action || '这个动作'}」不在执照白名单里：先问主人`,
      scopeHit: null,
    };
  }

  return { effect: 'allow', reason: `在执照范围内（${toolOk ? `工具 ${tool}` : `动作 ${action}`}）`, scopeHit: toolOk ? tool : action };
}

/** 判断 now 是否落在 windows 里。windows 为空 = 不限制（configured:false）。 */
export function insideWindows(windows, now = Date.now(), tz = 'Asia/Shanghai') {
  const list = Array.isArray(windows) ? windows : [];
  if (!list.length) return { configured: false, inside: true, minute: 0 };
  const minute = localMinuteOf(now, tz);
  for (const item of list) {
    const m = /^([0-2]?\d:[0-5]\d)-([0-2]?\d:[0-5]\d)$/.exec(String(item));
    if (!m) continue;
    const start = parseClock(m[1]);
    const end = parseClock(m[2]);
    if (start === null || end === null) continue;
    if (start <= end) {
      if (minute >= start && minute < end) return { configured: true, inside: true, minute };
    } else if (minute >= start || minute < end) {
      // 跨夜窗口（22:00-06:00）
      return { configured: true, inside: true, minute };
    }
  }
  return { configured: true, inside: false, minute };
}

/** 取某个时区的"当天第几分钟"。用 Intl 拿偏移，避免自己实现时区表。 */
export function localMinuteOf(ms, tz) {
  try {
    const d = new Date(Number(ms));
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const text = fmt.format(d);
    const [hh, mm] = text.split(':').map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) return hh * 60 + mm;
  } catch {
    // 时区名字不认识就退回本机时间，不因为时区配置把人卡死。
  }
  const d = new Date(Number(ms));
  return d.getHours() * 60 + d.getMinutes();
}

// ── 落盘：active.json（当前生效的执照）+ ledger.json（账本）─────────────

export function readMandateLedger(root) {
  const p = mandatePaths(root);
  try {
    if (!existsSync(p.ledger)) return { v: 1, items: [] };
    const json = JSON.parse(readFileSync(p.ledger, 'utf8'));
    return { v: 1, items: Array.isArray(json?.items) ? json.items : [] };
  } catch {
    return { v: 1, items: [] };
  }
}

function writeLedger(root, data) {
  const p = mandatePaths(root);
  mkdirSync(p.dir, { recursive: true });
  writeAtomic(p.ledger, `${JSON.stringify({ v: 1, items: data.items || [] }, null, 2)}\n`, 0o600);
  return p.ledger;
}

/** 读当前生效的执照（没有就返回 null，不自动生成——生成必须由主人显式动作触发）。 */
export function readActiveMandate(root) {
  const p = mandatePaths(root);
  try {
    if (!existsSync(p.active)) return { ok: true, missing: true, mandate: null, file: p.active };
    const json = JSON.parse(readFileSync(p.active, 'utf8'));
    const mandate = str(json?.mandate);
    if (!mandate) return { ok: true, missing: true, mandate: null, file: p.active };
    const verified = verifyMandate(mandate);
    return { ok: verified.ok, missing: false, mandate, claims: verified.claims, code: verified.code, reason: verified.reason, file: p.active };
  } catch (err) {
    return { ok: false, missing: false, mandate: null, code: 'io', reason: String(err?.message || err), file: p.active };
  }
}

/**
 * 签发并激活一张执照。**永不 throw**。
 * @param {string} root 机级根
 * @param {object} input 见 normalizeMandate；不给 scope 就用最小权限默认值
 */
export function issueMandate(root, input = {}) {
  const id = ensureIdentity(root);
  if (!id.ok) return { ok: false, reason: `本机身份不可用：${id.reason}` };
  try {
    const claims = normalizeMandate({
      ...input,
      issuedBy: input.issuedBy || id.kid,
      subject: input.subject || id.kid,
      pub: id.publicKeyB64Url,
      iat: Math.floor(Date.now() / 1000),
    });
    const mandate = encodeMandate(claims, id.privateKeyPem);
    const verified = verifyMandate(mandate);
    if (!verified.ok) return { ok: false, reason: `自检失败（签出来的执照自己验不过）：${verified.reason}` };

    const p = mandatePaths(root);
    mkdirSync(p.dir, { recursive: true });
    writeAtomic(p.active, `${JSON.stringify({ v: 1, mandate, updatedAt: new Date().toISOString() }, null, 2)}\n`, 0o600);

    const ledger = readMandateLedger(root);
    ledger.items = ledger.items.filter((x) => x?.id !== claims.id);
    ledger.items.push({
      id: claims.id,
      kid: verified.kid,
      issuedBy: claims.issuedBy,
      subject: claims.subject,
      tools: claims.scope.tools,
      actions: claims.scope.actions,
      perDay: claims.budget.perDay,
      windows: claims.time.windows,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      revokedAt: null,
    });
    if (ledger.items.length > 100) ledger.items = ledger.items.slice(-100);
    writeLedger(root, ledger);

    return { ok: true, mandate, claims, kid: verified.kid, file: p.active };
  } catch (err) {
    return { ok: false, reason: `${err?.name || 'Error'}: ${err?.message || err}` };
  }
}

/** 吊销：本地账本打标 + 删掉 active（离线凭证没有吊销中心，别的机器照样验得过，这点必须说清）。 */
export function revokeMandate(root, idOrNonce) {
  const key = str(idOrNonce);
  if (!key) return { ok: false, reason: '要吊销哪张？给执照 id' };
  const p = mandatePaths(root);
  const ledger = readMandateLedger(root);
  let hit = 0;
  const now = new Date().toISOString();
  for (const item of ledger.items) {
    if ((item.id === key || item.nonce === key) && !item.revokedAt) {
      item.revokedAt = now;
      hit += 1;
    }
  }
  if (!hit) return { ok: false, reason: `本地账本里没有 ${key} 这张执照` };
  writeLedger(root, ledger);
  try {
    const active = readActiveMandate(root);
    if (active.ok && active.claims && active.claims.id === key) writeFileSync(p.active, `${JSON.stringify({ v: 1, mandate: null }, null, 2)}\n`, 'utf8');
  } catch {
    // 清 active 失败不影响账本吊销结果。
  }
  return { ok: true, revoked: hit, file: p.ledger };
}

/** 执照摘要（给 /deck 与工具用，不含私钥）。 */
export function mandateSummary(root, opts = {}) {
  const ledger = readMandateLedger(root);
  const active = readActiveMandate(root);
  const nowMs = Number(opts.now) || Date.now();
  const activeClaims = active.ok && active.claims ? active.claims : null;
  const judge = activeClaims ? insideWindows(activeClaims.time.windows, nowMs, activeClaims.time.tz) : null;
  return {
    ok: Boolean(active.ok),
    hasActive: Boolean(activeClaims),
    id: activeClaims?.id || '',
    subject: activeClaims?.subject || '',
    tools: activeClaims?.scope.tools || [],
    actions: activeClaims?.scope.actions || [],
    deny: activeClaims?.scope.deny || [],
    perDay: activeClaims?.budget?.perDay ?? null,
    windows: activeClaims?.time?.windows || [],
    expiresAt: activeClaims?.exp || 0,
    insideWindow: judge ? judge.inside : true,
    windowConfigured: judge ? judge.configured : false,
    issued: ledger.items.length,
    revoked: ledger.items.filter((x) => x.revokedAt).length,
    reason: active.reason || '',
    code: active.code || '',
    file: active.file,
  };
}

export default {
  MANDATE_PREFIX,
  DEFAULT_TTL_DAYS,
  defaultMandate,
  normalizeMandate,
  encodeMandate,
  verifyMandate,
  judgeAutonomy,
  insideWindows,
  localMinuteOf,
  mandateDir,
  mandatePaths,
  readMandateLedger,
  readActiveMandate,
  issueMandate,
  revokeMandate,
  mandateSummary,
};