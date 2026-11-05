# 开源 + 上架：从这台机器到用户 `dsh plugin add` 的完整手工单

> 这份单子的每一步都在本机真实跑过：命令、期望输出、失败怎么办都写了。
> 总耗时：第一次约 40 分钟（含装 git、建仓库），之后每次发版 5 分钟。

---

## 0. 你现在处在哪一步

| 环节 | 状态 | 怎么验 |
| --- | --- | --- |
| 代码（插件本体，MIT） | ✅ 完成 | `node --test --test-concurrency=1 "tests/*.test.mjs"` → 281/281 |
| 打包（`dsh.bundle` + `cordis.patch.yml` + icon） | ✅ 完成 | `node tools/publish-npm.mjs` 第 1/4/5 关全绿 |
| 安装（从 tarball 真装进 DSH 并跑通） | ✅ 完成 | `docs/evidence/install-headless-*.md` |
| 授权/收费（真签发→真验签→真拦截） | ✅ 完成 | `node tests/e2e-local.mjs` 第 3 步 |
| 跨机协同（真 relay 真房间） | ✅ 完成 | `docs/evidence/two-hosts-*.md` |
| npm 包名 | ✅ `agentdeck-super` 未占用 | `node tools/publish-npm.mjs` 第 2 关 |
| GitHub 仓库 | ⬜ 要你建（本机没装 git） | 见 §1 |
| npm 真发布 | ⬜ 等你说"发" | 见 §3 |
| DSH 市场条目 | ⬜ 发布后提 PR | 见 §4 |

---

## 1. 建仓库并推上去（一次性，约 20 分钟）

### 1.1 装 git

```powershell
winget install --id Git.Git -e
```

装完**关掉当前 PowerShell 窗口重开**（PATH 才生效）。验证：`git --version`。
没有 winget 就去 <https://git-scm.com/download/win> 下安装包，一路默认。

### 1.2 在 GitHub 建一个空仓库

1. 打开 <https://github.com/new>
2. 仓库名填 `agentdeck-super`
3. **不要**勾 "Add a README file"、不要选 .gitignore、不要选 license（我们已经有 `LICENSE` 了）
4. 建完后页面会给你一个 `https://github.com/<你>/agentdeck-super.git` 地址

> 用谷歌邮箱注册的 GitHub 账号，登录名（username）≠ 邮箱。
> 地址里要填的是 username：右上角头像 → Settings → Account → Username。

### 1.3 初始化并推送

```powershell
cd D:\agentdeck-super
.\scripts\init-git.ps1 -Email <你的邮箱> -RepoUrl https://github.com/<你的用户名>/agentdeck-super
```

脚本做四件事，可反复跑：查 git → `git init`（`.gitignore` 已挡掉 `node_modules`、`.relay-data`、`.agentdeck-issuer`，**并会主动拦下密钥文件**）→ 首次提交 → 设 origin 并推 `main`。

### 1.4 把仓库地址写进 package.json

```powershell
node tools/set-repo.mjs https://github.com/<你的用户名>/agentdeck-super
```

填完后 npm 包页面上的 Repository / Homepage / Issues 三个链接都是真的。
（`publish-npm.mjs` 会拦占位地址——留占位符比不填更伤信任。）

---

## 2. 发版前：干跑体检（每次发版都跑，约 1 分钟）

```powershell
node tools/publish-npm.mjs
```

五关，任何一关红都别发：

| 关 | 检查什么 | 常见红的原因 |
| --- | --- | --- |
| 1 | 插件契约：ESM、`main`、`dsh.bundle.patch`、`compatibility.dshReleases` 对象、LICENSE、`files` 含 `tools`/`assets` | 忘了给新目录加进 `files` |
| 2 | npm 名字占用 + 同版本是否已发过 | `version` 没往上加 |
| 3 | 全量测试（281 条，串行） | 并行跑会假红，脚本已经串行 |
| 4 | `npm pack --dry-run` + 必备文件清单 + 图标 ≤256 KiB | 图标太大、`docs/` 没进包 |
| 5 | 真发（带 `--publish` 才执行） | 无 `NPM_TOKEN` / EOTP / E401 |

---

## 3. 真发布

```powershell
# 令牌：npmjs.com → 头像 → Access Tokens → Granular Token → Read and Publish
$env:NPM_TOKEN = 'npm_你的令牌'
node tools/publish-npm.mjs --publish
```

发完立刻自测（**这一步别省**，它证明"用户真能装上"）：

```powershell
dsh plugin --profile agentdecktest add agentdeck-super
```

然后开一个**新会话**（插件按会话加载），输入 `/deck`——看到状态页就是通了。

---

## 4. 上架 DSH 市场

市场目录是 `awesome-dsh-plugin`（<https://awesome-dsh-plugin.com/plugins.json>），收录要求就两条：**能装上** + 有 `dsh.bundle`。我们两条都满足（`dsh plugin add agentdeck-super` 真装过）。

提 PR 的条目形状（照现成条目抄，字段一个别漏）：

```json
{
  "name": "agentdeck-super",
  "description": "把 Claude Code / Codex / Gemini / DSH 等异构 Agent 拉进同一个任务板一起干；房主付费开跨机房间，客人凭邀请零授权入座；桌宠分身可串门开会。",
  "author": "<你的 GitHub 用户名>",
  "repo": "https://github.com/<你的用户名>/agentdeck-super",
  "npm": "agentdeck-super",
  "tags": ["agent-team", "collaboration", "multi-agent", "room", "pet"],
  "license": "MIT"
}
```

`docs/MARKET.md` 里有更完整的文案（中英文描述、截图建议、常见问答）。

---

## 5. 发完之后

- [ ] 在 README 顶部换 npm 版本徽章
- [ ] 给市场 PR 附一张 `/deck` 截图（市场条目有点击率差别）
- [ ] 发一条朋友圈/推文，文案用 `docs/COMMERCE.md` §8 的"房主付费、客人免费"
- [ ] 定价页三档与 `lib/license.js` 的 `TIERS` 对齐（改价只改一处，避免说法不一）

---

## 6. 出问题怎么查

| 现象 | 先看这里 |
| --- | --- |
| `dsh plugin add` 装不上 | `npm view agentdeck-super dist.tarball` 能不能下；`files` 里有没有 `cordis.patch.yml` |
| 装上但 `/deck` 没反应 | 插件是按会话加载的，**开新会话**；再不行看 DSH 日志里有没有 `[agentdeck-super]` 告警 |
| 市场审核被拒 | 90% 是 `dsh.bundle` 缺或 `compatibility.dshReleases` 不是对象；跑 `node tools/publish-npm.mjs` 第 1 关 |
| 用户说授权码没生效 | `/deck` 页看档位；`node tools/license-cli.mjs verify <码>`；确认用户改的是同一台机器（授权文件在 `$DSH_HOME/agentdeck-super/license/key.txt`） |
