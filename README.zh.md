# agentdeck-super · 超级 Agent + 任意 Agent 小组 + 跨机作战室

> 一个装在 DeepSeek Harness 里的插件：**给你一个什么活都能自己干的超级 Agent，再给你一间谁都能进来干活的作战室。**
>
> 一行装好：`dsh plugin add agentdeck-super`

`dsh plugin add agentdeck-super` 之后，你的 DSH 里会多出六样东西：

| 能力 | 说明 |
| --- | --- |
| 🦾 **超级 Agent** | 它自己会读文件、改代码、跑命令、搜代码库、抓网页、维护任务板——不是一个只会聊天的模型，而是一个能把活干完的执行体 |
| 👥 **任意 Agent 入组** | 本机 CLI（claude / codex / dsh / gemini …）、ACP over HTTP、OpenAI 兼容服务、桌面 App（CDP）、以及任何语言写的自研 Agent（ADBP 桥，20 行接入）都能进同一个小组 |
| 🧩 **分工并行交付** | 按 架构/开发/评审/测试/文档 角色拆任务，成 DAG、并行执行、过验收门，最后交一个真项目，而不是一堆聊天记录 |
| 📋 **任务板** | 谁在干什么、干到哪了、失败几次，全在板子上；跑完可复盘 |
| 🌐 **跨机房间** | 把邀请链接发给同事，**他不用装、不用买、不用配，点开就和你同一张任务板**；本地房间不用联网 |
| 🐾 **桌宠（数字分身）** | 越用越像你（习惯进化）；皮肤可换；能去朋友那儿串门、能替你和别的桌宠开会，结论直接落成任务 |

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
# 从 npm 装（推荐）
dsh plugin add agentdeck-super

# 本地开发（本仓库路径，Windows 上用 link: 或绝对路径）
dsh plugin --profile dev add link:D:/agentdeck-super
```

装完重启 DSH，工具会出现在 Agent 的工具列表里；输入 `/deck` 看状态。

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

### 2. 把任意 Agent 拉进同一个小组

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

第二条是**网页加入页**：对方没装 DSH 也能打开，页面上一行 `dsh plugin add agentdeck-super`、邀请码、以及一句"你是客人，不需要买授权"。

把链接扔给同事，他点开就进房间（**他不需要授权码**），然后：

- 你派的任务会同步到他那边，他可以认领、做掉、回报；
- 他那边做的活你这边实时可见，任务不会重复认领；
- 断网了？本地任务板照常记，恢复后自动补同步。

**自己搭中继**（不付费也能跨机，代码是 MIT 的）：

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
| `team_board` | 看板子：谁在干什么、进度、失败详情、导出运行记录 |
| `deck_room` | 建/进/退出跨机房间，发邀请，同步任务（协作版；本地房间免费） |
| `deck_license` | 查看/激活授权，看当前档位和权益 |
| `pet_visit` / `pet_meeting` / `pet_skin` | 串门、桌宠开会、换皮肤 |

`/deck` 命令是这些工具的快捷入口：`/deck` 看状态、`/deck room` 房间、`/deck license` 授权、`/deck pet` 桌宠。

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

---

## 免费版 vs 付费版

| | 免费 | 协作版 ¥29/月（年付 ¥299） | 工作室版 ¥199/月 |
| --- | --- | --- | --- |
| 超级 Agent + 工具带 | ✅ | ✅ | ✅ |
| 任意 Agent 入组 | ✅ | ✅ | ✅ |
| 本地团队 / 本地房间 | ✅（3 成员） | ✅（8 成员） | ✅（30 成员） |
| 并行车道 | 1 | 3 | 6 |
| **跨机云房间** | — | 1 | 5 |
| 付费皮肤 | — | ✅ | ✅ |
| 无人值守自动跑 / 审计导出 | — | ✅ / — | ✅ / ✅ |

- **客人免费**：别人建的房间，你凭邀请进去干活不需要授权。
- **可自建**：`tools/relay-server.mjs` 是完整中继，自己搭、自己发码，一分钱不花。
- 权益表在 [`lib/license.js`](lib/license.js) 里公开可查；收款与发码流程见 [`docs/COMMERCE.md`](docs/COMMERCE.md)。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | 九条核心能力各自落在哪段代码、哪条证据；留存设计；路线图 |
| [`docs/COMMERCE.md`](docs/COMMERCE.md) | 真实收款手册：签码、发码话术、售后、什么时候才需要后端 |
| [`docs/MARKET.md`](docs/MARKET.md) | 市场条目文案、PR 正文、截图清单 |
| [`docs/PUBLISH.md`](docs/PUBLISH.md) | 开源 + 上架手工单：建仓库、干跑体检五关、真发布、市场 PR、出问题怎么查 |
| [`docs/host-api.md`](docs/host-api.md) | 宿主 API 的形状与坑（写插件的人先看这个） |
| [`docs/transports.md`](docs/transports.md) | 五种传输方式与 ADBP 协议细节 |
| [`docs/PET.md`](docs/PET.md) | 桌宠：档案格式、习惯算法、皮肤规范、串门与会议协议 |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | 模块之间的接口契约（改代码前先看这个） |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) · [`docs/VISION.md`](docs/VISION.md) | 竞品调研与产品愿景 |
| [`docs/host-api.md`](docs/host-api.md) | DSH 宿主 API 实测笔记（宿主 0.2.1-rc.5）：证据 E1–E6、服务矩阵、四个注册面、降级矩阵、`ctx.llm.stream` 契约、三条最容易踩的坑、安装实录 |
| [`docs/evidence/`](docs/evidence/) | 验收证据：端到端自检、真机 Agent 实跑、两个厂商 Agent 真合作干项目、tarball 安装 + headless 执行 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南：怎么加一种新 Agent、测试要求、三条硬规则 |

**自己验一遍**（三条命令，不联网、不烧模型额度）：

```bash
node --test --test-concurrency=1 "tests/*.test.mjs"   # 281 用例
node tests/e2e-local.mjs                              # 5 步端到端，出一份证据文件
node tools/real-agents-check.mjs                      # 真机跑本机装着的 Agent
node tests/e2e-project.mjs                            # 两个厂商的 Agent 真合作写完一个模块（花 Agent 额度）
```

---

## 版本与路线

- **1.4.1（本版）**：真机验收出来的修正——**授权码与桌宠档案都改成机级**（放 `$DSH_HOME`，跟着人走，换项目不用重新激活，老数据自动迁移）；tarball 装机改走宿主自己的 `dsh plugin add`；另外补了一场**两个厂商的 Agent（Claude Code + Codex）真合作干项目**的验收。
- **1.4.0**：超级 Agent + 任意 Agent 入组 + 分工并行 + 任务板 + **跨机房间** + **授权体系** + **桌宠档案/皮肤**。
- **1.5.0**：桌宠串门、桌宠会议、每日站会、习惯→一键技能。
- **1.6.0**：在线激活（Worker：`/v1/activate` `/v1/usage`），按量额度、远程吊销。
- **2.0.0**：团队空间——多人共享的长期项目记忆、跨设备接力、组织权限。

## License

代码 MIT（见 [`LICENSE`](LICENSE)）：**随便用、随便改、随便自建**。
付费的是我们托管的服务（中继/云房间/额度）与美术素材包，两者边界在 `LICENSE` 末尾写清楚了。
安全问题看 [`SECURITY.md`](SECURITY.md)——邀请链接本身就是进房间的凭证，这是设计如此，不是漏洞。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
