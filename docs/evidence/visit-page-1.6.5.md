# 串门落地页 `/visit`（1.6.4 起，1.6.5 补齐跨机器验签）

一句话：**把邀请链接发给一个没装 DSH 的人，他也能点开看到「谁邀请我、能干什么、什么时候过期」，
而且页面能当场判断这张邀请函有没有被人改过。**

之前的邀请函只有 `dsh://agentdeck/visit?t=…` 深链，没装 DSH 的人点开是一片空白——
1.6.4 补上了那个缺口；1.6.5 把「跨机器验签」也补上了（Ed25519，公钥随邀请函走）。

## 这一页长什么样

![串门落地页](visit-page-1.6.5.png)

页面里出现的每一项都来自邀请函里的名片（主人自己放行的那部分）：

| 页面上的字 | 从哪来的 |
| --- | --- |
| 小犀 邀请你去串门 | `profile.name` |
| 皮肤 basic | `profile.skins.active` |
| 拿手习惯：每周写 SQL 周报、改完代码先让人 review | `profile.habits` 按 confidence 排序取前 3 |
| 能帮忙 | `profile.traits.capabilities`；没申报时如实写「同上（还没单独申报能力）」 |
| 范围：可以给我派活 | 邀请函的 `scope=work`（`visit` 时写「只串门，不派活」） |
| 有效期 | 邀请函的 `exp`，本地时间显示 |
| 怎么收下 | 给两种人两条路：装了 DSH 的给深链；没装的给一句可直接贴给 Agent 的 `pet_visit accept url=…` |
| 签名有效（Ed25519）…签发方密钥 `kid_…` | 落地页自己用邀请函里带的公钥验签 |

## 四种输入都验过

| 输入 | 结果 | 截图 |
| --- | --- | --- |
| `?t=<真邀请函>` | 200，绿框「签名有效（Ed25519）…签发方密钥 `kid_…`」 | [visit-page-1.6.5.png](visit-page-1.6.5.png) |
| `?t=<改过一个字的邀请函>` | 200，橙框「这张邀请函不对劲 / 签名对不上」，**不显示**「邀请你去串门」 | [visit-page-tampered-1.6.5.png](visit-page-tampered-1.6.5.png) |
| 不带 `?t=` | 200，人话提示「链接里没带凭证」 | [visit-page-no-token-1.6.5.png](visit-page-no-token-1.6.5.png) |
| `?t=obviously-not-a-real-token` | 200，不 500、不白屏 | [visit-page-bad-token-1.6.5.png](visit-page-bad-token-1.6.5.png) |

四种输入的 HTTP 断言（原件：[`visit-page-probe-1.6.5.txt`](visit-page-probe-1.6.5.txt)，2026-11-05 跑）：

| 输入 | 状态码 | 签名有效 | 签名对不上 | 解析不出来 | 「邀请你去串门」标题 |
| --- | --- | --- | --- | --- | --- |
| `good` | 200 | 有 | — | — | 有 |
| `tampered` | 200 | — | **有** | — | **—**（篡改件不显示邀请标题） |
| `noToken` | 200 | — | — | — | — |
| `badToken` | 200 | — | — | 有 | 有（名字回落到「一位朋友」） |

一条命令重跑这四张图 + 这份断言表：

```powershell
cd D:\agentdeck-super
node tools/capture-visit-page.mjs 57981
# → 写 docs/evidence/visit-page-{,-no-token-,-bad-token-,-tampered-}1.6.5.png
#   + docs/evidence/visit-page-probe-1.6.5.txt；跑完自己把演示目录和私钥删掉
```

只想手工看一眼也可以：`node tools/serve-visit-page.mjs 57971`（会打印 `READY {…url…}`），再拿浏览器打开。

截图用的是 Edge headless（`--headless=new --screenshot=…`），页面 **不发任何网络请求、不读任何外链 CDN**，
内联 CSS 一把梭，断网也能打开。

## 诚实边界

- **验签证明什么、不证明什么。** 1.6.5 起邀请函用 Ed25519 签，公钥写在邀请函里，
  所以**任何机器**都能验：通过 = 「这张名片自签发后一个字节都没被改过」+「是 `kid_xxx` 这把私钥签的」。
  它**不证明**这把私钥真的属于某个真人 / 某台机器——身份绑定（TOFU / 域名 / DID）**还没做**。
  页面原话：「至于这把密钥是不是真的属于「小犀」，得你自己知道这条链接是谁发给你的。」
  **绝不写成「验签通过 = 实名认证」。**
- **旧版（v1）跨机器邀请函仍然没有验签。** 1.6.4 及以前是 HMAC，密钥在签发方机器上，
  跨机器只能做格式 / 有效期 / 范围校验，页面会如实写「没有验签」并提示让对方用 1.6.5 重发一张。
  这种老令牌仍然读得下（向后兼容），只是不冒充验过。
- **篡改页面不显示收下入口。** 签名对不上时，「怎么收下 / 深链」整块**不渲染**，避免有人把改过的名片当真去收。
- **截图里那条 `dsh://` 深链是死的。** 它属于一个一次性演示主机（`127.0.0.1:57971`，截完即关）。
  截图之后演示目录连同签发私钥 `visit-key.json` 一起删了，那条令牌再也签不出、也验不过新东西。
  证据里的文本文件（`pet-visit-1.6.4.txt`、`visit-twoprocess-1.6.5.txt`）依旧把令牌整段脱敏，一个字符都不留。
- **名片只出不进。** 页面展示的是对方主动放行的那几个字段，原始会话、笔记正文、任务明细**不在这张名片里**，
  所以落地页也没有泄漏面——它只渲染邀请函自带的 payload，不碰本机任何状态。
- **落地页零副作用。** 渲染时调 `readInviteToken` 故意**不传 root**，所以点开这一页不会在客人机器上
  生成 `visit-key.json`；页脚也直接承诺「不发任何网络请求，不写任何东西到你的机器」。
- **不是注册页。** 它不写文件、不建账号、不登记「谁点过」。点开就是看一眼。

## 什么时候会用到

用户侧三句话：

1. 「我把桌宠的邀请链接发你了，点开看看」——对方没装也能看到小犀是谁。
2. 对方装了就点深链，`pet_visit accept` 收下，两边各留一条串门记录。
3. 收下之后还能互留便签：`pet_visit gift`（送礼）、`pet_visit ask`（求助，会落成对方任务板上的一条任务）。

## 相关文件

- 实现：`lib/index.js` → `handleVisitPage()`（路由注册在 `kind:'prefix', path:'/visit'`）
- 验签实现：`lib/pet/visit.js` → `makeInvite()` / `readInviteToken()`（`KEY_ALG='ed25519'`，密钥在 `.agentdeck/pet/visit-key.json`）
- 演示主机：`tools/serve-visit-page.mjs`（常驻，打印 `READY`）
- 一键复现（断言表 + 4 张图 + 收摊删私钥）：`tools/capture-visit-page.mjs`
- 用例：`tests/host.test.mjs` →「默认挂三个路由」「/visit 落地页：拿真邀请函渲染出主人名片；坏链接不 500」；
  `tests/pet-visit.test.mjs` →「跨机器的邀请：公钥在邀请函里，所以在客人机器上也能真验签」
  「v1 老邀请函仍然读得懂」「别人的公钥配别人签的体：验得过，但 kid 对不上——身份绑定不装作有」
