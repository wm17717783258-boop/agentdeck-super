# 收钱这件事：从今天就能收到，到接在线渠道

这份文档只讲一件事：**别人买你的皮肤，钱怎么到你账上**。

分两条路，按顺序看：

| 路线 | 需要什么 | 现在能不能用 |
|---|---|---|
| **人工收款** | 一个支付宝/微信/银行卡账号 | ✅ 现在就能用，不需要商户号、不需要公司主体 |
| **在线收款** | 真商户号（Stripe / 微信支付 / 支付宝）+ `pro/` 商业层 | ⏳ 要先去开通 |

## 现在货架上有什么

| 皮肤 | id | 单价 |
|---|---|---|
| 极光 | `premium-aurora` | ¥18 |
| 星云 | `premium-nebula` | ¥28 |
| 青玉 | `premium-jade` | ¥38 |
| 余烬 | `premium-ember` | ¥48 |

免费皮肤 3 套（原味 / 霓虹 / 水墨），单机功能不锁。价格改在 `assets/skins/<id>/skin.json` 的 `price`（单位：分）。

---

## 一、人工收款（五分钟配完，今天就能收第一笔）

### 1. 配一次收款方式

配一次，之后每张订单都会自动带上。**不配的话买家不知道钱往哪付，流程卡在第一步。**

```bash
# 终端里（一次配好，之后每张订单自动带上）
nexi call deck_market '{"action":"payinfo","methods":[{"kind":"alipay","account":"you@example.com","name":"张三"}]}'

# 或者在宿主对话里直接说
deck_market action="payinfo" methods='[{"kind":"alipay","account":"you@example.com","name":"张三"}]'
```

可选 `kind`：`alipay` / `wechat` / `bank` / `paypal` / `stripe` / `other`。
最多 5 条，可以混着配（比如支付宝 + 银行转账）。

不通过工具也行，直接写文件 `<工作区>/market/payinfo.json`：

```json
{
  "v": 1,
  "updatedAt": "2026-11-09T00:00:00.000Z",
  "note": "转账请备注订单号，否则对不上账",
  "methods": [
    { "kind": "alipay", "label": "支付宝", "account": "you@example.com", "name": "张三" },
    { "kind": "wechat", "label": "微信", "account": "zhangsan_wechat", "name": "张三" }
  ]
}
```

查看当前配置：`deck_market action="payinfo"`。

### 2. 买家下单 → 转账

买家侧：

```
deck_market action="place" skinId="premium-aurora"
```

会拿到三样东西：**订单号**、**收款备注**（固定是 `MANUAL-<订单号>`）、**你的收款方式**。

买家按备注转账。这一步是人和人之间的事，插件不参与。

> 同一个买家对同一套皮肤重复下单，会自动复用那张待付款单，不会堆一堆同价账单 ——
> 因为两个备注就是两笔说不清的钱。

### 3. 你确认到账 → 自动发放

```
deck_market action="confirm" orderId="ord_xxxxxxxx" paymentRef="2026110912345678"
```

- `paymentRef` **必填**：支付宝/微信的转账单号，或者你能认出来的凭证。
  没有凭证的确认，事后对账就是糊涂账，所以这一条是硬要求。
- 确认后：订单 → `delivered`、皮肤立刻可用、80/20 分账写进 `market/ledger.json`。

### 4. （可选，但建议）签一张授权码一起发出去

只靠 `confirm`，皮肤**只在这台机器上有效**（买家重装系统/换电脑就没了，因为凭据是本机账本推出来的）。

要跨设备、且让买家伪造不了，就在确认时附上签名授权码：

```bash
# 卖家机器上：签一张只含这套皮肤的授权（30 天有效期，按需改）
node tools/license-cli.mjs issue --tier free --to 买家 --days 365 --skins premium-aurora
```

拿到 `ADSK1.xxx.yyy` 之后：

```
deck_market action="confirm" orderId="ord_xxxxxxxx" paymentRef="..." licenseKey="ADSK1.xxx.yyy"
```

授权码会同时记进订单和账本。买家那边三条路都能贴进去：

```bash
# ① 聊天里让模型执行（最省事）
deck_license activate key="ADSK1.xxx.yyy"

# ② 终端里（新装、还没连宿主时用这条）
nexi call deck_license '{"action":"activate","key":"ADSK1.xxx.yyy"}'

# ③ 打开 /deck 状态页，粘贴到输入框
```

贴进去之后**换机器也认**，而且签名由你的私钥产生 —— 买家改一位都会验签失败。

> 为什么这条更硬：本地账本上的"买过"是可以用编辑器改的（改了就失效，但那仍然是"改文件"级别
> 的门槛）；签名授权是密码学级别，买家手上没有私钥，改不出来。

### 4.1 买家换电脑了：三步，别让他去翻邮件

这是最容易吵起来的一步。旧电脑上的凭据**不会自己跟过去**（本机账本带封印，拷过去也不采信），
能跟人走的只有那串码。所以：

```bash
# 旧电脑：把这笔订单的整串码调出来（列表里带「可换机」标的就是有码的）
deck_market action="orders"
deck_market action="orders" orderId="ord_xxxxxxxx"

# 新电脑：贴进去
deck_license activate key="ADSK1.xxx.yyy"
```

新电脑上不需要旧电脑的任何文件，也不需要重买。**码就是收据**。

> 提醒买家自己留一份码（记事本/邮件都行）。你这边也可以查：`node tools/license-cli.mjs orders`
> 会列出你签过的每一张码 —— 买家真丢了，你能照着订单号再发一次。

### 4.2 发出去的码，收不回来（这条必须知道）

签名码是**离线**的：验签只需要公钥，不需要连你的服务器。好处是买家断网也能用、你不用运维；
代价是**你没法远程吊销它**。

| 动作 | 本机凭据 | 已发出去的码 |
|---|---|---|
| 你 `refund` 退款 | ✅ 立刻收回 | ❌ 收不回（那台机器上没有你的账本） |
| 到期 | — | ✅ 自然失效 |
| 想立刻停用 | — | 只能上在线校验服务（`pro/` 那条路） |

所以定价和话术按这个前提来：

- 退款窗口内，**签短期码**（`--days 30`），到期自然失效，比"承诺会吊销"实在；
- 真需要强控（比如企业版按席位），走在线渠道，让服务端每次校验；
- 别在商品页写"防盗版"——本仓库是 AGPL，改代码是买家的合法权利。

### 5. 退款

```
deck_market action="refund" orderId="ord_xxxxxxxx" reason="不想要了" refundRef="支付宝退款单号"
```

带 `refundRef` 走人工退回：记退款流水、订单转 `refunded`、**皮肤立刻收回**
（本机凭据和签名凭据一起失效 —— 不然就是"退钱还留着皮肤"）。

不带 `refundRef` 时只做拒绝，不会假装退过。

---

## 二、在线收款（要商户号）

### 需要你去开的

| 渠道 | 去哪开 | 拿到什么 |
|---|---|---|
| Stripe | dashboard.stripe.com（需要有境外主体或支持的地区） | Secret key、Webhook 签名密钥 |
| 微信支付 | pay.weixin.qq.com（需要企业/个体户营业执照） | 商户号 mchid、APIv3 密钥、证书 |
| 支付宝 | open.alipay.com（需要企业/个体户） | APPID、应用私钥、支付宝公钥 |

**中国大陆个人没有营业执照是开不了微信支付/支付宝商户号的**，这是政策，不是技术问题。
所以短期内人工收款就是最快能收到钱的路。

### 配到插件里

装好 `pro/`（商业层）之后，这几个环境变量会被 `pro/billing/from-env.js` 读：

```bash
AGENTDECK_PAY_PROVIDER=stripe        # stripe | wechat | alipay
AGENTDECK_PAY_URL=https://...        # 下单接口
AGENTDECK_PAY_TOKEN=...              # 渠道凭据
AGENTDECK_PAY_REFUND_URL=https://... # 退款接口
```

配完重启宿主，`deck_market action="health"` 会说清楚"购买通道/退款通道"各自通没通。

> 没装 `pro/` 的话这些变量**不会被读**。工具会直说"设了也不会生效，走人工渠道"，
> 不会让你设一圈环境变量然后发现还是未配。

### 在线渠道的关键差别

在线渠道的 `charge` 返回 `paid:true` 才算收款成功 —— 插件不会因为"用户点了购买"就当成付过钱。
渠道返回里如果带 `licenseKey`（服务端用签发私钥现签的），会自动存进订单，效果和人工渠道附码一样。

---

## 三、账本在哪、怎么看

| 文件 | 内容 |
|---|---|
| `<工作区>/market/orders.json` | 订单状态机：`created → paid → delivered → refunded` |
| `<工作区>/market/ledger.json` | 已购皮肤 + 80/20 分账流水 |
| `<工作区>/market/payinfo.json` | 你的收款方式（就是上面配的那个） |
| `<工作区>/market/.integrity.key` | 账本封印密钥（**别删**，删了老账本的封印全部失效） |

两份账本都带 HMAC 封印。被手改过之后，插件会明说"封印对不上，本轮不采信本地购买凭据"，
不会静默当成买过。

看订单：`deck_market action="orders"`。

对账（需要 `pro/`）：`deck_market action="reconcile"` 拿渠道对账单跟本机订单逐笔勾对，只报差异不改账。

---

## 四、常见问题

**Q：买家说付款了，但我 confirm 之后他说用不了？**
先看 `deck_market action="orders"` 里那张单是不是 `delivered`。如果是，让他重启宿主再看货架。
如果他在另一台设备上，那台设备没有本机凭据 —— 把码取出来发给他，按 4.1 的三步走。

**Q：买家换电脑后说"我买过"，怎么办？**
让他把旧电脑上的码发给你核对（`deck_market action="orders" orderId="<单号>"` 能看到整串），
核对得上就让他贴到新电脑（`deck_license activate`）。核对不上就是另一回事了，不要凭"他说买过"再签一张。

**Q：能不能不给授权码，靠账本跨设备？**
不能。账本是本机的，跨设备同步属于另一套机制（`pro/sync/`），而且账本里的购买凭据
在别人机器上本来就不该被采信 —— 否则随便拷一份账本就能白拿。

**Q：买家改账本会怎样？**
会失效。封印会报"被改过"，本地购买凭据全部不采信，货架上那套皮肤重新变回锁定。
所以他要么真买，要么拿到你签的授权码。

**Q：那他能改代码改掉校验吗？**
能。本仓库是 AGPL-3.0，改代码是合法权利。所以**授权校验不构成强制力**，
真正拦得住的是"服务器才有的东西"（云房间、托管分身、模型额度）。
定价和宣传请按这个前提写，不要宣传"防盗版"。
