# agentdeck-super · 超级 Agent + 任意 Agent 小组 + 跨机作战室

[![npm](https://img.shields.io/npm/v/agentdeck-super.svg)](https://www.npmjs.com/package/agentdeck-super)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![repo](https://img.shields.io/badge/source-GitHub-181717.svg)](https://github.com/wm17717783258-boop/agentdeck-super)

> 一个装在 DeepSeek Harness 里的插件：**给你一个什么活都能自己干的超级 Agent，再给你一间谁都能进来干活的作战室。**
>
> 一行装好：`dsh plugin add agentdeck-super`
>
> 开源仓库（核心 AGPL-3.0 / 适配器 Apache-2.0，见 [`LICENSING.md`](LICENSING.md)）：https://github.com/wm17717783258-boop/agentdeck-super

`dsh plugin add agentdeck-super` 之后，你的 DSH 里会多出七样东西：

| 能力 | 说明 |
| --- | --- |
| 🦾 **超级 Agent** | 它自己会读文件、改代码、跑命令、搜代码库、抓网页、维护任务板——不是一个只会聊天的模型，而是一个能把活干完的执行体 |
| 👥 **任意 Agent 入组** | 本机 CLI（claude / codex / dsh / gemini …）、ACP over HTTP、OpenAI 兼容服务、桌面 App（CDP）、以及任何语言写的自研 Agent（ADBP 桥，20 行接入）都能进同一个小组 |
| 🧩 **分工并行交付** | 按 架构/开发/评审/测试/文档 角色拆任务，成 DAG、并行执行、过验收门，最后交一个真项目，而不是一堆聊天记录 |
| 📋 **任务板** | 谁在干什么、干到哪了、失败几次，全在板子上；跑完可复盘 |
| 🌐 **跨机房间** | 把邀请链接发给同事，**他不用装、不用买、不用配，点开就和你同一张任务板**；本地房间不用联网 |
| 🐾 **桌宠（数字分身）** | 越用越像你（习惯进化）；皮肤可换；能去朋友那儿串门、能替你和别的桌宠开会，结论直接落成任务 |
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

开了之后：`tools/list` 从 21 个降到 17 个（`super_agent`、`team_orchestrate`、`pet_meeting`、`twin_remember` 直接不出现，`agent_passport` 只留 show/verify/list），`team_board` 的描述里写着还剩下哪些动作，任何写动作返回 `isError` 并告诉你拧哪个开关——**任务板文件不会多一个字**。`GET /v1/mcp` 会报 `readOnly: true` 且只列真能调的；stdio 那条路用 `nexi mcp --read-only`，或者环境变量 `NEXI_MCP_READONLY=1`。

**宿主认证（`nexi verify-host`）**：不靠自己说"支持"，让宿主自己报。

```bash
nexi verify-host claude-code      # 单个：装 → 让宿主自己确认 → 卸 → 配置逐字节还原
nexi verify-host --all --record   # 8 个全跑，矩阵写进 docs/evidence/hosts-<版本>.txt
```

本机实测（`docs/evidence/hosts-1.8.0.txt`）：

| 宿主 | 结论 |
| --- | --- |
| Claude Code | ✅ 已认证（`claude mcp list` 自己报出 `nexi`） |
| Codex | ✅ 已认证（`codex mcp list`） |
| Claude Desktop | 🟡 只到配置层（本机没 CLI，标「实验性」） |
| Cursor / Windsurf / Cline / Continue / Gemini CLI | ⚪ 未安装——**拒绝伪造配置** |

---

## 免费版 vs 付费版

| | 免费 | 协作版 ¥29/月（年付 ¥288） | 工作室版 ¥99/月（年付 ¥999，含 3 席，加席 ¥20/席·月） |
| --- | --- | --- | --- |
| 超级 Agent + 工具带 | ✅ | ✅ | ✅ |
| 任意 Agent 入组 | ✅ | ✅ | ✅ |
| 本地团队 / 本地房间 | ✅（3 成员） | ✅（8 成员） | ✅（30 成员） |
| 并行车道 | 1 | 3 | 6 |
| **跨机云房间** | — | 1 | 5 |
| 付费皮肤 | — | ✅ | ✅ |
| 无人值守自动跑 / 审计导出 | — | ✅ / — | ✅ / ✅ |

- **客人免费**：别人建的房间，你凭邀请进去干活不需要授权。
- **企业版 ¥30000 起/年**：私有化部署、200 席位、50 个云房间、10 路并行、专属支持——同一张 `TIERS` 表再往下一行。
- **可自建**：`tools/relay-server.mjs` 是完整中继，自己搭、自己发码，一分钱不花。
- 权益表在 [`lib/license.js`](lib/license.js) 里公开可查；收款与发码流程见 [`docs/COMMERCE.md`](docs/COMMERCE.md)。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | 九条核心能力各自落在哪段代码、哪条证据；留存设计；路线图 |
| [`docs/PASSPORT.md`](docs/PASSPORT.md) | Agent 通行证：签发/验卡/K 钉签发方/只读边界，以及「证明什么、不证明什么」 |
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
node --test --test-concurrency=1 "tests/*.test.mjs"   # 709 用例
node tests/e2e-local.mjs                              # 5 步端到端，出一份证据文件
node tools/real-agents-check.mjs                      # 真机跑本机装着的 Agent
node tests/e2e-project.mjs                            # 两个厂商的 Agent 真合作写完一个模块（花 Agent 额度）
```

---

## 版本与路线

- **1.7.0**：多 Agent 会议 + 本地自动化，两条都不依赖模型。`deck_meeting` 开场记录每个 Agent 的发言（原样保存，中间不经模型改写），结会出纪要、写决议、把活拆进**真任务板**；`deck_automation` 按 `every`/`at` 跑定时与一次性任务，带审批队列、每项次数上限、全局 `stop`/`resume`（状态落盘，所以终端里 `nexi stop` 能让正在跑的宿主下一拍就不动）和执行记录。两条都带 `output` 契约，宿主不兜底。当时是 16 个工具、351 条测试。
- **1.10.0（本版）**：**把「开会 / 串门 / 审计 / 网关 / 桌宠」从"能演示"推到"跨进程真跑通"，并补上治理层与端到端加密**。**（a）两个真人真串一次门，便签真加密**：`node tools/verify-visit.mjs` 起两个独立 node 进程、两个互不相干的 `DSH_HOME`、两份独立 Ed25519 身份，甲机发邀请 → 乙机验签收下并回自己的名片 → 乙机留一张求助便签 → 甲机收下并**真落进任务板**；令牌改一个字符就验不过、过期就验不过；两台机器各自记自己那一半流水。**39 项断言全过**（`docs/evidence/visit-2user-1.10.0.txt`）。**（b）私密串门端到端加密**（1.10.0 补的硬门槛）：每个工作区一把 X25519 身份密钥，邀请函里带上发起方的公钥，收下邀请那台机器**不联网、不共享密钥目录**就能协商出共享密钥；共享密钥走 HKDF-SHA256 派生，正文用 **AES-256-GCM** 加密，AAD 绑上便签 id/类型/双方公钥——换头换尾都解不开。**加密后便签里没有 payload 字段，明文一个字都不上线**；解不开时**明确拒收**（`no_box_key` / `cannot_decrypt`），绝不退化成"当明文处理"。老明文便签照收，不影响兼容。**14 条单测 + 跨进程实测**（`docs/evidence/e2ee-1.10.0.txt`）。**边界照写**：这是匿名密钥交换，**不防中间人**（没有 CA、没有带外指纹比对，和所有"扫码互联"产品同一水平）；签名和加密是两件事，分开做。**（c）三个 Agent 真开一场会**：`node tools/verify-meeting.mjs` 让 claude / codex / dsh 三个独立进程连同一个项目，各交意见 → 摆出分歧 → 投票（2:1）→ 逐项了结议程 → 结会 → **决议真的变成 2 条任务**；里面还专门验了反例：**议程没了结时结会被拦住，且一条任务都不落**（治理闸门真生效、没有半成品副作用）。**41 项断言全过**（`docs/evidence/meeting-3agent-1.10.0.txt`）。**（d）2D 悬浮桌宠，不装 Electron**：`nexi pet` 用本机自带 Edge 的 `--app` 拉起一个**无地址栏、无标签页的独立窗口**，尺寸/位置/朝向可调，页面自包含（内联 SVG，零外链、不联网、不写盘）。真机取证见 `docs/evidence/pet-client-1.10.0.txt`。**边界照写**：浏览器窗口做不到逐像素透明与鼠标穿透，这里是「无边框圆角小窗」；要真透明只能上 Electron/原生窗口，那与"轻量插件"的定位冲突，所以明说而不是假装。**（e）动作策略 + 审计流真的接线了**：`deck_policy` 写的规则会在**每个工具真正执行之前**过一遍——`deny` 的工具不会被执行（只回一句【策略拒绝】），要确认的动作必须带 `confirm:true`，每次调用都记一笔 `deck_audit` 能翻的审计。`tests/policy-wiring.test.mjs` 从宿主工具带里把 `execute` 拿出来真调，证明的是"接线"而不是"引擎算得对"。**（f）自动化补三件事**：到点 **webhook** 回调（真起 HTTP 服务器收回执，发不出去不算任务失败）、**失败重试**（指数退避、成功清零）、**每日上限**（超了当天跳过、记录写明原因）。**（g）分身记忆加两个维度**：**作用域**（personal/project/team/global，global 永远算数）和**有效期**（TTL 到点不再召回，下次写入时清掉；钉住的永不过期）。**（h）对外协议网关**：OpenAPI **3.1** 文档 + **A2A** agent card 挂在根路径下，`/v1/openapi.json` 的路径数、`/v1/a2a/agent-card.json` 的 skills 数都等于**真实工具数 21**；只认 HTTP 的平台和别的 Agent 都能直接接。**（i）宿主认证多一个真认证**：Gemini CLI 从「未安装」修正为**真认证**（装→宿主自报→卸→配置逐字节还原），本机 **3 认证 / 0 失败**；顺带修了两个真 bug：只按"配置文件在不在"判装没装（把已装好的宿主误报成未安装），以及装前没有配置文件时"还原"会留下一个空文件。**（j）额度口径归位**：群组房间 3/20/50/999，会议与自动化按档位，企业版是 `Infinity` 而不是 999；`/deck` 额度卡显示本机真实用量。**（m）对账（1.10.0 新增）**：真实收款的最后一块不是"能付"而是**账能对上**。`deck_market action=reconcile` 拿一份渠道对账单跟本机订单逐笔勾对，六类差异逐条报出来——漏单、我们有渠道没有（可能没真扣款）、金额不符、状态不符、流水号不符、渠道重复——**只报差异，绝不自动改账**。渠道字段名认 `out_trade_no`/`transaction_id`/`total_amount` 等常见写法，按"元"给金额也能对（`unit:"yuan"`）。**不需要商户号就能验**，15 条单测 + 真机四种场景全过（`docs/evidence/reconcile-1.10.0.txt`）。**（n）发票数据（1.10.0 新增）**：已付订单能开出编号稳定、字段齐全的发票记录（抬头/税号/金额拆分/税额/行项目/渠道流水号），可查可导出；同一张单重复开票返回原票不重复开；公司抬头缺税号直接拒。**明说不是税务合规的电子发票**，税率不配就写「未配置」，绝不编一个 6% 冒充已含税。13 条单测 + 真机三种场景全过（`docs/evidence/invoice-1.10.0.txt`）。**（k）怎么证明**：`node tools/verify-all.mjs` 现在跑 **9 组验收**（gate / readonly / passport / mcp-http / recovery / console / pay / visit / meeting）**9/9 通过**，**709 条单测全绿**，21 个工具、只读广告 17 个。**（l）真机抓到并钉死的三个 bug**：网关问的是 `hub.list()`，而宿主门面当时只有 `names()`，于是 `paths` 是空的——假 hub 的单测全绿、真宿主却是坏的；「已安装·未接入」亮绿灯（看着像接好了）；桌宠窗口在小屏上算出负坐标。每个都补了**会真变红**的回归测试。
- **1.9.0**：**皮肤市场 + 收款 + 额度，三件事都做成能真跑的闭环，而不是画饼**。**（a）新增工具 `deck_market`**：`catalog` 看货架、`health` 看渠道配没配、`buy` 下单、`orders` 查本机订单、`refund` 退款。买 → 价格（分）→ 订单落 `orders.json` → 渠道回执 → 进货本 `ledger.json`（创作者 80 / 平台 20 分账）→ 发交付码 → 皮肤**真解锁渲染**；退款 → 账本冲正 → 皮肤重新需要授权。**（b）没有商户号也不撒谎**：`AGENTDECK_PAY_PROVIDER` + `AGENTDECK_PAY_URL`（可选 `AGENTDECK_PAY_TOKEN`）没配齐时，`buy` 一律返回 `{ok:false, code:'billing_unconfigured', reason:'环境未配'}`，订单停在 `created`，不写 `payment`、不编流水号；配齐之后走真 HTTP，**渠道返回 `paid === true` 才发放**，落盘 `payment.ref`，同一张单重复确认幂等（不会再扣一次）。你在 `/deck` 上点「买 ¥18」看到的就是这句实话。**（c）额度按档位真算**：`free / plus / studio / business` 的**云房间 / 席位**直接读 `lib/license.js` 的 `TIERS`（1.9.0 之前这里有两套表在打架，错的那套已删掉并加注释禁止回填），**会议 / 自动化 / 记忆**由 `lib/quota.js` 计量，`/deck` 的额度卡显示本机真实用量（例：会议 0/3、记忆 1/200、席位 1/3）；额度内部出错一律**放行**——宁可少管，不许拿计量故障拦人干活。**（d）怎么证明**：`node tools/verify-pay.mjs` 在 `127.0.0.1` 上起一个**真的 HTTP 支付网关**，真发 POST、真落盘、真解锁；网关拒绝时订单不许变已付；重复确认不重复扣款；退款后授权收回——**37 项断言全过**（`docs/evidence/pay-1.9.0.txt`）。**边界照写**：本机没有商户号，「真钱进账」这一条仍然开着，脚本不假装，配号之前只能到「链路通、只差一个号」。**（e）** `node tools/verify-all.mjs` 当时跑 7 组验收 **7/7 通过**，520 条单测全绿，18 个工具、只读广告 14 个。
- **1.8.0**：**Agent 通行证 + 四类故障真演练**。**（a）通行证**——工具 `agent_passport`，离线签发/校验一张 Ed25519 能力卡。`issue` 出 `NEXP1.<payload>.<sig>`，公钥**装在卡里**带过去，所以验卡那台机器不需要共享密钥目录、不需要服务器、不需要联网；`kid` 由公钥指纹算出，重复验证时把 `kid` 一起带上就等于在问「还是同一台机器签的吗」；`verify` 给出机器可读的码（`bad_signature` / `kid_mismatch` / `missing_capability` / `expired`），私钥从不离开签发方（验卡方 `show` 会老实说「本机还没有身份密钥」，不会偷偷生成一把）。只读模式下 `show`/`verify`/`list` 保留、`issue`/`revoke` 拒绝——借出去的 Hub 能验卡但造不出卡。**边界写清楚**：它证明「卡没被改过、签发方密钥没换过」，**不证明**「屏幕前是谁」——没有 CA、没有吊销中心，`revoke` 只标本地账本，卡在对面照样验得过（工具文案就是这么说的）。证据 `docs/evidence/passport-1.8.0.txt`（10 条跨进程实机断言）。**（b）四类故障真跑一遍**——`node tools/verify-recovery.mjs` 把断网 / 崩溃 / 升级 / 迁移各演一次：relay 连不上时 Hub 照常起，建组、加任务、写记忆全部成功且真落盘（房间操作优雅失败，说人话不挂死）；半截 JSON-RPC 请求被 `SIGKILL` 之后新进程不受污染，`state.json` 被撕成两半既不崩也不丢能读的内容，再猛写 8 轮、每轮杀一次，**撕裂 0 次**（原子写生效）；低 `version` + 老字段的状态读得回、写回不丢字段；整棵状态树搬到另一台「机器」后同一个 `teamId` 读得回同一块板，记忆和授权都跟着走，没搬授权的如实回落免费档。证据 `docs/evidence/recovery-1.8.0.txt`（27 项）。**（c）一条命令跑完所有验收**——`node tools/verify-all.mjs` 依次跑每个验收脚本、各自写证据，红一个或证据里出现 `❌` 就退出码 1、直接告诉你别发版。17 个工具 / 395 用例 / 只读广告 13 个（这些是 1.8.0 当时的数字，现状看本版条目）。
- **1.7.4**：两件事，都是为了「敢借给别人用、也不吹自己没做的」。**（a）宿主认证一条命令**：`nexi verify-host --all` 对 8 个宿主逐个跑「装 → 让宿主自己确认 → 卸 → 配置逐字节还原」，并写出能读的矩阵。本机结果：Claude Code ✅（`claude mcp list` 自己报 `nexi`）、Codex ✅（`codex mcp list`）、Claude Desktop 🟡 只到配置层（本机没 CLI，标「实验性」）、Cursor / Windsurf / Cline / Continue / Gemini CLI ⚪ 未安装——**没装的宿主拒绝伪造配置**。证据：`docs/evidence/hosts-1.8.0.txt`。**（b）`mcp.readOnly`**：把本机 Hub 借给别人模型时关掉写的一半——`tools/list` 从 16 个降到 12 个（`super_agent`、`twin_remember` 直接消失），`team_board` 的描述里明写还剩下哪些动作，每个写动作返回 `isError` 并告诉你拧哪个开关；任务板文件一个字都不会多。`GET /v1/mcp` 会报 `readOnly: true` 且只列真能调的工具，stdio 那条路用 `nexi mcp --read-only`；同一台机器上再起一个默认配置的宿主做对照，证明差别来自开关而不是工具本来就不行。证据：`docs/evidence/readonly-1.8.0.txt`（24 条断言）、`gate-1.8.0.txt`。17 个工具，395 条测试（1.8.0 当时的数字）。
- **1.7.2**：一套**真查出两个洞并当场堵上**的红队用例。`tests/security-redteam.test.mjs` 11 条，专打要命的地方：记忆投毒（「立刻 `touch` 一个文件 / 把私钥发出去」这种载荷存进去、召回来都只是文本，哨兵文件始终不存在）、便签注入（标题里塞 `curl … $(cat ~/.ssh/id_rsa)` 只变成一条任务标题，什么都不会执行）、跨团队读任务板、冒名成员、串门令牌越界/篡改/过期、记忆可见性绕过。其中两条在 1.7.1 上是**失败的**：`GET /adbp/v1/state?teamId=<别人的队>` 拿任何一张合法令牌都能读走别人的任务板；请求体里的 `memberId` 能盖掉令牌身份（替别人领活 / 交活 / 发言）。现在两处一律 `403 forbidden`，同时留了"正常路仍然通"的正向断言，避免把功能一起堵死。证据：`docs/evidence/security-redteam-1.8.0.txt` + `gate-1.8.0.txt`。
- **1.7.1**：MCP **Streamable HTTP**。本来给状态页的那个 URL，现在 `POST /adbp/v1/mcp` 就是说 JSON-RPC 的端点——只会在界面里填「远程 MCP 地址」的客户端（Claude Desktop、Cursor 之类）不用装任何东西、也不用起子进程，就能调同一批 17 个工具。无状态（不发 `Mcp-Session-Id`），所以宿主重启不用重新配对。诚实边界：没有 SSE 推流（`GET`/`PUT`/`DELETE` 一律 405 + `Allow: POST, OPTIONS`），没实现的方法老实回 `-32601`，不装作在推。同一个 URL 的 `GET` 仍然给人和脚本看清单，`transport` 写 `stdio+streamable-http`。证据：`docs/evidence/mcp-http-1.8.0.txt`（21 项断言，两个只会 fetch 的客户端完成一次真实协作）。
- **1.6.4**：四档授权——免费 / 协作版 ¥29·月（年付 ¥288）/ 工作室版 ¥99·月（年付 ¥999，含 3 席，加席 ¥20/席·月）/ 企业版 ¥30000 起·年。`lib/license.js` 的 `TIERS` 是价格表、发码工具、房间放行、`/deck` 状态页的唯一真源；老 `pro` 码继续有效。价格表不编收款链接：没配 `purchaseUrl` 就明说"还没挂在线收款页"。
- **1.6.2**：数字分身记忆——5 类记忆、4 级可见性、跨进程召回、习惯提议→确认→回滚（`twin_*` 工具）。
- **1.5.0**：桌宠串门、桌宠会议、付费皮肤。
- **1.4.1**：真机验收出来的修正——**授权码与桌宠档案都改成机级**（放 `$DSH_HOME`，跟着人走，换项目不用重新激活，老数据自动迁移）；tarball 装机改走宿主自己的 `dsh plugin add`；另外补了一场**两个厂商的 Agent（Claude Code + Codex）真合作干项目**的验收。
- **1.4.0**：超级 Agent + 任意 Agent 入组 + 分工并行 + 任务板 + **跨机房间** + **授权体系** + **桌宠档案/皮肤**。
- **计划中，尚未实现（别当功能看）**：在线激活 Worker（`/v1/activate` `/v1/usage`）、按量额度、远程吊销、市场收款（webhook/退款）、2.0 团队空间（共享长期记忆、组织权限）。

## License

核心代码 AGPL-3.0（见 [`LICENSE`](LICENSE)）、适配器与协议 Apache-2.0（见 [`LICENSING.md`](LICENSING.md)）：**随便用、随便改、随便自建；把 Nexi 当云服务卖就得开源你改的那部分**。
付费的是我们托管的服务（中继/云房间/额度）与美术素材包，两者边界在 `LICENSE` 末尾写清楚了。
安全问题看 [`SECURITY.md`](SECURITY.md)——邀请链接本身就是进房间的凭证，这是设计如此，不是漏洞。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

