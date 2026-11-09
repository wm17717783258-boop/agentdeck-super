# 授权分区（Licensing）

Nexi 灵犀 / `agentdeck-super` 是**双许可 + 分层**的结构：开源核心 AGPL-3.0，适配器与协议 Apache-2.0，商业层独立闭源。
切法只有一条原则：**谁能接进来，谁都不用改自己的代码；谁把 Nexi 变成云服务，谁就得开源。**

---

## 一、开源核心 · AGPL-3.0-only

覆盖：`lib/`（下述例外之外）、`bin/`、`tools/`、`assets/`（皮肤**规范**除外）、`tests/`、根目录配置与脚本。

- 可以自部署、修改、再分发、商用。
- **通过网络向他人提供服务时，必须向使用者提供完整源码**（AGPL 第 13 条）。这是和 MIT/Apache 的关键差别，也是「不被云厂商白嫖」的那道墙。
- 想把核心闭源嵌进商业产品 → 需要单独的商业授权，到 [Issues](https://github.com/wm17717783258-boop/agentdeck-super/issues) 开一张「商业授权」工单。

全文见 [LICENSE](LICENSE)（GNU AGPL-3.0，34 KB，逐字未改）。

## 二、适配器与协议 · Apache-2.0

覆盖：

| 路径 | 为什么是 Apache-2.0 |
|---|---|
| `lib/mcp/**` | MCP 网关（stdio / Streamable HTTP）——宿主厂商要能零成本实现 |
| `lib/connect/hosts.js` | 13 个宿主的适配定义（Claude Desktop / Claude Code / Cursor / Windsurf / Codex / Cline / VS Code / Continue / Gemini CLI / Qwen Code / Copilot CLI / Zed / OpenCode） |
| `docs/**` | 协议契约：`CONTRACTS.md`、`host-api.md`、`transports.md`、`PASSPORT.md`、`PET.md` |
| `assets/skins/**` | 皮肤包格式规范，让第三方能出皮肤而不用碰核心 |

- 允许自由集成进自己的产品，**包括闭源产品**，无需开源你的宿主。
- 保留版权与免责声明即可（Apache-2.0 第 4 条）。
- 全文见 [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)。

**目的**：让 Claude / Cursor / Codex / Windsurf 这些宿主厂零法律成本接入 Nexi，把「能接」变成默认，而不是谈判项。

## 三、商业层 · 闭源，不在本仓库

**这部分代码物理上不在公开仓库与公开包里**（`pro/` 已被 `.gitignore` 与打包白名单双重排除，`pro/package.json` 标了 `private: true` / `UNLICENSED`，从里面跑 `npm publish` 会被直接拒）。

本仓库对它的唯一依赖是 `lib/pro-resolve.js` 一个**可失败的加载器**：装得到就用，装不到就降级，绝不崩。
`pro/` 自己也有一份**本地** git 历史（`pro/.git`），只用于误删/误清理后的还原，**永远不推任何公开远端**。
**核心代码里不允许出现任何指向 `pro/` 的静态 `import`** —— 这条由 `tools/guard-boundary.mjs` 强制（`npm test` 与发布预检都会跑它）。

| 模块 | 内容 |
|---|---|
| `pro/billing/**` | 支付渠道适配（Stripe / 微信 / 支付宝 / 人工记账） |
| `pro/market/**` | 皮肤与主题的货架、下单交付、退款、创作者分账、发票、对账 |
| `pro/sync/**` | 多设备加密同步（快照打包、增量合并、冲突解决） |
| `pro/meeting/**` | 跨厂商会议编排（含 `deck_meeting` 工具本体） |

**开源核心不依赖它们即可完整跑通本地闭环**：

- 单机工具带、团队编排、桌宠、数字分身、策略与审计 —— 全部在开源侧。
- 跨机配对（`deck_room` / `nexi pair`）与本地中继（`lib/hosting/**`）—— 在开源侧，属于「永不付费墙」。

两种部署形态下工具面的真实差别（写清楚，不让人猜）：

| 工具 | 完整版（装了 `pro/`） | 开源版（无 `pro/`） |
|---|---|---|
| `deck_market` | 货架 / 下单 / 订单 / 退款 / 发票 / 对账 | **仍然注册**，调用时如实回「皮肤市场需要 Nexi Pro」；已装皮肤照常可用 |
| `deck_sync` | 打包 / 应用 / 增量 / 冲突 | **仍然注册**，调用时如实回「多设备加密同步需要 Nexi Pro」；单机与本地备份不受影响 |
| `deck_meeting` | 开会 / 议程 / 决议 | **不注册**（它的工具定义与实现在 `pro/meeting/` 里，核心侧没有可广告的 schema） |

其余工具两种形态完全一致。工具总数：完整版 23 个，开源版 22 个。


### 许可历史（必须如实记录）

`agentdeck-super` 的 `1.11.5` – `1.11.8` 四个版本**已以 AGPL-3.0 发布到 npm，且包内含当时的商业层代码**（`lib/billing/**`、`lib/market/**`、`lib/sync/**`、`lib/meeting/**`）。

**AGPL 不可撤销**：已经取得这四个版本的人，可继续按 AGPL-3.0 使用与再分发其中的代码。本文件所述的「商业层闭源」自 `pro/` 拆分之后的新代码起生效，不追溯已发布版本。

## 四、永不付费墙

按产品基线，以下三件事永远免费且不受限于任何订阅：**互操作基础接入（含跨机配对与本地中继）、本地记忆、数据导出权**。

## 五、已发布版本的许可

`agentdeck-super@1.9.0` 及更早的 `1.9.x` 预处理包对外标注的是 MIT；**以本文件与当前 `LICENSE` 为准的 AGPL-3.0 自 `1.10.0` 起生效**。已按 MIT 取得的副本仍可按 MIT 使用。
