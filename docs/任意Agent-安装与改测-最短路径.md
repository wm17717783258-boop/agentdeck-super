# 任意电脑、任意主流 Agent：最短安装与改测路径

版本：`1.11.5`  
结论先说：**能统一安装和更新，不能统一所有宿主的一个搜索框。**

## 1. 直接回答

### 能做到

- 任何一台有 **Node.js >= 22.12** 的 Windows / macOS / Linux 电脑；
- 同一个包、同一个安装命令；
- 自动探测并写入 8 个宿主：Claude Desktop、Claude Code、Cursor、Windsurf、Codex、Cline / VS Code、Continue、Gemini CLI；
- 宿主配置只指向稳定启动器 `<安装目录>/bin/nexi.mjs`；
- 改源码或换 tgz 后一条命令切换版本，宿主配置路径不变；
- 坏包不覆盖当前版本，旧版本保留，`nexi rollback` 可回退；
- 安装后直接用 `nexi pair host` / `nexi pair guest` 做双机测试；
- 多设备按席位加入，房间上限实际是 **200 席**，不是无限。

### 不能做到

**不存在“所有主流 Agent 共用一个插件搜索框”这件事。**

- npm 是包仓库，不是 Claude / Codex / Cursor 的搜索框；
- MCP Registry 只对实现了 Registry 的客户端可见；
- DSH 市场只给 DSH；
- Claude Desktop、Cursor、Windsurf、Codex 等宿主的配置方式各不相同。

所以正确承诺是：

> **一次发布、一个包、一个安装入口；不是所有宿主共用一个搜索市场。**

目前 npm 包、MCP Registry、GitHub Release 还没有发布。没有 npm/GitHub 账号凭据，
就不能声称“现在已经在市场里搜得到”。代码和离线安装包已经能测。

## 2. 任意设备最短安装

### 现在就能测（不依赖 npm）

把 `agentdeck-super-1.11.5.tgz` 拷到目标电脑，在包所在目录执行：

```powershell
node install.mjs --bundle .\agentdeck-super-1.11.5.tgz
```

已经解包时也可以：

```powershell
cd package
node install.mjs
```

验证：

```powershell
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" doctor
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" status
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair help
```

macOS 默认安装在 `~/Library/Application Support/Nexi`；Linux 默认在
`~/.local/share/nexi`，对应把上面的路径换掉即可。

### npm 发布后才能用的一行

```powershell
npx -y agentdeck-super@latest --all
```

这一行只有在 npm 上架后才成立。现在 npm 查询还是 404，不能把它写成已经可用。

## 3. 改完代码怎么继续测

### 只改本机源码

在项目源码根目录：

```powershell
node install.mjs --no-hosts
```

作用：把当前源码重新装进固定目录并原子切换 `current.json`，不碰宿主配置。
重启宿主即可让新代码生效。

### 模拟真实用户安装包

```powershell
npm pack --pack-destination .
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" update --bundle .\agentdeck-super-1.11.5.tgz
```

失败或要回退：

```powershell
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" rollback
```

宿主配置始终指向同一个稳定启动器，所以更新/回滚不需要重新改 8 个宿主的配置。

## 4. 两台以上物理设备最短测试

### 每台设备

安装同一个包，然后只做一次验证：

```powershell
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" doctor
```

### 房主设备

```powershell
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair host --tier business --seats 50
```

它会选本机局域网地址、起中继、签测试授权、建房间，并打印邀请。**窗口不能关**。

### 成员设备

把邀请保存成 `invite.txt`，然后：

```powershell
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair guest --invite-file invite.txt --name "张三-设计部"
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair check
```

### 两边验收同一件事

房主：

```powershell
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair task add --title "跨机验收任务" --acceptance "对方看到并领取"
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair sync
```

成员：

```powershell
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair sync
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair task list
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair task claim --id <任务号>
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair task done --id <任务号> --output "已完成"
node "$env:LOCALAPPDATA\Nexi\bin\nexi.mjs" pair sync
```

房主再 `sync` + `task list`，看到任务从 `pending` 走到 `done`，才算跨机协作通过。

### 席位口径

| 档位 | 席位上限（含房主） |
| --- | ---: |
| free | 3 |
| plus | 8 |
| studio | 30 |
| business | 200 |

每台设备占 1 席；同一条邀请可以给多人用，但超过席位上限 relay 返回 `room_full`。
当前不支持按员工单独签发/撤销邀请，公司内部用“姓名-部门/设备名”维护名单。

## 5. 做到“搜索安装”还缺什么

代码不缺安装器，缺的是发布凭据和渠道上架：

```powershell
npm login
npm publish --access public
node tools\publish-registry.mjs --login
node tools\publish-registry.mjs --publish
```

之后：

- npm 上可以搜到 `agentdeck-super`；
- 支持 MCP Registry 的客户端可以搜到该条目；
- DSH 可以用 `dsh plugin add agentdeck-super`；
- GitHub Release 提供 tgz 下载；
- 仍然没有“所有 Agent 共用一个市场”这回事。

**现在的真实状态：** 包、安装器、稳定启动器、更新/回滚、单机全量测试和
18 项验收已经跑通；npm / MCP Registry / GitHub Release 未发布；第二台物理设备
还没有实机跑过，不能用“同机双进程 28/28”冒充“物理双机已验收”。
