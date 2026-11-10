// SPDX-License-Identifier: Apache-2.0
// 8 个宿主的适配定义，按 LICENSING.md 用 Apache-2.0：宿主厂商零成本接进来。
/**
 * 宿主接入（Nexi Connect）：探测 8 个常见 Agent 宿主，把 `nexi mcp` 注册进去。
 *
 * 硬要求（写进 docs/NEXI-FINAL-PLAN.md 第 5 节）：
 *   - 先探测再动手，没装就报告"未安装"，绝不新建一个假配置骗自己。
 *   - 动手前先备份（*.nexi-backup-<时间戳>），合并而不是覆盖用户已有的 mcpServers。
 *   - 幂等：重复安装只更新自己那一项；卸载精确回滚，不留垃圾。
 *   - --dry-run 只打印差异，不落盘。
 *
 * 配置格式分两类：
 *   json  —— { "mcpServers": { "nexi": { command, args, env } } }
 *   toml  —— Codex 的 config.toml，用带哨兵注释的块写入（[mcp_servers.nexi]）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { platformCtx, pjoin, configRoot, dotConfigRoot, xdgRoot, homePath, isWindows } from './platform.js';
import { withCustomHosts } from './registry.js';
import { planYaml, planYamlRemove, yamlStr, yamlFlowArray, YAML_EMPTY_MAP } from './yaml.js';
import { withFileLock } from './lock.js';
import { backupFile, pruneBackups, DEFAULT_KEEP, listBackups, restoreBackup } from './backup.js';
import { readConfigText, toEol } from './encoding.js';
import { hasJsonc, parseJsonc } from './jsonc.js';
import { translateWriteError } from './errors.js';
import { spawnTool, unsafeArgsReason } from './exec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（lib/connect → ../..） */
export const REPO_ROOT = resolve(HERE, '..', '..');
export const NEXI_ENTRY = join(REPO_ROOT, 'bin', 'nexi.mjs');

const SENTINEL_START = '# >>> nexi (managed by nexi install, 删这段即完全移除) >>>';
const SENTINEL_END = '# <<< nexi <<<';

function envPath(name, fallback) {
  const v = process.env[name];
  return v ? v : fallback;
}

/**
 * VS Code 家族的用户配置目录。三个系统各一套根，但目录名相同：
 *   Windows %APPDATA%\Code\User
 *   macOS   ~/Library/Application Support/Code/User
 *   Linux   ~/.config/Code/User
 * 顺带把 Insiders / VSCodium 也列上 —— 它们是同一个格式，只是目录名不同。
 */
function vscodeUserDirs(ctx) {
  const root = configRoot(ctx);
  return ['Code', 'Code - Insiders', 'VSCodium'].map((name) => pjoin(ctx, root, name, 'User'));
}

/**
 * 宿主清单。paths() 返回该宿主可能存在的候选路径（多版本/多厂商时都给）。
 * tier：A = MCP stdio 正式支持；B = 需要 HTTP；exp = 实验性（格式还没稳定）。
 *
 * confidence —— 「这条路径、这个形状，我们凭什么信它」。三档，缺省是 docs：
 *   verified  本机真装过：跑过 install、看过写进去的字节、跑过 uninstall 且卸干净
 *   docs      照官方文档 / 官方仓库核对过，但没在真宿主上装过
 *   community 没有官方文档，按社区通行布局推的（最容易过时）
 * 这一档会原样出现在 `nexi host list` 和 docs/接入的Agent清单.md 里 ——
 * 用户有权知道自己信的是哪一档。**不要为了让表格好看就往上标**：
 * 标 verified 的唯一凭据是本机配置目录里能查到痕迹（nexi 备份，或配置里还在的 nexi 条目）。
 */
const BUILTIN_HOSTS = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    tier: 'A',
    kind: 'json',
    // 本机装过多次（配置目录里留着 nexi 备份），写入结果逐字看过。
    confidence: 'verified',
    docs: 'https://modelcontextprotocol.io/',
    paths: (ctx = platformCtx()) => [
      pjoin(ctx, configRoot(ctx), 'Claude', 'claude_desktop_config.json'),
    ],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    tier: 'A',
    kind: 'json',
    cli: 'claude',
    // Claude Code 的 mcp add 默认是 local scope（只对当前目录生效）。
    // 不指定 user 的话，用户换个项目就发现"工具没了"，所以这里显式要 user 级。
    cliAddExtra: ['--scope', 'user'],
    // 本机装过多次；连 `--scope user` 这个坑都是在本机撞出来的。
    confidence: 'verified',
    docs: 'https://docs.anthropic.com/en/docs/claude-code/mcp',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.claude.json')],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    tier: 'A',
    kind: 'json',
    docs: 'https://docs.cursor.com/context/model-context-protocol',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.cursor', 'mcp.json')],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    tier: 'A',
    kind: 'json',
    docs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.codeium', 'windsurf', 'mcp_config.json')],
  },
  {
    id: 'codex',
    label: 'Codex',
    tier: 'A',
    kind: 'toml',
    cli: 'codex',
    // Codex 的 add 语法是 `codex mcp add <name> -- <command> [args...]`，
    // 比 claude/gemini/qwen 的 `<name> <command> [args...]` 多一个 `--`。
    argStyle: 'dashDash',
    // 本机装过多次。这家的两个 bug 都是真机撞出来的：`codex mcp add` 会重排
    // config.toml 丢掉哨兵（装得进去卸不出来），以及本机 config.toml 里出现过半截哨兵。
    confidence: 'verified',
    docs: 'https://github.com/openai/codex#model-context-protocol-mcp',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.codex', 'config.toml')],
  },
  {
    id: 'cline',
    label: 'Cline (VS Code)',
    tier: 'A',
    kind: 'json',
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    paths: (ctx = platformCtx()) => vscodeUserDirs(ctx).map((d) =>
      pjoin(ctx, d, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')),
  },
  {
    id: 'continue',
    label: 'Continue',
    tier: 'A',
    // Continue 两代格式都在用：老版 ~/.continue/config.json（mcpServers 对象），
    // 新版 ~/.continue/config.yaml（mcpServers **列表**，每项带 name）。
    // 用 auto 按目标文件扩展名选写入器 —— 装在哪个文件就按那个文件的语法写。
    kind: 'auto',
    shape: 'mcpServers',
    shapes: { yaml: 'yaml.mcpServers', json: 'mcpServers' },
    docs: 'https://docs.continue.dev/customize/deep-dives/mcp',
    // yaml 在前：新版 Continue 只认 config.yaml，老 json 只作为已存在时的落点。
    paths: (ctx = platformCtx()) => [
      homePath(ctx, '.continue', 'config.yaml'),
      homePath(ctx, '.continue', 'config.json'),
    ],
  },
  {
    id: 'goose',
    label: 'Goose',
    tier: 'A',
    kind: 'yaml',
    shape: 'yaml.extensions',
    docs: 'https://goose-docs.ai/docs/guides/config-file',
    // 三系统路径不一样，且 **Windows 多一层 config 目录**（官方文档原文）：
    //   macOS/Linux  ~/.config/goose/config.yaml
    //   Windows      %APPDATA%\Block\goose\config\config.yaml
    // extensions.<id> 的字段是 type/name/cmd/args/envs/timeout —— 注意 envs，不是 env。
    paths: (ctx = platformCtx()) => [
      isWindows(ctx)
        ? pjoin(ctx, configRoot(ctx), 'Block', 'goose', 'config', 'config.yaml')
        : pjoin(ctx, xdgRoot(ctx), 'goose', 'config.yaml'),
    ],
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    tier: 'A',
    kind: 'json',
    cli: 'gemini',
    // gemini 的 add 默认 scope 是 project —— 会写进当前目录的 settings.json，
    // 而且碰到"工作区未被信任"的安全策略会直接失败（实测踩到）。
    // 显式要 user：写全局配置，一次装完所有项目都能用。
    cliAddExtra: ['--scope', 'user'],
    // 本机装过。下面「工作区未被信任直接失败」那条就是实测撞到的，不是文档写的。
    confidence: 'verified',
    docs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.gemini', 'settings.json')],
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    tier: 'A',
    kind: 'json',
    cli: 'qwen',
    docs: 'https://github.com/QwenLM/qwen-code',
    // Qwen Code 是 Gemini CLI 的分叉，配置布局与一份 settings.json 完全一致。
    // 它的 add 默认已是 user scope，这里仍显式写出来 —— 别依赖不同版本默认值。
    cliAddExtra: ['--scope', 'user'],
    // 本机装过（走 CLI 路径，所以目录里没有 nexi 备份，但 settings.json 里的 nexi 条目还在）。
    confidence: 'verified',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.qwen', 'settings.json')],
  },
  {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    tier: 'A',
    kind: 'json',
    cli: 'copilot',
    // 注意：这是 Copilot 的 **portable** 配置（顶层 mcpServers）。
    // VS Code 自己的 `.vscode/mcp.json` 用 `servers`，那是另一种形状，见 vscode 条目。
    // 本机装过（同样走 CLI 路径，无 nexi 备份，但 mcp-config.json 里的 nexi 条目还在）。
    confidence: 'verified',
    docs: 'https://docs.github.com/copilot/how-tos/use-copilot-agents/use-mcp',
    paths: (ctx = platformCtx()) => [
      pjoin(ctx, ctx.env.COPILOT_HOME || homePath(ctx, '.copilot'), 'mcp-config.json'),
    ],
  },
  {
    id: 'zed',
    label: 'Zed',
    tier: 'A',
    kind: 'json',
    shape: 'context_servers',
    docs: 'https://zed.dev/docs/ai/mcp',
    // Zed 用 `context_servers` 这个 key，但 entry 形状与 mcpServers 相同（扁平 command/args/env）。
    // Zed 是唯一一个三系统都读 ~/.config 的：macOS 也不用 Application Support。
    // 只有 Windows 的目录名是首字母大写的 Zed（在 %APPDATA% 下），别统一大小写。
    paths: (ctx = platformCtx()) => [
      pjoin(ctx, dotConfigRoot(ctx), ctx.platform === 'win32' ? 'Zed' : 'zed', 'settings.json'),
    ],
  },
  {
    id: 'vscode',
    label: 'VS Code (mcp.json)',
    tier: 'A',
    kind: 'json',
    shape: 'servers',
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    // VS Code 自己的格式是 `servers`（与 portable 的 `mcpServers` 不同，不能混）。
    paths: (ctx = platformCtx()) => vscodeUserDirs(ctx).map((d) => pjoin(ctx, d, 'mcp.json')),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    tier: 'A',
    kind: 'json',
    shape: 'mcp.servers',
    docs: 'https://opencode.ai/docs/mcp-servers/',
    // OpenCode V2 要求 `mcp.servers.<name>`；V1 是 `mcp.<name>`。
    // 这里按当前官方文档写 V2 布局；探测到 V1 时会在 warnings 里提示。
    // OpenCode 三系统都读 ~/.config（Windows 也是），所以用 xdgRoot 而不是 dotConfigRoot。
    paths: (ctx = platformCtx()) => [
      pjoin(ctx, xdgRoot(ctx), 'opencode', 'opencode.json'),
      pjoin(ctx, xdgRoot(ctx), 'opencode', 'config.json'),
    ],
  },
  // —— 以下为 VS Code 系插件 / 独立客户端，形状已按各自文档核过 ——
  {
    id: 'roo-code',
    label: 'Roo Code (VS Code)',
    tier: 'A',
    kind: 'json',
    docs: 'https://docs.roocode.com/features/mcp/using-mcp-in-roo',
    // Roo 是 Cline 的分叉：新版叫 mcp_settings.json，老版沿用了 cline_mcp_settings.json，
    // 两个都留着，谁在就用谁。
    paths: (ctx = platformCtx()) => vscodeUserDirs(ctx).flatMap((d) => [
      pjoin(ctx, d, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
      pjoin(ctx, d, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json'),
    ]),
  },
  {
    id: 'kilocode',
    label: 'Kilo Code (VS Code)',
    tier: 'A',
    kind: 'json',
    docs: 'https://kilo.ai/docs/automate/mcp/using-in-kilo-code',
    paths: (ctx = platformCtx()) => vscodeUserDirs(ctx).flatMap((d) => [
      pjoin(ctx, d, 'globalStorage', 'kilocode.kilo-code', 'settings', 'mcp_settings.json'),
      pjoin(ctx, d, 'globalStorage', 'kilocode.kilo-code', 'settings', 'cline_mcp_settings.json'),
    ]),
  },
  {
    id: 'kilo-cli',
    label: 'Kilo CLI',
    tier: 'A',
    kind: 'json',
    shape: 'mcp.local',
    docs: 'https://kilo.ai/docs/automate/mcp/using-in-kilo-code',
    paths: (ctx = platformCtx()) => [pjoin(ctx, xdgRoot(ctx), 'kilo', 'kilo.json')],
  },
  {
    id: 'kiro',
    label: 'Kiro',
    tier: 'A',
    kind: 'json',
    docs: 'https://kiro.dev/docs/mcp/',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.kiro', 'settings', 'mcp.json')],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    tier: 'A',
    kind: 'json',
    docs: 'https://lmstudio.ai/docs/app/mcp',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.lmstudio', 'mcp.json')],
  },
  {
    id: 'factory',
    label: 'Factory Droid',
    tier: 'A',
    kind: 'json',
    docs: 'https://docs.factory.ai/',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.factory', 'mcp.json')],
  },
  {
    id: 'junie',
    label: 'JetBrains Junie',
    tier: 'A',
    kind: 'json',
    docs: 'https://www.jetbrains.com/help/junie/',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.junie', 'mcp', 'mcp.json')],
  },
  {
    id: 'qoder',
    label: 'Qoder',
    tier: 'A',
    kind: 'json',
    docs: 'https://qoder.com/',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.qoder', 'settings.json')],
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    tier: 'A',
    kind: 'json',
    docs: 'https://antigravity.google/docs',
    // Antigravity 用 Gemini 的全局目录：~/.gemini/config/mcp_config.json
    paths: (ctx = platformCtx()) => [homePath(ctx, '.gemini', 'config', 'mcp_config.json')],
  },
  {
    id: 'amazon-q',
    label: 'Amazon Q Developer',
    tier: 'A',
    kind: 'json',
    docs: 'https://docs.aws.amazon.com/amazonq/',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.aws', 'amazonq', 'mcp.json')],
  },
  {
    id: 'amp',
    label: 'Amp',
    tier: 'A',
    kind: 'json',
    shape: 'amp.mcpServers',
    docs: 'https://ampcode.com/manual#mcp',
    paths: (ctx = platformCtx()) => [
      pjoin(ctx, dotConfigRoot(ctx), 'amp', 'settings.json'),
      homePath(ctx, '.amp', 'settings.json'),
    ],
  },
  {
    id: 'crush',
    label: 'Crush',
    tier: 'A',
    kind: 'json',
    shape: 'mcp.stdio',
    docs: 'https://github.com/charmbracelet/crush',
    paths: (ctx = platformCtx()) => [pjoin(ctx, xdgRoot(ctx), 'crush', 'crush.json')],
  },
  {
    id: 'codebuddy',
    label: '腾讯 CodeBuddy',
    tier: 'A',
    kind: 'json',
    docs: 'https://www.codebuddy.cn/docs/cli/mcp',
    // CodeBuddy 的读取优先级是 .mcp.json > mcp.json > .codebuddy.json（官方文档写明），
    // 写入规则是「哪个存在就写哪个，都不存在才新建 .mcp.json」——
    // 这正好就是 paths 数组的顺序语义：detectHosts 取第一个存在的，兜底取第一个。
    paths: (ctx = platformCtx()) => {
      const env = ctx.env.CODEBUDDY_CONFIG_DIR;
      const abs = env && (isWindows(ctx) ? /^[A-Za-z]:[\\/]/.test(env) : env.startsWith('/'));
      const root = abs ? env : homePath(ctx, '.codebuddy');
      return [
        pjoin(ctx, root, '.mcp.json'),
        pjoin(ctx, root, 'mcp.json'),
        homePath(ctx, '.codebuddy.json'),
      ];
    },
  },
  {
    id: 'trae',
    label: 'Trae',
    tier: 'A',
    kind: 'json',
    docs: 'https://forum.trae.cn/t/topic/65',
    // Trae 是 VS Code 系，但 MCP 配置不在 globalStorage 的扩展目录里，
    // 而是 User/mcp.json；较新版本另有一份放在 User/globalStorage/mcp.json。
    // 两处都给，谁存在写谁 —— 比赌一个路径强。
    paths: (ctx = platformCtx()) => [
      pjoin(ctx, configRoot(ctx), 'Trae', 'User', 'mcp.json'),
      pjoin(ctx, configRoot(ctx), 'Trae', 'User', 'globalStorage', 'mcp.json'),
    ],
  },
  {
    id: 'iflow',
    label: 'iFlow CLI',
    tier: 'A',
    kind: 'json',
    confidence: 'community',
    docs: 'https://github.com/iflow-ai/iflow-cli',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.iflow', 'settings.json')],
  },
  {
    id: 'lingma',
    label: '通义灵码',
    tier: 'A',
    kind: 'json',
    confidence: 'community',
    docs: 'https://help.aliyun.com/zh/lingma/',
    paths: (ctx = platformCtx()) => [homePath(ctx, '.lingma', 'mcp.json')],
  },
];

/**
 * 最终宿主表 = 内置 + 用户注册表（$DSH_HOME/agentdeck-super/hosts.d/*.json）。
 * 自定义优先：同名 id 覆盖内置，方便用户抢先修一个我们还没跟上的路径。
 * 注册表坏了不影响启动 —— problems 只影响 `nexi host list` 的提示，不让整表崩。
 */
const CUSTOM = (() => {
  try {
    return withCustomHosts([]);
  } catch (err) {
    return { hosts: [], problems: [{ file: '(registry)', error: err.message }], custom: [] };
  }
})();

export const HOSTS = [...CUSTOM.hosts, ...BUILTIN_HOSTS];
export const HOST_REGISTRY_PROBLEMS = CUSTOM.problems;
export { BUILTIN_HOSTS };

export function findHost(id) {
  return HOSTS.find((h) => h.id === id) || null;
}

/**
 * 宿主 CLI 的常见落点（只用来判断"这台机器装没装这个宿主"）。
 *
 * 为什么需要它：有些宿主（比如 Gemini CLI）配置文件是**第一次用才创建**的，
 * 但 CLI 明明已经在 PATH 上。只按"配置文件存不存在"判断，会把装好的宿主
 * 误报成「未安装」——那等于自己少认证一个宿主，还很难被发现。
 *
 * 判断规则（保守，宁可不报）：配置文件在 **或者** CLI 能起来 → 算装了。
 * 真调用那一步仍然由 verify.js 的 probe 去问宿主自己，这里只负责"该不该去问"。
 */
const CLI_CANDIDATES = {
  'claude-code': ['claude'],
  codex: ['codex'],
  'gemini-cli': ['gemini'],
  'qwen-code': ['qwen'],
  'copilot-cli': ['copilot'],
  opencode: ['opencode'],
};

/** 在 PATH 上找可执行文件（Windows 还要看 .cmd/.exe/.ps1 垫片）。 */
/**
 * PATH 查找的缓存。
 *
 * 为什么必须有：detectHosts 对**每个**没装配置的宿主都要问一句"它的 CLI 在不在"，
 * 一次 detectHosts 就是 1 万多次 stat（PATH 目录 × PATHEXT × 名字），实测 44ms。
 * 装 30 家、跑一次 config --all，这个成本乘 30 倍就变成秒级卡顿 —— 用户感受是"命令很肉"。
 *
 * 缓存键带上 PATH 本身：PATH 变了就重算，不会拿旧结果骗人。
 * 代价是"同进程内新建了一个 CLI 文件"这种场景看不到 —— 那是测试才会干的事，
 * 而且已经有 clearPathCache() 可以显式清。
 */
const PATH_CACHE = new Map();
const PATH_CACHE_MAX = 512;

/** 清掉 PATH 缓存（测试/长驻进程里环境变了时用）。 */
export function clearPathCache() {
  PATH_CACHE.clear();
}

export function findOnPath(names = []) {
  const pathStr = process.env.PATH || '';
  const key = `${process.platform}\u0000${pathStr}\u0000${names.join('\u0000')}`;
  if (PATH_CACHE.has(key)) return PATH_CACHE.get(key);

  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((s) => s.toLowerCase())
    : [''];
  const dirs = String(pathStr).split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  let found = null;
  outer:
  for (const dir of dirs) {
    for (const name of names) {
      // Windows 先看带扩展名的真实可执行文件（npx.cmd / cloudflared.exe），
      // 再退回无扩展名垫片。反过来的话会返回 `...\nodejs\npx` 这种
      // 无扩展名文件，cmd.exe 不一定能执行，隧道就会“启动即退出”。
      const bare = join(dir, name);
      if (process.platform !== 'win32' && existsSync(bare)) { found = bare; break outer; }
      for (const ext of exts) {
        if (!ext) continue;
        const withExt = join(dir, `${name}${ext}`);
        if (existsSync(withExt)) { found = withExt; break outer; }
      }
      if (process.platform === 'win32' && existsSync(bare)) { found = bare; break outer; }
    }
  }

  if (PATH_CACHE.size >= PATH_CACHE_MAX) PATH_CACHE.clear();
  PATH_CACHE.set(key, found);
  return found;
}

/**
 * 在 PATH 上找出**所有**同名可执行文件（按 PATH 顺序），不做去重、不提前 return。
 *
 * 为什么需要：写进宿主配置的可执行文件必须"活得久"。PATH 上排第一的 node
 * 常常是某个 IDE 自带的私有 node（版本号写进目录名，宿主一升级就没了）。
 * 只看第一个会选到最不稳的那个；要看全部才能按稳定性挑。
 */
export function findAllOnPath(names = []) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((s) => s.toLowerCase())
    : [''];
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const found = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const name of names) {
      let hit = null;
      const bare = join(dir, name);
      if (process.platform !== 'win32') {
        if (existsSync(bare)) hit = bare;
      } else {
        for (const ext of exts) {
          if (!ext) continue;
          const withExt = join(dir, `${name}${ext}`);
          if (existsSync(withExt)) { hit = withExt; break; }
        }
        if (!hit && existsSync(bare)) hit = bare;
      }
      if (hit && !seen.has(hit)) { seen.add(hit); found.push(hit); }
    }
  }
  return found;
}

/** 探测：只报事实（配置文件在不在 / CLI 在不在），**不创建任何文件**。
 *  ctx 只给测试注入（在这台 Windows 上核对 darwin / linux 的候选路径），正常调用不传。 */
export function detectHosts(ctx = platformCtx()) {
  return HOSTS.map((h) => {
    const candidates = h.paths(ctx);
    const hit = candidates.find((p) => existsSync(p)) || null;
    // 配置文件不在时，再看看 CLI 在不在（装好但还没首次运行的宿主）
    const cli = hit ? null : findOnPath(CLI_CANDIDATES[h.id] || []);
    const installed = Boolean(hit || cli);
    return {
      id: h.id,
      label: h.label,
      tier: h.tier,
      kind: kindFor(h, hit || candidates[0]),
      installed,
      path: hit || candidates[0],
      candidates,
      // 给人看的依据：是"配置文件在"还是"只找到 CLI"。别把两者混为一谈。
      detectedBy: hit ? 'config' : (cli ? 'cli' : 'none'),
      cliPath: cli || null,
      configExists: Boolean(hit),
    };
  });
}

/**
 * 给一个 node 路径打分：分越高越"活得久"，越适合写进宿主配置。
 *
 * 背后的真实教训（实测踩到）：
 *   PATH 上排第一的 node 是 `%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`
 *   —— 某个 IDE 的**私有 node**，目录名里带版本号。宿主配置写死它以后，
 *   IDE 一升级（22.22.2-6 → 22.22.3-1），旧目录被删，所有宿主静默起不来。
 *   而机器上其实还装着一个系统级 node（`C:\Users\<u>\Apps\nodejs\node.exe`），它才稳。
 *
 * 这段逻辑放在 hosts.js（底层）而不是 installer.js，是为了让
 * `launchCommand()`（nexi install / doctor 走这条）和 `stableLaunch()`
 * （nexi setup 走这条）共用同一套判断，不会两处各写一份、慢慢分叉。
 */
export function scoreNode(p) {
  const s = String(p).toLowerCase();
  let score = 0;
  // 私有/容器型的 node：目录里带 versions/<semver>，几乎必然随宿主升级消失
  if (/[\\/]versions?[\\/]\d+\.\d+\.\d+/.test(s)) score -= 100;
  if (/[\\/]binaries[\\/]/.test(s)) score -= 60;
  if (/[\\/]\.workbuddy[\\/]/.test(s)) score -= 60;
  if (/[\\/](node_modules|\.cache|\.pnpm|\.nvm|nvs|fnm|volta)[\\/]/.test(s)) score -= 40;
  // 常见的系统级安装点：加分
  if (/[\\/]program files[\\/]nodejs[\\/]/.test(s)) score += 40;
  if (/[\\/]apps[\\/]nodejs[\\/]/.test(s)) score += 30;
  if (/[\\/]nodejs[\\/]node(\.exe)?$/.test(s)) score += 30;
  if (/[\\/](usr|opt)[\\/].*node/.test(s)) score += 10;
  // 完全不在 PATH 上的临时路径（例如 %TEMP%）最不可靠
  if (/[\\/](temp|tmp)[\\/]/.test(s)) score -= 80;
  // 同分时，路径更短的更可能是正式安装点
  score -= s.length / 1000;
  return score;
}

/**
 * 解析「写进宿主配置的 node 可执行文件」。
 *
 * 策略（从稳到不稳）：
 *   ① NEXI_NODE 环境变量 —— 用户显式指定，最高优先级，不再自作聪明；
 *   ② PATH 上所有 node 候选，按稳定性评分选分最高的（⚠ 不能只看第一个：
 *      PATH 首个往往是 IDE 私有 node）；
 *   ③ process.execPath —— 兜底，此时 note 里写明风险与怎么改。
 */
export function resolveNodeCommand() {
  const explicit = String(process.env.NEXI_NODE || '').trim();
  if (explicit && existsSync(explicit)) {
    return { command: explicit, source: 'env', score: scoreNode(explicit) };
  }

  const candidates = findAllOnPath(['node']);
  if (candidates.length) {
    const ranked = candidates.map((p) => ({ p, score: scoreNode(p) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    return {
      command: best.p,
      source: 'path',
      score: best.score,
      considered: ranked.map((r) => ({ path: r.p, score: Number(r.score.toFixed(3)) })),
    };
  }

  const fallback = process.execPath;
  if (existsSync(fallback)) return { command: fallback, source: 'execPath', score: scoreNode(fallback) };
  return { command: 'node', source: 'bare', score: scoreNode('node') };
}

/**
 * 本机跑 `nexi mcp` 的启动命令。
 *
 * 这里有个权衡，踩过坑所以写清楚：
 *   · 用**绝对路径**最稳 —— 宿主的 PATH 可能跟我们不一样，裸写 "node" 在某些宿主里起不来；
 *     但绝对路径必须挑"活得久"的那个（见 resolveNodeCommand / scoreNode）。
 *   · 绝对路径**不可移植** —— 用户把配置拷到另一台电脑，那条路径就废了。
 *
 * 取舍：默认用"最稳的绝对路径"（先保证本机能跑、且不会被宿主升级弄坏），
 * 但把**裸命令**这条路留着 —— 调用方显式说 `{ portable: true }` 时给 `node`。
 */
export function launchCommand(opts = {}) {
  if (opts.portable === true) {
    return {
      command: 'node',
      args: [NEXI_ENTRY, 'mcp'],
      env: {},
      note: '用的是 PATH 里的 node；如果宿主找不到 node，把 command 改成 node 的绝对路径。',
      _node: { source: 'bare', score: 0 },
    };
  }
  const node = resolveNodeCommand();
  return {
    command: node.command,
    args: [NEXI_ENTRY, 'mcp'],
    env: {},
    note: node.source === 'execPath'
      ? `用的是当前解释器 ${node.command}。若它随宿主升级消失，把 command 改成 "node" 或新位置的绝对路径（或设 NEXI_NODE 后重装）。`
      : `用的是机器上较稳定的 node（${node.command}，来自 ${node.source === 'env' ? 'NEXI_NODE' : 'PATH'}）。`,
    _node: { source: node.source, score: node.score, considered: node.considered },
  };
}

/**
 * JSON 配置的「形状」：宿主之间真正的差异只有两件事 ——
 *   ① 服务器挂在哪个 key 下；② 每一项 entry 长什么样。
 * 早先这里写死了 mcpServers + {command,args,env}，结果只能接那些"恰好同形状"的宿主，
 * 一遇到 Zed（context_servers）、VS Code（servers）、OpenCode（mcp.servers + type:"local"）
 * 就完全进不来。抽成表以后，加新宿主只是加一行数据，不用再动写入逻辑。
 *
 * 每一格的依据（都是官方文档核过的，不是猜的）：
 *   mcpServers      —— Claude Desktop/Code、Cursor、Windsurf、Cline、Continue、Gemini CLI、Qwen、Copilot
 *   servers         —— VS Code 自己的 mcp.json（与 portable 的 mcpServers 不同，不能混用）
 *   context_servers —— Zed，entry 形状与 mcpServers 相同，只是 key 不同
 *   mcp.servers     —— OpenCode V2，entry 是 {type:"local", command:[...], environment:{}}
 */
const SHAPES = {
  mcpServers: {
    key: 'mcpServers',
    get: (d) => (d.mcpServers && typeof d.mcpServers === 'object' && !Array.isArray(d.mcpServers) ? d.mcpServers : {}),
    set: (d, servers) => ({ ...d, mcpServers: servers }),
    entry: (launch) => ({ command: launch.command, args: launch.args, env: launch.env || {} }),
  },
  servers: {
    key: 'servers',
    get: (d) => (d.servers && typeof d.servers === 'object' && !Array.isArray(d.servers) ? d.servers : {}),
    set: (d, servers) => ({ ...d, servers }),
    // VS Code 的 stdio 项显式要 type；不给的话它按 url 猜，会把本地命令当远程服务器。
    entry: (launch) => ({ type: 'stdio', command: launch.command, args: launch.args, env: launch.env || {} }),
  },
  context_servers: {
    key: 'context_servers',
    get: (d) => (d.context_servers && typeof d.context_servers === 'object' && !Array.isArray(d.context_servers) ? d.context_servers : {}),
    set: (d, servers) => ({ ...d, context_servers: servers }),
    entry: (launch) => ({ command: launch.command, args: launch.args, env: launch.env || {} }),
  },
  // Kilo CLI：mcp.<name>，命令合成数组，环境变量叫 environment。
  // 与 OpenCode 的 mcp.servers 差一层：这里没有 servers 这一级。
  'mcp.local': {
    key: 'mcp',
    get: (d) => {
      const mcp = d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp) ? d.mcp : {};
      return mcp.servers ? {} : mcp;
    },
    set: (d, servers) => {
      const mcp = d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp) ? d.mcp : {};
      return { ...d, mcp: { ...mcp, ...servers } };
    },
    entry: (launch) => ({
      type: 'local',
      command: [launch.command, ...launch.args],
      environment: launch.env || {},
      enabled: true,
    }),
    // set 是合并不是替换，删除必须显式做，否则卸载等于没卸。
    remove: (d, name) => {
      const mcp = { ...(d.mcp && typeof d.mcp === 'object' ? d.mcp : {}) };
      delete mcp[name];
      return { ...d, mcp };
    },
  },
  // Crush：mcp.<name>，但 entry 是 type:"stdio" + command 字符串。
  'mcp.stdio': {
    key: 'mcp',
    get: (d) => {
      const mcp = d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp) ? d.mcp : {};
      return mcp.servers ? {} : mcp;
    },
    set: (d, servers) => {
      const mcp = d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp) ? d.mcp : {};
      return { ...d, mcp: { ...mcp, ...servers } };
    },
    entry: (launch) => ({ type: 'stdio', command: launch.command, args: launch.args, env: launch.env || {} }),
    // 同上：mcp.* 是合并写入，卸载必须显式删。
    remove: (d, name) => {
      const mcp = { ...(d.mcp && typeof d.mcp === 'object' ? d.mcp : {}) };
      delete mcp[name];
      return { ...d, mcp };
    },
  },
  // Amp：键名本身带点，`amp.mcpServers`。
  'amp.mcpServers': {
    key: 'amp.mcpServers',
    get: (d) => (d['amp.mcpServers'] && typeof d['amp.mcpServers'] === 'object' && !Array.isArray(d['amp.mcpServers']) ? d['amp.mcpServers'] : {}),
    set: (d, servers) => ({ ...d, 'amp.mcpServers': servers }),
    entry: (launch) => ({ command: launch.command, args: launch.args, env: launch.env || {} }),
  },
  'mcp.servers': {
    key: 'mcp.servers',
    get: (d) => {
      const mcp = d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp) ? d.mcp : {};
      return mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers) ? mcp.servers : {};
    },
    set: (d, servers) => {
      const mcp = d.mcp && typeof d.mcp === 'object' && !Array.isArray(d.mcp) ? d.mcp : {};
      return { ...d, mcp: { ...mcp, servers } };
    },
    // OpenCode 把命令和参数合成一个数组，环境变量叫 environment。
    entry: (launch) => ({ type: 'local', command: [launch.command, ...launch.args], environment: launch.env || {} }),
  },
};

/**
 * YAML 形状：宿主之间同样只有两件事 —— 挂哪个 key、每项长什么样。
 * 但还有第三件事：**这一项是 map 的成员还是一整个列表项**。
 *
 *   Goose     extensions.<id>    → map 成员（type/name/cmd/args/envs/timeout）
 *   Continue  mcpServers: [...]  → 列表项（name/command/args/env）
 *
 * 官方文档原文核对过（不是猜字段名）：
 *   Goose     cmd / args / envs / enabled / timeout / type: stdio
 *   Continue  name / command / args / env，可选 type: stdio
 */
const YAML_SHAPES = {
  'yaml.extensions': {
    key: 'extensions',
    style: 'map',
    body: (launch, name) => [
      `${name}:`,
      '  type: stdio',
      `  name: ${yamlStr(name)}`,
      '  enabled: true',
      `  cmd: ${yamlStr(launch.command)}`,
      `  args: ${yamlFlowArray(launch.args)}`,
      `  envs: ${YAML_EMPTY_MAP}`,
      '  timeout: 300',
    ],
  },
  'yaml.mcpServers': {
    key: 'mcpServers',
    style: 'seq',
    body: (launch, name) => [
      `- name: ${yamlStr(name)}`,
      '  type: stdio',
      `  command: ${yamlStr(launch.command)}`,
      `  args: ${yamlFlowArray(launch.args)}`,
      `  env: ${YAML_EMPTY_MAP}`,
    ],
  },
};

/** YAML 形状清单（注册表校验与 snippet 共用）。 */
export function yamlShapeKeys() {
  return Object.keys(YAML_SHAPES);
}

function shapeOf(host, kind) {
  if (kind === 'yaml' || host.kind === 'yaml') {
    return YAML_SHAPES[host.shape] || YAML_SHAPES['yaml.mcpServers'];
  }
  return SHAPES[host.shape || 'mcpServers'] || SHAPES.mcpServers;
}

/**
 * 按目标文件判断用哪个写入器。
 * `kind: 'auto'` 是给"一个宿主两代格式并存"用的（Continue 就是典型）：
 * 装到哪个文件，就按那个文件的语法写，不靠猜。
 */
export function kindFor(host, file = '') {
  if (host.kind && host.kind !== 'auto') return host.kind;
  const f = String(file).toLowerCase();
  if (f.endsWith('.yaml') || f.endsWith('.yml')) return 'yaml';
  if (f.endsWith('.toml')) return 'toml';
  if (f.endsWith('.json') || f.endsWith('.jsonc')) return 'json';
  return 'json';
}

/** 支持的形状清单（给 snippet 的报错/帮助用）：8 种 JSON + 2 种 YAML。 */
export function shapeKeys() {
  return [...Object.keys(SHAPES), ...Object.keys(YAML_SHAPES)];
}

/** 这个宿主写进配置时挂在哪个 key 下（给人看 / 报错用）。 */
export function shapeKeyOf(id) {
  const host = findHost(id);
  if (!host) return null;
  const kind = host.kind === 'yaml' ? 'yaml' : 'json';
  if (host.kind === 'auto') return shapeOf(host, 'json').key;
  return shapeOf(host, kind).key;
}


/**
 * 原文的缩进风格。
 * 为什么在意：用户把 mcp.json 写成一行、或 4 空格、或 tab，都是他的选择。
 * 我们装一个条目就整份重排成 2 空格，git diff 会红一片，看着像我们"改了他的配置"。
 * 检测三种：单行（0）→ 紧凑输出；tab → tab；否则取实际宽度（2/4/…）。
 */
function detectIndent(text) {
  const body = String(text);
  if (!/\n/.test(body.trim())) return 0;
  const m = /\n([ \t]+)"/.exec(body);
  if (!m) return 2;
  if (m[1].includes('\t')) return '\t';
  return Math.min(8, m[1].length) || 2;
}

/** 按原文的缩进风格序列化（并保留 BOM 与结尾换行）。 */
function stringifyLike(data, indent, bom = '') {
  const body = indent === 0 ? JSON.stringify(data) : JSON.stringify(data, null, indent);
  return `${bom}${body}\n`;
}

/**
 * 读一个 JSON 配置，连同它的「原味」一起带回：BOM 有没有、换行是哪种。
 * 只返回数据是不够的 —— 写回去时丢了 BOM，就等于我们偷偷改了用户文件的编码。
 */
function readJsonDoc(file, warnings) {
  const doc = readConfigText(file);
  if (!doc.ok) {
    warnings.push(doc.error);
    return { ok: false, data: null, bom: '', text: '', jsonc: false, indent: 2 };
  }
  const raw = doc.text.trim();
  const indent = detectIndent(doc.text);
  if (!raw) return { ok: true, data: {}, bom: doc.bom, text: doc.text, jsonc: false, indent };
  // JSONC：VS Code / CodeBuddy 官方就允许注释和尾逗号。
  // 读的时候剥掉，写的时候不整份重排 —— 见下面 planJson 的 jsonc 分支。
  const jsonc = hasJsonc(raw);
  try {
    const value = jsonc ? parseJsonc(raw) : JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(`${file} 顶层不是对象，拒绝改写`);
      return { ok: false, data: null, bom: doc.bom, text: doc.text };
    }
    return { ok: true, data: value, bom: doc.bom, text: doc.text, jsonc, indent };
  } catch (err) {
    warnings.push(`${file} 不是合法 JSON${jsonc ? 'C' : ''}（${err.message}），拒绝改写`);
    return { ok: false, data: null, bom: doc.bom, text: doc.text, jsonc, indent };
  }
}

function backup(file, stamp) {
  // 命名与保留策略统一在 backup.js 里（含 `nexi restore` 用的解析规则）。
  // stamp 参数保留只为兼容老调用方，实际文件名由 backupFile 自己按现在时间生成。
  void stamp;
  const target = backupFile(file, 'write');
  // 顺手清理：每个配置文件只留最近几份，别往用户配置目录里堆垃圾
  pruneBackups(file, { keep: DEFAULT_KEEP });
  return target;
}

/**
 * 清理上次崩溃留下的半写临时文件。
 * 为什么：只读/占用的文件上 rename 会失败，如果不清理，用户目录里会慢慢堆一堆
 * `.123456.nexi.tmp`，而他根本不知道那是什么。只清超过 1 小时的，避免误删正在写的。
 */
function sweepStaleTmp(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith('.nexi.tmp')) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch { /* 删不掉就算了，下次再来 */ }
  }
}

/**
 * 原子写。失败时**必须**清掉临时文件并把错误原样抛给调用方翻译 ——
 * 以前这里裸抛，只读文件会让整个 CLI 打一串堆栈退出，用户以为程序坏了。
 */
function writeAtomic(file, text) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  sweepStaleTmp(dir);
  // 文件名带 pid + 随机后缀：同一毫秒写两个不同宿主时不会撞同一个临时文件
  const tmp = join(dir, `.${process.pid}-${Math.random().toString(36).slice(2, 8)}.nexi.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 已经没这个文件了 */ }
    throw err;
  }
}

/** 写盘失败翻译 —— 表在 lib/connect/errors.js，这里是薄壳，保持调用点不动。 */
function writeFailure(file, err, hint) {
  return translateWriteError(file, err, hint);
}

/** 计算 json 类宿主的「安装后内容」，不落盘。 */
function planJson(host, file, { launch, force, name = 'nexi' }) {
  const warnings = [];
  const doc = readJsonDoc(file, warnings);
  if (!doc.ok) return { ok: false, warnings };
  const data = doc.data;

  const shape = shapeOf(host);
  const servers = { ...shape.get(data) };
  const before = servers[name] ? JSON.stringify(servers[name]) : null;
  const entry = shape.entry(launch);
  const after = JSON.stringify(entry);

  // 已存在但不是我们写的（用户手工配了同名 server）→ 默认不动
  if (before && before !== after && !force) {
    warnings.push(`${shape.key}.${name} 已存在且不是当前启动命令；加 --force 才会覆盖`);
    return { ok: false, warnings, unchanged: false };
  }

  // 带注释的配置：条目没变就无事；要改就拒绝 ——
  // 整份重排会把用户的注释和排版全抹掉，那比「没装上」更糟。
  if (doc.jsonc && before !== after) {
    return {
      ok: false,
      reason: 'jsonc-preserve',
      warnings: [
        `${file} 是 JSONC（带注释）。整份重写会删掉你的注释，所以这里不动它。`,
        `改用：nexi snippet --shape ${shape.key === 'servers' ? 'servers' : shape.key}，把输出手工粘进 ${shape.key}.${name}；`
          + '或让宿主自己的 CLI 去写（它会保留格式）。',
      ],
      unchanged: false,
    };
  }

  servers[name] = entry;
  const next = shape.set(data, servers);
  // 原文件有 BOM 就还它一个 BOM、原来怎么缩进就怎么缩进；没有就绝不加。
  return {
    ok: true,
    warnings,
    unchanged: before === after,
    text: stringifyLike(next, doc.indent, doc.bom),
    path: file,
  };
}

/** Codex 的 TOML：用哨兵块包裹，卸载时精确删除。 */
/**
 * 造一个「临时宿主」：给未收录的 Agent 用。
 * `nexi install custom <文件> --shape servers` 走的就是它 —— 不写注册表也能装。
 */
export function adHocHost({ id = 'custom', label = '自定义 Agent', kind = 'json', shape = 'mcpServers', path } = {}) {
  return {
    id,
    label,
    tier: 'A',
    kind,
    shape,
    source: 'adhoc',
    paths: () => (path ? [path] : []),
  };
}

/**
 * 生成一段可直接粘贴的配置片段。
 * 用途：那些我们没有自动写盘能力的 Agent（只让在 UI 里粘 JSON 的），
 * 用户复制这一段就能接上 —— 这是「适配所有 Agent」的最后一条兜底通道。
 */
export function buildSnippet({ shape = 'mcpServers', launch, name = 'nexi', toml = false } = {}) {
  const l = launch || launchCommand();
  if (toml) {
    return [
      `[mcp_servers.${name}]`,
      `command = ${JSON.stringify(l.command)}`,
      `args = ${JSON.stringify(l.args)}`,
      '',
    ].join('\n');
  }
  // YAML：给一段"整个 key 一起给"的片段，用户整段贴进 config.yaml 就能跑。
  // 已经存在同名 key 的话，他只需把下面 `nexi:` / `- name:` 那几行挪进去。
  if (YAML_SHAPES[shape]) {
    const s = YAML_SHAPES[shape];
    const lines = [`${s.key}:`, ...s.body(l, name).map((line) => `  ${line}`), ''];
    return lines.join('\n');
  }
  const s = SHAPES[shape];
  if (!s) return null;
  const body = s.set({}, { [name]: s.entry(l) });
  return `${JSON.stringify(body, null, 2)}\n`;
}

function yamlShape(host) {
  return YAML_SHAPES[host.shape] || YAML_SHAPES['yaml.mcpServers'];
}

/** 计算 YAML 类宿主的「安装后内容」，不落盘。 */
function planYamlHost(host, file, { launch, force, name = 'nexi' }) {
  const shape = yamlShape(host);
  return planYaml(file, {
    key: shape.key,
    style: shape.style,
    body: shape.body(launch, name),
    name,
    force,
  });
}

function planToml(file, { launch, force, name = 'nexi' }) {
  const warnings = [];
  // TOML 的哨兵块是按名字写死的（[mcp_servers.nexi]），多装一份会互相覆盖。
  // 与其偷偷写出两个一样的块，不如直接说清楚。
  if (name !== 'nexi') {
    return { ok: false, warnings: [`Codex 的 config.toml 只支持一个 nexi 条目，不接受 --name ${name}`] };
  }
  const doc = readConfigText(file);
  if (!doc.ok) return { ok: false, warnings: [doc.error] };
  // 内部一律用 \n 算，落盘前再按原文件的换行风格转回去 ——
  // 否则一次安装会把 CRLF 文件变成「CRLF 与 LF 混行」，git diff 全红。
  const existing = doc.text.replace(/\r\n/g, '\n');
  const block = [
    SENTINEL_START,
    '[mcp_servers.nexi]',
    `command = ${JSON.stringify(launch.command)}`,
    `args = ${JSON.stringify(launch.args)}`,
    SENTINEL_END,
  ].join('\n');

  const start = existing.indexOf(SENTINEL_START);
  const end = existing.indexOf(SENTINEL_END);
  // 哨兵只有一半：多半是上次写到一半被中断，或者用户手删了一行。
  // 这时候追加第二个块会把文件弄得更乱，而且那个半截块以后也删不掉。
  if ((start === -1) !== (end === -1)) {
    return {
      ok: false,
      reason: 'torn-sentinel',
      warnings: [
        `${file} 里有一段不完整的 nexi 哨兵（只有 ${start === -1 ? '结束' : '开始'}标记）。`,
        `这通常是上次写到一半被中断，或者手工删掉了一行。先跑 nexi repair <宿主 id> 清干净再重装`
          + `（自定义宿主：nexi repair custom --path "${file}"），它只删 nexi 自己的那几行。`,
      ],
    };
  }
  let text;
  if (start !== -1 && end !== -1 && end > start) {
    // 重装：只替换块本身，块外的字节一个都不动 → 天然幂等
    text = existing.slice(0, start) + block + existing.slice(end + SENTINEL_END.length);
  } else {
    if (/^\s*\[mcp_servers\.nexi\]\s*$/m.test(existing) && !force) {
      warnings.push('config.toml 已有 [mcp_servers.nexi]（不是 nexi 写的）；加 --force 才追加同名表');
      return { ok: false, warnings };
    }
    // 块前后各一个换行：卸载时按「逆操作」精确剪掉，用户原有内容逐字节还回去
    text = existing === '' ? `${block}\n` : `${existing}\n${block}\n`;
  }

  const finalText = `${doc.bom}${toEol(text, doc.eol)}`;
  return {
    ok: true,
    warnings,
    unchanged: finalText === `${doc.bom}${doc.text}`,
    text: finalText,
    path: file,
  };
}

function removeFromJson(file, host, { name = 'nexi' } = {}) {
  const warnings = [];
  if (!existsSync(file)) return { ok: true, warnings, changed: false };
  const doc = readJsonDoc(file, warnings);
  if (!doc.ok) return { ok: false, warnings, changed: false };
  const data = doc.data;
  const shape = shapeOf(host);
  const current = shape.get(data);
  if (!current[name]) return { ok: true, warnings, changed: false, text: undefined };
  if (doc.jsonc) {
    warnings.push(`${file} 是 JSONC（带注释），卸载没动它。手工删掉 ${shape.key}.${name} 这一段即可。`);
    return { ok: false, reason: 'jsonc-preserve', warnings, changed: false };
  }
  const servers = { ...current };
  delete servers[name];
  const next = typeof shape.remove === 'function' ? shape.remove(data, name) : shape.set(data, servers);
  return { ok: true, warnings, changed: true, text: stringifyLike(next, doc.indent, doc.bom) };
}

function removeFromToml(file) {
  if (!existsSync(file)) return { ok: true, warnings: [], changed: false };
  const doc = readConfigText(file);
  if (!doc.ok) return { ok: false, warnings: [doc.error], changed: false };
  const existing = doc.text.replace(/\r\n/g, '\n');
  const start = existing.indexOf(SENTINEL_START);
  const end = existing.indexOf(SENTINEL_END);
  if (start === -1 || end === -1 || end < start) {
    // 没有哨兵不等于"没装"—— 宿主自己的 CLI 写进去的表就没有注释。
    // 实测 codex：`codex mcp add nexi` 会把 config.toml 重新序列化，把哨兵注释全丢掉，
    // 只剩一个 `[mcp_servers.nexi]`。以前这里直接返回 changed:false，
    // 于是「装得进去、卸不出来」—— 现在按表名精确删掉那一段。
    const stripped = stripNexiTableOnly(existing);
    if (!stripped.changed) return { ok: true, warnings: [], changed: false };
    return { ok: true, warnings: [], changed: true, via: 'table', text: `${doc.bom}${toEol(stripped.text, doc.eol)}` };
  }

  const before = existing.slice(0, start);
  const after = existing.slice(end + SENTINEL_END.length);
  // 安装时写的是 `原文 + \n + 块 + \n`（文件原本是空的话没有前导 \n），
  // 这里做严格逆操作，把块和它带来的换行一起剪掉，用户原文逐字节还回去。
  // 文件被人改过、接缝对不上时退回保守拼接 —— 宁可能多一个空行，也不吃掉用户内容。
  let joined;
  if (start === 0) {
    joined = after.startsWith('\n') ? after.slice(1) : after;
  } else if (before.endsWith('\n') && after.startsWith('\n')) {
    joined = before.slice(0, -1) + after.slice(1);
  } else {
    joined = before + after;
  }
  return { ok: true, warnings: [], changed: true, text: `${doc.bom}${toEol(joined, doc.eol)}` };
}

/**
 * 只删 `[mcp_servers.nexi]` 这一段表，别的一行都不碰。
 * 用于"没有哨兵"的情况（宿主 CLI 自己写的表）。删完把留下的连续空行压成一个。
 */
function stripNexiTableOnly(text) {
  const lines = text.split('\n');
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[mcp_servers\.nexi\]\s*$/.test(lines[i])) {
      removed += 1;
      i += 1;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) i += 1;
      i -= 1;
      continue;
    }
    out.push(lines[i]);
  }
  if (!removed) return { changed: false, text };
  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { changed: true, text: joined };
}

/**
 * 把一份 TOML 里**所有** nexi 痕迹清干净（哨兵注释 + [mcp_servers.nexi] 表）。
 *
 * 为什么需要它：哨兵只有一半时（上次写到一半被杀、用户手删了一行、老版本升级上来），
 * 安装会拒绝写，用户就卡死在那儿 —— 让他自己去 TOML 里找哪几行该删，是刁难。
 * 这里做的是「把 nexi 自己留下的东西全收走」，然后安装就能从干净状态重来。
 *
 * 只删两种东西，绝不碰用户的其他表：
 *   ① 整行就是哨兵注释的；
 *   ② `[mcp_servers.nexi]` 这个表（从表头到下一个 `[` 表头之前）。
 * 删完最多留下连续空行，顺手压成一行 —— 不追求逐字节还原（本来就没有"原文"可还原），
 * 但保证「改完的 TOML 一定能被重新装上」。
 */
function stripNexiToml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let removedMarkers = 0;
  let removedTables = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === SENTINEL_START || line.trim() === SENTINEL_END) {
      removedMarkers += 1;
      continue;
    }
    if (/^\s*\[mcp_servers\.nexi\]\s*$/.test(line)) {
      removedTables += 1;
      // 吃掉这个表的整个区间：表头之后、下一个表头（或文件尾）之前
      i += 1;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) i += 1;
      i -= 1; // 让 for 的 i+=1 落在下一个表头上
      continue;
    }
    out.push(line);
  }
  // 删除会留下连续空行（尤其块在文件尾部时），压成最多一个空行
  let joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (joined && !joined.endsWith('\n')) joined += '\n';
  return { text: joined, removedMarkers, removedTables };
}

/**
 * 修一个宿主的配置文件：把 nexi 留下的残渣（半截哨兵、重复块）清掉。
 *
 * 这是 `install` 拒绝写入时的**出口**。产品上不能只有"拒绝"，还得有"收拾干净"。
 *
 * @param {string} id 宿主 id
 * @param {{path?:string, host?:object, dryRun?:boolean, stamp?:string, ctx?:object}} opts
 */
export function repairHost(id, opts = {}) {
  const host = opts.host || findHost(id);
  if (!host) return { ok: false, reason: `不认识宿主：${id}`, known: HOSTS.map((h) => h.id) };
  const ctx = opts.ctx || platformCtx();
  const detected = detectHosts(ctx).find((h) => h.id === id)
    || { path: (typeof host.paths === 'function' ? host.paths(ctx)[0] : '') || '' };
  const file = opts.path || detected.path;
  if (!file) return { ok: false, reason: 'no-config-path' };
  if (!existsSync(file)) return { ok: true, changed: false, reason: 'no-config', path: file };

  const kind = kindFor(host, file);
  // 只有 TOML 会把 nexi 的痕迹写进用户文件（哨兵注释）；JSON/YAML 没有残渣可清。
  if (kind !== 'toml') return { ok: true, changed: false, reason: 'not-needed', path: file, kind };

  const doc = readConfigText(file);
  if (!doc.ok) return { ok: false, reason: 'read-failed', path: file, message: doc.error };

  const before = `${doc.bom}${doc.text}`;
  const stripped = stripNexiToml(doc.text);
  if (!stripped.removedMarkers && !stripped.removedTables) {
    return { ok: true, changed: false, reason: 'clean', path: file };
  }
  const next = `${doc.bom}${toEol(stripped.text, doc.eol)}`;
  const removed = { markers: stripped.removedMarkers, tables: stripped.removedTables };
  if (opts.dryRun) return { ok: true, dryRun: true, changed: true, path: file, preview: next, removed };

  let locked;
  try {
    locked = withFileLock(file, () => {
      const backupPath = backup(file, opts.stamp || new Date().toISOString().replace(/[:.]/g, '-'));
      writeAtomic(file, next);
      return backupPath;
    }, { host: id, what: 'repair', waitMs: opts.lockWaitMs });
  } catch (err) {
    return { ...writeFailure(file, err), id };
  }
  if (locked.lock === 'timeout') {
    return { ok: false, reason: 'lock-timeout', message: locked.reason, holder: locked.holder, path: file };
  }
  return { ok: true, changed: next !== before, path: file, backup: locked.value, removed };
}

/**
 * 安装到某个宿主。
 * @param {string} id 宿主 id
 * @param {{dryRun?: boolean, force?: boolean, stamp?: string, launch?: object}} opts
 */
export function installHost(id, opts = {}) {
  // opts.host：调用方现造一个宿主描述（安装到任意未收录的 Agent 时用）。
  // 这条通道让「接入一个新 Agent」不必等我们发版，也不必先写进注册表。
  const host = opts.host || findHost(id);
  if (!host) return { ok: false, reason: `不认识宿主：${id}`, known: HOSTS.map((h) => h.id) };
  const launch = opts.launch || launchCommand({ portable: opts.portable === true });
  // ctx 可注入：测试能在这台 Windows 上，用 darwin 的路径表真跑一遍装/卸，
  // 而不是只验「三条路径字符串互不相同」。不传就是当前机器。
  const ctx = opts.ctx || platformCtx();
  const detected = detectHosts(ctx).find((h) => h.id === id) || { installed: false, path: (host.paths(ctx)[0] || '') };
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-');

  // 没装就报未安装，不创建假配置；但调用方显式给了 --path（高级用法）就按他指的文件来
  if (!opts.path && !detected.installed && !opts.force) {
    return { ok: false, reason: 'host-not-installed', path: detected.path, hint: '宿主未安装；确认路径后可用 --force 指定目标文件' };
  }
  // 优先走宿主自己的 CLI：让它自己校验、自己决定写哪个文件的哪个 key。
  // 失败（老版本没有 mcp 子命令 / 权限 / 参数变了）才退回写配置文件，并在 warnings 里说清楚为什么退。
  let cliNote = null;
  if (host.cli && !opts.path && opts.via !== 'file') {
    const avail = cliAvailable(id);
    if (avail.available) {
      const args = cliAddArgs(host, opts.name || 'nexi', launch, host.cliAddExtra || []);
      const unsafe = unsafeArgsReason(args);
      if (unsafe) {
        // Windows 的 .cmd 垫片会把 %* 再解析一遍，带 & | > 的参数没法安全交过去。
        // 与其赌一把，不如直接走写配置文件那条路 —— 结果一样，还不经过 shell。
        cliNote = `宿主 CLI 这条路不安全，已改为直接写配置文件：${unsafe}`;
      } else {
        if (opts.dryRun) {
          return { ok: true, dryRun: true, changed: true, via: 'cli', cli: host.cli, bin: avail.bin, args, warnings: [] };
        }
        const cli = hostCliAdd(id, { ...opts, launch });
        if (cli.ok) {
          return {
            ok: true,
            changed: true,
            via: 'cli',
            cli: host.cli,
            bin: cli.bin,
            args,
            path: cli.bin,
            out: cli.out,
            warnings: [],
          };
        }
        cliNote = `宿主 CLI 安装失败，已退回写配置文件：${(cli.out || cli.err || `退出码 ${cli.code}`).split('\n')[0]}`;
      }
    }
  }

  const file = opts.path || detected.path;
  const kind = kindFor(host, file);

  const entryName = opts.name || 'nexi';
  const plan = kind === 'toml'
    ? planToml(file, { launch, force: opts.force, name: entryName })
    : kind === 'yaml'
      ? planYamlHost(host, file, { launch, force: opts.force, name: entryName })
      : planJson(host, file, { launch, force: opts.force, name: entryName });
  if (!plan.ok) return { ok: false, reason: plan.reason || 'config-conflict', warnings: plan.warnings, path: file, via: 'file' };
  // 就算没变化也要把配置文本带回去：调用方（nexi config / dry-run）要的是"这份配置长什么样"，
  // 不是"要不要写"。以前这里提前 return 且不带 preview，于是已经装过的宿主反而拿不到配置文本。
  if (plan.unchanged) return { ok: true, changed: false, via: 'file', path: file, preview: plan.text, warnings: plan.warnings };

  if (opts.dryRun) {
    return { ok: true, dryRun: true, changed: true, via: 'file', path: file, preview: plan.text, warnings: plan.warnings };
  }

  // 落盘这几行是「读-改-写」的临界区：plan 已经读过了旧内容，
  // 到这里如果另一个 nexi 也在写同一个文件，谁后写谁就把对方抹掉。
  // 锁只包这一段（毫秒级），不包探测，否则 --all 会自我串行化。
  // 写盘可能因为权限/占用/磁盘满失败。这类失败必须是「一句话 + 怎么办」，
  // 不能让 renameSync 的 EPERM 冒到顶层打一串堆栈 —— 那看起来像程序坏了。
  let locked;
  try {
    locked = withFileLock(file, () => {
      const backupPath = existsSync(file) ? backup(file, stamp) : null;
      writeAtomic(file, plan.text);
      return backupPath;
    }, { host: id, what: 'install', waitMs: opts.lockWaitMs });
  } catch (err) {
    return writeFailure(file, err, cliNote ? `${cliNote}；另外写盘也失败了。` : undefined);
  }

  if (locked.lock === 'timeout') {
    return { ok: false, reason: 'lock-timeout', message: locked.reason, holder: locked.holder, path: file };
  }

  const backupPath = locked.value;
  const warnings = cliNote ? [...plan.warnings, cliNote] : plan.warnings;
  if (locked.lock === 'unavailable') warnings.push(`没拿到文件锁（${locked.err && locked.err.code}），已无锁写入`);
  return { ok: true, changed: true, via: 'file', path: file, backup: backupPath, warnings };
}

/** 从某个宿主编配置里移除 nexi（精确回滚）。 */
export function uninstallHost(id, opts = {}) {
  // opts.host：与 installHost 对称。任意 Agent 既然能被装进去，
  // 就必须能被卸出来 —— 否则「适配所有 Agent」只做了一半。
  const host = opts.host || findHost(id);
  if (!host) {
    return {
      ok: false,
      reason: `不认识宿主：${id}`,
      hint: `用 nexi host list 看全部 ${HOSTS.length} 家；没收录的 Agent 用 nexi install custom <配置文件> --shape <形状> 直接接。`,
      known: HOSTS.map((h) => h.id),
    };
  }
  const ctx = opts.ctx || platformCtx();
  const detected = detectHosts(ctx).find((h) => h.id === id)
    || { path: (typeof host.paths === 'function' ? host.paths(ctx)[0] : '') || '' };
  const file = opts.path || detected.path;
  if (!existsSync(file)) return { ok: true, changed: false, path: file };
  const kind = kindFor(host, file);
  const entryName = opts.name || 'nexi';
  const res = kind === 'toml'
    ? removeFromToml(file)
    : kind === 'yaml'
      ? planYamlRemove(file, { key: yamlShape(host).key, style: yamlShape(host).style, name: entryName })
      : removeFromJson(file, host, { name: entryName });
  if (!res.ok) return { ok: false, reason: 'config-broken', warnings: res.warnings, path: file };
  if (!res.changed) return { ok: true, changed: false, path: file };
  if (opts.dryRun) return { ok: true, dryRun: true, changed: true, path: file, preview: res.text, via: res.via };
  let locked;
  try {
    locked = withFileLock(file, () => {
      const backupPath = backup(file, opts.stamp || new Date().toISOString().replace(/[:.]/g, '-'));
      writeAtomic(file, res.text);
      return backupPath;
    }, { host: id, what: 'uninstall', waitMs: opts.lockWaitMs });
  } catch (err) {
    return writeFailure(file, err);
  }
  if (locked.lock === 'timeout') {
    return { ok: false, reason: 'lock-timeout', message: locked.reason, holder: locked.holder, path: file };
  }
  const warnings = locked.lock === 'unavailable'
    ? [`没拿到文件锁（${locked.err && locked.err.code}），已无锁写入`]
    : [];
  if (res.via === 'table') {
    warnings.push('这段是宿主 CLI 自己写进去的（没有哨兵注释），已按表名精确删除。');
  }
  return { ok: true, changed: true, path: file, backup: locked.value, via: res.via, warnings };
}

/**
 * 走宿主自己的 CLI 安装（比写配置文件可靠）。
 *
 * 为什么要这条路：配置文件格式是**宿主内部实现**，会跟着版本变。
 *   · OpenCode V1 把服务器放在 `mcp.<name>`，V2 改成了 `mcp.servers.<name>`；
 *   · VS Code 的 portable 格式用 `mcpServers`，自己的格式用 `servers`。
 * 我们照文档写死一种，用户换个版本就"装了但不生效"，而且表面上完全看不出来。
 * 相反，`<宿主> mcp add` 是宿主**自己**的入口：参数对不对它当场就会报错，
 * 写哪个文件的哪个 key 也由它决定。让宿主校验，比我们猜格式强。
 *
 * 参数分两种方言（都是实测 help 出来的，不是猜的）：
 *   bare      claude / gemini / qwen : `mcp add <name> <cmd> [args...]`
 *   dashDash  codex / copilot        : `mcp add <name> -- <cmd> [args...]`
 */
function runCli(bin, args, opts = {}) {
  // 为什么不再 `spawnSync(bin, args, {shell:true})`：
  //   shell:true 会把参数拼成一整行交给 cmd.exe —— 路径里的空格、名字里的 `&` `|` `>`
  //   要么把参数切断（装了不生效），要么被当成命令分隔符（注入）。
  //   exec.js 里对 .cmd 垫片做了逐参数加引号，并对转义不了的字符直接判 unsafe。
  const r = spawnTool(bin, args, {
    cwd: opts.cwd || process.cwd(),
    timeout: opts.timeout ?? 120_000,
  });
  return {
    ok: r.ok,
    out: r.out,
    code: r.code,
    err: r.err,
    unsafe: r.unsafe || null,
    via: r.via,
  };
}

/** 拼 `mcp add` 的参数，按宿主方言。 */
export function cliAddArgs(host, name, launch, extra = []) {
  const cmd = [launch.command, ...launch.args];
  const tail = host.argStyle === 'dashDash' ? ['--', ...cmd] : cmd;
  return ['mcp', 'add', ...extra, name, ...tail];
}

/** 这台机器上能不能用 CLI 装这个宿主。 */
export function cliAvailable(id) {
  const host = findHost(id);
  if (!host || !host.cli) return { available: false, reason: 'host-has-no-cli' };
  const bin = findOnPath([host.cli]);
  return bin
    ? { available: true, bin, cli: host.cli }
    : { available: false, reason: 'cli-not-found', cli: host.cli };
}

export function hostCliAdd(id, opts = {}) {
  const host = findHost(id);
  if (!host || !host.cli) return { ok: false, reason: 'host-has-no-cli' };
  const bin = findOnPath([host.cli]);
  if (!bin) return { ok: false, reason: 'cli-not-found', cli: host.cli };
  const launch = opts.launch || launchCommand({ portable: opts.portable === true });
  const name = opts.name || 'nexi';
  const extra = host.cliAddExtra || [];
  const args = cliAddArgs(host, name, launch, extra);
  if (opts.dryRun) return { ok: true, dryRun: true, via: 'cli', cli: host.cli, bin, args };

  let r = runCli(bin, args, opts);
  let reinstalled = false;
  // 「已存在」不该算失败——安装本来就该幂等。但宿主的 add 不会覆盖同名项，
  // 所以先移除再装一次。实测 claude 报的是 "MCP server nexi already exists in user config"。
  if (!r.ok && /already exists|already present|already configured|已存在/i.test(r.out)) {
    hostCliRemove(id, { ...opts, name });
    r = runCli(bin, args, opts);
    reinstalled = true;
  }
  return {
    ok: r.ok,
    via: 'cli',
    cli: host.cli,
    bin,
    args,
    out: r.out,
    code: r.code,
    err: r.err,
    reinstalled,
    warnings: [],
  };
}

export function hostCliRemove(id, opts = {}) {
  const host = findHost(id);
  if (!host || !host.cli) return { ok: false, reason: 'host-has-no-cli' };
  const bin = findOnPath([host.cli]);
  if (!bin) return { ok: false, reason: 'cli-not-found', cli: host.cli };
  const name = opts.name || 'nexi';
  const extra = host.cliAddExtra || [];
  const args = ['mcp', 'remove', ...extra, name];
  if (opts.dryRun) return { ok: true, dryRun: true, via: 'cli', bin, args };
  const r = runCli(bin, args, opts);
  // 本来就没注册 → remove 会报错，但结果是对的，按幂等成功处理
  const alreadyGone = /not found|no such|不存在|未找到/i.test(r.out);
  return { ok: r.ok || alreadyGone, via: 'cli', bin, args, out: r.out, code: r.code, changed: r.ok };
}

/** 让宿主自己报一遍它认不认 nexi —— 这是"真装上了"最硬的证据。 */
export function hostCliList(id, opts = {}) {
  const host = findHost(id);
  if (!host || !host.cli) return { ok: false, reason: 'host-has-no-cli' };
  const bin = findOnPath([host.cli]);
  if (!bin) return { ok: false, reason: 'cli-not-found', cli: host.cli };
  const r = runCli(bin, ['mcp', 'list'], opts);
  return { ok: r.ok, out: r.out, hasNexi: /\bnexi\b/.test(r.out), cli: host.cli };
}

/** 一键装到所有「已安装」的宿主（幂等）。 */
/**
 * 回滚某个宿主的配置文件到某个备份。
 *
 * 三个入口：
 *   - backupPath 明确指定（`nexi restore codex --to <文件>`）
 *   - `last: true` 用最近一份（`nexi restore codex --last`）
 *   - 都不给就只列清单，不动文件（`nexi restore codex`）
 */
/** 回滚前校验一份备份的内容（按目标文件类型）。只判断「能不能安全地当回去」，不做业务校验。 */
function validateBackupFor(kind, file) {
  const doc = readConfigText(file);
  if (!doc.ok) return { ok: false, reason: doc.error };
  const text = doc.text.trim();
  if (!text) return { ok: false, reason: '备份是空文件' };
  if (kind === 'json') {
    try {
      const v = parseJsonc(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: '备份顶层不是对象' };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `不是合法 JSON（${err.message}）` };
    }
  }
  if (kind === 'toml') {
    const a = text.indexOf(SENTINEL_START);
    const b = text.indexOf(SENTINEL_END);
    if ((a === -1) !== (b === -1)) return { ok: false, reason: 'nexi 的哨兵注释只有一半' };
    return { ok: true };
  }
  return { ok: true };
}

export function restoreHost(id, opts = {}) {
  // 恢复只需要"文件在哪"，不需要知道形状/字段 —— 所以给了 --path 时，
  // 即使 id 不在内置表里（比如 nexi install custom 写进去的自定义 Agent）也能回滚。
  const adHoc = opts.path ? {
    id, label: id, tier: 'A', kind: 'json', source: 'custom', paths: () => [opts.path],
  } : null;
  const host = opts.host || findHost(id) || adHoc;
  if (!host) return { ok: false, reason: `不认识宿主：${id}`, known: HOSTS.map((h) => h.id) };
  const detected = detectHosts(opts.ctx || platformCtx()).find((h) => h.id === id);
  const file = opts.path || detected.path;
  if (!file) return { ok: false, reason: 'no-config-path' };

  const list = listBackups(file);
  if (!list.length) return { ok: false, reason: 'no-backup', path: file };

  if (!opts.to && !opts.last) return { ok: true, listed: true, path: file, backups: list };

  const target = opts.to || list[0].path;
  if (!existsSync(target)) return { ok: false, reason: 'backup-missing', backupPath: target, path: file };

  const kind = kindFor(host, file);
  let locked;
  try {
    locked = withFileLock(file, () => restoreBackup(file, target, {
      dryRun: opts.dryRun,
      validate: (p) => validateBackupFor(kind, p),
    }), { host: id, what: 'restore', waitMs: opts.lockWaitMs });
  } catch (err) {
    return { ...writeFailure(file, err), id };
  }
  if (locked.lock === 'timeout') {
    return { ok: false, reason: 'lock-timeout', message: locked.reason, holder: locked.holder, path: file };
  }
  return { ...locked.value, id, path: file };
}

export function installAll(opts = {}) {
  const results = [];
  for (const host of detectHosts(opts.ctx || platformCtx())) {
    if (!host.installed) {
      results.push({ id: host.id, label: host.label, ok: false, reason: 'host-not-installed', path: host.path });
      continue;
    }
    results.push({ id: host.id, label: host.label, ...installHost(host.id, opts) });
  }
  return results;
}

/** 给测试用：临时目录里造一个假宿主配置 */
export function __tmpConfigPath(name = 'config.json') {
  return join(tmpdir(), `nexi-connect-${process.pid}-${Date.now()}`, name);
}

export default {
  HOSTS,
  detectHosts,
  installHost,
  uninstallHost,
  installAll,
  restoreHost,
  launchCommand,
  cliAvailable,
  cliAddArgs,
  hostCliAdd,
  hostCliRemove,
  hostCliList,
  shapeKeyOf,
  kindFor,
};
