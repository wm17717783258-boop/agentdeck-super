# agentdeck-super · 模块契约（v1.3.0）

> 一切按本文件实现，签名不得改动。改动必须先改本文件并在群里说明。
> 运行环境：Node >= 22（宿主 DSH 0.2.1-rc.5，ESM）。**纯 JS，无 TS 构建步骤**，`lib/` 即发布产物。

## 0. 产品一句话

在 DeepSeek Harness 里装一个插件，你就得到一个「超级 Agent」+ 一个「任意 Agent 皆可入组」的小组：
超级 Agent 自己会干活（文件/命令/检索/网页/任务板），也能把活派给本机任意 CLI Agent（claude / codex / dsh / gemini …）
或任何外部 Agent（ACP / OpenAI 兼容 / CDP 桌面 / ADBP 桥），按角色并行、带验收门，最后交付一个真实项目。

三个交付物：
1. `agentdeck-super`：DSH 插件包（npm），免费上架插件市场。
2. Pro 层（阶段 2）：云额度订阅 —— 服务端签发额度、托管 key、云端编排。**不能靠本地代码拦截收费**。
3. 文档：中英 README + 接入指南 + 市场提交条目。

## 1. 包结构（npm 文件白名单）

```
package.json          main=lib/index.js   exports["./client"]  dsh.bundle.patch  dsh.compatibility
cordis.patch.yml      - insert: [ {id: agentdeck-super, name: 'agentdeck-super'} ]    # id 行禁止行尾注释
lib/index.js          宿主侧 Cordis 插件：注册工具 / 服务 / 路由 / 命令
lib/engine/*.js       cli.js  bridge.js  adbp.js  llm.js  toolbelt.js  roles.js  board.js
lib/tools/*.js        super.js  team.js  join.js
lib/client.js         浏览器侧面板（阶段 2；v1 先给 HTML 状态页）
docs/  tests/         不入包
```

`dsh.compatibility.dshReleases`：至少给 `0.2.1-rc.5` 标 `compatible`（本机宿主版本），并给 `0.1.7-rc.2` 标 `incompatible`。

## 2. 模块契约

### 2.1 `engine/board.js`（状态与任务板 · 唯一真相源）
```js
export function createBoard({ storage, root }) => Board
// storage: 宿主 dsh-storage 句柄；不可用时退化为 ~/.dsh/agentdeck-super/state.json（原子写）
Board = {
  createTeam({ name, goal, members? }) => Team,              // Team={id,name,goal,members:[],createdAt}
  getTeam(teamId) => Team | null,
  listTeams() => Team[],
  addMember(teamId, spec) => Member,                          // Member={id,name,kind,manifest,joinedAt}
  listMembers(teamId) => Member[],
  addTask(teamId, { title, role, dependsOn?, acceptance?, assignee? }) => Task,
  listTasks(teamId, filter?) => Task[],                       // filter={status?,assignee?}
  claimTask(teamId, taskId, memberId) => boolean,              // 抢占式，原子
  completeTask(teamId, taskId, { ok, output, note? }) => Task,
  failTask(teamId, taskId, reason) => Task,
  nextTaskFor(teamId, memberId) => Task | null,                // 依赖已满足 + 未认领
  waitForTask(teamId, memberId, { timeoutMs }) => Promise<Task|null>,   // 长轮询
  appendEvent(teamId, evt) => void,                            // {ts,kind,text,...}
  listEvents(teamId, sinceSeq?) => Event[],
  stats(teamId) => { total, done, failed, running, pending }
}
```
并发安全：同一进程内用 Promise 链串行化写；跨进程必须落到文件锁（`root/.lock`，`wx` 打开 + 过期 10s 回收）。

### 2.2 `engine/cli.js`（本机 CLI Agent）
```js
export const AGENT_PRESETS // { claude:{cmd,args,detect}, codex:{...}, dsh:{...}, gemini:{...}, custom }
export function detectAgents({ env = process.env } = {}) => [{ id, label, available, cmd, version? }]
export async function runAgent(spec, prompt, opts = {}) => {
  rc, out, err, ms, meta: { agentId, model?, usage?: { in, out } }
}
// spec: { id, cmd, args, cwd?, env?, timeoutMs?, transport: 'cli' }  或字符串 id（查 AGENT_PRESETS）
// opts: { cwd, timeoutMs = 0, signal, onChunk(kind, text), stdinText }
```
要求：不吞 stderr；支持取消（`signal` → kill 进程树）；超时杀进程树；所有子进程 `windowsHide: true`；
参数模板从 AgentDeck 的成熟配方移植（`D:\AgentDeck\service\server.py` 的 `run_cli` / `AGENTS`，只读参考，不要改那个项目）。

### 2.3 `engine/bridge.js`（外部 / 非 CLI Agent）
```js
export const KINDS = ['acp-http', 'openai', 'cdp', 'adbp', 'cli']
export async function probe(manifest, { timeoutMs = 8000 } = {}) => { ok, kind, models?, error? }
export async function call(manifest, prompt, opts = {}) => { out, ms, meta }
// manifest 形态：
//  { id, kind:'acp-http', url }            Agent Client Protocol over HTTP+SSE
//  { id, kind:'openai',  baseUrl, apiKey, model }   OpenAI 兼容 /v1/chat/completions
//  { id, kind:'cdp',     port, app }       Chrome DevTools Protocol（桌面 App）
//  { id, kind:'adbp',    url }             我们自己的 ADBP
//  { id, kind:'cli',     cmd, args }       走 cli.js
```
要求：一律 `AbortController` 超时；ACP 需 `initialize` → `session/new` → `session/prompt` 并聚合流式 chunk；
OpenAI 兼容只取 `choices[0].message.content`，容错 SSE；CDP 只做「发消息 + 等回答」最小实现。

### 2.4 `engine/adbp.js`（Agent Deck Bridge Protocol v1 —— 任意 Agent 来领活）
```js
export const ADBP_VERSION = '1'
export function createIngress({ board, log, onEvent }) => {
  manifest() => object,                       // GET /adbp/v1/manifest
  handler(method, path, body) => { status, json } | null | Promise<{status,json}|null>,  // 非 ADBP 路由返回 null
}
```
路由（全部 JSON）：
- `GET  /adbp/v1/manifest` → `{protocol:'adbp', version:'1', name, capabilities:[...]}`
- `POST /adbp/v1/hello`    ← `{name, kind, capabilities?}` → `{teamId, memberId, token}`（register 到默认 team）
- `GET  /adbp/v1/tasks?memberId=&wait=25` → 长轮询，返回 `{task:{id,title,role,acceptance,context}}` 或 `{task:null}`
- `POST /adbp/v1/result`   ← `{memberId, taskId, ok, output, note?}` → `{ok:true}`
- `POST /adbp/v1/chat`     ← `{memberId, text}` → 群里发一条消息（appendEvent + onEvent）
- `GET  /adbp/v1/state?teamId=` → `{team, tasks, stats}`
鉴权：`Authorization: Bearer <token>`（hello 之后必须带）；失败 401。

### 2.5 `engine/llm.js`（超级 Agent 的大脑）
```js
export function createBrain({ host, cfg }) => {
  mode,                        // 'host'（用宿主模型，零配置）| 'api'（直连）| 'cli'（借本机 CLI）
  chat({ messages, tools, temperature, maxTokens, signal }) =>
        { content, toolCalls: [{ name, args }], usage: { in, out }, model },
  models() => string[]
}
// host: 宿主 dsh-llm 句柄（T1 负责查清真实接口，经 host.chat(...) 适配）
// cfg:  { mode?, baseUrl?, apiKey?, model?, cliAgent? }
```
双通道：优先宿主模型；配了 `baseUrl/apiKey` 走直连（OpenAI 兼容，SSE 容错）；都不可用时降级 `cli`（借 claude/codex 一次性回答）。
必须支持 tool-calling 文本模式：模型不支持 tools 时，用 `<<<TOOL{json}TOOL>>>` 协议解析。

### 2.6 `engine/toolbelt.js`（超级 Agent 的工具带）
```js
export const TOOLS // name -> { description, schema(JSON Schema), run(args, ctx) }
export function schemas(pick?) => object[]                      // OpenAI tools 格式
export async function invoke(name, args, ctx) => { ok, content }
export function makeCtx({ root, signal, log }) => ctx            // ctx={root,signal,log,board,teamId}
```
v1 必备工具：`fs_list` `fs_read` `fs_write` `fs_patch` `fs_glob` `fs_grep` `shell` `web_fetch` `http_request`
`board_add` `board_list` `board_done` `agent_run`（派活给某个成员）`ask_user`（写进事件流等回答）。
安全：所有路径 realpath 后必须落在 `ctx.root` 内；`shell` 默认 60s 超时，输出截断 200KB；不自动执行 `rm -rf` 类高危命令（要求 `confirm:true` 参数才放行）。

### 2.7 `engine/roles.js`（分工与验收）
```js
export const ROLES // lead architect critic worker tester scribe → { system, tools, whenToUse }
export async function planProject({ brain, brief, opts }) => {
  goal, tasks: [{ id, title, role, acceptance, dependsOn: [] }]
}
export async function runGraph({ tasks, run, concurrency = 3, gate }) => {
  ok, results: { [taskId]: { ok, output, error? } }, failures
}
// run(task) => Promise<{ok, output}>  ; gate(task, result) => { ok, reason }（默认按 acceptance 自检）
```

### 2.8 `tools/*.js`（暴露给宿主的工具）
```js
export function createSuperTool(deps) => Tool    // 名字：super_agent
export function createTeamTool(deps)  => Tool    // 名字：team_orchestrate
export function createJoinTool(deps)  => Tool    // 名字：agent_join
export function createBoardTool(deps) => Tool    // 名字：team_board
Tool = { name, description, parameters /* JSON Schema */, output, execute(args, exec) }
```
`deps = { brain, registry, board, workspace, emit, runAgent, callRemote, ingress, cfg }`

**修订（已查实宿主 API，2026-11-05）**：宿主用 `ctx.tools.register(def)`，def 的形状是
`{ name, description, parameters /* 原生 JSON Schema */, output: { schema, render(args,value)=>[{type:'text',text}] }, execute(args, exec), timeoutMs? }`。
所以每个 Tool 额外带 `output`：
```js
output = { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
           render: (args, v) => [{ type: 'text', text: String(v?.text ?? v) }] }
```
`execute(args, exec)` **返回 `{ text }`**（可读报告）；`exec` 是宿主给的执行上下文，可能含 `signal`/`cwd`，取不到就用默认值。
`execute` 绝不允许抛异常（宿主只会转成一行 `Error: ...`）；所有失败都 `return { text: '错误：...' }`。
不依赖 `@deepseek-ai/dsh-tools`（`defineTool` 只是把属性 DSL 编译成 JSON Schema 的糖，我们直接给 JSON Schema）。

## 3. `lib/index.js`（宿主侧入口 · T1 独占）
```js
export const name = 'agentdeck-super'
export const inject = [...]                 // 依 T1 查到的服务名
export function apply(ctx) { ... }          // 注册 4 个工具 + ADBP 路由 + 1 个命令 + 配置项
export default { name, inject, apply }      // 兼容两种加载方式
```
要求：任何依赖缺失都不能让宿主启动失败（全部 `try/catch` + `ctx.logger?.warn`）。

## 4. 测试（不烧配额）
- 全部外部模型/CLI 用 **假件**：`tests/fixtures/fake-agent.mjs`（模拟 CLI，读 prompt 回固定 JSON）、`tests/fixtures/fake-openai.mjs`（本地 HTTP）。
- 跑法：`node --test --test-concurrency=1 "tests/*.test.mjs"`（每个 teammate 自己加 `tests/<模块>.test.mjs`；Windows 上必须串行，并行会因临时目录/端口互相踩而假红）。
- 一个端到端脚本 `tests/e2e-local.mjs`：建组 → 3 个假成员领活 → 并行完成 → 校验任务板终态。
