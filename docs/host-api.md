# DSH 宿主 API 实测笔记（agentdeck-super 用到的那一面）

这份文档只回答一件事：**我们依赖的宿主接口，到底被什么证据证明过它长这样。**
不是抄官方文档（我们也拿不到），每条结论都标了证据来源和置信度。

- 宿主版本：DSH `0.2.1-rc.5`（`dsh --version` 同机核对）
- 机器：Windows · Node v24.15.0 · 独立 profile `agentdecktest`（没碰日常的 `desktop`）
- 被测插件：`agentdeck-super@1.4.1`（本地 `npm pack` 的 tarball，不是 link 源码目录）

## 0. 证据从哪来（先看这个，再看结论）

| 编号 | 证据 | 能证明什么 | 位置 |
| --- | --- | --- | --- |
| E1 | 19 个宿主契约用例（假 ctx） | 注册形状、路由、命令、降级、卸载 | `tests/host.test.mjs` |
| E2 | tarball 装进干净 profile + headless 真会话调工具 | 装完真的能用、真的落盘 | `docs/evidence/install-headless-1.4.1-2026-11-05.md` |
| E3 | 故意少写 `output` 的探针插件 | 宿主在**注册时**抛错、该条目失活但 dsh 照常跑 | §3.1 复现步骤 |
| E4 | 能力探针插件（真机 headless 里读服务面 + 真调一次模型） | 哪些服务存在、`ctx.get` 语义、`llm.stream` 的真实块类型 | §2、§5、§6 |
| E5 | 本仓库调用点 | 我们实际怎么用（行号可点） | `lib/index.js` |
| E6 | 机级授权/迁移探针（临时脚本：假宿主 + 两个临时工作区 + 临时密钥对） | 授权码存机级、换工作区不掉档、老授权自动迁移 | §8（脚本未入库，复现要点见 §10） |

置信度标记：**✅ 实测**（E1–E4 至少一条直接命中）｜**🔶 推断**（依据 cordis 语义或观察到的现象，没单独做对照实验）｜**❓ 未验证**（写了但没证据，别当承诺）。

> 为什么不能引宿主源码：本机 `@deepseek-ai/dsh` 这个 npm 包只有 CLI（`lib/bin.js`），GUI 运行时在 `…\Programs\DeepSeek Harness\resources\app.asar`（213 MB，没有解包的 dsh 目录）。所以本文一律以「我们跑出来的现象」为准，不编造源码行号。

## 1. 插件怎么被宿主认下来 ✅

包形状（`package.json` + `cordis.patch.yml`，两者必须对齐）：

```json
{
  "name": "agentdeck-super",
  "type": "module",
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
- insert:
    - id: agentdeck-super
      name: 'agentdeck-super'
```

- `id` 必须等于包名；`id: 值` 那行后面不能写行尾注释（市场预检会挑）。
- 入口导出：`name`、`inject`、`Config`、`apply(ctx, config)`；`apply` 可以是 **async**（我们就是 async，真机加载正常）。
- 装：`dsh plugin add <spec>` 内部走 pnpm。tarball 用 `file:D:/…/agentdeck-super-1.4.1.tgz`；装完 `dsh plugin --profile <p> list` 里能看到，profile 的 `dsh.profile.bundles` 里也有它。
- `dsh plugin add` 需要 **pnpm 在 PATH 上**（只装了 npm 的机器会直接失败，报找不到 pnpm）；`✕ missing peer @deepseek-ai/cordis@^4.0.4` 只是警告，不影响安装与加载。
- `file:<目录>` 装的是**快照**：源码改了 `add` 会回 `Already up to date`，必须 `remove` 再 `add` 才会更新（E4 过程中被这条坑过一次，白跑一轮）。

**加载失败是隔离的** ✅：`apply` 里抛异常 → 宿主只打一行 `dsh: warning: 1 entry did not activate`，进程退出码仍是 0，其余插件照常。所以「插件没生效」时先找这行 warning，不要怀疑 dsh 整体。

## 2. 真实会话里能摸到哪些服务 ✅

E4 探针在一个真实 headless 会话的 `apply(ctx)` 里逐个 `ctx.get(name, false)`，结果：

| 服务 | headless profile | 说明 |
| --- | --- | --- |
| `tools` | ✅ 对象 | 硬依赖，我们 `inject: ['tools']` |
| `commands` | ✅ 对象 | 存在；`list()` 返回 7 个命令，其中含我们的 `deck`、`agentdeck` |
| `llm` | ✅ 对象 | `stream` 是函数，另有 `registerAdapter` / `listProviders` 等（见 §5、§6） |
| `agentDefaultModel` | ✅ 对象 | `currentSelection()` → `{ provider: 'magpie', model: '1/deepseek-v4.1-flash' }`（本机配置，别人机器不同） |
| `storage` | ✅ 对象，但**不是同步 KV** | 原型上只有 `mount / form / domain`，`loadSync/saveSync/load/save` 全是 `undefined` |
| `fs` / `shell` / `sessions` / `agents` / `settings` / `skills` / `subprocess` / `sandbox` / `timer` | ✅ 对象 | 我们没用；`fs` 带 `locks`、`defaultMode`，`sandbox` 带 `workspaceGrants` |
| `webServer` | ❌ `null` | headless 没有 HTTP 服务 → 我们的两个路由**根本不会挂**（见 §4） |
| `credentials` / `http` / `logger` / `plugins` / `registry` / `workspace` / `event` | ❌ `ctx.get` 为 `null` | `ctx.logger`、`ctx.emit` 作为属性可读（`typeof` 是 `function`），其余服务属性直接抛错 |

**属性访问的坑（🔶 但现象是实测的）**：没写进 `inject` 的服务，**不能** `ctx.xxx` 直接读——

```
ctx.llm        → Error: cannot get property "llm" without inject
ctx.webServer  → Error: cannot get property "webServer" without inject
ctx.name       → Error: cannot get property "name" without inject
```

读可选服务一律用 `ctx.get('名字', false)`（缺了给 `null`，不抛）。这条也是我们 `lib/index.js:539`（llm/默认模型）和 `lib/index.js:481`（storage）都用 `ctx.get` 的原因。

## 3. 四个注册面

### 3.1 `ctx.tools.register` —— 唯一有强制形状的接口 ✅

```js
ctx.tools.register({
  name: 'team_board',
  description: '…',
  parameters: { type: 'object', properties: { … } },   // JSON Schema
  output: {
    schema: { … },
    render(args, value) { return [{ type: 'text', text: String(value?.text || '') }]; },
  },
  async execute(args) { return { text: '给人看的中文结果' }; },
  // timeoutMs?: number
});
```

- **`output` 必填**。少了它，`register` 当场抛 `TypeError: tool "<名字>" must declare output { schema, render, presentationMeta? }`。E3 复现步骤（5 分钟）：
  1. 建一个只有 `package.json` + `cordis.patch.yml` + `index.js` 的探针插件，工具定义里故意不写 `output`；
  2. `dsh plugin --profile agentdecktest add file:<目录>`，跑一次 headless 会话；
  3. 看到 `dsh: warning: 1 entry did not activate`，该插件的工具**一个都不在**，但会话本身正常。
- `render` 返回 content 块数组（我们统一 `[{type:'text', text}]`）；`execute` 返回 `{ text }`，宿主拿它去渲染。
- 同名工具：宿主不覆盖，推测是注册时报错（我们代码里按「抛错 → 跳过」处理并写了注释，**未单独复现**）。
- 缺 `tools` 服务：我们整体不注册工具（`lib/index.js:188`）。`inject: ['tools']` 是硬依赖，没有它插件本来也不会被激活。

### 3.2 `ctx.webServer.register` ✅（E1 假 ctx；E4 证明 headless 无此服务）

```js
const dispose = ctx.webServer.register({
  kind: 'prefix',          // 'prefix' | 'exact'
  path: cfg.routePrefix,   // 默认 /adbp
  handler(req, res) { … },
});
```

- 返回 `dispose()`；卸载时调用它不会炸宿主（E1 用例「挂载器返回 dispose 且调用不抛」）。
- `kind: 'prefix'` 认领 `/adbp` 下全部路径，`'exact'` 只认 `/deck` 一条。
- 端口从 `ctx.webServer.port` 读（我们只用来打日志，读不到就写 `?`，🔶 非公开字段）。
- 没有 `webServer` 时 `ctx.inject(['webServer'], cb)` 的回调**根本不执行** → 静默没有网页，不是错误。headless 就是这种情况（E4：`webServer: null`）。

### 3.3 `ctx.commands.register` ✅

```js
ctx.commands.register({
  name: 'deck',
  description: '…',
  input: { hint: '直接回车看状态；也支持 board | teams | license <授权码> | help' }, // 可选
  handler(invocation) { return { kind: 'success', text: '…' }; },  // 或 { kind: 'error', text }
});
```

- 返回值必须是 `{ kind: 'success' | 'error', text }`，否则 TUI 显示不出来（E1 用例断言）。
- **斜杠命令只在 TUI 里被展开**。headless 里 `dsh --profile agentdecktest headless "/deck"` 把 `/deck` 当普通 prompt 发给模型，不会执行命令（✅ 实测）。
- 注册确实生效：E4 在真机 `commands.list()` 里看到了 `deck`、`agentdeck`（该 profile 共 7 个命令）。
- 老名字想保留就再注册一个（我们同时注册 `/deck` 和 `/agentdeck`）；重名注册是否抛错没测，我们 `try/catch` 兜住（❓）。

### 3.4 `ctx.inject` / `ctx.effect` / `ctx.get` ✅ + 🔶

- `inject: ['tools']`：**硬依赖**。cordis 4.0.5 的 `inject` 没有 optional 语义，把它写成 `['tools','webServer']` 会让整个插件在没 webServer 的 profile 里永远不激活（🔶 依据 cordis 语义，没做对照实验——但我们正是因为这条才把 webServer/commands 放进 `ctx.inject([...], cb)` 子作用域）。
- 可选服务标准写法：`ctx.inject(['webServer'], (scope) => { scope.effect(() => { …; return dispose; }, '标签'); });`
  —— 子 fiber 里注册、`scope.effect` 返回清理函数，宿主卸载/热重载时自己收。
- 收尾：`ctx.effect(() => () => { … });`（`lib/index.js:347`，卸载时 flush 任务板）。
- 日志：拿不到 logger 服务时 `console.warn` 兜底（`lib/index.js:426`），永远不因为日志把主流程搞挂。

## 4. 缺服务时的降级矩阵（我们的实际行为）✅

| 缺什么 | 现象 | 用户体验 |
| --- | --- | --- |
| `webServer` | `/adbp/*`、`/deck`、授权 POST 都不存在 | 网页没了；工具和命令照常 |
| `commands` | 没有 `/deck` | 网页和工具照常 |
| `llm` / 默认模型 | 宿主大脑通道关闭（`makeHostBridge` 返回 `null`），super_agent 回落 api/cli 通道 | 仍可用，只是要自己配 key 或用本机 CLI |
| `storage`（同步 KV） | 任务板改文件状态：`$DSH_HOME/agentdeck-super/state.json` | 无感 |
| 兄弟模块文件缺失（license/room/pet） | 对应工具/页面块少一块，`warn` 一行 | 无感，其余功能正常 |
| `enabled: false` | 什么都不注册（工具/路由/命令全空） | 用户明确关掉就该安静 |

E1 有两个用例专门盯这张表：「精简宿主（没有 webServer/commands/storage）也能起来」「enabled:false 时什么都不挂」。

## 5. 宿主模型通道 `ctx.llm.stream` ✅（这块最值得抄）

```js
for await (const chunk of ctx.llm.stream({
  provider: 'magpie',
  model: '1/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '…' }] }], // ← content 必须是块数组
  system: '你是…',
  maxTokens: 256,
})) {
  // chunk.type: 'block-start' | 'reasoning-delta' | 'text-delta' | 'finish' …
}
```

实测结论（E4，真机真调模型）：

- `content` 传**字符串**不会报错，而是流结束时给一个 `{ type: 'finish', reason: { kind: 'error', failure: { message: 'content.some is not a function', code: 'UNKNOWN' } } }`，正文空 → 表现为「模型没说话」。改成块数组 `[{type:'text',text:'…'}]` 后正常，正文 `"1+1 等于 2。"`。
- 块类型见过：`block-start`（带 `blockType:'reasoning'`）、`reasoning-delta`（思考过程）、`text-delta`（正文，我们靠它拼 `content`）、`finish`（`reason.kind` + `reason.failure`）。
- **`system` 是独立字段，不是 `role:'system'` 的消息**。E4 探针里 `system` 传了有效值、模型正常出正文；反过来，我们自己的 `toHostMessages` 早先把 system 消息整条丢掉——宿主不会报错，只是人设和工具协议悄悄没了。现在桥会先把 system 消息抽出来、拼成字符串单独传 `system`（`lib/index.js:555` 起），这也算 §7 之外的第 4 个静默坑。
- 我们的桥（`lib/index.js:535` 起，`chat()` 在 `:555`）只累计 `text-delta` 和 `tool-call-delta`，**故意丢掉 reasoning**（思考过程不该混进产品输出）；`usage` 块有就记 token，没有就算了。
- `currentSelection()` 给 `{ provider, model }`；拿不到就不声明宿主通道（宁可回落到 api/cli，也不留一个必然失败的通道）。
- 端到端印证（E2 那台机器、headless、**没配 baseUrl/apiKey/CLI**）：装 1.4.1 tarball 后调 `super_agent`（参数 `goal`），返回正文 `【结论】**结论：1+1 = 2。**`，结束原因「模型给出最终答复」——走的正是这条宿主通道，不是 api、也不是本机 CLI。

## 6. Provider 适配器可行性：有门，但没走通验证 ❓

E4 看到 `ctx.llm` 的原型上有这些方法：`registerAdapter`、`listProviders`、`listModels`、`resolveModelInfo`、`prepareCall`、`registerModelDiscovery`、`discoverModels`、`registerConfigurableProviders`…

- `listProviders()` 实测返回：`[{id:'deepseek-official',name:'DeepSeek'}, {id:'deepseek-account',name:'DeepSeek Account'}, {id:'magpie',name:'Magpie'}]`。
- `registerAdapter` 存在（`length === 2`，原生绑定实现 `function () { [native code] }`）。

**结论（不美化）**：从接口面看，插件**有可能**注册自己的 provider 适配器；但 `registerAdapter` 没有文档、没有类型说明、参数语义未知，我们也**没有真的注册成功过**（只确认它存在）。所以在 1.4 里我们**不做** provider 适配，`super_agent` 只走「宿主默认模型 / OpenAI 兼容 / 本机 CLI」三条已验收通道。真要做，属于 1.5 的独立探索，且必须先在真机上跑通「注册一个假 provider → `listProviders()` 里能看见 → `stream()` 能出正文」三步，再把结论写回这里。

## 7. 三条最容易踩的坑（README 可直接用）

1. **工具不带 `output` 会整个插件条目失活**——宿主在 `register` 时抛 `TypeError`，dsh 只留一行 `1 entry did not activate` 的 warning，工具一个都不会出现。
2. **没写进 `inject` 的服务别用 `ctx.xxx` 直接读**——会抛 `cannot get property "xxx" without inject`；可选服务一律 `ctx.get('xxx', false)`，缺了给 `null` 而不是炸掉。
3. **委托 store 时把 dep 名和工具里的取值名对齐**——桌宠那次就是 `deps.pet` 给了、工具读 `deps.profile`，结果不报错、静默在工作区新建了一份档案（`$DSH_HOME/agentdeck-super/.agentdeck/pet/profile.json` 才是对的）。

## 8. 附：其它值得记住的行为

- **`ctx.llm.stream` 的 `content` 必须是块数组**，字符串内容会得到空的 `finish` 且不抛错（§5）。
- **斜杠命令 TUI-only**：headless/脚本里别指望 `/deck` 被展开，命令文本要靠单测或 TUI 验。
- **`dsh plugin add file:<目录>` 是快照**，改源码后要 `remove` + `add`。
- **`storage` 不是同步 KV**：只有 `mount/form/domain`，我们的 `pickSyncStorage` 检测不到 `loadSync/saveSync` 就诚实回落到文件状态（`lib/index.js:478`）。
- **授权码和桌宠档案存机级（跟人走，不跟项目走）** ✅（E6）：路径是 `$DSH_HOME/agentdeck-super/.agentdeck/{license,pet}/…`，配置项 `licenseRoot` / `petRoot` 留空就走机级。授权码还带一次性迁移：机级没有、工作区 `.agentdeck/license/key.txt` 有 → **插件启动时**复制到机级（工具读授权前也会兜一次，`deps.migrateLicense`），**老文件保留**；迁移失败只 `warn`，不会让已付费的人掉回免费版。
- **`apply` 里任何 throw 都只毁自己那个条目**：dsh 继续跑（退出码 0），所以「工具全消失」时先搜 warning。
- 卸载路径要自己写好：`scope.effect(() => { …; return dispose; })`，热重载时不清理会重复挂路由。

## 9. 我没验证的（别当承诺）

- 同名工具注册的真实行为（覆盖？抛错？）——我们只按「抛错则跳过」写。
- `timeoutMs` 的具体语义（超时后是取消 execute 还是只报错）。
- `webServer.register` 的路径匹配细节（尾斜杠、查询串、大小写）。
- 多插件同时认领同一路径时的冲突行为。
- 非 headless（GUI/TUI）profile 的服务面差异（GUI 一定有 webServer，但端口/生命周期没实测）。
- `ctx.llm.registerAdapter` 的真实参数（§6）。

## 10. 复现入口

```powershell
# 全部单测（281 例，含宿主契约 21 例）
node --test --test-concurrency=1 "tests/*.test.mjs"

# 真机安装 + headless 验收（详见证据文档）
node "C:\…\npm\bin\npm-cli.js" pack
dsh plugin --profile agentdecktest add "file:D:/agentdeck-super/agentdeck-super-1.4.1.tgz"
dsh --profile agentdecktest "调用 team_board 工具（action=list），把原始返回贴出来。"

# E4 能力探针：一个只注册 caps_report 工具的临时插件，
# 在 apply(ctx) 里 ctx.get() 各服务 + 真调一次 ctx.llm.stream，跑完 remove

# E6 机级授权/迁移探针（本机 13/13）：造一对临时 Ed25519 密钥 + 两个临时工作区，
# 授权串放 $DSH_HOME/agentdeck-super/.agentdeck/license/key.txt，
# 分别在 wsA / wsB 两个 workspace 起插件实例，读 /deck status 与 ADBP GET /state；
# 迁移用例：授权只放工作区，断言首次读取后机级文件出现、内容逐字一致、老文件仍在。
```

探针要点（二十来行，想复现照抄）：

```js
export const inject = ['tools'];
export function apply(ctx) {
  const services = {};
  for (const n of ['tools','webServer','commands','llm','agentDefaultModel','storage','credentials'])
    services[n] = ctx.get(n, false) ? 'object' : null;
  ctx.tools.register({
    name: 'caps_report',
    description: '探针',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute() {
      return { text: JSON.stringify({
        services,
        selection: ctx.get('agentDefaultModel', false)?.currentSelection?.(),
        llmStream: typeof ctx.get('llm', false)?.stream,
      }, null, 2) };
    },
  });
}
```

（这份文档只描述我们验证过的宿主行为；结论会随宿主版本变，升级 rc 后请重跑 E1–E4 再改结论。）

## 11. 安装实录（可直接复现的原始输出）

一次性干净 profile，不碰日常账号：

```powershell
$env:Path = "$env:TEMP\adtest-pnpm\node_modules\.bin;$env:Path"   # dsh plugin 内部要 pnpm
cd D:\agentdeck-super
npm pack
# agentdeck-super-1.4.1.tgz · 约 319 KiB · 60 files（最终包，含机级授权/桌宠档案迁移）

dsh plugin --profile agentdecktest add "file:D:/agentdeck-super/agentdeck-super-1.4.1.tgz"
# + agentdeck-super 1.4.1
# Done in 894ms using pnpm v11.28.5
# （同一行会警告 ✕ missing peer @deepseek-ai/cordis@^4.0.4，不影响加载）

dsh plugin --profile agentdecktest list
# dsh-profile-agentdecktest C:\Users\王冕\.dsh\profiles\agentdecktest (PRIVATE)
# └── agentdeck-super@1.4.1
```

装完真跑（没配 baseUrl / apiKey / CLI，只有宿主自己在）：

```powershell
dsh --profile agentdecktest "调用 super_agent 工具，参数 prompt='用一句话回答：1+1 等于几？'，然后把工具返回的原始文本一字不改贴出来。"
```

返回（节选，逐字）：

```text
【super_agent】✅ 已完成
目标：用一句话回答：1+1 等于几？
工作区：C:\Users\王冕\AppData\Local\Temp\adtest-caps-run

【结论】
**结论：1+1 = 2。**

【执行轨迹】共 0 步
（没有执行任何工具调用）

【结束原因】模型给出最终答复
```

（注意：上面我传的是 `prompt`，但 `super_agent` 的必填参数其实叫 `goal`，所以模型自己把它纠成了 `goal` 再调；写测试或写文档时别照抄 `prompt`。）

落盘位置（同一次会话后核对）：任务板状态 `C:\Users\王冕\.dsh\agentdeck-super\state.json`，房间/聊天记录 `<工作区>\.agentdeck\rooms\`，桌宠档案 `C:\Users\王冕\.dsh\agentdeck-super\.agentdeck\pet\profile.json`，授权文件 `C:\Users\王冕\.dsh\agentdeck-super\.agentdeck\license\key.txt`（桌宠和授权都跟人走，不跟项目走；授权换项目目录不用重新激活，换台机器要重新激活）。

升级迁移实测（E6 的真机版）：清空机级授权、只在临时工作区放一张已签名授权，装上最终 tarball 后 headless 第一句就问 `deck_license status`——**不用先打开 `/deck`**，返回已是「当前档位：协作版」；机级文件同步出现、与工作区老文件逐字一致、老文件保留（跑完已清理测试授权，没污染真机）。

> 最终包（1.4.1）的完整安装验收（含 3 次 headless 工具调用、每个工具的输出、落盘核对）见 `docs/evidence/install-headless-1.4.1-2026-11-05.md`；那份文档写于桌宠档案改成机级之后，路径描述已与当前代码一致。
