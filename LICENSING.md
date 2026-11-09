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
| `pro/billing/**` | 在线支付渠道适配（Stripe / 微信 / 支付宝路由、签名、幂等）+ 从 `AGENTDECK_PAY_*` 认出渠道 |
| `pro/market/reconcile.js` | 渠道对账单 ↔ 本机订单逐笔勾对 |
| `pro/market/invoice.js` | 发票数据（票面字段） |
| `pro/market/themes.js` | 主题包（皮肤 + 音效 + 动作打包卖） |
| `pro/sync/**` | 多设备加密同步（快照打包、增量合并、冲突解决） |
| `pro/meeting/**` | 跨厂商会议编排（含 `deck_meeting` 工具本体） |

**皮肤市场的买家侧全部开源**（1.11.9 起重划）。`lib/market/**` 里有货架、账本、下单、人工确认发放、退款、80/20 分账计算 —— 所以跑免费版的人**能真的付钱、能真的拿到皮肤**，而不是看着入口买不了。

**防伪那一层也在开源侧**（同一版补的）：账本 HMAC 封印（`lib/market/integrity.js`）、双源交叉核对、ADSK1 签名授权验签（`lib/license.js` 里的内置公钥）、卖家收款方式（`lib/market/payout.js`）。这些不是"商业机密"——它们只在**买家机器上**跑，买家有权看到自己那台机器到底怎么判"这套皮肤算不算买过"。真正的闭源价值在服务端（在线渠道**签发**、对账、发票），不在校验逻辑本身。

这样切的原因很实在：如果把「买」也锁进付费墙，那么收入来源（买家）必须先付费才能付费，逻辑上就是死的。

**开源核心不依赖它们即可完整跑通本地闭环**：

- 单机工具带、团队编排、桌宠、数字分身、策略与审计 —— 全部在开源侧。
- 跨机配对（`deck_room` / `nexi pair`）与本地中继（`lib/hosting/**`）—— 在开源侧，属于「永不付费墙」。
- 皮肤市场的买、卖、退、查 —— 在开源侧。人工收款（`place` → 转账 → `confirm`）不需要任何商户号，两种形态都能跑通。

两种部署形态下工具面的真实差别（写清楚，不让人猜）：

| 工具 | 完整版（装了 `pro/`） | 开源版（无 `pro/`） |
|---|---|---|
| `deck_market` | 全部动作：货架 / 下单 / 人工确认 / 订单 / 退款 / 收款方式 / **发票 / 对账 / 主题包** | **同样能买卖退款**（`catalog`/`place`/`confirm`/`orders`/`refund`/`payinfo`/`health`）；只有 `invoice`/`reconcile`/`themes` 回「卖家侧工具需要 Nexi Pro」 |
| `deck_sync` | 打包 / 应用 / 增量 / 冲突 | **仍然注册**，调用时如实回「多设备加密同步需要 Nexi Pro」；单机与本地备份不受影响 |
| `deck_meeting` | 开会 / 议程 / 决议 | **不注册**（它的工具定义与实现在 `pro/meeting/` 里，核心侧没有可广告的 schema） |

其余工具两种形态完全一致。工具总数：完整版 23 个，开源版 22 个。
**在线收银台**（自动扣款、webhook 回调、自动退款）需要 `pro/billing/**`；没有它时 `health` 会明说「未配置」，并给出人工渠道的三步操作。这不算降级失败 —— 人工渠道本来就是完整可用的收款方式。


### 许可历史（必须如实记录）

`agentdeck-super` 的 `1.11.5` – `1.11.8` 四个版本**已以 AGPL-3.0 发布到 npm，且包内含当时的商业层代码**（`lib/billing/**`、`lib/market/**`、`lib/sync/**`、`lib/meeting/**`）。

**AGPL 不可撤销**：已经取得这四个版本的人，可继续按 AGPL-3.0 使用与再分发其中的代码。本文件所述的「商业层闭源」自 `pro/` 拆分之后的新代码起生效，不追溯已发布版本。

从 `1.11.9` 起，边界又改了一次（**往回收，不是往前推**）：拆分时被搬进 `pro/market/**` 的那部分——货架、账本、下单、人工确认发放、退款、80/20 分账——**搬回** `lib/market/**`（开源），只有渠道识别、对账、发票、主题包留在 `pro/`。也就是说，**1.11.9 开源的部分比 1.11.8 更多**，没有任何东西从开源变闭源。

## 四、永不付费墙

按产品基线，以下三件事永远免费且不受限于任何订阅：**互操作基础接入（含跨机配对与本地中继）、本地记忆、数据导出权**。

## 五、已发布版本的许可

`agentdeck-super@1.9.0` 及更早的 `1.9.x` 预处理包对外标注的是 MIT；**以本文件与当前 `LICENSE` 为准的 AGPL-3.0 自 `1.10.0` 起生效**。已按 MIT 取得的副本仍可按 MIT 使用。
