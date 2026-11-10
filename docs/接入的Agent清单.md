# 能接的 Agent 清单

这份清单不是手抄的，是从代码里生成的：

```
nexi host list --md > docs/接入的Agent清单.md   # 整份重生成，含下面的表格
```

**为什么这么设计**：Agent 出新的速度比我们发版快。所以「适配」不是一张固定名单，
而是三层：

1. **内置 30 个**：下面表里这些，`nexi install --all` 一条命令全装；
2. **注册表**：任何吃 MCP 的 Agent，写一份 JSON 描述丢进
   `$DSH_HOME/agentdeck-super/hosts.d/`（`nexi host add <id> <配置文件>`），
   从此 install / where / doctor 全都认它，**不用等发版**；
3. **兜底片段**：连文件都不方便写的，`nexi snippet --shape …` 生成 JSON / YAML / TOML，
   粘进它的 UI 就能用。

> 表里的路径按**当前这台机器**展开；`~` 是家目录，Windows 上是 `%APPDATA%` 那套。
> 想看三个系统各自落哪，跑 `nexi where`。
>
> 配置形状里的 `yaml/…` 是 YAML 宿主（Goose、Continue 新版），
> 写入时按行拼接、只动自己那一段，不重排用户文件（注释和别的扩展都留着）。

## 「依据」这一列，是这张表里最该先看的一列

| 值 | 什么意思 | 能信到什么程度 |
| --- | --- | --- |
| **本机实装** | 跑过 install、看过写进去的字节、跑过 uninstall 且卸干净 | 写盘链路能信；**但没重启宿主 GUI 看工具列表** |
| **文档核对** | 照官方文档 / 官方仓库写的路径与形状，**没在真机上装过** | 路径可能已经过时，装之前先 `nexi doctor <id>` |
| **社区约定** | 没有官方文档，按社区通行布局推的 | 最弱，装完要自己确认宿主认不认 |

**当前实数（30 家）**：`本机实装 6` / `文档核对 22` / `社区约定 2`。

这 6 家是 Claude Desktop、Claude Code、Codex、Gemini CLI、Qwen Code、GitHub Copilot CLI，
凭据是本机配置目录里查得到痕迹 —— 4 家有 `nexi` 备份文件，2 家（走 CLI 写入的）配置里
还留着 `nexi` 条目。**这不是"我印象里装过"，是能在磁盘上验的。**

剩下 24 家是已知的**最大风险**。代码能保证的是「写进去的格式对、写坏了能回滚、写完能卸干净」；
保证不了的是「这家 Agent 这个版本还读这个路径」。把 24 降到 0 只能靠真机，
任何代码改动都替代不了 —— 见 `docs/成熟度自检.md` 第六节。

| 宿主 | id | 配置形状 | 依据 | 自定义 | 配置文件 | 官方文档 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Desktop | `claude-desktop` | mcpServers | 本机实装 |  | `%APPDATA%\Claude\claude_desktop_config.json` | https://modelcontextprotocol.io/ |
| Claude Code | `claude-code` | mcpServers | 本机实装 |  | `~\.claude.json` | https://docs.anthropic.com/en/docs/claude-code/mcp |
| Cursor | `cursor` | mcpServers | 文档核对 |  | `~\.cursor\mcp.json` | https://docs.cursor.com/context/model-context-protocol |
| Windsurf | `windsurf` | mcpServers | 文档核对 |  | `~\.codeium\windsurf\mcp_config.json` | https://docs.windsurf.com/windsurf/cascade/mcp |
| Codex | `codex` | toml | 本机实装 |  | `~\.codex\config.toml` | https://github.com/openai/codex#model-context-protocol-mcp |
| Cline (VS Code) | `cline` | mcpServers | 文档核对 |  | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` | https://docs.cline.bot/mcp/configuring-mcp-servers |
| Continue | `continue` | yaml / json | 文档核对 |  | `~\.continue\config.yaml` | https://docs.continue.dev/customize/deep-dives/mcp |
| Goose | `goose` | yaml/extensions | 文档核对 |  | `%APPDATA%\Block\goose\config\config.yaml` | https://goose-docs.ai/docs/guides/config-file |
| Gemini CLI | `gemini-cli` | mcpServers | 本机实装 |  | `~\.gemini\settings.json` | https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md |
| Qwen Code | `qwen-code` | mcpServers | 本机实装 |  | `~\.qwen\settings.json` | https://github.com/QwenLM/qwen-code |
| GitHub Copilot CLI | `copilot-cli` | mcpServers | 本机实装 |  | `~\.copilot\mcp-config.json` | https://docs.github.com/copilot/how-tos/use-copilot-agents/use-mcp |
| Zed | `zed` | context_servers | 文档核对 |  | `%APPDATA%\Zed\settings.json` | https://zed.dev/docs/ai/mcp |
| VS Code (mcp.json) | `vscode` | servers | 文档核对 |  | `%APPDATA%\Code\User\mcp.json` | https://code.visualstudio.com/docs/copilot/customization/mcp-servers |
| OpenCode | `opencode` | mcp.servers | 文档核对 |  | `~\.config\opencode\opencode.json` | https://opencode.ai/docs/mcp-servers/ |
| Roo Code (VS Code) | `roo-code` | mcpServers | 文档核对 |  | `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json` | https://docs.roocode.com/features/mcp/using-mcp-in-roo |
| Kilo Code (VS Code) | `kilocode` | mcpServers | 文档核对 |  | `%APPDATA%\Code\User\globalStorage\kilocode.kilo-code\settings\mcp_settings.json` | https://kilo.ai/docs/automate/mcp/using-in-kilo-code |
| Kilo CLI | `kilo-cli` | mcp | 文档核对 |  | `~\.config\kilo\kilo.json` | https://kilo.ai/docs/automate/mcp/using-in-kilo-code |
| Kiro | `kiro` | mcpServers | 文档核对 |  | `~\.kiro\settings\mcp.json` | https://kiro.dev/docs/mcp/ |
| LM Studio | `lmstudio` | mcpServers | 文档核对 |  | `~\.lmstudio\mcp.json` | https://lmstudio.ai/docs/app/mcp |
| Factory Droid | `factory` | mcpServers | 文档核对 |  | `~\.factory\mcp.json` | https://docs.factory.ai/ |
| JetBrains Junie | `junie` | mcpServers | 文档核对 |  | `~\.junie\mcp\mcp.json` | https://www.jetbrains.com/help/junie/ |
| Qoder | `qoder` | mcpServers | 文档核对 |  | `~\.qoder\settings.json` | https://qoder.com/ |
| Google Antigravity | `antigravity` | mcpServers | 文档核对 |  | `~\.gemini\config\mcp_config.json` | https://antigravity.google/docs |
| Amazon Q Developer | `amazon-q` | mcpServers | 文档核对 |  | `~\.aws\amazonq\mcp.json` | https://docs.aws.amazon.com/amazonq/ |
| Amp | `amp` | amp.mcpServers | 文档核对 |  | `%APPDATA%\amp\settings.json` | https://ampcode.com/manual#mcp |
| Crush | `crush` | mcp | 文档核对 |  | `~\.config\crush\crush.json` | https://github.com/charmbracelet/crush |
| 腾讯 CodeBuddy | `codebuddy` | mcpServers | 文档核对 |  | `~\.codebuddy\.mcp.json` | https://www.codebuddy.cn/docs/cli/mcp |
| Trae | `trae` | mcpServers | 文档核对 |  | `%APPDATA%\Trae\User\mcp.json` | https://forum.trae.cn/t/topic/65 |
| iFlow CLI | `iflow` | mcpServers | 社区约定 |  | `~\.iflow\settings.json` | https://github.com/iflow-ai/iflow-cli |
| 通义灵码 | `lingma` | mcpServers | 社区约定 |  | `~\.lingma\mcp.json` | https://help.aliyun.com/zh/lingma/ |
