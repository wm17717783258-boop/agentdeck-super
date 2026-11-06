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
// 宿主接入（MCP）：状态页要能如实显示"这台机器上哪些 Agent 已经接进来了"
import { detectHosts, launchCommand } from './connect/hosts.js';
// 只读模式的策略表：清单页也要按它过滤，保证「网页上看到的」= 「真能调的」
import { readonlyToolNames } from './mcp/readonly.js';
import { consolePageHtml, parseConsoleSubmit } from './console.js';
// 产品主页渲染层（1.9.0 起 `/deck` 是产品，不是诊断页）：纯函数、零 I/O，数据由这里组装
import { deckPageHtml as renderDeckPage } from './deck.js';

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
      purchaseUrl: z.string().default('').description('收款/购买页地址；留空时价格表只报价格，不给假链接。'),
      cloud: z.object({
        relayUrl: z.string().default('').description('跨机房间的 relay 地址，如 http://127.0.0.1:8787；留空读环境变量 AGENTDECK_RELAY_URL。'),
      }).description('跨机房间（云房间）配置。'),
      relayUrl: z.string().default('').description('relay 地址的扁平写法（等价 cloud.relayUrl，老配置兼容）。'),
      automation: z.object({
        enabled: z.boolean().default(true).description('自动化巡检（定时任务/审批）总开关；关掉后工具还在，但到点不会自己动。'),
        tickMs: z.number().default(30000).description('巡检间隔（毫秒），最小 1000。'),
      }).description('定时任务与审批的巡检配置。'),
      mcp: z.object({
        readOnly: z.boolean().default(false).description('MCP 只读模式：任务板/分身/桌宠只给看，写动作（建组、派活、串门、改画像、跑自动化）直接拒。适合把本机 Hub 借给别人的模型用。'),
      }).description('MCP 端点策略。'),
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
  // 真的注册成功的工具定义本体（不只是名字）：Streamable HTTP 端点要拿它们当 tools/list 的来源，
  // 这样 HTTP 端点和宿主工具带里看到的永远是同一批工具，不会出现「网页上有、HTTP 上没有」。
  const definitions = [];

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
  // 桌宠的数字分身：事件出口顺手把活动喂给档案学习惯。这里先立空壳，
  // 等 2.5 节桌宠模块加载完再把 store/observe 装进去（桌宠没加载就一直空着，不影响别处）。
  const petSink = { store: null, observe: null, board, record: null };
  const emit = makeEmit(ctx, board, log, petSink);
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
  let petActivity = null;
  try {
    const petProfile = await import('./pet/profile.js');
    if (typeof petProfile.createProfileStore === 'function') {
      petStore = petProfile.createProfileStore({ root: cfg.petRoot || globalStateRoot() });
    }
    // 活动 → 习惯：把宿主真实动作翻译成桌宠事件，别让"学习习惯"只存在于演示脚本里。
    petActivity = await import('./pet/activity.js');
    petSink.store = petStore;
    petSink.observe = typeof petProfile.observe === 'function' ? petProfile.observe : null;
    if (petStore && petActivity && typeof petActivity.observeActivity === 'function') {
      petSink.record = (type, data) => {
        try {
          petActivity.observeActivity(petSink, type, data || {});
        } catch { /* 桌宠学不到习惯不算故障，主流程优先 */ }
      };
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
  // 皮肤模块：状态页要画真皮肤（不是占位图），所以单独拿一份引用。
  let skinsApi = null;
  try {
    skinsApi = await import('./pet/skins.js');
  } catch (err) {
    log.info(`皮肤模块没加载（状态页退化为占位图）：${errText(err)}`);
  }

  const version = readVersion();

  // 授权迁移必须在启动时跑一次：不能等用户打开 /deck 才迁——
  // 升级后先问 deck_license、或先建云房间的人，读到的还是机级空目录，当场掉回免费版。
  // 字段和 deckEnv 保持一致（licenseApi / licenseRoot / root / log）；失败只 warn。
  const licenseEnv = { licenseApi, licenseRoot, root: stateRoot, log };
  migrateWorkspaceLicense(licenseEnv);

  // 分身记忆（M2）：工具与状态页共用同一份实现；这里加载失败只少了这一块展示，绝不拖垮启动。
  let twinApi = null;
  try {
    const [contextMod, memoryMod] = await Promise.all([
      import('./twin/context.js'),
      import('./twin/memory.js'),
    ]);
    twinApi = { ...memoryMod, ...contextMod };
  } catch (err) {
    log.warn(`分身记忆模块加载失败（只影响状态页那一块）：${errText(err)}`);
  }

  // 通行证（M4.5）：主页的「卡包」要能显示本机身份 kid 和已签出的卡。
  // 这里只读不写——identitySummary 用 create:false 调用，绝不因为在主页上刷一下
  // 就偷偷生成一对密钥（那是"非变更操作不得铸新身份"的硬约束）。
  let identityApi = null;
  try {
    identityApi = await import('./identity.js');
  } catch (err) {
    log.info(`通行证模块没加载（主页卡包区隐藏）：${errText(err)}`);
  }

  // 皮肤市场 + 支付抽象层 + 配额（1.9.0）：三者都是可选加载。
  // 缺文件时对应工具降级成「只能买免费皮肤 / 不拦配额」，绝不拖垮启动。
  // 账本落在机级目录（跟人走）：换项目目录不该丢掉买过的皮肤和订单。
  const ledgerRoot = (() => {
    try { return String(licenseRoot()); } catch { return String(stateRoot()); }
  })();
  let marketApi = null;
  let billingApi = null;
  let quotaApi = null;
  // 可选模块加载失败不该静默：主页会把这几行摆出来，用户能一眼看到「哪块没了、为什么」。
  const loadIssues = [];
  try {
    const { createMarket, billingFromEnv } = await import('./market/index.js');
    // 市场自己的下单通道：只要 AGENTDECK_PAY_PROVIDER + AGENTDECK_PAY_URL 都在，就是真渠道
    const envBill = billingFromEnv(process.env);
    marketApi = createMarket({
      root: ledgerRoot,
      license: (() => { try { return licenseApi?.currentLicense?.() ?? null; } catch { return null; } })(),
      billing: envBill && envBill.ok ? envBill.adapter : null,
    });
    if (marketApi && marketApi.ok === false) {
      log.info(`皮肤市场没建起来（工具会说明原因）：${marketApi.reason}`);
      loadIssues.push(`皮肤市场：${marketApi.reason}`);
    }
  } catch (err) {
    log.info(`皮肤市场模块没加载（市场功能不可用）：${errText(err)}`);
    loadIssues.push(`皮肤市场加载失败：${errText(err)}`);
  }
  try {
    const { createBilling } = await import('./billing/index.js');
    // 这里只做「渠道配没配」的诚实体检 + 真实下单能力；没配一律 configured:false
    billingApi = createBilling({
      provider: String(process.env.AGENTDECK_PAY_PROVIDER || '').trim() || null,
      root: ledgerRoot,
    });
  } catch (err) {
    log.info(`支付抽象层没加载（deck_market health 会说明）：${errText(err)}`);
    loadIssues.push(`支付渠道加载失败：${errText(err)}`);
  }
  try {
    const { createQuota } = await import('./quota.js');
    quotaApi = createQuota({ tiers: licenseApi?.TIERS });
  } catch (err) {
    log.info(`配额模块没加载（不做配额拦截）：${errText(err)}`);
    loadIssues.push(`配额模块加载失败：${errText(err)}`);
  }

  // 1.10.0：策略门控（policy.json）+ 审计流（audit.jsonl）。
  // 两个模块都是本地纯函数 + 文件读写，加载失败只影响「门控/留痕」，工具照常注册。
  let policyApi = null;
  let auditApi = null;
  try {
    policyApi = await import('./policy/engine.js');
    auditApi = await import('./policy/audit.js');
  } catch (err) {
    log.info(`策略/审计模块没加载（工具不做门控，只留启动日志）：${errText(err)}`);
    loadIssues.push(`策略模块加载失败：${errText(err)}`);
  }
  // 对外协议网关（OpenAPI 3.1 + A2A）：同样失败不挡启动，只是少两个协议面。
  let gatewayApi = null;
  try {
    gatewayApi = await import('./gateway/index.js');
  } catch (err) {
    log.info(`网关模块没加载（OpenAPI/A2A 不可用）：${errText(err)}`);
    loadIssues.push(`网关加载失败：${errText(err)}`);
  }

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
    skins: skinsApi,
    // 桌宠工具内部认的是 deps.profile（而不是 deps.pet）：不显式传它，
    // storeOf() 会拿 root（工作区）现建一个档案 store，桌宠档案就又按项目隔离了。
    profile: petStore,
    // 工具可能在任何页面之前被单独调用：把同一个迁移函数交给工具复用，避免逻辑复制两份。
    migrateLicense: () => migrateWorkspaceLicense(licenseEnv),
    twin: twinApi,
    // 1.9.0：皮肤市场 / 支付渠道 / 配额判定（任一为 null 时工具自己降级说人话）
    market: marketApi,
    billing: billingApi,
    quota: quotaApi,
  };

  // ── 2.5 策略门控 + 审计流 ────────────────────────────────────────────────
  // 根目录必须和 deck_policy / deck_audit 工具用的同一个（工具用 deps.root() = stateRoot），
  // 否则用户在 deck_policy set 的规则对真实调用不生效 —— 两边得是同一份 policy.json。
  const guardRoot = () => {
    try {
      return stateRoot();
    } catch {
      return String(cfg.workspace || process.cwd());
    }
  };

  /** 记一条审计。best-effort：审计写不进去绝不影响工具本身的返回值。 */
  const auditOf = (record) => {
    if (!auditApi) return;
    try {
      auditApi.appendAudit(guardRoot(), { ...record, source: 'tool' });
    } catch (err) {
      log.info(`审计没写进去（不影响调用）：${errText(err)}`);
    }
  };

  /** deck_* 系工具的动作名都在 action 里；别的工具没有这个参数，就是空串。 */
  const actionOf = (args) => {
    const a = args && typeof args === 'object' ? args : {};
    return String(a.action ?? a.op ?? a.operation ?? '').trim();
  };

  /** 把工具返回值压成一行，给审计用（工具可能返回字符串，也可能返回 {text}）。 */
  const summarizeCall = (out) => {
    const text = typeof out === 'string'
      ? out
      : out && typeof out === 'object'
        ? String(out.text ?? '')
        : '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  };

  /** strict 打开后，动作分级判出的"需确认"（付款/删除/发消息/外部写入）才真拦。 */
  const strictConfirm = () => {
    if (String(process.env.AGENTDECK_POLICY_STRICT || '').trim() === '1') return true;
    try {
      return policyApi.loadPolicy(guardRoot()).policy.strict === true;
    } catch {
      return false;
    }
  };

  /**
   * 给每个工具包一层「策略 + 审计」。拦截语义写清楚，免得有人以为默认全拦：
   *   · 规则 deny / 预算超限      → 一律拒绝，工具不执行（唯一的硬拦截，永远生效）
   *   · 规则 confirm（显式规则）   → 要求入参带 confirm:true，否则不执行
   *   · 动作分级 confirm（无规则，付款/删除/发消息/外部写入）
   *                              → 只有 policy.json 的 strict:true 或 AGENTDECK_POLICY_STRICT=1 才强制，
   *                                默认放行（写成默认强制会把 buy/forget 这类日常动作全打断）
   *   · allow / 没命中            → 放行
   */
  const guarded = (definition) => {
    const inner = definition && definition.execute;
    if (typeof inner !== 'function' || !policyApi || typeof policyApi.decide !== 'function') return definition;
    const name = definition.name;
    definition.execute = async (args, callCtx) => {
      const request = { tool: name, action: actionOf(args), cost: 1 };
      const started = Date.now();
      let verdict = null;
      try {
        verdict = policyApi.decide(policyApi.loadPolicy(guardRoot()).policy, request);
      } catch (err) {
        log.info(`策略判定失败，按放行处理：${errText(err)}`);
      }
      if (verdict && verdict.effect === 'deny') {
        const why = verdict.reason || '策略不允许';
        auditOf({ tool: name, action: request.action, result: 'denied', text: why, durationMs: Date.now() - started });
        return `【策略拒绝】${why}。工具 ${name} 没有执行。（deck_policy show 看规则，deck_policy set 改规则）`;
      }
      const a = args && typeof args === 'object' ? args : {};
      const confirmed = a.confirm === true || a.confirmed === true;
      const needsConfirm = verdict && verdict.effect === 'confirm'
        && Boolean(verdict.matchedRuleId || strictConfirm());
      if (needsConfirm && !confirmed) {
        const why = verdict.reason || '这一步要你确认';
        auditOf({ tool: name, action: request.action, result: 'needs_confirm', text: why, durationMs: Date.now() - started });
        return `【需要确认】${why}。确认请在参数里带 confirm:true 再调一次；工具 ${name} 这次没有执行。`;
      }

      let out;
      try {
        out = await inner(args, callCtx);
      } catch (err) {
        auditOf({ tool: name, action: request.action, result: 'failed', text: errText(err), durationMs: Date.now() - started });
        throw err;
      }
      // 记账只在真执行后做：被拒的调用没发生，记进去会把「试图越界」和「真干了」混成一堆。
      try {
        const loaded = policyApi.loadPolicy(guardRoot());
        const next = policyApi.recordUsage(loaded.policy, request);
        policyApi.savePolicy(guardRoot(), next.policy);
      } catch (err) {
        log.info(`策略记账失败（不影响调用）：${errText(err)}`);
      }
      auditOf({ tool: name, action: request.action, result: 'ok', text: summarizeCall(out), durationMs: Date.now() - started });
      return out;
    };
    return definition;
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
      // 1.7 新增：跨厂商会议 + 定时/审批/全局停止（M4）
      ['./meeting/tool.js', 'createMeetingTool', 'deck_meeting'],
      ['./automation/index.js', 'createAutomationTool', 'deck_automation'],
      // 1.8 新增：Agent 通行证 v1（Ed25519 能力卡，M4.5 ⑥）
      ['./tools/identity.js', 'createPassportTool', 'agent_passport'],
      // 1.9 新增：皮肤市场（看货架 / 下单 / 订单 / 退款 / 支付渠道体检）
      ['./tools/market.js', 'createMarketTool', 'deck_market'],
      // 1.10 新增：团队空间（席位/成员/共享记忆/审计导出）、动作策略、审计流
      ['./tools/team.js', 'createDeckTeamTool', 'deck_team'],
      ['./tools/policy.js', 'createPolicyTool', 'deck_policy'],
      ['./tools/audit.js', 'createAuditTool', 'deck_audit'],
      // 1.10.0：跨设备同步（加密 Sync）—— 蓝图的付费触发点之一
      ['./tools/sync.js', 'createSyncTool', 'deck_sync'],
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
        tools.register(guarded(definition));
        registered.push(definition.name);
        definitions.push(definition);
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
            tools.register(guarded(definition));
            registered.push(definition.name);
            definitions.push(definition);
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

    // 1.5 分身记忆（M2）：形状和桌宠工具一样是数组，适配方式一致；
    // 缺模块/缺档都只跳过这 5 个工具，不影响其它能力。
    try {
      const mod = await import('./twin/index.js');
      const factory = mod?.createTwinTools ?? mod?.default?.createTwinTools;
      if (typeof factory === 'function') {
        const list = (await factory(deps)) || [];
        for (const item of Array.isArray(list) ? list : []) {
          if (!item || !item.name || typeof item.execute !== 'function') continue;
          try {
            const definition = normalizeToolDefinition({
              name: item.name,
              description: item.description,
              parameters: item.inputSchema ?? item.parameters,
              execute: item.execute,
              output: item.output ?? TEXT_OUTPUT,
            }, log);
            tools.register(guarded(definition));
            registered.push(definition.name);
            definitions.push(definition);
            log.info(`已注册分身记忆工具 ${definition.name}`);
          } catch (err) {
            log.warn(`分身记忆工具 ${item.name} 挂载失败，已跳过：${errText(err)}`);
          }
        }
      }
    } catch (err) {
      log.warn(`分身记忆工具加载失败（不影响其它功能）：${errText(err)}`);
    }
  } else {
    log.warn('宿主没有 tools 服务，跳过工具注册');
  }

  // ── 3.3 MCP Streamable HTTP（M4.5）：让「已经在跑的宿主」自己就是一个 MCP 端点 ──
  // 懒加载：只有真的有人 POST /v1/mcp 时才 import，起服务不付这份钱。
  // 工具一个都没注册成功时返回 null（端点如实报 503，而不是给个空壳说"已支持"）。
  let httpMcp = null;
  let httpMcpTried = false;
  const httpMcpOf = async () => {
    if (httpMcpTried) return httpMcp;
    httpMcpTried = true;
    if (!definitions.length) return null;
    try {
      const mod = await import('./mcp/http.js');
      httpMcp = mod.createHttpMcp({ definitions, log, readOnly: cfg.mcp.readOnly });
    } catch (err) {
      log.warn(`MCP Streamable HTTP 没加载（stdio 入口不受影响）：${errText(err)}`);
      httpMcp = null;
    }
    return httpMcp;
  };

  // ── 3.4 自动化巡检（M4）：到点的定时任务在这里被真的跑起来 ──────────────────
  // 每轮都从盘上重读状态，所以另一个进程执行 `nexi stop` 能立刻停住运行中的宿主 ——
  // 只改内存标志位的话，"全局停止"就是骗人的。
  let automationTicker = null;
  if (cfg.automation?.enabled !== false) {
    try {
      const { createRunner, startTicker } = await import('./automation/runner.js');
      const tickerRunner = createRunner({
        root: stateRoot(),
        deps,
        now: () => Date.now(),
        log: (msg) => log.info(msg),
      });
      automationTicker = startTicker({
        runner: tickerRunner,
        tickMs: cfg.automation?.tickMs,
        log: (msg) => log.info(msg),
      });
      // 挂到 ctx.effect 上：插件卸载/宿主关闭时定时器被清掉，不留幽灵线程
      ctx.effect(() => () => {
        try { automationTicker?.(); } catch { /* 清理失败不影响卸载 */ }
        automationTicker = null;
      }, 'agentdeck-super: automation ticker');
      log.info(`自动化巡检已启动（每 ${Math.round((cfg.automation?.tickMs || 30000) / 1000)} 秒一次）`);
    } catch (err) {
      log.warn(`自动化巡检没起来（定时任务不会自己动，deck_automation 工具仍可用）：${errText(err)}`);
    }
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
    skins: skinsApi,
    log,
    root: stateRoot,
    licenseRoot,
    // 本机 CLI 探测结果（makeRegistry.detect() 后台填，命令/页面直接读）
    registry,
    // 分身记忆模块（可能为 null：加载失败时页面显示"未就绪"而不是空白）
    twin: twinApi,
    // 通行证模块（可能为 null：主页就少一块卡包，不影响其它）
    identityApi,
    // 皮肤市场 / 支付渠道体检（可能为 null：皮肤区就只说"没接渠道"，不影响其它）
    market: marketApi,
    billing: billingApi,
    quota: quotaApi,
    // 可选模块的加载失败原因（空数组 = 一切正常）。主页会把它们摆出来而不是假装没事。
    loadIssues,
  };

  // ── 4. HTTP 路由（ADBP + 状态页）────────────────────────────────────────
  // 宿主没有 webServer 服务（例如精简 profile）时，这个 inject 回调根本不会执行，
  // 于是「没有网页」是一种静默降级，而不是启动失败。

  /**
   * 测试台用的"本地 Hub"门面：把已注册的工具包成 `hub.call(name, args)`，
   * 返回 MCP 风格的 content 块（跟 lib/hub.js 的 createHub 同一个形状）。
   * 这样测试台点一下按钮 = 走一遍真实工具，而不是另写一套逻辑。
   */
  const localHub = {
    names: () => registered.slice(),
    // 1.10.0：协议网关（OpenAPI / A2A）要的是 list()，拿的是带 name/description/parameters 的定义数组。
    // 以前这里只有 names()，网关取不到工具 → 文档里路径数是 0（真机验收时抓到的）。
    list: () => (definitions || []).map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    })),
    call: async (name, args = {}) => {
      const def = (definitions || []).find((d) => d?.name === name);
      if (!def) throw new Error(`没有这个工具：${name}`);
      const value = await def.execute(args, { hub: true });
      const blocks = typeof def.output?.render === 'function'
        ? def.output.render(args, value)
        : [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }];
      return Array.isArray(blocks) && blocks.length ? blocks : [{ type: 'text', text: '' }];
    },
  };

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
        handler: (req, res) => handleHttp(req, res, { cfg, board, ingress, log, registered, definitions, deckEnv, mcpHttp: httpMcpOf, hub: localHub }),
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
      // 测试台：/deck/console（短路径，用户会打这个）——必须单独挂，
      // 因为 /deck 是 `kind:'exact'`，/deck/console 根本到不了它的 handler（踩过）。
      if (mount({
        kind: 'exact',
        path: '/deck/console',
        handler: (req, res) => { void handleConsole(req, res, { hub: localHub, cfg, log, method: String(req?.method || 'GET').toUpperCase() }); },
      }, '测试台')) {
        log.info(`测试台已挂载：http://127.0.0.1:${port}/deck/console`);
      }
      // 主页动作入口：POST /deck/act（产品页上那几个按钮都打到这儿，303 回主页）
      if (mount({
        kind: 'exact',
        path: '/deck/act',
        handler: (req, res) => { void handleDeckAct(req, res, { hub: localHub, cfg, log, board, method: String(req?.method || 'GET').toUpperCase() }); },
      }, '主页动作')) {
        log.info(`主页动作已挂载：POST http://127.0.0.1:${port}/deck/act`);
      }
      // 串门落地页：/visit?t=<邀请凭证>——没装 DSH 的人也能点开看是谁邀请我
      if (mount({
        kind: 'prefix',
        path: '/visit',
        handler: (req, res) => { void handleVisitPage(req, res, { cfg: { ...cfg, version: deckEnv?.version } }); },
      }, '串门落地页')) {
        log.info(`串门落地页已挂载：http://127.0.0.1:${port}/visit?t=<邀请凭证>`);
      }
      // 1.10.0：对外协议网关 —— OpenAPI 3.1（给只认 HTTP 的平台）+ A2A agent card（给别的 Agent）。
      // 路径自带 /v1 前缀（/v1/openapi.json、/v1/tools/<name>、/v1/a2a/*），所以 basePath 留空；
      // 也不能挂 /adbp 下：那边是 prefix 路由，会把 /adbp/* 全吞进 handleHttp。
      // 工具表直接用本插件的 hub（localHub），网关里出现的工具和直接调用的是同一批。
      if (gatewayApi && typeof gatewayApi.mountGateway === 'function') {
        try {
          const disposeGateway = gatewayApi.mountGateway(scope.webServer, {
            hub: localHub,
            baseUrl: port === '?' ? '' : `http://127.0.0.1:${port}`,
            log,
          });
          if (typeof disposeGateway === 'function') disposers.push(disposeGateway);
          log.info(`网关已挂载：http://127.0.0.1:${port}/v1/openapi.json（OpenAPI 3.1）· http://127.0.0.1:${port}/v1/a2a/agent-card.json（A2A）`);
        } catch (err) {
          log.warn(`网关挂载失败（其它功能不受影响）：${errText(err)}`);
        }
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
  purchaseUrl: '',
  // 跨机房间：cloud.relayUrl 是文档里的正规写法，relayUrl 是早期扁平写法，两个都认
  cloud: { relayUrl: '' },
  relayUrl: '',
  automation: { enabled: true, tickMs: 30000 },
  llm: { mode: 'auto', baseUrl: '', apiKey: '', model: '', cliAgent: 'claude' },
  mcp: { readOnly: false },
};

/** 配置兜底：宿主可能传空、传字符串、传半截对象，这里一律整成完整形状。 */
function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const llm = c.llm && typeof c.llm === 'object' ? c.llm : {};
  const cloud = c.cloud && typeof c.cloud === 'object' ? c.cloud : {};
  const automation = c.automation && typeof c.automation === 'object' ? c.automation : {};
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
    purchaseUrl: text(c.purchaseUrl),
    // 这里漏字段=用户填了 relay 也连不出去（上一版就栽在这：schema 放行、normalize 丢弃）
    cloud: { relayUrl: text(cloud.relayUrl) || text(c.relayUrl) },
    relayUrl: text(c.relayUrl),
    automation: {
      enabled: automation.enabled !== false,
      tickMs: Math.max(1000, Number(automation.tickMs) || DEFAULTS.automation.tickMs),
    },
    llm: {
      mode: text(llm.mode) || DEFAULTS.llm.mode,
      baseUrl: text(llm.baseUrl),
      apiKey: text(llm.apiKey),
      model: text(llm.model),
      cliAgent: text(llm.cliAgent) || DEFAULTS.llm.cliAgent,
    },
    mcp: { readOnly: (c.mcp && typeof c.mcp === 'object' ? c.mcp.readOnly : c.mcp) === true },
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
function makeEmit(ctx, board, log, petSink = null) {
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
    // 桌宠的数字分身：用户干活的动作就是它的学习材料（不认的事件自己跳过）。
    try {
      if (petSink && typeof petSink.record === 'function') petSink.record(payload.type, data ?? {});
    } catch { /* 学不到习惯不算故障 */ }
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

async function handleHttp(req, res, { cfg, board, ingress, log, registered, definitions = [], deckEnv, mcpHttp, hub }) {
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
    // 主页动作（1.9.0）：产品页上那四个快捷按钮 + 加任务 + 换装都打这儿。
    // 走 303 回主页，结果塞 ?done= / ?failed= —— 产品页不当日志页用。
    if (path === `${cfg.routePrefix}/deck/act` || path === '/deck/act') {
      await handleDeckAct(req, res, { hub, cfg, log, method });
      return;
    }
    // 测试台（1.8.0）：`/deck/console` —— 能真点每一个工具的那一页。
    // GET 出表单，POST 真调 hub.call，结果渲染回同一个页面。同样不走 ingress。
    if (path === `${cfg.routePrefix}/deck/console` || path === '/deck/console') {
      await handleConsole(req, res, { hub, cfg, log, method });
      return;
    }
    // MCP 入口：同一个 URL 按方法分流——
    //   POST → Streamable HTTP（客户端真能在这里 initialize / tools/list / tools/call）
    //   GET  → 给人看/给脚本读的接入清单（不经过 ADBP ingress）
    if (path === `${cfg.routePrefix}/v1/mcp` || path === '/v1/mcp') {
      const bridge = typeof mcpHttp === 'function' ? await mcpHttp() : null;
      if (method === 'GET' || method === 'HEAD') {
        // 只读模式：清单里只列真的能调的读工具，并把 readOnly 明写出来（别让客户端以为能写）
        const ro = cfg.mcp.readOnly === true;
        sendJson(res, 200, {
          ...mcpSummary(),
          tools: ro ? readonlyToolNames(definitions) : registered.slice(),
          readOnly: ro,
          transport: bridge ? 'stdio+streamable-http' : 'stdio',
          ...(bridge ? {
            httpEndpoint: `${cfg.routePrefix}/v1/mcp`,
            httpNotes: [
              'POST 这个 URL 就是 MCP Streamable HTTP：JSON-RPC 2.0，无状态，不发 Mcp-Session-Id。',
              'GET 只给这份清单；没有 SSE 推流（规范允许直接 405）。',
              ...(ro ? ['本机开着只读模式（mcp.readOnly=true）：写动作会返回 isError，不会落盘。'] : []),
            ],
          } : {}),
        });
        return;
      }
      if (!bridge) {
        sendJson(res, 503, {
          error: 'mcp_http_unavailable',
          hint: '这个宿主里一个工具都没注册成功，HTTP 端点暂时不给（stdio 入口 `nexi mcp` 仍可用）',
          transport: 'stdio',
        });
        return;
      }
      // POST=JSON-RPC；其它方法由传输层如实回 405（含 PUT/DELETE，别掉进 ADBP ingress 变成 401）
      await bridge.handle(req, res);
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

/**
 * 截断长文本给状态页/命令用：任务标题可能很长，整行铺开就把版面挤爆了。
 * 全角字符按两个宽度算，中文标题不会被截成半截。
 * 注意：这个函数必须定义在渲染路径之前——之前漏了它，/deck 和 /adbp 直接 500。
 */
function clipText(value, max = 60) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(8, num0(max) || 60);
  let width = 0;
  let out = '';
  for (const ch of raw) {
    const w = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    if (width + w > limit) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════
 * /deck 状态页：命令文本、HTML 页面、授权表单、ADBP /state 摘要
 *   三处展示同一份数据，所以先把取数逻辑写成一组纯函数（都可单独 try/catch），
 *   页面和命令只是排版不同——避免"网页上有、命令里没有"这种不一致。
 * ════════════════════════════════════════════════════════════════════════ */

/** 任务状态的中文标签：状态页是给人看的，别在页面上露 pending/running 这种词。 */
const STATUS_ZH = Object.freeze({
  pending: '待办',
  todo: '待办',
  running: '进行中',
  doing: '进行中',
  claimed: '进行中',
  done: '完成',
  completed: '完成',
  failed: '失败',
  blocked: '受阻',
});

function statusZh(status) {
  const key = String(status || '').toLowerCase();
  return STATUS_ZH[key] || String(status || '待办');
}

/**
 * 状态页里的桌宠：用当前激活皮肤画真图。
 * 拿不到皮肤（模块缺失/皮肤被删）才回退到占位图 —— 占位图必须明确写"占位"，不能骗人。
 */
function petSpriteHtml(env, lic, pet) {
  const fallback = `<svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="桌宠占位图">
    <rect x="8" y="10" width="48" height="44" rx="12" fill="#eef3ff" stroke="#9db4e6"/>
    <circle cx="24" cy="30" r="4" fill="#3d444d"/><circle cx="40" cy="30" r="4" fill="#3d444d"/>
    <path d="M24 42 q8 6 16 0" stroke="#3d444d" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  </svg>`;
  try {
    const api = env.skins;
    if (!api || typeof api.listSkins !== 'function' || typeof api.renderSprite !== 'function') return fallback;
    const root = env.root ? env.root() : process.cwd();
    const listed = api.listSkins({ root, license: lic });
    const all = Array.isArray(listed?.skins) ? listed.skins : [];
    const skin = all.find((item) => item && item.id === pet.skin) || all[0] || null;
    if (!skin) return fallback;
    const svg = api.renderSprite({ skin, state: 'idle', size: 64, license: lic });
    const text = String(svg || '');
    // renderSprite 拿不到素材时会退回它自己的占位图，这里不重复画，直接用
    return text || fallback;
  } catch {
    return fallback;
  }
}

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
  const empty = { name: '小助', skin: 'basic', habits: [], tasksDone: 0, tasksAdded: 0, activeDays: 0 };
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
      tasksAdded: Number(profile.stats?.tasksAdded || 0),
      activeDays: Array.isArray(profile.days) ? profile.days.length : 0,
    };
  } catch {
    return empty;
  }
}

/**
 * 分身记忆的页面摘要：条数、类型分布、已确认习惯、待确认候选。
 * 任何一步出错都退回空摘要——状态页宁可不显示，也不能 500。
 */
export function twinSummary(env) {
  const empty = { ready: false, total: 0, byType: {}, habits: [], proposals: [], file: '' };
  const api = env.twin;
  if (!api || typeof api.stats !== 'function') return empty;
  // deps.root 可能是函数（工作区会变）：状态页这边必须现取，不能把函数当路径。
  const resolved = typeof env.root === 'function' ? env.root() : env.root;
  const root = typeof resolved === 'string' && resolved.trim() ? resolved : process.cwd();
  try {
    const st = api.stats(root);
    const habits = typeof api.readHabits === 'function' ? api.readHabits(root) : { habits: { confirmed: [] } };
    const proposals = typeof api.proposeHabits === 'function'
      ? (api.proposeHabits({ root, store: env.petStore })?.proposals || [])
      : [];
    return {
      ready: true,
      total: Number(st.total || 0),
      byType: st.byType || {},
      habits: (habits?.habits?.confirmed || []).map((h) => ({ label: String(h.label || h.key || ''), evidence: Number(h.evidence || 0) })),
      proposals: proposals.map((p) => ({
        label: String(p.label || p.key || ''),
        evidence: Number(p.evidence || 0),
        key: String(p.key || ''),
        auto: Boolean(p.auto),
      })),
      file: String(st.file || ''),
    };
  } catch {
    return empty;
  }
}

/** 状态页「分身记忆」段落：只读展示 + 一行可复制的命令，不做写操作（写走工具）。 */
function twinSectionHtml(env) {
  const t = twinSummary(env);
  if (!t.ready) {
    return `<h2>分身记忆</h2><p class="muted">这一版没加载到记忆模块（不影响其它功能）。</p>`;
  }
  const typeText = Object.entries(t.byType || {})
    .filter(([, n]) => Number(n) > 0)
    .map(([k, n]) => `${esc(typeLabelZh(k))} ${num0(n)}`)
    .join(' / ') || '还没有内容';
  const habitHtml = t.habits.length
    ? `<ul>${t.habits.map((h) => `<li>${esc(h.label)}<span class="muted">（你确认过，出现 ${num0(h.evidence)} 次）</span></li>`).join('')}</ul>`
    : '<p class="muted">还没有你确认过的习惯。</p>';
  const proposalHtml = t.proposals.length
    ? `<p>待你确认 ${t.proposals.length} 条：${t.proposals
      .map((p) => `<span class="tag">${esc(p.label)}</span>${p.auto ? '<span class="muted">（桌宠先记了一笔，等你点头才算数）</span>' : ''}<code>${esc(p.key)}</code>`)
      .join('<br>')}<br><span class="muted">确认方式：让 Agent 调 <code>twin_habit {"action":"confirm","key":"&lt;上面的 key&gt;"}</code>（也可以直接给序号 1），或直接说"把这个习惯记下来"。</span></p>`
    : '';
  return `<h2>分身记忆</h2>
<p>共 ${num0(t.total)} 条：${typeText}</p>
${habitHtml}
${proposalHtml}
<p class="muted">存在本机 <code>${esc(t.file || '~/.dsh/agentdeck-super/.agentdeck/twin/memory.json')}</code>。分四档可见性（私有 / 好友 / 房间 / 公开），对外协作时只有你放行的那部分才会跟着走。</p>`;
}

/** 记忆类型的中文名（页面用；协议里始终是英文键）。 */
function typeLabelZh(type) {
  const map = { session: '会话', event: '事件', semantic: '知识', preference: '偏好', relation: '关系' };
  return map[String(type)] || String(type);
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
  lines.push(`桌宠：皮肤 ${pet.skin}${pet.name && pet.name !== '桌宠' ? `（${pet.name}）` : ''} · 完成 ${num0(pet.tasksDone)} / 拆出 ${num0(pet.tasksAdded)} 个任务${pet.habits.length ? ` · ${pet.habits.map((h) => h.label).join('；')}` : ' · 还在观察你的习惯'}`);
  lines.push(`工具 ${registered.length} 个：${registered.length ? registered.join('、') : '（无）'}`);
  lines.push(`ADBP：${cfg.routePrefix}/v1/manifest${relayUrlOf(cfg) ? ` · relay ${relayUrlOf(cfg)}` : ' · 未配 relay（跨机不可用）'}`);
  lines.push('', '下一步三步：', ...nextSteps(cfg, lic, room));
  return lines.join('\n');
}

/** `/deck` 的 HTML 版状态页：自包含，无外链、无 CDN、无 JS 依赖（表格提交用原生 form）。 */
/**
 * MCP 接入现状：只报事实。
 * "已接入" = 该宿主配置文件里真有我们写进去的那一项；没装就是没装，不猜。
 */
function mcpSummary() {
  let launch = { command: 'node', args: ['bin/nexi.mjs', 'mcp'] };
  try {
    launch = launchCommand();
  } catch { /* 保持兜底值 */ }
  let hosts = [];
  try {
    hosts = detectHosts().map((h) => {
      let registered = false;
      try {
        if (h.installed && existsSync(h.path)) {
          const raw = readFileSync(h.path, 'utf8');
          registered = h.kind === 'toml'
            ? raw.includes('[mcp_servers.nexi]')
            : raw.includes('"nexi"') && raw.includes('nexi.mjs');
        }
      } catch {
        registered = false;
      }
      return { id: h.id, label: h.label, tier: h.tier, installed: h.installed, registered, path: h.path, detectedBy: h.detectedBy || 'config' };
    });
  } catch { /* 探测失败就当全是未接入，页面照常出 */ }
  return {
    command: `${launch.command} ${launch.args.join(' ')}`.trim(),
    hosts,
    registered: hosts.filter((h) => h.registered).length,
    installed: hosts.filter((h) => h.installed).length,
    // 1.10.0：把"哪些宿主只能验到配置层、以及为什么"一并交出去。
    // 页面照实写：GUI 类宿主没有可非交互调用的 mcp 子命令，这是平台事实，不是我们偷懒。
    unprobeable: hosts
      .filter((h) => h.installed && !PROBEABLE_HOSTS.has(h.id))
      .map((h) => h.label),
  };
}

/** 有非交互探针的宿主（能在装完之后问宿主自己"认不认"）。其余只能验到配置层。 */
const PROBEABLE_HOSTS = new Set(['claude-code', 'codex', 'gemini-cli']);

/**
 * 组装 `/deck` 的 view-model，交给 lib/deck.js 渲染。
 *
 * 这个函数只做两件事：把已有模块的摘要揉成一份数据结构；以及**保证任何一项
 * 失败都不让整页白屏**——每块单独 try/catch，失败给空值，页面自己退化成
 * 「还没有…」的文案。产品页崩掉比少一块信息严重得多。
 *
 * 1.9.0 之前这里直接拼 HTML（一堆授权路径、房间 id、MCP 表格），那是给开发者
 * 看的诊断页。现在渲染搬进 lib/deck.js，这里只准备数据。
 */
function deckPageHtml(env, query) {
  const { cfg, registered } = env;
  const lic = licenseSummary(env);
  const room = roomSummary(env);
  const sum = boardSummary(env.board);
  const pet = petSummary(env);
  const mcp = mcpSummary();
  const root = env.root ? env.root() : process.cwd();
  const licRoot = env.licenseRoot ? env.licenseRoot() : root;
  const prefix = String(cfg?.routePrefix || '/adbp');

  // 一次性提示条：授权码结果，或某个动作 303 回来带的 done / failed
  const pick = (k) => { try { return String(query?.get?.(k) || ''); } catch { return ''; } };
  let flash = null;
  const banner = pick('license');
  if (banner === 'ok') flash = { ok: true, text: '授权码已写入，重启会话后按新档位生效。' };
  else if (banner === 'bad') flash = { ok: false, text: '授权码没通过校验，文件没有写入（旧档位不变）。' };
  else if (banner === 'err') flash = { ok: false, text: '写授权文件失败，请检查机级目录是否可写。' };
  else if (pick('done')) flash = { ok: true, text: pick('done').slice(0, 240) };
  else if (pick('failed')) flash = { ok: false, text: pick('failed').slice(0, 240) };

  // 皮肤授权判定吃的是 license 对象本身（不是摘要），单独取一次
  let licenseObj = null;
  try {
    licenseObj = env.licenseApi?.currentLicense?.(licRoot) || null;
  } catch { licenseObj = null; }

  // ── 桌宠精灵 + 皮肤网格：一律走 skins.js，绝不在这一页另画一份 ──
  // 状态是从真实数据推出来的，不是写死 'idle'：有任务在跑就是干活中，在房间里就是串门中。
  const petState = num0(sum.running) > 0 ? 'working' : room.roomId && room.active ? 'visiting' : 'idle';
  const petStateLabel = { idle: '发呆中', working: '干活中', meeting: '开会中', visiting: '串门中', sleeping: '睡觉了' }[petState] || '发呆中';
  let petSprite = '';
  const skins = [];
  const skinsApi = env.skins;
  if (skinsApi && typeof skinsApi.renderSprite === 'function') {
    try {
      petSprite = String(skinsApi.renderSprite({ skin: pet.skin || 'basic', state: petState, size: 130, license: licenseObj, root }) || '');
    } catch { petSprite = ''; }
  }
  if (skinsApi && typeof skinsApi.listSkins === 'function') {
    try {
      const listed = skinsApi.listSkins({ root, license: licenseObj });
      for (const s of Array.isArray(listed?.skins) ? listed.skins : []) {
        let preview = '';
        try {
          preview = String(skinsApi.renderSprite({ skin: s.id, state: 'idle', size: 64, license: licenseObj, root }) || '');
        } catch { preview = ''; }
        skins.push({
          id: String(s.id || ''),
          name: String(s.name || s.id || '未命名'),
          author: s.author ? String(s.author) : '官方',
          // skins.js 的 price 是「元」（皮肤包 manifest 的约定，见 assets/skins/*/skin.json）；
          // deck.js 的 money() 收的是「分」。这里换算一次，否则 ¥18 会显示成 ¥0.18。
          price: Math.round(num0(s.price) * 100),
          currency: String(s.currency || 'CNY'),
          // locked 是 skins.js 的授权判定结果。没这个字段说明列目录时没带 license，
          // 那时一律当"能用"——否则会把免费皮肤也标成上锁。
          owned: s.locked !== true,
          active: String(pet.skin || 'basic') === String(s.id || ''),
          preview,
        });
      }
    } catch { /* 皮肤列不出来就整块不显示，别拖垮主页 */ }
  }

  // ── 分身记忆条数：读不到就当 0，别让页面出现 undefined ──
  let memoryCount = 0;
  try {
    if (env.twin && typeof env.twin.stats === 'function') memoryCount = num0(env.twin.stats(root)?.total);
  } catch { memoryCount = 0; }

  // ── 卡包：create:false —— 只看，绝不因为刷了一下主页就铸一对新密钥 ──
  let passport = { enabled: false, kid: '', cards: [] };
  try {
    const api = env.identityApi;
    if (api && typeof api.identitySummary === 'function') {
      const id = api.identitySummary(licRoot, { create: false });
      const store = typeof api.readPassports === 'function' ? api.readPassports(licRoot) : { cards: [] };
      passport = {
        enabled: true,
        kid: String(id?.kid || ''),
        cards: (Array.isArray(store?.cards) ? store.cards : []).slice(0, 6).map((c) => {
          const caps = c?.capabilities || c?.claims?.capabilities;
          return {
            name: String(c?.name || c?.claims?.name || '未命名'),
            agent: String(c?.agent || c?.claims?.agent || 'dsh'),
            capabilities: Array.isArray(caps) ? caps.map(String) : [],
          };
        }),
      };
    }
  } catch { /* 卡包读不出来不影响主页 */ }

  // 可选模块（皮肤市场 / 支付渠道 / 配额）没加载起来时，env 里带着原因。
  // 这里先复制一份，因为算额度失败也要往同一个列表里补一条——不能直接 push 到 env 上（会越积越多）。
  const issues = Array.isArray(env.loadIssues)
    ? env.loadIssues.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  // ── 额度：数的是本机真实用量（countUsed 读各模块自己的落盘位置，不另造账）──
  // 免费档最想知道的就是「我还能建几个房间 / 记几条」；这里如实摆出来。
  let quota = null;
  try {
    const q = env.quota;
    if (q && typeof q.check === 'function') {
      const used = typeof q.countUsed === 'function'
        ? q.countUsed({ roots: { workspace: root, global: licRoot } })
        : { counts: {} };
      const order = [
        ['rooms', '群组房间'],
        ['meetings', '会议'],
        ['automations', '自动化'],
        ['twinEntries', '记忆'],
        ['seats', '席位'],
      ];
      const items = order.map(([kind, label]) => {
        // 席位这台机器上就一个人用：按 1 算，不瞎猜
        const u = kind === 'seats' ? 1 : num0(used?.counts?.[kind]);
        const r = q.check(lic.tier, kind, u);
        const cap = r && r.limit !== undefined && r.limit !== null ? Number(r.limit) : Infinity;
        const unlimited = !Number.isFinite(cap);
        return { kind, label, used: u, limit: unlimited ? 0 : cap, unlimited };
      });
      const up = typeof q.upgradeOf === 'function' ? q.upgradeOf(lic.tier) : null;
      const tierLabels = { free: '免费版', plus: 'PLUS', studio: 'STUDIO', business: 'BUSINESS' };
      quota = {
        tier: lic.tier,
        tierLabel: lic.label || tierLabels[lic.tier] || lic.tier,
        items,
        upgradeTo: up || '',
        upgradeLabel: up ? (tierLabels[up] || up) : '',
      };
    }
  } catch (err) {
    quota = null;
    issues.push(`额度算不出来（不影响其它）：${errText(err)}`);
  }

  return renderDeckPage({
    version: env.version || 'dev',
    // 短路径直接命中 exact 挂载；ADBP 前缀那条也照样被 handleHttp 分发，两种写法都认。
    actPath: '/deck/act',
    licensePath: `${prefix}/deck/license`,
    license: {
      tier: lic.tier,
      label: lic.label,
      exp: lic.exp,
      maxSeats: lic.maxSeats,
      cloudRooms: lic.cloudRooms,
      describe: lic.describe,
      reason: lic.reason,
      path: lic.path,
    },
    room,
    board: { totals: sum, latest: sum.latest },
    pet: {
      name: pet.name,
      skin: pet.skin,
      habits: pet.habits,
      tasksDone: pet.tasksDone,
      tasksAdded: pet.tasksAdded,
      activeDays: pet.activeDays,
      memoryCount,
      state: petState,
      stateLabel: petStateLabel,
    },
    petSprite,
    skins,
    // 额度（本机真实用量）与可选模块的加载问题。都是「有就显示、没有就整块不渲染」。
    quota,
    issues,
    passport,
    mcp: {
      hosts: (Array.isArray(mcp.hosts) ? mcp.hosts : []).map((h) => ({
        name: String(h.label || h.name || ''),
        installed: Boolean(h.installed),
        registered: Boolean(h.registered),
        path: String(h.path || ''),
        // 这两个字段以前在映射时被丢掉了，于是页面上的「只找到 CLI」「平台限制」两段说明
        // 永远渲染不出来——数据一路传到了这里，最后一步没带过去。
        detectedBy: String(h.detectedBy || 'config'),
      })),
      unprobeable: Array.isArray(mcp.unprobeable) ? mcp.unprobeable.map((x) => String(x)) : [],
    },
    flash,
    // 跨机房间全靠它，页面上必须如实写出来（配了就显示，没配就写未配置）
    relay: relayUrlOf(cfg),
    // 支付渠道体检：皮肤区据此决定说"点买会跳真实收款页"还是"环境未配，不会扣钱"
    pay: (() => {
      try {
        const h = env?.billing?.health?.();
        return { configured: h?.configured === true, provider: String(h?.provider || '') };
      } catch { return { configured: false, provider: '' }; }
    })(),
    toolCount: Array.isArray(registered) ? registered.length : 0,
  });
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

/** `/deck/console` 测试台入口（GET 出表单，POST 真调工具并把原始返回渲染回去）。 */
async function handleConsole(req, res, { hub, cfg, log, method }) {
  const readOnly = cfg?.mcp?.readOnly === true;
  const version = readVersion();
  const tools = (() => {
    try { return typeof hub?.names === 'function' ? hub.names() : []; } catch { return []; }
  })();

  if (method === 'GET' || method === 'HEAD') {
    sendHtml(res, consolePageHtml({ version, tools, readOnly }));
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed', hint: 'GET 或 POST /deck/console' });
    return;
  }

  let fields = null;
  try {
    const raw = await readRawBody(req);
    fields = new URLSearchParams(raw);
  } catch (err) {
    sendHtml(res, consolePageHtml({
      version, tools, readOnly,
      result: { id: '(读取表单)', tool: '-', args: '-', text: `读请求体失败：${errText(err)}`, ok: false, ms: 0 },
    }));
    return;
  }

  const parsed = parseConsoleSubmit(fields);
  const t0 = Date.now();
  let text = '';
  let ok = true;

  if (!parsed.ok) {
    text = `错误：${parsed.error}`;
    ok = false;
  } else if (readOnly) {
    // 只读模式下页面上的按钮已经置灰，但直连 POST 也得拦住（页面只是提示，闸门在服务端）
    text = `错误：只读模式（mcp.readOnly=true）：${parsed.tool} 这个动作会改状态，已被拦下。`
      + `\n改配置里 mcp.readOnly: false 再试，或者只用页面上的读动作。`;
    ok = false;
  } else if (!hub || typeof hub.call !== 'function') {
    text = '错误：这个宿主里 Hub 没起来（没有注册到工具），测试台无法调用。';
    ok = false;
  } else {
    try {
      const blocks = await hub.call(parsed.tool, parsed.args);
      text = blocks.map((b) => (typeof b?.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
      ok = !/^(错误|❌)/.test(text.trim());
    } catch (err) {
      text = `错误：${parsed.tool} 调用失败 —— ${errText(err)}`;
      ok = false;
    }
  }

  try {
    log?.info?.(`测试台调用 ${parsed.tool}（${ok ? '成功' : '失败'}）`);
  } catch { /* 忽略 */ }

  sendHtml(res, consolePageHtml({
    version, tools, readOnly,
    result: {
      id: parsed.id || '(未知)',
      tool: parsed.tool || '-',
      args: JSON.stringify(parsed.args || {}),
      text,
      ok,
      ms: Date.now() - t0,
    },
  }));
}

/**
 * 主页按钮 → 工具调用。产品页只让点「一下就有结果」的动作，慢的（开会、编排）
 * 留在测试台或者让 Agent 自己发起——主页不是控制台。
 *
 * 关键取舍：**结果不渲染回页面**，而是 303 回 `/deck?done=…` 的提示条。
 * 原因有两个：① 刷新不会重复提交；② 主页只该显示「变了」，一堆原始 JSON 是
 * `/deck/console` 的职责。想看原始返回就去测试台。
 *
 * 只读模式（mcp.readOnly=true）在这里**服务端再拦一次**：页面上按钮灰掉只是提示，
 * 闸门必须在这边，否则直连 POST 就绕过去了。
 */
const DECK_ACTIONS = Object.freeze({
  'passport-card': { tool: 'pet_visit', args: () => ({ action: 'card' }), label: '我的名片' },
  'visit-invite': { tool: 'pet_visit', args: () => ({ action: 'invite' }), label: '串门邀请' },
  'twin-brief': { tool: 'twin_brief', args: () => ({}), label: '今日简报' },
  'pet-state': { tool: 'pet_skin', args: () => ({ action: 'states' }), label: '桌宠状态' },
  'skin-activate': {
    tool: 'pet_skin',
    args: (fields) => ({ action: 'activate', id: String(fields.get('skin-activate__id') || '').trim() }),
    label: '换装',
  },
  'task-add': {
    tool: 'team_board',
    // 页面上没有"选组"这一步，所以这里要自己把默认小组补上。
    // 规则（踩过的坑：以前只在"恰好 1 个组"时才用，多于 1 个就留空 → 按钮静默失败；
    // 而真实用起来组是会越攒越多的）：
    //   给了 teamId 就用它；否则用**最近建的那个组**；一个都没有就自动建一个。
    args: (fields, ctx) => {
      const title = String(fields.get('task-add__title') || '').trim();
      const board = ctx?.board || null;
      let teamId = String(fields.get('task-add__teamId') || '').trim();
      try {
        const teams = Array.isArray(board?.listTeams?.()) ? board.listTeams() : [];
        if (!teamId && teams.length) {
          // 最近建的排前面（没有 createdAt 就按数组顺序取最后一个）
          const sorted = [...teams].sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')));
          teamId = String(sorted[0]?.id || '');
        }
        if (!teamId) {
          const created = board?.createTeam?.({ name: '我的小组', goal: '从 /deck 页面上直接加的第一条任务' });
          teamId = String(created?.id || created?.teamId || '');
        }
      } catch { /* 板子不配合就按没有组处理，下面会如实报错 */ }
      return { action: 'add', title, ...(teamId ? { teamId } : {}) };
    },
    label: '加任务',
  },
  // 皮肤市场：走 deck_market（真下单；没配渠道就如实说环境未配）
  'skin-buy': {
    tool: 'deck_market',
    args: (fields) => ({ action: 'buy', skinId: String(fields.get('skin-buy__id') || '').trim() }),
    label: '购买皮肤',
  },
});

async function handleDeckAct(req, res, { hub, cfg, log, method, board }) {
  const back = (query) => {
    try {
      res.writeHead(303, { location: `/deck?${query}`, 'cache-control': 'no-store' });
      res.end();
    } catch { /* 连接已断就算了 */ }
  };
  const fail = (text) => back(`failed=${encodeURIComponent(String(text).slice(0, 240))}`);

  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed', hint: 'POST /deck/act' });
    return;
  }

  let fields = null;
  try {
    fields = new URLSearchParams(await readRawBody(req));
  } catch (err) {
    fail(`读表单失败：${errText(err)}`);
    return;
  }

  const id = String(fields.get('__id') || '').trim();
  const spec = DECK_ACTIONS[id];
  if (!spec) {
    fail(`不认识的动作：${id || '(空)'}`);
    return;
  }
  if (cfg?.mcp?.readOnly === true) {
    fail(`只读模式（mcp.readOnly=true）：${spec.label} 会改状态，已被拦下。改配置 mcp.readOnly: false 再试`);
    return;
  }
  if (!hub || typeof hub.call !== 'function') {
    fail('这个宿主里 Hub 没起来，主页按钮暂时不可用');
    return;
  }

  let text = '';
  try {
    
    const blocks = await hub.call(spec.tool, spec.args(fields, { board }));
    text = (Array.isArray(blocks) ? blocks : [])
      .map((b) => (typeof b?.text === 'string' ? b.text : JSON.stringify(b)))
      .join('\n');
  } catch (err) {
    text = `错误：${errText(err)}`;
  }

  const ok = !/^(错误|❌)/.test(text.trim());
  // 提示条只放第一行非空内容：主页不是日志页
  const first = text.trim().split('\n').map((s) => s.trim()).filter(Boolean)[0] || '完成';
  try {
    log?.info?.(`主页动作 ${id}（${ok ? '成功' : '失败'}）`);
  } catch { /* 忽略 */ }
  back(`${ok ? 'done' : 'failed'}=${encodeURIComponent(`${spec.label}：${first.slice(0, 200)}`)}`);
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
 * 串门落地页 /visit —— 让「把链接发给朋友」这件事对**没装 DSH 的人也成立**
 *
 * 背景：邀请函正文里有主人的名片（名字/皮肤/习惯/能力）和有效期，
 * 但 token 是签名过的，**没装 DSH 的人打不开 dsh:// 链接**。
 * 所以这里给一个纯静态落地页：显示主人名片 + 有效期 + 两种收下方式（复制链接 / 深链）。
 *
 * 1.6.5 起签名从 HMAC 换成 Ed25519，公钥就写在邀请函里，所以**这一页自己就能验签**：
 * 页面上的「签名有效」「签名对不上」都是本机真跑出来的结论，不是假装通过。
 * 能证明的只有「名片自签发后没被改过、确实由 kid_xxx 那个私钥签的」；
 * 「这把钥匙是不是真属于你认识的那个人」这一层（TOFU / 域名 / DID）还没做，页面里如实写了。
 * ════════════════════════════════════════════════════════════════════════ */

/** 读邀请函 token 里的名片信息（只解析，不校验签名；失败给 null）。 */
async function peekInvite(token) {
  try {
    const mod = await import('./pet/visit.js');
    if (typeof mod?.readInviteToken !== 'function') return { info: null, error: null };
    const result = mod.readInviteToken(String(token || ''));
    if (result && result.ok !== false) return { info: result, error: null };
    return { info: null, error: result && typeof result === 'object' ? result : null };
  } catch {
    return { info: null, error: null };
  }
}

/** 已过期/解析不了时，尽量把名片抠出来给个"这张邀请过期了"的人话页。 */
function peekInvitePayloadLoose(token) {
  try {
    const body = String(token || '').split('.')[0];
    if (!body) return null;
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * `/visit?t=<token>` 落地页。
 * 装没装 DSH 都能看：装了给 dsh:// 深链 + 复制指令；没装给网页加入说明。
 */
async function handleVisitPage(req, res, { cfg }) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed', hint: 'GET /visit?t=<token>' });
    return;
  }
  let token = '';
  try {
    token = String(new URL(String(req?.url || '/visit'), 'http://127.0.0.1').searchParams.get('t') || '');
  } catch { token = ''; }

  const peek = token ? await peekInvite(token) : { info: null, error: null };
  const info = peek.info;
  const peekCode = String(peek.error?.code || '');
  const loose = info ? null : peekInvitePayloadLoose(token);
  const card = (info?.host) || (loose?.from) || null;
  const expired = Boolean(token) && !info && peekCode === 'expired';
  const tampered = Boolean(token) && !info && peekCode === 'bad_signature';
  const hostName = String(card?.name || '').trim() || '一位朋友';
  const skin = String(card?.petSkin || '').trim() || 'basic';
  // 名片里的习惯是 {key,label,confidence} 对象，页面上要摊成人能读的字
  const habits = (Array.isArray(card?.habitsTop3) ? card.habitsTop3 : [])
    .map((h) => (typeof h === 'string' ? h : String(h?.label || h?.key || '')))
    .filter(Boolean)
    .slice(0, 3);
  const caps = (Array.isArray(card?.capabilities) ? card.capabilities : [])
    .map((c) => (typeof c === 'string' ? c : String(c?.label || c?.name || c?.key || '')))
    .filter(Boolean)
    .slice(0, 8);
  const scope = String(info?.scope || loose?.scope || 'visit');
  const expMs = Number(info?.expMs || loose?.exp) || 0;
  const expText = expMs ? new Date(expMs).toLocaleString('zh-CN', { hour12: false }) : '（没写有效期）';

  const listOr = (arr, empty) => (arr.length ? arr.join('、') : empty);
  // 档案里没单独申报能力时，capabilitiesOf 会退化成"拿习惯当能力"——页面上别重复列一遍
  const capsSameAsHabits = caps.length > 0 && habits.length > 0 && caps.join('|') === habits.join('|');
  const capsText = capsSameAsHabits ? '同上（还没单独申报能力，先按习惯算）' : listOr(caps, '聊天、记笔记');

  const kid = String(info?.kid || loose?.kid || '');
  const trustBox = !info
    ? tampered
      ? `<p><b>签名对不上。</b>这张名片在签发之后被改过（哪怕只改一个字，签名也会烂掉），或者根本不是它声称的那个人签的。</p>
         <p class="hint">下面这张名片只是从原始字节里抠出来的，<b>一个字都别信</b>。要确认，让朋友用 <code>pet_visit invite</code> 重新发一张。</p>`
      : expired
        ? `<p>凭证本身没问题，<b>只是过期了</b>：串门邀请是有时效的，过期就得重发。</p>
           <p class="hint">让 ${esc(hostName)} 再发一张（<code>pet_visit invite</code>），点新链接就行。</p>`
        : `<p>这张链接里的凭证<b>解析不出来</b>（可能被截断、被改过，或者根本不是 Nexi 灵犀 发的邀请函）。下面那张名片是从原始字节里尽量抠出来的，仅供参考。</p>`
    : info.verified
      ? info.version === 2
        ? `<p class="okp"><b>签名有效（Ed25519）。</b>这张名片自签发后<b>一个字节都没被改过</b>，签发方密钥 <code>${esc(kid || 'kid_（缺）')}</code>。</p>
         <p class="hint">验签用的公钥就写在邀请链接里，所以哪台机器都能验，不用提前交换密钥。能证明的到此为止：<b>没被改过</b>；
         至于这把密钥是不是真的属于「${esc(hostName)}」，得你自己知道这条链接是谁发给你的。</p>`
        : '<p class="okp"><b>本机签发。</b>签名在本机校验通过（这台的旧版 v1 邀请函）。</p>'
      : `<p>这是<b>旧版（v1）跨机器</b>邀请函：签发方的 HMAC 密钥在对方机器上，本机没有，所以只做了<b>格式 / 有效期 / 范围</b>校验——<b>没有</b>验签。</p>
         <p class="hint">让对方用 1.6.4 及以上版本重发一张就好：新版邀请函自带公钥，跨机器也能真验签。</p>`;

  const head = tampered
    ? `<h1>这张邀请函不对劲</h1><p class="sub">签名对不上：名片在被发出来之后被改过。</p>`
    : expired
      ? `<h1>这张邀请已经过期了</h1><p class="sub">让 ${esc(hostName)} 重新发一张（\`pet_visit invite\`）就能继续。</p>`
      : !token
        ? '<h1>这里是一张串门邀请函</h1><p class="sub">链接里没带凭证（缺少 <code>?t=</code>）。让朋友把完整链接发你一遍。</p>'
        : `<h1>${esc(hostName)} 邀请你去串门</h1><p class="sub">${scope === 'work' ? '这次是「可以派活」的邀请' : '这次是「只串门」的邀请'} · 有效期到 ${esc(expText)}</p>`;

  const body = !token
    ? ''
    : `<div class="card">
      <div class="who"><span class="dot"></span><b>${esc(hostName)}</b><span class="tag">皮肤 ${esc(skin)}</span></div>
      <table>
        <tr><th>拿手习惯</th><td>${esc(listOr(habits, '还没养成习惯'))}</td></tr>
        <tr><th>能帮忙</th><td>${esc(capsText)}</td></tr>
        <tr><th>范围</th><td>${scope === 'work' ? '可以给我派活' : '只串门，不派活'}</td></tr>
        <tr><th>有效期</th><td>${esc(expText)}${expired ? ' <span class="bad">（已过期）</span>' : ''}</td></tr>
      </table>
      <p class="hint">这张名片是对方主动放行的那部分，<b>不含</b>任何原始记录（会话、笔记、任务明细都不在里面）。</p>
    </div>
    ${info ? `<h2>怎么收下</h2>
    <div class="card">
      <p><b>装了 DSH：</b>点这条深链，或把整条链接丢给 Agent——</p>
      <pre><code>${esc(`dsh://agentdeck/visit?t=${token}`)}</code></pre>
      <p><b>没装 DSH：</b>把下面这句发给任意一个装了 Nexi 灵犀插件的 Agent，它会替你收下并回名片——</p>
      <pre><code>${esc(`pet_visit accept url=${'<把这条链接整条贴进来>'}`)}</code></pre>
      <p class="hint">收下之后还能互留便签：送礼物（<code>pet_visit gift</code>）、发求助（<code>pet_visit ask</code>，会落成对方任务板上的一条任务）。</p>
    </div>` : ''}
    <h2>这张邀请我怎么信的</h2>
    <div class="card ${info?.verified ? 'okbox' : 'warnbox'}">
      ${trustBox}
    </div>`;

  sendHtml(res, `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(hostName)} 的串门邀请 · Nexi 灵犀</title>
<style>
  :root{--bg:#141210;--card:#1f1b17;--line:#372f27;--ink:#f3ece2;--dim:#a4947f;--ok:#54c98a;--bad:#c96a5a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Microsoft YaHei",system-ui,-apple-system,sans-serif;padding:44px 22px 80px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:26px;margin:0 0 6px} h2{font-size:17px;margin:30px 0 10px;color:var(--dim);font-weight:600}
  .sub{color:var(--dim);font-size:13.5px;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:12px 0}
  .who{display:flex;align-items:center;gap:10px;font-size:18px;margin-bottom:10px}
  .dot{width:12px;height:12px;border-radius:50%;background:linear-gradient(135deg,#7de3ff,#b07cff);box-shadow:0 0 12px #7de3ff88}
  .tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:1px 9px}
  table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:6px 0;vertical-align:top;font-size:14px}
  th{width:96px;color:var(--dim);font-weight:500}
  code,pre{font-family:Consolas,Menlo,monospace}
  pre{background:#15120f;border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow:auto;font-size:13px;user-select:all;white-space:pre-wrap;word-break:break-all}
  .hint{color:var(--dim);font-size:12.5px;margin:8px 0 0}
  .bad{color:var(--bad)} .ok{color:var(--ok)}
  .warnbox{border-color:#4a3a26}
  .okbox{border-color:#2c5c40;background:#182219}
  .okp{color:var(--ok);margin:0 0 6px}
  .foot{margin-top:34px;color:var(--dim);font-size:12px}
</style>
<div class="wrap">
  ${head}
  ${body}
  <div class="foot">由 Nexi 灵犀（agentdeck-super）${esc(String(cfg?.version || ''))} 渲染 · 这一页不发任何网络请求，不写任何东西到你的机器</div>
</div>`);
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

