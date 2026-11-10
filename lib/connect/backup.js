/**
 * lib/connect/backup.js —— 备份的命名、清理与回滚。
 *
 * 原来只有"写前备份"这一半：每次安装留一个 `<配置>.nexi-backup-<时间戳>`，
 * 从不清理。装 10 次 26 家就是几百个文件堆在用户的配置目录里 —— 这不叫安全，
 * 叫往人家家里倒垃圾。缺少的另一半是**回滚**：有备份却只能自己去目录里翻。
 *
 * 这里补齐三件事：
 *   ① 统一命名与解析（能从文件名倒推出时间与来由）；
 *   ② 保留策略（每个配置文件只留最近 N 份，且总数有硬上限）；
 *   ③ 回滚（回滚前把"现在这份"也备份一次，所以回滚本身也可撤销）。
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** 备份文件名：`<原文件名>.nexi-backup-<ISO 时间戳去冒号>[-序号][.<理由>]` */
const BACKUP_RE = /^(?<base>.+?)\.nexi-backup-(?<stamp>\d{4}-\d{2}-\d{2}T[\d-]+Z)(?:-(?<seq>\d+))?(?:\.(?<why>[a-z-]+))?$/;

export const DEFAULT_KEEP = 5;
export const MAX_KEEP = 20;

function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 从备份文件名还原出「什么时候、为什么」。解析不出来不算错，只是 why 为 null。 */
export function parseBackupName(name) {
  const m = BACKUP_RE.exec(basename(name));
  if (!m || !m.groups) return null;
  const s = m.groups.stamp; // 2026-11-10T06-50-00-000Z
  const iso = s.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const at = new Date(iso);
  return {
    base: m.groups.base,
    stamp: s,
    seq: m.groups.seq ? Number(m.groups.seq) : 1,
    at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
    why: m.groups.why || 'write',
  };
}

/** 列出某个配置文件的全部备份，最新在前。 */
export function listBackups(file) {
  const dir = dirname(file);
  const base = basename(file);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${base}.nexi-backup-`)) continue;
    const info = parseBackupName(name);
    if (!info) continue;
    const full = join(dir, name);
    let size = 0;
    try { size = statSync(full).size; } catch { continue; }
    out.push({ path: full, name, size, ...info });
  }
  out.sort((a, b) => {
    const byStamp = String(b.stamp).localeCompare(String(a.stamp));
    return byStamp !== 0 ? byStamp : (b.seq || 1) - (a.seq || 1);
  });
  return out;
}

/** 备份一份当前内容。返回备份路径（文件不存在则不备份，返回 null）。 */
export function backupFile(file, why = 'write') {
  if (!existsSync(file)) return null;
  const suffix = why === 'write' ? '' : `.${why}`;
  const stamp = stampNow();
  // 同一毫秒内连续备份（--all 批量、测试循环）会撞名，撞了就加序号 ——
  // 直接覆盖等于把上一份备份吃掉，正是备份最不该犯的错。
  let target = `${file}.nexi-backup-${stamp}${suffix}`;
  let seq = 1;
  while (existsSync(target)) {
    seq += 1;
    target = `${file}.nexi-backup-${stamp}-${seq}${suffix}`;
  }
  copyFileSync(file, target);
  return target;
}

/**
 * 保留策略：同一个配置文件只留最近 keep 份。
 * 不删"最近一份"，哪怕 keep=0 —— 永远给用户留一条退路。
 */
export function pruneBackups(file, { keep = DEFAULT_KEEP } = {}) {
  const limit = Math.max(1, Math.min(MAX_KEEP, Number.isFinite(keep) ? keep : DEFAULT_KEEP));
  const all = listBackups(file);
  const doomed = all.slice(limit);
  const removed = [];
  for (const b of doomed) {
    try {
      unlinkSync(b.path);
      removed.push(b.path);
    } catch { /* 删不掉就留着，不报错 */ }
  }
  return { kept: all.length - removed.length, removed };
}

/**
 * 回滚到指定备份。
 *
 * 顺序很重要：**先把现在这份备份成 `.prerestore`**，再从备份写回，
 * 最后回读确认。这样"回滚错了"还能再回滚回去 —— 否则回滚本身成了单向操作。
 */
export function restoreBackup(file, backupPath, opts = {}) {
  if (!existsSync(backupPath)) return { ok: false, reason: 'backup-missing', backupPath };
  const info = parseBackupName(backupPath);
  if (!info) return { ok: false, reason: 'not-a-backup', backupPath };

  // 回滚前必须验内容。以前这里直接 copyFileSync：
  // 一份被截断/写坏的备份会把**当前好配置**覆盖成坏内容，而命令返回 ok ——
  // 用户以为救回来了，其实两份都没了。这是数据丢失级的问题。
  if (typeof opts.validate === 'function') {
    const v = opts.validate(backupPath);
    if (!v || v.ok === false) {
      return {
        ok: false,
        reason: 'backup-corrupt',
        backupPath,
        message: `这份备份本身不能用：${(v && v.reason) || '内容无法解析'}`,
        hint: '当前配置一个字节都没动。换一份更早的备份：nexi restore <host> 看列表，用 --to 指定。',
      };
    }
  }

  const safety = opts.dryRun ? null : backupFile(file, 'prerestore');
  if (opts.dryRun) {
    return { ok: true, dryRun: true, changed: true, from: backupPath, at: info.at };
  }

  copyFileSync(backupPath, file);
  // 回读：不信任 copyFileSync 的返回值，直接比对字节
  const want = readFileSync(backupPath);
  const got = readFileSync(file);
  const same = want.length === got.length && Buffer.compare(want, got) === 0;
  return {
    ok: same,
    changed: true,
    from: backupPath,
    at: info.at,
    safety,
    reason: same ? null : 'verify-failed',
  };
}

/** 把"最近的备份"挑出来给 `nexi restore --last` 用。 */
export function latestBackup(file, { why = null } = {}) {
  const all = listBackups(file);
  const pool = why ? all.filter((b) => b.why === why) : all;
  return pool[0] || null;
}

/** 只读摘要（doctor / 诊断包用）：不读内容，只要数量与最近时间。 */
export function backupSummary(file) {
  const all = listBackups(file);
  return {
    count: all.length,
    latest: all[0] ? { path: all[0].path, at: all[0].at, why: all[0].why, size: all[0].size } : null,
    bytes: all.reduce((n, b) => n + b.size, 0),
  };
}

export default {
  parseBackupName,
  listBackups,
  backupFile,
  pruneBackups,
  restoreBackup,
  latestBackup,
  backupSummary,
  DEFAULT_KEEP,
  MAX_KEEP,
};
