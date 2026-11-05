/**
 * agentdeck-super · 宿主侧入口（Cordis 插件）
 *
 * 这个文件只干一件事：把 lib/engine/* 和 lib/tools/* 接进宿主。
 * 它自己**不做业务**——业务在 board / llm / cli / bridge / toolbelt / roles 里。
 *
 * 三条铁律（血泪换来的）：
 *   1) 宿主启动是全有全无：apply 里抛一个异常，整个 dsh 进程起不来。
 *      所以这里每一步都 try/catch，出错只 warn，绝不上抛。
 *   2) 可选服务按需挂载：webServer / commands / llm / storage 不是每个 profile 都有
 *      （headless profile 就没有 webServer）。用 ctx.inject([...], cb) 开子 fiber，
 *      服务在就挂，不在就安静跳过——而不是把整个插件卡死。
 *   3) 工具定义必须带 output（{schema, render}）：宿主 ctx.tools.register 在
 *      output 缺失或 render 不是函数时**直接抛 TypeError**（已实测），
 *      execute 返回的规范值由 render 转成 content 块。
 *
 * 已核实的宿主 API（证据见 docs/host-api.md）：
 *   ctx.tools.register({name, description, parameters, output, execute, timeoutMs?}) → disposer
 *   ctx.webServer.register({kind:'prefix'|'exact', path, handler(req,res)}) → disposer
 *   ctx.commands.register({name, description, input:{hint}, handler({rawInput,agent,signal})})
 *        → disposer；返回 {kind:'success', text?} | {kind:'error', text}
 *   ctx.llm.stream({provider, model, messages, system?, tools?, temperature?, maxTokens?, signal?})
 *   ctx.agentDefaultModel.currentSelection()
 *   ctx.get('service', false) —— 不声明依赖地读服务（cordis 4.0.5 的 inject 没有 optional 概念）
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createBoard } from './engine/board.js';

/** Cordis 插件名：与 package.json / cordis.patch.yml 里的 id 保持一致。 */
export const name = 'agentdeck-super';

/**
 * 硬依赖只有 tools——本插件的存在意义就是给宿主加工具。
 * 其余服务（webServer / commands / llm / storage）在 apply 内部用 ctx.inject 按需取。
 * 注意：cordis 4.0.5 的 inject 是「name → 拦截配置」的映射，**没有 optional 语义**，
 * 所以绝不能把 webServer 之类写进来，否则 headless 环境里插件永远 pending。
 */
export const inject = ['tools'];

/**
 * 配置声明：宿主会用它做校验/生成设置界面。
 * schemastery 属于宿主自带的依赖，第三方插件装进来后不一定解析得到，
 * 所以用顶层 await + try/catch 软加载：拿不到就不导出 Config
 * （宿主会把原始配置直接传给我们，normalizeConfig 自己兜默认值）。
 */
let Config;
try {
  const mod = await import('@deepseek-ai/schemastery');
  const z = mod?.default ?? mod;
  if (z && typeof z.object === 'function') {
    Config = z.object({
      enabled: z.boolean().default(true).description('总开关；关掉后不注册任何工具/路由，插件仍在但不干活。'),
      workspace: z.string().default('').description('默认工作区绝对路径；留空时用会话 cwd。'),
      boardRoot: z.string().default('').description('任务板状态目录；留空用 $DSH_HOME/agentdeck-super。'),
      petRoot: z.string().default('').description('桌宠档案目录；留空用 $DSH_HOME/agentdeck-super（桌宠跟人走，不跟项目走）。'),
      licenseRoot: z.string().default('').description('授权文件目录；留空用 $DSH_HOME/agentdeck-super（授权跟人走，不跟项目走）。'),
      routePrefix: z.string().default('/adbp').description('HTTP 路由前缀（ADBP 入口 + 状态页）。'),
      teamId: z.string().default('').description('默认小组 id；留空时自动取唯一的小组。'),
      agents: z.array(z.string()).default([]).description('允许派活的 CLI agent 预设，如 ["claude","codex"]；留空=自动探测。'),
      llm: z.object({
        mode: z.string().default('auto').description('大脑通道：auto | host | api | cli。'),
        baseUrl: z.string().default('').description('直连通道的 OpenAI 兼容 baseUrl。'),
        apiKey: z.string().default('').description('直连通道的 apiKey（建议走宿主 credentials，不要写死在配置里）。'),
        model: z.string().default('').description('直连通道的模型名。'),
        cliAgent: z.string().default('claude').description('cli 通道借用哪个本机 CLI。'),
      }).description('超级 Agent 的大脑通道配置。'),
    }).description('agentdeck-super 插件配置');
  }
} catch {
  // 没有 schemastery 也能活：配置按原样传入，normalizeConfig 负责兜底。
  Config = undefined;
}

export { Config };

/**
 * 插件主体。
 *
 * 为什么是 async：lib/tools/*.js 用动态 import 挂载（某个文件缺了/坏了只跳过它，
 * 不影响其余工具与整个插件）；第一方插件里 async apply 是常见写法（如 dsh-mcp-client）。
 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const log = createLogger(ctx);
  const registered = [];

  if (!cfg.enabled) {
    log.info('插件已被配置禁用，不做任何挂载');
    return;
  }

  // ── 1. 任务板（唯一真相源，同步落盘 + 文件锁）────────────────────────────
  const storage = pickSyncStorage(ctx, log);
  const board = safe(log, '任务板', () => createBoard({
    storage,
    root: cfg.boardRoot || undefined,
    onWarn: (msg) => log.warn(`[board] ${msg}`),
  }), null);

  // ── 2. 依赖容器：所有模块都从这里取，缺哪项就在下游降级 ────────────────
  const emit = makeEmit(ctx, board, log);
  const workspace = cfg.workspace || process.cwd();
  const registry = makeRegistry(ctx, cfg, log, emit);

  const brain = safe(log, '大脑', () => {
    // 宿主模型通道：只有当宿主真的挂了 llm 服务且能拿到默认模型时才声明可用，
    // 否则传 null，让 llm.js 自己回落到 api / cli 通道（而不是留一个会炸的假通道）。
    const host = makeHostBridge(ctx, log);
    return makeBrain({ host, cfg });
  }, null);

  const runAgent = makeDispatcher(log);
  const callRemote = makeRemoteCaller(log);

  const ingress = safe(log, 'ADBP 入口', () => makeIngress({
    board,
    log: { debug: log.debug, info: log.info, warn: log.warn, error: log.error },
    onEvent: (evt) => emit(evt?.kind || 'adbp', evt),
  }), null);

  // ── 2.5 授权 / 云房间 / 桌宠：都是兄弟模块，这里只 import 不改它们 ──────
  // 三个文件各自有用例覆盖（license 14 / room 7 / pet-profile），所以加载失败只可能是
  // "这个包里没带它"，一律 warn 后降级，绝不让插件整体起不来。
  const stateRoot = () => String(cfg.workspace || process.cwd());
  // 桌宠档案存"全局"目录而不是工作区：桌宠是人的数字分身，跟人走、不跟项目走。
  // 存工作区会出现"同一个人的桌宠在 A 项目是甲、B 项目是乙"，习惯永远攒不到一起。
  const globalStateRoot = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'agentdeck-super');
  // 授权码也存"全局"目录：买的是"这个人"，不是"这个项目"。
  // 以前挂在 stateRoot（工作区）上，用户在 A 项目激活后换个目录就掉回免费版，云房间/席位全降级。
  const licenseRoot = () => (cfg.licenseRoot ? String(cfg.licenseRoot) : globalStateRoot());
  let licenseApi = null;
  try {
    licenseApi = await import('./license.js');
  } catch (err) {
    log.warn(`授权模块没加载（将按免费版处理）：${errText(err)}`);
  }
  let roomApi = null;
  try {
    roomApi = await import('./room.js');
  } catch (err) {
    log.warn(`跨机房间模块没加载（云房间不可用，本地不受影响）：${errText(err)}`);
  }
  let petStore = null;
  try {
    const petProfile = await import('./pet/profile.js');
    if (typeof petProfile.createProfileStore === 'function') {
      petStore = petProfile.createProfileStore({ root: cfg.petRoot || globalStateRoot() });
    }
  } catch (err) {
    log.info(`桌宠档案没加载（状态页少一块画像）：${errText(err)}`);
  }
  // 桌宠工具模块可能还没落地（lib/pet/index.js 由队友在写），没有就静默跳过。
  let petToolFactory = null;
  try {
    const petToolsMod = await import('./pet/index.js');
    petToolFactory = petToolsMod?.petTools ?? petToolsMod?.default?.petTools ?? null;
  } catch {
    petToolFactory = null;
  }

  const version = readVersion();

  // 授权迁移必须在启动时跑一次：不能等用户打开 /deck 才迁——
  // 升级后先问 deck_license、或先建云房间的人，读到的还是机级空目录，当场掉回免费版。
  // 字段和 deckEnv 保持一致（licenseApi / licenseRoot / root / log）；失败只 warn。
  const licenseEnv = { licenseApi, licenseRoot, root: stateRoot, log };
  migrateWorkspaceLicense(licenseEnv);

  const deps = {
    brain,
    registry,
    board,
    workspace,
    emit,
    runAgent,
    callRemote,
    ingress,
    cfg,
    // 1.4 新增依赖：root 用函数（工作区可能变），其余是模块本体或 null
    root: stateRoot,
    licenseRoot,
    license: licenseApi,
    room: roomApi,
    pet: petStore,
    // 桌宠工具内部认的是 deps.profile（而不是 deps.pet）：不显式传它，
    // storeOf() 会拿 root（工作区）现建一个档案 store，桌宠档案就又按项目隔离了。
    profile: petStore,
    // 工具可能在任何页面之前被单独调用：把同一个迁移函数交给工具复用，避免逻辑复制两份。
    migrateLicense: () => migrateWorkspaceLicense(licenseEnv),
  };

  // ── 3. 工具（宿主工具带；挂不上就少几个工具，不影响启动）───────────────
  const tools = ctx.tools;
  if (tools && typeof tools.register === 'function') {
    const loaders = [
      ['./tools/super.js', 'createSuperTool', 'super_agent'],
      ['./tools/team.js', 'createTeamTool', 'team_orchestrate'],
      ['./tools/join.js', 'createJoinTool', 'agent_join'],
      ['./tools/board.js', 'createBoardTool', 'team_board'],
      // 1.4 新增：授权与跨机房间。两者都在缺模块时返回人话而不是抛错。
      ['./tools/license.js', 'createLicenseTool', 'deck_license'],
      ['./tools/room.js', 'createRoomTool', 'deck_room'],
    ];
    for (const [file, factoryName] of loaders) {
      try {
        const mod = await import(file);
        const factory = mod?.[factoryName] ?? mod?.default?.[factoryName] ?? mod?.default;
        if (typeof factory !== 'function') {
          log.warn(`工具模块 ${file} 没有导出 ${factoryName}()，跳过`);
          continue;
        }
        const raw = await factory(deps);
        const definition = normalizeToolDefinition(raw, log);
        tools.register(definition);
        registered.push(definition.name);
        log.info(`已注册工具 ${definition.name}`);
      } catch (err) {
        // 常见原因：文件不在包里 / 工具重名（宿主对同名工具直接抛错，不覆盖）
        log.warn(`工具 ${file} 挂载失败，已跳过：${errText(err)}`);
      }
    }

    // 桌宠工具由 petTools(deps) 生产，形状是 [{ name, description, inputSchema, execute }]，
    // 和我们的 Tool 契约只差 inputSchema→parameters 一次改名，这里就地适配。
    if (typeof petToolFactory === 'function') {
      try {
        const list = (await petToolFactory(deps)) || [];
        for (const item of Array.isArray(list) ? list : []) {
          if (!item || !item.name || typeof item.execute !== 'function') continue;
          try {
            const definition = normalizeToolDefinition({
              name: item.name,
              description: item.description,
              parameters: item.inputSchema ?? item.parameters,
              execute: item.execute,
              // 桌宠描述符目前不带 output（它们只产出人话），这里补上通用纯文本形态，
              // 免得每次启动都刷三条「output 不符合宿主契约」的告警。
              output: item.output ?? TEXT_OUTPUT,
            }, log);
            tools.register(definition);
            registered.push(definition.name);
            log.info(`已注册桌宠工具 ${definition.name}`);
          } catch (err) {
            log.warn(`桌宠工具 ${item.name} 挂载失败，已跳过：${errText(err)}`);
          }
        }
      } catch (err) {
        log.warn(`桌宠工具加载失败（不影响其它功能）：${errText(err)}`);
      }
    } else {
      log.info('桌宠工具模块（lib/pet/index.js）还没就绪，跳过桌宠工具，其它功能不受影响');
    }
  } else {
    log.warn('宿主没有 tools 服务，跳过工具注册');
  }

  // ── 3.5 状态页上下文：命令文本 / HTML 状态页 / ADBP state 共用同一份取数 ─────
  const deckEnv = {
    cfg,
    board,
    registered,
    ingress,
    version,
    licenseApi,
    roomApi,
    petStore,
    log,
    root: stateRoot,
    licenseRoot,
    // 本机 CLI 探测结果（makeRegistry.detect() 后台填，命令/页面直接读）
    registry,
  };

  // ── 4. HTTP 路由（ADBP + 状态页）────────────────────────────────────────
  // 宿主没有 webServer 服务（例如精简 profile）时，这个 inject 回调根本不会执行，
  // 于是「没有网页」是一种静默降级，而不是启动失败。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const disposers = [];
      const mount = (route, label) => {
        try {
          const dispose = scope.webServer.register(route);
          if (typeof dispose === 'function') disposers.push(dispose);
          return true;
        } catch (err) {
          log.warn(`${label}挂载失败：${errText(err)}`);
          return false;
        }
      };
      const port = scope.webServer?.port ?? '?';
      if (mount({
        kind: 'prefix',
        path: cfg.routePrefix,
        handler: (req, res) => handleHttp(req, res, { cfg, board, ingress, log, registered, deckEnv }),
      }, 'ADBP 路由')) {
        log.info(`ADBP 路由已挂载：http://127.0.0.1:${port}${cfg.routePrefix}`);
      }
      // 给人看的状态页：/deck（自包含 HTML，不引用任何外链/CDN，断网也能开）
      if (mount({
        kind: 'exact',
        path: '/deck',
        handler: (req, res) => handleDeckPage(req, res, { deckEnv }),
      }, '状态页')) {
        log.info(`状态页已挂载：http://127.0.0.1:${port}/deck`);
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch { /* 卸载期失败无所谓 */ }
        }
      };
    }, 'agentdeck-super: routes');
  });

  // ── 5. 斜杠命令（/deck，旧名 /agentdeck 保留）────────────────────────────
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => {
      const disposers = [];
      try {
        disposers.push(scope.commands.register({
          name: 'deck',
          description: 'agentdeck-super 状态页：版本 / 档位 / 房间 / 任务板 / 桌宠 / 下一步三步',
          input: { hint: '直接回车看状态；也支持 board | teams | license <授权码> | help' },
          handler: (invocation) => runDeckCommand(invocation, deckEnv),
        }));
      } catch (err) {
        log.warn(`/deck 命令挂载失败：${errText(err)}`);
      }
      // 老名字：v1.3 的用户习惯 /agentdeck，别让人升级后找不到入口
      try {
        disposers.push(scope.commands.register({
          name: 'agentdeck',
          description: '同 /deck（旧名保留）',
          handler: (invocation) => runDeckCommand(invocation, deckEnv),
        }));
      } catch { /* 宿主不接受重名就只留 /deck */ }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch { /* 同上 */ }
        }
      };
    }, 'agentdeck-super: command');
  });

  // ── 6. 启动时的后台探测（不阻塞宿主启动）───────────────────────────────
  void registry.detect().catch(() => {});

  // ── 7. 卸载收尾 ─────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    try {
      board?.flush?.();
    } catch { /* 尽力而为 */ }
    log.info(`已卸载（本次注册工具 ${registered.length} 个）`);
  }, 'agentdeck-super: lifecycle');

  log.info(`就绪：工作区 ${workspace}；工具 ${registered.length} 个；ADBP ${cfg.routePrefix}`);
}

export default { name, inject, Config, apply };

/* ════════════════════════════════════════════════════════════════════════
 * 配置
 * ════════════════════════════════════════════════════════════════════════ */

const DEFAULTS = {
  enabled: true,
  workspace: '',
  boardRoot: '',
  petRoot: '',
  licenseRoot: '',
  routePrefix: '/adbp',
  teamId: '',
  agents: [],
  llm: { mode: 'auto', baseUrl: '', apiKey: '', model: '', cliAgent: 'claude' },
};

/** 配置兜底：宿主可能传空、传字符串、传半截对象，这里一律整成完整形状。 */
function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const llm = c.llm && typeof c.llm === 'object' ? c.llm : {};
  const agents = Array.isArray(c.agents)
    ? c.agents.map((x) => String(x).trim()).filter(Boolean)
    : splitList(c.agents);
  return {
    enabled: c.enabled !== false,
    workspace: text(c.workspace),
    boardRoot: text(c.boardRoot) || text(c.root),
    petRoot: text(c.petRoot),
    licenseRoot: text(c.licenseRoot),
    routePrefix: normalizePrefix(c.routePrefix),
    teamId: text(c.teamId),
    agents,
    llm: {
      mode: text(llm.mode) || DEFAULTS.llm.mode,
      baseUrl: text(llm.baseUrl),
      apiKey: text(llm.apiKey),
      model: text(llm.model),
      cliAgent: text(llm.cliAgent) || DEFAULTS.llm.cliAgent,
    },
  };
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function splitList(value) {
  if (typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 路由前缀统一成 `/xxx`（无尾斜杠），保证拼接结果可预测。 */
function normalizePrefix(value) {
  let p = text(value) || DEFAULTS.routePrefix;
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  return p || DEFAULTS.routePrefix;
}

/* ════════════════════════════════════════════════════════════════════════
 * 日志 / 容错小工具
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * 日志：优先用宿主注入的 logger，没有就退回 console。
 * 只把 warn/error 当成真正需要人看的信号，info/debug 在无宿主 logger 时静默。
 */
function createLogger(ctx) {
  let base = null;
  try {
    base = ctx?.logger ?? ctx?.get?.('logger', false) ?? null;
  } catch {
    base = null;
  }
  const tag = '[agentdeck-super]';
  const call = (level, msg) => {
    try {
      if (base && typeof base[level] === 'function') {
        base[level](`${tag} ${msg}`);
        return;
      }
    } catch { /* logger 自己炸了也不能影响主流程 */ }
    if (level === 'warn' || level === 'error') console.warn(`${tag} ${msg}`);
    else if (level === 'info') console.log(`${tag} ${msg}`);
  };
  return {
    debug: (m) => call('debug', m),
    info: (m) => call('info', m),
    warn: (m) => call('warn', m),
    error: (m) => call('error', m),
  };
}

/** 包一层 try/catch：失败就 warn 并返回兜底值，apply 里绝不外抛。 */
function safe(log, label, fn, fallback) {
  try {
    const out = fn();
    if (out == null) log.warn(`${label}初始化返回空值，继续以降级状态运行`);
    return out;
  } catch (err) {
    log.warn(`${label}初始化失败：${errText(err)}`);
    return fallback;
  }
}

function errText(err) {
  if (!err) return '未知错误';
  return `${err.name || 'Error'}: ${err.message || String(err)}`;
}

/* ════════════════════════════════════════════════════════════════════════
 * 可选模块的软加载
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * 宿主存储：dsh-storage 是**异步**接口（按 domain 注册 schema），
 * 任务板要的是同步原子写，所以只有它明确提供同步 KV 时才接管；
 * 否则返回 null，board 自动落到 $DSH_HOME/agentdeck-super/state.json。
 */
function pickSyncStorage(ctx, log) {
  let hub = null;
  try {
    hub = ctx?.get?.('storage', false) ?? ctx?.storage ?? null;
  } catch {
    hub = null;
  }
  if (!hub) return null;
  const syncLike = typeof hub.loadSync === 'function' && typeof hub.saveSync === 'function';
  if (!syncLike) {
    log.info('宿主 storage 是异步接口，任务板改用文件状态（$DSH_HOME/agentdeck-super/state.json）');
    return null;
  }
  return hub;
}

/** 软加载 engine 模块：模块缺失时给出可读原因，返回 null。 */
async function loadEngine(relPath, log) {
  try {
    return await import(relPath);
  } catch (err) {
    log.warn(`engine 模块 ${relPath} 不可用：${errText(err)}`);
    return null;
  }
}

/** 大脑：lib/engine/llm.js 的 createBrain({host, cfg})。 */
function makeBrain({ host, cfg }) {
  try {
    // llm.js 是纯函数模块，静态导入也安全；但为了「模块缺失也不崩」的一致性，这里同步 require 风格拿不到就降级。
    return createBrainSync(host, cfg);
  } catch (err) {
    return null;
  }
}

// llm.js 通过下面的静态绑定注入；用一个小的惰性包装，避免模块缺失时整个入口 import 失败。
let createBrainImpl = null;
try {
  const mod = await import('./engine/llm.js');
  createBrainImpl = typeof mod.createBrain === 'function' ? mod.createBrain : null;
} catch {
  createBrainImpl = null;
}
function createBrainSync(host, cfg) {
  if (!createBrainImpl) return null;
  return createBrainImpl({ host, cfg });
}

/**
 * 宿主模型通道适配：把宿主 dsh-llm 的流式接口包成 llm.js 认识的 host.chat(...)。
 * 宿主接口（已核实）：
 *   ctx.llm.stream({provider, model, messages, system?, tools?, temperature?, maxTokens?, signal?})
 *        → AsyncIterable<StreamChunk>，chunk.type 为 text-delta / tool-call-delta / usage ...
 *   ctx.agentDefaultModel.currentSelection() → 当前选中的 provider + model
 * 拿不到默认模型时返回 null：宁可诚实地说「没有宿主通道」，也不要留一个必然失败的通道。
 */
function makeHostBridge(ctx, log) {
  let llm = null;
  let selection = null;
  try {
    llm = ctx?.get?.('llm', false) ?? ctx?.llm ?? null;
    selection = ctx?.get?.('agentDefaultModel', false)?.currentSelection?.() ?? null;
  } catch {
    return null;
  }
  if (!llm || typeof llm.stream !== 'function') return null;
  const provider = pickString(selection, ['provider', 'route', 'providerId', 'id']);
  const model = pickString(selection, ['model', 'modelId', 'name']);
  if (!provider || !model) {
    log.info('宿主没有可用的默认模型选择，宿主大脑通道关闭（可用 api/cli 通道）');
    return null;
  }
  return {
    provider,
    model,
    /** llm.js 只要求 host 是函数或带 chat/complete/generate 的对象。 */
    async chat({ messages, tools, temperature, maxTokens, signal } = {}) {
      // 宿主 llm.stream 的 system 是独立字段（不是 role:'system' 的消息）；
      // 直接扔进去会被丢掉，模型会拿不到人设/协议说明，所以这里把 system 消息拆出来单传。
      const hostMessages = [];
      let system = '';
      for (const m of Array.isArray(messages) ? messages : []) {
        if (!m || typeof m !== 'object') continue;
        if (String(m.role || '') === 'system') {
          const text = toContentBlocks(m.content).map((b) => b.text).join('\n');
          if (text) system = system ? `${system}\n\n${text}` : text;
          continue;
        }
        hostMessages.push(m);
      }
      const chunks = llm.stream({
        provider,
        model,
        messages: toHostMessages(hostMessages),
        ...(system ? { system } : {}),
        tools: toHostTools(tools),
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isFinite(maxTokens) ? { maxTokens } : {}),
        ...(signal ? { signal } : {}),
      });
      let content = '';
      const calls = new Map();
      let usage = null;
      let finishReason;
      for await (const chunk of chunks) {
        if (!chunk || typeof chunk !== 'object') continue;
        const type = String(chunk.type || '');
        if (type === 'text-delta' && typeof chunk.text === 'string') content += chunk.text;
        else if (type === 'tool-call-delta') {
          const id = String(chunk.id ?? `call_${calls.size}`);
          const cur = calls.get(id) || { id, name: '', arguments: '' };
          if (chunk.name) cur.name = String(chunk.name);
          if (typeof chunk.argumentsDelta === 'string') cur.arguments += chunk.argumentsDelta;
          calls.set(id, cur);
        } else if (type === 'usage' && chunk.usage) usage = chunk.usage;
        else if (type === 'finish' || type === 'done' || type === 'message-stop') {
          finishReason = chunk.finishReason ?? chunk.reason ?? finishReason;
        }
      }
      const toolCalls = [];
      for (const call of calls.values()) {
        if (!call.name) continue;
        toolCalls.push({ name: call.name, args: parseJsonSafe(call.arguments), id: call.id });
      }
      return {
        content,
        toolCalls,
        usage: usage ? { in: num(usage.inputTokens ?? usage.in ?? usage.promptTokens), out: num(usage.outputTokens ?? usage.out ?? usage.completionTokens) } : undefined,
        model,
        finishReason,
      };
    },
  };
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      const nested = v.id ?? v.name;
      if (typeof nested === 'string' && nested) return nested;
    }
  }
  return '';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseJsonSafe(text) {
  if (!text) return {};
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

/** 我们的 messages → 宿主的 RequestMessage（user/assistant 文本块）。 */
function toHostMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || 'user');
    if (role === 'system') continue; // 宿主用 system 字段而不是 system 消息
    const blocks = toContentBlocks(m.content);
    if (!blocks.length) continue;
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }
  return out;
}

function toContentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === 'string' && part) blocks.push({ type: 'text', text: part });
      else if (part && typeof part === 'object') {
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
        else if (typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'tool-call' || part.type === 'tool-result') blocks.push({ type: 'text', text: JSON.stringify(part) });
      }
    }
    return blocks;
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return [{ type: 'text', text: content.text }];
  return [];
}

/** 工具描述：llm.js 给的是 OpenAI 风格 {type:'function', function:{...}} 或裸 ToolSchema，两种都吃。 */
function toHostTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const fn = t.function && typeof t.function === 'object' ? t.function : t;
    const toolName = fn.name;
    if (!toolName) continue;
    out.push({
      name: String(toolName),
      description: String(fn.description || ''),
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    });
  }
  return out.length ? out : undefined;
}

/** 派活：CLI 走 cli.js，其它 kind 走 bridge.js，失败都返回结构化结果而不抛。 */
function makeDispatcher(log) {
  let cli = null;
  let bridge = null;
  return async function runAgent(spec, prompt, opts = {}) {
    const s = typeof spec === 'string' ? { id: spec } : (spec && typeof spec === 'object' ? spec : {});
    const kind = String(s.kind || s.transport || 'cli');
    try {
      if (kind === 'cli') {
        if (!cli) cli = (await loadEngine('./engine/cli.js', log)) || {};
        if (typeof cli.runAgent !== 'function') throw new Error('engine/cli.js 不可用');
        return await cli.runAgent(s, prompt, opts);
      }
      if (!bridge) bridge = (await loadEngine('./engine/bridge.js', log)) || {};
      if (typeof bridge.call !== 'function') throw new Error('engine/bridge.js 不可用');
      const res = await bridge.call(s, prompt, opts);
      return { rc: 0, out: String(res?.out ?? ''), err: '', ms: Number(res?.ms ?? 0), meta: res?.meta || {}, raw: res };
    } catch (err) {
      return { rc: 1, out: '', err: errText(err), ms: 0, meta: { kind } };
    }
  };
}

/** 直连外部 Agent（bridge.call）。 */
function makeRemoteCaller(log) {
  let bridge = null;
  return async function callRemote(manifest, prompt, opts = {}) {
    if (!bridge) bridge = (await loadEngine('./engine/bridge.js', log)) || {};
    if (typeof bridge.call !== 'function') throw new Error('engine/bridge.js 不可用');
    return bridge.call(manifest, prompt, opts);
  };
}

/** ADBP 入口：lib/engine/adbp.js 的 createIngress({board, log, onEvent})。 */
function makeIngress(opts) {
  if (!createIngressImpl) return null;
  try {
    return createIngressImpl(opts);
  } catch {
    return null;
  }
}

let createIngressImpl = null;
try {
  const mod = await import('./engine/adbp.js');
  createIngressImpl = typeof mod.createIngress === 'function' ? mod.createIngress : null;
} catch {
  createIngressImpl = null;
}

/* ════════════════════════════════════════════════════════════════════════
 * 事件 / 成员登记
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * 事件出口：同时进（a）宿主事件总线（客户端可订阅）和（b）任务板事件流（长轮询/状态页可见）。
 * 两条链路都容错——事件丢了不算故障。
 */
function makeEmit(ctx, board, log) {
  return function emit(type, data) {
    const payload = { type: String(type || 'event'), at: new Date().toISOString(), data: data ?? null };
    try {
      ctx?.emit?.('agentdeck-super/event', payload);
    } catch { /* 没有监听者或总线不可用 */ }
    try {
      const teamId = data?.teamId || board?.listTeams?.()[0]?.id;
      if (teamId && typeof board?.appendEvent === 'function') {
        board.appendEvent(String(teamId), { kind: 'host', text: payload.type, payload: data ?? null });
      }
    } catch (err) {
      log.debug(`事件落盘失败：${errText(err)}`);
    }
  };
}

/**
 * 成员登记：tools/common.js 期望 registry 是数组或带 list() 的对象。
 * 内容 = 本机可用的 CLI Agent（后台探测）+ board 里已登记的成员（由工具在运行时补充）。
 */
function makeRegistry(ctx, cfg, log, emit) {
  const agents = [];
  const upsert = (entry) => {
    if (!entry || !entry.id) return;
    const idx = agents.findIndex((a) => a.id === entry.id);
    if (idx >= 0) agents[idx] = { ...agents[idx], ...entry };
    else agents.push(entry);
  };
  return {
    agents,
    list() {
      return agents;
    },
    upsert,
    async detect() {
      try {
        const mod = await loadEngine('./engine/cli.js', log);
        if (!mod || typeof mod.detectAgents !== 'function') return [];
        const found = await mod.detectAgents({ withVersion: false });
        const wanted = cfg.agents.length ? new Set(cfg.agents) : null;
        for (const item of Array.isArray(found) ? found : []) {
          if (!item || item.available === false) continue;
          if (wanted && !wanted.has(String(item.id))) continue;
          upsert({
            id: String(item.id),
            name: String(item.label || item.id),
            role: 'worker',
            agent: String(item.id),
            status: item.available ? 'idle' : 'offline',
            raw: { id: String(item.id), cmd: item.cmd, transport: 'cli' },
          });
        }
        log.info(`本机可用 CLI Agent：${agents.map((a) => a.id).join('、') || '（无）'}`);
        emit('agents_detected', { agents: agents.map((a) => a.id) });
        return agents;
      } catch (err) {
        log.warn(`探测本机 Agent 失败：${errText(err)}`);
        return [];
      }
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * 工具定义归一化（宿主契约的最后一道防线）
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * 把 tools/*.js 返回的 Tool 归一成宿主 ctx.tools.register 认的定义。
 *
 * 已实测的宿主行为（docs/host-api.md）：
 *   · output 缺失 / 不是对象 / render 不是函数 → TypeError，注册失败；
 *   · parameters **不做校验**，原样回显给模型（所以我们的原生 JSON Schema 直接透传）；
 *   · 同名工具注册 → 抛错（不覆盖），所以必须每个工具单独 try/catch。
 */
function normalizeToolDefinition(raw, log) {
  if (!raw || typeof raw !== 'object') throw new Error('工具工厂没有返回对象');
  const toolName = String(raw.name || '');
  if (!toolName) throw new Error('工具缺少 name');
  if (typeof raw.execute !== 'function') throw new Error(`工具 ${toolName} 缺少 execute()`);

  const parameters = toJsonSchema(raw.parameters);
  const output = normalizeOutput(raw.output, toolName, log);

  const definition = {
    name: toolName,
    description: String(raw.description || `agentdeck-super 工具：${toolName}`),
    parameters,
    output,
    // execute 再兜一层：契约要求「永不 throw」，把异常变成普通的文本结果返回给模型。
    async execute(args, exec) {
      try {
        const value = await raw.execute(args && typeof args === 'object' ? args : {}, exec || {});
        return toResultValue(value);
      } catch (err) {
        const msg = `错误：${toolName} 执行失败 —— ${errText(err)}`;
        log.warn(msg);
        return { text: msg };
      }
    },
  };
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) definition.timeoutMs = raw.timeoutMs;
  return definition;
}

/** 纯文本工具的通用 output：只声明 text，render 原样吐一个 content 块。 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string', description: '给人看的纯文本结果' } },
    required: ['text'],
  },
  render(args, value) {
    return [{ type: 'text', text: renderText(value) }];
  },
};

/** 宿主 output 契约：{ schema, render(args, value) => content 块[] }。 */
function normalizeOutput(output, toolName, log) {
  if (output && typeof output === 'object' && typeof output.render === 'function' && output.schema && typeof output.schema === 'object') {
    return output;
  }
  log.warn(`工具 ${toolName} 的 output 不符合宿主契约，已用默认渲染兜底`);
  return TEXT_OUTPUT;
}

function renderText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value ?? '');
}

/** 工具返回值统一成 { text }（与 output.schema 对齐）。 */
function toResultValue(value) {
  if (typeof value === 'string') return { text: value };
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value;
    return { text: renderText(value) };
  }
  return { text: String(value ?? '') };
}

/**
 * parameters 归一：队友给的是原生 JSON Schema（ToolSchema.parameters 的类型就是
 * Record<string, unknown>，注释写明「JSON Schema object for the arguments」），
 * 所以**原样透传**；只有明显不是 JSON Schema（没有 type/properties/oneOf…）
 * 时才当成「属性表」包一层，避免把结构错的参数塞给模型。
 */
function toJsonSchema(parameters) {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    const looksLikeSchema =
      typeof parameters.type === 'string' ||
      parameters.properties ||
      parameters.oneOf ||
      parameters.anyOf ||
      parameters.allOf ||
      parameters.$ref;
    if (looksLikeSchema) return parameters;
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(parameters)) {
      properties[key] = value && typeof value === 'object' ? value : { type: 'string' };
      if (value && typeof value === 'object' && value.required === true) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  return { type: 'object', properties: {} };
}

/* ════════════════════════════════════════════════════════════════════════
 * HTTP：ADBP + 状态页
 * ════════════════════════════════════════════════════════════════════════ */

const MAX_BODY_BYTES = 1024 * 1024;
/** ADBP 协议内部固定前缀（合同 §2.4）；宿主路由前缀默认就是它，可配但内部不改。 */
const ADBP_INTERNAL_PREFIX = '/adbp';

async function handleHttp(req, res, { cfg, board, ingress, log, registered, deckEnv }) {
  const method = String(req?.method || 'GET').toUpperCase();
  let path = '/';
  try {
    path = new URL(String(req?.url || '/'), 'http://127.0.0.1').pathname;
  } catch {
    path = String(req?.url || '/');
  }
  try {
    // 预检：外部 Agent 多半从浏览器/其它 origin 来
    if (method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    // 状态页：`/adbp` 根和 `/deck` 出同一个页面（两个地址都有人记，省得维护两份 HTML）
    if (method === 'GET' && (path === cfg.routePrefix || path === `${cfg.routePrefix}/`)) {
      sendHtml(res, deckPageHtml(deckEnv || {}));
      return;
    }
    // 授权码粘贴表单提交（/deck 页面里的 <form>）：写文件后 303 回状态页。
    // 放在 ADBP 路由之前：它不是协议请求，别喂给 ingress。
    if (path === `${cfg.routePrefix}/deck/license` || path === '/deck/license') {
      await handleDeckLicense(req, res, { deckEnv, method, path });
      return;
    }
    if (!ingress || typeof ingress.handler !== 'function') {
      sendJson(res, 503, { error: 'adbp_unavailable', hint: 'engine/adbp.js 未加载，ADBP 入口不可用' });
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req);
    // ADBP 协议内部按 /adbp/v1/* 路由（合同 §2.4 规定），若用户把前缀改成了别的，
    // 这里做一次「入站改写到 /adbp/v1、出站把清单里的路径改回来」，让两边都自洽。
    const out = await ingress.handler(method, toAdbpPath(path, cfg.routePrefix), body, req.headers);
    if (!out) {
      sendJson(res, 404, { error: 'not_found', path });
      return;
    }
    const payload = localizeManifest(out.json ?? {}, cfg.routePrefix);
    // GET /state 补两个摘要字段：授权档位 + 当前房间。ADBP 是队友的模块（只读），
    // 所以扩展在入口这一层做——协议字段只增不改，老客户端读不懂新字段也不会崩。
    if (path.endsWith('/v1/state') && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      Object.assign(payload, deckStateExtras(deckEnv));
    }
    sendJson(res, Number(out.status) || 200, payload);
  } catch (err) {
    log.warn(`HTTP ${method} ${path} 处理失败：${errText(err)}`);
    if (!res.writableEnded) sendJson(res, 500, { error: 'internal_error', message: errText(err) });
  }
}

/**
 * 把宿主实际路径改写成 ADBP 内部路径：`/adbp/v1/tasks` → `/adbp/v1/tasks`（原样），
 * `/agentdeck-x/v1/tasks` → `/adbp/v1/tasks`（前缀可配时）。
 * 非 `/v1` 的路径原样返回，让 ingress 自己判定「不是我的」。
 */
function toAdbpPath(path, prefix) {
  const p = String(path || '/');
  if (p === ADBP_INTERNAL_PREFIX || p.startsWith(`${ADBP_INTERNAL_PREFIX}/`)) return p;
  if (prefix === ADBP_INTERNAL_PREFIX) return p;
  if (p === prefix) return p; // 状态页由上层拦截，不会走到这里
  if (p.startsWith(`${prefix}/`)) return `${ADBP_INTERNAL_PREFIX}${p.slice(prefix.length)}`;
  return p;
}

/** 出站把 self-describing 清单里的 /adbp/... 换成真实前缀，客户端照着清单就能调通。 */
function localizeManifest(payload, prefix) {
  if (prefix === ADBP_INTERNAL_PREFIX) return payload;
  if (!payload || typeof payload !== 'object') return payload;
  const swap = (value) => (typeof value === 'string' ? value.split(`${ADBP_INTERNAL_PREFIX}/`).join(`${prefix}/`) : value);
  const out = { ...payload };
  if (Array.isArray(out.endpoints)) {
    out.endpoints = out.endpoints.map((item) => (item && typeof item === 'object' ? { ...item, path: swap(item.path) } : item));
  }
  if (out.routes && typeof out.routes === 'object') {
    out.routes = Object.fromEntries(Object.entries(out.routes).map(([k, v]) => [k, swap(v)]));
  }
  if (typeof out.base === 'string') out.base = swap(out.base);
  return out;
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...corsHeaders(),
  });
  res.end(payload);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

/** 读请求体（JSON），带上限与错误语义；空体返回 undefined。 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.round(limit / 1024)}KB 上限`));
        try {
          req.destroy?.();
        } catch { /* 忽略 */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function safeList(fn) {
  try {
    const out = fn();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

function num0(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 「云房间 x/y」的展示：免费档的云房间配额是 0，直接写 0/0 会让人以为"用完了"，
 * 所以配额为 0 时改成一句人话；有配额时才显示 已用/总数。
 */
function cloudRoomText(lic, room) {
  const quota = num0(lic?.cloudRooms);
  const used = room?.roomId ? 1 : 0;
  if (quota <= 0) return '0（当前档位不含跨机房间）';
  return `${used}/${quota}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ════════════════════════════════════════════════════════════════════════
 * /deck 状态页：命令文本、HTML 页面、授权表单、ADBP /state 摘要
 *   三处展示同一份数据，所以先把取数逻辑写成一组纯函数（都可单独 try/catch），
 *   页面和命令只是排版不同——避免"网页上有、命令里没有"这种不一致。
 * ════════════════════════════════════════════════════════════════════════ */

/** 读自身 package.json 的版本号；读不到就写 dev，不让状态页因 IO 失败而崩。 */
function readVersion() {
  try {
    const file = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    return String(pkg.version || 'dev');
  } catch {
    return 'dev';
  }
}

/** 1.4 之前授权码在工作区里；升级后第一次读授权时把它搬到机级目录，别让已付费的人凭空掉档。 */
const licenseMigratedFrom = new Set();
function migrateWorkspaceLicense(env) {
  const api = env.licenseApi;
  if (!api || typeof api.writeLicenseKey !== 'function' || typeof api.licensePath !== 'function') return;
  try {
    const machineRoot = env.licenseRoot ? env.licenseRoot() : (env.root ? env.root() : process.cwd());
    const machineFile = String(api.licensePath(machineRoot) || '');
    if (!machineFile || existsSync(machineFile)) return; // 机级已经有了（或路径拿不到），不动
    const wsFile = String(api.licensePath(env.root ? env.root() : process.cwd()) || '');
    if (!wsFile || wsFile === machineFile || !existsSync(wsFile)) return; // 没有老文件 = 首次安装
    if (licenseMigratedFrom.has(wsFile)) return; // 同一次启动只尝试一次，别刷日志
    licenseMigratedFrom.add(wsFile);
    const key = readFileSync(wsFile, 'utf8').trim();
    if (!key) return;
    const wrote = api.writeLicenseKey(machineRoot, key);
    if (wrote?.ok) env.log?.info?.('授权文件已从工作区迁到机级目录');
    else env.log?.warn?.(`授权文件迁移失败（继续用工作区里的老授权）：${wrote?.reason || '未知原因'}`);
  } catch (err) {
    env.log?.warn?.(`授权文件迁移失败（不影响当前使用）：${errText(err)}`);
  }
}

/** 取当前授权档位（含到期日）。license 模块缺失时返回免费版，语义与工具一致。 */
function licenseSummary(env) {
  const api = env.licenseApi;
  // 授权跟人走：一律读机级目录（可用 cfg.licenseRoot 覆盖），不再读工作区
  const root = env.licenseRoot ? env.licenseRoot() : (env.root ? env.root() : process.cwd());
  let path = '';
  try {
    path = api && typeof api.licensePath === 'function' ? String(api.licensePath(root) || '') : '';
  } catch { path = ''; }
  const base = { tier: 'free', label: '免费版', exp: null, seats: null, maxSeats: null, cloudRooms: 0, entitlements: null, describe: '', reason: '', path };
  if (!api || typeof api.currentLicense !== 'function') {
    return { ...base, reason: '授权模块未加载，按免费版处理' };
  }
  migrateWorkspaceLicense(env);
  try {
    const lic = api.currentLicense(root);
    const ent = lic?.entitlements || {};
    const expMs = Number(lic?.claims?.exp) > 0 ? Number(lic.claims.exp) * 1000 : null;
    let exp = null;
    if (expMs) {
      const d = new Date(expMs);
      if (!Number.isNaN(d.getTime())) {
        exp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    }
    // 权益文案统一由 license.js 提供，避免"网页写 3 席、命令写 5 席"这种两处不一致
    let describe = '';
    try {
      describe = typeof api.describeEntitlements === 'function' ? String(api.describeEntitlements(ent) || '') : '';
    } catch { describe = ''; }
    return {
      tier: String(lic?.tier || 'free'),
      label: String(ent.label || '免费版'),
      exp,
      seats: lic?.claims?.seats ?? ent.maxSeats ?? null,
      maxSeats: ent.maxSeats ?? lic?.claims?.seats ?? null,
      cloudRooms: num0(ent.cloudRooms),
      entitlements: ent,
      describe,
      reason: lic?.ok ? '' : String(lic?.reason || ''),
      path,
    };
  } catch (err) {
    return { ...base, reason: `读授权失败：${errText(err)}` };
  }
}

/** 本机 CLI 探测结果（后台 detect() 填；没探到就写「未探测到」而不是崩）。 */
function cliList(env) {
  try {
    const rows = typeof env.registry?.list === 'function' ? env.registry.list() : [];
    return (Array.isArray(rows) ? rows : []).map((a) => String(a?.id || '')).filter(Boolean);
  } catch {
    return [];
  }
}

/** 取房间摘要：只读本地会话记录（不发网络），够状态页显示"在哪个房间、几个人"。 */
function roomSummary(env) {
  const root = env.root ? env.root() : process.cwd();
  // inviteWebUrl 是 relay 新版给的「没装 DSH 也能打开的加入页」；老 relay 没有，空串就只展示深链。
  const empty = { roomId: '', name: '', members: 0, names: [], inviteUrl: '', inviteWebUrl: '', active: false };
  try {
    const dir = join(root, '.agentdeck', 'rooms');
    if (!existsSync(dir)) return empty;
    const readOne = (file) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    };
    const last = readOne(join(dir, 'last.json')) || {};
    let roomId = String(last.roomId || '');
    if (!roomId) {
      // last.json 被清掉时兜底：取目录里最新的会话文件
      const rows = readdirSync(dir)
        .filter((f) => f.endsWith('.json') && f !== 'last.json')
        .map((f) => {
          const p = join(dir, f);
          let at = 0;
          try { at = statSync(p).mtimeMs; } catch { at = 0; }
          return { p, at };
        })
        .sort((a, b) => b.at - a.at);
      for (const row of rows) {
        const data = readOne(row.p);
        if (data?.roomId) {
          roomId = String(data.roomId);
          break;
        }
      }
    }
    if (!roomId) return empty;
    const names = Array.isArray(last.members)
      ? last.members.map((m) => String(m?.name || m?.seatId || '')).filter(Boolean)
      : [];
    return {
      roomId,
      name: String(last.name || ''),
      members: names.length,
      names,
      inviteUrl: String(last.inviteUrl || ''),
      inviteWebUrl: String(last.inviteWebUrl || ''),
      active: !last.closed && !last.leftAt,
    };
  } catch {
    return empty;
  }
}

/** 任务板计数 + 最近 3 条，跨所有小组汇总（状态页不要求用户先选组）。 */
function boardSummary(board) {
  const teams = safeList(() => board?.listTeams?.());
  const totals = { teams: teams.length, pending: 0, running: 0, done: 0, failed: 0, total: 0 };
  const latest = [];
  for (const team of teams) {
    for (const task of safeList(() => board?.listTasks?.(team.id))) {
      totals.total += 1;
      const status = String(task.status || 'pending');
      if (status === 'running') totals.running += 1;
      else if (status === 'done') totals.done += 1;
      else if (status === 'failed') totals.failed += 1;
      else totals.pending += 1;
      latest.push({
        id: String(task.id || ''),
        title: String(task.title || ''),
        status,
        teamId: String(team.id || ''),
        updatedAt: Number(task.updatedAt || task.createdAt || 0) || 0,
      });
    }
  }
  latest.sort((a, b) => b.updatedAt - a.updatedAt);
  return { ...totals, latest: latest.slice(0, 3) };
}

/** 桌宠摘要：皮肤 + 最靠前 3 条习惯。档案坏了就当"没养"处理。 */
function petSummary(env) {
  const empty = { name: '小助', skin: 'basic', habits: [], tasksDone: 0, activeDays: 0 };
  const store = env.petStore;
  if (!store || typeof store.get !== 'function') return empty;
  try {
    const profile = store.get() || {};
    const habits = (Array.isArray(profile.habits) ? profile.habits : [])
      .slice()
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0) || Number(b.evidence || 0) - Number(a.evidence || 0))
      .slice(0, 3)
      .map((h) => ({ label: String(h.label || h.key || ''), evidence: Number(h.evidence || 0) }));
    return {
      name: String(profile.name || '小助'),
      skin: String(profile.skins?.active || 'basic'),
      habits,
      tasksDone: Number(profile.stats?.tasksDone || 0),
      activeDays: Array.isArray(profile.days) ? profile.days.length : 0,
    };
  } catch {
    return empty;
  }
}

/** ADBP `GET /state` 的两个附加摘要（协议字段只增不改）。 */
function deckStateExtras(env) {
  const lic = licenseSummary(env);
  const room = roomSummary(env);
  return {
    license: { tier: lic.tier, exp: lic.exp, seats: lic.seats, label: lic.label, path: lic.path },
    room: { roomId: room.roomId, members: room.members, name: room.name, active: room.active },
  };
}

/** relay 地址：配置优先，其次环境变量（自建 relay 常用环境变量快速验证）。 */
function relayUrlOf(cfg) {
  const raw = cfg?.cloud?.relayUrl || cfg?.relayUrl || process.env.AGENTDECK_RELAY_URL || '';
  return String(raw).trim().replace(/\/+$/, '');
}

/** 拼出 /deck 里「下一步三步」——用户最缺的从来不是功能，是"现在该点哪"。 */
function nextSteps(cfg, lic, room) {
  const prefix = String(cfg.routePrefix || '/adbp');
  return [
    `① 起一个小组：让 Agent 调 team_orchestrate（或 team_board action=create），把要交付的目标写清楚。`,
    room.roomId && room.active
      ? `② 拉同事进来：deck_room info 看邀请链接，整条发给对方；对方 deck_room join 贴进来。`
      : `② 拉同事进来：deck_room create 建房间 → 拿到 dsh:// 邀请链接发给对方（当前档位：${lic.label}）。`,
    lic.tier === 'free'
      ? `③ 解锁跨机：deck_license plans 看价格 → 付款后 deck_license activate 粘贴授权码，或打开 /deck 页面粘贴。`
      : `③ 保持同步：两边每隔一会儿 deck_room sync 一次，任务板自动合并（当前档位：${lic.label}）。`,
    `附：ADBP 入口 ${prefix}/v1/manifest；网页状态页 /deck。`,
  ];
}

/** `/deck` 的命令文本版状态页。 */
function deckStatusText(env) {
  const { cfg, board, registered } = env;
  const lic = licenseSummary(env);
  const room = roomSummary(env);
  const sum = boardSummary(board);
  const pet = petSummary(env);
  const clis = cliList(env);
  const where = safeString(() => board?.location?.());
  const lines = [
    `agentdeck-super v${env.version || 'dev'} · ${lic.label}${lic.exp ? `（到期 ${lic.exp}）` : ''}`,
    `授权：档位 ${lic.label} · 剩余席位 ${Math.max(0, num0(lic.maxSeats) - room.members)}/${lic.maxSeats ?? '—'}（本机已进 ${room.members} 人）· 云房间 ${cloudRoomText(lic, room)}`,
    `工作区：${cfg.workspace || process.cwd()}`,
    `授权文件：${lic.path || '（未取到路径）'}（跟人走，不跟项目走）`,
    `本机 CLI：${clis.length ? clis.join('、') : '（未探测到，team_orchestrate 会退化成单机模式）'}`,
    `任务板：${typeof where === 'string' && where ? where : '(内存)'} · ${sum.teams} 个小组 · 待办 ${sum.pending} / 进行中 ${sum.running} / 完成 ${sum.done}${sum.failed ? ` / 失败 ${sum.failed}` : ''}`,
  ];
  if (lic.describe) lines.splice(2, 0, `权益（${lic.describe}）`);
  if (sum.latest.length) {
    lines.push('最近 3 条：');
    for (const t of sum.latest) lines.push(`  · [${t.status}] ${clipText(t.title, 60)}（${t.teamId}）`);
  } else {
    lines.push('最近 3 条：（还没有任务）');
  }
  const roomLine = room.roomId
    ? `房间：${room.roomId}${room.name ? `（${room.name}）` : ''} · ${room.active ? '进行中' : '已关闭/已退出'} · 成员 ${room.members} 人${room.names.length ? `：${room.names.slice(0, 6).join('、')}` : ''}`
    : '房间：还没进房间（单人单机不需要）';
  lines.push(roomLine);
  // 房间开着时把两条邀请链接直接摊在状态里：房主想再拉人不用重跑 create。
  if (room.roomId && room.active && room.inviteUrl) {
    lines.push(`  装了 DSH：${room.inviteUrl}${room.inviteWebUrl ? ` · 没装 DSH：${room.inviteWebUrl}` : ''}`);
  }
  lines.push(`桌宠：皮肤 ${pet.skin}${pet.name && pet.name !== '桌宠' ? `（${pet.name}）` : ''}${pet.habits.length ? ` · ${pet.habits.map((h) => h.label).join('；')}` : ' · 还在观察你的习惯'}`);
  lines.push(`工具 ${registered.length} 个：${registered.length ? registered.join('、') : '（无）'}`);
  lines.push(`ADBP：${cfg.routePrefix}/v1/manifest${relayUrlOf(cfg) ? ` · relay ${relayUrlOf(cfg)}` : ' · 未配 relay（跨机不可用）'}`);
  lines.push('', '下一步三步：', ...nextSteps(cfg, lic, room));
  return lines.join('\n');
}

/** `/deck` 的 HTML 版状态页：自包含，无外链、无 CDN、无 JS 依赖（表格提交用原生 form）。 */
function deckPageHtml(env, query) {
  const { cfg, registered } = env;
  const lic = licenseSummary(env);
  const room = roomSummary(env);
  const sum = boardSummary(env.board);
  const pet = petSummary(env);
  const relay = relayUrlOf(cfg);
  const banner = query?.get?.('license');
  const bannerHtml = banner === 'ok'
    ? '<p class="ok">授权码已写入，重启会话后按新档位生效。</p>'
    : banner === 'bad'
      ? '<p class="bad">授权码没通过校验，文件没有写入（旧档位不变）。</p>'
      : banner === 'err'
        ? '<p class="bad">写授权文件失败，请检查机级目录（$DSH_HOME/agentdeck-super）是否可写。</p>'
        : '';
  const habitHtml = pet.habits.length
    ? `<ul>${pet.habits.map((h) => `<li>${esc(h.label)}（出现 ${num0(h.evidence)} 次）</li>`).join('')}</ul>`
    : '<p class="muted">还没有足够的行为数据。</p>';
  const latestHtml = sum.latest.length
    ? `<ul>${sum.latest.map((t) => `<li><span class="tag ${esc(t.status)}">${esc(t.status)}</span> ${esc(clipText(t.title, 80))} <span class="muted">${esc(t.teamId)}</span></li>`).join('')}</ul>`
    : '<p class="muted">还没有任务。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentdeck-super · 状态</title><style>
body{font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:32px 28px 64px;color:#1f2328;background:#fff}
h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:26px 0 6px;color:#3d444d}
code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:13px}
.muted{color:#656d76}.ok{color:#1a7f37;background:#eaf6ec;padding:8px 12px;border-radius:6px}
.bad{color:#b42318;background:#fdeceb;padding:8px 12px;border-radius:6px}
table{border-collapse:collapse;margin-top:8px}th,td{border:1px solid #e2e6ea;padding:6px 10px;text-align:left}
th{background:#f7f8fa;font-weight:600}
.tag{display:inline-block;font-size:12px;padding:0 6px;border-radius:4px;background:#eef1f4}
.tag.done{background:#e6f4ea;color:#1a7f37}.tag.running{background:#e8f0fe;color:#1a56db}
.tag.failed{background:#fdeceb;color:#b42318}
form{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
input[type=text]{flex:1;min-width:260px;padding:7px 10px;border:1px solid #d0d7de;border-radius:6px;font:inherit}
button{padding:7px 16px;border:0;border-radius:6px;background:#1f6feb;color:#fff;font:inherit;cursor:pointer}
.pet{display:flex;gap:14px;align-items:center;margin-top:6px}
.card{max-width:820px}
</style></head><body><div class="card">
<h1>agentdeck-super v${esc(env.version || 'dev')}</h1>
<div class="muted">超级 Agent 与异构 Agent 小组 · 运行中</div>
${bannerHtml}
<h2>当前档位</h2>
<p>${esc(lic.label)}${lic.exp ? `（到期 ${esc(lic.exp)}）` : ''} · 席位 ${lic.maxSeats ?? '—'} · 云房间 ${esc(cloudRoomText(lic, room))}${lic.reason ? ` · <span class="muted">${esc(lic.reason)}</span>` : ''}</p>
${lic.describe ? `<p class="muted">${esc(lic.describe)}</p>` : ''}
${lic.path ? `<p class="muted">授权文件：<code>${esc(lic.path)}</code>（跟人走：换项目目录不用重新激活，换台机器要重新激活）</p>` : ''}
${lic.tier === 'free'
    ? `<form method="post" action="${esc(cfg.routePrefix)}/deck/license">
         <input type="text" name="key" placeholder="粘贴授权码（ADSK1 开头）解锁跨机房间" autocomplete="off">
         <button type="submit">启用</button>
       </form>`
    : '<p class="muted">已启用付费档位；续费时在上面同样的位置粘贴新授权码即可。</p>'}
<h2>房间</h2>
<p>${room.roomId
    ? `${esc(room.roomId)}${room.name ? `（${esc(room.name)}）` : ''} · ${room.active ? '进行中' : '已关闭/已退出'} · 成员 ${room.members} 人${room.names.length ? `：${esc(room.names.slice(0, 8).join('、'))}` : ''}`
    : '<span class="muted">还没进房间（单人单机不需要）</span>'}</p>
${room.roomId && room.active && (room.inviteUrl || room.inviteWebUrl)
    ? `<p class="muted">拉人进来：${room.inviteUrl ? `装了 DSH 的发 <code>${esc(room.inviteUrl)}</code>` : ''}${room.inviteUrl && room.inviteWebUrl ? '；' : ''}${room.inviteWebUrl ? `没装 DSH 的发 <code>${esc(room.inviteWebUrl)}</code>（网页加入页）` : ''}</p>`
    : ''}
<h2>任务板</h2>
<p>${sum.teams} 个小组 · 待办 ${num0(sum.pending)} / 进行中 ${num0(sum.running)} / 完成 ${num0(sum.done)}${sum.failed ? ` / 失败 ${num0(sum.failed)}` : ''}</p>
${latestHtml}
<h2>桌宠</h2>
<div class="pet">
  <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="桌宠占位图">
    <rect x="8" y="10" width="48" height="44" rx="12" fill="#eef3ff" stroke="#9db4e6"/>
    <circle cx="24" cy="30" r="4" fill="#3d444d"/><circle cx="40" cy="30" r="4" fill="#3d444d"/>
    <path d="M24 42 q8 6 16 0" stroke="#3d444d" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  </svg>
  <div><div>${esc(pet.name)} · 皮肤 <code>${esc(pet.skin)}</code></div>
  <div class="muted">累计完成 ${num0(pet.tasksDone)} 个任务，活跃 ${num0(pet.activeDays)} 天</div></div>
</div>
${habitHtml}
<h2>下一步三步</h2>
<ol>${nextSteps(cfg, lic, room).filter((s) => !s.startsWith('附：')).map((s) => `<li>${esc(s.replace(/^[①②③]\s*/, ''))}</li>`).join('')}</ol>
<h2>入口</h2>
<p>ADBP：<code>${esc(cfg.routePrefix)}/v1/manifest</code> · <code>${esc(cfg.routePrefix)}/v1/state</code><br>
本机 CLI：${(() => { const clis = cliList(env); return clis.length ? clis.map((c) => `<code>${esc(c)}</code>`).join(' ') : '<span class="muted">未探测到（会退化成单机模式）</span>'; })()}<br>
relay：${relay ? `<code>${esc(relay)}</code>` : '<span class="muted">未配置（跨机房间不可用，本地不受影响）</span>'}<br>
工具 ${registered.length} 个：${registered.length ? registered.map((t) => `<code>${esc(t)}</code>`).join(' ') : '<span class="muted">（无）</span>'}</p>
</div></body></html>`;
}

/** `/deck` 页面与 `/adbp/deck/license` 表单共用：解析表单/JSON 请求体。 */
async function readRawBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.round(limit / 1024)}KB 上限`));
        try { req.destroy?.(); } catch { /* 忽略 */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

/** 从表单（urlencoded）或 JSON 里取授权码。 */
function pickLicenseKey(raw, contentType) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/json/i.test(String(contentType || '')) || text.startsWith('{')) {
    try {
      const body = JSON.parse(text);
      return String(body.key ?? body.license ?? body.code ?? '').trim();
    } catch {
      return '';
    }
  }
  const params = new URLSearchParams(text);
  return String(params.get('key') ?? params.get('license') ?? params.get('code') ?? '').trim();
}

/**
 * 处理授权码提交（POST /adbp/deck/license）：
 *   - 浏览器表单（/deck 页面里的 <form>）→ 写文件后 303 回 /deck?license=ok|bad|err
 *   - JSON 调用（脚本/curl -H 'content-type: application/json' -d '{"key":"…"}'）
 *     → 回 { ok, tier, expiresAt } / { ok:false, reason }
 * 任何情况都不抛：写失败也只是把人话 reason 回给调用方。
 */
async function handleDeckLicense(req, res, { deckEnv, method }) {
  const env = deckEnv || {};
  const api = env.licenseApi;
  const contentType = String(req?.headers?.['content-type'] || '');
  const acceptHeader = String(req?.headers?.accept || '');
  const respondJson = (code, payload) => {
    sendJson(res, code, payload);
  };
  if (method !== 'POST') {
    respondJson(405, { ok: false, reason: '请用 POST 提交（JSON {"key":"授权码"} 或 /deck 页面上的表单）' });
    return;
  }
  if (!api || typeof api.writeLicenseKey !== 'function' || typeof api.verifyLicense !== 'function') {
    respondJson(503, { ok: false, reason: 'lib/license.js 未加载，无法写入授权码' });
    return;
  }
  const raw = await readRawBody(req);
  const key = pickLicenseKey(raw, contentType);
  const isJsonCall = /json/i.test(contentType) || /json/i.test(acceptHeader) || String(raw).trim().startsWith('{');
  const finish = (code, payload, banner) => {
    if (isJsonCall) {
      sendJson(res, code, payload);
      return;
    }
    // 表单提交：回状态页并用 query 带一句话结论（页面顶部渲染成横幅）
    res.writeHead(303, { location: `/deck?license=${encodeURIComponent(banner)}`, 'cache-control': 'no-store' });
    res.end();
  };
  if (!key) {
    finish(400, { ok: false, reason: 'key 不能为空' }, 'bad');
    return;
  }
  let check = null;
  try {
    check = api.verifyLicense(key);
  } catch (err) {
    finish(500, { ok: false, reason: `校验失败：${errText(err)}` }, 'bad');
    return;
  }
  if (!check?.ok) {
    finish(400, { ok: false, tier: 'free', reason: String(check?.reason || check?.code || '授权码无效') }, 'bad');
    return;
  }
  const root = env.licenseRoot ? env.licenseRoot() : (env.root ? env.root() : process.cwd());
  let wrote = null;
  try {
    wrote = api.writeLicenseKey(root, key);
  } catch (err) {
    finish(500, { ok: false, reason: `写授权文件失败：${errText(err)}` }, 'err');
    return;
  }
  if (!wrote?.ok) {
    finish(500, { ok: false, reason: String(wrote?.reason || '写授权文件失败（机级目录不可写？）') }, 'err');
    return;
  }
  const expSec = Number(check?.claims?.exp) || 0;
  const expiresAt = expSec ? new Date(expSec * 1000).toISOString() : null;
  try {
    env.log?.info?.(`授权码已写入：${wrote.path || ''}（${check.tier} 档，到期 ${expiresAt || '无期限'}）`);
  } catch { /* 忽略 */ }
  finish(200, { ok: true, tier: String(check.tier || 'free'), expiresAt, path: String(wrote.path || '') }, 'ok');
}

/** `/deck` 网页状态页入口（GET 出页面，其它方法给人话）。 */
function handleDeckPage(req, res, { deckEnv }) {
  const method = String(req?.method || 'GET').toUpperCase();
  let query = null;
  try {
    query = new URL(String(req?.url || '/deck'), 'http://127.0.0.1').searchParams;
  } catch {
    query = null;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed', hint: 'GET /deck' });
    return;
  }
  try {
    sendHtml(res, deckPageHtml(deckEnv || {}, query));
  } catch (err) {
    // 状态页自己崩了也不能让宿主挂：退化成一个最小页面
    sendHtml(res, `<!doctype html><meta charset="utf-8"><title>agentdeck-super</title><p>状态页渲染失败：${esc(errText(err))}</p>`);
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * 斜杠命令
 * ════════════════════════════════════════════════════════════════════════ */

/** `/deck [status|board|teams|license <授权码>|help]`；宿主命令 handler 只允许返回 {kind, text}。 */
function runDeckCommand(invocation, env) {
  const raw = String(invocation?.rawInput ?? '').trim();
  const parts = raw ? raw.split(/\s+/) : [];
  const sub = (parts[0] || 'status').toLowerCase();
  try {
    if (sub === 'help') {
      return ok([
        '/deck                 状态页（版本/档位/房间/任务板/桌宠/下一步三步）',
        '/deck board           各组任务明细',
        '/deck teams           小组列表',
        '/deck license <授权码> 启用授权码（同 deck_license activate）',
        `/ADBP：GET ${env.cfg.routePrefix}/v1/manifest`,
      ].join('\n'));
    }
    if (sub === 'license') {
      const key = parts.slice(1).join(' ').trim();
      if (!key) return { kind: 'error', text: '用法：/deck license <授权码>（整串 ADSK1…）' };
      const api = env.licenseApi;
      if (!api || typeof api.verifyLicense !== 'function' || typeof api.writeLicenseKey !== 'function') {
        return { kind: 'error', text: '授权模块未加载（lib/license.js 缺失），无法写入授权码。' };
      }
      const check = api.verifyLicense(key);
      if (!check?.ok) return { kind: 'error', text: `授权码没通过校验：${check?.reason || check?.code || '无效'}（没有写入）` };
      const wrote = api.writeLicenseKey(env.licenseRoot ? env.licenseRoot() : (env.root ? env.root() : process.cwd()), key);
      if (!wrote?.ok) return { kind: 'error', text: `写授权文件失败：${wrote?.reason || '未知原因'}` };
      // 给用户看中文档位名（免费版/协作版/工作室版），别把内部 id（pro）甩到人脸上
      const label = env.licenseApi?.entitlements?.(check.tier)?.label || check.tier;
      return ok(`授权码已写入（${label}），重启会话后生效。\n授权文件：${wrote.path || ''}`);
    }
    if (sub === 'teams') {
      const teams = safeList(() => env.board?.listTeams?.());
      if (!teams.length) return ok('还没有小组。用 team_board action=create 建一个。');
      return ok(teams.map((t) => `· ${t.id} ${t.name || ''} — ${t.goal || '(无目标)'}（成员 ${safeList(() => env.board.listMembers(t.id)).length}）`).join('\n'));
    }
    if (sub === 'board') {
      const teams = safeList(() => env.board?.listTeams?.());
      if (!teams.length) return ok('还没有小组。用 team_board action=create 建一个。');
      const lines = [];
      for (const team of teams) {
        const stats = safeList(() => [env.board.stats(team.id)])[0] || {};
        lines.push(`【${team.name || team.id}】完成 ${num0(stats.done)}/${num0(stats.total)}，进行中 ${num0(stats.running)}，失败 ${num0(stats.failed)}`);
        for (const task of safeList(() => env.board.listTasks(team.id))) {
          lines.push(`  · [${task.status}] ${task.title}${task.assignee ? ` @${task.assignee}` : ''}`);
        }
      }
      return ok(lines.join('\n'));
    }
    if (sub === 'status') return ok(deckStatusText(env));
    return { kind: 'error', text: `未知子命令：${sub}（可用：status / board / teams / license <授权码> / help）` };
  } catch (err) {
    return { kind: 'error', text: `deck 命令失败：${errText(err)}` };
  }
}

function ok(text) {
  return { kind: 'success', text: String(text) };
}

function safeString(fn) {
  try {
    return fn() ?? '';
  } catch {
    return '';
  }
}
