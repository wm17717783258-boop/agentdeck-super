# 能接的 Agent 清单

这份清单不是手抄的，是从代码里生成的：

```
nexi host list --md >> docs/接入的Agent清单.md   # 只追加表格部分
```

**为什么这么设计**：Agent 出新的速度比我们发版快。所以「适配」不是一张固定名单，
而是三层：

1. **内置 26 个**：下面表里这些，`nexi install --all` 一条命令全装；
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

| 宿主 | id | 配置形状 | 自定义 | 配置文件 | 官方文档 |
| --- | --- | --- | --- | --- | --- |
| Claude Desktop | `claude-desktop` | mcpServers |  | `%APPDATA%\Claude\claude_desktop_config.json` | https://modelcontextprotocol.io/ |
| Claude Code | `claude-code` | mcpServers |  | `~\.claude.json` |  |
| Cursor | `cursor` | mcpServers |  | `~\.cursor\mcp.json` |  |
| Windsurf | `windsurf` | mcpServers |  | `~\.codeium\windsurf\mcp_config.json` |  |
| Codex | `codex` | toml |  | `~\.codex\config.toml` |  |
| Cline (VS Code) | `cline` | mcpServers |  | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |  |
| Continue | `continue` | yaml / json |  | `~\.continue\config.yaml` | https://docs.continue.dev/customize/deep-dives/mcp |
| Goose | `goose` | yaml/extensions |  | `%APPDATA%\Block\goose\config\config.yaml` | https://goose-docs.ai/docs/guides/config-file |
| Gemini CLI | `gemini-cli` | mcpServers |  | `~\.gemini\settings.json` |  |
| Qwen Code | `qwen-code` | mcpServers |  | `~\.qwen\settings.json` | https://github.com/QwenLM/qwen-code |
| GitHub Copilot CLI | `copilot-cli` | mcpServers |  | `~\.copilot\mcp-config.json` | https://docs.github.com/copilot/how-tos/use-copilot-agents/use-mcp |
| Zed | `zed` | context_servers |  | `%APPDATA%\Zed\settings.json` | https://zed.dev/docs/ai/mcp |
| VS Code (mcp.json) | `vscode` | servers |  | `%APPDATA%\Code\User\mcp.json` | https://code.visualstudio.com/docs/copilot/customization/mcp-servers |
| OpenCode | `opencode` | mcp.servers |  | `~\.config\opencode\opencode.json` | https://opencode.ai/docs/mcp-servers/ |
| Roo Code (VS Code) | `roo-code` | mcpServers |  | `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json` | https://docs.roocode.com/features/mcp/using-mcp-in-roo |
| Kilo Code (VS Code) | `kilocode` | mcpServers |  | `%APPDATA%\Code\User\globalStorage\kilocode.kilo-code\settings\mcp_settings.json` | https://kilo.ai/docs/automate/mcp/using-in-kilo-code |
| Kilo CLI | `kilo-cli` | mcp |  | `~\.config\kilo\kilo.json` | https://kilo.ai/docs/automate/mcp/using-in-kilo-code |
| Kiro | `kiro` | mcpServers |  | `~\.kiro\settings\mcp.json` | https://kiro.dev/docs/mcp/ |
| LM Studio | `lmstudio` | mcpServers |  | `~\.lmstudio\mcp.json` | https://lmstudio.ai/docs/app/mcp |
| Factory Droid | `factory` | mcpServers |  | `~\.factory\mcp.json` | https://docs.factory.ai/ |
| JetBrains Junie | `junie` | mcpServers |  | `~\.junie\mcp\mcp.json` | https://www.jetbrains.com/help/junie/ |
| Qoder | `qoder` | mcpServers |  | `~\.qoder\settings.json` | https://qoder.com/ |
| Google Antigravity | `antigravity` | mcpServers |  | `~\.gemini\config\mcp_config.json` | https://antigravity.google/docs |
| Amazon Q Developer | `amazon-q` | mcpServers |  | `~\.aws\amazonq\mcp.json` | https://docs.aws.amazon.com/amazonq/ |
| Amp | `amp` | amp.mcpServers |  | `%APPDATA%\amp\settings.json` | https://ampcode.com/manual#mcp |
| Crush | `crush` | mcp |  | `~\.config\crush\crush.json` | https://github.com/charmbracelet/crush |
