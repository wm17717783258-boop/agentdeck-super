# 授权与定价链路实测（1.6.4 · 2026-11-05）

> 这份证据回答一个问题：**"收钱"这件事在代码里到底是不是真的闭环了。**
> 结论：价格表、权益表、发码、验签、生效、老码兼容、状态页展示，全部有真输出；唯一没做的是"在线收款页"（人的动作，见文末）。

原始输出：[`license-1.6.4.txt`](license-1.6.4.txt)｜状态页截图：[`license-deck-1.6.4.png`](license-deck-1.6.4.png)

## 一、四档价格（用户问"多少钱"时它自己答得出来）

```
【deck_license】四档价格
1. 免费版 — ¥0
   单机全功能：超级 Agent、任务板、异构接入、桌宠 3 套皮肤
2. 协作版 — ¥29/月（年付 ¥288）
   云房间 1 个、跨机席位 8 个、并行 3、自动执行、桌宠会议 3 轮
3. 工作室版 — ¥99/月（年付 ¥999，含 3 席，加席 ¥20/席·月）
   云房间 5 个、席位 30、并行 6、付费皮肤全解锁、审计导出
4. 企业版 — ¥30000 起/年（私有化部署，含 10 席）
   云房间 50 个、席位 200、并行 10、私有部署、专属支持
```

## 二、卖家侧：一张表就是"能收多少钱"的唯一真源

`node tools/license-cli.mjs entitlements` 打印代码里真正生效的权益（不是文档抄的）：

| 档位 | 价格 | 本地房间 | 云房间 | 席位 | 并行 | 会议轮 | 付费皮肤 | 跨机邀请 | 自动执行 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 免费版 | ¥0 | 1 | 0 | 3 | 1 | 1 | — | — | — |
| 协作版 | ¥29/月（年 ¥288） | 5 | 1 | 8 | 3 | 3 | — | ✓ | ✓ |
| 工作室版 | ¥99/月（年 ¥999，含 3 席） | 50 | 5 | 30 | 6 | 5 | ✓ | ✓ | ✓ |
| 企业版 | ¥30000 起/年 | 999 | 50 | 200 | 10 | 5 | ✓ | ✓ | ✓ |

改价只改 `lib/license.js` 的 `TIERS` 一处：价格表（`PRICE_TABLE`）、发码 CLI、`deck_license plans`、relay 建房校验全从它读，不会出现"文档写 ¥99、代码按 ¥199 卖"。

## 三、本机授权真的在生效（不是演示开关）

```
【deck_license】当前档位：工作室版
授权状态：有效（授权给 <买家>）
到期：2027-11-05
席位上限：30
权益：工作室版：本地房间 50、云房间 5、席位 30、并行 6、可邀请跨机、付费皮肤全解锁
授权文件：C:\Users\<用户>\.dsh\agentdeck-super\.agentdeck\license\key.txt（跟人走：换项目目录不用重新激活）
```

`/deck` 状态页首屏同一份信息（见截图）：`工作室版（到期 2027-11-05）· 席位 30 · 云房间 0/5`，房间区显示"云房间 0/5"就是权益表算出来的配额，不是写死的文案。

## 四、老授权码不会因为改档名失效

历史码里写的是 `pro`（协作版旧 id）。这次改名没有作废任何已售出的码：

- `TIERS.pro` 是 `TIERS.plus` 的**不可枚举只读别名** → `Object.keys(TIERS)` 仍是 `free/plus/studio/business`，价格表不多一档；
- 单测 `tests/license.test.mjs`「老档位 pro 只升不降」真签发一张 `tier=pro, seats=8` 的码，`verifyLicense` 返回 `ok:true / tier:pro / 席位 8`；
- 新增 `tests/license-plans.test.mjs` 4 项：四档全在且顺序与 `PRICE_TABLE` 一致、没配收款页时**不许出现任何网址**、配了 `purchaseUrl` 才给链接、¥99/¥999/加席价/企业版"起"逐字对。

## 五、还差的一步（不吹）

**在线收款页没挂**：现在买家付钱后由卖家跑一条命令发码（`tools/license-cli.mjs issue --tier plus --to 张三 --days 365`），买家粘进 `/deck` 即生效。要做成"点开就付"，需要接一个收款渠道（爱发电 / Gumroad / 微信商户），那是 M5 的活；代码侧已经留好 `purchaseUrl` 配置位，填上真链接后价格表自动改成"打开链接付款"，没填时它明说"还没挂在线收款页"——**不许编一个假域名让用户去点**。

## 怎么自己重跑

```powershell
cd D:\agentdeck-super
node bin\nexi.mjs call deck_license '{"action":"plans"}'
node bin\nexi.mjs call deck_license '{"action":"status"}'
node tools\license-cli.mjs entitlements
node --test --test-concurrency=1 tests\license.test.mjs tests\license-plans.test.mjs
```
