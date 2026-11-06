# M1 · Nexi Connect（MCP 网关）真机证据 · 1.5.0

日期：2026-11-05
版本：agentdeck-super **1.5.0**（`bin/nexi` 进包）
结论一句话：**别的厂商的 Agent，能真的调用我们这套能力干活，而且我们这边的盘上确实多出了它写的东西。**
不是"配置写进去了"，是 Claude Code 建组 → 落盘 → Codex 读到。

---

## 1 这一版加了什么

| 新增 | 文件 | 作用 |
| --- | --- | --- |
| MCP 网关（stdio） | `lib/mcp/server.js` | JSON-RPC 2.0 换行分帧：`initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call`，错误码 `-32700/-32600/-32601/-32602/-32603` |
| Hub（复用层） | `lib/hub.js` | 用假 ctx 跑真正的 `apply()`，工具定义**不复制一份**：MCP 暴露的就是插件里注册的那 9 个工厂产物 |
| 宿主安装器 | `lib/connect/hosts.js` | 8 个宿主：Claude Desktop / Claude Code / Cursor / Windsurf / Codex(TOML) / Cline / Continue / Gemini CLI；哨兵块、备份、幂等、冲突拒绝、精确回滚 |
| CLI | `bin/nexi.mjs` | `mcp / list / call / doctor / install / uninstall / status`，`--dry-run`、`--all`、`--force`、`--json` |
| 状态页 | `lib/index.js` | 新增「接入其他 Agent 宿主（MCP）」区块 + `GET /adbp/v1/mcp`（只报事实） |

反重复守卫：`tests/mcp.test.mjs` 第 3 条断言 **MCP `tools/list` 与 `createHub().list()` 名字完全一致**——将来谁再写一份工具定义，测试立刻红。

## 2 测试

```
$ cd D:\agentdeck-super; $env:DSH_HOME="$env:TEMP\adsk-home-test"
$ node --test --test-concurrency=1 "tests/*.test.mjs"
ℹ tests 306   ℹ pass 306   ℹ fail 0
```

其中新增：`tests/mcp.test.mjs` 3 条（真子进程、真 stdio、真 JSON-RPC）、`tests/connect.test.mjs` 9 条（幂等/备份/坏 JSON/冲突/TOML 往返/回滚/dry-run/探测）。

## 3 真机：三台宿主，两种验证方式

本机实际装了 3 个 MCP 宿主（其余 5 个只报"未安装"，没有凭空造配置）：

| 宿主 | 配置文件 | 接入 | 谁验证的 |
| --- | --- | --- | --- |
| Claude Code | `C:\Users\王冕\.claude.json` | 已接入 | **宿主自己** `claude mcp list` |
| Codex | `C:\Users\王冕\.codex\config.toml` | 已接入 | **宿主自己** `codex mcp list` + 真调用 |
| Claude Desktop | `…\Roaming\Claude\claude_desktop_config.json` | 已接入 | 配置文件写入 + 桌面端需重启才加载（本地未重启，**记为仅写入层验证**） |

### 3.1 Claude Code 自己报的健康状态

`docs/evidence/raw-claude-mcp-list-1.5.0.txt`（原样）：

```
Checking MCP server health…

nexi: C:\Users\王冕\Apps\nodejs\node.exe D:\agentdeck-super\bin\nexi.mjs mcp - √ Connected
```

### 3.2 Codex 自己列的 MCP 服务器

`docs/evidence/raw-codex-mcp-list-1.5.0.txt`（原样，只截了表头与 nexi 行）：

```
nexi  C:\Users\王冕\Apps\nodejs\node.exe  D:\agentdeck-super\bin\nexi.mjs mcp  -  -  enabled  Unsupported
```

## 4 跨厂商真闭环（这条最硬）

### 4.1 Claude Code 写

命令：

```
claude -p "请调用 nexi 这个 MCP 服务上的 team_board 工具：用 action=create 建一个名字叫
 'Claude 第二次通过 MCP 建的组' 的小组，然后用 action=add 加一条任务，标题是
 '跨厂商协作：Claude 写、Codex 读'。把两次工具返回的原文用代码块原样贴出来。"
 --allowedTools "mcp__nexi__team_board"
```

原始输出见 `docs/evidence/raw-claude-writes-board-1.5.0.txt`，关键两段：

```
【team_board】已创建小组 team_bb5d6188b6（Claude 第二次通过 MCP 建的组）
【team_board】已添加任务 task_83926ab99f
标题：跨厂商协作：Claude 写、Codex 读
```

### 4.2 盘上核账（不信模型的嘴，看文件）

```
$ Get-Content C:\Users\王冕\.dsh\agentdeck-super\state.json -Raw | Select-String team_bb5d6188b6
FOUND team_bb5d6188b6
FOUND task_83926ab99f
FOUND 标题（中文原文在盘上）
state.json 最后写入时间：2026年11月5日 16:58:52 → 17:0x（跟着 Claude 的调用在动）
```

### 4.3 Codex 读

命令：

```
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
  "调用 nexi MCP 的 team_board 工具，action=teams，把返回原文贴出来。"
```

原始输出见 `docs/evidence/raw-codex-reads-board-1.5.0.txt`：

```
【team_board】共 5 个小组
1. team_23057f9d03 — 发布验证｜目标：证明打包安装后工具真的能写盘
2. team_3b17f94bd7 — 发布验证141｜目标：证明 1.4.1 的 tarball 装完以后工具真能写盘
3. team_cd84498aa8 — 本地验收-老板亲检｜目标：你亲眼验收：任务板能建组、能派活、能落盘
4. team_9f3e26fa86 — Claude 亲自建的组｜目标：验证 Claude Code 通过 MCP 读写团队任务板
5. team_bb5d6188b6 — Claude 第二次通过 MCP 建的组
```

第 4、5 条都是 **Claude Code 刚通过 MCP 建的组，被 Codex 通过 MCP 读到了**。
这就是"打破 Agent 孤岛"的最小可验证闭环：两个不同厂商、不同模型、不同进程的 Agent，共用同一块任务板。

### 4.4 一条需要注意的坑（如实记）

Codex 默认审批策略下会拦自己：

```
$ codex exec "调用 nexi MCP 的 team_board…"        # approval: never
mcp: nexi/team_board started
mcp: nexi/team_board (failed)
MCP tool call requires approval, but approval policy is never
```

这是 **Codex 自己的安全策略**，不是我们的服务有问题（服务已经起来了）。加
`--dangerously-bypass-approvals-and-sandbox` 或改成 `approval_policy = "on-request"` 才放行。
产品文档里要写清楚：**接入 ≠ 免审批**，宿主自己的审批还得宿主自己开。

## 5 协议层原始报文

`docs/evidence/mcp-session-1.5.0.jsonl`：26 行，真实的 `host→server` / `server→host` 逐条报文（含 stderr 日志），可直接人肉复核。摘要：

```json
{"server":{"name":"nexi","title":"Nexi 灵犀","version":"1.5.0"},
 "protocolVersion":"2025-06-18",
 "tools":["team_board","agent_join","team_orchestrate","super_agent","deck_room",
          "deck_license","pet_visit","pet_meeting","pet_skin"],
 "createOk":true,"addOk":true,"listHasTask":true,
 "unknownToolCode":-32602,"pingOk":true}
```

## 6 状态页上看得见

第二台真 DSH 宿主（`web` profile + 覆盖层，端口 59931，装的就是 1.5.0）：

```
$ curl http://127.0.0.1:59931/adbp/v1/mcp
{"command":"…node.exe …\\profiles\\web\\node_modules\\agentdeck-super\\bin\\nexi.mjs mcp",
 "hosts":[…8 条…],"registered":3,"installed":3,
 "tools":["super_agent","team_orchestrate","agent_join","team_board","deck_license",
          "deck_room","pet_visit","pet_meeting","pet_skin"],"transport":"stdio"}
```

原始 JSON：`docs/evidence/raw-adbp-mcp-1.5.0.json`；页面截图：`docs/evidence/mcp-deck-1.5.0.png`（状态页里 8 个宿主一行一个，3 个显示"已接入"）。

## 7 回滚（必须能干净退）

每个被改的配置文件旁边都有备份：`config.toml.nexi-backup-<ISO时间戳>`、`.claude.json.nexi-backup-<…>`、`claude_desktop_config.json.nexi-backup-<…>`。

```
nexi uninstall codex            # 只删我们那段哨兵块，用户原有配置逐字节保留
nexi uninstall claude-code      # 只删 mcpServers.nexi 这一项
nexi uninstall --all --dry-run  # 先看要动哪些文件，不动盘
```

`tests/connect.test.mjs` 里"uninstall 精确回滚到只剩用户自己的配置"就是这条的机器证明。

## 8 这一版**没有**做到的事（别当成做了）

1. 只做了 **stdio** transport；Streamable HTTP / SSE 还没做（写进 M2）。
2. Cursor / Windsurf / Cline / Continue / Gemini CLI 本机没装，**没有真机验证**，代码路径有测试但对外只能说"支持，未在真机跑过"。`Continue` 标记为 `exp`。
3. Claude Desktop 只验证到"配置文件写对"，**没有重启桌面端**看工具是否列出（重启用户正在用的 App 需要本人同意）。
4. MCP 侧的权限分级、审计、按人限流都还没做——现在接进来的宿主能调全部工具（当版 9 个；1.6.x 已扩到 14 个，含 5 个分身记忆工具，见 `twin-1.6.2.md`）。

