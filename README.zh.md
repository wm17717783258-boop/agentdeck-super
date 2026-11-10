# agentdeck-super · 超级 Agent + 多 Agent 小组 + 跨机作战室

[![npm](https://img.shields.io/npm/v/agentdeck-super.svg)](https://www.npmjs.com/package/agentdeck-super)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![repo](https://img.shields.io/badge/source-GitHub-181717.svg)](https://github.com/wm17717783258-boop/agentdeck-super)

> 一个装在 DeepSeek Harness 里的插件：**给你一个什么活都能自己干的超级 Agent，再给你一间谁都能进来干活的作战室。**
>
> **三种装法，挑一个（都能用）**
>
> | 你手上有什么 | 复制这一行 |
> | --- | --- |
> | **Claude Code** | `/plugin install nexi --marketplace wm17717783258-boop/agentdeck-super` |
> | 任意电脑，最省事 | `npx -y agentdeck-super@latest --all` |
> | 已经在用 DSH | `dsh plugin add agentdeck-super` |
>
> **装完跑一句 `nexi doctor`** —— 它用人话告诉你这台机器能不能用；
> 不能用会直说差在哪，最后给你一段可以原样发给我的报告。
>
> 多台设备要测：每台都重复上面这一行，再各跑一次 `nexi doctor`。
> 完整步骤见 [`docs/装机和多设备测试.md`](docs/装机和多设备测试.md)。

> 开源仓库（核心 AGPL-3.0 / 适配器 Apache-2.0，见 [`LICENSING.md`](LICENSING.md)）：https://github.com/wm17717783258-boop/agentdeck-super

> **想知道每件事做到哪一步？看 [`docs/功能现状核对表.md`](docs/功能现状核对表.md)。**
> 那里逐条写了「已做到 / 部分做到 / 未实现」，含怎么验、边界是什么。本文下面的宣传语以那份表为准。

`dsh plugin add agentdeck-super` 之后，你的 DSH 里会多出七样东西：

| 能力 | 说明 |
| --- | --- |
| 🦾 **超级 Agent** | 它自己会读文件、改代码、跑命令、搜代码库、抓网页、维护任务板——不是一个只会聊天的模型，而是一个能把活干完的执行体 |
| 👥 **主流 Agent 入组** | 只要宿主支持 MCP（stdio / HTTP）、本机 CLI、ACP over HTTP、OpenAI 兼容服务、桌面 App（CDP）或 ADBP 之一，就能进同一个小组；不限 Agent 厂商和语言 |
| 🧩 **分工并行交付** | 按 架构/开发/评审/测试/文档 角色拆任务，成 DAG、并行执行、过验收门，最后交一个真项目，而不是一堆聊天记录 |
| 📋 **任务板** | 谁在干什么、干到哪了、失败几次，全在板子上；跑完可复盘 |
| 🌐 **跨机房间** | 把邀请链接发给同事，**客人不用买授权、不用配模型**；没装 DSH 会先打开网页说明，一行安装后进同一张任务板。本地房间不用联网 |
| 🐾 **桌宠（数字分身）** | 把你的工作习惯记成可确认、可回滚的统计规则（不是机器学习）；皮肤可换；能去朋友那儿串门、能替你和别的桌宠开会，结论直接落成任务 |
| 🎨 **皮肤市场** | 桌宠的样子可以换、也可以买（¥18 起，创作者拿 80%）；**没接支付渠道时它老实说「环境未配」**，不会假装买到了 |

---

## 为什么需要它

单个 Agent 有三个天花板：

1. **只能聊天**——没有工具带，改不了文件、跑不了命令，最后还得你自己动手；
2. **只能用一家**——你有 claude、codex、dsh、公司内网 Agent，它们各说各话，凑不到一张桌上；
3. **只能一个人干**——同事帮不上忙，任务板和上下文都锁在你自己的窗口里。

这个插件把三件事一起解决：给它工具带、给它队友、给你一间屋子。

---

## 和别的多 Agent 插件有什么不一样

| | 常见的团队/编排插件 | agentdeck-super |
| --- | --- | --- |
| 成员是谁 | 只有自家宿主里的 subagent | **异构**：外部 CLI 进程、HTTP 服务、桌面 App、别的机器上的 Agent（ADBP） |
| 跨机器 | 一般不做，或只能远程遥控一个端 | **多方房间**：多人多 Agent 同一张任务板，任务/认领/完成双向同步、认领互斥 |
| 邀请 | 发一条消息给你看 | **邀请即席位**：房主付费建房间，客人凭链接入座，**客人不需要授权** |
| 断网 | 直接不可用 | **降级可用**：没有中继，本地团队和工具带照常干活 |
| 上手 | 要先配模型/写配置 | **零配置**：装完就用宿主模型，自动探测本机已装的 CLI |
| 数据 | 可能上传 | 任务板与桌宠档案在 `$DSH_HOME/agentdeck-super/`（全机一份，人换项目档案也跟着走，可用 `boardRoot`/`petRoot` 改）· 跨机房间会话在 `<工作区>/.agentdeck/rooms/`（房间属于项目）· 无遥测 |

> 诚实说明：生态里已有 ~30 个团队/编排类插件、39 个桌宠类插件，DSH 本身也自带 Agent Teams。我们不声称"首创"，我们的差异是**异构成员 + 多方房间 + 邀请即席位 + 桌宠串门**这四件事同时成立。

---

## 安装

```bash
# ① DSH 插件版（在 DSH 里用）
dsh plugin add agentdeck-super

# ② 任意 MCP 宿主版（Claude Code / Codex / Cursor / Windsurf / Cline / Continue / Gemini CLI / Claude Desktop）
# 上架 npm 后，任意电脑一条命令：
npx -y agentdeck-super@latest --all

# 未上架 / 离线测试：在交付包目录里
node install.mjs --bundle .\agentdeck-super-1.11.9.tgz

# 本地开发（会把源码目录直接写进宿主配置，仅调试用）
node install.mjs --dev codex
dsh plugin --profile dev add link:D:/agentdeck-super
```

安装器会把完整包放进固定目录（Windows 默认 `%LOCALAPPDATA%\Nexi`），写一个稳定启动器
`<安装目录>\bin\nexi.mjs`，再把该启动器注册到本机已安装的宿主。**以后升级只切版本指针，
宿主配置里的路径不变**；改完代码重新打 tgz 后：

```powershell
node <安装目录>\bin\nexi.mjs update --bundle .\agentdeck-super-1.11.9.tgz
```

改自己的源码后，不想每次打 tgz，可以先用固定目录安装当前源码：

```powershell
node install.mjs --no-hosts
```

装完直接做真机配对，不用去版本目录里找脚本：

```powershell
node <安装目录>\bin\nexi.mjs pair help
```

装完重启宿主，工具会出现在 Agent 的工具列表里；输入 `/deck` 看状态。

> 搜索安装的真实边界：npm 是包仓库，MCP Registry 只对支持它的客户端可见，DSH 市场只给 DSH。
> 不存在“所有主流 Agent 共用同一个插件搜索框”。能保证的是**同一条安装命令、同一个包、同一套工具**。

**先验证它真的能跑**（不联网、不烧模型额度）：

```bash
node tests/e2e-local.mjs     # 5 步全绿：接入 / 任务板 / 授权 / 跨机房间 / 断网降级
node tools/real-agents-check.mjs   # 用你机器上真装着的 claude/codex/gemini/dsh 真跑一轮
node tests/e2e-project.mjs   # 真让两个厂商的 Agent 合作写完一个能跑的模块 + 测试（会花一点 Agent 额度）
```

最后那条是"能不能一起干"的硬证据：建组 → 派活 → Claude Code 写实现 → Codex 写测试 → `node --test` 真跑通，
产出目录和每步耗时都留在 `docs/evidence/real-project-*.md` 里。只装了一个 Agent 也能跑，只是会提示"跑不了这条验收"。

---

## 五个用法

### 1. 让超级 Agent 自己干

```text
用 super_agent 帮我把这个仓库的 README 补上「快速开始」一节，
并跑一遍测试确认没弄坏东西。
```

它会自己：列目录 → 读文件 → 改文件 → 跑 `node --test` → 看失败日志 → 修 → 再跑 → 汇报。

### 2. 把主流 Agent 拉进同一个小组（需一种支持的接入方式）

```text
用 agent_join 把本机的 claude 和 codex 加进来，
再用 team_orchestrate 让它们一起把这个需求做完：
「给这个项目加一个导出 CSV 的接口，带测试」。
```

`agent_join` 支持：

| 方式 | 适合谁 | 怎么接 |
| --- | --- | --- |
| `cli` | 本机已装的 Agent CLI | 填命令即可，内置 claude/codex/dsh/gemini 预设 |
| `acp-http` | 支持 ACP 的 Agent（编辑器系） | 填 `url` |
| `openai` | 任何 OpenAI 兼容服务（含本地 vLLM/Ollama 网关） | 填 `baseUrl` / `apiKey` / `model` |
| `cdp` | 只能开 GUI 的桌面 App | 填调试端口 |
| `adbp` | **你自己写的 Agent**（任何语言） | 见下 |

### 3. 自研 Agent 接入（ADBP，20 行）

```js
// 你的 Agent 只要会 HTTP，就能进组领活
const BASE = process.env.ADBP_URL, TOKEN = process.env.ADBP_TOKEN;
const hello = await fetch(`${BASE}/hello`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '我的内网Agent', kind: 'custom', capabilities: ['code'] }) }).then(r => r.json());

for (;;) {
  const { task } = await fetch(`${BASE}/tasks?memberId=${hello.memberId}&wait=25`, {
    headers: { authorization: `Bearer ${hello.token}` } }).then(r => r.json());
  if (!task) continue;
  const output = await doMyOwnWork(task);          // ← 你自己的 Agent 干活
  await fetch(`${BASE}/result`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hello.token}` },
    body: JSON.stringify({ memberId: hello.memberId, taskId: task.id, ok: true, output }) });
}
```

协议说明见 [`docs/transports.md`](docs/transports.md)，四个路由：`manifest` / `hello` / `tasks` / `result`。

### 4. 和同事一起干（跨机房间）

```text
/deck room create 官网改版
```

它会给你两条邀请（同一次邀请，两种发法）：

```
dsh://agentdeck/join?room=2bbc9263&t=93SqhZZi     ← 装了 DSH 的人：点开直达
http://<relay>/?room=2bbc9263&t=93SqhZZi          ← 没装 DSH 的人：打开是加入页
```

第二条是**网页加入页**：对方没装 DSH 也能打开，页面上一行 `dsh plugin add agentdeck-super`、邀请码、以及一句"你是客人，不需要买授权"。安装仍需要一次，不能把网页说成免安装客户端。

把链接扔给同事，他点开就进房间（**他不需要授权码**），然后：

- 你派的任务会同步到他那边，他可以认领、做掉、回报；
- 他那边做的活你这边实时可见，任务不会重复认领；
- 断网了？本地任务板照常记，恢复后自动补同步。

**自己搭中继**（不付费也能跨机，代码是 AGPL-3.0 的）：

```bash
node tools/relay-server.mjs --port 8787 --data .relay-data
# 打开 http://<你的机器>:8787 就是服务自述页；房主侧把 relayUrl 指向它
# 想自己发授权码：node tools/license-cli.mjs init → 把公钥放进 AGENTDECK_LICENSE_PUBKEY 再启动 relay
```

### 5. 桌宠（数字分身）

```text
/deck pet
```

- **越用越像你**：它记你几点开工、用什么工具、常做哪类活；重复三次以上的动作会变成"习惯"，并在开工时替你列出今天该干的三件事。
- **皮肤**：内置 3 套免费；付费皮肤由授权码里的 `skins` 字段解锁，删掉皮肤不影响任何功能。
- **串门 / 开会**：把桌宠派到朋友的房间看一眼、留句话；多只桌宠围绕一个议题开会，结论直接落成任务板上的任务。

---

## 工具一览

| 工具 | 什么时候用 |
| --- | --- |
| `super_agent` | 一个需要动手（读写文件、跑命令、查网页）的完整任务，交给它自己去循环完成 |
| `team_orchestrate` | 一个有多个子任务的项目，要拆活、并行、验收后交付 |
| `agent_join` | 想把某个 Agent（本机/远程/自研）加进小组，或先扫描本机有哪些能用的 Agent |
| `agent_passport` | 签发/校验/查账本/吊销一张离线 Ed25519 能力卡（`NEXP1.…`）：跨机器可用、不需要共享密钥目录，可指定 `kid` 盯住签发方 |
| `team_board` | 看板子：谁在干什么、进度、失败详情、导出运行记录 |
| `deck_room` | 建/进/退出跨机房间，发邀请，同步任务（协作版；本地房间免费） |
| `deck_license` | 查看/激活授权，看当前档位和权益 |
| `pet_visit` / `pet_meeting` / `pet_skin` | 串门、桌宠开会、换皮肤 |
| `twin_remember` / `twin_recall` / `twin_brief` / `twin_forget` / `twin_habit` | 数字分身记忆：记一条（带来源与可见范围）、换宿主也能召回、今天的简报、删除、提议一个习惯 |
| `deck_meeting` | 多 Agent 会议：开场 → 每个 Agent 各自发言（原样落盘，不经模型改写）→ 结会出决议并把活拆进任务板 |
| `deck_automation` | 定时或一次性任务：审批队列、每项跑几次的上限、全局 `stop` / `resume`、执行记录 |

`/deck` 命令是这些工具的快捷入口：`/deck` 看状态、`/deck room` 房间、`/deck license` 授权、`/deck pet` 桌宠。

**不想敲命令？打开 `/deck/console`** —— 那就是「测试台」：上面每个按钮点一下 = 真调一次工具，**原始返回原样打给你看**（不做美化）。建组、加任务、签通行证、验卡、记记忆、看皮肤、开会……都能点出来。只读模式（`mcp.readOnly`）下会改状态的 6 个按钮直接置灰并写明原因，而且**服务端**也会拦（页面置灰只是提示，不是闸门）。

---

## 配置（大脑）

插件默认**用宿主自带的模型**，零配置即可用。也可以换：

```yaml
# DSH 设置 → 插件 → agentdeck-super
mode: host          # host | api | cli
# api 模式：任何 OpenAI 兼容服务
baseUrl: https://api.deepseek.com/v1
apiKey: ${DEEPSEEK_API_KEY}
model: deepseek-chat
# cli 模式：借本机 CLI 当大脑（没 key 时的兜底）
cliAgent: claude
```

三种模式都会自动降级：`host` 不可用 → 试 `api` → 再试 `cli`。

---

## 安全与权限

- 插件在本机以你的用户权限运行，**能读写文件、能执行命令**——这是它能干活的前提，也是你要知道的风险。
- 所有文件操作被限制在当前工作目录内（realpath 校验）。
- `shell` 有超时与输出截断；`rm -rf` 这类高危命令必须显式带 `confirm: true`。
- 所有动作写进任务板事件流，可导出复盘。
- 跨机房间只同步**任务与聊天**，不同步你的文件；房间里的人默认互相信任（同团队场景）。
- 无遥测。任务板是 `$DSH_HOME/agentdeck-super/state.json` 一个文件，桌宠档案在同一目录，跨机房间在 `<工作区>/.agentdeck/rooms/`；删掉即恢复出厂。

## 借给别人用：只读模式 + 宿主认证

**只读模式（`mcp.readOnly`）**：把自己的 Hub 借给别人的模型时，把写的一半关掉。

```yaml
mcp:
  readOnly: true      # 默认 false
```

开了之后：`tools/list` 从 23 个降到 19 个（`super_agent`、`team_orchestrate`、`pet_meeting`、`twin_remember` 直接不出现，`agent_passport` 只留 show/verify/list），`team_board` 的描述里写着还剩下哪些动作，任何写动作返回 `isError` 并告诉你拧哪个开关——**任务板文件不会多一个字**。`GET /v1/mcp` 会报 `readOnly: true` 且只列真能调的；stdio 那条路用 `nexi mcp --read-only`，或者环境变量 `NEXI_MCP_READONLY=1`。

**宿主认证（`nexi verify-host`）**：不靠自己说"支持"，让宿主自己报。

```bash
nexi verify-host claude-code      # 单个：装 → 让宿主自己确认 → 卸 → 配置逐字节还原
nexi verify-host --all --record   # 8 个全跑，矩阵写进 docs/evidence/hosts-<版本>.txt
```

本机实测（`docs/evidence/hosts-1.11.2.txt`）：

| 宿主 | 结论 |
| --- | --- |
| Codex | ✅ 已认证（`codex mcp list`） |
| Claude Code / Claude Desktop / Cursor / Windsurf / Cline / Continue / Gemini CLI | ⚪ 本机未安装——**拒绝伪造配置** |

---

## 免费版 vs 付费版

| | 免费 | 协作版 ¥29/月（年付 ¥288） | 工作室版 ¥99/月（年付 ¥999，含 3 席，加席 ¥25/席·月） | 企业版 ¥30000 起/年 |
| --- | --- | --- | --- | --- |
| 超级 Agent + 工具带 | ✅ | ✅ | ✅ | ✅ |
| 主流 Agent 入组 | ✅ | ✅ | ✅ | ✅ |
| 本地群组房间 / 席位上限 | ✅ 3 / 3 | ✅ 20 / 8 | ✅ 50 / 30 | ✅ 999 / 200 |
| 并行车道 | 1 | 3 | 6 | 10 |
| **跨机云房间** | — | 20 | 50 | 200 |
| 付费皮肤 | — | ✅ | ✅ | ✅ |
| 无人值守自动跑 / 审计导出 | — | ✅ / — | ✅ / ✅ | ✅ / ✅ |

- **客人免费**：别人建的房间，你凭邀请进去干活不需要授权。
- **企业版 ¥30000 起/年**：200 席位、200 个云房间、10 路并行、专属支持——同一张 `TIERS` 表。**私有化部署未实现，不作为已售能力**。
- **可自建**：`tools/relay-server.mjs` 是完整中继，自己搭、自己发码，一分钱不花。
- 权益表在 [`lib/license.js`](lib/license.js) 里公开可查；收款与发码流程见 内部运营资料（发码与收款手册，不随包发布）。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | 九条核心能力各自落在哪段代码、哪条证据；留存设计；路线图 |
| [`docs/PASSPORT.md`](docs/PASSPORT.md) | Agent 通行证：签发/验卡/K 钉签发方/只读边界，以及「证明什么、不证明什么」 |
| 内部运营资料（发码与收款手册，不随包发布） | 真实收款手册：签码、发码话术、售后、什么时候才需要后端 |
| 内部运营资料（上架文案，不随包发布） | 市场条目文案、PR 正文、截图清单 |
| 内部运营资料（发布检查表，不随包发布） | 开源 + 上架手工单：建仓库、干跑体检五关、真发布、市场 PR、出问题怎么查 |
| [`docs/host-api.md`](docs/host-api.md) | 宿主 API 的形状与坑（写插件的人先看这个） |
| [`docs/transports.md`](docs/transports.md) | 五种传输方式与 ADBP 协议细节 |
| [`docs/PET.md`](docs/PET.md) | 桌宠：档案格式、习惯算法、皮肤规范、串门与会议协议 |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | 模块之间的接口契约（改代码前先看这个） |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) · [`docs/VISION.md`](docs/VISION.md) | 竞品调研与产品愿景 |
| [`docs/host-api.md`](docs/host-api.md) | DSH 宿主 API 实测笔记（宿主 0.2.1-rc.5）：证据 E1–E6、服务矩阵、四个注册面、降级矩阵、`ctx.llm.stream` 契约、三条最容易踩的坑、安装实录 |
| [`docs/evidence/`](docs/evidence/) | 验收证据：端到端自检、真机 Agent 实跑、两个厂商 Agent 真合作干项目、tarball 安装 + headless 执行 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南：怎么加一种新 Agent、测试要求、三条硬规则 |

**自己验一遍**（前四条不联网、不烧模型额度；最后一条走真实公网 HTTPS）：

```bash
npm test                                              # Windows 下显式枚举 tests/*.test.mjs
node tests/e2e-local.mjs                              # 5 步端到端，出一份证据文件
node tools/real-agents-check.mjs                      # 真机跑本机装着的 Agent
node tests/e2e-project.mjs                            # 两个厂商的 Agent 真合作写完一个模块（花 Agent 额度）
node tools/verify-public.mjs --provider cloudflared    # 公网 MCP 全链路：healthz/401/握手/工具表（需 cloudflared）
```

---

## 版本与路线

> 当前测试版：**1.11.19**。下面旧条目里的“本版”是当时发布原文，保留用于追溯。

- **1.11.19（本版）**：**「不分系统」从口头承诺变成会红的测试；顺手修掉了体检的假绿**。① **一个包的机器契约**：新增 `tests/one-package.test.mjs` 7 条 —— `package.json` 不许有 `os`/`cpu`/`dependencies`/`optionalDependencies`，包内不许有 `.node`/`.exe`/`.dmg`/`install.ps1`，**平台分支白名单**（9 个文件，每个写明理由，白名单外出现 `process.platform` 立刻红，白名单腐烂也红），三系统下 10 种配置形状的**结构逐字同构**（只有路径字符串不同）。注入 `os:["win32"]` 当场变红。② **体检不再说谎**：旧判据是 `/nexi/i.test(配置全文)`，脚本被删、node 路径失效、只在注释里提到 nexi、别家叫 `nexi-helper`，它全给绿勾。新增 `lib/connect/audit.js` 做**四层校验**（按形状解析出条目 → 脚本在磁盘上存在 → 解释器存在或 PATH 上找得到 → 路径一致性备注），状态分 `wired`/`unreachable`/`absent`/`broken`，`doctor --json` 的 `hosts` 检查不再写死 `ok:true`（`tests/host-audit.test.mjs` 16 条，每种假绿都有用例）。③ **并发不丢更新**：落盘段加 `openSync(...,'wx')` 文件锁，僵尸锁按 pid/TTL 抢占，超时把持锁 pid 告诉用户，目录不可写则降级；测试里开**两个真进程**同时往一个配置装不同条目（`lib/connect/lock.js`）。④ **备份能回滚、不堆积**：每个配置只留最近 5 份（撞名加序号，不再互相覆盖），新增 `nexi restore <host> [--last] [--to 文件]`，回滚前把"现在这份"再备份一次所以**回滚可撤销**，回滚后回读比对字节。⑤ **`nexi doctor --export`**：9 个纯文本文件（meta / doctor / hosts / 配置结构 / 备份 / 锁 / 状态 / 日志尾巴 / README），**不导密钥与配置原文**，家目录缩成 `~`；有一条测试拿本机真实配置跑一遍，全目录搜 `sk-*`/`ghp_*`/40 位十六进制/JWT 一个都搜不到。**顺带修了三个真缺陷**：`--name` 在写配置文件那条路上静默失效（同一个 Agent 装两份必然互相覆盖）；同一毫秒内的多次备份互相覆盖（等于把上一份备份吃掉）；`restoreHost` 不认 `--path`（`install custom` 写进去的自定义 Agent 无法回滚）。新增 4 个测试文件共 **41 条**，全量 **1297 条 / 1282 通过 / 0 失败 / 15 跳过**。三处突变验证（审计不查文件、备份不清理、锁不互斥）都当场变红。**边界不改口**：26 家里本机只真装过 6 家；没有第二台 Mac/Linux 真机；并发锁只保单机。\n- **1.11.18（历史）**：**把自检里剩下的四件补上了 —— YAML 宿主、把自己卸干净、运行日志、更新检查**。① **YAML 写入器**：Goose（`extensions.<id>`，字段是 `cmd`/`args`/`envs`/`timeout`）和 Continue 新版（`mcpServers:` **列表**，字段是 `command`/`args`/`env`）现在直接写进 `config.yaml`，内置从 25 家到 **26 家**、形状从 8 种到 **10 种**。没引 yaml 包：一是零依赖是硬要求，二是整份重新序列化会把用户的注释、空行、键顺序全冲掉 —— 所以改成**按行切片**，只在自己的哨兵注释之间动手，卸载按哨兵整块剪掉，卸完逐字节回到装之前。`kind: auto` 让 Continue 两代格式（`config.yaml` / `config.json`）按目标文件扩展名分流。② **`nexi uninstall --self`**：以前"卸载"只摘宿主条目，安装目录和状态目录得自己删。现在三段式 —— 活着的进程摘宿主条目、能当场删的当场删并**回读确认**、删不掉的（进程正踩在里面的安装目录）交给独立清理进程在父进程退出后删，结果写进 `%TEMP%\nexi-self-uninstall-*.log` 并把路径打印出来。安全边界写死：只吃绝对路径、只删名字带 `nexi` / `agentdeck-super` 的目录、拒绝家目录与盘根；从源码目录跑时不动源码。③ **结构化运行日志**：`logs/nexi-YYYYMMDD.log` 一行一个 JSON，按天分文件、5 MB 轮转、保留 7 天；`nexi logs [--tail N] [--json] [--dir] [--clear]`；`token`/`secret`/`sha256` 只记长度，写失败一律吞掉（只读盘上主流程照样跑）。④ **可选更新检查**：`nexi update --check` 或 `NEXI_UPDATE_CHECK=1`，**默认一次网络都不发**（第一条测试就是拿"被调用就炸"的 `fetch` 盯着），超时 1.5 s、缓存 24 h。**顺带修了三个真缺陷**：给 CLI 加日志后 `--help` 会在家目录里留下 `~/.dsh/agentdeck-super/`（`tests/cli-help.test.mjs` 当场变红 → `--help` 不记日志）；`nexi config` 对 YAML 宿主给的是 JSON 文本、`--out` 还按 `.json` 起名（现在按默认落点解析 kind，`.yaml` 宿主写 `.yaml`）；`nexi host list --md` 把家目录写进公开文档（现在缩成 `~` / `%APPDATA%`）。新增四个测试文件共 **32 条**（`yaml-hosts` 12 / `self-uninstall` 6 / `logs` 9 / `updatecheck` 5），全量 **1256 条 / 1241 通过 / 0 失败 / 15 跳过**。**边界不改口**：26 家里本机只真装过 6 家，Goose 与 Continue 的字段是官方文档逐字核对、没在真宿主点开。
- **1.11.17（历史）**：**不分 Agent —— 接入能力从"我们维护的名单"改成"用户手里的开关"**。名单式适配永远慢半拍：Agent 冒出来的速度比发版快，用户手上那个一旦不在名单里就只能等。这版做三层：① **内置从 13 家扩到 25 家**（新增 Roo Code、Kilo Code、Kilo CLI、Kiro、LM Studio、Factory Droid、JetBrains Junie、Qoder、Google Antigravity、Amazon Q、Amp、Crush），配置形状从 5 种扩到 8 种（新增 `mcp.local` / `mcp.stdio` / `amp.mcpServers`，都是按官方文档核的）；② **注册表**：`nexi host add <id> <配置文件> [--shape …]`，或直接把一份 JSON 丢进 `$DSH_HOME/agentdeck-super/hosts.d/`，从此 install/where/doctor 全认它，**不用发版**；③ **兜底**：`nexi snippet --shape …` 生成 JSON/TOML 片段，粘进只有 UI 的 Agent。还有 `nexi install custom <文件> --shape …` 这条临时通道。**顺带修了三个真缺陷**：`mcp.*` 形状卸载等于没卸（写入是合并，删除也走合并 → 报成功但文件里还在）；OpenCode 在 Windows 上被写进 `%APPDATA%`（它三系统都读 `~/.config`）；doctor 被 25 家宿主顶爆（一家一行"没装"把结论挤出屏幕，回归测试当场变红，改成装了的逐条列、没装的折一行）。新增 `tests/any-agent.test.mjs`（10 条）与 `tests/offline.test.mjs`（4 条，**拔网**后 MCP 仍能握手、`--portable` 配置换 HOME 照抄能起、状态换目录还在）。全量 **1225 条 / 1210 通过 / 0 失败 / 15 跳过**。**边界不改口**：25 家里本机只真装过 6 家，其余 19 家是文档级适配；没有第二台 Mac/Linux 真机。缺口清单见 `docs/成熟度自检.md`。

- **1.11.16（历史）**：**插件不分系统 —— 以前看起来分，是四个宿主的配置路径只写了 Windows 那一套**。在 macOS 上会算成 `~/AppData/Roaming/Claude/…`：路径不存在 → 探测报"宿主未安装" → 用户看到的结论就是"这插件不支持 Mac"。这版把 13 个宿主的落点按系统拆成三张表（`lib/connect/platform.js`，同一份代码查表，不是两套代码），路径拼接按目标系统选 `path.win32` / `path.posix`，所以能在 Windows 上把 darwin / linux 的路径逐字算出来核对；顺带补了 VS Code 家族的 `Code - Insiders` / `VSCodium`，以及 macOS 侧 CLI 的落点（`/opt/homebrew/bin`、`~/.npm-global/bin` 等 —— 从 Dock 启动的宿主拿不到 shell 的 PATH）。新增命令 **`nexi where`**：一屏打出 13 个宿主 × 三系统，当前系统那列标 `←`，`--json` 给脚本读。新增 `tests/platform-matrix.test.mjs` **12 条**，含"darwin/linux 任何候选路径不许出现 `AppData` 或反斜杠"这条全局禁令；做过突变验证（改回 Windows 写法红 3 条，还原全绿）。全量 **1197 条 / 1182 通过 / 0 失败 / 15 跳过**。**边界不改口**：没有第二台 Mac / Linux 真机，矩阵测试锁的是路径算得对，锁不住"真 Mac 上点开宿主看见 23 个工具"。

- **1.11.15（历史）**：**配对完成后直接告诉你「回 Agent 里问一句」，别停在命令行**。上一版把 Agent 侧接通了，但命令行的收尾提示还只说"两边跑 check"—— 用户很可能就此关窗，永远发现不了 Agent 已经能看见房间。这版两处改动：① `pair host` / `pair guest` 收尾多一行「回你常用的 Agent 里问『房间里有谁？』，它应该答出成员 2 人」；② `pair check` 多报一行 **Agent 那边：已进房 …（N 人）**，直接读机级房间记录，用户自查一步到位。测试：`tests/pair-agent-visible.test.mjs` 增加对这条自查输出的断言（只加断言不改行为，仍有突变验证守着）。

- **1.11.14（历史）**：**修掉"配对成功但 Agent 看不见房间"—— 上一版打通的是命令行，Agent 那边其实一直不知道自己在一个房间里**。真机表现：`pair guest` 打印「进房并同步成功，成员 2 人」，用户切回自己的项目问 Agent「房间里有谁」，Agent 答「还没有配置 relay 地址，跨机房间连不出去」。根因是两套状态：配对把房间会话写进 `.nexi-pair/`，而 Agent 的房间会话按**项目工作区**存，中间没有桥。这一版把**房间会话与小组板挪到机级目录**（一台设备一个席位，跟机器走不跟项目走，和授权/桌宠同一口径），配对直接写那里，所以换个目录也认。**这版怎么验的**：两台独立机级根 + 独立配对状态，A `pair host` → B `pair guest` → 换一个毫不相干的项目目录，用 Agent 路径（`nexi call`）问房间 → 看到「成员 2 人」和同一个 `team_…`；再把任务从 A 推到 B：A 加任务+sync → B sync 看到 → B 认领+完成+sync → A sync 看到 `✓ done`。新增 `tests/pair-agent-visible.test.mjs`，并做了两次**突变验证**（把机级根改回工作区 / 把小组板改回配对目录），两次都立刻变红 —— 这条链以后退回不去。**边界照写**：仍是同一台物理机的两个独立进程 + 真实网卡地址，**没有第二台物理电脑**。

- **1.11.13（历史）**：**修掉"第二台设备根本连不上"—— 真机配对第一次真的跨机跑通，也第一次发现它此前跑不通**。三个坑全在「房主打印给对面的那段文本」里，而房主自己那台机器一切正常，所以两边都会以为是对方网络的问题：① **邀请链接是 `127.0.0.1`** —— 中继用回环地址建房，relay 生成的网页邀请就带着回环，对面拿到它连的是**自己的**回环，永远连不上，报错却长得像"房间不存在"（局域网模式下现在换成 `192.168.x.x` 真地址）；② **命令写成 `node tools/nexi-pair.mjs guest …`** —— 对面没有本仓源码，照着敲 `Cannot find module`（统一改成 `npx -y agentdeck-super@latest pair guest --invite "…"`）；③ **推荐过 `set NEXI_INVITE=a&b`** —— cmd 会在 `&` 处截断，token 变空，所谓"次稳"其实不稳（现在主路径只给一条，退路只有"存 invite.txt"）。另修客人进房成功后不记 `relayUrl`，害它在自己机器上跑 `check` 说"本机没记过，先跑一次 host 或 guest"，用户以为没配对成功、白重跑一轮。**为什么以前没发现**：同机开两个窗口时 `127.0.0.1` 恰好是通的，第①条永不暴露 —— **拿同机双实例当"真机验证"是不算数的**。**这版怎么验的**：两台独立状态根 + 真实局域网地址，按用户看到的那两行命令原样跑 —— A `pair host` 打印 `http://192.168.1.10:8899/?room=…`（不再回环）→ B `npx … pair guest --invite "…"` 进房「成员 2 人」→ A `task add`+`sync` → B `sync`+`task list` 看到同一条任务 → B `claim`+`done`+`sync` → A `sync` 看到 `✓ done`。回归：全量 **1180 条 / 1165 通过 / 0 失败 / 15 跳过**；新增 `tests/pair-guide.test.mjs`（10 条）钉住"邀请不许是回环、命令必须是 npx 全命令、主路径只有一条、给用户看的输出不许写回源码路径"。多设备文档从 8 份互相矛盾收敛为 1 份入口 `docs/装机和多设备测试.md`，其余 6 份顶部标"已过期"并指过去。**边界照写**：仍是同一台物理机的两个独立进程 + 真实网卡地址，**没有第二台物理电脑**；离线签名码换机后无法远程吊销。

- **1.11.9（历史）**：**把"买皮肤"这一侧整体搬回开源**。1.11.5–1.11.8 发出去的包里，市场代码全在闭源层 `pro/` 里，等于**买家必须先付费才能付费** —— 逻辑死锁。这一版重划边界：货架 / 账本 / 下单 / 人工确认 / 退款 / 80-20 分账（约 2100 行）回到 `lib/market/`；闭源只留卖家侧与渠道细节（在线收款、对账、发票、主题包）。**是往回收，不是往前推**：公开部分比上一版更多，没有任何东西从开源变闭源。四个自检里挖出来的真缺陷一并修掉：① **两处读-改-写没有互斥** —— 两个宿主同时确认时后写的覆盖先写的，实测 3 进程 × 5 单只剩 5 单、销售流水 2 条（现在 `withFileLock` 用 O_EXCL 锁文件，陈旧锁按 mtime 抢，抢不到如实失败）；② **账本里认不出来的行被静默丢弃**，下次写入就把丢失落盘（现在原样进 `quarantined` 并给 warning）；③ **`nexi rollback --help` 真的会回滚**、`nexi pet --help` 真的弹窗（现在任何子命令带 `--help` 只解释不执行）；④ **`.gitignore` 里的 `market/` 连 `lib/market/` 一起吞了** —— 推上 GitHub 的开源版会缺整整一层，clone 下来起不来（改成 `/market/`，并给边界守门加了一条"核心源码不许被忽略"）。另修 `place` 缺参数时把"买"说成"卖"，以及开源版 `health` 教用户设 `AGENTDECK_PAY_*`（那层模块压根没装，设了不生效）。**买家那一侧再补三层**（同一版内继续修 —— “能买”和“买了算不算数”是两件事）：① **账本封印**：`orders.json` / `ledger.json` 落盘时带 `hmac-sha256` 封印（密钥 `market/.integrity.key`，0600），拿编辑器往账本里加一条购买**不再是“买过”**，货架会明说“封印对不上，本轮不采信本地购买凭据”；② **双源交叉核对**：每条已购记录必须有对应的 `delivered` 订单、皮肤 id 与金额都对得上 —— 全新设备上伪造一份账本会被这条拦住；③ **签名授权（ADSK1）真用起来**：卖家 `license-cli issue --skins` 签的码随订单存档，买家换电脑只带那串码就能用；实测**改一位签名 / 把 `skins` 改成 `["*"]` / 过期码 / 别人密钥签的码 —— 四种伪造全部被拒**；退款时签名凭据同步收回（原来退钱还留皮肤，是真漏洞）。付费 SKU 从 1 套补到 **4 套**（极光 ¥18 / 星云 ¥28 / 青玉 ¥38 / 余烬 ¥48，`tools/make-skins.mjs` 生成，所有 SVG id 带皮肤前缀，同页渲染不互相裁切）。**收款补上“钱往哪付”这一环**：`deck_market action="payinfo"` 配一次收款方式（支付宝/微信/银行/PayPal/Stripe，最多 5 条），之后每张订单自动带上；没配时直说“还没配”并给命令 —— 否则流程卡在第一步。换机三步写进 `docs/PAY.md`（旧机取码 → 新机 `deck_license activate` → 不用重买），并如实写明**离线码收不回来**这个边界。另修一个无障碍真 bug：未授权皮肤的占位图 `aria-label` 硬编码“桌宠素材缺失”，屏幕阅读器会把“此皮肤需授权 ¥38”读成“皮肤坏了”。新增 `tools/verify-twoinstances.mjs`：两个独立实例（各自一把封印密钥）跑完整现金流程 + 四种伪造 + 退款，**28/28**。回归：全量 **1153 条 / 1138 通过 / 0 失败 / 15 跳过**，边界守卫 5 条规矩全过，公开包 277 个文件 `pro/` 零命中。

- **1.11.8（历史）**：**发布链路真的转起来了——改完一条命令到上线，全程不碰浏览器、不要动态码**。npm 上已真实发布，用户侧一条命令：`npx -y agentdeck-super@latest --all`。新增两个工具：`tools/release.mjs`（脱敏 → 体检 → 全测 → 打包 → 临时目录装一遍真调工具 → 发布 → 回源确认 → 可选 `--publish`）与 `tools/dev.mjs`（打包 → 装本机全部宿主 → 宿主自报 → 配置真伪 → 工具冒烟），发布凭据用带 bypass 的 granular token（写进 `~/.npmrc`，90 天）。**修掉四个会把成功判成失败的坑**：① `npm view` 有约 5 分钟 CDN 缓存，发布后立刻查会读到旧文档（改成直连 registry 文档接口并带 cache-busting）；② npm 新版发布是**异步**的，PUT 之后先回 409「正在处理」，1–3 分钟才可查（改成等待而不是判失败）；③ `test-summary.mjs` 只认 `ℹ tests`、不认非 TTY 的 TAP `# tests`，会把全绿读成空；④ `release.mjs` 在 Windows 上 `spawnSync('npm') + shell:false` 直接 ENOENT（npm 是 `.cmd` 垫片）。另修两个真缺陷：`bin/nexi-pet.mjs` 缺 shebang（macOS/Linux 装完 `Exec format error`）、`@deepseek-ai/cordis` 写死成硬 peer（代码零处 import，改成可选）。回归：全量 **1109 条 / 1094 通过 / 0 失败 / 15 跳过**；从公网 `npx -y agentdeck-super` 真装回来 **6/6 宿主确认、配置 6/6 全部可移植、23 个工具真调通过**。**边界照写**：Zed / VS Code / OpenCode / Cursor / Windsurf / Cline / Continue 本机未安装，只核过官方文档形状，**不算已验证**；macOS / Linux 完全未测；`bypass 2FA` 直发通道 npm 已宣布 2027-01 取消，届时要走 `stage publish` + 网页批准。

- **1.11.5（历史）**：**一条命令装、改完一条命令切、装完直接 `nexi pair` 真机测**。安装器改成固定目录 + 稳定启动器：Windows 默认 `%LOCALAPPDATA%\Nexi`，宿主配置只写 `<安装目录>\bin\nexi.mjs`，升级只切 `current.json`；坏包不切版本，旧版保留，`nexi rollback` 可回退。新增 `nexi pair host|guest|check|sync` 稳定入口，配对状态放 `<安装目录>\pair`，升级不丢。真实回归：全量测试 **1075 条 / 1060 通过 / 0 失败 / 15 跳过 / 98 文件**，验收矩阵 **18/18**（双机模拟 28/28、真网卡 16/16、串门 39/39、会议 41/41、可移植性 4/4），安装器 7/7。**边界照写：** 发布当时 npm / MCP Registry / GitHub Release 都还没上（npm 已在 1.11.8 真实发布，MCP Registry 与 GitHub Release 仍未）；不存在所有 Agent 共用的插件搜索市场；没有第二台物理电脑，不能宣称物理双机已验收。
- **1.11.4（历史）**：**多设备入席有名字，项目管理员能核席位**。`nexi-pair guest` 新增 `--name "姓名-部门"`，默认回落到本机主机名；房主新增 `nexi-pair members` 查看完整席位名单；`deck_room join` 同步支持 `memberName`。定向回归：`pair-tooling` 4/4、`pair-seats` 3/3。**边界不变：** 一个房间最多 200 席，同一邀请每设备占 1 席，不是无限席位；本轮没有第二台物理电脑，不能把同机双进程当作物理机验收。

- **1.11.2**：**五轮自检、诚实边界、发布门禁不会藏红测**。修了 brain 配置路径：`llm` 配置现在以扁平字段传给 `createBrain()`，并补了回归测试；验收现在把完整测试明细保存到 `docs/evidence/tests-1.11.2.txt`；邀请恢复测试不再等 TEST-NET 超时。五轮均以显式 `NEXI_E2E_BASE` 连隔离的真 DSH 宿主复跑：**1064 条测试 / 1064 通过 / 0 失败 / 0 跳过（95 文件）**，发布门禁 **15/15**，验收矩阵 **18/18**，全功能副作用 **162/162**，MCP stdio **26/26**，Streamable HTTP **21/21**，本地 HTTP 支付/退款 **53/53**，Stripe 形状适配器 **26/26**，红队 **11/11**。证据：`round32-gate-console-1.11.2.txt`、`round32-acceptance-console-1.11.2.txt`、`round33-verify-all-console-1.11.2.txt`、`round34-gate-console-1.11.2.txt`、`round35-acceptance-console-1.11.2.txt`。不设宿主地址时，15 条外部宿主断言会洁净跳过，不再探测固定端口。**边界：** 本机真认证只有 **Codex 1/8**，其余 7 个宿主未安装；公网 MCP 只通过临时 Cloudflare 隧道验证，第二台物理机、Windows↔Linux/macOS、真实商户扣款、官方托管 relay、24 小时云端分身都没有冒充通过。

- **1.11.1（历史）**：**公网链路补上真实验收，修掉发布前最后一组环境坑**。`--tunnel cloudflared` 在 PATH 找不到时会回查 Program Files 与 WinGet Links，显式指定不可用 provider 时直接给人话错误，不再 spawn 空命令；新增 `node tools/verify-public.mjs --provider cloudflared`，从公网侧验 `/healthz` 200、无 token 401、Bearer 握手 200、`tools/list` 23 个工具；再用公网 relay 完成进房、2 人、任务 claim + done 回传。最终结果：`npm test` **1054 条 / 1039 通过 / 0 失败 / 15 跳过（93 文件）**，发布门禁 **15/15**，验收矩阵 **18/18**。**边界照写**：公网配对是同一台物理机的两个独立安装，真双物理机、Windows↔Linux/macOS、真实扣款、云上 24 小时托管仍未冒充通过。

- **1.7.0**：多 Agent 会议 + 本地自动化，两条都不依赖模型。`deck_meeting` 开场记录每个 Agent 的发言（原样保存，中间不经模型改写），结会出纪要、写决议、把活拆进**真任务板**；`deck_automation` 按 `every`/`at` 跑定时与一次性任务，带审批队列、每项次数上限、全局 `stop`/`resume`（状态落盘，所以终端里 `nexi stop` 能让正在跑的宿主下一拍就不动）和执行记录。两条都带 `output` 契约，宿主不兜底。当时是 16 个工具、351 条测试。
- **1.10.0（历史）**：**把「开会 / 串门 / 审计 / 网关 / 桌宠」从"能演示"推到"跨进程真跑通"，并补上治理层与端到端加密**。**（a）两个真人真串一次门，便签真加密**：`node tools/verify-visit.mjs` 起两个独立 node 进程、两个互不相干的 `DSH_HOME`、两份独立 Ed25519 身份，甲机发邀请 → 乙机验签收下并回自己的名片 → 乙机留一张求助便签 → 甲机收下并**真落进任务板**；令牌改一个字符就验不过、过期就验不过；两台机器各自记自己那一半流水。**39 项断言全过**（`docs/evidence/visit-2user-1.10.0.txt`）。**（b）私密串门端到端加密**（1.10.0 补的硬门槛）：每个工作区一把 X25519 身份密钥，邀请函里带上发起方的公钥，收下邀请那台机器**不联网、不共享密钥目录**就能协商出共享密钥；共享密钥走 HKDF-SHA256 派生，正文用 **AES-256-GCM** 加密，AAD 绑上便签 id/类型/双方公钥——换头换尾都解不开。**加密后便签里没有 payload 字段，明文一个字都不上线**；解不开时**明确拒收**（`no_box_key` / `cannot_decrypt`），绝不退化成"当明文处理"。老明文便签照收，不影响兼容。**14 条单测 + 跨进程实测**（`docs/evidence/e2ee-1.10.0.txt`）。**边界照写**：这是匿名密钥交换，**不防中间人**（没有 CA、没有带外指纹比对，和所有"扫码互联"产品同一水平）；签名和加密是两件事，分开做。**（c）三个 Agent 真开一场会**：`node tools/verify-meeting.mjs` 让 claude / codex / dsh 三个独立进程连同一个项目，各交意见 → 摆出分歧 → 投票（2:1）→ 逐项了结议程 → 结会 → **决议真的变成 2 条任务**；里面还专门验了反例：**议程没了结时结会被拦住，且一条任务都不落**（治理闸门真生效、没有半成品副作用）。**41 项断言全过**（`docs/evidence/meeting-3agent-1.10.0.txt`）。**（d）2D 悬浮桌宠，不装 Electron**：`nexi pet` 用本机自带 Edge 的 `--app` 拉起一个**无地址栏、无标签页的独立窗口**，尺寸/位置/朝向可调，页面自包含（内联 SVG，零外链、不联网、不写盘）。真机取证见 `docs/evidence/pet-client-1.10.0.txt`。**边界照写**：浏览器窗口做不到逐像素透明与鼠标穿透，这里是「无边框圆角小窗」；要真透明只能上 Electron/原生窗口，那与"轻量插件"的定位冲突，所以明说而不是假装。**（e）动作策略 + 审计流真的接线了**：`deck_policy` 写的规则会在**每个工具真正执行之前**过一遍——`deny` 的工具不会被执行（只回一句【策略拒绝】），要确认的动作必须带 `confirm:true`，每次调用都记一笔 `deck_audit` 能翻的审计。`tests/policy-wiring.test.mjs` 从宿主工具带里把 `execute` 拿出来真调，证明的是"接线"而不是"引擎算得对"。**（f）自动化补三件事**：到点 **webhook** 回调（真起 HTTP 服务器收回执，发不出去不算任务失败）、**失败重试**（指数退避、成功清零）、**每日上限**（超了当天跳过、记录写明原因）。**（g）分身记忆加两个维度**：**作用域**（personal/project/team/global，global 永远算数）和**有效期**（TTL 到点不再召回，下次写入时清掉；钉住的永不过期）。**（h）对外协议网关**：OpenAPI **3.1** 文档 + **A2A** agent card 挂在根路径下，`/v1/openapi.json` 的路径数、`/v1/a2a/agent-card.json` 的 skills 数都等于**真实工具数 23**；只认 HTTP 的平台和别的 Agent 都能直接接。**（i）宿主认证多一个真认证**：Gemini CLI 从「未安装」修正为**真认证**（装→宿主自报→卸→配置逐字节还原），本机 **1 认证 / 0 失败（Codex；其余 7 台未装且拒绝伪造配置）**；顺带修了两个真 bug：只按"配置文件在不在"判装没装（把已装好的宿主误报成未安装），以及装前没有配置文件时"还原"会留下一个空文件。**（j）额度口径归位**：群组房间 3/20/50/999，会议与自动化按档位，企业版是 `Infinity` 而不是 999；`/deck` 额度卡显示本机真实用量。**（m）对账（1.10.0 新增）**：真实收款的最后一块不是"能付"而是**账能对上**。`deck_market action=reconcile` 拿一份渠道对账单跟本机订单逐笔勾对，六类差异逐条报出来——漏单、我们有渠道没有（可能没真扣款）、金额不符、状态不符、流水号不符、渠道重复——**只报差异，绝不自动改账**。渠道字段名认 `out_trade_no`/`transaction_id`/`total_amount` 等常见写法，按"元"给金额也能对（`unit:"yuan"`）。**不需要商户号就能验**，15 条单测 + 真机四种场景全过（`docs/evidence/reconcile-1.10.0.txt`）。**（n）发票数据（1.10.0 新增）**：已付订单能开出编号稳定、字段齐全的发票记录（抬头/税号/金额拆分/税额/行项目/渠道流水号），可查可导出；同一张单重复开票返回原票不重复开；公司抬头缺税号直接拒。**明说不是税务合规的电子发票**，税率不配就写「未配置」，绝不编一个 6% 冒充已含税。13 条单测 + 真机三种场景全过（`docs/evidence/invoice-1.10.0.txt`）。**（k）怎么证明**：`node tools/verify-acceptance.mjs` 现在跑 **18 项验收，18/18 通过、0 失败、0 跳过**（含全量单测、真宿主、双机模拟、跨网卡、串门、会议、支付、恢复、打包和可移植性）；`npm test` 本轮真实结果 **1035 条 / 1020 通过 / 0 失败 / 15 跳过 / 88 文件**，23 个工具、只读模式 19 个。**（l）真机抓到并钉死的三个 bug**：网关问的是 `hub.list()`，而宿主门面当时只有 `names()`，于是 `paths` 是空的——假 hub 的单测全绿、真宿主却是坏的；「已安装·未接入」亮绿灯（看着像接好了）；桌宠窗口在小屏上算出负坐标。每个都补了**会真变红**的回归测试。
- **1.9.0**：**皮肤市场 + 收款 + 额度，三件事都做成能真跑的闭环，而不是画饼**。**（a）新增工具 `deck_market`**：`catalog` 看货架、`health` 看渠道配没配、`buy` 下单、`orders` 查本机订单、`refund` 退款。买 → 价格（分）→ 订单落 `orders.json` → 渠道回执 → 进货本 `ledger.json`（创作者 80 / 平台 20 分账）→ 发交付码 → 皮肤**真解锁渲染**；退款 → 账本冲正 → 皮肤重新需要授权。**（b）没有商户号也不撒谎**：`AGENTDECK_PAY_PROVIDER` + `AGENTDECK_PAY_URL`（可选 `AGENTDECK_PAY_TOKEN`）没配齐时，`buy` 一律返回 `{ok:false, code:'billing_unconfigured', reason:'环境未配'}`，订单停在 `created`，不写 `payment`、不编流水号；配齐之后走真 HTTP，**渠道返回 `paid === true` 才发放**，落盘 `payment.ref`，同一张单重复确认幂等（不会再扣一次）。你在 `/deck` 上点「买 ¥18」看到的就是这句实话。**（c）额度按档位真算**：`free / plus / studio / business` 的**云房间 / 席位**直接读 `lib/license.js` 的 `TIERS`（1.9.0 之前这里有两套表在打架，错的那套已删掉并加注释禁止回填），**会议 / 自动化 / 记忆**由 `lib/quota.js` 计量，`/deck` 的额度卡显示本机真实用量（例：会议 0/3、记忆 1/200、席位 1/3）；额度内部出错一律**放行**——宁可少管，不许拿计量故障拦人干活。**（d）怎么证明**：`node tools/verify-pay.mjs` 在 `127.0.0.1` 上起一个**真的 HTTP 支付网关**，真发 POST、真落盘、真解锁；网关拒绝时订单不许变已付；重复确认不重复扣款；退款后授权收回——**37 项断言全过**（`docs/evidence/pay-1.9.0.txt`）。**边界照写**：本机没有商户号，「真钱进账」这一条仍然开着，脚本不假装，配号之前只能到「链路通、只差一个号」。**（e）** `node tools/verify-all.mjs` 当时跑 7 组验收 **7/7 通过**，520 条单测全绿，18 个工具、只读广告 14 个。
- **1.8.0**：**Agent 通行证 + 四类故障真演练**。**（a）通行证**——工具 `agent_passport`，离线签发/校验一张 Ed25519 能力卡。`issue` 出 `NEXP1.<payload>.<sig>`，公钥**装在卡里**带过去，所以验卡那台机器不需要共享密钥目录、不需要服务器、不需要联网；`kid` 由公钥指纹算出，重复验证时把 `kid` 一起带上就等于在问「还是同一台机器签的吗」；`verify` 给出机器可读的码（`bad_signature` / `kid_mismatch` / `missing_capability` / `expired`），私钥从不离开签发方（验卡方 `show` 会老实说「本机还没有身份密钥」，不会偷偷生成一把）。只读模式下 `show`/`verify`/`list` 保留、`issue`/`revoke` 拒绝——借出去的 Hub 能验卡但造不出卡。**边界写清楚**：它证明「卡没被改过、签发方密钥没换过」，**不证明**「屏幕前是谁」——没有 CA、没有吊销中心，`revoke` 只标本地账本，卡在对面照样验得过（工具文案就是这么说的）。证据 `docs/evidence/passport-1.8.0.txt`（10 条跨进程实机断言）。**（b）四类故障真跑一遍**——`node tools/verify-recovery.mjs` 把断网 / 崩溃 / 升级 / 迁移各演一次：relay 连不上时 Hub 照常起，建组、加任务、写记忆全部成功且真落盘（房间操作优雅失败，说人话不挂死）；半截 JSON-RPC 请求被 `SIGKILL` 之后新进程不受污染，`state.json` 被撕成两半既不崩也不丢能读的内容，再猛写 8 轮、每轮杀一次，**撕裂 0 次**（原子写生效）；低 `version` + 老字段的状态读得回、写回不丢字段；整棵状态树搬到另一台「机器」后同一个 `teamId` 读得回同一块板，记忆和授权都跟着走，没搬授权的如实回落免费档。证据 `docs/evidence/recovery-1.8.0.txt`（27 项）。**（c）一条命令跑完所有验收**——`node tools/verify-all.mjs` 依次跑每个验收脚本、各自写证据，红一个或证据里出现 `❌` 就退出码 1、直接告诉你别发版。17 个工具 / 395 用例 / 只读广告 13 个（这些是 1.8.0 当时的数字，现状看本版条目）。
- **1.7.4**：两件事，都是为了「敢借给别人用、也不吹自己没做的」。**（a）宿主认证一条命令**：`nexi verify-host --all` 对 8 个宿主逐个跑「装 → 让宿主自己确认 → 卸 → 配置逐字节还原」，并写出能读的矩阵。本机结果：Claude Code ✅（`claude mcp list` 自己报 `nexi`）、Codex ✅（`codex mcp list`）、Claude Desktop 🟡 只到配置层（本机没 CLI，标「实验性」）、Cursor / Windsurf / Cline / Continue / Gemini CLI ⚪ 未安装——**没装的宿主拒绝伪造配置**。证据：`docs/evidence/hosts-1.8.0.txt`。**（b）`mcp.readOnly`**：把本机 Hub 借给别人模型时关掉写的一半——`tools/list` 从 16 个降到 12 个（`super_agent`、`twin_remember` 直接消失），`team_board` 的描述里明写还剩下哪些动作，每个写动作返回 `isError` 并告诉你拧哪个开关；任务板文件一个字都不会多。`GET /v1/mcp` 会报 `readOnly: true` 且只列真能调的工具，stdio 那条路用 `nexi mcp --read-only`；同一台机器上再起一个默认配置的宿主做对照，证明差别来自开关而不是工具本来就不行。证据：`docs/evidence/readonly-1.8.0.txt`（24 条断言）、`gate-1.8.0.txt`。17 个工具，395 条测试（1.8.0 当时的数字）。
- **1.7.2**：一套**真查出两个洞并当场堵上**的红队用例。`tests/security-redteam.test.mjs` 11 条，专打要命的地方：记忆投毒（「立刻 `touch` 一个文件 / 把私钥发出去」这种载荷存进去、召回来都只是文本，哨兵文件始终不存在）、便签注入（标题里塞 `curl … $(cat ~/.ssh/id_rsa)` 只变成一条任务标题，什么都不会执行）、跨团队读任务板、冒名成员、串门令牌越界/篡改/过期、记忆可见性绕过。其中两条在 1.7.1 上是**失败的**：`GET /adbp/v1/state?teamId=<别人的队>` 拿任何一张合法令牌都能读走别人的任务板；请求体里的 `memberId` 能盖掉令牌身份（替别人领活 / 交活 / 发言）。现在两处一律 `403 forbidden`，同时留了"正常路仍然通"的正向断言，避免把功能一起堵死。证据：`docs/evidence/security-redteam-1.8.0.txt` + `gate-1.8.0.txt`。
- **1.7.1**：MCP **Streamable HTTP**。本来给状态页的那个 URL，现在 `POST /adbp/v1/mcp` 就是说 JSON-RPC 的端点——只会在界面里填「远程 MCP 地址」的客户端（Claude Desktop、Cursor 之类）不用装任何东西、也不用起子进程，就能调同一批 17 个工具。无状态（不发 `Mcp-Session-Id`），所以宿主重启不用重新配对。诚实边界：没有 SSE 推流（`GET`/`PUT`/`DELETE` 一律 405 + `Allow: POST, OPTIONS`），没实现的方法老实回 `-32601`，不装作在推。同一个 URL 的 `GET` 仍然给人和脚本看清单，`transport` 写 `stdio+streamable-http`。证据：`docs/evidence/mcp-http-1.8.0.txt`（21 项断言，两个只会 fetch 的客户端完成一次真实协作）。
- **1.6.4**：四档授权——免费 / 协作版 ¥29·月（年付 ¥288）/ 工作室版 ¥99·月（年付 ¥999，含 3 席，加席 ¥20/席·月）/ 企业版 ¥30000 起·年。`lib/license.js` 的 `TIERS` 是价格表、发码工具、房间放行、`/deck` 状态页的唯一真源；老 `pro` 码继续有效。价格表不编收款链接：没配 `purchaseUrl` 就明说"还没挂在线收款页"。
- **1.6.2**：数字分身记忆——5 类记忆、4 级可见性、跨进程召回、习惯提议→确认→回滚（`twin_*` 工具）。
- **1.5.0**：桌宠串门、桌宠会议、付费皮肤。
- **1.4.1**：真机验收出来的修正——**授权码与桌宠档案都改成机级**（放 `$DSH_HOME`，跟着人走，换项目不用重新激活，老数据自动迁移）；tarball 装机改走宿主自己的 `dsh plugin add`；另外补了一场**两个厂商的 Agent（Claude Code + Codex）真合作干项目**的验收。
- **1.4.0**：超级 Agent + 多 Agent 入组 + 分工并行 + 任务板 + **跨机房间** + **授权体系** + **桌宠档案/皮肤**。
- **尚未实现（别当功能看，完整清单见 [`docs/功能现状核对表.md`](docs/功能现状核对表.md)）**：
  - 桌宠人格/技能的**图形化编辑器**（现在只能手写 JSON 或让 Agent 写）
  - **托管分身**（云上 24h 在线）—— 只有本地常驻进程 `nexi-daemon`
  - **真实支付**（缺商户号与支付账号；本地真 HTTP 网关 53/53、Stripe 形状 26/26，真钱扣款没验）
  - **官方托管 relay 实例** —— relay 代码在，要跨公网得自己部署
  - **自动多设备发现** —— 增量同步能算，但"怎么找到对面"仍靠人给地址
  - SSO / SCIM / 私有化部署（代码里标 `UNIMPLEMENTED`）
  - Windows ↔ Linux/macOS 互通**未测**；大规模并发**未测**

## License

核心代码 AGPL-3.0（见 [`LICENSE`](LICENSE)）、适配器与协议 Apache-2.0（见 [`LICENSING.md`](LICENSING.md)）：**随便用、随便改、随便自建；把 Nexi 当云服务卖就得开源你改的那部分**。
付费的是我们托管的服务（中继/云房间/额度）与美术素材包，两者边界在 `LICENSE` 末尾写清楚了。
安全问题看 [`SECURITY.md`](SECURITY.md)——邀请链接本身就是进房间的凭证，这是设计如此，不是漏洞。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)


