/**
 * tools/pack-helper.mjs —— 验收脚本共用的「现打一个包」助手
 *
 * 为什么需要它：
 *   `verify-portable` / `verify-twomachines` 原来直接在仓库根找
 *   `agentdeck-super-<version>.tgz`。开发机上根本没有这个文件 ——
 *   于是每次跑验收都是「解包失败：ENOENT」，看起来像功能坏了，其实只是没打。
 *
 *   更糟的是：即使手动打过一次，那个包可能已经过期（代码改了没重打），
 *   验收就变成在验一份旧代码 —— 那比失败更危险，因为它会给出"通过"。
 *
 * 所以这里钉死两条：
 *   1. 没有包 → 自己打，绝不让调用方去找一个不存在的文件；
 *   2. 打到**临时目录**，不往仓库里丢大文件（历史上有过 294 个文件的包被误提交）。
 *
 * 注意：npm pack 走的是 `files` 白名单，所以打出来的**永远是开源版**（`pro/` 不在里面）。
 * 这正是用户从 npm 装到的东西。要验完整版（含商业层），不能靠打包 —— 见 docs/CONTRACTS.md。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpawnInvocation, resolveCommand } from '../lib/engine/cli.js';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 把当前仓库打成 tgz，落在临时目录。
 *
 * @param {string} [dest] 目标目录；不传就新建一个临时目录
 * @returns {{ ok:true, tgz:string, dir:string, version:string, filename:string }
 *          | { ok:false, reason:string }}
 */
export function packCurrentPackage(dest) {
  const dir = dest || mkdtempSync(join(tmpdir(), 'nexi-pack-'));
  const version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;

  const npm = resolveCommand('npm', { env: process.env });
  if (!npm) return { ok: false, reason: '找不到 npm，无法打出真实安装包' };

  const [exe, argv, spawnOpts] = buildSpawnInvocation(
    npm,
    ['pack', '--pack-destination', dir, '--json'],
    process.env,
  );
  const r = spawnSync(exe, argv, {
    cwd: PKG,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    ...spawnOpts,
  });
  if (r.status !== 0) {
    return { ok: false, reason: `npm pack 失败：${String(r.stderr || r.stdout || '').slice(-500)}` };
  }

  // stdout 是 JSON 数组；解析不出来就按扩展名扫目录兜底（npm 版本差异）
  let filename = '';
  try {
    const parsed = JSON.parse(String(r.stdout || ''));
    filename = String(parsed?.[0]?.filename || '');
  } catch { /* 走兜底 */ }
  if (!filename) {
    const hit = readdirSync(dir).filter((n) => n.endsWith('.tgz')).sort().pop() || '';
    filename = hit;
  }
  if (!filename) return { ok: false, reason: 'npm pack 成功但没找到产物（目录里没有 .tgz）' };

  const tgz = join(dir, filename);
  if (!existsSync(tgz)) return { ok: false, reason: `npm pack 说产出了 ${filename}，但盘上没有` };

  return { ok: true, tgz, dir, version, filename };
}

/**
 * 找一个现成的包：优先用调用方给的路径，其次临时目录里最新的同名包，
 * 都没有就现打。给"想复用上一次打的包"留了口子，但**绝不接受仓库根里的旧包**。
 *
 * @param {string} [explicit] 调用方显式指定的 tgz 路径
 */
export function ensurePackage(explicit) {
  if (explicit) {
    // 显式传了就必须存在，不存在直接报错 —— 静默改用新包会让人以为验的是那个文件
    if (!existsSync(explicit)) return { ok: false, reason: `指定的包不存在：${explicit}` };
    return { ok: true, tgz: explicit, dir: dirname(explicit), version: '', filename: '' };
  }
  return packCurrentPackage();
}
