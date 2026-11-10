/**
 * tests/one-package.test.mjs —— 「一个包，不分系统」的机器验收。
 *
 * 用户的原话：插件是配合通用 Agent 用的，不该分电脑系统。
 * 这句话的正确理解不是「路径不用管」，而是：
 *
 *   ① 分发的产物只有**一份**：同一个 tarball 装在 Windows / macOS / Linux 上，
 *      npm 不会因为 `os` 字段拒绝任何平台，里面没有一个平台专属二进制；
 *   ② 安装的动作只有**一条**：没有 install-win.ps1 / install-mac.sh 这种东西；
 *   ③ 功能不分岔：同样的命令、同样的工具集、同样的配置结构，只有「路径字符串的值」
 *      因为宿主自己把文件放在不同地方而不同 —— 那是宿主的目录习惯，不是我们的分支。
 *
 * 前两条靠静态扫描守，第三条靠「平台分支白名单」守：
 * 只有白名单里的文件允许出现 process.platform，且每处都是「跟操作系统打交道」
 * （PATH 分隔符、可执行文件扩展名、shell 垫片、默认安装目录）。
 * 将来谁往业务逻辑里塞一句 `if (win32)`，这个测试立刻变红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOSTS, buildSnippet, launchCommand, shapeKeys, shapeKeyOf } from '../lib/connect/hosts.js';
import { platformCtx, pjoin } from '../lib/connect/platform.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * 允许出现 process.platform 的文件，以及**为什么**。
 * 加新文件必须在这里写理由 —— 这是强制的自证环节，不是备忘。
 */
const PLATFORM_BRANCH_ALLOWLIST = {
  'lib/connect/platform.js': '三系统路径拼接的唯一落点（path.win32 / path.posix 切表）',
  'lib/connect/hosts.js': 'PATH 分隔符、PATHEXT、shell 垫片 —— 都是跟操作系统打交道',
  'lib/connect/verify.js': 'Windows 上宿主 CLI 是 .cmd 垫片，过 shell 才能调',
  'lib/engine/cli.js': '本机 CLI 的候选目录（npm -g 落点各系统不同）',
  'lib/engine/toolbelt.js': '工具能力探测要报告宿主平台给模型',
  'lib/installer.js': '安装根目录的默认值（LOCALAPPDATA / Application Support / XDG）',
  'lib/tools/super.js': '把平台名写进系统提示，让模型知道自己在什么环境',
  'lib/diagnostics.js': '诊断包要如实报告宿主平台与架构（排障第一手信息）',
  'lib/connect/audit.js': '路径比较要按系统处理大小写（Windows 不区分）',
  'bin/nexi.mjs': 'where 要跨系统预览三种落点、doctor 要报告机器信息',
};

/** 递归列出某目录下的 .js / .mjs 源码（不碰 node_modules）。 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

function rel(full) {
  return path.relative(ROOT, full).split(path.sep).join('/');
}

test('分发产物一份：package.json 不限定 os / cpu，npm 不会拒绝任何平台', () => {
  assert.equal(pkg.os, undefined, 'package.json 出现 os 字段 = 这个包开始分系统了');
  assert.equal(pkg.cpu, undefined, 'package.json 出现 cpu 字段 = 开始分架构了');
  assert.equal(pkg.optionalDependencies, undefined, 'optionalDependencies 里通常藏着平台专属预编译包');
  // 零依赖是硬事实，也是「同一个包三系统都能跑」最硬的证据
  assert.equal(pkg.dependencies, undefined, '出现 dependencies 就可能引入原生模块');
  assert.ok(pkg.type === 'module');
  assert.ok(pkg.bin && pkg.bin.nexi, 'bin 里必须有 nexi');
});

test('包里没有任何原生二进制与平台安装器', () => {
  const all = walk(ROOT).concat(
    readdirSync(ROOT).filter((n) => /\.(exe|dll|dylib|so|msi|dmg|pkg|deb|rpm|AppImage)$/i.test(n)).map((n) => path.join(ROOT, n)),
  );
  const native = all.filter((f) => /\.(node|exe|dll|dylib|\.so|msi|dmg|pkg|deb|rpm|AppImage)$/i.test(f));
  assert.deepEqual(native.map(rel), [], `包里有平台专属文件：${native.map(rel).join(', ')}`);

  // 安装入口只允许是 node 脚本；出现 .ps1/.bat/.sh 安装器就是「分系统安装」回潮
  const installers = readdirSync(ROOT).filter((n) => /^install.*\.(ps1|bat|cmd|sh|bash|zsh)$/i.test(n));
  assert.deepEqual(installers, [], `出现了平台专属安装脚本：${installers.join(', ')}`);
});

test('平台分支只在白名单里，且白名单不许腐烂', () => {
  const hit = [];
  for (const file of walk(path.join(ROOT, 'lib')).concat(walk(path.join(ROOT, 'bin')))) {
    const src = readFileSync(file, 'utf8');
    // 只看代码，不看注释 —— 注释里提到 win32 不算分支
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');
    if (/process\.platform|['"]win32['"]|['"]darwin['"]/.test(code)) hit.push(rel(file));
  }
  const unknown = hit.filter((f) => !PLATFORM_BRANCH_ALLOWLIST[f]);
  assert.deepEqual(unknown, [], `这些文件不该有平台分支（业务逻辑必须与系统无关）：${unknown.join(', ')}`);

  // 反向：白名单里的文件必须真的还有分支，否则白名单本身在骗人
  for (const f of Object.keys(PLATFORM_BRANCH_ALLOWLIST)) {
    assert.ok(existsSync(path.join(ROOT, f)), `白名单里的 ${f} 已经不存在了，删掉这一项`);
    assert.ok(hit.includes(f), `白名单里的 ${f} 已经没有平台分支了，删掉这一项`);
  }
});

test('配置结构不分系统：三种上下文生成的键名与层级完全同构', () => {
  const ctxs = {
    win32: platformCtx({ platform: 'win32', home: 'C:\\Users\\you', env: { APPDATA: 'C:\\Users\\you\\AppData\\Roaming' } }),
    darwin: platformCtx({ platform: 'darwin', home: '/Users/you', env: {} }),
    linux: platformCtx({ platform: 'linux', home: '/home/you', env: {} }),
  };

  /** 把字符串值抹成 <str>，只留结构（键集合 / 嵌套 / 数组长度）。 */
  function skeleton(v) {
    if (Array.isArray(v)) return v.map(skeleton);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, skeleton(v[k])]));
    }
    if (typeof v === 'string') return '<str>';
    return v;
  }

  /** YAML 不能用 JSON 解析：把值抹掉，只留「缩进 + 键 + 行序」。 */
  function yamlSkeleton(text) {
    return text
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l && !l.trimStart().startsWith('#'))
      .map((l) => {
        const indent = l.length - l.trimStart().length;
        const body = l.trimStart().replace(/^-\s*/, '- ');
        // 值（引号串 / 裸标量 / 数字）一律抹成 <v>，键保留
        const key = body.replace(/:\s*.*$/, ':');
        return `${indent}|${key}`;
      })
      .join('\n');
  }

  for (const shape of shapeKeys()) {
    const skels = {};
    const isYaml = shape.startsWith('yaml.');
    for (const [name, ctx] of Object.entries(ctxs)) {
      const launch = launchCommand({ ctx });
      const text = buildSnippet({ shape, launch });
      assert.ok(text, `${name} 下 ${shape} 生成失败`);
      skels[name] = isYaml ? yamlSkeleton(text) : skeleton(JSON.parse(text));
    }
    assert.deepEqual(skels.win32, skels.darwin, `${shape}：Windows 与 macOS 的配置结构不一致`);
    assert.deepEqual(skels.darwin, skels.linux, `${shape}：macOS 与 Linux 的配置结构不一致`);
  }
});

test('工具集不分系统：MCP 服务端源码里没有任何平台判断', () => {
  const mcpDir = path.join(ROOT, 'lib', 'mcp');
  const offenders = walk(mcpDir).filter((f) => {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return /process\.platform/.test(code);
  });
  assert.deepEqual(offenders.map(rel), [], `MCP 服务端按系统分岔了：${offenders.map(rel).join(', ')}`);
});

test('每个内置宿主的配置落在哪，三系统都算得出来且互不相同', () => {
  const ctx = {
    win32: platformCtx({ platform: 'win32', home: 'C:\\Users\\you', env: { APPDATA: 'C:\\Users\\you\\AppData\\Roaming' } }),
    darwin: platformCtx({ platform: 'darwin', home: '/Users/you', env: {} }),
    linux: platformCtx({ platform: 'linux', home: '/home/you', env: { XDG_CONFIG_HOME: '' } }),
  };
  for (const host of HOSTS) {
    const paths = {};
    for (const [name, c] of Object.entries(ctx)) {
      const list = host.paths(c).filter(Boolean);
      assert.ok(list.length >= 1, `${host.id} 在 ${name} 上算不出路径`);
      for (const p of list) {
        assert.ok(path.isAbsolute(p), `${host.id}@${name} 算出的不是绝对路径：${p}`);
        if (name !== 'win32') {
          assert.ok(!p.includes('AppData'), `${host.id}@${name} 出现了 AppData：${p}`);
          assert.ok(!p.includes('\\'), `${host.id}@${name} 出现了反斜杠：${p}`);
        }
      }
      paths[name] = list[0];
    }
    assert.notEqual(paths.win32, paths.darwin, `${host.id} 在 Windows 与 macOS 上落到同一个绝对路径（不可能）`);
    assert.notEqual(paths.darwin, paths.linux, `${host.id} 在 macOS 与 Linux 上落到同一个绝对路径（不可能）`);
  }
});

test('安装动作只有一条：nexi setup，没有按系统分家的入口', () => {
  const help = readFileSync(path.join(ROOT, 'bin', 'nexi.mjs'), 'utf8');
  // 帮助里不许出现「请下载 Windows 版」这类分流话术
  assert.ok(!/下载.*(Windows|macOS|Linux).*版/.test(help), '帮助文本在按系统分流');
  // setup 的签名里不许有平台参数
  assert.ok(!/setup\s+--(win|mac|linux)/.test(help), 'setup 出现了平台参数');
  // 包名与仓库地址里不许带平台后缀
  assert.ok(!/-(win|win32|darwin|linux|macos)$/i.test(pkg.name), '包名带平台后缀');
});
