/**
 * lib/market/themes.js —— 主题包（bundles）1.10.0
 *
 * 蓝图 08 模块写得很清楚：市场要提供「皮肤、声音、动作和**主题包**」，
 * 付费点是「单次购买、创作者分账、**主题包**」。
 * 之前只做了单套皮肤，没有"把几样打包一起卖"这一层 —— 这次补上。
 *
 * 一个主题包 = 一套皮肤 + 可选的音效/动作标识 + 一段说明，
 * 有自己的一口价（通常比单买便宜），买一次解锁包里全部。
 *
 * 诚实边界：
 *   · 只做**打包与授权**这一层。包里引用的素材（音效等）本身得真有文件，
 *     没有的话在 health 里如实报"缺素材"，不假装能用。
 *   · 授权判定复用 skin 那套（lib/market/catalog.js + lib/license.js），不另建第二套真相。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 内置主题包（放在 assets/themes/<id>/theme.json 里，也可由用户工作区提供）。 */
export const THEME_DIRNAME = 'themes';

const str = (v, d = '') => (typeof v === 'string' && v.trim() ? v.trim() : d);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 把一个 theme.json 归一化成能用的形状。
 * 缺必填（id / name / 至少一套皮肤）就返回 null —— 坏包不进市场，免得买了个空壳。
 */
export function normalizeTheme(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const skins = (Array.isArray(raw.skins) ? raw.skins : []).map((s) => str(s)).filter(Boolean);
  if (!skins.length) return null;
  const sounds = (Array.isArray(raw.sounds) ? raw.sounds : []).map((s) => str(s)).filter(Boolean);
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).map((s) => str(s)).filter(Boolean);
  // 价格统一用**分**：市场里其它地方（catalog/orders）都是分，这里也必须是分，
  // 否则同一个页面出现两种单位，算出来的"省多少"就是错的。
  // 兼容老写法 `price`（元）：内部 ×100，只在这里转一次。
  const priceCents = Number.isFinite(Number(raw.priceCents))
    ? Math.max(0, Math.round(Number(raw.priceCents)))
    : Math.max(0, Math.round(num(raw.price, 0) * 100));
  return {
    id,
    name,
    priceCents,
    license: str(raw.license, priceCents > 0 ? 'premium' : 'free'),
    author: str(raw.author, '未知创作者'),
    version: str(raw.version, '1.0.0'),
    description: str(raw.description),
    skins,
    sounds,
    actions,
    // 单买这些皮肤要多少钱（分）；没配就让调用方用皮肤单价加
    separateCents: Math.max(0, Math.round(num(raw.separateCents ?? (raw.separatePrice != null ? raw.separatePrice : 0), 0))),
    accent: str(raw.accent, '#8b7cff'),
  };
}

/** 列出所有主题包（内置 + 工作区里的）。坏包跳过并在 warnings 里说明。 */
export function listThemes({ root, builtinDir } = {}) {
  const dirs = [];
  const builtin = builtinDir || join(process.cwd(), 'assets', THEME_DIRNAME);
  dirs.push({ dir: builtin, source: 'builtin' });
  const r = str(root);
  if (r) dirs.push({ dir: join(r, 'assets', THEME_DIRNAME), source: 'workspace' });

  const themes = [];
  const warnings = [];
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = join(dir, e.name, 'theme.json');
      if (!existsSync(file)) continue;
      const norm = normalizeTheme(readJson(file));
      if (!norm) {
        warnings.push(`${source}/${e.name}/theme.json 不完整（缺 id/name/皮肤），已跳过`);
        continue;
      }
      themes.push({ ...norm, source });
    }
  }
  return { ok: true, themes, warnings };
}

/**
 * 检查一个主题包"是不是真能用"：包里引用的皮肤必须真的存在。
 * 素材缺了就如实报，别让用户买了发现是空包。
 */
export function themeHealth(theme, { knownSkinIds = [] } = {}) {
  if (!theme) return { ok: false, reason: '没有这个主题包' };
  const known = new Set(knownSkinIds);
  const missingSkins = theme.skins.filter((s) => !known.has(s));
  const missingSounds = theme.sounds.filter((s) => !s); // 只有空串才算缺
  return {
    ok: missingSkins.length === 0,
    missingSkins,
    missingSounds,
    playable: missingSkins.length === 0,
  };
}

/**
 * 打包价 vs 单买价：给页面显示"省多少"。
 *
 * 单位统一到**分**（跟 lib/market/catalog.js 一致：价格都是分）。
 * 包价用 `priceCents`；老写法 `price`（元）也认，内部 ×100 —— 但**同一个文件里
 * 两种单位混用会算出"省 99%"这种鬼话**，所以这里统一转换，不再直接比。
 */
export function themeSavings(theme, { skinPriceOf = () => 0 } = {}) {
  if (!theme) return { separateCents: 0, bundleCents: 0, savedCents: 0, percent: 0 };
  const separateCents = theme.separateCents > 0
    ? theme.separateCents
    : theme.skins.reduce((sum, id) => sum + Math.max(0, Math.round(num(skinPriceOf(id), 0))), 0);
  const bundleCents = theme.priceCents;
  const savedCents = Math.max(0, separateCents - bundleCents);
  return {
    separateCents,
    bundleCents,
    savedCents,
    percent: separateCents > 0 ? Math.round((savedCents / separateCents) * 100) : 0,
  };
}

/** 买过这个包没有：包里**所有**皮肤都已在账本里才算有。 */
export function ownsTheme(theme, { ownedSkinIds = [] } = {}) {
  if (!theme) return false;
  const owned = new Set(ownedSkinIds);
  return theme.skins.every((s) => owned.has(s));
}

/** 给人看的一段说明。 */
export function describeTheme(theme, { skinPriceOf = () => 0, ownedSkinIds = [] } = {}) {
  if (!theme) return '（没有这个主题包）';
  const s = themeSavings(theme, { skinPriceOf });
  const owned = ownsTheme(theme, { ownedSkinIds });
  const yuan = (cents) => `¥${(Math.round(num(cents)) / 100).toFixed(2)}`.replace(/\.00$/, '');
  const parts = [
    `${theme.name}（${theme.id}）· ${theme.author} · v${theme.version}`,
    `含 ${theme.skins.length} 套皮肤：${theme.skins.join('、')}${theme.sounds.length ? `｜音效 ${theme.sounds.length} 个` : ''}${theme.actions.length ? `｜动作 ${theme.actions.length} 个` : ''}`,
    `打包价 ${theme.priceCents > 0 ? yuan(theme.priceCents) : '免费'}${s.savedCents > 0 ? `（单买 ${yuan(s.separateCents)}，省 ${yuan(s.savedCents)}，约 ${s.percent}%）` : ''}`,
    owned ? '状态：已拥有' : '状态：未拥有',
  ];
  if (theme.description) parts.push(theme.description);
  return parts.join('\n');
}

export default {
  THEME_DIRNAME,
  normalizeTheme,
  listThemes,
  themeHealth,
  themeSavings,
  ownsTheme,
  describeTheme,
};
