# 证据索引（每一份都能在本机重跑）

> 规矩：**没有证据文件的"跑通了"一律不算**。下面每份文件都是一次真实执行的原始输出（表格 + 结论），
> 文件名带 UTC 时间戳。代码改动后旧的会删掉、重新生成，所以这里永远只有最新的几份。

## 现在有哪几份

| 文件 | 一句话证明什么 | 怎么自己重跑 |
| --- | --- | --- |
| [`install-headless-1.4.1-2026-11-05.md`](install-headless-1.4.1-2026-11-05.md) | **1.4.1 最终包装进干净 DSH profile，开真会话连续调 3 次工具**：`dsh plugin add` 装得上、版本对得上、工具真能落盘（`state.json` 里查得到 team/task id），还顺带证明了授权码已是机级路径 | `pwsh -File scripts\release.ps1 -Version 1.4.1` 后按文档里的 headless prompt 重跑 |
| [`e2e-local-2026-11-05T07-07-11-422Z.md`](e2e-local-2026-11-05T07-07-11-422Z.md) | **五条主链路端到端**：真起 Agent 子进程 → 任务板抢占互斥 → 真签授权码并验篡改 → 真 relay 建房跨机往返 → relay 挂掉时本地照常干 | `node tests/e2e-local.mjs` |
| [`two-hosts-2026-11-05T06-23-30.md`](two-hosts-2026-11-05T06-23-30.md) | **两台"机器"协同**：房主付费建房 → 免费用户被拦住并被告知怎么升级 → 客人凭邀请零授权入座 → 任务镜像 + 认领回流 → 断线续传 → 房主关房客人优雅收敛 | `node --test --test-concurrency=1 "tests/room-two-hosts.test.mjs"` |
| [`real-agents-2026-11-05T07-06-12-094Z.md`](real-agents-2026-11-05T07-06-12-094Z.md) | **本机真装着的 Agent 真被调起来**：claude 2.1.317 / codex 0.166.0 / dsh 0.2.1-rc.5 实跑通过；gemini 0.66.0 识别到但没登录（标"环境未配"，不算插件失败） | `node tools/real-agents-check.mjs` |
| [`real-project-2026-11-05T06-52-45-242Z.md`](real-project-2026-11-05T06-52-45-242Z.md) | **两个不同厂商的 Agent 真合作干完一个项目**：Claude Code 写 `math.mjs`（29.5s）、Codex 写 `math.test.mjs`（28.4s），经任务板派活/认领/依赖门控，最后 `node --test` 真跑通 2 项、`import` 真算得出结果 | `node tests/e2e-project.mjs` |

## 全量测试（不单独存文件，因为它是每次发版的强制闸门）

```bash
node --test --test-concurrency=1 "tests/*.test.mjs"
# → 281 tests / 281 pass / 0 fail
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
- **多租户安全**：房间里默认互相信任（同团队场景），没有做租户隔离——这点在 `docs/PRODUCT.md` §5 里也写了。
