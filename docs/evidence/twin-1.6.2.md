# M2 证据：数字分身记忆 + 习惯进化（v1.6.2）

抓取时间：2026-11-05 17:22 与 17:31（Asia/Shanghai）
版本：`agentdeck-super@1.6.2`（MCP `serverInfo.version` 直接读 package.json，不写死）
工具面：14 个，其中分身记忆 5 个：`twin_remember` / `twin_recall` / `twin_brief` / `twin_forget` / `twin_habit`

## 一句话结论

外部 Agent（不经过 DSH 内部，走的是 MCP stdio 网关，和 Claude / Codex 接进来时同一条路）
能把记忆写进本机文件、换个进程再读回来；它干的活会被桌宠攒成"习惯候选"，
你点头确认后才进简报——**学习和确认是两件事，页面上都看得见**。

## 一、MCP 网关：14 个工具，逐个有 inputSchema

`tools/list` 必须和 `HUB_TOOL_ORDER` 完全一致（多一个少一个都算契约破了），
这条已经是自动化断言：`tests/mcp.test.mjs` 里 `assert.deepEqual(names.sort(), HUB_TOOL_ORDER.sort())`。

原始报文：`twin-mcp-session-1.6.2.jsonl`（每条 client/server JSON-RPC 原样记录）
结构化摘要：`raw-twin-mcp-1.6.2.json`

## 二、外部 Agent 真写盘、真召回

| 步骤 | 工具 | 结果 |
| --- | --- | --- |
| 记住用户偏好 | `twin_remember` | 偏好 · 私有 · 标签 汇报/风格 |
| 记住项目事实 | `twin_remember` | 语义 · 私有 · 标签 构建/演示 |
| 关键词召回 | `twin_recall` `{query:"汇报 结论"}` | 命中 1 条（该视角可见 2 条） |
| 生成简报 | `twin_brief` | 偏好记忆 + 语义记忆 + 画像统计 |
| 记忆统计 | `twin_forget` `{action:"stats"}` | 共 2 条：语义 1｜偏好 1；私有 2 |
| 习惯候选 | `twin_habit` `{action:"propose"}` | 候选 0 条（这个档案还没攒够信号，符合预期） |

落盘位置是脚本自己打印的，不是猜的：
`D:\demo\hostN\work\.agentdeck\twin\memory.json`

## 三、跨进程可见：状态页读到外部 Agent 写的记忆

`http://127.0.0.1:59931/deck`（独立 web profile 宿主，装的就是 1.6.2）：

```
<h2>分身记忆</h2>
<p>共 2 条：知识 1 / 偏好 1</p>
<p class="muted">存在本机 D:\demo\hostN\work\.agentdeck\twin\memory.json。
分四档可见性（私有 / 好友 / 房间 / 公开），对外协作时只有你放行的那部分才会跟着走。</p>
```

截图：`twin-deck-1.6.2.png`

> 踩过的坑，记下来防复发：宿主给 `apply` 的 `deps.root` 是**函数**（工作区会变），
> 页面摘要一开始直接把它当路径传给 `stats()`，`path.join` 抛错被 catch 成空，
> 于是页面永远显示"这一版没加载到记忆模块"。修法：`typeof env.root === 'function' ? env.root() : env.root`，
> 并补了断言「状态页摘要：宿主把 root 传成函数也要算得出来」。

## 四、习惯进化：观察 → 提议 → 你确认 → 进简报

这一版真跑了一遍（全程 MCP，同一条路径，脚本 `tools/drive-habit.mjs`）：

1. 建组 → 连续 3 个"跑 sql 周报"任务 → 逐个标完成。宿主的真实动作被翻成桌宠事件
   （加任务 + 完成，同一标签集合算同一类，所以信号攒到 6 次），到阈值就由桌宠自己先记一笔（`HABIT_PROMOTE_AT = 3`）。
2. `twin_habit propose` 列出候选，并标明"桌宠先记了一笔，等你点头"：

```
【twin_habit】候选 1 条｜已确认 0 条
1. 干活处理「sql、周报」这类活（已 6 次） [16-18|worker|sql,周报]（桌宠先记了一笔，等你点头）

这些是桌宠观察到但还没确定的习惯。用 action=confirm 点名它才会生效（也可以直接给序号，比如 1），action=reject 让它以后别问。
```

3. `twin_habit confirm`（也可以直接给序号 1）→ 进 twin 账本，同时升级进桌宠画像：

```
【twin_habit】已确认：干活处理「sql、周报」这类活（已 6 次）
置信度 0.95｜证据 6 次
已确认：以后桌宠会按这条习惯帮你做决定；不满意随时 action=rollback 撤回。
```

4. 再要候选：`候选 0 条｜已确认 1 条`（确认过的不会再追问）；再要简报，习惯已经真的在用了：

```
【twin_brief】
用户确认过的习惯（可以据此替他做决定）：
- 干活处理「sql、周报」这类活（已 6 次）
偏好记忆：
- 王冕：汇报先给结论，再给细节
统计：累计完成 3 个任务、拆出 3 个，活跃 1 天，最早 2026-11-05。
```

原始会话：`habit-session-1.6.2.txt`
状态页截图：`habit-deck-1.6.2.png`（桌宠段"干活处理「sql、周报」这类活（已 6 次）（出现 6 次）"，
分身记忆段同名条目后标着"（你确认过，出现 6 次）"）

**为什么要分两套账**：桌宠到点自己记的叫"它以为"，只有你点过头才进简报和对外共享。
之前两套账打架（自动升级的那条被候选列表排除，于是永远无法确认），现在候选列表把自动的也列出来并标注
（`auto: true`），`tests/twin.test.mjs` 里有一条专门守这个：「桌宠自动记下的也还得你点头才算数」。

## 五、可见性是硬门槛（不是"过滤一下"）

`visibility` 是**最小受众**：`private` 只有你，`friend` 好友级才看得见，`room` 房间级，`public` 公开。
`visibleTo(visibility, audience)` 在 `audience === 'private'` 时恒真，其余按等级比较。
召回时类型和可见性**先过滤再打分**——不会出现"私有偏好被 friend 视角顺带命中"。

`tests/twin.test.mjs` 共 12 条（可见性 5 条 + 简报/共享视图 + 习惯三态 + 工具永不 throw + root 函数坑），全绿。

## 六、诚实边界（这一版还没有的）

- 跨用户共享记忆（好友/房间视角真的发给别人）属于 M3：本版只做了可见性闸门与数据结构，没连跨机通道。
- 记忆文件是明文 JSON（`~/.dsh/agentdeck-super/.agentdeck/twin/memory.json`）；加密同步是付费云端那一层，本版没有。
- 云端 / 市场 / 订阅未验证，按"环境未配"处理。
- 习惯的"确认"目前要 Agent 调 `twin_habit confirm`（页面上给了 key 与序号用法），还没有一键按钮。
