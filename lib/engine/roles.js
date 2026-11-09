/**
 * engine/roles.js —— 分工、计划、调度与验收
 *
 * 契约（docs/CONTRACTS.md 2.7，签名不得改）：
 *   ROLES / planProject({brain,brief,opts}) => { goal, tasks:[{id,title,role,acceptance,dependsOn}] }
 *   runGraph({tasks,run,concurrency=3,gate}) => { ok, results:{[id]:{ok,output,error?}}, failures }
 *
 * 为什么要有角色：让模型"扮演六种人"比让它"自由发挥"稳定得多——
 *   lead 拆任务、architect 定方案、critic 挑毛病、worker 干活、
 *   tester 验结果、scribe 写文档。每个角色的 system 都写死了它的边界，
 *   这样并行派活时不会出现三个人同时改同一个文件的惨剧。
 *
 * 为什么 planProject 要自己再校验一遍：模型给的 JSON 十有八九有坑
 * （id 重复、依赖指向不存在的任务、依赖成环、漏验收标准）。
 * 直接用会让调度器死锁或"做完没人验"。所以：校验 → 有问题回喂一次 →
 * 还不行就降级成一条 lead 任务，保证"计划失败但项目不卡死"。
 */

/** 六个角色。tools 是建议的工具白名单（super 工具会据此裁剪工具带）。 */
export const ROLES = {
  lead: {
    id: 'lead',
    name: '组长',
    system: [
      '你是项目组长（lead）。',
      '你的职责：把模糊的大目标拆成可执行、可验收、有依赖关系的任务；分派给合适的角色；盯进度；',
      '在冲突时做最终决策；最后对用户交付结果负责。',
      '原则：任务粒度以"一个人能在一次会话内做完并自证"为准；每条任务必须有验收标准；',
      '能并行的任务绝不要串成链；不要自己写代码——把写代码派给 worker。',
    ].join('\n'),
    tools: ['board_add', 'board_list', 'board_done', 'agent_run', 'ask_user', 'fs_read', 'fs_grep', 'shell'],
    whenToUse: '需要拆解目标、分派任务、汇总结果、做最终决策时',
    defaultAcceptance: '给出可核对的交付清单（做了什么、产物路径、结论），且每条子任务都有明确状态',
  },
  architect: {
    id: 'architect',
    name: '架构师',
    system: [
      '你是架构师（architect）。',
      '你的职责：读代码、定方案、划清模块边界和接口契约，输出别人能直接照着写代码的设计。',
      '原则：先看现状再给方案；明确到"哪个文件、哪个函数、什么签名"；指出风险与取舍，不要只报喜。',
      '不写实现细节以外的废话，也不要越权改文件。',
    ].join('\n'),
    tools: ['fs_list', 'fs_read', 'fs_glob', 'fs_grep', 'web_fetch'],
    whenToUse: '需要技术选型、接口设计、改动范围评估、方案评审时',
    defaultAcceptance: '给出明确的接口/文件级方案，并说明关键取舍与风险',
  },
  critic: {
    id: 'critic',
    name: '评审官',
    system: [
      '你是评审官（critic）。',
      '你的职责：专门找问题——逻辑漏洞、边界条件、安全风险、与契约不符之处。',
      '原则：每条意见都要指出"具体位置 + 为什么错 + 怎么改"；区分"必须修"和"建议"；',
      '不许为空而空，没问题就明确说通过。',
    ].join('\n'),
    tools: ['fs_read', 'fs_grep', 'fs_glob', 'shell'],
    whenToUse: '产出需要挑刺、上线前风险评估、检查是否偏离契约时',
    defaultAcceptance: '列出分级问题清单（必须修/建议），或明确给出"通过"结论及依据',
  },
  worker: {
    id: 'worker',
    name: '执行者',
    system: [
      '你是执行者（worker）。',
      '你的职责：按给定任务真正动手改代码/写文件/跑命令，把活干完。',
      '原则：先读再改；小步修改；改完自证（跑测试或复现命令）；',
      '只做被要求的事，发现需求不清就先按最合理的方式做并说明假设。',
    ].join('\n'),
    tools: ['fs_list', 'fs_read', 'fs_write', 'fs_patch', 'fs_glob', 'fs_grep', 'shell', 'http_request'],
    whenToUse: '需要真正写代码、改文件、执行命令时',
    defaultAcceptance: '目标文件已按要求改好，并有可复现的验证结果（命令 + 输出）',
  },
  tester: {
    id: 'tester',
    name: '测试员',
    system: [
      '你是测试员（tester）。',
      '你的职责：用可复现的方式验证产出是否真的能用（跑测试、复现步骤、检查边界）。',
      '原则：只报告你实际运行过的结果，绝不编造；失败要给出复现命令和关键报错；',
      '通过也要写清"跑了什么、覆盖了什么"。',
    ].join('\n'),
    tools: ['shell', 'fs_read', 'fs_list', 'fs_grep', 'http_request', 'web_fetch'],
    whenToUse: '需要验证功能是否可用、回归测试、复现用户报的问题时',
    defaultAcceptance: '给出实际执行的验证命令与完整结果（通过/失败及关键输出）',
  },
  scribe: {
    id: 'scribe',
    name: '记录员',
    system: [
      '你是记录员（scribe）。',
      '你的职责：写 README、变更说明、交付报告，把过程和结论整理成人能看懂的文字。',
      '原则：面向"第一次看这个项目的人"写；给命令、给路径、给预期输出；不吹牛，没做的不写。',
    ].join('\n'),
    tools: ['fs_read', 'fs_write', 'fs_patch', 'fs_list', 'fs_glob', 'fs_grep'],
    whenToUse: '需要写文档、整理交付说明、记录决策时',
    defaultAcceptance: '文档已落盘（给出路径），内容覆盖用法、验证方式与已知限制',
  },
};

export const ROLE_NAMES = Object.keys(ROLES);

/** 角色规范化：认不出来的角色一律当 worker（不能让一个错别字把计划废掉）。 */
export function normalizeRole(role) {
  const r = String(role ?? '').trim().toLowerCase();
  if (ROLES[r]) return r;
  const byName = ROLE_NAMES.find((n) => ROLES[n].name === r);
  return byName || 'worker';
}

/** 取某个角色的 system prompt（拼上项目公共规则）。 */
export function systemFor(role, extra = '') {
  const r = ROLES[normalizeRole(role)];
  return [r.system, extra].filter(Boolean).join('\n\n');
}

const PLANNER_SYSTEM = [
  '你是项目组长，负责把用户目标拆成任务图。',
  '只输出一个 JSON 数组，不要任何解释、不要 Markdown 围栏之外的话。',
  '数组每一项的字段：',
  '  id: 短字符串（t1、t2…），全局唯一；',
  '  title: 一句话说清"要交付什么"，动宾结构；',
  '  role: lead | architect | critic | worker | tester | scribe 之一；',
  '  acceptance: 验收标准，必须能被检查（跑什么命令、看什么文件、达到什么现象）；',
  '  dependsOn: 依赖的任务 id 数组（没有依赖就写 []）；',
  '  brief: 可选，给执行者的补充上下文（一两句话）。',
  '硬性要求：',
  '1) 无依赖的任务要尽量拆开并行，不要人为串成一条链；',
  '2) dependsOn 只能引用数组里真实存在的 id，禁止自依赖和环；',
  '3) 任务数控制在 3~8 条，最后一条通常是 tester 或 critic 的验收任务；',
  '4) 不要虚构不存在的文件、命令或 API。',
].join('\n');

export function buildPlannerPrompt(brief, { maxTasks = 8 } = {}) {
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief ?? {});
  return [
    '【项目目标】',
    text,
    '',
    `请输出任务图 JSON 数组（最多 ${maxTasks} 条）。记住：只输出 JSON 数组。`,
  ].join('\n');
}

/**
 * 校验并修正模型给的计划。
 * 返回 { ok, tasks, warnings, errors }：
 *   errors  → 致命问题（依赖环、无有效任务），需要模型重来；
 *   warnings → 已就地修好的小问题（角色不认识、缺验收、id 重复…）。
 */
export function validatePlan(raw, { maxTasks = 12 } = {}) {
  const warnings = [];
  const errors = [];
  let list = raw;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    list = list.tasks || list.plan || list.steps || null;
  }
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, tasks: [], warnings, errors: ['模型没有返回任务数组'] };
  }

  const tasks = [];
  const used = new Set();

  list.slice(0, Math.max(1, maxTasks)).forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      warnings.push(`第 ${i + 1} 项不是对象，已跳过`);
      return;
    }
    const title = String(item.title ?? item.task ?? item.name ?? '').trim();
    if (!title) {
      warnings.push(`第 ${i + 1} 项没有 title，已跳过`);
      return;
    }
    let id = String(item.id ?? item.key ?? '').trim() || `t${i + 1}`;
    if (used.has(id)) {
      const base = id;
      let n = 2;
      while (used.has(`${base}-${n}`)) n += 1;
      id = `${base}-${n}`;
      warnings.push(`任务 id 重复，已把「${title}」改为 ${id}`);
    }
    used.add(id);

    const roleRaw = item.role ?? item.owner ?? item.type;
    const role = normalizeRole(roleRaw);
    if (roleRaw && String(roleRaw).toLowerCase() !== role) warnings.push(`任务 ${id} 的角色 "${roleRaw}" 不认识，已按 worker 处理`);

    let acceptance = String(item.acceptance ?? item.accept ?? item.done ?? '').trim();
    if (!acceptance) {
      acceptance = ROLES[role].defaultAcceptance;
      warnings.push(`任务 ${id} 缺验收标准，已用 ${role} 的默认验收：${acceptance.slice(0, 40)}…`);
    }

    const depsRaw = item.dependsOn ?? item.deps ?? item.depends ?? [];
    const dependsOn = (Array.isArray(depsRaw) ? depsRaw : [depsRaw])
      .map((d) => String(d ?? '').trim())
      .filter(Boolean)
      .filter((d) => {
        if (d === id) {
          errors.push(`任务 ${id} 依赖了自己`);
          return false;
        }
        return true;
      });

    tasks.push({
      id,
      title,
      role,
      acceptance,
      dependsOn,
      brief: String(item.brief ?? item.context ?? item.note ?? '').trim(),
      retries: Math.min(5, Math.max(0, Number(item.retries) || 0)),
    });
  });

  if (!tasks.length) return { ok: false, tasks: [], warnings, errors: [...errors, '没有任何有效任务'] };

  // 依赖必须指向真实任务；不存在的依赖直接丢掉（否则调度器永远等不到它）
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    const kept = [];
    for (const d of t.dependsOn) {
      if (ids.has(d)) kept.push(d);
      else warning(`任务 ${t.id} 依赖了不存在的 ${d}，已忽略`);
    }
    t.dependsOn = [...new Set(kept)];
  }
  function warning(msg) {
    warnings.push(msg);
  }

  // 依赖环检测（DFS 三色）：有环的话调度器会永远没有"就绪任务"
  const state = new Map(); // 0 未访问 1 在栈上 2 已完成
  const stack = [];
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`依赖成环：${cycle.join(' → ')}`);

  return { ok: errors.length === 0, tasks, warnings, errors };

  function findCycle(list2) {
    const byId = new Map(list2.map((t) => [t.id, t]));
    for (const t of list2) state.set(t.id, 0);
    for (const t of list2) {
      if (state.get(t.id) === 0) {
        const res = visit(t);
        if (res) return res;
      }
    }
    return null;

    function visit(node) {
      state.set(node.id, 1);
      stack.push(node.id);
      for (const dep of node.dependsOn || []) {
        const next = byId.get(dep);
        if (!next) continue;
        const s = state.get(dep);
        if (s === 1) {
          const idx = stack.indexOf(dep);
          return [...stack.slice(idx), dep];
        }
        if (s === 0) {
          const r = visit(next);
          if (r) return r;
        }
      }
      state.set(node.id, 2);
      stack.pop();
      return null;
    }
  }
}

/**
 * 让大脑出计划。永不抛错：
 *   · 第一次不合格 → 把错误回喂给模型重来一次；
 *   · 仍不合格（或模型根本不可用）→ 降级成一条 lead 任务，项目继续跑。
 */
export async function planProject({ brain, brief, opts = {} } = {}) {
  const goal = String(typeof brief === 'string' ? brief : brief?.goal ?? brief?.title ?? JSON.stringify(brief ?? '')).trim();
  const maxTasks = Math.min(20, Math.max(1, Number(opts.maxTasks) || 8));
  const warnings = [];
  const errors = [];

  const fallback = (reason) => {
    errors.push(reason);
    return {
      ok: false,
      goal: goal || '未命名目标',
      tasks: [
        {
          id: 't1',
          title: goal ? `完成目标：${goal.slice(0, 60)}` : '完成用户目标',
          role: 'lead',
          acceptance: ROLES.lead.defaultAcceptance,
          dependsOn: [],
          brief: reason,
          retries: 0,
        },
      ],
      warnings,
      errors,
      degraded: true,
    };
  };

  if (!brain || typeof brain.chat !== 'function') return fallback('没有可用的大脑（brain 缺失），计划降级为单任务');
  if (!goal) return fallback('目标为空，无法拆分');

  const messages = [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: buildPlannerPrompt(brief, { maxTasks }) },
  ];
  const retries = opts.retries == null ? 1 : Math.max(0, Number(opts.retries) || 0);

  let lastRaw = '';
  let feedback = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await brain.chat({
        messages: attempt === 0 ? messages : [...messages, { role: 'assistant', content: lastRaw }, { role: 'user', content: feedback }],
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 2400,
        signal: opts.signal,
        system: undefined,
      });
    } catch (err) {
      return fallback(`调用模型生成计划失败：${err?.message || err}`);
    }
    lastRaw = String(res?.content ?? '');
    const parsed = parsePlan(lastRaw);
    if (parsed == null) {
      feedback = '你上一次的输出不是合法 JSON 数组（可能是空、或者夹了说明文字）。请只输出 JSON 数组，不要任何别的字符。';
      continue;
    }
    const check = validatePlan(parsed, { maxTasks });
    warnings.push(...check.warnings);
    if (check.ok) {
      return { ok: true, goal, tasks: check.tasks, warnings, errors: [], degraded: false, model: res?.model || '' };
    }
    feedback = `你上一次的计划没有通过校验，原因：\n- ${check.errors.join('\n- ')}\n请修正后重新输出完整 JSON 数组（仍然只输出数组）。`;
  }

  return fallback(`计划两次都没有通过校验（模型输出：${lastRaw.slice(0, 200) || '空'}），已降级为单任务`);
}

/** 从模型正文里抠出任务数组（容忍围栏、`{"tasks":[...]}`、前后废话）。 */
export function parsePlan(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const candidates = [];
  // 先试整段就是数组
  if (raw.startsWith('[')) candidates.push(raw);
  // 再试围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  // 再试第一个 [ ... ] 区间（配平扫描）
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '[') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < raw.length; j += 1) {
      const c = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(raw.slice(i, j + 1));
          break;
        }
      }
    }
    break;
  }
  const objFence = raw.match(/\{[\s\S]*\}/);
  if (objFence) candidates.push(objFence[0]);

  for (const c of candidates) {
    try {
      const val = JSON.parse(c);
      if (Array.isArray(val)) return val;
      if (val && typeof val === 'object' && Array.isArray(val.tasks)) return val.tasks;
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

/**
 * 默认验收闸门。没有模型可用时的"尽力而为"自检：
 *   · 跑挂 / 抛错 → 不通过；
 *   · 没有任何产出 → 不通过；
 *   · 产出非空 → 通过，并把 acceptance 记在 reason 里，方便人工复核。
 */
export function defaultGate(task, result) {
  if (!result) return { ok: false, reason: '执行器没有返回结果' };
  if (result.ok === false) return { ok: false, reason: String(result.error || '执行失败') };
  const output = String(result.output ?? result.content ?? '');
  if (!output.trim()) return { ok: false, reason: '没有产出内容，无法验收' };
  const acc = task?.acceptance ? `（验收标准：${String(task.acceptance).slice(0, 120)}）` : '';
  return { ok: true, reason: `产出 ${output.length} 字${acc}` };
}

/**
 * 按依赖图并行跑任务。
 * 特性：
 *   · 只跑"依赖都已完成"的任务，最多 concurrency 个同时跑；
 *   · 每个任务过闸门，不通过按 task.retries 重试，重试仍不过就失败并**级联跳过**下游；
 *   · 依赖环/全阻塞时不会死等，剩余任务标记 skipped 并记入 failures；
 *   · 永不抛错，任何异常都变成 { ok:false, ... } 的结果。
 */
export async function runGraph({ tasks, run, concurrency = 3, gate } = {}) {
  const results = {};
  const failures = [];
  const warnings = [];
  const list = Array.isArray(tasks) ? tasks.filter((t) => t && t.id != null) : [];
  if (!list.length) return { ok: true, results, failures, warnings };
  if (typeof run !== 'function') {
    return { ok: false, results, failures: [{ id: '*', error: 'runGraph 需要 run(task) 执行器' }], warnings };
  }

  const gateFn = typeof gate === 'function' ? gate : defaultGate;
  // 夹在 1..32：0 和负数当 1（串行），乱传/缺省当契约默认 3。
  // 注意不能写 `Number(concurrency) || 3`——那样 0 会被当成"没传"而变成 3，与"串行"的直觉相反。
  const wanted = Number(concurrency);
  const limit = Number.isFinite(wanted) ? Math.max(1, Math.min(32, Math.floor(wanted))) : 3;

  // 克隆一份，避免改到调用方的对象；顺手去重 id
  const byId = new Map();
  const order = [];
  for (const t of list) {
    let id = String(t.id);
    if (byId.has(id)) {
      let n = 2;
      while (byId.has(`${id}-${n}`)) n += 1;
      warnings.push(`任务 id 重复：${id} → ${id}-${n}`);
      id = `${id}-${n}`;
    }
    byId.set(id, { ...t, id, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [], retries: Math.min(5, Math.max(0, Number(t.retries) || 0)) });
    order.push(id);
  }

  const status = new Map(order.map((id) => [id, 'pending']));
  const doneOutputs = new Map();

  // 依赖没"完成"就不能开工：在跑、待跑、失败、跳过统统算堵住。
  // 曾经这里只拦 failed/skipped，结果下游会在上游还在跑的时候就抢跑，
  // 拿到的上游产出是空的（"并行"变成了"乱序"）。
  const depBlock = (id) => {
    const t = byId.get(id);
    for (const d of t.dependsOn) {
      if (!byId.has(d)) continue; // 外部依赖：当作已满足（计划校验阶段已剔除失效依赖）
      if (status.get(d) !== 'done') return d;
    }
    return null;
  };

  const markFailed = (id, error, extra = {}) => {
    status.set(id, 'failed');
    results[id] = { ok: false, output: '', error, ...extra };
    failures.push({ id, error });
    // 级联跳过下游（含传递依赖）
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      for (const other of order) {
        if (status.get(other) !== 'pending') continue;
        if (!byId.get(other).dependsOn.includes(cur)) continue;
        status.set(other, 'skipped');
        results[other] = { ok: false, output: '', error: `上游任务 ${cur} 失败，已跳过` };
        failures.push({ id: other, error: `上游任务 ${cur} 失败，已跳过` });
        queue.push(other);
      }
    }
  };

  const execOne = async (id) => {
    const task = byId.get(id);
    status.set(id, 'running');
    const upstream = task.dependsOn
      .map((d) => (doneOutputs.has(d) ? { id: d, output: doneOutputs.get(d) } : null))
      .filter(Boolean);
    const input = {
      ...task,
      attempt: 0,
      context: upstream.map((u) => `【上游 ${u.id} 的产出】\n${String(u.output).slice(0, 4000)}`).join('\n\n'),
    };
    let lastReason = '';
    for (let attempt = 0; attempt <= task.retries; attempt += 1) {
      input.attempt = attempt;
      let result;
      try {
        const raw = await run(input);
        result = typeof raw === 'string' ? { ok: true, output: raw } : { ok: raw?.ok !== false, output: String(raw?.output ?? raw?.content ?? ''), error: raw?.error };
      } catch (err) {
        result = { ok: false, output: '', error: `${err?.name || 'Error'}: ${err?.message || err}` };
      }
      let verdict;
      try {
        verdict = (await gateFn(byId.get(id), result)) || { ok: true, reason: '' };
      } catch (err) {
        verdict = { ok: false, reason: `验收闸门异常：${err?.message || err}` };
      }
      if (verdict.ok) {
        status.set(id, 'done');
        doneOutputs.set(id, result.output);
        results[id] = { ok: true, output: result.output, attempts: attempt + 1, gate: verdict.reason };
        try {
          (globalThis.__agentdeck_event__)?.(id, result);
        } catch { /* 忽略 */ }
        return;
      }
      lastReason = verdict.reason || '验收不通过';
      if (attempt < task.retries) warnings.push(`任务 ${id} 第 ${attempt + 1} 次验收不通过（${lastReason}），重试中`);
    }
    markFailed(id, lastReason, { attempts: task.retries + 1 });
  };

  // 调度循环：起满并发 → 等最先完成的 → 再起
  const active = new Map();
  try {
    for (;;) {
      // 起点：所有依赖都 done 的 pending 任务
      while (active.size < limit) {
        const next = order.find((id) => status.get(id) === 'pending' && !depBlock(id));
        if (!next) break;
        const p = execOne(next).finally(() => active.delete(next));
        active.set(next, p);
      }
      // 没跑的了：要么全完成，要么剩余被上游堵死
      if (!active.size) break;
      await Promise.race([...active.values()]);
    }
  } catch (err) {
    // 理论上到不了这里（execOne 自己兜错），但绝不能把异常抛给宿主
    warnings.push(`调度器异常：${err?.message || err}`);
  }

  // 收尾：仍 pending 的就是死锁（依赖环 / 依赖被外部堵住）
  for (const id of order) {
    if (status.get(id) === 'pending') {
      results[id] = { ok: false, output: '', error: '依赖成环或无就绪任务，未能调度' };
      failures.push({ id, error: '依赖成环或无就绪任务，未能调度' });
      status.set(id, 'skipped');
    }
  }

  const okAll = failures.length === 0 && order.every((id) => results[id]?.ok === true);
  return { ok: okAll, results, failures, warnings };
}

export default { ROLES, ROLE_NAMES, normalizeRole, systemFor, planProject, parsePlan, validatePlan, runGraph, defaultGate };
