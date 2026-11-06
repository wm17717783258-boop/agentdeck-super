# 活体验收：插件装进老板自己的 GUI（profile `desktop`）当场跑通

- 时间：2026-11-05 15:37–15:42（Asia/Shanghai）
- 机器：本机（Windows），DSH 0.2.1-rc.5，GUI `http://127.0.0.1:59710`
- 安装来源：GitHub Release tgz `https://github.com/wm17717783258-boop/agentdeck-super/releases/download/v1.4.1/agentdeck-super-1.4.1.tgz`

## 1. 装进正在使用的 profile（不是新建 profile，是老板眼前这个）

通过 DSH 原生 `plugin_manager install_bundle` 安装到当前 live profile `desktop`，返回：

```json
{"stage":"enable","target":"agentdeck-super","enabled":true,"changed":true,
 "application":"applied","bundle":"agentdeck-super","version":"1.4.1","warnings":[]}
```

pnpm 输出 `+ agentdeck-super 1.4.1`，耗时 12.8s，日志 `C:\Users\王冕\.dsh\profiles\desktop\.plugin-manager\logs\operation-XUJgBH\pnpm.log`。
`application: applied` = live profile 立即生效，无需重启。

## 2. 装完当场调工具（同一会话内，真实返回）

| 调用 | 真实返回要点 |
| --- | --- |
| `deck_license status` | 免费版；席位 3；授权文件 `C:\Users\王冕\.dsh\agentdeck-super\.agentdeck\license\key.txt` |
| `team_board create` | `team_cd84498aa8`（本地验收-老板亲检） |
| `team_board add` | `task_31e86ea313`，角色 worker，带验收标准 |
| `pet_skin list` | 4 套皮肤（basic/nio/ink 免费，premium-aurora ¥18 未解锁） |
| `pet_visit card` | 桌宠名片（皮肤 basic、习惯、能帮忙），不含原始记录 |
| `pet_meeting` | 会议 `meet_2834f57a`，3 角色 × 2 轮真发言 → 决议 → 落 3 条任务 |
| `deck_room create` | 明确拒绝并给出两条出路（未配 relay），不假装成功 |

## 3. 落盘核对（不靠工具自述）

`C:\Users\王冕\.dsh\agentdeck-super\state.json`（10,974 → 之后含会议任务）：

```
顶层键：version, seq, teams, tasks, events
teams.team_cd84498aa8.name = 本地验收-老板亲检
tasks.team_cd84498aa8 = task_31e86ea313, task_37e6d7c78e, task_c3ef207c78, task_50b1985312（4 条）
events.team_cd84498aa8 = seq 27..30 起（team/create → host team_create → task/add → host task_add）
```

## 4. 同一份代码的回归

`node --test --test-concurrency=1 "tests/*.test.mjs"` → **tests 281 / pass 281 / fail 0**（14.7s）。

## 5. 现场存在的缺口（如实记录）

1. **跨机房间**：本机未配 `cloud.relayUrl`，工具如实报「连不出去」并给自建 relay 的步骤；两主机版能力由 `tests/room-two-hosts.test.mjs` 覆盖，未在本机 GUI 现场演示。
2. **付费皮肤**：未解锁状态如实显示「此皮肤需授权 ¥18」，不静默降级。
3. **公开仓库**：已按用户要求把 GitHub 仓库改为 private，公开发布等用户本地验收通过后再开。

## 6. 人眼可看的产物

- `C:\Users\王冕\Desktop\agentdeck-验收\1-本机实时状态.html`（读真实文件生成的实时看板）
- `C:\Users\王冕\Desktop\agentdeck-验收\2-验收清单.md`
- `C:\Users\王冕\Desktop\agentdeck-验收\3-桌宠会议纪要.md`
