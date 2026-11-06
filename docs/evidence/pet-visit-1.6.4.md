# 证据：桌宠串门 + 付费皮肤 + 授权拦截（1.6.4 实录）

- 时间：2026-11-05（Asia/Shanghai）
- 版本：`agentdeck-super@1.6.4`
- 一键复现：`node tools/capture-visit.mjs`（脚本自己清空 `D:\demo\visit`，可反复跑）
- 逐字原始输出：[pet-visit-1.6.4.txt](pet-visit-1.6.4.txt)
- 皮肤画廊：[pet-skins-1.6.4.html](pet-skins-1.6.4.html) / [pet-skins-1.6.4.png](pet-skins-1.6.4.png)

## 这一版证明了什么

起**两个互不相干的 Hub**（各有自己的工作区、任务板、桌宠档案、授权目录），只通过显式传递的邀请函 / 便签 JSON 通信，完整走一遍：

| 步骤 | 谁做 | 工具调用 | 真的发生了什么 |
| --- | --- | --- | --- |
| 1 | 小犀 | `pet_visit card` | 输出一张只有名字/皮肤/习惯/能力的名片，不含任何原始记录 |
| 2 | 小犀 | `team_board create` | 建出 `team_…`，后面求助便签要落到这个组 |
| 3 | 小犀 | `pet_visit invite scope=work ttlHours=24` | 拿到 `dsh://agentdeck/visit?t=…` 邀请链接（令牌已签名，24 小时有效） |
| 4 | 小鹿 | `pet_visit accept expectedScope=work` | 校验令牌版本 / 种类 / 有效期 / 范围；收下后落 `visits.log` |
| 5 | 小鹿 | `team_board create` | 客人本机也有组，收便签才有地方落 |
| 6 | 小犀 | `pet_visit gift skin=premium-aurora` | 生成一张礼物便签 JSON（含付费皮肤 id） |
| 7 | 小鹿 | `pet_visit receive` | 「收下了 小犀 的礼物，已记一条事件」 |
| 8 | 小鹿 | `pet_visit ask title=…` | 生成求助便签 JSON（标题/验收/角色） |
| 9 | 小犀 | `pet_visit receive` | **求助真的落成任务** `task_…`（队 `team_…`） |
| 10 | 小犀 | `team_board list` | 板子上真多出这一条，验收标准原样带着 |
| 11 | 双方 | `pet_visit log` | 两边各自的 `visits.log` 都记到了 invite / note-out / note-in |
| 12 | 小犀 | `pet_skin list/activate/states/render` | 4 套皮肤（含 ¥18 付费「极光」），换上后 5 种状态各渲染出真 SVG |
| 13 | 小白（无授权） | `pet_skin activate premium-aurora` | **被明确拒绝**：「这个皮肤需要授权：¥18（需要 studio 档或单独购买）」，不偷偷降级成免费皮肤 |

## 诚实边界

- 两个 Hub 跑在**同一台机器**上，是「两个用户各自独立的工作区」而不是两台物理机；跨机链路另见 [crosshost-1.4.5.md](crosshost-1.4.5.md)（relay 房间 + 任务双向落地）。
- 邀请函是**主机自己的密钥签名**的。**（1.6.5 补记）** 这份证据是 1.6.4 跑的，那时是 HMAC，客人那台机器没有主机密钥，只能做「格式 / 有效期 / 范围」校验，输出里如实写「签名：跨机器的邀请只能在本地做格式校验」——**没有**假装验签通过。1.6.5 起改成 Ed25519 且公钥随邀请函走，客人侧已经能真验签，见 [visit-twoprocess-1.6.5.txt](visit-twoprocess-1.6.5.txt) 与 [visit-page-1.6.5.md](visit-page-1.6.5.md)；本文件原样保留，不做后补。
- 邀请令牌与便签里的令牌**不写进证据**：文本里替换成 `<邀请令牌已脱敏，长度 N>`，只留长度。
- 皮肤 SVG 是 `pet_skin render` 直接吐出来的字符串，画廊只是把它们并排贴出来，没有二次加工。
- 付费皮肤的解锁判断读的是**本机授权文件**（`licenseRoot/.agentdeck/license/key.txt`）；第 13 步那台 Hub 故意不给授权文件，所以拿到的是免费版。
