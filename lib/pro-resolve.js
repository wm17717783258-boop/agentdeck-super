/**
 * lib/pro-resolve.js —— 闭源商业层（Pro）的统一加载入口
 *
 * 为什么需要这一层：
 *   核心（本仓库，AGPL-3.0）与商业层（`pro/`，闭源、独立私有仓库）物理分离。
 *   核心运行时需要按需加载商业模块，而**开源用户本来就没有装商业层**——
 *   这是正常状态，不是错误。所以这里的铁律是：**永远不抛异常，永远可降级**。
 *
 * 解析顺序（先到先用）：
 *   1. `../pro/<spec>`        —— 同仓开发态 / 私有 monorepo
 *   2. `agentdeck-pro/<spec>` —— 私有 npm 包（生产态）
 *   3. 都没有 → { ok:false }，调用方按「此功能需要 Nexi Pro」处理
 *
 * 边界（写清楚，别让后面的人猜）：
 *   · 本文件属于**开源核心**，不得引用任何 pro/ 下的静态符号（否则开源版加载即崩）。
 *   · pro 模块的导出形状由两边共同遵守的契约决定，见 docs/CONTRACTS.md。
 *   · 加载失败原因会保留下来给 `proHealth()`，方便 doctor 一眼看出「缺什么」。
 */

/** spec → { ok, mod, via } | { ok:false, reason, errors } */
const CACHE = new Map();

/** 把用户传入的模块名归一成安全的相对路径（不许 ../、不许绝对路径）。 */
function normalizeSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return '';
  if (raw.includes('..') || raw.startsWith('/') || raw.startsWith('\\')) return '';
  return raw.replace(/^\.\//, '').replace(/\\/g, '/');
}

/**
 * 按需加载一个商业层模块。
 *
 * @param {string} spec 形如 `market/index.js`、`billing/index.js`
 * @returns {Promise<{ok:true, mod:any, via:string} | {ok:false, reason:string, errors:string[]}>}
 */
export async function loadPro(spec) {
  const key = normalizeSpec(spec);
  if (!key) {
    return { ok: false, reason: `模块名不合法：${String(spec)}`, errors: [] };
  }
  const hit = CACHE.get(key);
  if (hit) return hit;

  const candidates = [`../pro/${key}`, `agentdeck-pro/${key}`];
  const errors = [];
  for (const specifier of candidates) {
    try {
      // 动态 import：模块不存在时抛 ERR_MODULE_NOT_FOUND，被下面接住
      const mod = await import(specifier);
      const result = { ok: true, mod, via: specifier };
      CACHE.set(key, result);
      return result;
    } catch (err) {
      const code = (err && (err.code || err.name)) || 'error';
      const msg = String((err && err.message) || err).split('\n')[0].slice(0, 160);
      errors.push(`${specifier} → ${code}: ${msg}`);
    }
  }
  const result = {
    ok: false,
    reason: 'Nexi Pro 商业层未安装',
    errors,
  };
  CACHE.set(key, result);
  return result;
}

/**
 * 一次探明商业层整体状态，供 `nexi doctor` / `deck_market health` 展示。
 * 不做任何副作用，缺什么就如实说缺什么。
 */
export async function proHealth() {
  const probes = [
    { spec: 'billing/index.js', label: '支付渠道' },
    { spec: 'market/index.js', label: '皮肤市场' },
    { spec: 'sync/index.js', label: '多设备同步' },
    { spec: 'meeting/index.js', label: '云端会议' },
  ];
  const rows = [];
  for (const p of probes) {
    const r = await loadPro(p.spec);
    rows.push({
      label: p.label,
      spec: p.spec,
      ok: r.ok === true,
      via: r.ok ? r.via : null,
      reason: r.ok ? '' : r.reason,
    });
  }
  const ready = rows.filter((r) => r.ok).length;
  return {
    installed: ready > 0,
    complete: ready === rows.length,
    ready,
    total: rows.length,
    rows,
  };
}

/** 仅供测试重置缓存用（生产代码不要调）。 */
export function __resetProCache() {
  CACHE.clear();
}
