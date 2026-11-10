/**
 * tests/platform-matrix.test.mjs —— 一个包，三个系统。
 *
 * 为什么要有这个测试：
 *   用户的原话是「插件是配合通用 Agent 用的，凭什么分电脑系统」。
 *   他说得对：产物只有一个（纯 Node ESM、零原生依赖，npm 上同一个 tarball）。
 *   真正认系统的只有一件事 —— **别人家的宿主把配置文件放在哪**：
 *     Windows  %APPDATA%\Claude\claude_desktop_config.json
 *     macOS    ~/Library/Application Support/Claude/claude_desktop_config.json
 *     Linux    ~/.config/Claude/claude_desktop_config.json
 *   这张表以前写死成 Windows 版，macOS 上会算成 ~/AppData/Roaming/...：
 *   路径不存在 → 探测说"宿主未安装" → 用户以为插件不支持 mac。
 *
 * 所以这里不假装去装一台 Mac，而是把 platform 注入进去，
 * 在这台 Windows 上把三条系统的路径**逐字**算出来核对。
 * 谁把 Window 专用写法改回来，这里立刻红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HOSTS, findHost, detectHosts } from '../lib/connect/hosts.js';
import { platformCtx, configRoot, dotConfigRoot } from '../lib/connect/platform.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WIN_HOME = 'C:\\Users\\nexi';
const NIX_HOME = '/Users/nexi';

const ctxOf = (platform) => platformCtx({
  platform,
  home: platform === 'win32' ? WIN_HOME : NIX_HOME,
  env: platform === 'win32'
    ? { APPDATA: 'C:\\Users\\nexi\\AppData\\Roaming' }
    : {},
});

const first = (id, ctx) => findHost(id).paths(ctx)[0];

test('每个宿主在三个系统上都能算出绝对路径，不抛异常', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const ctx = ctxOf(platform);
    for (const h of HOSTS) {
      const paths = h.paths(ctx);
      assert.ok(Array.isArray(paths) && paths.length > 0, `${h.id} 在 ${platform} 上没有候选路径`);
      for (const p of paths) {
        assert.equal(typeof p, 'string', `${h.id} 在 ${platform} 上给了非字符串`);
        assert.ok(
          platform === 'win32' ? /^[A-Za-z]:\\/.test(p) : p.startsWith('/'),
          `${h.id} 在 ${platform} 上不是绝对路径：${p}`,
        );
      }
    }
  }
});

test('Claude Desktop：三系统各自的真实落点', () => {
  assert.equal(
    first('claude-desktop', ctxOf('win32')),
    'C:\\Users\\nexi\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
  );
  assert.equal(
    first('claude-desktop', ctxOf('darwin')),
    '/Users/nexi/Library/Application Support/Claude/claude_desktop_config.json',
  );
  assert.equal(
    first('claude-desktop', ctxOf('linux')),
    '/Users/nexi/.config/Claude/claude_desktop_config.json',
  );
});

test('VS Code：Application Support / .config 不能退化成 AppData', () => {
  assert.equal(
    first('vscode', ctxOf('darwin')),
    '/Users/nexi/Library/Application Support/Code/User/mcp.json',
  );
  assert.equal(first('vscode', ctxOf('linux')), '/Users/nexi/.config/Code/User/mcp.json');
  assert.equal(
    first('vscode', ctxOf('win32')),
    'C:\\Users\\nexi\\AppData\\Roaming\\Code\\User\\mcp.json',
  );
});

test('Cline 的 globalStorage 跟着 VS Code 走', () => {
  assert.equal(
    first('cline', ctxOf('darwin')),
    '/Users/nexi/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
  );
  assert.equal(
    first('cline', ctxOf('linux')),
    '/Users/nexi/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
  );
});

test('Zed 在 macOS 上读 ~/.config，不是 Application Support', () => {
  assert.equal(first('zed', ctxOf('darwin')), '/Users/nexi/.config/zed/settings.json');
  assert.equal(first('zed', ctxOf('linux')), '/Users/nexi/.config/zed/settings.json');
  assert.equal(
    first('zed', ctxOf('win32')),
    'C:\\Users\\nexi\\AppData\\Roaming\\Zed\\settings.json',
  );
});

test('macOS / Linux 的任何候选路径都不许出现 AppData 或反斜杠', () => {
  for (const platform of ['darwin', 'linux']) {
    const ctx = ctxOf(platform);
    for (const h of HOSTS) {
      for (const p of h.paths(ctx)) {
        assert.ok(!/AppData/i.test(p), `${platform} 上 ${h.id} 算出了 Windows 路径：${p}`);
        assert.ok(!p.includes('\\'), `${platform} 上 ${h.id} 算出了反斜杠路径：${p}`);
      }
    }
  }
});

test('XDG_CONFIG_HOME 有值时按它走（Linux 自定义配置目录）', () => {
  const ctx = platformCtx({ platform: 'linux', home: NIX_HOME, env: { XDG_CONFIG_HOME: '/data/cfg' } });
  assert.equal(configRoot(ctx), '/data/cfg');
  assert.equal(dotConfigRoot(ctx), '/data/cfg');
  assert.equal(first('opencode', ctx), '/data/cfg/opencode/opencode.json');
});

test('APPDATA 缺失时 Windows 也不许拼出相对路径', () => {
  const ctx = platformCtx({ platform: 'win32', home: WIN_HOME, env: {} });
  assert.equal(configRoot(ctx), 'C:\\Users\\nexi\\AppData\\Roaming');
  for (const h of HOSTS) {
    for (const p of h.paths(ctx)) {
      assert.ok(/^[A-Za-z]:\\/.test(p), `${h.id} 在 APPDATA 缺失时算出了非绝对路径：${p}`);
    }
  }
});

test('detectHosts 接受平台上下文：13 个宿主、不抛、不造文件', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const rows = detectHosts(ctxOf(platform));
    assert.equal(rows.length, HOSTS.length);
    assert.ok(rows.length >= 13, `宿主数量掉了：${rows.length}`);
    for (const r of rows) {
      assert.ok(r.path, `${r.id} 没有落点路径`);
      assert.ok(Array.isArray(r.candidates) && r.candidates.length > 0);
    }
  }
});

test('真实机器上算出来的路径和注入模式一致（同一份代码，不是两套）', () => {
  const real = detectHosts();
  const injected = detectHosts(platformCtx());
  assert.deepEqual(real.map((r) => r.path), injected.map((r) => r.path));
  // 本机是三系统之一，落点必须是绝对路径；顺带把当前系统的根打出来便于对账。
  for (const r of real) assert.ok(path.isAbsolute(r.path), `${r.id} 落点不是绝对路径：${r.path}`);
});

test('nexi where：一屏打出三个系统的落点，自带「同一份包」的结论', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'nexi.mjs'), 'where'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /一个包，三个系统/);
  for (const p of ['win32', 'darwin', 'linux']) assert.ok(out.includes(p), `输出里没有 ${p} 这一列`);
  for (const h of HOSTS) assert.ok(out.includes(h.label), `输出里没有宿主 ${h.label}`);
  // 跨系统预览必须是该系统的真实形状，不能把本机家目录硬套过去。
  assert.match(out, /darwin\s+~\/Library\/Application Support\/Claude\/claude_desktop_config\.json/);
  assert.match(out, /linux\s+~\/\.config\/Claude\/claude_desktop_config\.json/);
  assert.ok(!/darwin\s+C:\\/.test(out), 'macOS 那列混进了 Windows 路径');
});

test('nexi where --json：机器可读，和 hosts 表同源', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'nexi.mjs'), 'where', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.sameArtifact, true);
  assert.equal(data.hosts.length, HOSTS.length);
  const claude = data.hosts.find((h) => h.id === 'claude-desktop');
  assert.equal(claude.darwin, '~/Library/Application Support/Claude/claude_desktop_config.json');
  assert.equal(claude.linux, '~/.config/Claude/claude_desktop_config.json');
  for (const h of data.hosts) {
    assert.ok(!/AppData/.test(h.darwin), `${h.id} 的 macOS 路径是 Windows 形状`);
    assert.ok(!/AppData/.test(h.linux), `${h.id} 的 Linux 路径是 Windows 形状`);
  }
});
