## 这个 PR 干了什么

<!-- 一句话说清：改了什么、为什么改。别写"优化了代码"。 -->

## 影响面

- [ ] 只改了文档 / 注释
- [ ] 改了工具签名或返回格式（会影响已上板的任务流）
- [ ] 改了引擎（`lib/engine/*`）：任务板 / CLI 桥 / LLM 通道
- [ ] 改了授权或房间（`lib/license.js`、`lib/room.js`、`tools/relay-server.mjs`）
- [ ] 改了打包与发布流程（`package.json` 的 `files` / `scripts/*`）

## 自检（勾之前先真跑一遍）

- [ ] `node --test --test-concurrency=1 "tests/*.test.mjs"` 全绿（Windows 必须串行，并行会假红）
- [ ] 新功能带测试：涉及子进程 / 网络的用例要能在离线下跑（用 fixture 或本地 relay 子进程）
- [ ] `node tests/e2e-local.mjs` 五步仍 5/5
- [ ] 如果动了打包内容：`node tools/publish-npm.mjs`（干跑）五关全过，且新文件确实进了 tarball
- [ ] 如果动了工具：在真会话里试过（`dsh --profile <p> headless "…"`），不是只跑单元测试
- [ ] 文档同步：`README.zh.md` / `README.md` 两边一致；行为变了就改 `docs/PRODUCT.md` 对应行

## 兼容性

- 是否改变已有工具的入参 / 返回结构？（是 → 在 PR 里写明旧调用会怎样）
- 是否改变落盘位置？（是 → 必须带自动迁移 + 迁移测试，参考 1.4.1 的「授权码/桌宠档案改机级」）
- 是否需要新版本的 DSH？（是 → 更新 `package.json` 的 `dsh.compatibility.dshReleases`，别只改 README）

## 证据（可选但强烈建议）

贴一条真实输出：命令 + 关键几行。涉及「跑通了」的结论，请附 `docs/evidence/` 下新增的那份文件路径。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
