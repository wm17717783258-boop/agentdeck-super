/**
 * lib/policy/engine.js —— 动作策略引擎（规则判定 + 脱敏 + policy.json 落盘）
 *
 * 这个文件只做三件事，全部是"给定输入 → 返回结果"，不碰宿主的工具注册：
 *   1) decide()：拿一条策略和一次工具调用（tool/action/cost），算出 allow / confirm / deny；
 *   2) redact()：把手机号、身份证、邮箱、密钥、Bearer 之类敏感串打码；
 *   3) loadPolicy() / savePolicy()：读写 <root>/policy.json，文件坏了回落到默认值、绝不 throw。
 *
 * 为什么规则没命中时默认放行？——策略是"护栏"不是"门禁"。护栏只在用户自己写了规则、
 * 或者动作本身属于付款/删除/发消息/外部写入时才拦一下；剩下的一律放行，免得把正常工作卡死。
 * 但"放行"不等于"没看见"：deck_audit 会把这些动作记进审计流（如果宿主接了审计出口）。
 *
 * 为什么不用第三方依赖？——仓库铁律：零第三方依赖、纯 ESM、Node >= 22。
 * 所以 glob、窗口计数、脱敏全部手写，逻辑短到一眼能看完。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 策略文件名（相对 root）。 */
export const POLICY_FILE = 'policy.json';
/** 文件格式版本：以后字段变了靠它做迁移，别让老文件静默读错。 */
export const POLICY_VERSION = 1;
/** 三种判定结果，别的一律算配置错误。 */
export const EFFECTS = Object.freeze(['allow', 'confirm', 'deny']);

/* ════════════════════════════════════════════════════════════════════════
 * 一、动作分级：没写规则时，危险动作先问一句
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * 词表按"风险从高到低"排：付款 > 删除 > 发消息 > 外部写入 > 只读。
 * 用 token 而不是 substring，避免 "display" 里命中 "pay" 这种乌龙。
 */
const PAYMENT_TOKENS = new Set([
  'pay', 'payment', 'purchase', 'buy', 'order', 'checkout', 'charge', 'refund',
  'subscribe', 'subscription', 'billing', 'invoice', 'recharge', 'topup', 'top_up',
  'donate', 'tip', 'payout', 'withdraw',
]);

const DELETE_TOKENS = new Set([
  'delete', 'remove', 'rm', 'forget', 'destroy', 'drop', 'purge', 'clear',
  'uninstall', 'revoke', 'reset', 'truncate', 'wipe', 'erase',
]);

const MESSAGE_TOKENS = new Set([
  'send', 'message', 'msg', 'notify', 'notification', 'email', 'mail', 'sms',
  'dm', 'chat', 'say', 'broadcast', 'publish', 'post', 'announce', 'invite',
  'reply', 'share', 'forward', 'webhook',
]);

const EXTERNAL_WRITE_TOKENS = new Set([
  'upload', 'sync', 'push', 'deploy', 'install', 'submit', 'transfer', 'grant',
  'sign', 'issue', 'mint', 'delegate', 'activate', 'accept',
]);

const LOCAL_WRITE_TOKENS = new Set([
  'write', 'save', 'set', 'update', 'patch', 'put', 'add', 'create', 'apply',
  'edit', 'move', 'rename', 'mkdir', 'copy', 'cp', 'mv', 'append', 'upsert',
  'export', 'import', 'run', 'start', 'stop', 'resume', 'toggle',
]);

const READ_TOKENS = new Set([
  'show', 'status', 'list', 'get', 'info', 'query', 'tail', 'check', 'stats',
  'plans', 'recall', 'brief', 'detect', 'card', 'preview', 'search', 'find',
  'read', 'scan', 'verify', 'view', 'peek', 'lookup', 'describe', 'summary',
  'report', 'history', 'log', 'logs', 'events', 'count', 'measure', 'inspect',
  'whoami', 'doctor',
]);

/** 这些工具天生跨出本机/本工作区：写动作一律按"外部写入"算。 */
const EXTERNAL_TOOLS = new Set(['deck_room', 'room', 'deck_market', 'market', 'agent_passport']);

/** 把 deck_roomSend / deck-room:send 这类写法拆成小写 token。 */
function tokenize(...parts) {
  const text = parts
    .filter((x) => x !== undefined && x !== null && x !== '')
    .map(String)
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const set = new Set();
  for (const t of text.split(/[^a-z0-9]+/)) if (t) set.add(t);
  return set;
}

function firstHit(tokens, set) {
  for (const t of tokens) if (set.has(t)) return t;
  return null;
}

/**
 * 动作分级：不依赖用户规则，给出"这类动作最低限度该怎么处理"。
 * 返回 { category, effect, reason }，effect 只可能是 allow / confirm。
 * 只有规则能给出 deny —— 因为"拒绝"是最强约束，必须由用户明确写下来。
 */
export function classifyAction(tool, action) {
  const toolText = String(tool ?? '').trim();
  const actionText = String(action ?? '').trim();
  const tokens = tokenize(actionText) || new Set();
  const all = tokenize(toolText, actionText);

  const pay = firstHit(all, PAYMENT_TOKENS);
  if (pay) return { category: 'payment', effect: 'confirm', reason: `付款类操作（命中「${pay}」）：默认先要你确认` };

  const del = firstHit(tokens, DELETE_TOKENS) || firstHit(all, DELETE_TOKENS);
  if (del) return { category: 'delete', effect: 'confirm', reason: `删除/不可逆操作（命中「${del}」）：默认先要你确认` };

  const msg = firstHit(tokens, MESSAGE_TOKENS) || firstHit(all, MESSAGE_TOKENS);
  if (msg) return { category: 'message', effect: 'confirm', reason: `对外发消息（命中「${msg}」）：默认先要你确认` };

  const read = firstHit(tokens, READ_TOKENS);
  if (read) return { category: 'read', effect: 'allow', reason: `只读动作（命中「${read}」）：默认放行` };

  const ext = firstHit(tokens, EXTERNAL_WRITE_TOKENS);
  if (ext) return { category: 'external_write', effect: 'confirm', reason: `外部写入（命中「${ext}」）：默认先要你确认` };

  // 工具本身是跨机/云端/市场类：没写动作名也按外部写入处理（读动作上面已经放行）。
  if (EXTERNAL_TOOLS.has(toolText.toLowerCase())) {
    return { category: 'external_write', effect: 'confirm', reason: `工具 ${toolText} 会写外部系统：默认先要你确认` };
  }

  const local = firstHit(tokens, LOCAL_WRITE_TOKENS);
  if (local) return { category: 'local_write', effect: 'allow', reason: `本地写入（命中「${local}」）：默认放行` };

  return { category: 'unknown', effect: 'allow', reason: '没有识别出风险动作：默认放行' };
}

/* ════════════════════════════════════════════════════════════════════════
 * 二、策略归一化：用户手写的 JSON 不可信，先把结构钉死
 * ════════════════════════════════════════════════════════════════════════ */

function normalizeMatchValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    const list = value
      .map((v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim()))
      .filter(Boolean);
    return list.length ? list : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    return s ? s : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function normalizeBudget(raw) {
  const budget = {};
  if (!raw || typeof raw !== 'object') return budget;
  for (const key of ['perHour', 'perDay']) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n > 0) budget[key] = Math.floor(n);
  }
  return budget;
}

function normalizeUsage(raw) {
  const usage = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return usage;
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const hourStart = Number(entry.hourStart);
    const dayStart = typeof entry.dayStart === 'string' ? entry.dayStart : '';
    usage[String(key)] = {
      hourStart: Number.isFinite(hourStart) ? hourStart : 0,
      hour: Math.max(0, Math.floor(Number(entry.hour) || 0)),
      dayStart,
      day: Math.max(0, Math.floor(Number(entry.day) || 0)),
    };
  }
  return usage;
}

/**
 * 归一化一份策略。原则：能读多少读多少，单条规则坏了只丢那条（别因为一个笔误
 * 把用户其余规则全清了）；返回值里用 issues 说明哪儿被跳过。
 */
export function normalizePolicy(raw) {
  const issues = [];
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    issues.push('策略文件不是 JSON 对象');
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (source.rules !== undefined && !Array.isArray(source.rules)) issues.push('rules 不是数组，已忽略');
  const list = Array.isArray(source.rules) ? source.rules : [];

  const rules = [];
  const seen = new Set();
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`第 ${index + 1} 条规则不是对象，已跳过`);
      return;
    }
    const effect = String(item.effect ?? '').trim().toLowerCase();
    if (!EFFECTS.includes(effect)) {
      issues.push(`第 ${index + 1} 条规则 effect 只能是 ${EFFECTS.join('/')}，已跳过`);
      return;
    }
    const matchRaw = item.match && typeof item.match === 'object' && !Array.isArray(item.match) ? item.match : {};
    const tool = normalizeMatchValue(matchRaw.tool);
    const action = normalizeMatchValue(matchRaw.action);
    if (!tool && !action) {
      issues.push(`第 ${index + 1} 条规则没有 match.tool / match.action，已跳过（空条件会吞掉所有动作）`);
      return;
    }
    let id = String(item.id ?? '').trim() || `rule_${index + 1}`;
    if (seen.has(id)) {
      let n = 2;
      while (seen.has(`${id}#${n}`)) n += 1;
      id = `${id}#${n}`;
    }
    seen.add(id);
    const budget = normalizeBudget(item.budget);
    const rule = { id, match: {}, effect, budget };
    if (tool) rule.match.tool = tool;
    if (action) rule.match.action = action;
    const reason = String(item.reason ?? '').trim();
    if (reason) rule.reason = reason;
    rules.push(rule);
  });

  return {
    ok: issues.length === 0,
    issues,
    policy: { version: POLICY_VERSION, rules, usage: normalizeUsage(source.usage), strict: source.strict === true },
  };
}

/** 一份空策略：默认放行一切，只有动作分级会给出 confirm。 */
export function defaultPolicy() {
  return { version: POLICY_VERSION, rules: [], usage: {}, strict: false };
}

/* ════════════════════════════════════════════════════════════════════════
 * 三、规则匹配 + 预算窗口 + 判定
 * ════════════════════════════════════════════════════════════════════════ */

/** 支持 * 和 ? 的轻量 glob；规则里的 tool 写 `deck_*` 就能盖住一族工具。 */
export function matchGlob(pattern, value) {
  if (pattern === undefined || pattern === null || pattern === '' || pattern === '*') return true;
  const p = String(pattern);
  const v = String(value ?? '');
  let re = '^';
  for (const ch of p) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  try {
    return new RegExp(re, 'i').test(v);
  } catch {
    return false;
  }
}

function matchField(pattern, value) {
  if (Array.isArray(pattern)) return pattern.some((p) => matchGlob(p, value));
  return matchGlob(pattern, value);
}

/** 一条规则是否命中这次调用；tool/action 都填了就必须同时命中。 */
export function matchRule(rule, request = {}) {
  if (!rule || typeof rule !== 'object' || !rule.match) return false;
  const tool = String(request.tool ?? '');
  const action = String(request.action ?? '');
  if (rule.match.tool !== undefined && !matchField(rule.match.tool, tool)) return false;
  if (rule.match.action !== undefined && !matchField(rule.match.action, action)) return false;
  return true;
}

/** 预算窗口：按绝对小时 + UTC 日期切桶，跨窗口自动归零（不依赖常驻定时器）。 */
function budgetStateFor(rule, entry, now) {
  const hourStart = Math.floor(now / 3600000);
  const dayStart = new Date(now).toISOString().slice(0, 10);
  const hour = entry && entry.hourStart === hourStart ? entry.hour : 0;
  const day = entry && entry.dayStart === dayStart ? entry.day : 0;
  return {
    perHour: rule.budget?.perHour ?? null,
    perDay: rule.budget?.perDay ?? null,
    hour,
    day,
    hourStart,
    dayStart,
  };
}

function exceededBudget(budget, cost) {
  if (budget.perHour && budget.hour + cost > budget.perHour) {
    return `超出每小时预算（上限 ${budget.perHour} 次，已用 ${budget.hour} 次，本次 ${cost} 次）`;
  }
  if (budget.perDay && budget.day + cost > budget.perDay) {
    return `超出每日预算（上限 ${budget.perDay} 次，已用 ${budget.day} 次，本次 ${cost} 次）`;
  }
  return null;
}

function normalizeCost(cost) {
  const n = Number(cost);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.round(n));
}

/**
 * 判定一次工具调用。
 *
 * @param {object} policy 策略（可以是未归一化的原始 JSON）
 * @param {{tool?:string, action?:string, cost?:number}} request
 * @param {{now?:number, usage?:object}} [options] usage 可传入外部计数（宿主集中记账时用）
 * @returns {{effect:'allow'|'confirm'|'deny', matchedRuleId:string|null, reason:string, category:string, budget:object, usage:object|null, budgetExceeded:boolean, cost:number}}
 *
 * 优先级：第一条命中的规则说了算（first-match-wins，规则顺序就是优先级）；
 * 规则没命中时才用动作分级兜底：普通动作 allow，危险动作 confirm；deny 只能由规则给出。
 */
export function decide(policy, request = {}, options = {}) {
  const normalized = normalizePolicy(policy);
  const p = normalized.policy;
  const tool = String(request.tool ?? '').trim();
  const action = String(request.action ?? '').trim();
  const cost = normalizeCost(request.cost);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const usage = options.usage && typeof options.usage === 'object' ? options.usage : p.usage;
  const category = classifyAction(tool, action).category;

  for (const rule of p.rules) {
    if (!matchRule(rule, { tool, action })) continue;
    const budget = budgetStateFor(rule, usage[rule.id], now);
    const exceeded = exceededBudget(budget, cost);
    if (exceeded) {
      return {
        effect: 'deny',
        matchedRuleId: rule.id,
        matchedRule: rule,
        reason: `规则「${rule.id}」${exceeded}`,
        category,
        budget,
        usage: budget,
        budgetExceeded: true,
        cost,
      };
    }
    return {
      effect: rule.effect,
      matchedRuleId: rule.id,
      matchedRule: rule,
      reason: rule.reason || (rule.effect === 'deny'
        ? `命中规则「${rule.id}」：已按策略拒绝`
        : rule.effect === 'confirm'
          ? `命中规则「${rule.id}」：需要确认`
          : `命中规则「${rule.id}」：放行`),
      category,
      budget,
      usage: budget,
      budgetExceeded: false,
      cost,
    };
  }

  const classified = classifyAction(tool, action);
  return {
    effect: classified.effect,
    matchedRuleId: null,
    matchedRule: null,
    reason: classified.reason,
    category: classified.category,
    budget: {},
    usage: null,
    budgetExceeded: false,
    cost,
  };
}

/**
 * 记账：把一次调用的 cost 加到命中规则的当前小时/当天窗口。
 * 纯函数（不改入参），返回新的 policy；只有 allow/confirm 的调用才该记，
 * deny 的调用没发生，记了会把"试图越界"和"真的干了"混在一起。
 */
export function recordUsage(policy, request = {}, options = {}) {
  const normalized = normalizePolicy(policy);
  const p = normalized.policy;
  const tool = String(request.tool ?? '').trim();
  const action = String(request.action ?? '').trim();
  const cost = normalizeCost(request.cost);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();

  const rule = p.rules.find((r) => matchRule(r, { tool, action })) || null;
  const key = rule ? rule.id : '__default__';
  const hourStart = Math.floor(now / 3600000);
  const dayStart = new Date(now).toISOString().slice(0, 10);
  const prev = p.usage[key];
  const hour = prev && prev.hourStart === hourStart ? prev.hour : 0;
  const day = prev && prev.dayStart === dayStart ? prev.day : 0;
  const usage = {
    ...p.usage,
    [key]: { hourStart, hour: hour + cost, dayStart, day: day + cost },
  };
  return {
    policy: { ...p, usage },
    usage,
    matchedRuleId: rule?.id ?? null,
    cost,
  };
}

/** 预算使用情况的人话（给 deck_policy check / show 用）。 */
export function describeBudget(rule, usageEntry, now = Date.now()) {
  if (!rule || !rule.budget || (!rule.budget.perHour && !rule.budget.perDay)) return '';
  const state = budgetStateFor(rule, usageEntry, now);
  const parts = [];
  if (state.perHour) parts.push(`每小时 ${state.hour}/${state.perHour}`);
  if (state.perDay) parts.push(`每天 ${state.day}/${state.perDay}`);
  return parts.join('，');
}

/* ════════════════════════════════════════════════════════════════════════
 * 四、脱敏：宁可多打几个星号，也别把密钥写进日志/回复
 * ════════════════════════════════════════════════════════════════════════ */

/** 默认脱敏规则。每条都能单独替换，调用方也可以传自己的 patterns。 */
export const DEFAULT_REDACT_PATTERNS = Object.freeze([
  {
    name: 'phone',
    re: /\b1[3-9]\d{9}\b/g,
    replacement: (m) => `${m.slice(0, 3)}****${m.slice(-4)}`,
  },
  {
    name: 'idcard',
    re: /\b(?:\d{17}[\dXx]|\d{15})\b/g,
    replacement: (m) => `${m.slice(0, 3)}***********${m.slice(-4)}`,
  },
  {
    name: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: (m) => {
      const at = m.indexOf('@');
      return `${m.slice(0, 1)}***@${m.slice(at + 1)}`;
    },
  },
  {
    name: 'api_key',
    re: /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}\b/g,
    replacement: (m) => `${m.split('-')[0]}-***`,
  },
  {
    name: 'license_key',
    re: /\bADSK1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: () => 'ADSK1.***.***',
  },
  {
    name: 'bearer',
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
    replacement: () => 'Bearer ***',
  },
  {
    name: 'secret_assignment',
    re: /\b(token|api[_-]?key|secret|password|passwd|pwd)\b(\s*[:=]\s*)["']?[A-Za-z0-9._+/-]{8,}["']?/gi,
    replacement: (m, name, sep) => `${name}${sep}***`,
  },
  {
    name: 'url_auth',
    re: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g,
    replacement: (m, proto) => `${proto}***@`,
  },
  {
    name: 'long_hex',
    re: /\b[0-9a-f]{40,}\b/gi,
    replacement: () => '[已脱敏]',
  },
]);

/** 把用户传的 patterns（RegExp / 字符串 / {name,re,replacement}）统一成可执行列表。 */
function normalizePatterns(patterns) {
  const list = Array.isArray(patterns) ? patterns : patterns ? [patterns] : [];
  const out = [];
  for (const item of list) {
    try {
      if (item instanceof RegExp) {
        out.push({ name: item.source, re: item, replacement: '[已脱敏]' });
      } else if (typeof item === 'string') {
        out.push({ name: item, re: new RegExp(item, 'g'), replacement: '[已脱敏]' });
      } else if (item && typeof item === 'object') {
        const source = item.re instanceof RegExp ? item.re : item.pattern ? new RegExp(String(item.pattern), String(item.flags || 'g')) : null;
        if (!source) continue;
        const flags = source.flags.includes('g') ? source.flags : `${source.flags}g`;
        out.push({
          name: item.name || source.source,
          re: new RegExp(source.source, flags),
          replacement: item.replacement ?? '[已脱敏]',
        });
      }
    } catch {
      // 单条自定义规则写错（比如非法正则）只跳过它，不影响其它规则。
    }
  }
  return out;
}

/**
 * 脱敏正文，返回 { text, hits }：hits 是命中了哪些规则（不包含原文，方便审计）。
 * 任何异常都吞掉并返回能返回的部分——脱敏是保护措施，不能反过来把调用方炸掉。
 */
export function redactDetails(text, patterns = DEFAULT_REDACT_PATTERNS) {
  const input = typeof text === 'string' ? text : String(text ?? '');
  const hits = [];
  let output = input;
  for (const item of normalizePatterns(patterns)) {
    try {
      const re = new RegExp(item.re.source, item.re.flags);
      output = output.replace(re, (...args) => {
        hits.push(item.name);
        if (typeof item.replacement === 'function') return String(item.replacement(...args));
        return String(item.replacement);
      });
    } catch {
      // 同上：坏规则跳过。
    }
  }
  return { text: output, hits };
}

/** 只要脱敏结果时用这个；需要命中列表时用 redactDetails。 */
export function redact(text, patterns = DEFAULT_REDACT_PATTERNS) {
  return redactDetails(text, patterns).text;
}

/* ════════════════════════════════════════════════════════════════════════
 * 五、落盘：<root>/policy.json 的读写（坏文件不许 throw）
 * ════════════════════════════════════════════════════════════════════════ */

/** policy.json 的绝对路径；root 缺失时退回当前工作目录（宁可写错地方也别崩）。 */
export function policyFile(root) {
  return join(String(root || process.cwd()), POLICY_FILE);
}

/**
 * 读策略。任何情况下都返回一个对象，绝不 throw：
 *   - 文件不存在：ok:true, missing:true，给默认策略；
 *   - JSON 坏了：ok:false, code:'corrupt', recovered:true，给默认策略；
 *   - 结构有毛病但还能救：ok:false, code:'corrupt', recovered:true，保留能读的规则；
 *   - 读写 IO 错：ok:false, code:'io', recovered:true，给默认策略。
 * 为什么 recovered 都是 true？——调用方（工具/宿主）永远拿到一份能用的策略，不中断工作。
 */
export function loadPolicy(root) {
  const file = policyFile(root);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, file, missing: true, recovered: false, policy: defaultPolicy(), issues: [] };
    }
    return {
      ok: false,
      file,
      missing: false,
      code: 'io',
      recovered: true,
      policy: defaultPolicy(),
      error: String(err && err.message ? err.message : err),
      issues: [`策略文件读不出来（${err && err.code ? err.code : '未知错误'}），已按默认策略继续`],
    };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      file,
      missing: false,
      code: 'corrupt',
      recovered: true,
      policy: defaultPolicy(),
      error: String(err && err.message ? err.message : err),
      issues: ['策略文件不是合法 JSON，已回落到默认策略（原文件没动，方便你手工修）'],
    };
  }

  const normalized = normalizePolicy(raw);
  if (!normalized.ok) {
    return {
      ok: false,
      file,
      missing: false,
      code: 'corrupt',
      recovered: true,
      policy: normalized.policy,
      issues: normalized.issues,
    };
  }
  return { ok: true, file, missing: false, recovered: false, policy: normalized.policy, issues: [] };
}

/**
 * 写策略：先归一化，再写临时文件 + rename（避免断电/被杀进程留下半截 JSON）。
 * 失败返回 { ok:false, code, error }，不 throw。
 */
export function savePolicy(root, policy) {
  const file = policyFile(root);
  const normalized = normalizePolicy(policy);
  if (!normalized.ok) {
    return {
      ok: false,
      code: 'invalid',
      file,
      error: normalized.issues.join('；'),
      issues: normalized.issues,
    };
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(String(root || process.cwd()), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(normalized.policy, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
    return { ok: true, file, policy: normalized.policy, issues: [] };
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能根本没建成；清理失败不需要再报错。
    }
    return {
      ok: false,
      code: 'io',
      file,
      error: String(err && err.message ? err.message : err),
      issues: ['策略写盘失败，本次修改没有生效'],
    };
  }
}

/** 恢复到默认策略（空规则 + 空计数），主要给 deck_policy reset 用。 */
export function resetPolicy(root) {
  return savePolicy(root, defaultPolicy());
}

export default {
  POLICY_FILE,
  POLICY_VERSION,
  EFFECTS,
  DEFAULT_REDACT_PATTERNS,
  classifyAction,
  decide,
  defaultPolicy,
  describeBudget,
  loadPolicy,
  matchGlob,
  matchRule,
  normalizePolicy,
  policyFile,
  recordUsage,
  redact,
  redactDetails,
  resetPolicy,
  savePolicy,
};
