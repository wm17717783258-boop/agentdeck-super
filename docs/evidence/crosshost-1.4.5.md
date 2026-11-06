# 证据：两台真机器、同一个小组、任务双向落地（1.4.5 终版实录）

- 时间：2026-11-05 16:3x（Asia/Shanghai）
- 版本：`agentdeck-super@1.4.5`（本机 `pnpm pack` 打出，装进 `headless` 配置档后跑）
- 机器 A（房主）：`dsh --profile headless --patch D:\demo\hostA4.yml`，工作区 `D:\demo\hostA4\work`，任务板 `D:\demo\hostA4\board`，工作室版授权
- 机器 B（客人）：`dsh --profile headless --patch D:\demo\hostB3.yml`，工作区 `D:\demo\hostB3\work`，任务板 `D:\demo\hostB3\board`，**全新机器、任务板一张白纸、没有授权**
- relay：`node tools\relay-server.mjs --port 8787 --data .relay-data`（本机 8787）
- 房间：`4c8f6032-fdc9-4aaf-bfe8-6ff278f9898a`（联合交付·终验），小组：`team_e7505dae8c`

## 这一版修的是什么

1.4.4 及以前，客人那台机器本机没有房主的小组，远端任务拉下来无处可落（`team not found`），
错误被吞进 `applied:0`，回执却还写"已同步"。线上真实踩到：B 那边 `deck_room sync` 说
"推上去 1 条、拉回来 1 条"，`team_board list` 却是空的。

修法：

- `lib/engine/board.js`：`createTeam({ id })` 支持指定 id（幂等，已存在就直接返回），小组能在另一台机器上"原样复刻"。
- `lib/room.js`：`ensureRoomTeam()` 在落地远端 `task/*` 事件前先复刻房主的小组；`joinRoom` 记住 relay 下发的 `teamId`，`resume` 重启后也认；`pull()` 分开数「事件落地」和「任务落地」（`appliedTasks`），回执里"落到本机任务板 N 条"是任务数，不再拿事件数充数。
- `tools/relay-server.mjs`：建房 / 进房 / 房间概况三个回执都带上 `room.teamId`。
- `lib/tools/room.js`：sync 回执如实报数，复刻小组成功时明说"已在本机复刻房主的小组 …"。

## 原始输出（工具返回逐字粘贴）

### 机器 B：进房

```text
【deck_room】已进房间：4c8f6032-fdc9-4aaf-bfe8-6ff278f9898a（联合交付·终验） · 成员 · 席位 40170f24-c57a-4ec4-a89c-69a9193a6b58
成员 2 人：王冕(owner)、客人
下一步：deck_room sync 把本地任务推上去、把房间里的任务拉下来。
```

### 机器 B：第一次 sync —— 小组在本机被复刻出来，房主的两个任务真的落板

```text
【deck_room】已同步房间 4c8f6032-fdc9-4aaf-bfe8-6ff278f9898a：推上去 0 条、拉回来 3 条（其中落到本机任务板 2 条）。
已在本机复刻房主的小组 team_e7505dae8c：从现在起两边的任务在同一个小组里，team_board list 用这个 id 看。
成员 2 人：王冕(owner)、客人
```

```text
【team_board】小组 team_e7505dae8c 任务（2 条）

· r_e8f95d_task_e036d9cc8a [pending] 主机A：写一份上线检查清单（含5条）  角色:worker
    验收：五条都能照着做
· r_e8f95d_task_3acd9d5c93 [pending] 主机A：把清单里的回滚步骤单独摘出来  角色:tester
    验收：有明确回滚命令

进度：完成 0/2
```

### 机器 B：在复刻出来的小组里加自己的任务

```text
【team_board】已添加任务 task_0d5de08182
标题：主机B：写一份部署脚本（含3步）
角色：worker
验收：脚本能直接跑
依赖：无（可立即开始）
```

### 机器 B：第二次 sync —— 自己的任务推上去

```text
【deck_room】已同步房间 4c8f6032-fdc9-4aaf-bfe8-6ff278f9898a：推上去 1 条、拉回来 1 条（其中落到本机任务板 0 条，另 1 条是自己发的或之前已经拉过）。
提醒：这次拉回来的 1 条没有新内容落到板子上（自己发的事件或重复事件都算）。以 team_board list 的结果为准。
成员 2 人：王冕(owner)、客人
```

```text
【team_board】小组 team_e7505dae8c 任务（3 条）

· r_e8f95d_task_e036d9cc8a [pending] 主机A：写一份上线检查清单（含5条）  角色:worker
    验收：五条都能照着做
· r_e8f95d_task_3acd9d5c93 [pending] 主机A：把清单里的回滚步骤单独摘出来  角色:tester
    验收：有明确回滚命令
· task_0d5de08182 [pending] 主机B：写一份部署脚本（含3步）  角色:worker
    验收：脚本能直接跑

进度：完成 0/3
```

### 机器 A（房主）：回头 sync —— 客人的任务出现在自己的板子上

```text
【deck_room】已同步房间 4c8f6032-fdc9-4aaf-bfe8-6ff278f9898a：推上去 2 条、拉回来 4 条（其中落到本机任务板 1 条，另 2 条是自己发的或之前已经拉过）。
成员 2 人：王冕(owner)、客人
```

```text
【team_board】小组 team_e7505dae8c 任务（3 条）

· task_e036d9cc8a [pending] 主机A：写一份上线检查清单（含5条）  角色:worker
    验收：五条都能照着做
· task_3acd9d5c93 [pending] 主机A：把清单里的回滚步骤单独摘出来  角色:tester
    验收：有明确回滚命令
· r_40170f_task_0d5de08182 [pending] 主机B：写一份部署脚本（含3步）  角色:worker
    验收：脚本能直接跑

进度：完成 0/3
```

## 结论

- **双向都通**：A 的板子上有 B 的活（`r_40170f_task_0d5de08182`，前缀是对方席位，能认领回原产地）；B 的板子上有 A 的两条活。
- **id 对齐**：两台机器都叫 `team_e7505dae8c`，不是各看各的小组。
- **客人零授权**：B 是免费档，凭邀请链接就进来了。
- **数字不忽悠**：3 条任务 = 1 条本机 + 2 条镜像；"落到本机任务板 N 条"是任务数。

## 复现（三行）

```powershell
node tools\relay-server.mjs --port 8787 --data .relay-data
dsh --profile headless --patch D:\demo\hostA4.yml "team_board create → add×2 → deck_room create → sync → list"
dsh --profile headless --patch D:\demo\hostB3.yml "deck_room join <邀请链接> → sync → list → add → sync → list"
```

## 自动化回归

`tests/room-two-hosts.test.mjs` 里新加一条：

> 回归：客人本机没有房主的小组时，拉下来的任务必须自己长出小组并真的落板

它起一个真 relay 子进程、两个真任务板根目录，断言：join 拿到 `teamId` → `ensureRoomTeam()` 复刻成功 →
`pull().appliedTasks ≥ 1` → 镜像任务带着来源坐标出现 → 客人能在复刻出来的小组里 `addTask` →
房主回头同步看得到客人的任务。

同一文件原有的双机用例也改成"房间绑定房主的小组"这一正确语义（以前它默认两台机器各有一个小组）。

全量：`node --test --test-concurrency=1 "tests/*.test.mjs"` → **286 / 286 通过**（约 17 秒）。
