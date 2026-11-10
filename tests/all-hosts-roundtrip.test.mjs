/**
 * tests/all-hosts-roundtrip.test.mjs —— 26 家宿主，每一家都真的走一遍「装 → 审 → 卸」。
 *
 * 为什么需要这个文件：
 *   `docs/成熟度自检.md` 里如实写过一句「26 家里只真装过 6 家」。
 *   那不是能力问题，是这台机器上只装了 6 个宿主 —— 剩下 20 家的写入逻辑
 *   从来没被真正执行过，只被单元测试覆盖过形状。
 *
 *   这个文件把 26 家的**真实写盘路径**（临时目录里）全部跑一遍：
 *     ① 装：配置里真的出现 nexi 条目；
 *     ② 审：四层审计判 wired（条目在、脚本在、解释器在、路径一致）；
 *     ③ 再装：判「无变化」，不写盘；
 *     ④ 卸：条目精确消失，文件里不再残留 nexi 的启动命令。
 *
 *   它证明的是「逻辑对 26 家都成立」，不是「26 个宿主软件都认这份配置」——
 *   后者只能靠真机，这里不冒充。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOSTS, installHost, uninstallHost } from '../lib/connect/hosts.js';
import { auditHost } from '../lib/connect/audit.js';

const NEXI = fileURLToPath(new URL('../bin/nexi.mjs', import.meta.url));
const LAUNCH = { command: process.execPath, args: [NEXI, 'mcp'], env: {} };
const DIR = mkdtempSync(path.join(tmpdir(), 'nexi-roundtrip-'));

function fileFor(host) {
  const ext = path.extname(host.paths()[0]) || '.json';
  return path.join(DIR, `${host.id}${ext}`);
}

test('26 家宿主：装 → 审 wired → 再装无变化 → 卸干净', () => {
  const failures = [];
  for (const host of HOSTS) {
    const file = fileFor(host);
    const h = { ...host, paths: () => [file] };
    const where = `${host.id}（${path.basename(file)}）`;

    const first = installHost(host.id, { host: h, path: file, launch: LAUNCH, force: true, via: 'file' });
    if (!first.ok) {
      failures.push(`${where} 装失败：${first.reason || (first.warnings || []).join('；')}`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    if (!/nexi/.test(text)) {
      failures.push(`${where} 装完文件里没有 nexi`);
      continue;
    }

    const audit = auditHost(h, { file, currentLaunch: LAUNCH });
    if (audit.state !== 'wired') {
      failures.push(`${where} 审出 ${audit.state}：${audit.reason || audit.note || ''}`);
      continue;
    }

    const second = installHost(host.id, { host: h, path: file, launch: LAUNCH, force: true, via: 'file' });
    if (!second.ok || second.changed !== false) {
      failures.push(`${where} 二次安装不是「无变化」（changed=${second.changed}）`);
      continue;
    }

    const removed = uninstallHost(host.id, { path: file, name: 'nexi' });
    if (!removed.ok || removed.changed !== true) {
      failures.push(`${where} 卸失败：${removed.reason || `changed=${removed.changed}`}`);
      continue;
    }
    const after = readFileSync(file, 'utf8');
    if (/nexi/.test(after)) {
      failures.push(`${where} 卸完还残留 nexi：${after.slice(0, 120).replace(/\n/g, '⏎')}`);
    }
  }
  assert.deepEqual(failures, [], `有 ${failures.length} 家没走通：\n${failures.join('\n')}`);
});

test('26 家宿主：装的时候都不会把「本机家目录」写进别人的配置（除脚本路径本身）', () => {
  const offenders = [];
  for (const host of HOSTS) {
    const file = fileFor(host);
    const h = { ...host, paths: () => [file] };
    installHost(host.id, { host: h, path: file, launch: LAUNCH, force: true, via: 'file' });
    const text = readFileSync(file, 'utf8');
    // 允许出现 node 与 nexi 脚本的真实路径；不允许出现「为了占位而写的假家目录」
    if (text.includes('/Users/you') || text.includes('C:\\Users\\you')) {
      offenders.push(host.id);
    }
  }
  assert.deepEqual(offenders, [], `这些宿主的配置里写进了假家目录：${offenders.join(', ')}`);
});

test('不留下半写的临时文件（原子写要真的原子）', () => {
  const strays = readdirSync(DIR).filter((n) => /\.tmp$/.test(n) || /^\..*\.nexi\.tmp$/.test(n));
  assert.deepEqual(strays, [], `写盘留下了临时文件：${strays.join(', ')}`);
});
