# 接入层：把任意 Agent 拉进同一个团队

> 这一页只讲一件事：**手上已有的 Agent，怎么用最少的话接进来、怎么验它真的通了。**
> 涉及三个文件：`lib/engine/cli.js`（本机 CLI）、`lib/engine/bridge.js`（远程 / 桌面 / 自研协议）、
> `lib/engine/adbp.js`（我们自己的 ADBP 服务端入口）。

## 1. 一眼看结论

| transport | 面向什么 | 实测到哪一步 | 证据 |
|---|---|---|---|
| `cli` | 本机命令行 Agent（claude / codex / dsh / gemini / 自定义） | **真机跑通 3/4**：claude / codex / dsh 真跑回 `AGENTDECK_OK`；gemini 本机缺 API Key（退出码 41，属配置问题，不是接入层） | 第 2 节原始输出 + `docs/evidence/real-agents-2026-11-05T06-02-34-575Z.md` |
| `openai` | 任何 OpenAI 兼容服务（官方、中转、本地 vLLM/Ollama） | 假服务端全程验证（探活 / 调用 / 流式 / 401 / 用量） | `tests/bridge.test.mjs` |
| `acp-http` | 支持 ACP over HTTP 的 Agent 网关（CodeBuddy 一类） | 假 ACP 网关验证（connect → initialize → session/new → session/prompt） | `tests/bridge.test.mjs` |
| `cdp` | 只有网页版的桌面 App（ChatGPT / Claude 桌面端等） | 假调试端口 + 假 WebSocket 验证（注入输入、回车、等回答） | `tests/bridge.test.mjs` |
| `adbp` | 任何语言自己写的桥（几十行 HTTP） | **服务端 21 个用例全绿**；客户端与 bridge 互通 | `tests/adbp.test.mjs` |

没有真机验证的那几行我都写明了缺口，不吹。假服务端的价值是：协议细节（字段名、SSE、鉴权、超时分支）已经钉死，真机接上时只剩"地址和 token 填对"这一件事。

## 2. 本机真实探测（`detectAgents()`，无模型调用）

命令：

```powershell
node -e "import('./lib/engine/cli.js').then(async m => console.log(JSON.stringify(await m.detectAgents(), null, 2)))"
```

真实输出（2026-11-05 本机运行，全程 4307 ms，只跑 `--version`，不烧 token）：

```json
[
  { "id": "claude", "label": "Claude Code", "available": true,
    "cmd": "D:\\ClaudeCode\\claude.cmd", "version": "2.1.317 (Claude Code)" },
  { "id": "codex", "label": "Codex", "available": true,
    "cmd": "C:\\Users\\王冕\\Apps\\nodejs\\codex.cmd", "version": "codex-cli 0.166.0" },
  { "id": "dsh", "label": "DeepSeek Harness", "available": true,
    "cmd": "C:\\Users\\王冕\\Apps\\nodejs\\dsh.cmd", "version": "0.2.1-rc.5" },
  { "id": "gemini", "label": "Gemini CLI", "available": true,
    "cmd": "C:\\Users\\王冕\\Apps\\nodejs\\gemini.cmd", "version": "0.66.0" }
]
```

接上 `probe()` 之后（同一个进程里先探测再逐个探活）：

```text
PROBE claude={"ok":true,"kind":"cli","meta":{"cmd":"D:\\ClaudeCode\\claude.cmd","version":"2.1.317 (Claude Code)"},"ms":3069}
PROBE codex ={"ok":true,"kind":"cli","meta":{"cmd":"C:\\Users\\王冕\\Apps\\nodejs\\codex.cmd","version":"codex-cli 0.166.0"},"ms":81}
PROBE dsh   ={"ok":true,"kind":"cli","meta":{"cmd":"C:\\Users\\王冕\\Apps\\nodejs\\dsh.cmd","version":"0.2.1-rc.5"},"ms":91}
PROBE gemini={"ok":true,"kind":"cli","meta":{"cmd":"C:\\Users\\王冕\\Apps\\nodejs\\gemini.cmd","version":"0.66.0"},"ms":81}
PROBE dead  ={"ok":false,"kind":"openai","error":"连接被拒绝：端口没开、或服务没启动（ECONNREFUSED）","reason":"连接被拒绝：端口没开、或服务没启动（ECONNREFUSED）","ms":32}
```

要点：

- 四个 CLI 都是 `.cmd` 包装（npm 全局装的），`resolveCommand` 会按 `PATHEXT` 补后缀找到真实文件，**不会**把 `.cmd` 直接 `spawn`（Windows 上必然 ENOENT）。
- `claude --version` 要 3 秒（Node 冷启动 + 它自己加载配置），所以版本探测默认 10 s 超时 + 10 分钟缓存；`detectAgents({ withVersion: false })` 只找路径，毫秒级。

### 2.1 真机真跑一轮（会烧 token，单独脚本手动跑）

探测只能证明"装没装"。要证明"真能干活"，跑：

```powershell
node tools/real-agents-check.mjs --timeout 300   # 每家用真模型问一句"只回 AGENTDECK_OK + 你的名字"
```

本机结果（`docs/evidence/real-agents-2026-11-05T06-02-34-575Z.md`）：

| Agent | 结果 | 耗时 | 退出码 | 实际命令行 |
| --- | --- | --- | --- | --- |
| claude | ✅ 回 `AGENTDECK_OK GLM` | 26.0s | 0 | `D:\ClaudeCode\claude.cmd` |
| codex | ✅ 回 `AGENTDECK_OK Codex` | 10.5s | 0 | `C:\Users\王冕\Apps\nodejs\codex.cmd` |
| dsh | ✅ 回 `AGENTDECK_OK Claude (Anthropic)` | 24.7s | 0 | `C:\Users\王冕\Apps\nodejs\dsh.cmd` |
| gemini | ⚠️ 退出码 41 | 3.3s | 41 | `C:\Users\王冕\Apps\nodejs\gemini.cmd` |

gemini 的 41 是它自己的报错原文："Please set an Auth method in `~/.gemini/settings.json` or specify `GEMINI_API_KEY` …"——**没登录**，不是我们调用方式的问题；同一台机器上它的 `--version` 探测是正常的。

> 回归意义：这一轮跑之前，四家**全部** `rc:127 spawn claude ENOENT`（面板显示已安装、一跑就失败）。原因是 `runAgent` 把模板里的裸名 `claude` 直接交给 `spawn`，Windows 不做 PATHEXT 展开；探测走 `resolveCommand` 却能找到。现在 `runAgent` 先 `resolveCommand` 再 `wrapInvocation`，并把解析后的绝对路径写进 `meta.cmd`。对应回归用例：`tests/cli.test.mjs` 里"四家裸名只靠 PATH 里的 `.cmd` 垫片就能跑通"。

## 3. 五种 transport 的接入配方

`probe(manifest)` 只验"能不能连上、是不是这个东西"，`call(manifest, prompt, opts)` 才真正干活。两者都**不抛异常**（`probe` 内部抛、出口翻成 `{ok:false, error, reason}`）。

### 3.1 `cli` —— 本机命令行 Agent

```js
// 用模板
await bridge.call({ id: 'cc', kind: 'cli', agent: 'claude', model: 'claude-sonnet-4-5' }, '把 docs/api.md 的错别字改掉');
// 用自己的命令（模板覆盖）
await bridge.call({ id: 'my', kind: 'cli', cmd: 'node', args: ['scripts/worker.mjs'], stdin: true, promptArg: '-' }, '活来了');
```

| 字段 | 说明 |
|---|---|
| `agent` | `claude` / `codex` / `dsh` / `gemini`，取 `AGENT_PRESETS` 里的参数模板 |
| `cmd` + `args` | 直接给命令，绕过模板（优先级最高） |
| `stdin` | `true` 时 prompt 走标准输入（**推荐**）；否则走 `promptArg` 位置参数 |
| `model` | 走模板的 `modelArg`（如 `--model`），不支持就忽略 |
| `cwd` / `timeoutMs` / `signal` | 工作目录 / 超时（默认 120 s）/ 取消 |

返回值里 `meta.rc` 是子进程退出码：`0` 成功、`124` 超时、`130` 被取消、`127` 命令起不来，其它就是 CLI 自己的退出码。`meta.usage` 是 `{in, out}`（能解析出来才有）。

**只读是显式开关**：模板里的 `readonly: true` 只是能力标记，不会自动生效；要在 `manifest.readonly === true` 时才追加 `--permission-mode plan` 之类的参数。默认给团队 Agent 写文件的权限——它们是要干活的。

### 3.2 `openai` —— 任何 OpenAI 兼容服务

```js
await bridge.call({ id: 'relay', kind: 'openai', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-...', model: 'gpt-5' }, '写个摘要');
```

- 探活 `GET {baseUrl}/models`；`baseUrl` 结尾带不带 `/`、带不带 `/v1` 都行（结尾已经是 `/vN` 就不再补 `/v1`，避免拼出 `/v1/v1`）。
- 调用 `POST {baseUrl}/chat/completions`，固定 `stream: false`；对端硬要回 SSE 也能读（按 `data:` 逐行拼）。
- `meta.usage` 同时兼容 `prompt_tokens/completion_tokens` 和 `input_tokens/output_tokens` 两种命名。
- 401/403 的报错被翻成 `鉴权失败（HTTP 401）：apiKey / token 不对、或请求没带上`——别让人对着状态码猜。

### 3.3 `acp-http` —— ACP over HTTP 网关

```js
await bridge.call({ id: 'cb', kind: 'acp-http', url: 'http://127.0.0.1:8080', apiKey: '...' }, '跑一下这几个用例');
```

流程（`meta.transport` 里能看出走到哪一步）：`POST {url}/api/v1/acp/connect` 拿 `connectionId` + `sessionToken` → JSON-RPC `initialize` → `session/new {cwd, mcpServers}` → `session/prompt`，逐块收 `sessionUpdate === 'agent_message_chunk'` 拼正文。`url` 填根、`/api/v1`、`/api/v1/acp` 三种形态都认。

`meta` 里会带 `sessionId`、`stopReason`、`usage`、`model`（从 `_meta['codebuddy.ai/usage']`、`_meta['codebuddy.ai/requestModelId']` 提）。

### 3.4 `cdp` —— 给只有网页版的桌面 App 代打字

```js
await bridge.call({ id: 'chatgpt-app', kind: 'cdp', port: 9222, app: 'chatgpt', timeoutMs: 180000 }, '帮我看看这段日志');
```

- 前提：那个 App 以 `--remote-debugging-port=9222` 启动。探活会 `GET /json/version`（必须有 `Browser` 字段）和 `/json/list`（要有 `type: 'page'` 的页面）。
- `app` 是页面匹配关键词（默认 `chatgpt`），命不中就取第一个页面。
- 调用：连 `webSocketDebuggerUrl` → `Runtime.evaluate` 找到输入框（contenteditable / textarea）→ 写入文本 → `Input.dispatchKeyEvent` 回车 → 轮询页面文本直到出现新回答。
- `opts.pollMs` 可以调轮询间隔（测试里用 30–40 ms 才跑得快）。

### 3.5 `adbp` —— 我们自己的协议（重点）

`bridge` 这一侧是**客户端**：

```js
const p = await bridge.probe({ id: 'peer', kind: 'adbp', url: 'http://10.0.0.8:59710' });
// { ok:true, kind:'adbp', meta:{ protocol:'adbp', version:'1', name:'远程工位', teamId:'team-1' } }

await bridge.call({ id: 'peer', kind: 'adbp', url: 'http://10.0.0.8:59710', token: '...' }, '今晚把回归跑一遍');
// { ok:true, out:'', meta:{ delivered:true, teamId, memberId, note:'ADBP 是拉取式协议：…' } }
```

**注意语义**：ADBP 是**投递**不是问答。`out` 永远为空——任务进了对方的队列，对方下次轮询 `/adbp/v1/tasks` 才会看到；结果通过 `/result` 回到 board 上，不在这条 HTTP 响应里。想要"问一句立刻答"，用 `openai` / `acp-http`，或者把问题写进任务里等对方交活。

## 4. 服务端：ADBP 六个路由 + `handler` 契约

`createIngress({ board, name, teamId, maxWaitSec, log, onEvent })` 返回 `{ manifest, handler, tokens }`。

```js
// 宿主（lib/index.js 那侧）挂载方式：一个函数就够，不建服务器、不碰 socket
const ingress = createIngress({ board, onEvent: (e) => ui.push(e) });

const out = await ingress.handler(req.method, req.url, body, req.headers);
if (!out) return next();                       // null = 不是 ADBP 路径，继续走别的路由
res.writeHead(out.status, { 'content-type': 'application/json' });
res.end(JSON.stringify(out.json));
```

- 签名 `(method, path, body, headers)`，第 4 个 `headers` 是可选的（Bearer / `x-adbp-token` / `?token=` 三种都认）。
- **返回值可能是 Promise**：只有带 `?wait=` 的 `/tasks` 一定是 Promise（长轮询必须等），其余路由在同步 board 上同步返回。宿主统一 `await` 一次就同时兼容两种形态——这是经 Lead 同意的最小扩展，`CONTRACTS` 里的同步签名没有变。
- `null` 的语义很硬：**不是 `/adbp/v1` 开头就返回 `null`**，不抢别人的路由。

自描述清单（`GET /adbp/v1/manifest`，真机输出）：

```json
{
  "protocol": "adbp", "version": "1", "name": "agentdeck-super", "teamId": null,
  "capabilities": ["manifest", "hello", "tasks", "long-poll", "result", "chat", "state"],
  "endpoints": [
    { "method": "GET",  "path": "/adbp/v1/manifest", "auth": false, "desc": "本文件：协议自描述" },
    { "method": "POST", "path": "/adbp/v1/hello",    "auth": false, "desc": "注册成团队成员，换 token" },
    { "method": "GET",  "path": "/adbp/v1/tasks",    "auth": true,  "desc": "领活；?wait=25 时长轮询，超时返回 task:null" },
    { "method": "POST", "path": "/adbp/v1/result",   "auth": true,  "desc": "交活；同 taskId 重复提交幂等" },
    { "method": "POST", "path": "/adbp/v1/chat",     "auth": true,  "desc": "往团队里说一句话" },
    { "method": "GET",  "path": "/adbp/v1/state",    "auth": true,  "desc": "团队 / 任务 / 统计快照" }
  ],
  "auth": "hello 之后每次请求带 Authorization: Bearer <token>",
  "notes": [
    "ADBP 是拉取式协议：服务端不会主动推任务，客户端自己轮询 /tasks",
    "任务状态以服务端 board 为准，客户端重连只需带 memberId，不缓存任务",
    "长轮询无任务时返回 200 + { task: null }（等同空数组），不会 500"
  ]
}
```

四条被 Lead 点名的硬要求，实现和测试都在：

1. **自描述**：外部 Agent 只读这一个 GET 就能写客户端，不需要先看我们的源码。
2. **长轮询**：`?wait=25` 有活立刻返回；没活等到超时返回 `200 + { task: null }`（**绝不 500**，客户端不该把"暂时没活"当故障）。`wait` 会被 `maxWaitSec`（默认 30 s）夹紧。
3. **无状态重连**：token 只在 `/hello` 换一次，之后**只带 `memberId` 就能继续领活**；任务状态一律以 board 为准，ingress 内存里不留任务，进程重启后客户端照样接得上。
4. **`/result` 幂等**：同一个 `taskId` 重复提交只落一次账，第二次起返回 `{ ok: true, duplicate: true }`。两道保险——进程内 `doneResults` 集合 + 回读 board（`listTasks` 看这个任务是不是已经结束），所以**重启之后也不会重复记功**。

## 5. 最小 ADBP 客户端（三种语言，各二十来行）

三份都能直接跑，改 `BASE` 就能用。共同套路：`hello` 换 token → 循环 `tasks?wait=25` → 干活 → `result`。

### 5.1 Python（只用标准库）

```python
import json, urllib.request

BASE = "http://127.0.0.1:59710"

def call(path, body=None, token=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers=headers,
                                 method="POST" if data is not None else "GET")
    return json.load(urllib.request.urlopen(req, timeout=60))

hello = call("/adbp/v1/hello", {"name": "py-worker", "kind": "python"})
token, member = hello["token"], hello["memberId"]

while True:
    task = call(f"/adbp/v1/tasks?memberId={member}&wait=25", token=token)["task"]
    if not task:
        continue                       # 只是没活，不是错误；接着等
    print("领到：", task["title"])
    call("/adbp/v1/result",
         {"taskId": task["id"], "ok": True, "output": f"py 干完了：{task['title']}"},
         token=token)
```

### 5.2 Node（`fetch` 自带，零依赖）

```js
const BASE = 'http://127.0.0.1:59710';
const api = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};

const { token, memberId } = await api('/adbp/v1/hello', { name: 'node-worker', kind: 'node' });
for (;;) {
  const { task } = await api(`/adbp/v1/tasks?memberId=${memberId}&wait=25`, null, token);
  if (!task) continue;
  await api('/adbp/v1/result', { taskId: task.id, ok: true, output: `node 干完了：${task.title}` }, token);
}
```

### 5.3 Bash（curl + jq）

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:59710}

HELLO=$(curl -fsS -X POST "$BASE/adbp/v1/hello" -H 'content-type: application/json' \
  -d "{\"name\":\"$(hostname)\",\"kind\":\"bash\"}")
TOKEN=$(echo "$HELLO" | jq -r .token)
MEMBER=$(echo "$HELLO" | jq -r .memberId)
AUTH="authorization: Bearer $TOKEN"

while true; do
  TASK=$(curl -fsS "$BASE/adbp/v1/tasks?memberId=$MEMBER&wait=25" -H "$AUTH")
  ID=$(echo "$TASK" | jq -r '.task.id // empty')
  if [ -z "$ID" ]; then sleep 1; continue; fi          # 没活：歇一下再来
  TITLE=$(echo "$TASK" | jq -r '.task.title')
  BODY=$(jq -n --arg id "$ID" --arg out "bash 干完了：$TITLE" '{taskId:$id, ok:true, output:$out}')
  curl -fsS -X POST "$BASE/adbp/v1/result" -H "$AUTH" -H 'content-type: application/json' -d "$BODY" >/dev/null
done
```

> 没有 `jq` 就把 `jq -r .token` 换成 `python -c "import sys,json;print(json.load(sys.stdin)['token'])"`。
> 没读过 `manifest` 的话，先 `curl -s $BASE/adbp/v1/manifest | jq .`——协议就是那一个文件。

## 6. 已知限制（先写在这，免得踩了以为是 bug）

1. **Windows 位置参数传中文 prompt 会出事**：`.cmd` 走 `cmd.exe`，引号 + 中文 + 特殊字符三者凑一起会被拆碎。所以 CLI 模板优先 `stdin: true`（claude / codex / dsh 都是），gemini 只支持位置参数，长 prompt 建议写成文件让它读。
2. **本地端点必须绕代理**：Clash / V2Ray 的全局代理会把 `127.0.0.1` 也劫走。接入层对本地地址一律禁用代理，不要在 `fetch` 上再套 agent。
3. **`cdp` 依赖页面结构**：目标 App 改了 DOM（输入框选择器、发送按钮）就会 `找不到输入框`。输入框是 contenteditable 还是 textarea 由选择器兜底，实在变了就更新 `CDP_EDITOR_SEL`。
4. **`acp-http` / `cdp` 本机没有真机**：协议用假网关、假调试端口验到字段级，真机第一次接可能要在地址/token 上试两下。`openai` 同理（假服务端验的是协议，不是某家中转的怪癖）。
5. **`cli` 的退出码会原样透传**：`meta.rc` 不是 0 时 `call()` 也返回 `ok: false`，但 `err` 里是 CLI 自己的报错正文，不重写（改写会把有用信息弄丢）。
6. **ADBP 只有拉取语义**：别指望 `call()` 拿到答案；要同步问答就用 `openai` / `acp-http`。
7. **一个 base url 只握手一次**：客户端 token 缓存 10 分钟，同一进程里对同一个 `url` 不会反复 `/hello`；换端口/换地址就是新会话。
8. **Windows 环境变量大小写**：`{ ...process.env }` 快照里的 key 常是 `Path` 而不是 `PATH`，直接读 `env.PATH` 会拿到 `undefined`——于是"探测得到、执行找不到"。接入层内部统一用容忍大小写的读法（`resolveCommand` 的 `envValue`），自己传 `env` 进来也不会踩空。

## 7. 报错对照表

| 报错文案 | 真正的原因 |
|---|---|
| `连接被拒绝：端口没开、或服务没启动（ECONNREFUSED）` | 地址对、端口没人监听；或服务只监听在本机其它网卡 |
| `鉴权失败（HTTP 401）：apiKey / token 不对、或请求没带上` | key 过期 / 没带 `Authorization` / 带了但服务不认 |
| `这个地址不是 ADBP 端点（HTTP 404）：确认对方装了 agentdeck-super 并开启了 ingress` | 端口通了但不是 ADBP：路径前缀不对，或对面是普通 HTTP 服务 |
| `ADBP 握手失败（HTTP 404）：对端可能是旧版本…` | `/adbp/v1/hello` 不存在 |
| `找不到可执行文件「claude」：这台机器没装，或者它不在 PATH 里` | CLI 没装 / 装在没进 PATH 的目录（`detectAgents` 的 `extraPaths` 可以补） |
| `cdp 需要 port` / `acp-http 需要 url` / `openai 需要 baseUrl` | manifest 少了必填字段，接入面板该拦下来 |
| `等了 120s 没有给出答复` | CDP 页面还在生成，或输入没生效（提高 `timeoutMs`、检查选择器） |
| `board-unavailable`（503） | 宿主没把任务板注进来，ADBP 只能读 `/manifest` |
