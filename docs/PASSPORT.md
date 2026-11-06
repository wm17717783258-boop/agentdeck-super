# Agent 通行证 v1（能力卡）· 用法与边界

> 一句话：**给每个 Agent（或每个人）发一张离线能力卡，对面机器不联网、不共享密钥目录也能验出「卡没被改过、签发方还是同一把密钥」。**
>
> 工具名：`agent_passport`（1.8.0 加入；1.10.0 起共 21 个工具，编号不再写死，免得每次加工具都要回来改）。实现：`lib/identity.js` + `lib/tools/identity.js`。
> 真机证据：`docs/evidence/passport-1.8.0.txt`（10 项，跨两个独立 `DSH_HOME`）；单测：`tests/identity.test.mjs`（11 例）。

---

## 1. 一分钟上手

```powershell
# A 机器：给某个 agent 签一张卡（第一次会自动生成机级密钥）
nexi call agent_passport '{"action":"issue","name":"小犀","agent":"claude","capabilities":["team_board","deck_meeting"],"ttlDays":30}'

# 把返回的 NEXP1.… 整串复制给 B 机器，B 机器上直接验（不需要任何密钥、不需要网络）
nexi call agent_passport '{"action":"verify","card":"NEXP1.…"}'

# 想确认"还是那台机器签的"：把第一次看到的 kid 一起带上
nexi call agent_passport '{"action":"verify","card":"NEXP1.…","kid":"kid_oNTQtHB95etb_aSW"}'

# 要求这张卡必须声明过某个能力
nexi call agent_passport '{"action":"verify","card":"NEXP1.…","required":["deck_meeting"]}'

# 看本机签过哪些卡（账本）、吊销一张（只标本地账本）
nexi call agent_passport '{"action":"list"}'
nexi call agent_passport '{"action":"revoke","kid":"kid_oNTQtHB95etb_aSW"}'
```

> PowerShell 里传 JSON 用**单引号包住**整串，否则 `"` 会被吃掉（`nexi call` 会报「参数不是合法 JSON」）。

在宿主里（Claude Code / Codex / Cursor / DSH …）就是让模型调同名工具，参数一模一样。远程 MCP 也一样：`POST /adbp/v1/mcp` 的 `tools/call`。

---

## 2. 卡长什么样

```
NEXP1.<base64url(payload)>.<base64url(signature)>
```

- `NEXP1` 是前缀兼版本位；两段 base64url（无 `=` 填充），靠 `.` 切分。典型长度 450–600 字符。
- `signature` = Ed25519 对「规范化 payload」的签名；**公钥本身装在 payload 里**，这就是"没网也能验"的原因。
- payload 字段（顺序即规范化顺序）：

| 字段 | 含义 |
| --- | --- |
| `v` | 卡格式版本，当前 `1` |
| `kid` | 签发方密钥指纹 = `kid_` + base64url(sha256(SPKI DER)) 前 16 位；同一把私钥永远是同一个 `kid` |
| `name` / `agent` | 这张卡发给谁、给哪个 agent 用（自由文本，`name` 截断到 80 字符、`agent`/`host` 各 60） |
| `host` | 签发主机名（自由文本，60 字符） |
| `capabilities` | 声明能做什么，最多 32 条；验卡时可要求其中若干条必须存在 |
| `tier` / `seats` | 可选：授权档位与席位数（便于对面判断"这人有没有付费"） |
| `iat` / `exp` | 签发时间 / 过期时间（Unix 秒）；`ttlDays` 缺省或给 0 时按 30 天，给了就夹到 1–365 天 |
| `nonce` | 可选随机串，防两张卡字节完全相同 |
| `pub` | Ed25519 公钥（SPKI PEM，base64），随卡走 |

**卡里永远没有私钥。** 私钥只存在签发那台机器的机级目录里：

```
<licenseRoot>/.agentdeck/identity/key.pem     # PKCS8 PEM，权限 0o600，原子写
<licenseRoot>/.agentdeck/identity/pub.txt     # 公钥指纹，便于人眼核对
<licenseRoot>/.agentdeck/identity/passports.json  # 本机账本（最多 50 张）
```

> `<licenseRoot>` 默认是 `$DSH_HOME/agentdeck-super`，可用 `NEXI_LICENSE_ROOT` 覆盖。**它跟着"人"走，不跟着项目走**——换项目、换工作区，你的身份还是同一个 `kid`。

---

## 3. 验卡会返回什么

成功：

```
【agent_passport】通过：卡没被改过，签名与 kid 对得上
```

失败给出**机器可读的 code**，人话在前、码在后：

| code | 什么情况 | 对面该怎么做 |
| --- | --- | --- |
| `empty` / `format` | 空串、段数不对、base64 坏 | 让对方重发 |
| `payload` | JSON 坏、字段缺失或类型不对 | 让对方重发（不带病解析） |
| `version` | `v` 不是认识的版本 | 升级插件 |
| `kid_mismatch` | 你钉的 `kid` 与实际签发者不符 | **当心**：这是一张别人签的卡 |
| `bad_signature` | 改过一个字节，或不是这把密钥签的 | 拒绝 |
| `expired` / `not_yet` | 过了 `exp` / 时钟还没到 `iat`（容忍 30 秒偏移） | 让对方续签 |
| `missing_capability` | 卡里没声明你要求的能力 | 让对方补签 |
| `internal` | 极端情况兜底 | 报 issue，别当"通过" |

**永远不要吞掉 code。** 把 `code` 和 `kid` 一起记进日志，才有追溯力。

---

## 4. 只读模式（把 Hub 借给别人时）

`mcp.readOnly = true`（或 `nexi mcp --read-only`、`NEXI_MCP_READONLY=1`）时：

- `agent_passport` **仍在工具清单里**（1.10.0 起共 21 个工具，只读模式广告 17 个），但只允许 `show` / `verify` / `list`；
- `issue` / `revoke` 直接 `isError`，文案点名开关：`错误：只读模式（mcp.readOnly=true）：agent_passport action=issue 会改状态，…`；
- 也就是说：**借出去的 Hub 能验卡，但造不出卡，也删不掉卡。**

理由跟整个只读模式一致：默认拒绝、按动作粒度、被禁的能力干脆不出现在 `tools/list` 里（而不是"广告了再拒"）。

---

## 5. 它证明什么、不证明什么（写清楚，别吹）

**证明：**

1. 这张卡的字节没被改过（改了签名就对不上）；
2. 签发它的是持有对应私钥的那台机器；
3. 它还在有效期内（`exp` 未到）；
4. 卡里声明的能力确实由签发方声明过；
5. 用 `kid` 钉住之后，**这次的签发方和上次是同一把密钥**（密钥连续性）。

**不证明：**

1. **不证明"屏幕前是谁"**——没有实名、没有 CA，名字是签发方自己填的；
2. **没有在线吊销中心**——`revoke` 只标你这台机器的账本，卡在别人机器上照样验得过（`passport-1.8.0.txt` 第 ⑩ 项就是这条的实测）；
3. **不防"自签"**——任何人都能生成自己的密钥并签一张看起来合法的卡，裸验（不给 `kid`）会通过。这不是 bug，是离线凭证的固有性质；要防就得**在第二次见面时比对 `kid`**（这也是我们建议的用法）。
4. 不替代授权码：**通行证不授予任何付费能力**，付费能力仍由 `ADSK1.…` 授权码决定。

---

## 6. 密钥与隐私红线（运维必读）

- **私钥永不外带**：不进仓库、不进日志、不进证据文件、不回显在控制台。签卡只输出卡本身。
- **换机器就等于换身份**：`kid` 变了，对面钉了旧 `kid` 的会 `kid_mismatch`——这是预期行为，别"修"它。
- **`show` 不会偷偷造密钥**：本机没有身份时它明确回「本机还没有身份密钥（第一次签发通行证时才会生成）」，盘上不留任何文件（单测锁死）。
- **账本上限 50 张**，超出淘汰最旧的；账本坏了读成空账本（不崩，也不假装有卡）。
- 卡是可分享的公开凭证（公钥在里面），**但它带着对方的名字与能力声明**——别随手发到公开群。

---

## 7. 下一步（还没做，别当成已有）

- 卡里带运行指标（最近失败率 / 平均耗时 / 花钱上限）；
- `/deck` 上的「我的卡包」面板（现在只有 CLI / MCP）；
- 在线吊销与公钥目录（需要服务端，属 M5 之后）；
- 与中继房间打通：入座时自动出示能力卡（现在是纯离线凭证）。
