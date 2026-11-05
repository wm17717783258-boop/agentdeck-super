# 上架文案包（市场条目 + PR 正文 + 截图清单）

> 用途：`npm publish` 之后，把这份文档里的内容**原样**贴到 `awesome-dsh-plugin` 的 PR 里，以及任何要投放的地方（即刻/V2EX/Twitter/小红书）。
> 原则：不吹"首创"，只讲"你能拿它干什么"，每条都能被实测验证。

---

## 1. 市场条目（填表用）

| 字段 | 中文 | English |
| --- | --- | --- |
| 名称 | agentdeck-super | agentdeck-super |
| 一句话 | 给 DSH 一个能干活的超级 Agent，再给你一间谁都能进来干活的作战室 | A super-agent with a toolbelt, plus a war room any agent or teammate can join |
| 分类 | 多 Agent / 编排（Multi-Agent & Orchestration） | Multi-Agent & Orchestration |
| npm 包名 | `agentdeck-super` | `agentdeck-super` |
| 仓库 | `github.com/<你的账号>/agentdeck-super` | 同左 |
| `dsh.bundle` | `./cordis.patch.yml`（已声明） | declared |
| 兼容版本 | `>=0.2.1-rc.2 <0.3.0-0`（已实测 0.2.1-rc.2 / 0.2.1-rc.5） | 同左 |
| 许可证 | MIT（代码）/ 商业授权（托管服务与素材包） | MIT (code) + commercial (hosted service & asset packs) |
| 关键词 | agent team, multi-agent, orchestration, collaboration, pet, 串门, 邀请 | agent-team, multi-agent, orchestration, collaboration |

### 长描述（中文，≤ 500 字）

> **一句话**：`dsh plugin add agentdeck-super`，你的 DSH 里就多了一支能自己干活的队伍。
>
> **它会做什么**
> - 🦾 超级 Agent：读文件、改代码、跑命令、搜代码库、抓网页、维护任务板——不是只会聊天，而是把活干完。
> - 👥 任何 agent 都能进组：本机 claude / codex / gemini / dsh 等 CLI、OpenAI 兼容服务、桌面 App、以及你自己写的 agent（ADBP 协议，20 行接入）。
> - 🧩 分工并行：按架构/开发/评审/测试/文档拆任务、成 DAG、过验收门，交一个真项目而不是一堆聊天记录。
> - 📋 任务板：谁在干什么、干到哪、失败几次，全在板上，可复盘可导出。
> - 🌐 跨机房间（协作版）：建一间云房间，把邀请链接甩给同事——**对方不用买、不用配、点开就能一起干**。
> - 🐾 桌宠：你的数字分身，越用越像你（习惯进化）；皮肤可换；能去朋友那儿串门、能开会。
>
> **免费版就能把活干完**：本地团队、任务板、任意 agent 接入、桌宠基础能力全部免费。付费只买"和同事一起干"和"规模"。

---

## 2. 给 `awesome-dsh-plugin` 的 PR

**标题**
```
Add agentdeck-super — super-agent toolbelt + multi-agent team + cross-machine rooms
```

**正文（英文，仓库通用语言）**
```markdown
## What it is

`agentdeck-super` gives DSH two things:

1. **A super-agent** — a toolbelt (files, shell, search, web, task board) plus an autonomous loop, so it finishes work instead of describing it.
2. **A war room** — heterogeneous agents (local CLIs like claude/codex/gemini/dsh, OpenAI-compatible endpoints, desktop apps over CDP, or any custom agent via the ADBP protocol) and *people* can work on one task board together.

## Why it’s different from the other orchestrators

- **Heterogeneous members.** Most team plugins only orchestrate DSH sub-sessions. Here a member can be an external CLI process, an HTTP endpoint, or another machine's agent.
- **Invite = seat.** A room owner creates a cloud room; guests join from an invite link and **need no license**. That is the collaboration model people actually use.
- **Zero-config detection.** `dsh plugin add` is enough: it detects the CLIs already on the machine and uses them.
- **Works offline.** No relay? Local rooms and the full toolbelt keep working.

## Checks for the reviewer

```bash
dsh plugin add agentdeck-super
dsh --profile <p> headless "用 team_board 建一个组，派两个任务"   # tools are live
node tests/e2e-local.mjs                                        # 5/5 steps, no network, no model calls
node tests/e2e-project.mjs                                      # 两个厂商的 CLI 经任务板真合作干一个项目（需本机装 claude/codex）
```

- Package manifest declares `dsh.bundle` (`./cordis.patch.yml`), `dsh.client` is deliberately absent (no custom UI panel; it ships an HTML status page served by the host).
- License: MIT for code. Paid tiers only cover *our hosted relay / cloud rooms / quota / art packs*; self-hosting the relay (`node tools/relay-server.mjs`) is free and documented.
- No telemetry. Board state lives under `$DSH_HOME/agentdeck-super/`, per-project state (rooms) under `<workspace>/.agentdeck/`, and the license + pet profile follow the person (also under `$DSH_HOME`), so switching projects never re-activates.
- Requires Node ≥ 22.12, zero runtime dependencies.

Powered by DSH.
```

> 提交前跑一遍 `node tools/publish-npm.mjs`（默认 dry-run），确认清单/图标/文件都在，再 `--publish`。

---

## 3. 截图/动图清单（市场条目需要，按顺序拍）

| # | 画面 | 怎么复现 | 说明文字 |
| --- | --- | --- | --- |
| 1 | 四行安装 + `/deck` 状态输出 | `dsh plugin add agentdeck-super` → `/deck` | "一行装好，四个 agent 已就位" |
| 2 | 任务板：3 个任务两种状态 | `team_board` 建组派活 | "谁在干什么，一眼看到" |
| 3 | 超级 Agent 真改文件 | 让它"把 README 的安装段改成一行命令" | "它不是聊天，它动手" |
| 4 | 跨机房间 + 邀请链接 | `/deck room create 演示` | "把这条链接发给同事，他不用买" |
| 5 | 桌宠 + 习惯总结 | `/deck pet` | "它记得你每天几点干什么" |
| 6 | 自检 5/5 | `node tests/e2e-local.mjs` | "全部真跑通，不是 PPT" |
| 7 | 两个厂商的 Agent 真合作干项目 | `node tests/e2e-project.mjs`（要本机装了 `claude` / `codex`） | "Claude 写、Codex 审，它们自己在板上抢活" |

拍完把 GIF 放 `assets/`（≤ 5 MB），README 里引用。

---

## 4. 投放文案（社交平台，短）

**即刻 / 小红书**
> 我把 claude、codex、gemini、dsh 塞进了同一张任务板，然后拉了个同事进来一起干。
> 他不用装任何东西，点我发的链接就进来了。
> 开源，免费版能干完全部活；要"一起干"才收费。
> 👉 `dsh plugin add agentdeck-super`

**V2EX / 少数派标题**
> 我做了一个能让不同厂商的 Agent 和人一起干活的 DSH 插件（开源，含跨机协作）

**Twitter/X**
> Shipped `agentdeck-super`: a DSH plugin that puts claude / codex / gemini / dsh on one task board — and lets a teammate join from a link without installing anything.
> Heterogeneous agents, invite-as-seat, offline-first. MIT.
> `dsh plugin add agentdeck-super`

---

## 5. 上架后的第一周动作

1. 提 PR 当天，在 README 顶部加"市场已收录"徽章。
2. 盯着 issue：**前 10 个反馈决定第二版做什么**，别自己猜。
3. 有人问"能不能和 XX 一起用" → 那就是下一个接入适配器，公开排期。
4. 每有一个付费用户，把他的话（征得同意）放进 README 的"谁在用"。
