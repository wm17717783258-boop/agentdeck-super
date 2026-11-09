/**
 * lib/sync/index.js —— 跨设备同步（加密 Sync）1.10.0
 *
 * 蓝图里三次点名这件事：
 *   · 07 模块「跨设备、云长期记忆」= 付费触发点；
 *   · 能力表 Payment Hook「跨设备同步与云长期记忆」；
 *   · 架构图「Encrypted Sync：跨设备 · 备份 · 恢复」。
 *
 * 这一层做三件事：
 *   ① **打包**：把本机"属于你的东西"（皮肤装备、分身记忆、习惯、自动化规则）
 *      打成一个可传输的快照；
 *   ② **加密**：用一个**你自己的口令**派生出密钥（scrypt），AES-256-GCM 整体加密。
 *      服务器只看到密文——这是"端到端"该有的样子，不是"我们承诺不看"。
 *   ③ **还原**：在另一台设备上解密、合并（不是覆盖）。
 *
 * 诚实边界（照写）：
 *   · 口令丢了就**真的**解不开 —— 没有后门、没有找回。这是特性不是 bug。
 *   · 合并策略是"后写的赢 + 记忆按内容去重"，不是 CRDT；同一字段两边同时改会以后到的为准。
 *   · 不含授权码、不含身份私钥（那两样不该跨设备明文搬运）。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SYNC_VERSION = 1;
export const SYNC_MAGIC = 'NEXISYNC1';
// scrypt 成本：N=16384 约 16MB 内存，桌面够用。
// 注意别调太大：N=32768 会撞上 Node 默认的 maxmem（32MB）直接抛
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS —— 真机踩过。
export const KDF_N = 1 << 14;
export const KDF_R = 8;
export const KDF_P = 1;
export const KDF_KEYLEN = 32;
/** scrypt 的 maxmem：留足 N*r*128 的两倍余量，免得依赖 Node 默认值 */
const KDF_MAXMEM = 64 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8MB：记忆再多也不该超过这个量级

const b64 = (b) => Buffer.from(b).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');

/** 从口令派生密钥。salt 每次导出都新生成，跟着密文一起走。 */
export function deriveKey(passphrase, salt) {
  const pass = String(passphrase ?? '');
  if (pass.length < 6) return null; // 太短的口令等于没加密
  return scryptSync(pass, salt, KDF_KEYLEN, { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: KDF_MAXMEM });
}

/** 一条快照里包含哪些"属于你的东西"。 */
export function collectSnapshot({ root, now } = {}) {
  const r = String(root || '');
  if (!r) return { ok: false, reason: '同步需要工作区路径（root）' };
  const at = Number(now ? (typeof now === 'function' ? now() : now) : Date.now());

  const readJson = (p, fallback) => {
    try {
      if (!existsSync(p)) return fallback;
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return fallback; // 坏文件跳过，不阻塞整次同步
    }
  };

  const memory = readJson(join(r, '.agentdeck', 'twin', 'memory.json'), { items: [] });
  const habits = readJson(join(r, '.agentdeck', 'twin', 'habits.json'), { confirmed: [], rejected: [] });
  const automation = readJson(join(r, '.agentdeck', 'automation', 'state.json'), { jobs: [] });
  const pet = readJson(join(r, '.agentdeck', 'pet', 'profile.json'), {});
  const policy = readJson(join(r, 'policy.json'), { rules: [] });

  return {
    ok: true,
    snapshot: {
      v: SYNC_VERSION,
      exportedAt: new Date(at).toISOString(),
      // 只带"你的东西"，不带授权码/私钥
      // 注意字段名：profile.json 里是 skins.active / skins.owned，
      // 不是顶层 skin（写错过一次，结果"皮肤没同步"还查了半天）。
      pet: {
        skin: pet?.skins?.active ?? null,
        owned: Array.isArray(pet?.skins?.owned) ? pet.skins.owned : [],
        name: pet?.name ?? null,
      },
      memory: { items: Array.isArray(memory.items) ? memory.items : [] },
      habits: {
        confirmed: Array.isArray(habits.confirmed) ? habits.confirmed : [],
        rejected: Array.isArray(habits.rejected) ? habits.rejected : [],
      },
      automation: { jobs: Array.isArray(automation.jobs) ? automation.jobs : [] },
      policy: { rules: Array.isArray(policy.rules) ? policy.rules : [] },
    },
    counts: {
      memory: Array.isArray(memory.items) ? memory.items.length : 0,
      habits: Array.isArray(habits.confirmed) ? habits.confirmed.length : 0,
      jobs: Array.isArray(automation.jobs) ? automation.jobs.length : 0,
      rules: Array.isArray(policy.rules) ? policy.rules.length : 0,
    },
  };
}

/**
 * 打包 + 加密。返回一个**自包含**的字符串（可以贴微信、可以传服务器）。
 * @returns {{ok:boolean, blob?:string, counts?:object, reason?:string}}
 */
export function packSync({ root, passphrase, now } = {}) {
  const got = collectSnapshot({ root, now });
  if (!got.ok) return got;

  const plain = Buffer.from(JSON.stringify(got.snapshot), 'utf8');
  if (plain.length > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: `要同步的内容太大（${plain.length} 字节，上限 ${MAX_PAYLOAD_BYTES}）` };
  }
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  if (!key) return { ok: false, reason: '口令太短：至少要 6 个字符，不然等于没加密' };

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // 把头部也纳入认证：改版本号/改盐都会被 GCM 拦住
  const header = Buffer.from(`${SYNC_MAGIC}:${SYNC_VERSION}`, 'utf8');
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = {
    magic: SYNC_MAGIC,
    v: SYNC_VERSION,
    kdf: { alg: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, maxmem: KDF_MAXMEM, salt: b64(salt) },
    enc: { alg: 'aes-256-gcm', iv: b64(iv), tag: b64(tag) },
    data: b64(ct),
  };
  return {
    ok: true,
    blob: `${SYNC_MAGIC}.${b64(Buffer.from(JSON.stringify(envelope), 'utf8'))}`,
    counts: got.counts,
  };
}

/**
 * 解包 + 解密。**任何失败都返回 ok:false**，绝不给半截数据。
 */
export function unpackSync({ blob, passphrase } = {}) {
  const raw = String(blob || '').trim();
  if (!raw) return { ok: false, reason: '没有内容可解' };
  if (!raw.startsWith(`${SYNC_MAGIC}.`)) {
    return { ok: false, reason: `这不是 ${SYNC_MAGIC} 格式的同步包（或者被截断了）` };
  }
  let envelope = null;
  try {
    envelope = JSON.parse(unb64(raw.slice(SYNC_MAGIC.length + 1)).toString('utf8'));
  } catch {
    return { ok: false, reason: '同步包内容坏了（不是合法 base64/JSON）' };
  }
  if (envelope?.magic !== SYNC_MAGIC) return { ok: false, reason: `同步包标识不对：${envelope?.magic}` };
  if (Number(envelope?.v) !== SYNC_VERSION) return { ok: false, reason: `同步包版本不认识：${envelope?.v}` };
  if (envelope?.kdf?.alg !== 'scrypt') return { ok: false, reason: `KDF 不认识：${envelope?.kdf?.alg}` };
  if (envelope?.enc?.alg !== 'aes-256-gcm') return { ok: false, reason: `加密算法不认识：${envelope?.enc?.alg}` };

  const key = deriveKey(passphrase, unb64(envelope.kdf.salt));
  if (!key) return { ok: false, reason: '口令太短' };

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, unb64(envelope.enc.iv));
    decipher.setAAD(Buffer.from(`${SYNC_MAGIC}:${SYNC_VERSION}`, 'utf8'));
    decipher.setAuthTag(unb64(envelope.enc.tag));
    const out = Buffer.concat([decipher.update(unb64(envelope.data)), decipher.final()]);
    const snapshot = JSON.parse(out.toString('utf8'));
    return { ok: true, snapshot };
  } catch (err) {
    // 口令错 / 密文被改 / 头被改 —— 都收敛成一句话，不泄漏是哪里失败的
    return { ok: false, reason: `解不开（口令不对，或者内容被改过）：${String(err?.message || err).slice(0, 80)}` };
  }
}

/** 数组按 id/内容去重（后写的赢）。 */
function mergeById(localList, remoteList, keyOf) {
  const out = [];
  const index = new Map();
  for (const item of Array.isArray(localList) ? localList : []) {
    const k = keyOf(item);
    if (k == null) continue;
    index.set(k, out.length);
    out.push(item);
  }
  for (const item of Array.isArray(remoteList) ? remoteList : []) {
    const k = keyOf(item);
    if (k == null) continue;
    if (index.has(k)) out[index.get(k)] = item; // 远端更新 → 覆盖
    else { index.set(k, out.length); out.push(item); }
  }
  return out;
}

/**
 * 把一份快照合并进本机（**合并，不是覆盖**）。
 * @returns {{ok:boolean, applied?:object, reason?:string}}
 */
export function applySnapshot({ root, snapshot, now } = {}) {
  const r = String(root || '');
  if (!r) return { ok: false, reason: '还原需要工作区路径（root）' };
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: '快照不是对象' };
  if (Number(snapshot.v) !== SYNC_VERSION) return { ok: false, reason: `快照版本不认识：${snapshot.v}` };

  const at = Number(now ? (typeof now === 'function' ? now() : now) : Date.now());
  const writeJson = (p, value) => {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, p);
  };
  const readJson = (p, fallback) => {
    try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; } catch { return fallback; }
  };

  const applied = { memory: 0, habits: 0, jobs: 0, rules: 0, pet: false };

  // 记忆：按 text 指纹去重（同一句话不该出现两遍）
  const memPath = join(r, '.agentdeck', 'twin', 'memory.json');
  const local = readJson(memPath, { version: 1, items: [] });
  const fp = (it) => String(it?.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const incoming = Array.isArray(snapshot?.memory?.items) ? snapshot.memory.items : [];
  applied.memory = mergeById(
    Array.isArray(local.items) ? local.items : [],
    incoming,
    (it) => fp(it) || null,
  );
  writeJson(memPath, { ...local, version: 1, items: applied.memory });
  applied.memory = applied.memory.length;

  // 习惯
  const habPath = join(r, '.agentdeck', 'twin', 'habits.json');
  const lh = readJson(habPath, { confirmed: [], rejected: [] });
  const confirmed = mergeById(lh.confirmed, snapshot?.habits?.confirmed, (x) => x?.key ?? null);
  const rejected = mergeById(lh.rejected, snapshot?.habits?.rejected, (x) => x?.key ?? null);
  writeJson(habPath, { ...lh, confirmed, rejected });
  applied.habits = confirmed.length;

  // 自动化规则（按 id）
  const autoPath = join(r, '.agentdeck', 'automation', 'state.json');
  const la = readJson(autoPath, { version: 1, jobs: [], approvals: [], runs: [] });
  const jobs = mergeById(la.jobs, snapshot?.automation?.jobs, (x) => x?.id ?? null);
  writeJson(autoPath, { ...la, version: la.version ?? 1, jobs });
  applied.jobs = jobs.length;

  // 策略规则（按 id）
  const polPath = join(r, 'policy.json');
  const lp = readJson(polPath, { version: 1, rules: [] });
  const rules = mergeById(lp.rules, snapshot?.policy?.rules, (x) => x?.id ?? null);
  writeJson(polPath, { ...lp, version: lp.version ?? 1, rules });
  applied.rules = rules.length;

  // 桌宠装备（皮肤）：合并 owned，并把 active 设成同步过来的那套
  if (snapshot?.pet?.skin) {
    const petPath = join(r, '.agentdeck', 'pet', 'profile.json');
    const lpet = readJson(petPath, { version: 1, skins: { owned: ['basic'], active: 'basic' } });
    const owned = new Set([...(Array.isArray(lpet?.skins?.owned) ? lpet.skins.owned : []), ...(Array.isArray(snapshot.pet.owned) ? snapshot.pet.owned : [])]);
    owned.add('basic');
    owned.add(String(snapshot.pet.skin));
    writeJson(petPath, {
      ...lpet,
      version: lpet.version ?? 1,
      skins: { ...(lpet.skins || {}), owned: [...owned], active: String(snapshot.pet.skin) },
      ...(snapshot.pet.name ? { name: String(snapshot.pet.name) } : {}),
      syncedAt: new Date(at).toISOString(),
    });
    applied.pet = true;
  }

  return { ok: true, applied, at: new Date(at).toISOString() };
}

/** 取本机指纹：用来判断"这台设备是不是同一台"，避免自己同步自己。 */
export function deviceId({ root } = {}) {
  const file = join(String(root || ''), '.agentdeck', 'device-id.txt');
  if (existsSync(file)) {
    const v = readFileSync(file, 'utf8').trim();
    if (v) return v;
  }
  const id = `dev_${randomBytes(6).toString('hex')}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`, 'utf8');
  } catch { /* 写不了就每次新生成，不影响功能 */ }
  return id;
}

/** 两个字符串常数时间比较（给测试/指纹用）。 */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export default {
  SYNC_VERSION,
  SYNC_MAGIC,
  deriveKey,
  collectSnapshot,
  packSync,
  unpackSync,
  applySnapshot,
  deviceId,
  sameSecret,
};
