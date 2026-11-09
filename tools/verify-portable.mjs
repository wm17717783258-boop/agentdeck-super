/**
 * 可移植性验证：把 tgz 解到别处，按它写出来的宿主配置**真起一次服务**。
 *
 * 要证的事：这个包拷到另一台电脑能不能直接用。
 * 唯一靠谱的验法不是看路径字符串，而是**照配置里写的命令真起一次**。
 */
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTgz } from '../lib/untar.js';
import { HUB_TOOL_ORDER } from '../lib/hub.js';

// 仓库位置：从本文件位置往上推，别写死——写死后在别的机器上直接失败（真机踩过）
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const tgz = join(REPO, `agentdeck-super-${version}.tgz`);
const expectedTools = HUB_TOOL_ORDER.length;
const far = mkdtempSync(join(tmpdir(), 'portable-'));
const dshHome = join(far, 'dsh');
const work = join(far, 'work');
mkdirSync(dshHome, { recursive: true });
mkdirSync(work, { recursive: true });

console.log('模拟另一台电脑：', far);

/* 1. 解包（就像用户把 tgz 拷过去解开） */
// 用自带的纯 JS 解包：不依赖系统 tar（中文路径 + 精简环境都扛得住）
const untarRes = extractTgz(tgz, far, { readFile: readFileSync });
if (!untarRes.ok) { console.log('  ❌ 解包失败:', untarRes.reason); process.exit(1); }
const pkgDir = join(far, 'package');
const bin = join(pkgDir, 'bin', 'nexi.mjs');
console.log('  ✅ 解包成功');

/* 2. 用'那台电脑上'的 bin 装进一个假宿主配置 */
const target = join(far, 'cursor-mcp.json');
const inst = spawnSync(process.execPath, [bin, 'install', 'cursor', target], { encoding: 'utf8', windowsHide: true });
console.log('  装入配置:', inst.status === 0 ? '成功' : '失败 ' + inst.stderr.slice(0, 120));

/* 3. 读那份配置，看它让宿主起什么 */
const cfg = JSON.parse(readFileSync(target, 'utf8'));
const entry = cfg.mcpServers.nexi;
console.log('  配置里写的命令:', entry.command);
console.log('  配置里写的脚本:', entry.args[0]);

/* 4. 关键：**完全照配置起一次**（宿主就是这么干的） */
const child = spawn(entry.command, entry.args, {
  env: { ...process.env, DSH_HOME: dshHome, NEXI_WORKSPACE: work },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let buf = '';
let settled = false;
let initialized = false;
const finish = (msg, code) => { if (settled) return; settled = true; console.log(msg); try { child.kill(); } catch {} process.exitCode = code; };

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m = null;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      if (!m.result?.serverInfo?.name) return finish('  ❌ initialize 响应缺 serverInfo', 1);
      initialized = true;
      console.log(`  ✅ 照配置起的服务回话了：${m.result.serverInfo.name} v${m.result.serverInfo.version}`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    }
    if (m.id === 2) {
      const count = m.result?.tools?.length;
      if (!initialized) return finish('  ❌ tools/list 先于 initialize 返回', 1);
      if (!Number.isInteger(count) || count !== expectedTools) {
        return finish(`  ❌ 工具清单 ${count ?? '缺失'} 个，期望 ${expectedTools} 个`, 1);
      }
      finish(`  ✅ 工具清单：${count} 个，与本机一致\n  ✅ 2/2 通过`, 0);
    }
  }
});
child.stderr.on('data', (d) => { const s = d.toString(); if (/Error|Cannot/.test(s)) finish(`  ❌ 子进程报错: ${s.slice(0, 200)}`, 1); });
child.on('error', (e) => finish(`  ❌ 起不来: ${e.message}`, 1));

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })}\n`);
setTimeout(() => finish('  ❌ 10 秒没回应', 1), 10000);
setTimeout(() => { rmSync(far, { recursive: true, force: true }); }, 11000);
