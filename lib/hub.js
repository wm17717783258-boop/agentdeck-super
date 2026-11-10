/**
 * 本地 Hub：在没有 DSH 宿主的进程里，把同一套工具装起来。
 *
 * 为什么要有它：
 *   插件本体（lib/index.js 的 apply）已经把所有能力写成了「工具工厂 + deps」，
 *   但 deps 的装配绑在 cordis 的 ctx 上。要服务 Claude / Cursor / Codex 这些
 *   非 DSH 宿主，就必须有一个「假 ctx」把 deps 装好，而不是把逻辑复制一份。
 *
 * 这条铁律是内部方案第 2 节的硬约束：
 *   MCP 网关和 DSH 插件调用的是同一批工具工厂，任何"网关里再写一遍逻辑"都算 bug。
 *
 * 设计要点：
 *   - 只有一个入口 createHub()，返回 { tools, call, list, state, close }。
 *   - 默认不挂 HTTP 路由（MCP stdio 进程不需要端口）；需要状态页时传 webServerFactory。
 *   - 日志默认写 stderr：stdio 通道上的 stdout 是协议流量，混一个字符协议就废了。
 */

import { apply } from './index.js';

/** 真正能被 MCP 暴露的工具名清单（顺序只影响 tools/list 的排版，不影响语义）。 */
export const HUB_TOOL_ORDER = [
  'team_board',
  'agent_join',
  'agent_passport',
  'team_orchestrate',
  'super_agent',
  'deck_room',
  'deck_license',
  'pet_visit',
  'pet_meeting',
  'pet_skin',
  // M2 分身记忆：跨宿主共用同一份本地记忆
  'twin_remember',
  'twin_recall',
  'twin_brief',
  'twin_forget',
  'twin_habit',
  // M4 会议与自动化：跨厂商开会 + 定时/审批/全局停止
  'deck_meeting',
  'deck_automation',
  // 1.9 皮肤市场：看货架 / 下单 / 订单 / 退款 / 支付渠道体检
  'deck_market',
  // 1.11 分身执照：规定桌宠能自己动手到什么程度
  'twin_mandate',
  // 1.10 团队空间 / 动作策略 / 审计流
  'deck_team',
  'deck_policy',
  'deck_audit',
  'deck_sync',
];

/** 日志：默认写 stderr，stdio 模式绝不允许污染 stdout。 */
function makeLogger(sink) {
  const write = typeof sink === 'function'
    ? sink
    : (line) => process.stderr.write(`${line}\n`);
  const fmt = (level, msg) => `[nexi:${level}] ${msg}`;
  return {
    debug() {},
    info: (m) => write(fmt('info', String(m))),
    warn: (m) => write(fmt('warn', String(m))),
    error: (m) => write(fmt('error', String(m))),
  };
}

/**
 * 假 cordis ctx：只实现 apply() 真正用到的表面。
 * @param {{logger?: object, onLog?: Function, webServer?: object, commands?: object}} opts
 */
export function makeHeadlessCtx(opts = {}) {
  const state = { tools: [], infos: [], warns: [], effects: [], emitted: [] };
  const logger = opts.logger || makeLogger(opts.onLog);

  const wrapLogger = {
    debug() {},
    info: (m) => { state.infos.push(String(m)); logger.info?.(m); },
    warn: (m) => { state.warns.push(String(m)); logger.warn?.(m); },
    error: (m) => { state.warns.push(String(m)); logger.error?.(m); },
  };

  const ctx = {
    logger: wrapLogger,
    // 宿主服务探测：headless 下什么都没有，允许各模块自己降级
    get: () => null,
    has: () => false,
    emit: (evt, payload) => state.emitted.push({ evt, payload }),
    effect: (fn, label) => {
      const dispose = fn();
      const record = { label, dispose: typeof dispose === 'function' ? dispose : () => {} };
      state.effects.push(record);
      return record.dispose;
    },
    tools: {
      register(def) {
        state.tools.push(def);
        return () => {};
      },
    },
  };

  // ctx.inject：真 cordis 会等依赖就绪再回调；这里只有显式提供的服务才回调，
  // 所以 apply() 里「没有 webServer 就静默降级」的分支会自然走到。
  ctx.inject = (services, cb) => {
    const list = Array.isArray(services) ? services : [services];
    const provided = {};
    if (opts.webServer && list.includes('webServer')) provided.webServer = opts.webServer;
    if (opts.commands && list.includes('commands')) provided.commands = opts.commands;
    if (!Object.keys(provided).length) return undefined;
    const scope = { ...ctx, ...provided, effect: ctx.effect };
    cb(scope);
    return undefined;
  };

  return { ctx, state };
}

/**
 * 起一个本地 Hub。
 *
 * @param {object} options
 * @param {string} [options.workspace]  工作区（默认 process.cwd()）
 * @param {string} [options.boardRoot]  任务板/状态目录（默认 $DSH_HOME/agentdeck-super）
 * @param {string} [options.petRoot]    桌宠档案目录
 * @param {string} [options.licenseRoot]授权目录
 * @param {string} [options.roomRoot]   跨机房间会话目录（默认跟机器走，不跟项目走）
 * @param {object} [options.config]     额外配置（覆盖上面的字段）
 * @param {object} [options.webServer]  传入 {port, register(route)} 时顺带挂 /deck 与 ADBP
 * @param {Function} [options.onLog]    日志落地函数（默认 stderr）
 */
export async function createHub(options = {}) {
  const config = {
    workspace: options.workspace || process.cwd(),
    boardRoot: options.boardRoot || '',
    petRoot: options.petRoot || '',
    licenseRoot: options.licenseRoot || '',
    roomRoot: options.roomRoot || '',
    ...(options.config || {}),
  };

  const { ctx, state } = makeHeadlessCtx({ onLog: options.onLog, webServer: options.webServer });
  await apply(ctx, config);

  const byName = new Map();
  for (const def of state.tools) byName.set(def.name, def);

  /** 工具名 → 定义；按 HUB_TOOL_ORDER 排序，未知工具排在后面。 */
  const list = () => {
    const names = [...byName.keys()];
    const rank = (n) => {
      const i = HUB_TOOL_ORDER.indexOf(n);
      return i === -1 ? HUB_TOOL_ORDER.length : i;
    };
    return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((n) => byName.get(n));
  };

  /**
   * 调一个工具，返回 MCP content 块数组。
   * 工具的 execute 契约是「永不 throw」，这里再兜一层，保证网关不 500。
   */
  const call = async (name, args = {}) => {
    const def = byName.get(name);
    if (!def) {
      const err = new Error(`没有这个工具：${name}`);
      err.code = 'no_such_tool';
      err.known = [...byName.keys()];
      throw err;
    }
    const value = await def.execute(args, { hub: true });
    const blocks = typeof def.output?.render === 'function'
      ? def.output.render(args, value)
      : [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }];
    return Array.isArray(blocks) && blocks.length ? blocks : [{ type: 'text', text: '' }];
  };

  return {
    tools: byName,
    list,
    call,
    state,
    config: ctx.__config,
    close: async () => {
      // 真卸载：倒序跑 disposer（定时器、监听、锁都要在这里停干净），
      // 以前只读 label 不调用 —— 结果 createHub 关掉后自动化巡检线程还在跑。
      const errors = [];
      for (const record of [...state.effects].reverse()) {
        try {
          record.dispose?.();
        } catch (err) {
          errors.push({ label: record.label, error: String(err?.message || err) });
        }
      }
      state.effects.length = 0;
      if (errors.length) state.warns.push(`卸载时有 ${errors.length} 个清理动作报错（已忽略）`);
    },
  };
}

export default createHub;
