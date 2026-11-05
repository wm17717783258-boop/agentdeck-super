# 安全与漏洞

## 报告方式

- 一般问题：直接开 issue（`.github/ISSUE_TEMPLATE/bug_report.yml`）。
- **安全类问题（能读不该读的文件、能越权执行、授权码可伪造、中继可被滥用）**：请先私下告知作者，别开公开 issue。仓库里留的联系方式只有维护者邮箱；发出后 72 小时内会给回执。

请附：能复现的最小步骤、涉及的版本（`dsh plugin --profile <p> list` 里的版本号）、你的平台（Windows / macOS / Linux + Node 版本）。**不要**附真实授权码或 API key。

## 范围（这个插件真的会碰什么）

| 能力 | 边界 |
| --- | --- |
| 起子进程跑本机 CLI（claude / codex / dsh / gemini…） | 只跑用户**自己**装好并已登录的 CLI；命令行参数来自 `lib/engine/cli.js` 的预设表，不拼 shell 字符串，`windowsHide: true`，超时/中断用 `taskkill /T /F` 收整棵树 |
| 读写文件 | 走 DSH 宿主给的工具（`ctx.tools`），受宿主的文件策略约束；插件自己不绕过策略 |
| 网络 | 只有两处：模型 API（宿主通道或用户自配 baseUrl）、自建中继（`tools/relay-server.mjs`，默认不启用）。无任何遥测上报 |
| 落盘 | 任务板 `$DSH_HOME/agentdeck-super/`、授权码与桌宠档案 `$DSH_HOME/agentdeck-super/.agentdeck/`、房间 `<工作区>/.agentdeck/rooms/`。全为明文 JSON，随时可删 |
| 授权码 | Ed25519 离线签名（`ADSK1.<payload>.<sig>`），公钥内置在 `lib/license.js`；篡改任一字节即验签失败（有测试） |

## 已知的设计取舍（不是漏洞，但你应该知道）

- **房间邀请令牌 = 进入凭证**：拿到邀请链接的人就能进房间（这正是"不用买、点开就能一起干"的实现方式）。房主可以随时 `close` 房间，令牌随之失效。分享前请确认你把链接发给了谁。
- **中继是纯转发**：`tools/relay-server.mjs` 不存模型密钥、不做身份认证之外的事；房主付费校验用签名授权码（`ADSK1`），伪造会被 402 拒绝。自己部署中继是免费的。
- **本机 CLI 的权限由它自己决定**：例如 `claude --permission-mode acceptEdits` 会真的改文件。这是"能干活"的前提；不想让它改就换更保守的预设（`lib/engine/cli.js` 里可配）。

## 不在范围内

- DSH 宿主本身的漏洞（请报到 DSH 项目）。
- 本机 CLI 自身的漏洞（请报到对应厂商）。
- 用户自己把授权码/邀请链接贴到公开渠道导致的滥用。
