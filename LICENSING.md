# 授权分区（Licensing）

Nexi 灵犀 / `agentdeck-super` 不是单一许可，而是**双许可分区**：核心 AGPL-3.0，适配器与协议 Apache-2.0。
切法只有一条原则：**谁能接进来，谁都不用改自己的代码；谁把 Nexi 变成云服务，谁就得开源。**

---

## 一、核心 · AGPL-3.0-only

覆盖：`lib/`（下述例外之外）、`bin/`、`tools/`、`assets/`（皮肤**规范**除外）、根目录配置与脚本。

- 可以自部署、修改、再分发、商用。
- **通过网络向他人提供服务时，必须向使用者提供完整源码**（AGPL 第 13 条）。这是和 MIT/Apache 的关键差别，也是「不被云厂商白嫖」的那道墙。
- 想把核心闭源嵌进商业产品 → 需要单独的商业授权，到 [Issues](https://github.com/wm17717783258-boop/agentdeck-super/issues) 开一张「商业授权」工单。

全文见 [LICENSE](LICENSE)（GNU AGPL-3.0，34 KB，逐字未改）。

## 二、适配器与协议 · Apache-2.0

覆盖：

| 路径 | 为什么是 Apache-2.0 |
|---|---|
| `lib/mcp/**` | MCP 网关（stdio / Streamable HTTP）——宿主厂商要能零成本实现 |
| `lib/connect/hosts.js` | 8 个宿主的适配定义（Claude Desktop / Claude Code / Cursor / Windsurf / Codex / Cline / Continue / Gemini CLI） |
| `docs/**` | 协议契约：`CONTRACTS.md`、`host-api.md`、`transports.md`、`PASSPORT.md`、`PET.md` |
| `assets/skins/**` | 皮肤包格式规范，让第三方能出皮肤而不用碰核心 |

- 允许自由集成进自己的产品，**包括闭源产品**，无需开源你的宿主。
- 保留版权与免责声明即可（Apache-2.0 第 4 条）。
- 全文见 [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)。

**目的**：让 Claude / Cursor / Codex / Windsurf 这些宿主厂零法律成本接入 Nexi，把「能接」变成默认，而不是谈判项。

## 三、不在本仓库的部分（商业层）

多设备加密同步 · 托管串门中继 · 云端会议编排与转写 · 团队控制台 / SSO / 审计保留 · 官方皮肤与人格包 · 市场支付与创作者结算。
这些**不在**本仓库，也不在任何开源许可内；开源核心不依赖它们即可完整跑通本地闭环。

## 四、永不付费墙

按产品基线，以下三件事永远免费且不受限于任何订阅：**互操作基础接入、本地记忆、数据导出权**。

## 五、已发布版本的许可

`agentdeck-super@1.9.0` 及更早的 `1.9.x` 预处理包对外标注的是 MIT；**以本文件与当前 `LICENSE` 为准的 AGPL-3.0 自 `1.10.0` 起生效**。已按 MIT 取得的副本仍可按 MIT 使用。
