/**
 * `/deck/console` —— 能真点的测试台
 *
 * 为什么单独做一页：原来的 `/deck` 是**只读状态页**（能看不能摸），
 * 用户没法在里面试任何一个工具。这一页把 18 个工具做成能点的表单，
 * 点一下就是一次真的 `hub.call(...)`，结果原样打回页面。
 *
 * 设计约束（跟整个插件一致）：
 *   - 自包含 HTML，零外链、零 CDN、零框架（断网也能开）；
 *   - 只读模式（mcp.readOnly）时，写动作按钮直接置灰并说明原因，不假装能点；
 *   - 任何动作都要能在页面上看到「原始返回」，不是美化过的摘要；
 *   - 不打印任何密钥/私钥/授权码原文。
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 测试台的动作清单。每项 = 一个按钮 + 少量输入框。
 * `danger` 标记的会改状态；只读模式下这些整体禁用。
 */
export const CONSOLE_ACTIONS = [
  {
    group: '团队与任务板',
    items: [
      { id: 'board-list', tool: 'team_board', label: '看任务板', args: { action: 'list' }, inputs: [{ k: 'teamId', ph: '小组 id（留空=当前）' }] },
      { id: 'board-create', tool: 'team_board', label: '建一个小组', danger: true, args: { action: 'create' }, inputs: [{ k: 'name', ph: '小组名', required: true }] },
      { id: 'board-add', tool: 'team_board', label: '加一条任务', danger: true, args: { action: 'add' }, inputs: [{ k: 'title', ph: '任务标题', required: true }, { k: 'acceptance', ph: '验收标准' }] },
      { id: 'board-stats', tool: 'team_board', label: '统计', args: { action: 'stats' } },
    ],
  },
  {
    group: 'Agent 通行证（1.8.0 新增）',
    items: [
      { id: 'pp-show', tool: 'agent_passport', label: '看本机身份', args: { action: 'show' }, note: '没签过卡时会如实说「还没有身份密钥」，不会偷偷生成' },
      { id: 'pp-issue', tool: 'agent_passport', label: '签一张能力卡', danger: true, args: { action: 'issue' }, inputs: [{ k: 'name', ph: '发给谁（如：小犀）', required: true }, { k: 'agent', ph: '给哪个 agent 用（默认 dsh）' }, { k: 'capabilities', ph: '能力，逗号分隔（如 team_board,deck_meeting）' }] },
      { id: 'pp-list', tool: 'agent_passport', label: '看本机账本', args: { action: 'list' } },
      { id: 'pp-verify', tool: 'agent_passport', label: '验一张卡', args: { action: 'verify' }, multiline: { k: 'card', ph: '把 NEXP1.… 整串粘这里' }, inputs: [{ k: 'kid', ph: '要钉的 kid（可选：确认还是同一台机器签的）' }] },
    ],
  },
  {
    group: '数字分身记忆',
    items: [
      { id: 'twin-remember', tool: 'twin_remember', label: '记一件事', danger: true, args: { action: 'remember' }, inputs: [{ k: 'content', ph: '要记的内容', required: true }, { k: 'type', ph: '类型（knowledge/preference/event…）' }] },
      { id: 'twin-recall', tool: 'twin_recall', label: '召回', args: { query: '', any: true }, inputs: [{ k: 'query', ph: '关键词（留空=全部）' }] },
      { id: 'twin-brief', tool: 'twin_brief', label: '今天的简报', args: {} },
    ],
  },
  {
    group: '桌宠',
    items: [
      { id: 'pet-skin', tool: 'pet_skin', label: '看皮肤', args: { action: 'list' } },
      { id: 'pet-visit-card', tool: 'pet_visit', label: '看我的名片', args: { action: 'card' } },
      { id: 'pet-invite', tool: 'pet_visit', label: '生成邀请（串门）', danger: true, args: { action: 'invite' }, inputs: [{ k: 'scope', ph: 'visit（只串门）/ work（可以派活）' }] },
    ],
  },
  {
    group: '会议与自动化',
    items: [
      { id: 'meeting-open', tool: 'deck_meeting', label: '开一场会', danger: true, args: { action: 'open' }, inputs: [{ k: 'topic', ph: '议题', required: true }] },
      { id: 'auto-list', tool: 'deck_automation', label: '看自动化任务', args: { action: 'list' } },
    ],
  },
  {
    group: '授权与房间',
    items: [
      { id: 'lic-show', tool: 'deck_license', label: '看当前档位', args: { action: 'show' } },
      { id: 'lic-plans', tool: 'deck_license', label: '看价格表', args: { action: 'plans' } },
      { id: 'room-info', tool: 'deck_room', label: '看房间', args: { action: 'info' } },
    ],
  },
];

/** 只读模式下被整体禁掉的工具（跟 lib/mcp/readonly.js 同源）。 */
const READONLY_BLOCKED_TOOLS = ['super_agent', 'team_orchestrate', 'pet_meeting', 'twin_remember'];

function actionBlockedByReadonly(item, readOnly) {
  if (!readOnly) return null;
  if (READONLY_BLOCKED_TOOLS.includes(item.tool)) return `只读模式下 ${item.tool} 整个不可用`;
  if (item.danger) return `只读模式（mcp.readOnly=true）下这个动作会改状态，已被拦下`;
  return null;
}

/**
 * 渲染测试台页面。
 * @param {object} o
 * @param {string} o.version   插件版本
 * @param {Array}  o.tools     hub.list() 的工具名数组（用来显示"真有几个工具"）
 * @param {boolean} o.readOnly 当前是否只读
 * @param {object} [o.result]  上一次动作的结果 { id, tool, args, text, ok, ms }
 */
export function consolePageHtml({ version, tools = [], readOnly = false, result = null }) {
  const groups = CONSOLE_ACTIONS.map((g) => {
    const items = g.items.map((it) => {
      const blocked = actionBlockedByReadonly(it, readOnly);
      const inputs = (it.inputs || []).map((inp) => `<label class="f"><span>${esc(inp.k)}</span><input type="text" name="${esc(it.id)}__${esc(inp.k)}" placeholder="${esc(inp.ph || '')}"${blocked ? ' disabled' : ''}></label>`).join('');
      const ml = it.multiline
        ? `<label class="f wide"><span>${esc(it.multiline.k)}</span><textarea name="${esc(it.id)}__${esc(it.multiline.k)}" placeholder="${esc(it.multiline.ph || '')}" rows="3"${blocked ? ' disabled' : ''}></textarea></label>`
        : '';
      return `<form class="act${blocked ? ' blocked' : ''}" method="post" action="/deck/console">
  <input type="hidden" name="__id" value="${esc(it.id)}">
  <div class="acthead"><button type="submit"${blocked ? ' disabled' : ''}>${esc(it.label)}</button>
  <code>${esc(it.tool)}</code>${it.danger ? '<span class="warn">会改状态</span>' : ''}</div>
  ${it.note ? `<div class="muted small">${esc(it.note)}</div>` : ''}
  ${inputs}${ml}
  ${blocked ? `<div class="blockedmsg">${esc(blocked)}</div>` : ''}
</form>`;
    }).join('');
    return `<section><h3>${esc(g.group)}</h3><div class="acts">${items}</div></section>`;
  }).join('');

  const resultHtml = result
    ? `<section class="resultbox ${result.ok ? 'good' : 'bad'}">
<h3>上一次动作的原始返回</h3>
<div class="muted small">动作 <code>${esc(result.id)}</code> → 工具 <code>${esc(result.tool)}</code> · 参数 <code>${esc(result.args)}</code> · 耗时 ${esc(result.ms)}ms · ${result.ok ? '未报错' : '返回里有错误标记'}</div>
<pre>${esc(result.text)}</pre>
</section>`
    : '<section class="resultbox"><h3>上一次动作的原始返回</h3><p class="muted">还没点过按钮。上面随便点一个，结果会原样打在这里。</p></section>';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexi 灵犀 · 测试台</title><style>
body{font:15px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:28px 26px 72px;color:#1f2328;background:#fff}
h1{font-size:21px;margin:0 0 2px}h3{font-size:14px;margin:22px 0 8px;color:#3d444d;text-transform:none}
code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:13px}
a{color:#1f6feb}.muted{color:#656d76}.small{font-size:13px}
.wrap{max-width:1040px}
.acts{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.act{border:1px solid #e2e6ea;border-radius:8px;padding:10px 12px;background:#fcfcfd}
.act.blocked{background:#fafafa;border-style:dashed}
.acthead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
button{padding:6px 14px;border:0;border-radius:6px;background:#1f6feb;color:#fff;font:inherit;cursor:pointer}
button:disabled{background:#c9ced6;cursor:not-allowed}
.warn{font-size:12px;color:#9a6700;background:#fff8e5;padding:0 6px;border-radius:4px}
.blockedmsg{font-size:12px;color:#b42318;margin-top:6px}
.f{display:flex;gap:8px;align-items:center;margin-top:7px;font-size:13px}
.f span{color:#656d76;min-width:84px}
.f input[type=text],.f textarea{flex:1;padding:5px 8px;border:1px solid #d0d7de;border-radius:6px;font:inherit;font-size:13px;min-width:0}
.f.wide{align-items:flex-start}.f.wide textarea{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.resultbox{border:1px solid #e2e6ea;border-radius:8px;padding:12px 14px;margin-top:26px}
.resultbox.good{border-color:#b7e0c0;background:#f6fdf8}
.resultbox.bad{border-color:#f3c2bd;background:#fff7f6}
pre{white-space:pre-wrap;word-break:break-word;background:#f7f8fa;border:1px solid #e9edf1;border-radius:6px;padding:10px 12px;font-size:12.5px;max-height:420px;overflow:auto;margin:8px 0 0}
.top{border:1px solid #e2e6ea;border-radius:8px;padding:10px 14px;margin:10px 0 4px}
.top .ro{color:#9a6700}
</style></head><body><div class="wrap">
<h1>Nexi 灵犀 · 测试台</h1>
<div class="muted">v${esc(version)} · 这里点一下 = 真调一次工具，返回原样打给你看（不做美化）</div>
<div class="top">
  本机工具 <b>${tools.length}</b> 个${readOnly ? ' · <span class="ro">只读模式：写动作已置灰</span>' : ''}<br>
  <span class="small muted">${tools.map((t) => `<code>${esc(t)}</code>`).join(' ')}</span><br>
  <span class="small">只读状态页在 <a href="/deck">/deck</a> · 没装 DSH 的人看串门页 <a href="/visit">/visit</a></span>
</div>
${resultHtml}
${groups}
</div></body></html>`;
}

/**
 * 把表单 POST 解成一次工具调用。
 * @returns {{ ok:boolean, id:string, tool:string, args:object, error?:string }}
 */
export function parseConsoleSubmit(fields) {
  const id = String(fields.get('__id') || '');
  let found = null;
  for (const g of CONSOLE_ACTIONS) {
    const hit = g.items.find((i) => i.id === id);
    if (hit) { found = hit; break; }
  }
  if (!found) return { ok: false, id, tool: '', args: {}, error: `不认识的测试台动作：${id}` };

  // 从表单里收集这个动作自己的输入（前缀是动作 id，避免多个表单重名）
  const args = { ...(found.args || {}) };
  const consumed = [];
  for (const [k, v] of fields.entries()) {
    const pre = `${id}__`;
    if (!k.startsWith(pre)) continue;
    const key = k.slice(pre.length);
    const val = String(v ?? '').trim();
    consumed.push([key, val]);
  }
  for (const [key, val] of consumed) {
    if (val === '') continue;              // 留空 = 不改这个字段（保留动作默认）
    if (key === 'capabilities') {
      args.capabilities = val.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    } else if (key === 'seats') {
      args.seats = Number(val) || 0;
    } else if (key === 'ttlDays') {
      args.ttlDays = Number(val) || 0;
    } else {
      args[key] = val;
    }
  }
  // 必填校验：别让用户点一个空表单进去看法报错
  for (const inp of found.inputs || []) {
    if (inp.required && (args[inp.k] === undefined || args[inp.k] === '')) {
      return { ok: false, id, tool: found.tool, args, error: `「${inp.k}」是必填的` };
    }
  }
  if (found.multiline) {
    const v = args[found.multiline.k];
    if (!v) return { ok: false, id, tool: found.tool, args, error: `「${found.multiline.k}」是必填的` };
  }
  return { ok: true, id, tool: found.tool, args };
}

export default { CONSOLE_ACTIONS, consolePageHtml, parseConsoleSubmit };
