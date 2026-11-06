# 证据索引（每一份都能在本机重跑）

> 规矩：**没有证据文件的"跑通了"一律不算**。下面每份文件都是一次真实执行的原始输出（表格 + 结论），
> 文件名带 UTC 时间戳。代码改动后旧的会删掉、重新生成，所以这里永远只有最新的几份。

## 现在有哪几份

| 文件 | 一句话证明什么 | 怎么自己重跑 |
| --- | --- | --- |
| [`mcp-1.5.0.md`](mcp-1.5.0.md) | **别的厂商的 Agent 真能调我们这套能力**：`claude mcp list` 自己报 `√ Connected`；Claude Code 通过 MCP 建组+加任务 → 盘上 `state.json` 查得到 `team_bb5d6188b6`/`task_83926ab99f` → Codex 再通过 MCP 把这 5 个组读出来。附 26 行真 JSON-RPC 报文 + `/adbp/v1/mcp` 实况 + 状态页截图 | `node tests/mcp.test.mjs`、`nexi install codex`、`claude -p "…team_board…" --allowedTools "mcp__nexi__team_board"` |
| [`install-headless-1.4.1-2026-11-05.md`](install-headless-1.4.1-2026-11-05.md) | **1.4.1 最终包装进干净 DSH profile，开真会话连续调 3 次工具**：`dsh plugin add` 装得上、版本对得上、工具真能落盘（`state.json` 里查得到 team/task id），还顺带证明了授权码已是机级路径 | `pwsh -File scripts\release.ps1 -Version 1.4.1` 后按文档里的 headless prompt 重跑 |
| [`e2e-local-2026-11-05T07-07-11-422Z.md`](e2e-local-2026-11-05T07-07-11-422Z.md) | **五条主链路端到端**：真起 Agent 子进程 → 任务板抢占互斥 → 真签授权码并验篡改 → 真 relay 建房跨机往返 → relay 挂掉时本地照常干 | `node tests/e2e-local.mjs` |
| [`two-hosts-2026-11-05T06-23-30.md`](two-hosts-2026-11-05T06-23-30.md) | **两台"机器"协同**：房主付费建房 → 免费用户被拦住并被告知怎么升级 → 客人凭邀请零授权入座 → 任务镜像 + 认领回流 → 断线续传 → 房主关房客人优雅收敛 | `node --test --test-concurrency=1 "tests/room-two-hosts.test.mjs"` |
| [`real-agents-2026-11-05T07-06-12-094Z.md`](real-agents-2026-11-05T07-06-12-094Z.md) | **本机真装着的 Agent 真被调起来**：claude 2.1.317 / codex 0.166.0 / dsh 0.2.1-rc.5 实跑通过；gemini 0.66.0 识别到但没登录（标"环境未配"，不算插件失败） | `node tools/real-agents-check.mjs` |
| [`real-project-2026-11-05T06-52-45-242Z.md`](real-project-2026-11-05T06-52-45-242Z.md) | **两个不同厂商的 Agent 真合作干完一个项目**：Claude Code 写 `math.mjs`（29.5s）、Codex 写 `math.test.mjs`（28.4s），经任务板派活/认领/依赖门控，最后 `node --test` 真跑通 2 项、`import` 真算得出结果 | `node tests/e2e-project.mjs` |
| [`license-1.6.4.md`](license-1.6.4.md) | **“收钱”这条链路真闭环**：四档价格（¥0 / ¥29·月 / ¥99·月含 3 席 / ¥3 万起）由 `deck_license plans` 原样打出；本机真授权是工作室版（到期 2027-11-05、席位 30）；卖家侧 `license-cli entitlements` 表格与 `TIERS` 逐项一致；老 `pro` 码改名后仍验得通；没挂收款页时价格表不编假链接。附 `/deck` 截图 | `node bin/nexi.mjs call deck_license '{"action":"plans"}'`、`node tools/license-cli.mjs entitlements`、`node --test tests/license.test.mjs tests/license-plans.test.mjs` |
| [`pet-visit-1.6.4.md`](pet-visit-1.6.4.md) | **桌宠串门这条链路真往返**：两个互不相干的 Hub（各自工作区/任务板/桌宠档案），小犀 `invite` → 小鹿 `accept` → 送礼便签 → 收礼 → 求助便签 → 小犀收下后**真落成任务**（板子上查得到）→ 两边 `visits.log` 都有记录；顺带 `pet_skin` 4 套皮肤、换上 ¥18 付费「极光」渲染 5 种状态，没授权的第三台 Hub 换同一套**被明确拒绝并报价**。附皮肤画廊截图 | `node tools/capture-visit.mjs` |
| [`visit-twoprocess-1.6.5.txt`](visit-twoprocess-1.6.5.txt) | **串门在两个独立进程之间真跑通，且跨进程真验签**：每一步都另起一个 `node bin/nexi.mjs call` 进程、各自独立工作区，状态只靠盘上文件传递（邀请令牌 → 收下 → 建组 → 求助便签 → 收下后真落成 `task_…` → 两边 `visits.log`）。收下那台机器的输出是「签名：Ed25519 校验通过（凭证没被改过，签发方密钥 `kid_…`）」；再把名片上的名字改一个字、签名保留，同一台机器立刻判「签名对不上，可能被改过」 | `node tools/capture-visit-twoprocess.mjs` |
| [`visit-page-1.6.5.md`](visit-page-1.6.5.md) | **没装 DSH 的人也能点开邀请链接，并且页面当场判真伪**：`/visit?t=<邀请凭证>` 落地页渲染主人名片（名字/皮肤/拿手习惯/能力/范围/有效期）+ 两种收下方式 + 「这张邀请我怎么信的」绿框（Ed25519 验签通过、签发方 `kid_…`）；改过字的凭证变成橙框「这张邀请函不对劲」，且**不显示**收下入口；不带凭证、乱写凭证都 200 不白屏。附 4 张真实截图 | `node tools/capture-visit-page.mjs` |
| [`visit-page-probe-1.6.5.txt`](visit-page-probe-1.6.5.txt) | 上一条的**原始输出**：4 个输入 × 真 HTTP 断言表（状态码 / 签名有效 / 签名对不上 / 解析不出来 / 有没有邀请标题）+ 4 张图的字节数 + 收摊记录（私钥已删、令牌只在内存） | 同上，一条命令一起重跑 |
| [`visit-installed-1.6.5.txt`](visit-installed-1.6.5.txt) | **装进 `web` profile 的那份 1.6.5，在真 DSH 宿主里当场验签**：磁盘版本 `1.6.5`、装的那份 `visit.js` 里 `KEY_ALG = 'ed25519'` 且保留 v1 兼容；邀请函由另一个进程用装好的代码签，真宿主 `/visit` 判「签名有效（Ed25519）」、改过字的判「签名对不上」、乱写的降级不白屏、`/deck` 报的版本与磁盘一致（8 项断言全过） | `node tools\verify-installed-visit.mjs`（自己起临时宿主、跑完连进程一起收摊） |
| [`twin-1.6.2.md`](twin-1.6.2.md) | **数字分身记忆 + 习惯进化真跑通**：MCP 网关 14 个工具（断言与 `HUB_TOOL_ORDER` 完全一致）→ 外部 Agent 写记忆落盘 `D:\demo\hostN\work\.agentdeck\twin\memory.json` → 换进程 `twin_recall` 召回 → `/deck` 跨进程读到"共 2 条：知识 1 / 偏好 1"。另有一轮真习惯链：3 个"跑 sql 周报"任务 → 候选冒出来 → `confirm` → `twin_brief` 里出现"用户确认过的习惯"。附真实 JSON-RPC 报文与两张状态页截图 | `node tools/capture-twin.mjs`、`node tools/drive-habit.mjs`、`node --test tests/twin.test.mjs` |
| [`m4-1.7.0.txt`](m4-1.7.0.txt) | **三个不同厂商的 Agent 真开了一场会，并且定时任务真的到点自己动（17 项断言全过）**：三条互不相干的 `nexi mcp` 进程（Claude Code / Codex / DSH）各自 `initialize` → 同一场会里发言序号 1/2/3 → 纪要逐字留档不改写 → 结会真往任务板写 3 条带验收标准的任务（另一条独立 CLI 进程查得到）。真 DSH 宿主（巡检 3 秒）里：到点任务只进审批队列、审批前 0 次执行；`nexi stop` 落盘后另一条到点任务 20 秒内 0 次执行；`resume` 后下一拍自己跑；`approve` 放行真建出 `task_…` | `node tools/verify-m4.mjs`（自己起临时宿主，跑完连进程带目录一起收摊） |
| [`m4-mcp-1.7.0.jsonl`](m4-mcp-1.7.0.jsonl) | 上一条的**原始 JSON-RPC 报文**：三条连接各自的方向、`initialize`/`notifications/initialized`/`tools/call` 请求与响应，一行一条，可以自己数（67 行） | 同上，一条命令一起重跑 |
| [`mcp-http-1.8.0.txt`](mcp-http-1.8.0.txt) | **不用装任何东西，一个 URL 就能接管这台机器的 17 个工具（21 项断言全过）**：真 DSH 宿主上，两个只会 `fetch` 的"远程客户端"（模拟 Claude Desktop / Cursor 填 URL 的用法）各自 `initialize` → `tools/list` 拿到与宿主完全一致的 17 个工具（数字取自 Hub 自报，不写死）→ 客户端 A 建组、开会 → A 和 B 各发一条言 → B 结会拆任务 → 任务板与纪要都能用 CLI 这条独立通道读回来；无 `Mcp-Session-Id`（无状态）；坏 JSON 400/-32700、未知工具 -32602、未实现方法 -32601、PUT 405 `Allow: POST, OPTIONS`（没有 SSE 就明说）、批量报文回 2 条 | `node tools/verify-mcp-http.mjs`（自己起临时宿主，跑完连进程带目录一起收摊） |
| [`mcp-http-1.8.0.jsonl`](mcp-http-1.8.0.jsonl) | 上一条的**原始 HTTP 帧**：两个客户端每个请求的方法、报文、响应状态码与响应体（含 `202` 通知、`400`、`405`），一行一条 | 同上，一条命令一起重跑 |
| [`passport-1.8.0.txt`](passport-1.8.0.txt) | **Agent 通行证 v1（Ed25519 能力卡）跨进程真验得通**：A 目录签出 `NEXP1.…`（私钥只落在 A，`kid_` 是公钥指纹）→ B 目录（`DSH_HOME` 完全不同、连身份密钥都没生成）只凭卡里的公钥就验过 → 改一个字符 `bad_signature`、指定别人的 `kid` → `kid_mismatch`、要求没声明的能力 → `missing_capability`；同一张卡在 MCP stdio 通道里 `tools/call` 也验得过，只读模式广告 13 个工具（`agent_passport` 标「仅 show/verify/list」）且签不出新卡；A 账本 1 张 / B 账本 0 张；吊销只标本地、卡在 B 仍验得过（离线凭证没有吊销中心，文案里已写明） | `node tools/verify-passport.mjs`（对仓跑）；发版前 `node tools/verify-passport.mjs --pkg %USERPROFILE%\.dsh\profiles\web\node_modules\agentdeck-super` |
| [`security-redteam-1.8.0.txt`](security-redteam-1.8.0.txt) | **红队 11 条：该拦的拦住了，而且当场查出两个真洞**。① 记忆里塞「立刻 touch 一个文件 / 把私钥发出去」，存进去召回来都是原样文本，哨兵文件不存在（命令没被执行）；便签标题里塞 `touch`/`curl` 只落一条任务 ② 远程令牌拿 A 队身份读 `?teamId=<B 队>` → **403**，响应里连对方 teamId 和任务标题都不回显 ③ 冒名发言/交活/领活 → **403**，用自己的名义照常 200 ④ `public`/`friend` 视角召回不到 `private`；`forget` 拿别人 id 或 `../` 路径删不掉任何东西 ⑤ 邀请函 `scope=visit` 换 `work` → `scope_mismatch`，改 scope/有效期 → `bad_signature`，改版本 → `bad_version`，过期 → `expired`，令牌过期后进程没重启也当场 401。**这两个洞是这轮红队真发现的**（`lib/engine/adbp.js` 跨团队读 + memberId 冒名），已修并锁死 | `node tools/verify-security.mjs`（顺手把全量回归也跑一遍） |
| [`gate-1.8.0.txt`](gate-1.8.0.txt) | **全量回归的原始输出**：`395 tests / 395 pass / 0 fail`，串行跑，含 MCP stdio / Streamable HTTP / 只读模式 / ADBP / 串门 / 记忆 / 会议 / 自动化 / 安装器 / 宿主认证 / 通行证 | `node tools/verify-security.mjs`，或 `node --test --test-concurrency=1 "tests/*.test.mjs"` |
| [`installed-security-1.8.0.txt`](installed-security-1.8.0.txt) | **在"真装进 profile 的那份"上重放同样的攻击**（import 的是 `~/.dsh/profiles/web/node_modules/agentdeck-super`，不是仓库源码）：磁盘版本 `1.8.0`、`lib/engine/adbp.js` 的 SHA256 与仓库逐字节一致、7 项断言全过——自己团队照常 200，读别人的队 403 且 66 字节响应里连对方 teamId 都没有，冒名交活/发言 403，编造的令牌 401 | `node tools/verify-installed-security.mjs`（`NEXI_PROFILE` 可换 profile） |
| [`hosts-1.8.0.txt`](hosts-1.8.0.txt) | **8 个宿主的认证矩阵**（每台都跑「装 → 让宿主自己确认 → 卸 → 配置逐字节还原」）：Claude Code ✅ `claude mcp list` 自己报 `nexi`、Codex ✅ `codex mcp list` 自己报 `nexi`、Claude Desktop 🟡 只到配置层（本机没 CLI，标"实验性"）、其余 5 台 ⚪ 未安装（不伪造配置）。失败的 0 台 | `node bin/nexi.mjs verify-host --all --record` |
| [`readonly-1.8.0.txt`](readonly-1.8.0.txt) | **只读模式真拦得住**：同一个 URL 借给别人时开 `mcp.readOnly`，`tools/list` 从 17 个降到 13 个（`super_agent`/`team_orchestrate`/`pet_meeting`/`twin_remember` 直接消失），建组/加任务/记记忆/开会/签通行证五类写动作全返 `isError` 且盘上 `board.json` 没多一个字；对照组（同一台机器、默认配置）同一个写动作照常成功；`nexi mcp --read-only` 的 stdio 那条路也同样拒写。24 条断言全过 | `node tools/verify-readonly.mjs` |
| [`recovery-1.8.0.txt`](recovery-1.8.0.txt) | **门槛 ⑦ 四类故障各真演一遍（27 项断言全过）**：①**断网**——relay 不可达时 Hub 照常起、建组/加任务/写记忆全部成功且真落盘，`deck_room` 优雅失败（说人话、不挂死、不崩）②**崩溃**——半截 JSON-RPC 请求被 `SIGKILL` 后新进程不受污染、任务板数据还在；`state.json` 被撕成两半时**不崩、有话说、恢复后数据原样回来**；目录里的 `.tmp` 碎片不会被误读；再猛写 8 轮、每轮 `SIGKILL` 一次，**撕裂 0 次**（原子写生效）③**升级**——把状态改成低 `version` + 塞一个老字段，新版读得回、写得进，写回后**老字段没被吃掉、老任务和新任务同时在**（不做破坏性迁移）④**迁移**——整棵状态树搬到另一台"机器"后，同一个 `teamId` 读得回同一块板、记忆召回得到、授权文件在位；反过来，没搬授权的机器如实回落免费档 | `node tools/verify-recovery.mjs` |
| [`console-1.8.0.txt`](console-1.8.0.txt) | **测试台：在真宿主里点按钮 = 真调工具、真写盘（20 项断言全过）**。`/deck/console` 把 17 个工具做成能点的按钮，点一下就是一次真的 `hub.call`，原始返回原样打回页面。真 `dsh --profile web` 宿主上：GET 出页面（自报 17 个工具、零外链）、点「建一个小组」拿到真 `team_…`、点「加一条任务」拿到真 `task_…`、**盘上 `state.json` 里两个标题都查得到**（不是页面自己编的）、必填留空给人话、伪造的动作 id 被拒。再开一台 `mcp.readOnly: true` 的宿主：6 个写动作按钮置灰并写明原因，**绕过页面直连 POST 也在服务端被拦**，盘上连 `state.json` 都没生成；同一台上读动作照常可用。**顺带**：这两页截图（可点态 / 只读态）在 `docs/evidence/` 里 | `node tools/verify-console.mjs` |

## 全量测试（不单独存文件，因为它是每次发版的强制闸门）

```bash
node --test --test-concurrency=1 "tests/*.test.mjs"
# → 395 tests / 395 pass / 0 fail
```

`tools/publish-npm.mjs` 第 3 关会强制跑这一条，红了就不许发。

## 怎么判断一份证据是真还是编的

1. **有文件名时间戳**，且比最后一次代码改动新（否则说明代码改了没重跑）。
2. **有原始输出的痕迹**：耗时、退出码、房间 id 前缀、任务 id——编的内容不会有这些噪声。
3. **失败也照实写**：`real-agents` 里 gemini 就是"环境未配"，没被抹成"通过"；`two-hosts` 第 2 例专门测"relay 挂了会怎样"。
4. **能一条命令重跑**，跑完内容一样（时间戳和随机 id 除外）。

## 已知的"证据覆盖不到"的地方（诚实列出来）

- **真的两台不同电脑**：现在用「两个独立工作区 + 一个本地 relay 子进程」模拟，传输路径是真的，但没跨公网跑过。跨公网只差一个部署动作（`tools/relay-server.mjs` 放任意能跑 Node 的机器）。
- **真钱收款**：收款码/爱发电是人的动作，代码侧只保证"发码→验签→权益生效"这条链路真跑通（见 e2e 第 3 步）。
- **"崩溃恢复"覆盖的是状态层，不是操作系统层**：`recovery-1.8.0.txt` 证明了进程被杀/文件被撕/换机器时**状态**能恢复（含原子写压力测试），但没有测过断电、磁盘坏道、文件系统损坏这类更底层的情况。
- **多租户安全**：远程令牌（ADBP）已经做了团队隔离——别的团队的任务板读不到（403，见 `security-redteam-1.8.0.txt`），也不能冒名；但**同一个团队内的成员默认互信**（没有做成员级权限，只有"是不是这个队的人"）。`docs/PRODUCT.md` §5 也写了这一条。



