/**
 * tests/platform-paths.test.mjs —— 「路径算得对」的机器验收。
 *
 * 之前只有一个弱断言：三系统算出来的路径**互不相同**、macOS/Linux 上不许出现
 * AppData 与反斜杠。它能挡住「四个宿主在 Mac 上算成 ~/AppData/Roaming」这种大错，
 * 但挡不住「文件名少一个字母」—— 那三个路径依然互不相同，测试依然绿。
 *
 * 这个文件补两件事：
 *   ① 通用禁令：每个宿主的每条路径，按**目标系统**的语法检查
 *      （win32 必须盘符开头且无正斜杠；posix 必须 / 开头、无反斜杠、
 *        不许出现另一系统的标志性目录、不许留 ~ 或 ${VAR} 占位符）；
 *   ② 关键宿主的**逐字契约**：把高置信度的落点写死成常量。
 *      谁改了路径表，就必须同时改这里的期望值 —— 逼人确认「是真的变了，还是写错了」。
 *
 * 低置信度的宿主（官方文档没给死、只能靠实测的）不写死，只走通用禁令。
 * 这不是偷懒：写一张自己都不确定的期望表，比没有表更坏。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 as winPath, posix as posixPath } from 'node:path';

import { HOSTS } from '../lib/connect/hosts.js';
import { platformCtx } from '../lib/connect/platform.js';

const CTX = {
  win32: platformCtx({ platform: 'win32', home: 'C:\\Users\\you', env: { APPDATA: 'C:\\Users\\you\\AppData\\Roaming' } }),
  darwin: platformCtx({ platform: 'darwin', home: '/Users/you', env: {} }),
  linux: platformCtx({ platform: 'linux', home: '/home/you', env: { XDG_CONFIG_HOME: '' } }),
};

/**
 * 逐字契约：只收「官方文档写明 / 本机实测过」的落点。
 * 值一律用 `~` 表示家目录，方便人读；比较时再展开。
 */
const CONTRACT = {
  'claude-desktop': {
    win32: '%APPDATA%/Claude/claude_desktop_config.json',
    darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
    linux: '~/.config/Claude/claude_desktop_config.json',
  },
  'claude-code': {
    win32: '~/.claude.json',
    darwin: '~/.claude.json',
    linux: '~/.claude.json',
  },
  cursor: {
    win32: '~/.cursor/mcp.json',
    darwin: '~/.cursor/mcp.json',
    linux: '~/.cursor/mcp.json',
  },
  windsurf: {
    win32: '~/.codeium/windsurf/mcp_config.json',
    darwin: '~/.codeium/windsurf/mcp_config.json',
    linux: '~/.codeium/windsurf/mcp_config.json',
  },
  codex: {
    win32: '~/.codex/config.toml',
    darwin: '~/.codex/config.toml',
    linux: '~/.codex/config.toml',
  },
  cline: {
    win32: '%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
    darwin: '~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
    linux: '~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
  },
  'roo-code': {
    win32: '%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
    darwin: '~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
    linux: '~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json',
  },
  kilocode: {
    win32: '%APPDATA%/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json',
    darwin: '~/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json',
    linux: '~/.config/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json',
  },
  vscode: {
    win32: '%APPDATA%/Code/User/mcp.json',
    darwin: '~/Library/Application Support/Code/User/mcp.json',
    linux: '~/.config/Code/User/mcp.json',
  },
  zed: {
    win32: '%APPDATA%/Zed/settings.json',
    darwin: '~/.config/zed/settings.json',
    linux: '~/.config/zed/settings.json',
  },
  goose: {
    win32: '%APPDATA%/Block/goose/config/config.yaml',
    darwin: '~/.config/goose/config.yaml',
    linux: '~/.config/goose/config.yaml',
  },
  continue: {
    win32: '~/.continue/config.yaml',
    darwin: '~/.continue/config.yaml',
    linux: '~/.continue/config.yaml',
  },
  'gemini-cli': {
    win32: '~/.gemini/settings.json',
    darwin: '~/.gemini/settings.json',
    linux: '~/.gemini/settings.json',
  },
  opencode: {
    win32: '~/.config/opencode/opencode.json',
    darwin: '~/.config/opencode/opencode.json',
    linux: '~/.config/opencode/opencode.json',
  },
  antigravity: {
    win32: '~/.gemini/config/mcp_config.json',
    darwin: '~/.gemini/config/mcp_config.json',
    linux: '~/.gemini/config/mcp_config.json',
  },
  // 官方文档写明：~/.codebuddy/.mcp.json > mcp.json > .codebuddy.json，都不存在就建第一个。
  codebuddy: {
    win32: '~/.codebuddy/.mcp.json',
    darwin: '~/.codebuddy/.mcp.json',
    linux: '~/.codebuddy/.mcp.json',
  },
  // Trae 是 VS Code 系，但 MCP 配置在 User/mcp.json，不在 globalStorage 的扩展目录。
  trae: {
    win32: '%APPDATA%/Trae/User/mcp.json',
    darwin: '~/Library/Application Support/Trae/User/mcp.json',
    linux: '~/.config/Trae/User/mcp.json',
  },
};

/** 把契约里的 `~` / `%APPDATA%` 展开成与实现同源的绝对路径。 */
function expand(tpl, platform) {
  const ctx = CTX[platform];
  let s = tpl;
  if (s.startsWith('%APPDATA%/')) s = `${ctx.env.APPDATA.replace(/\\/g, '/')}/${s.slice('%APPDATA%/'.length)}`;
  if (s === '~') s = ctx.home.replace(/\\/g, '/');
  else if (s.startsWith('~/')) s = `${ctx.home.replace(/\\/g, '/')}/${s.slice(2)}`;
  return platform === 'win32' ? s.replace(/\//g, '\\') : s;
}

test('逐字契约：16 家关键宿主的三系统落点与文档一致', () => {
  for (const [id, spec] of Object.entries(CONTRACT)) {
    const host = HOSTS.find((h) => h.id === id);
    assert.ok(host, `契约里的宿主 ${id} 已经不在 HOSTS 里了，删掉这一项或补回宿主`);
    for (const platform of ['win32', 'darwin', 'linux']) {
      const actual = host.paths(CTX[platform])[0];
      assert.equal(actual, expand(spec[platform], platform), `${id}@${platform} 的落点与契约不符`);
    }
  }
});

test('通用禁令：每条路径都符合目标系统的语法，且不串味', () => {
  for (const host of HOSTS) {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const list = host.paths(CTX[platform]).filter(Boolean);
      assert.ok(list.length >= 1, `${host.id}@${platform} 一条路径都算不出来`);
      for (const p of list) {
        const where = `${host.id}@${platform}`;

        // 占位符必须展开干净
        assert.ok(!p.includes('~'), `${where} 的路径里还留着未展开的 ~：${p}`);
        assert.ok(!/\$\{|\$[A-Z_]+/.test(p), `${where} 的路径里还留着未展开的环境变量：${p}`);
        // 分隔符不能叠
        assert.ok(!/\/{2,}|\\\\/.test(p), `${where} 出现重复分隔符：${p}`);
        // 最后一段必须是文件名（带扩展名），不能以目录结尾
        const tail = p.split(/[\\/]/).filter(Boolean).pop() || '';
        assert.match(tail, /\.[a-z0-9]+$/i, `${where} 的最后一段不像配置文件名：${p}`);

        if (platform === 'win32') {
          assert.ok(winPath.isAbsolute(p), `${where} 在 Windows 上不是绝对路径：${p}`);
          assert.match(p, /^[A-Za-z]:\\/, `${where} 没有盘符：${p}`);
          assert.ok(!p.includes('/'), `${where} 在 Windows 上混进了正斜杠：${p}`);
        } else {
          assert.ok(posixPath.isAbsolute(p), `${where} 在 ${platform} 上不是绝对路径：${p}`);
          assert.ok(p.startsWith('/'), `${where} 在 ${platform} 上不是 / 开头：${p}`);
          assert.ok(!p.includes('\\'), `${where} 在 ${platform} 上出现反斜杠：${p}`);
          assert.ok(!/AppData/i.test(p), `${where} 在 ${platform} 上出现 Windows 的 AppData：${p}`);
          assert.ok(!/^\/Users\/you\/AppData/.test(p), `${where} 把 Windows 的家目录结构搬到了 ${platform}：${p}`);
        }
        if (platform === 'darwin') {
          assert.ok(!p.startsWith('/home/'), `${where} 在 macOS 上用 Linux 的 /home：${p}`);
          assert.ok(!p.includes('Library/Application Support') || p.startsWith('/Users/'), `${where} 的 Application Support 不在家目录下：${p}`);
        }
        if (platform === 'linux') {
          assert.ok(!p.startsWith('/Users/'), `${where} 在 Linux 上用 macOS 的 /Users：${p}`);
          assert.ok(!p.includes('Library/Application Support'), `${where} 在 Linux 上出现 macOS 的目录：${p}`);
        }
      }
    }
  }
});

test('同一宿主在三个系统上不能落到同一个路径（目录习惯必然不同）', () => {
  for (const host of HOSTS) {
    const w = host.paths(CTX.win32)[0];
    const d = host.paths(CTX.darwin)[0];
    const l = host.paths(CTX.linux)[0];
    assert.notEqual(w, d, `${host.id}：Windows 与 macOS 落点相同`);
    assert.notEqual(d, l, `${host.id}：macOS 与 Linux 落点相同`);
    assert.notEqual(w, l, `${host.id}：Windows 与 Linux 落点相同`);
  }
});

test('契约表自身不许腐烂：每一条都必须真的在 HOSTS 里、每个系统都有期望值', () => {
  for (const [id, spec] of Object.entries(CONTRACT)) {
    assert.ok(HOSTS.some((h) => h.id === id), `契约里的 ${id} 不存在`);
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.ok(spec[platform], `契约 ${id} 缺 ${platform} 的期望值`);
    }
  }
});

test('ctx 注入只改「配置文件放哪」，不改「用哪个 node 启动」', async () => {
  const { launchCommand } = await import('../lib/connect/hosts.js');
  // launchCommand 永远按当前机器算：配置最终是给这台机器上的宿主用的，
  // 拿目标系统的 node 路径写进去，装完就是一条死路。
  const launch = launchCommand();
  assert.ok(launch.command, 'launchCommand 没给出命令');
  assert.ok(!launch.command.includes('/Users/you'), 'launchCommand 用了伪家目录');
  assert.ok(!launch.command.includes('C:\\Users\\you'), 'launchCommand 用了伪家目录');
});
