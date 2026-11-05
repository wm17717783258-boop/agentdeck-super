# 参与贡献

这个项目的目标是**让任何 Agent、任何人都能进同一间屋子干活**。所以贡献代码之前，先确认你的改动没有破坏两条底线：

1. **免费版能独立把活干完**（不许把本地能力挪到付费墙后面）；
2. **断网也能用**（任何联网功能都必须能优雅退化，不能因为中继挂了就干不了活）。

---

## 开发环境

不需要构建，不需要装依赖（零运行时依赖，纯 ESM）。

```bash
git clone https://github.com/<账号>/agentdeck-super.git
cd agentdeck-super
node --test --test-concurrency=1 "tests/*.test.mjs"   # 全部单元测试
node tests/e2e-local.mjs                              # 端到端自检（不联网、不烧模型额度）
node tools/publish-npm.mjs                            # 发布前 5 关自检（默认 dry-run）
```

要求 Node ≥ 22.12。Windows 上必须带 `--test-concurrency=1`：`node --test` 的并行模式会让共享临时目录的用例互相踩（这不是代码问题，是测试隔离的取舍）。

本机装着的真 Agent 可以用这条命令实测：

```bash
node tools/real-agents-check.mjs --timeout 300     # 真起进程、真调模型
```

某个 CLI 报"环境未配"是它自己没登录，不是接入层坏了——按提示登录一次即可。

---

## 目录结构（改代码前先看 `docs/CONTRACTS.md`）

| 路径 | 职责 | 别在这做什么 |
| --- | --- | --- |
| `lib/index.js` | 宿主入口：注册工具、HTTP 路由、`/deck` 命令 | 别把业务逻辑写进来 |
| `lib/engine/board.js` | 任务板状态层（团队/成员/任务/事件流） | 别在这发网络请求 |
| `lib/engine/cli.js` | 本机 CLI Agent 的探测与调用 | 别硬编码某一家的路径 |
| `lib/engine/{bridge,adbp}.js` | 五种传输 + ADBP 接入协议 | 别绕过 `wrapInvocation`（Windows `.cmd` 垫片） |
| `lib/engine/{llm,toolbelt,roles}.js` | 大脑 / 工具带 / 角色分工 | 别让 `execute` 抛异常（宿主会崩） |
| `lib/license.js` · `lib/room.js` | 授权与跨机房间 | **不要改线上签发密钥相关逻辑**，见下 |
| `lib/pet/*` | 桌宠：档案、皮肤、串门、会议 | 别在 `renderSprite` 里引外部资源 |
| `tools/*` | 运维脚本（中继、发码、发布自检） | 别把私钥写进仓库 |
| `docs/*` | 文档 | `docs/CONTRACTS.md` 是模块契约，改动要在 PR 里说明理由 |

---

## 三条硬规则

1. **工具 `execute` 永不抛异常。** 失败要返回结构化的 `{ ok: false, reason: '中文人话' }`，宿主不会因为你的 bug 崩掉。
2. **错误信息写人话。** 不要 `ENOENT` / `ECONNREFUSED` 直接甩给用户，要说清"找不到哪个文件、下一步该干什么"。
3. **跨平台。** Windows 上所有 `.cmd`/`.bat` 调用必须走 `wrapInvocation`，杀进程必须用进程树（`taskkill /T /F`）；文件路径不许手拼分隔符。

---

## 提交 PR

- 一个 PR 一件事，标题写清"改了什么、为什么"。
- 必须带测试：新功能 → 新增用例；修 bug → 一条能复现该 bug 的用例（先红后绿）。
- PR 描述里贴这三条命令的输出尾部：`node --test ...`、`node tests/e2e-local.mjs`、`node tools/publish-npm.mjs`。
- 中文注释没问题，代码标识符用英文。

## 不要做的事

- ❌ 提交 `issuer-private.pem` 或任何私钥、API key（`.gitignore` 已覆盖，但别依赖它）。
- ❌ 在免费能力上加限制来"引导付费"。
- ❌ 引入第三方运行时依赖来做本来能 200 行写完的事。
- ❌ 修改 `docs/CONTRACTS.md` 里已冻结的接口签名而不通知其他模块维护者。

## 授权与商业化边界（重要）

代码是 MIT，你可以 fork、自建中继、自己给自己的团队发授权码，**不需要给我们任何钱**。
付费购买的是我们*托管*的中继/云房间/模型额度，以及美术素材包。
所以：**任何"绕过授权"的 PR 都不会被合**，但**任何让自建变得更容易的 PR 都欢迎**。

---

## 报告问题

用 issue 模板，附上：操作系统、Node 版本、`dsh --version`、你敲的命令、完整报错、以及 `docs/evidence/` 里生成的自检报告（如果有）。
越小、越可复现的例子，修得越快。
