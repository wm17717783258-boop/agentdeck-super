# Install on several machines, then test

Two commands per machine. No config editing, no MCP knowledge required.

---

## Step 1 — install

```
npx -y agentdeck-super@latest --all
```

Wait 1–3 minutes the first time. You are done when you see `装好了。下一步：` (installed).

Claude Code users can instead run:

```
/plugin install nexi --marketplace wm17717783258-boop/agentdeck-super
```

or type `/plugin`, search `nexi` in the panel, and click install.

## Step 2 — check this machine

```
npx -y agentdeck-super doctor
```

It prints three sections in plain language (environment / host wiring / does it actually work) and ends with a verdict:

| Verdict line | Meaning | Fix |
| --- | --- | --- |
| `结论：这台机器可以直接用。` | Ready | — |
| `还不能用 —— 宿主没接上 nexi` | Host installed, plugin not wired | re-run step 1 with `--force` |
| `还不能用 —— Node 版本太低` | Node < 22 | install Node 22+ from nodejs.org |
| `还不能用 —— 没有可用宿主` | No supported agent on this machine | install Claude Code / Codex / Gemini CLI |

The report is in Chinese by design (the author's primary audience); the verdict keywords are stable and machine-greppable: `PASS` / `FAIL`.

### If something is wrong

`doctor` ends with a box:

```
┌────────────────────────────────
│ 机器 win32/x64 · node 22.22.2
│ 版本 1.11.11
│ 宿主 claude-code=ok codex=ok cursor=没装
│ 功能 货架=ok 开单=ok 皮肤图=ok
│ 结论 PASS
└────────────────────────────────
```

Copy that whole box into the issue. No screenshots, no prose needed.

---

## Pairing two machines

Both machines must pass `doctor` first, and be on the same network.

On machine A:

```
npx -y agentdeck-super pair host
```

It prints a pairing code and a command for B. Run that command on B. Both should report success.

Then verify it is actually shared: on A say `用 team_board 建个小组叫"跨机测试"`, and on B say `看看 team_board 里有什么`. If B sees A's group, the link is real.

---

## Where files land

| Platform | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Nexi` |
| macOS | `~/Library/Application Support/Nexi` |
| Linux | `~/.local/share/nexi` |

Upgrades only move a version pointer; host config paths never change.

---

## FAQ

**Slow download in mainland China:**
```
npx --registry=https://registry.npmmirror.com -y agentdeck-super@latest --all
```

**`nexi: command not found`** — expected; `npx` installs do not touch PATH. Keep using `npx -y agentdeck-super doctor`, or call the stable launcher directly: `node "$LOCALAPPDATA/Nexi/bin/nexi.mjs" doctor`.

**Uninstall:** `npx -y agentdeck-super uninstall --all` (removes host entries only, leaves your data).

**Does `doctor` touch my data?** No. It creates an order and renders skins inside a `mkdtemp` directory, then deletes it. Guarded by `tests/cli-doctor.test.mjs`.

---

## TL;DR

```
npx -y agentdeck-super@latest --all
npx -y agentdeck-super doctor
```

Run both on every machine. If the verdict is not `PASS`, paste the box back.
