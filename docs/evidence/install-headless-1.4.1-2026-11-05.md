# 真机装机验收（1.4.1 最终包）：tarball 安装 + headless 工具执行

这一份回答一个问题：**别人按 README 装完之后，工具是不是真的能用？**
不是 link 进源码目录（那只能证明源码能跑），是把 `npm pack` 出来的 tarball 用**宿主自己的 `dsh plugin add`** 装进一个干净 profile，然后真开会话、真让模型调工具、真落盘。

- 时间：2026-11-05 15:00–15:03（Asia/Shanghai）
- 机器：Windows · Node v24.15.0 · DSH 0.2.1-rc.5 · pnpm 11.28.5（DSH 运行时自带）
- 被测插件：`agentdeck-super-1.4.1.tgz` — **约 319 KiB / 60 个文件**（精确字节数每次 `npm pack` 都会随文档内容小幅浮动，以命令输出为准；解包约 0.8 MiB）
- 测试 profile：`C:\Users\王冕\.dsh\profiles\agentdecktest`（独立 profile，不碰日常在用的 `desktop`）
- 工作目录：`D:\adsk-headless-proof`（空目录，故意不是源码目录）

## 1. 装（走宿主命令，不是手工拷目录）

```powershell
cd D:\agentdeck-super
pwsh -File scripts\release.ps1 -Version 1.4.1     # 内部：改版本 → 281 用例 → e2e 5 步 → npm pack → 装进 agentdecktest
```

关键一步真的发生了什么（脚本原样输出）：

```text
[4/5] npm pack
    ✓ agentdeck-super-1.4.1.tgz · 60 个文件 · 319 KiB
[5/5] 装进隔离 profile：agentdecktest
    · 用 C:\Users\王冕\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs 当 pnpm（临时 shim：...）
      dependencies:
      - agentdeck-super 1.4.0
      + agentdeck-super 1.4.1
      Done in 894ms using pnpm v11.28.5
    ✓ 已安装 agentdeck-super@1.4.1（真目录，非软链）
```

装完后的独立核对：

| 检查项 | 结果 |
| --- | --- |
| `node_modules\agentdeck-super` 是软链吗 | 否（`LinkType` 为空 = 从 tarball 解出来的实体目录） |
| 装到的版本 | `1.4.1`（与 tarball 的 `package.json` 一致，脚本里断言过） |
| profile 的 `dsh.profile.bundles` | 含 `agentdeck-super` |
| 从公网装同一条命令 | `dsh plugin --profile agentdecktest add agentdeck-super`（发布后再走这条） |

> 本机踩到一个**只在很久没升级过 pnpm 的机器上才出现**的坑，记下来免得别人以为是插件问题：
> `[ERR_PNPM_UNEXPECTED_STORE]`——profile 里旧的 `node_modules` 是 pnpm 10 的 store（v10）链的，装的是 pnpm 11（v11 store），pnpm 拒绝跨 store 混链。
> 解法是 pnpm 官方给的那句：在该 profile 目录跑一次 `pnpm install --config.confirmModulesPurge=false`（非交互环境必须加这个参数，否则报 `Aborted removal of modules directory due to no TTY`），重建后再装就一路过。
> 这一步已经写进 `scripts/release.ps1`：找不到 pnpm 时自动用 DSH 运行时自带的那份做临时 shim，不用用户先装 pnpm。

## 2. 跑（headless 会话里让模型真的调工具）

一条命令、一个 prompt、三步都要真调工具：

```powershell
dsh --profile agentdecktest "严格按顺序做三件事，每件都必须真的调用工具，不许凭记忆作答：
  1) 调 deck_license，action=status；
  2) 调 team_board，action=create，name=发布验证141，goal=证明 1.4.1 的 tarball 装完以后工具真能写盘；
  3) 用上一步返回的 teamId 调 team_board，action=add，title=验证 1.4.1 安装。
  最后把三次工具的原始返回逐条贴出来，并说明状态落在哪个文件（如果返回里有）。"
```

模型返回的原文（未删改）：

```text
三步都已按顺序执行完毕，以下是三次工具调用的原始返回。

### 1) deck_license，action=status
【deck_license】当前档位：免费版
授权状态：还没有授权码（免费版可用）
到期：长期 / 未设置
席位上限：3
权益：免费版：本地房间 1、云房间 0、席位 3、并行 1、仅本机
授权文件：C:\Users\王冕\.dsh\agentdeck-super\.agentdeck\license\key.txt（跟人走：换项目目录不用重新激活）
一句话：免费版已够单机全功能使用；需要多台机器一起干活时再升级（协作版起有云房间）。

### 2) team_board，action=create，name=发布验证141
【team_board】已创建小组 team_3b17f94bd7（发布验证141）
目标：证明 1.4.1 的 tarball 装完以后工具真能写盘
成员：（暂无，可用 agent_join 或 super_agent 带入）

### 3) team_board，action=add，teamId=team_3b17f94bd7
【team_board】已添加任务 task_e05006f5f6
标题：验证 1.4.1 安装
角色：worker
依赖：无（可立即开始）
```

——工具真被调用了，返回的是人话，不是裸 JSON，也不是"工具不存在"。而且**第一步就直接暴露了这次改动的成果**：授权码路径是机级的 `C:\Users\王冕\.dsh\agentdeck-super\...`，不是工作区下的 `.agentdeck`。

## 3. 落盘核对（不信模型的话，直接看文件）

```powershell
Get-Item 'C:\Users\王冕\.dsh\agentdeck-super\state.json'      # 当时 8,498 字节，2026-11-05 15:02:59 写入
Get-Content 'C:\Users\王冕\.dsh\agentdeck-super\state.json' -Raw | ConvertFrom-Json
# teams.team_3b17f94bd7.name = 发布验证141
# teams.team_3b17f94bd7.goal = 证明 1.4.1 的 tarball 装完以后工具真能写盘
# tasks.task_e05006f5f6      = 标题 验证 1.4.1 安装
```

| 检查项 | 结果 | 依据 |
| --- | --- | --- |
| tarball 能装进干净 profile | ✅ | `dsh plugin add` 成功，实体目录，版本 `1.4.1` |
| 装完宿主能加载插件（注册工具、无报错启动） | ✅ | headless 会话正常起来并连续调了 3 次工具 |
| 工具在真实会话里能被模型选中并执行 | ✅ | 三次调用都返回中文可读结果 |
| 执行结果真的落盘、可被下一次会话读到 | ✅ | `state.json` 里 `team_3b17f94bd7` / `task_e05006f5f6` 都在 |
| 不需要源码目录也能跑 | ✅ | 工作目录是空的 `D:\adsk-headless-proof` |

## 4. 这次没测到的（别当成 bug）

- 任务板状态在 `$DSH_HOME\agentdeck-super\state.json`，**全机一张板**（同一个人跨项目延续上下文）；房间在 `<工作区>\.agentdeck\` 下按项目隔离；**桌宠档案与授权码都是机级**（跟着人走，换项目不掉档，迁移实测见 `docs/host-api.md` §11）。
- 这次没测模型额度耗尽 / 网络异常下的降级——那部分由 `tests/e2e-local.mjs` 第 5 步（把中继指向 `127.0.0.1:1`）覆盖。
- 跨公网的两台真机器仍未实测，本地用「两个独立工作区 + 一个真 relay 子进程」代替（`tests/room-two-hosts.test.mjs`），只差把 `tools/relay-server.mjs` 部署到一台公网机器。
