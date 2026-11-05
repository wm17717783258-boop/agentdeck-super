#!/usr/bin/env node
/**
 * 改版本号（不碰 git，不需要 git 已安装）。
 *
 *   node scripts/bump-version.mjs patch     # 1.4.0 → 1.4.1
 *   node scripts/bump-version.mjs minor     # 1.4.0 → 1.5.0
 *   node scripts/bump-version.mjs 1.5.2     # 指定版本
 *
 * 只改 package.json 的 version，顺带把 dsh.compatibility.dshReleases 里
 * 当前宿主版本（读 `dsh --version`）标成 compatible，避免忘了加导致市场判不兼容。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const arg = process.argv[2];

if (!arg) {
  console.log(`当前版本 ${pkg.version}；用法：node scripts/bump-version.mjs patch|minor|major|<x.y.z>`);
  process.exit(1);
}

const [maj, min, pat] = pkg.version.split('.').map(Number);
let next;
if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`;
else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
else if (arg === 'major') next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  console.error(`看不懂这个版本号：${arg}`);
  process.exit(1);
}

pkg.version = next;

// 把本机宿主版本标成 compatible（读不到就跳过，不阻断）
// 优先用调用方传进来的 AGENTDECK_HOST_VERSION（release.ps1 已经解析过 dsh 路径，
// 不必依赖 PATH 上有 dsh.cmd —— 在 pwsh 里直接调 `dsh` 往往找不到）。
function hostVersion() {
  const injected = (process.env.AGENTDECK_HOST_VERSION || '').trim();
  if (injected) return injected;
  const candidates = [];
  if (process.env.AGENTDECK_DSH_BIN) candidates.push(process.env.AGENTDECK_DSH_BIN);
  candidates.push(process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, shell: bin === 'dsh.cmd' }).trim();
      if (out) return out;
    } catch {
      // 下一个候选
    }
  }
  return '';
}

try {
  const raw = hostVersion();
  const version = (raw.match(/\d+\.\d+\.\d+(?:-rc\.\d+)?/) || [])[0];
  if (version) {
    pkg.dsh.compatibility.dshReleases = pkg.dsh.compatibility.dshReleases || {};
    if (pkg.dsh.compatibility.dshReleases[version] !== 'compatible') {
      pkg.dsh.compatibility.dshReleases[version] = 'compatible';
      console.log(`compatibility.dshReleases["${version}"] = compatible`);
    }
  } else {
    console.log('（读不到本机 dsh 版本，跳过 compatibility 补写）');
  }
} catch {
  console.log('（读不到本机 dsh 版本，跳过 compatibility 补写）');
}

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${pkg.version === next ? '' : ''}${next}  ← 版本已更新（原 ${[maj, min, pat].join('.')}）`);
