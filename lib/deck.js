/**
 * Nexi 灵犀 · 产品主页（/deck）
 *
 * 这是用户装上插件后**唯一会主动打开的页面**，所以它必须是产品，不是诊断信息堆。
 * 1.9.0 之前这里是「授权文件在哪、房间 id 是多少、MCP 有几个宿主」——那是给开发者看的。
 * 现在分两层：
 *   /deck          产品主页：桌宠、今日数据、任务板、皮肤、卡包、接入
 *   /deck/console  开发者测试台：每个按钮 = 真调一次工具，原始返回原样打出来
 *
 * 渲染层铁律：
 *   1. 纯函数、零 I/O、零外部资源（没有 CDN、没有外部字体、没有 fetch）——
 *      内网/离线也要能打开，这是本地优先产品的底线。
 *   2. 所有动态内容一律 esc()，包括属性值。
 *   3. 数据一律由 index.js 算好传进来（view-model），这里不 re-export 业务逻辑，
 *      这样单测可以喂假数据，测的是「页面怎么画」而不是「业务对不对」。
 */

/** HTML 转义。属性值和文本都用它，别自己拼。 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/** 把数字安全地变成整数（Infinity/NaN/负值都给 0），避免页面上出现 NaN。 */
function num0(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 金额：分 → 「¥12」「¥12.50」。0 显示「免费」。 */
function money(cents, currency = 'CNY') {
  const c = num0(cents);
  if (c <= 0) return '免费';
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  const whole = Math.floor(c / 100);
  const frac = c % 100;
  return frac === 0 ? `${symbol}${whole}` : `${symbol}${whole}.${String(frac).padStart(2, '0')}`;
}

/** 相对时间：给「刚刚 / 3 分钟前 / 昨天」这种人话，比时间戳友好。 */
function ago(ms, now = Date.now()) {
  const t = num0(ms);
  if (!t) return '—';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  return new Date(t).toISOString().slice(0, 10);
}

const STATUS_ZH = { pending: '待办', running: '进行中', done: '已完成', failed: '失败' };

/** 顶部品牌栏 + 档位徽章。升级入口只在免费档出现，付费档显示到期时间。 */
function headerHtml(vm) {
  const lic = vm.license || {};
  const tierName = String(lic.label || '免费版');
  const paid = String(lic.tier || 'free') !== 'free';
  const badge = paid
    ? `<span class="badge paid">${esc(tierName)}${lic.exp ? ` · 到期 ${esc(lic.exp)}` : ''}</span>`
    : '<span class="badge">免费版</span>';
  return `<header class="top">
  <div class="brand">
    <span class="logo" aria-hidden="true">◈</span>
    <div>
      <h1>Nexi 灵犀</h1>
      <p class="sub">你的数字分身 · 在这台机器上替你干活<br><code class="muted">agentdeck-super</code></p>
    </div>
  </div>
  <div class="top-right">
    ${badge}
    <span class="ver">v${esc(vm.version || 'dev')}</span>
  </div>
</header>`;
}

/**
 * Hero：桌宠 + 今日数据 + 四个快捷动作。
 * 桌宠 SVG 由 index.js 用 skins.js 的 renderSprite() 生成后塞进 vm.petSprite，
 * 这里只负责摆位置——渲染逻辑只有一份，别在两个文件里各画一遍。
 */
function heroHtml(vm) {
  const pet = vm.pet || {};
  const stateKey = String(pet.state || 'idle');
  const stateLabel = String(pet.stateLabel || '发呆中');
  const habits = Array.isArray(pet.habits) ? pet.habits : [];
  const habitHtml = habits.length
    ? habits.map((h) => `<li>${esc(h.label)} <span class="muted">×${num0(h.evidence)}</span></li>`).join('')
    : '<li class="muted">还在观察你——用几次就会开始学到习惯</li>';

  const actions = [
    { id: 'pet-state', label: '桌宠状态', hint: '看它现在五种状态的样子' },
    { id: 'passport-card', label: '我的名片', hint: '别人串门时会看到什么' },
    { id: 'twin-brief', label: '今日简报', hint: '分身今天帮你记了什么' },
    { id: 'visit-invite', label: '串门邀请', hint: '生成一条可发出去的邀请链接' },
  ];
  const actionHtml = actions.map((a) => `
      <form method="post" action="${esc(vm.actPath || '/deck/act')}" class="act">
        <input type="hidden" name="__id" value="${esc(a.id)}">
        <button type="submit" title="${esc(a.hint)}">${esc(a.label)}</button>
      </form>`).join('');

  return `<section class="hero">
  <div class="pet-stage">
    <div class="sprite" data-skin="${esc(pet.skin || 'basic')}" aria-label="桌宠 ${esc(pet.name || '小助')}">${vm.petSprite || '<span class="sprite-fallback">◈</span>'}</div>
    <div class="pet-name">${esc(pet.name || '小助')}</div>
    <div class="state-pill ${esc(stateKey)}">${esc(stateLabel)}</div>
  </div>
  <div class="hero-body">
    <h2>今天</h2>
    <div class="stat-grid">
      <div class="stat"><b>${num0(pet.tasksDone)}</b><span>完成任务</span></div>
      <div class="stat"><b>${num0(pet.memoryCount)}</b><span>记住的事</span></div>
      <div class="stat"><b>${habits.length}</b><span>形成习惯</span></div>
      <div class="stat"><b>${num0(pet.activeDays)}</b><span>活跃天数</span></div>
    </div>
    <h3>它学到的</h3>
    <ul class="habits">${habitHtml}</ul>
    <p class="note muted">这些习惯只存本机（不上云）；累计拆出 ${num0(pet.tasksAdded)} 个任务。</p>
    <div class="quick">${actionHtml}</div>
  </div>
</section>`;
}

/** 任务板：进度条 + 最近任务。空状态要给出「怎么开始」而不是干巴巴一句「还没有任务」。 */
function boardHtml(vm) {
  const b = vm.board || {};
  const t = b.totals || {};
  const total = num0(t.total);
  const done = num0(t.done);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const latest = Array.isArray(b.latest) ? b.latest.slice(0, 6) : [];

  const rows = latest.length
    ? latest.map((task) => {
      const status = String(task.status || 'pending');
      // 长标题在页面上截断，但整串塞进 title —— 悬停能看全，页面也不会被一条任务撑爆。
      const full = String(task.title || '(无标题)');
      const shown = full.length > 42 ? `${full.slice(0, 42)}…` : full;
      return `<li>
        <span class="tag ${esc(status)}">${esc(STATUS_ZH[status] || status)}</span>
        <span class="task-title" title="${esc(full)}">${esc(shown)}</span>
        <span class="muted">${esc(ago(task.updatedAt))}</span>
      </li>`;
    }).join('')
    : `<li class="empty">
        还没有任务。任务板是「人和 Agent 共用的同一张纸」——
        你可以让 Agent 建一个小组，也可以自己先写一条。
       </li>`;

  return `<section class="card board">
  <div class="card-head">
    <h2>任务板</h2>
    <span class="muted">${num0(t.teams)} 个小组 · ${total} 条任务 · 已完成 ${done}</span>
  </div>
  <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
    <div class="bar" style="width:${pct}%"></div>
  </div>
  <div class="progress-label muted">完成度 ${pct}%${num0(t.running) ? ` · ${num0(t.running)} 条进行中` : ''}${num0(t.failed) ? ` · ${num0(t.failed)} 条失败` : ''}</div>
  <ul class="tasks">${rows}</ul>
  <form method="post" action="${esc(vm.actPath || '/deck/act')}" class="add-task">
    <input type="hidden" name="__id" value="task-add">
    <input type="text" name="task-add__title" placeholder="加一条任务，回车提交" maxlength="200" required autocomplete="off">
    <button type="submit" class="small">加上</button>
  </form>
</section>`;
}

/** 皮肤网格：拥有的可点「换上」，没拥有的显示价格并引导到市场。 */
function skinsHtml(vm) {
  const skins = Array.isArray(vm.skins) ? vm.skins : [];
  if (!skins.length) return '';
  const cards = skins.map((skin) => {
    const owned = skin.owned !== false;
    const active = skin.active === true;
    const price = num0(skin.price);
    const btn = active
      ? '<span class="skin-state on">正在用</span>'
      : owned
        ? `<form method="post" action="${esc(vm.actPath || '/deck/act')}" class="inline">
             <input type="hidden" name="__id" value="skin-activate">
             <input type="hidden" name="skin-activate__id" value="${esc(skin.id)}">
             <button type="submit" class="small">换上</button>
           </form>`
        : `<form method="post" action="${esc(vm.actPath || '/deck/act')}" class="inline">
             <input type="hidden" name="__id" value="skin-buy">
             <input type="hidden" name="skin-buy__id" value="${esc(skin.id)}">
             <button type="submit" class="small">买 ${esc(money(price, skin.currency))}</button>
           </form>`;
    return `<div class="skin-card${active ? ' active' : ''}${owned ? '' : ' locked'}">
      <div class="skin-preview">${skin.preview || '<span class="sprite-fallback">◈</span>'}</div>
      <div class="skin-meta">
        <b>${esc(skin.name)}</b>
        <span class="muted">${esc(skin.author || '官方')}</span>
      </div>
      ${btn}
    </div>`;
  }).join('');
  // 购买走的是真渠道：没配就明说没配，别让人点了按钮才发现买不了（更别假装买到了）。
  const pay = vm.pay && typeof vm.pay === 'object' ? vm.pay : {};
  const payNote = pay.configured === true
    ? `<p class="note muted">支付渠道 <b>${esc(pay.provider || '已配置')}</b>：点「买」会跳到真实收款页，收到钱才发皮肤。</p>`
    : `<p class="note muted">现在还没有接支付渠道（环境未配）：点「买」会如实告诉你缺什么，不会扣钱，也不会假装买到了。</p>`;
  const anyLocked = skins.some((s) => s.owned === false);
  return `<section class="card">
  <div class="card-head"><h2>皮肤</h2><span class="muted">桌宠就是这个样子，可以换</span></div>
  <div class="skin-grid">${cards}</div>
  ${anyLocked ? payNote : ''}
</section>`;
}

/** 额度：把「本机真实用量 / 这一档的上限」摆出来。免费档最想知道的就这一块。 */
function quotaHtml(vm) {
  const q = vm.quota;
  if (!q || !Array.isArray(q.items) || !q.items.length) return '';
  const rows = q.items.map((item) => {
    const used = num0(item.used);
    const cap = num0(item.limit);
    const pct = item.unlimited ? 0 : Math.max(0, Math.min(100, Math.round((used / Math.max(1, cap)) * 100)));
    const full = item.unlimited !== true && cap > 0 && used >= cap;
    return `<li class="${full ? 'full' : ''}">
      <span class="q-label">${esc(item.label || item.kind || '')}</span>
      <span class="q-bar"><i style="width:${pct}%"></i></span>
      <span class="q-num"><b>${used}</b> / ${item.unlimited ? '不限' : cap}</span>
    </li>`;
  }).join('');
  const foot = q.upgradeTo
    ? `<p class="note muted">当前档位 <b>${esc(q.tierLabel || q.tier || '')}</b>；想放开就升到 <b>${esc(q.upgradeLabel || q.upgradeTo)}</b>，说「deck_license plans」看价格。</p>`
    : `<p class="note muted">当前档位 <b>${esc(q.tierLabel || q.tier || '')}</b> 已经是最高档，这些上限基本不用管。</p>`;
  return `<section class="card">
  <div class="card-head"><h2>额度</h2><span class="muted">数的是本机真实用量，不是估算</span></div>
  <ul class="quota">${rows}</ul>
  ${foot}
</section>`;
}

/** 卡片包：本机身份 kid + 已签出的卡。没有身份时给出「怎么签第一张」。 */
function passportHtml(vm) {
  const pp = vm.passport || {};
  if (!pp.enabled) return '';
  const kid = String(pp.kid || '');
  const cards = Array.isArray(pp.cards) ? pp.cards : [];
  const cardRows = cards.length
    ? cards.slice(0, 5).map((c) => `<li><b>${esc(c.name || '未命名')}</b> <span class="muted">→ ${esc(c.agent || 'dsh')} · ${esc((c.capabilities || []).slice(0, 3).join('、'))}${(c.capabilities || []).length > 3 ? '…' : ''}</span></li>`).join('')
    : '<li class="muted">还没签过卡。通行证用来跟别的 Agent 证明「我是谁、我能干什么」，签出来是一串可验签的字符串。</li>';
  return `<section class="card">
  <div class="card-head"><h2>卡包</h2><span class="muted">${kid ? `本机身份 <code>${esc(kid)}</code>` : '还没有本机身份，签第一张卡时自动生成'}</span></div>
  <ul class="passport">${cardRows}</ul>
</section>`;
}

/** 接入：8 宿主探测结果。没装的如实写「未安装」，不许写「全兼容」。 */
function connectHtml(vm) {
  const mcp = vm.mcp || {};
  const hosts = Array.isArray(mcp.hosts) ? mcp.hosts : [];
  if (!hosts.length) return '';
  const rows = hosts.map((h) => {
    const state = h.registered && h.installed ? '已接入'
      : h.registered ? '配置已写·宿主未装'
        : h.installed ? '已安装·未接入' : '未安装';
    const cls = h.registered && h.installed ? 'ok' : (h.registered || h.installed) ? 'warn' : 'off';
    return `<tr><td>${esc(h.name)}</td><td><span class="dot ${cls}"></span>${esc(state)}</td><td class="muted">${esc(h.path || '—')}</td></tr>`;
  }).join('');
  return `<section class="card">
  <div class="card-head"><h2>接入其他 Agent</h2><span class="muted">同一个 URL / 同一个命令，${num0(vm.toolCount) || 18} 个工具直接可用</span></div>
  <table class="hosts"><thead><tr><th>宿主</th><th>状态</th><th>配置文件</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="muted">没装的宿主就是没装——这里不做「支持所有宿主」的宣传。装了 DSH 之外的宿主，用 <code>nexi mcp</code> 起 stdio 服务即可接入。</p>
</section>`;
}

/** 页脚：开发者入口 + 授权文件位置。诊断信息收进折叠区，不占产品版面。 */
/**
 * 「下一步三步」：新用户装完最常问的就是「然后呢」。
 * 这三步刻意不做成按钮——它们是说明，不是动作；能点的动作都在上面。
 */
function nextStepsHtml(vm) {
  const pp = vm.passport || {};
  const hosts = (vm.mcp && Array.isArray(vm.mcp.hosts)) ? vm.mcp.hosts : [];
  const linked = hosts.filter((h) => h.registered).length;
  const steps = [
    {
      t: '把别的 Agent 接进来',
      d: linked > 0
        ? `已经接上 ${linked} 个宿主，剩下的在下面「接入其他 Agent」那张表里。`
        : '在下面「接入其他 Agent」那张表里挑一个，复制那行配置贴进它的设置文件，重启它。',
    },
    {
      t: '签一张通行证',
      d: pp.kid
        ? '本机身份已经有了。让 Agent 调 <code>agent_passport</code> 的 show，就能拿到一张可验签的卡。'
        : '让 Agent 调 <code>agent_passport</code>，第一次会自动生成一对本机密钥，再签出你的第一张卡。',
    },
    {
      t: '建个小组把活派出去',
      d: '跟 Agent 说「建一个小组，把这几件事分下去」——它会在上面那张任务板上开小组、拆任务、自己认领。',
    },
  ];
  return `<section class="card">
  <div class="card-head"><h2>下一步三步走</h2><span class="muted">从装好到真的有人跟你一起干活</span></div>
  <ol class="steps">${steps.map((s) => `<li><b>${esc(s.t)}</b><span>${s.d}</span></li>`).join('')}</ol>
</section>`;
}

/** 页脚：其它入口 + 进阶信息。relay 地址必须如实显示——跨机房间全靠它。 */
function footerHtml(vm) {
  const lic = vm.license || {};
  const relay = String(vm.relay || '');
  return `<footer>
  <p class="muted">
    其他入口：<a href="/deck/console">开发者测试台</a>
    · <a href="/visit">串门落地页</a>
    ${lic.path ? ` · 授权文件 <code>${esc(lic.path)}</code>` : ''}
  </p>
  <details>
    <summary class="muted">进阶信息</summary>
    <ul class="muted">
      <li>当前档位 <b>${esc(lic.label || '免费版')}</b>${lic.exp ? ` · 到期 ${esc(lic.exp)}` : ''}${lic.maxSeats ? ` · 席位上限 ${num0(lic.maxSeats)}` : ''}${lic.cloudRooms ? ` · 云房间 ${num0(lic.cloudRooms)}` : ''}</li>
      <li>跨机房间 relay：${relay ? `<code>${esc(relay)}</code>` : '<span class="muted">未配置</span>（同机协作不需要）'}</li>
      <li>授权跟人走：换项目目录不用重新激活，换机器要重新激活。</li>
      <li>本机工具 ${num0(vm.toolCount)} 个，全部经由同一套工具工厂，DSH 插件和 MCP 网关调用的是同一份实现。</li>
      <li>${esc(lic.reason || '当前档位判定正常')}</li>
    </ul>
  </details>
</footer>`;
}

/** 顶部结果条：POST 动作后 303 回来带的提示。 */
function flashHtml(vm) {
  if (!vm.flash) return '';
  const kind = vm.flash.ok === false ? 'bad' : 'ok';
  return `<p class="${kind}">${esc(vm.flash.text)}</p>`;
}

/** 升级卡片：只在免费档出现，说明「免费能干什么 / 付费买到什么」。 */
function upgradeHtml(vm) {
  const lic = vm.license || {};
  if (String(lic.tier || 'free') !== 'free') return '';
  return `<section class="card upgrade">
  <div class="card-head"><h2>你现在是免费版</h2><span class="muted">免费版能独立跑完：安装 → 记忆 → 串门 → 任务</span></div>
  <p class="muted">付费买的是省时、规模、确定性，不是解锁互操作——互操作永远免费。</p>
  <form method="post" action="${esc(vm.licensePath || '/deck/license')}" class="license">
    <input type="text" name="key" placeholder="粘贴授权码（ADSK1 开头）" autocomplete="off">
    <button type="submit">启用</button>
  </form>
</section>`;
}

const STYLE = `
:root{--fg:#1f2328;--muted:#656d76;--line:#e4e8ed;--bg:#f6f8fa;--card:#fff;--brand:#5b5bd6;--brand2:#8a63d2;--ok:#1a7f37;--warn:#9a6700;--bad:#b42318}
*{box-sizing:border-box}
body{margin:0;padding:0 0 56px;font:15px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
code{background:#eef1f4;padding:1px 5px;border-radius:4px;font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
.muted{color:var(--muted)}
.wrap{max-width:940px;margin:0 auto;padding:0 20px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:26px 0 18px}
.brand{display:flex;align-items:center;gap:13px}
.logo{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-size:23px}
h1{font-size:21px;margin:0;letter-spacing:.3px}
.sub{margin:1px 0 0;font-size:13px;color:var(--muted)}
.top-right{display:flex;align-items:center;gap:10px}
.badge{font-size:12.5px;padding:5px 11px;border-radius:999px;background:#eceef2;color:#3d444d;white-space:nowrap}
.badge.paid{background:linear-gradient(135deg,#fef3c7,#fde68a);color:#7c5200}
.ver{font-size:12px;color:var(--muted)}
section,.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
.hero{display:grid;grid-template-columns:190px 1fr;gap:22px;align-items:start}
.pet-stage{display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px 8px;border-radius:12px;background:linear-gradient(180deg,#f8f7ff,#f1f0ff)}
.sprite{width:130px;height:130px;display:grid;place-items:center}
.sprite svg{width:100%;height:100%;display:block}
.sprite-fallback{font-size:52px;color:var(--brand)}
.pet-name{font-weight:600;font-size:15px}
.state-pill{font-size:12px;padding:3px 10px;border-radius:999px;background:#e8e7ff;color:#4b47b8}
.state-pill.working{background:#e6f4ea;color:var(--ok)}
.state-pill.meeting{background:#fff4e5;color:var(--warn)}
.state-pill.visiting{background:#e8f0fe;color:#1a56db}
.state-pill.sleeping{background:#eceef2;color:var(--muted)}
.hero-body h2{margin:0 0 10px;font-size:15px;color:var(--muted);font-weight:600}
.hero-body h3{margin:16px 0 5px;font-size:13.5px;color:var(--muted);font-weight:600}
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat{background:var(--bg);border-radius:10px;padding:10px 8px;text-align:center}
.stat b{display:block;font-size:21px;line-height:1.2}
.stat span{font-size:12px;color:var(--muted)}
.habits{margin:0;padding-left:18px;font-size:13.5px}
.habits li{margin:2px 0}
.quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
.act{display:inline}
button{padding:8px 15px;border:0;border-radius:9px;background:var(--brand);color:#fff;font:inherit;font-size:13.5px;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.08)}
button.small{padding:5px 12px;font-size:12.5px;border-radius:7px}
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.card-head h2{margin:0;font-size:16px}
.progress{height:9px;border-radius:999px;background:#eceef2;overflow:hidden}
.bar{height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2));border-radius:999px;transition:width .3s}
.progress-label{font-size:12.5px;margin-top:6px}
.tasks{list-style:none;margin:14px 0 0;padding:0}
.tasks li{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.tasks li:first-child{border-top:0}
.tasks li.empty{display:block;color:var(--muted);font-size:13.5px;line-height:1.7}
.task-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font-size:11.5px;padding:2px 8px;border-radius:999px;background:#eceef2;color:#3d444d;white-space:nowrap}
.tag.done{background:#e6f4ea;color:var(--ok)}
.tag.running{background:#e8f0fe;color:#1a56db}
.tag.failed{background:#fdeceb;color:var(--bad)}
.skin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px}
.skin-card{border:1px solid var(--line);border-radius:12px;padding:12px;text-align:center;background:#fff}
.skin-card.active{border-color:var(--brand);box-shadow:0 0 0 2px rgba(91,91,214,.12)}
.skin-card.locked{opacity:.72}
.skin-preview{height:76px;display:grid;place-items:center;margin-bottom:8px}
.skin-preview svg{width:64px;height:64px}
.skin-meta{display:flex;flex-direction:column;font-size:13px;margin-bottom:8px}
.skin-meta .muted{font-size:11.5px}
.skin-state{font-size:12px;padding:3px 9px;border-radius:999px;display:inline-block}
.skin-state.on{background:#e6f4ea;color:var(--ok)}
.skin-state.lock{background:#fef3c7;color:#7c5200}
.inline{display:inline}
.add-task{display:flex;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.add-task input[type=text]{flex:1;padding:8px 12px;border:1px solid #d0d7de;border-radius:9px;font:inherit;font-size:13.5px}
.note{font-size:12.5px;margin:10px 0 0}
.steps{margin:0;padding-left:20px}
.steps li{margin:10px 0;line-height:1.6}
.steps li b{display:block;font-size:14px}
.steps li span{color:var(--muted);font-size:13px}
.steps code{background:#f2f3f7;padding:1px 5px;border-radius:5px;font-size:12px}
.quota{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.quota li{display:grid;grid-template-columns:96px 1fr 86px;align-items:center;gap:10px;font-size:13px}
.quota .q-label{color:var(--muted)}
.quota .q-bar{height:8px;border-radius:6px;background:#eef0f5;overflow:hidden}
.quota .q-bar i{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,#8f7bff,#5cc8ff)}
.quota .q-num{text-align:right;color:var(--muted)}
.quota .q-num b{color:var(--ink)}
.quota li.full .q-bar i{background:linear-gradient(90deg,#ff8a5c,#ff5c7a)}
.quota li.full .q-num b{color:#c0392b}
.list-plain{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:13px;color:var(--muted)}
.list-plain li{padding-left:14px;position:relative}
.list-plain li::before{content:"·";position:absolute;left:2px;color:#d4a72c;font-weight:700}
.card.warn{border-color:#f0d9a8;background:#fffdf5}
.passport{list-style:none;margin:0;padding:0;font-size:13.5px}
.passport li{padding:6px 0;border-top:1px solid var(--line)}
.passport li:first-child{border-top:0}
table.hosts{width:100%;border-collapse:collapse;font-size:13.5px}
table.hosts th,table.hosts td{text-align:left;padding:7px 8px;border-top:1px solid var(--line)}
table.hosts th:nth-child(2),table.hosts td:nth-child(2){white-space:nowrap;width:1%}
table.hosts td:nth-child(3){word-break:break-all}
table.hosts th{color:var(--muted);font-weight:600;font-size:12.5px;border-top:0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}
.dot.ok{background:#2da44e}.dot.warn{background:#d4a72c}.dot.off{background:#c6cbd1}
.upgrade .license{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.license input[type=text]{flex:1;min-width:250px;padding:8px 12px;border:1px solid #d0d7de;border-radius:9px;font:inherit}
.ok{color:var(--ok);background:#eaf6ec;padding:10px 13px;border-radius:9px;margin:0 0 14px}
.bad{color:var(--bad);background:#fdeceb;padding:10px 13px;border-radius:9px;margin:0 0 14px}
footer{padding:6px 2px;font-size:13px}
footer a{color:var(--brand);text-decoration:none}
footer a:hover{text-decoration:underline}
footer details{margin-top:8px}
footer summary{cursor:pointer}
@media (max-width:640px){
  .hero{grid-template-columns:1fr}
  .stat-grid{grid-template-columns:repeat(2,1fr)}
  .top{flex-direction:column;align-items:flex-start}
}
`;

/**
 * 渲染产品主页。
 *
 * @param {object} vm view-model（index.js 组装）
 * @param {object} [vm.license]   {tier,label,exp,maxSeats,cloudRooms,describe,reason,path}
 * @param {object} [vm.room]      房间摘要
 * @param {object} [vm.board]     {totals, latest}
 * @param {object} [vm.pet]       {name,state,stateLabel,habits,tasksDone,memoryCount,activeDays}
 * @param {string} [vm.petSprite] 已渲染好的桌宠 SVG
 * @param {Array}  [vm.skins]     [{id,name,author,price,currency,owned,active,preview}]
 * @param {object} [vm.passport]  {enabled,kid,cards}
 * @param {object} [vm.mcp]       {hosts:[{name,installed,registered,path}]}
 * @param {object} [vm.flash]     {ok,text} 动作后的一次性提示
 * @returns {string} 完整 HTML
 */
/** 自检：可选模块（皮肤市场 / 支付渠道 / 配额）没加载起来时，把原因摆出来。 */
function issuesHtml(vm) {
  const list = Array.isArray(vm.issues) ? vm.issues.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!list.length) return '';
  const rows = list.slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join('');
  return `<section class="card warn">
  <div class="card-head"><h2>自检</h2><span class="muted">下面这几块没起来，其它功能照常</span></div>
  <ul class="list-plain">${rows}</ul>
</section>`;
}

export function deckPageHtml(vm = {}) {
  const actPath = String(vm.actPath || '/deck/act');
  const model = { ...vm, actPath };
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nexi 灵犀</title>
<style>${STYLE}</style>
</head><body><div class="wrap">
${headerHtml(model)}
${flashHtml(model)}
${issuesHtml(model)}
${heroHtml(model)}
${boardHtml(model)}
${skinsHtml(model)}
${quotaHtml(model)}
${passportHtml(model)}
${upgradeHtml(model)}
${nextStepsHtml(model)}
${connectHtml(model)}
${footerHtml(model)}
</div></body></html>`;
}

export const __test__ = { esc, money, ago, num0, STATUS_ZH };
export default deckPageHtml;
