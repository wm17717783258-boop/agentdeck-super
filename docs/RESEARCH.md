# 同款调研：市面上已经有什么，还缺什么

> 数据来源（都是本机可核验的）：
> 1. 插件市场全量清单缓存 `~/.dsh/profiles/desktop/.dsh-market/discovery-compatibility-v1.json` —— **4,192 个插件**（按名字做了关键词扫描）
> 2. 6 个最接近的竞品，逐个拉 npm registry 元数据（版本、体积、描述、peer、exports）看它到底做了什么
> 3. DSH 自带的原生 Agent Teams 子系统源码 + README（`@deepseek-ai/dsh-experimental-agent-team*`、`dsh-subagent`、`dsh-subagent-codex`）
>
> 结论一句话：**三个层都有人做，但从没人把它们连成一张网。**

---

## 一、竞争者地图

| 层 | 有没有人做 | 谁 | 做到什么程度 | 缺口 |
| --- | --- | --- | --- | --- |
| **L1 单 Agent 能干活的工具带** | 大量 | `dsh-tool-orchestrate`、各类 MCP 桥、文件/搜索/终端插件（百级） | 成熟，官方自带（Read/Write/Bash/Glob/Grep/WebFetch） | 不缺，别重造 |
| **L2 Agent 之间的团队协同** | 有人做，且**官方已内置** | 官方 `dsh-experimental-agent-team-(profile/tool/client-ui)`；第三方 `@nanmicoder/dsh-agent-teams`（3.4 MB / 129 文件）、`@contexera/dsh-agent-team`（5.8 MB）、`dsh-swarm-orchestrator`、`dsh-expert-orchestrator`、`dsh-tool-orchestrate` | 官方：roster + 九个团队工具 + 共享任务板 + Web 团队 UI；`dsh-team-rooms` 已因它**主动退役**（作者原话："Harness now ships the native Agent Teams subsystem"） | **只能拉起 DSH 自己的子会话**（spawn/fork provider），一个团队里坐的全是"同一种 Agent"；共享同一个 cwd；**不能邀请外部的人** |
| **L3a 跨机器 Agent** | 极少 | `dsh-remote-agent`（0.9.12，MIT，零依赖，keywords 里写 `subagent-provider`）"把另一台电脑变成你 DSH 的远程 Agent 同事，副机本地持久跑任务，只回传 handoff 摘要" | 做得不错：relay + pairing + hub/worker profile | 是"我的另一台电脑"，不是"我朋友/我同事的 Agent"；没有多方、没有房间、没有身份 |
| **L3b 人与人协同（邀请）** | 极少 | `dsh-share-room`（0.3.3）"Invite others into your DSH conversation: they join from a link, discuss with you and ask the AI together. No account needed."；`dsh-meeting-room`、`dsh-social` | 邀请链接已有人做，但只做到"围观同一段对话" | 没有"分工干活"：别人进来只能聊天，不能领任务、不能派自己的 Agent 上手；`邀请`/`p2p` 关键词在 4,192 个插件里命中 **0 / 0** 次 |
| **L4 桌宠社交（串门）** | 宠物很多，社交为 0 | **39 个桌宠插件**（`dsh-pet-plugin` 官方 1.27.1、`kunpet-dsh`、`dsh-whale-pet` 系列…） | 全是"本地宠物 + 皮肤 + 互动动作" | 在 `dsh-pet` 全仓 grep `串门/visit/friend/邀请/邻居` → **一条都没有**。宠物不出门、不认识别的宠物、不替你带话 |

## 二、官方原生能力的确切边界（决定我们该站在谁的肩上）

从 `dsh-subagent` 的类型定义里挖到的关键事实：

- 团队成员的启动走 **provider 机制**：`tool-agent-team` 配置里 `freshProvider: spawn` / `forkProvider: fork`，即"谁来创建一个 teammate"是可替换的。
- `subagent/descriptor` 事件里记录 **`provider` 名字**（"The `ctx.subagents` provider name that established the child"）。
- 还有 `establishExternalCatalogChild(parent, childId, label)` —— **"Record an external execution without a local child Session"**：官方已经预留了"外部执行体"的位置。
- `@deepseek-ai/dsh-subagent-codex` 已经在 desktop profile 里 —— 说明"用别家的 Agent 当团队成员"官方是认的，只是目前只有 Codex 这一个。

**这意味着**：正确姿势不是再写一个团队系统（会像 `dsh-team-rooms` 一样被原生取代），而是：
1. 写一个 **provider 适配器**，把 claude / gemini / ACP / 自研 / 远程机器变成原生团队的合法成员（官方 UI、任务板、roster 全部免费复用）；
2. 在官方做不到的地方补网络层：**跨机器、跨人、邀请、房间、身份**；
3. 在上面加一层"零配置体验"：一句话就组队，不用手写 provider 配置。

## 三、我们的位置（空位在哪）

| 别人有的 | 我们要不要做 | 判断 |
| --- | --- | --- |
| 单 Agent 工具带 | 做，但**只作为骨架** | 它是超级 Agent 的底座，不靠它取胜 |
| 团队 roster / 任务板 / 角色 | 做，但**复用官方 + 补异构** | 直接竞争没意义；把"异构成员 + 外部执行体"接进去才有差别 |
| 跨机器执行 | 做，但升级成**多方网络** | 对手只有"我的第二台电脑"，我们做"任意人、任意台" |
| 邀请链接 | 做，但升级成**邀请=让位的席位** | 对手只做围观聊天，我们做"进来就能派 Agent 领任务" |
| 桌宠 | 做，做成**社交入口** | 39 个宠物都是本地皮肤；串门是唯一没人占的空位 |

**一句话定位**：
> 别人做「一个更聪明的 Agent」，我们做「**Agent 的共同体**」——我的 Agent 和你的 Agent 能互相认识、互相派活、互相串门。

## 四、必须先承认的风险

1. 官方 Agent Teams 还在 `experimental`，schema 会变 → 我们的适配器要**薄**，契约集中在 `lib/engine/bridge.js` 一处，官方变了只改一处。
2. `dsh-subagent-codex` 说明官方在逐步补齐异构成员 → 我们的护城河不是"能接 Codex"，而是**接入的广度 + 网络（邀请/跨机/身份）**，这两件官方短期不会做（涉及账号体系与服务器）。
3. 桌宠串门需要"对方的 DSH 在线"→ 必须要有中转（relay），这正好是收费点。

## 五、可验证的差异化清单（写进 README 首页的六条）

1. 一个团队里**同时**坐着 DSH、Claude、Codex、Gemini、你自研的 Agent —— 它们共用一个任务板。
2. **一条邀请链接**：对方点开就把自己的 Agent 派进你的房间，不用装别的东西。
3. 跨机器：任务可以派到别人电脑/服务器上跑，只回传产物。
4. 任务板是**多方共享的真相源**，人看板、Agent 领活。
5. 桌宠可以**串门**：带着你的 Agent 去朋友那儿做客，顺手把活干了。
6. 全程可审计：谁派的活、谁干的、花了多少、产出在哪。

> 1~4 是干活的价值，5 是传播的价值，6 是能卖给企业/团队的价值。
