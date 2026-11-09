/**
 * lib/pet/skins.js —— 桌宠皮肤：三个免费皮肤 + 付费皮肤与授权判定
 *
 * 商业模型（见 docs/PRO.md）：**本机不设开关**——不是「付费就打开某个 flag」，
 * 而是「付费皮肤本身就在包里，授权到位才允许激活」。所以这里的职责很窄：
 *   1. 列出可用皮肤（包内内置 + 包内付费 + 用户自己放进工作区的）；
 *   2. 判定某个皮肤当前能不能用（授权来自 lib/license.js 的 currentLicense()）；
 *   3. 激活皮肤（写进分身档案），授权不到位就明确拒绝，绝不静默退回免费皮肤；
 *   4. 把皮肤渲染成 SVG 字符串（桌宠视图只需要一段 SVG，不需要图片依赖）。
 *
 * 约定：
 *   - 纯 ESM、零依赖、无构建；
 *   - 除 renderSprite（契约要求它返回 SVG 字符串）外，所有函数返回 { ok, ... }，永不 throw；
 *   - 皮肤文件是**不可信资源**：skin.json 只当数据读，绝不 eval、绝不拼路径；
 *   - 免费皮肤任何时候都能用，哪怕授权码是坏的、过期的、压根没有。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包内皮肤素材根目录（assets/skins，本文件在 lib/pet/ 下） */
const ASSETS_SKINS_DIR = fileURLToPath(new URL('../../assets/skins/', import.meta.url));

/** 五种状态：发呆 / 干活 / 开会 / 串门 / 睡觉 */
export const SKIN_STATES = Object.freeze(['idle', 'working', 'meeting', 'visiting', 'sleeping']);

/** 状态 → 中文标签（会渲染到皮肤上） */
export const STATE_LABELS = Object.freeze({
  idle: '发呆中',
  working: '搬砖中',
  meeting: '开会中',
  visiting: '串门中',
  sleeping: '睡着了',
});

/**
 * 内置免费皮肤。字符串顺序就是商店里的展示顺序。
 * file 相对皮肤自己的目录，见 assets/skins/<dir>/<file>。
 */
export const BUILTIN_SKINS = Object.freeze([
  Object.freeze({
    id: 'basic',
    name: '原味',
    price: 0,
    file: 'basic.svg',
    dir: 'basic',
    premium: false,
    builtin: true,
    accent: '#b26a2f',
    description: '奶油色小兽，最耐用的一套，默认就用它',
  }),
  Object.freeze({
    id: 'nio',
    name: '霓虹',
    price: 0,
    file: 'nio.svg',
    dir: 'nio',
    premium: false,
    builtin: true,
    accent: '#4ff0ff',
    description: '赛博小机甲，夜里干活更好看',
  }),
  Object.freeze({
    id: 'ink',
    name: '水墨',
    price: 0,
    file: 'ink.svg',
    dir: 'ink',
    premium: false,
    builtin: true,
    accent: '#9a3b2a',
    description: '宣纸上的墨点小兽，安静的一套',
  }),
]);

/** 哪些档位自带「付费皮肤全解锁」（与 lib/license.js 的 TIERS 对齐，这里只做兜底判断） */
const TIER_PREMIUM_SKINS = Object.freeze({ free: false, pro: false, studio: true });

/** 渲染尺寸兜底（太小看不清、太大没意义） */
const MIN_SIZE = 24;
const MAX_SIZE = 512;
const DEFAULT_SIZE = 96;
/** 单个皮肤模板文件大小上限，防止有人塞个超大文件进来 */
const MAX_TEMPLATE_BYTES = 256 * 1024;

/** 包内皮肤素材目录 */
export function assetsSkinsDir() {
  return ASSETS_SKINS_DIR;
}

/** 用户放进工作区的第三方皮肤目录：<root>/.agentdeck/pet/skins */
export function localSkinsDir(root) {
  const base = typeof root === 'string' && root.trim() ? root.trim() : '';
  return base ? path.join(base, '.agentdeck', 'pet', 'skins') : null;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 皮肤 id 只允许保守字符集，防止 ../ 之类的东西混进来 */
function safeId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id) && !id.includes('..') ? id : '';
}

/** 皮肤素材只允许是当前目录下的普通文件名 */
function safeFileName(value) {
  const name = str(value);
  if (!name || name.includes('..') || /[\\/:*?"<>|]/.test(name)) return '';
  return name;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 包内素材路径可以被缓存（发布后不变）；第三方皮肤每次都重新读 */
const templateCache = new Map();

function readTemplate(file, { cache = true } = {}) {
  if (cache && templateCache.has(file)) return templateCache.get(file);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('不是普通文件');
  if (stat.size > MAX_TEMPLATE_BYTES) throw new Error(`模板太大（${Math.round(stat.size / 1024)}KB）`);
  const text = fs.readFileSync(file, 'utf8');
  if (cache) templateCache.set(file, text);
  return text;
}

// ---------------------------------------------------------------------------
// listSkins：包内 + 工作区里的皮肤
// ---------------------------------------------------------------------------

/** 读一个皮肤目录里的 skin.json（不可信数据，读坏了就返回 null + 原因） */
function readManifest(dir) {
  const file = path.join(dir, 'skin.json');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, reason: 'skin.json 不是普通文件' };
    if (stat.size > 64 * 1024) return { ok: false, reason: 'skin.json 过大' };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'skin.json 必须是一个对象' };
    return { ok: true, manifest: raw };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: '没有 skin.json' };
    return { ok: false, reason: `skin.json 读不了：${err && err.message ? err.message : err}` };
  }
}

/** 扫一个目录下的皮肤子目录（结构：<dir>/<skin-id>/skin.json） */
function scanSkinDir(baseDir, warnings, source) {
  if (!baseDir) return [];
  let names;
  try {
    names = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在是正常情况
  }
  const out = [];
  for (const dirent of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(baseDir, dirent.name);
    const read = readManifest(dir);
    if (!read.ok) {
      if (read.reason !== '没有 skin.json') warnings.push(`跳过 ${dirent.name}：${read.reason}`);
      continue;
    }
    const m = read.manifest;
    const id = safeId(m.id) || safeId(dirent.name);
    if (!id) {
      warnings.push(`跳过 ${dirent.name}：皮肤 id 不合法`);
      continue;
    }
    const file = safeFileName(m.sprite || m.file);
    if (!file) {
      warnings.push(`跳过 ${dirent.name}：skin.json 里的 sprite 文件名不合法`);
      continue;
    }
    const spritePath = path.join(dir, file);
    if (!fs.existsSync(spritePath)) {
      warnings.push(`跳过 ${dirent.name}：素材文件不存在（${file}）`);
      continue;
    }
    const price = Math.max(0, Math.round(num(m.price)));
    const premium = price > 0 || m.license === 'premium' || m.license === 'paid';
    out.push({
      id,
      name: str(m.name, dirent.name),
      price,
      file,
      dir: dirent.name,
      premium,
      builtin: false,
      accent: str(m.accent, '#7ef3ff'),
      description: str(m.description, ''),
      author: str(m.author, ''),
      version: str(m.version, ''),
      source,
      spritePath,
    });
  }
  return out;
}

/**
 * 按 id 找一套「不在 BUILTIN_SKINS 里」的皮肤：先包内付费，再工作区第三方。
 * listSkins 走的就是这个顺序；renderSprite 可能被单独调用（先列目录、再逐张渲染），
 * 所以同一顺序要能复用，否则付费皮肤会被画成占位图。
 */
function findInstalledSkin(id, root) {
  if (!id) return null;
  const warnings = [];
  for (const skin of scanSkinDir(ASSETS_SKINS_DIR, warnings, 'package')) {
    if (skin.id === id) return skin;
  }
  const local = localSkinsDir(typeof root === 'string' && root.trim() ? root.trim() : null);
  if (local) {
    for (const skin of scanSkinDir(local, warnings, 'local')) {
      if (skin.id === id) return skin;
    }
  }
  return null;
}

/**
 * 列出所有皮肤：内置免费（固定 3 套）→ 包内付费 → 工作区里的第三方皮肤。
 * 同 id 只保留第一个出现的那套（内置优先），并记一条 warning。
 *
 * @param {{ root?:string, license?:object }} [opts]
 * @returns {{ ok:true, skins:object[], warnings:string[], dirs:{assets:string, local:string|null}, root:string|null }}
 */
export function listSkins({ root, license } = {}) {
  const warnings = [];
  const skins = [];
  const seen = new Set();
  const base = typeof root === 'string' && root.trim() ? root.trim() : null;

  const add = (skin) => {
    if (seen.has(skin.id)) {
      warnings.push(`皮肤 id 重复，已忽略后出现的那套：${skin.id}`);
      return;
    }
    seen.add(skin.id);
    skins.push(skin);
  };

  // 1) 内置免费皮肤：文件缺失也照样列出来（渲染时给占位图），并记 warning
  for (const skin of BUILTIN_SKINS) {
    const spritePath = path.join(ASSETS_SKINS_DIR, skin.dir, skin.file);
    let exists = false;
    try {
      exists = fs.statSync(spritePath).isFile();
    } catch {
      exists = false;
    }
    if (!exists) warnings.push(`内置皮肤 ${skin.id} 的素材丢了：${path.relative(process.cwd(), spritePath)}`);
    add({ ...skin, source: 'builtin', spritePath, exists });
  }

  // 2) 包内带的付费皮肤（示例：极光）
  for (const skin of scanSkinDir(ASSETS_SKINS_DIR, warnings, 'package')) {
    add({ ...skin, premium: skin.premium || skin.price > 0 });
  }

  // 3) 工作区里的第三方皮肤
  const local = localSkinsDir(base);
  for (const skin of scanSkinDir(local, warnings, 'local')) {
    add(skin);
  }

  const result = { ok: true, skins, warnings, dirs: { assets: ASSETS_SKINS_DIR, local }, root: base };
  if (license !== undefined) {
    result.skins = skins.map((skin) => {
      const verdict = checkSkinLicense({ skin, license, root: base, now: undefined });
      return { ...skin, allowed: verdict.allowed, locked: !verdict.allowed };
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// checkSkinLicense：能不能用这套皮肤
// ---------------------------------------------------------------------------

/**
 * 把各种授权形态揉成一张可判断的脸。
 * 认两种输入（Lead 定的契约）：
 *   (a) lib/license.js 的 currentLicense(root) 返回：{ ok, tier, claims?, entitlements?, reason? }
 *   (b) 裸 claims：{ tier, skins?, exp? }
 * 传授权码字符串是**不认**的——凭证串只由 lib/license.js 校验，这里不解析。
 */
function normalizeLicense(license) {
  const none = { present: false, tier: 'free', claims: null, premiumSkins: false, reason: '还没有授权' };
  if (license === undefined || license === null) return none;
  if (typeof license === 'string') {
    return { ...none, present: true, reason: '这里只认 currentLicense() 的结果，不直接解析授权码' };
  }
  if (typeof license !== 'object' || Array.isArray(license)) {
    return { ...none, present: true, reason: '授权信息形状不对' };
  }

  const nested = license.claims;
  const claims = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : license.tier || license.skins || license.exp
      ? license
      : null;
  if (!claims) {
    return {
      present: true,
      tier: 'free',
      claims: null,
      premiumSkins: false,
      reason: str(license.reason, '授权信息里没有 claims'),
    };
  }

  const verified = typeof license.ok === 'boolean' ? license.ok : true;
  const tier = String(claims.tier || license.tier || 'free').toLowerCase();
  const entitlements = license.entitlements && typeof license.entitlements === 'object' ? license.entitlements : null;
  const premiumSkins = entitlements && typeof entitlements.premiumSkins === 'boolean'
    ? entitlements.premiumSkins
    : tier === 'studio' || TIER_PREMIUM_SKINS[tier] === true;
  return {
    present: true,
    verified,
    tier: TIER_PREMIUM_SKINS[tier] === undefined ? 'free' : tier,
    claims,
    premiumSkins,
    reason: str(license.reason),
  };
}

/** 时间归一成毫秒：Date / 秒（10 位）/ 毫秒（13 位）/ ISO 都认 */
function expToMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (value && typeof value === 'object' && typeof value.getTime === 'function') {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 授权里点名了这个皮肤吗？（支持 '*' / 'all' / 'premium-*' 前缀通配） */
function claimCoversSkin(claims, id) {
  const list = Array.isArray(claims && claims.skins) ? claims.skins : [];
  for (const raw of list) {
    const item = String(raw || '').trim().toLowerCase();
    if (!item) continue;
    if (item === '*' || item === 'all') return true;
    if (item === id) return true;
    if (item.endsWith('*') && id.startsWith(item.slice(0, -1))) return true;
  }
  return false;
}

/**
 * 判断一套皮肤当前能不能用。免费皮肤永远返回 allowed:true。
 *
 * @param {{ skin:object|string, license?:object, root?:string, now?:any }} opts
 * @returns {{ ok:boolean, allowed:boolean, reason:string, detail?:string, price:number, tier:string, source?:string, skin?:object }}
 */
export function checkSkinLicense({ skin, license, root, now } = {}) {
  let target = skin;
  if (typeof skin === 'string') {
    const found = listSkins({ root }).skins.find((item) => item.id === safeId(skin));
    if (!found) return { ok: false, allowed: false, reason: `没有这个皮肤：${skin}`, price: 0, tier: 'free' };
    target = found;
  }
  if (!target || typeof target !== 'object') {
    return { ok: false, allowed: false, reason: 'checkSkinLicense 需要一个皮肤对象或皮肤 id', price: 0, tier: 'free' };
  }

  const id = safeId(target.id) || str(target.id);
  const price = Math.max(0, Math.round(num(target.price)));
  const premium = target.premium === true || price > 0;
  const base = { ok: true, price, tier: 'free', skin: target };

  // 免费皮肤：无条件可用
  if (!premium) {
    return { ...base, allowed: true, reason: '免费皮肤，随时可用', source: 'free' };
  }

  const lic = normalizeLicense(license);
  const need = `这个皮肤需要授权：¥${price}`;
  const deny = (detail, tier = lic.tier) => ({ ok: true, allowed: false, reason: need, detail, price, tier, skin: target });

  if (!lic.present) return deny('还没有填授权码');
  if (lic.verified === false) return deny(lic.reason || '授权码无效');
  if (!lic.claims) return deny(lic.reason || '授权信息不完整');

  const expMs = expToMs(lic.claims.exp);
  const nowMs = expToMs(now) ?? (typeof now === 'function' ? expToMs(now()) : null) ?? Date.now();
  if (expMs !== null && expMs > 0 && nowMs > expMs) {
    return deny(`授权已于 ${new Date(expMs).toLocaleDateString('zh-CN')} 到期`, lic.tier);
  }

  // 1) 授权里点名了这一套（单买）
  if (claimCoversSkin(lic.claims, id)) {
    return { ...base, allowed: true, reason: `授权已包含「${str(target.name, id)}」`, source: 'license', tier: lic.tier };
  }
  // 2) 档位自带付费皮肤全解锁（工作室版）
  if (lic.premiumSkins) {
    return { ...base, allowed: true, reason: '当前档位已解锁全部付费皮肤', source: 'tier', tier: lic.tier };
  }
  return deny(lic.tier === 'free' ? '当前是免费版' : `${lic.tier} 档不含这套皮肤`, lic.tier);
}

// ---------------------------------------------------------------------------
// activateSkin：写进分身档案
// ---------------------------------------------------------------------------

/**
 * 激活（换装）。授权不到位就拒绝，并且**不改档案**——不做静默降级。
 *
 * @param {object} store createProfileStore 的返回值
 * @param {string} id 皮肤 id
 * @param {object} [license] currentLicense() 的结果或裸 claims
 * @returns {{ ok:boolean, active?:string, profile?:object, skin?:object, reason?:string, price?:number, detail?:string }}
 */
export function activateSkin(store, id, license) {
  if (!store || typeof store.update !== 'function' || typeof store.get !== 'function') {
    return { ok: false, reason: '需要一个 createProfileStore 建出来的档案 store' };
  }
  const wanted = safeId(id);
  if (!wanted) return { ok: false, reason: `皮肤 id 不合法：${id}` };

  const root = typeof store.root === 'string' ? store.root : null;
  const listed = listSkins({ root });
  const skin = listed.skins.find((item) => item.id === wanted);
  if (!skin) {
    return { ok: false, reason: `没有这个皮肤：${id}`, available: listed.skins.map((item) => item.id) };
  }

  const clock = typeof store.now === 'function' ? store.now : () => Date.now();
  const verdict = checkSkinLicense({ skin, license, root, now: clock() });
  if (!verdict.allowed) {
    return { ok: false, reason: `这个皮肤需要授权：¥${verdict.price}`, price: verdict.price, skin, detail: verdict.detail };
  }

  const nowIso = (() => {
    const t = expToMs(clock());
    return new Date(t === null ? Date.now() : t).toISOString();
  })();
  const written = store.update((draft) => {
    const owned = Array.isArray(draft.skins && draft.skins.owned) ? draft.skins.owned.slice() : [];
    if (!owned.includes('basic')) owned.unshift('basic');
    if (!owned.includes(skin.id)) owned.push(skin.id);
    draft.skins = { owned, active: skin.id };
    draft.updatedAt = nowIso;
  });
  if (!written || written.ok === false) {
    return { ok: false, reason: (written && written.reason) || '写档案失败，皮肤没换' };
  }
  return { ok: true, active: skin.id, profile: written.profile, skin };
}

// ---------------------------------------------------------------------------
// renderSprite：皮肤 → SVG 字符串
// ---------------------------------------------------------------------------

/** 皮肤素材的绝对路径（拿不到就 null） */
export function resolveSkinSprite(skin) {
  if (!skin || typeof skin !== 'object') return null;
  if (typeof skin.spritePath === 'string' && skin.spritePath) return skin.spritePath;
  const file = safeFileName(skin.file);
  const dir = safeFileName(skin.dir) || safeId(skin.id);
  if (!file || !dir) return null;
  if (skin.source === 'local' || skin.source === 'workspace') return null; // 第三方皮肤必须带 spritePath，避免瞎拼路径
  return path.join(ASSETS_SKINS_DIR, dir, file);
}

/** 找不到素材时给的占位图：能显示、能看懂、不崩 */
function placeholderSvg({ id, state, size, label, detail }) {
  const stateLabel = STATE_LABELS[state] || STATE_LABELS.idle;
  // aria-label 必须跟着 label 走：这张图有三种完全不同的含义
  //（素材缺失 / 此皮肤需授权 / 素材损坏），硬编码「素材缺失」会让
  //「还没买」被读成「皮肤坏了」——屏幕阅读器和任何读标签的地方都会误解。
  const headline = label ? String(label) : '桌宠素材缺失';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160"`,
    ` data-skin="${esc(id || 'placeholder')}" data-state="${esc(state)}" data-placeholder="true"`,
    ` role="img" aria-label="${esc(headline)}：${esc(stateLabel)}">`,
    '<title>' + esc(headline) + '</title>',
    '<rect x="3" y="3" width="154" height="154" rx="34" fill="#f6f1e6" stroke="#c9b79c" stroke-width="2" stroke-dasharray="7 6"/>',
    '<circle cx="80" cy="70" r="26" fill="none" stroke="#c9b79c" stroke-width="2.4" stroke-dasharray="5 5"/>',
    '<circle cx="71" cy="66" r="2.6" fill="#a99475"/>',
    '<circle cx="89" cy="66" r="2.6" fill="#a99475"/>',
    '<path d="M72 82 q8 5 16 0" fill="none" stroke="#a99475" stroke-width="2.2" stroke-linecap="round"/>',
    `<text x="80" y="112" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" font-weight="600" fill="#8a755a">${esc(label)}</text>`,
    detail
      ? `<text x="80" y="128" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9" fill="#a99475">${esc(detail)}</text>`
      : '',
    `<text x="80" y="150" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10" fill="#a99475">${esc(stateLabel)}</text>`,
    '</svg>',
  ].join('');
}

/** 把模板里的 {{token}} 全部替换掉；模板里没定义的 token 直接清空，保证输出是干净 SVG */
function fillTemplate(template, values) {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out.replace(/\{\{[a-zA-Z0-9_-]+\}\}/g, '');
}

/**
 * 把一套皮肤渲染成一段 SVG 字符串（桌宠视图直接插进 DOM 就行）。
 * **这个函数是契约里唯一返回字符串的**：出错也返回占位 SVG，绝不 throw、绝不返回空串。
 *
 * @param {{ skin:object|string, state?:string, size?:number, license?:object, now?:any, root?:string }} opts
 * @returns {string} SVG 文本
 */
export function renderSprite({ skin, state = 'idle', size = DEFAULT_SIZE, license, now, root } = {}) {
  const wantedState = SKIN_STATES.includes(String(state)) ? String(state) : 'idle';
  const px = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(num(size, DEFAULT_SIZE)) || DEFAULT_SIZE));

  try {
    let target = skin;
    if (typeof skin === 'string') {
      const wanted = safeId(skin);
      target = BUILTIN_SKINS.find((item) => item.id === wanted) || null;
      // 付费皮肤（包内的 premium-aurora、工作区里装的第三方皮肤）不在 BUILTIN_SKINS 里。
      // 只查 BUILTIN 会把「已安装但没授权」画成「素材缺失 / 没有这个皮肤」——那是错的：
      // 它存在，只是锁着，该显示「此皮肤需授权 ¥18」。所以这里按 listSkins 的同一顺序再找一遍。
      if (!target && wanted) target = findInstalledSkin(wanted, root);
      if (!target) {
        return placeholderSvg({ id: skin, state: wantedState, size: px, label: '桌宠素材缺失', detail: `没有这个皮肤：${String(skin).slice(0, 24)}` });
      }
    }
    if (!target || typeof target !== 'object') {
      return placeholderSvg({ state: wantedState, size: px, label: '桌宠素材缺失', detail: '没有指定皮肤' });
    }

    const id = safeId(target.id) || 'skin';
    const premium = target.premium === true || num(target.price) > 0;
    if (premium) {
      const verdict = checkSkinLicense({ skin: target, license, now });
      if (!verdict.allowed) {
        return placeholderSvg({
          id,
          state: wantedState,
          size: px,
          label: `此皮肤需授权 ¥${verdict.price}`,
          detail: '填好授权码就能换上',
        });
      }
    }

    const file = resolveSkinSprite(target);
    if (!file) {
      return placeholderSvg({ id, state: wantedState, size: px, label: '桌宠素材缺失', detail: '皮肤文件路径不可用' });
    }

    let template;
    try {
      template = readTemplate(file, { cache: target.source !== 'local' });
    } catch (err) {
      return placeholderSvg({
        id,
        state: wantedState,
        size: px,
        label: '桌宠素材缺失',
        detail: err && err.code === 'ENOENT' ? '皮肤文件不存在' : '皮肤文件读不了',
      });
    }

    const svg = fillTemplate(template, {
      size: px,
      state: wantedState,
      stateLabel: STATE_LABELS[wantedState],
      accent: str(target.accent, '#b26a2f'),
      name: str(target.name, id),
    });
    if (!/^\s*<svg[\s>]/.test(svg)) {
      return placeholderSvg({ id, state: wantedState, size: px, label: '桌宠素材损坏', detail: '不是一段 SVG' });
    }
    return svg;
  } catch {
    return placeholderSvg({ state: wantedState, size: px, label: '桌宠素材缺失', detail: '渲染时出了点问题' });
  }
}

export default {
  SKIN_STATES,
  STATE_LABELS,
  BUILTIN_SKINS,
  assetsSkinsDir,
  localSkinsDir,
  listSkins,
  checkSkinLicense,
  activateSkin,
  renderSprite,
  resolveSkinSprite,
};
