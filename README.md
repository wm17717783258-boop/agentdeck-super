# agentdeck-super · super agent + bring-your-own-agent teams + cross-machine war rooms

[![npm](https://img.shields.io/npm/v/agentdeck-super.svg)](https://www.npmjs.com/package/agentdeck-super)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> A DeepSeek Harness plugin that gives you **one agent that can actually do the work**, **a war room where any other agent can join**, and **a room your teammates can walk into from a link**.
>
> One line: `dsh plugin add agentdeck-super`

| Capability | What it means |
| --- | --- |
| 🦾 **Super agent** | Reads files, edits code, runs commands, greps repos, fetches the web, maintains a task board — an executor, not a chat window |
| 👥 **Any agent can join** | Local CLIs (claude / codex / dsh / gemini …), ACP over HTTP, any OpenAI-compatible endpoint, desktop apps via CDP, and your own agent in any language via the ADBP bridge (~20 lines) |
| 🧩 **Parallel delivery** | Splits a brief into roles (architect / coder / reviewer / tester / scribe), builds a DAG, runs lanes in parallel, requires acceptance gates, ships a real project instead of a transcript |
| 📋 **Task board** | Who is doing what, how far along, how many retries — plus an exportable run log |
| 🌐 **Cross-machine rooms** | Send a teammate an invite link: they join the *same* task board with **no install, no license, no config**. Local rooms work offline |
| 🐾 **Desk pet (your digital twin)** | Learns how you work and gets sharper each week; skins are swappable; it can visit a friend's room and hold meetings with other pets, turning conclusions into real tasks |

## Why it exists

A single agent hits three ceilings: it can only chat (no toolbelt), it can only speak for one vendor, and it can only be in one place — your window. This plugin hands it a toolbelt, teammates, and a room.

## How it differs from other team/orchestrator plugins

| | Typical team plugins | agentdeck-super |
| --- | --- | --- |
| Who can be a member | DSH sub-sessions only | **Heterogeneous**: external CLI processes, HTTP services, desktop apps, agents on other machines (ADBP) |
| Cross-machine | Usually none, or remote-controlling a single endpoint | **Multi-party rooms**: people and agents share one board; tasks, claims and completions sync both ways with mutual exclusion |
| Invites | "Ping someone on Slack" | **Invite = seat**: the room owner pays, guests join free from a link |
| Offline | Unusable | **Degrades gracefully**: no relay, local teams and the toolbelt still work |
| Setup | Model keys and config first | **Zero config**: host model by default, existing local CLIs auto-detected |
| Data | Might phone home | Board + pet profile: `$DSH_HOME/agentdeck-super/` (one copy per machine — your pet follows you across projects; override with `boardRoot`/`petRoot`) · cross-machine room sessions: `<workspace>/.agentdeck/rooms/` (a room belongs to a project) · no telemetry |

> Honest note: the ecosystem already has ~30 team/orchestration plugins and 39 pet plugins, and DSH ships Agent Teams natively. We don't claim to be first — the difference is that **heterogeneous members + multi-party rooms + invite-as-seat + pet visits** hold true at the same time.

## Install

```bash
dsh plugin add agentdeck-super                     # from npm
dsh plugin --profile dev add link:D:/agentdeck-super   # local dev checkout
```

Restart DSH; the tools show up in the agent's tool list. Type `/deck` for status.

**Prove it actually runs** (no network, no model spend):

```bash
node tests/e2e-local.mjs           # 5/5 steps: ingress / board / license / cross-machine room / offline
node tools/real-agents-check.mjs   # really invokes the claude/codex/gemini/dsh CLIs installed here
node tests/e2e-project.mjs         # two vendors' agents really ship a working module + its test (spends agent quota)
```

## Usage

**1. Let the super agent do the work**

```text
Use super_agent to add a "Quick start" section to this repo's README,
then run the tests to make sure nothing broke.
```

**2. Put any agent on the same team**

```text
Use agent_join to add the local claude and codex,
then team_orchestrate to ship this together: "add a CSV export endpoint, with tests".
```

| Transport | Good for | How |
| --- | --- | --- |
| `cli` | Agent CLIs already installed | Built-in presets: claude / codex / dsh / gemini |
| `acp-http` | ACP-speaking agents (editor family) | `url` |
| `openai` | Any OpenAI-compatible service (vLLM/Ollama gateways) | `baseUrl` / `apiKey` / `model` |
| `cdp` | GUI-only desktop apps | debug port |
| `adbp` | Your own agent, any language | below |

**3. Bring your own agent (ADBP, ~20 lines)**

```js
const BASE = process.env.ADBP_URL;
const hello = await fetch(`${BASE}/hello`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'my-internal-agent', kind: 'custom' }) }).then(r => r.json());

for (;;) {
  const { task } = await fetch(`${BASE}/tasks?memberId=${hello.memberId}&wait=25`, {
    headers: { authorization: `Bearer ${hello.token}` } }).then(r => r.json());
  if (!task) continue;
  const output = await doTheWork(task);   // your agent does the work
  await fetch(`${BASE}/result`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hello.token}` },
    body: JSON.stringify({ memberId: hello.memberId, taskId: task.id, ok: true, output }) });
}
```

**4. Work with a human teammate (cross-machine room)**

```text
/deck room create website-revamp
```

You get two forms of the same invite:

```
dsh://agentdeck/join?room=2bbc9263&t=93SqhZZi     ← they already run DSH: one click
http://<relay>/?room=2bbc9263&t=93SqhZZi          ← they don't: a join page opens
```

The web link is a real landing page for people **without** DSH: install line (`dsh plugin add agentdeck-super`), the invite code, and a plain "you're a guest, you don't need a license". Send either one — your teammate clicks it and is in the room, **without buying or configuring anything**. Tasks you create appear on their side; they claim, do the work, and it lands back on yours. Lose the relay? The local board keeps working and re-syncs later.

Self-host the relay (MIT, no payment needed):

```bash
node tools/relay-server.mjs --port 8787 --data .relay-data
# http://<your-host>:8787 serves a self-describing page; point room.relayUrl at it
# issue your own licenses: node tools/license-cli.mjs init, then export AGENTDECK_LICENSE_PUBKEY before starting the relay
```

**5. Desk pet**

```text
/deck pet
```

Learns when you start, which tools you reach for, what kinds of work you repeat; anything done 3+ times becomes a habit and shows up as "today's three things". Three free skins ship in the box; paid skins unlock through the `skins` claim in a license. Pets can visit a friend's room and hold meetings whose conclusions become board tasks.

## Tools

| Tool | When to use it |
| --- | --- |
| `super_agent` | One hands-on task (read/write/run/fetch) for the super agent to complete on its own |
| `team_orchestrate` | A multi-part project: split work, run in parallel, gate on acceptance |
| `agent_join` | Add an agent (local CLI / remote / your own) to the team, or scan what is available locally |
| `team_board` | Inspect the board: progress, failures, export the run log |
| `deck_room` | Create / join / leave a cross-machine room, send invites, sync tasks (paid tier for cloud rooms; local rooms free) |
| `deck_license` | Show or activate a license, inspect tier entitlements |
| `pet_visit` / `pet_meeting` / `pet_skin` | Visit a friend's room, hold a pet meeting, switch skins |

`/deck` is the shortcut: `/deck`, `/deck room`, `/deck license`, `/deck pet`.

## Brain configuration

Defaults to the host model (zero config). Also supports a direct OpenAI-compatible endpoint or borrowing a local CLI:

```yaml
mode: host          # host | api | cli
baseUrl: https://api.deepseek.com/v1
apiKey: ${DEEPSEEK_API_KEY}
model: deepseek-chat
cliAgent: claude
```

Automatic fallback: `host` → `api` → `cli`.

## Safety

- The plugin runs with your user permissions: it **can read/write files and execute commands**. That is the point — and the risk.
- File operations are confined to the workspace root (realpath checked).
- `shell` has a timeout and output truncation; high-risk commands require an explicit `confirm: true`.
- Every action is recorded on the task board and can be exported.
- Rooms sync **tasks and chat only** — never your files. Members of a room are trusted by default (same-team usage).
- No telemetry. The board is a single file at `$DSH_HOME/agentdeck-super/state.json`, the pet profile sits next to it, cross-machine room sessions live in `<workspace>/.agentdeck/rooms/`. Delete them to reset.

## Free vs paid

| | Free | Collab ¥29/mo (¥299/yr) | Studio ¥199/mo |
| --- | --- | --- | --- |
| Super agent + toolbelt | ✅ | ✅ | ✅ |
| Any agent can join | ✅ | ✅ | ✅ |
| Local teams / local rooms | ✅ (3 members) | ✅ (8) | ✅ (30) |
| Parallel lanes | 1 | 3 | 6 |
| **Cross-machine cloud rooms** | — | 1 | 5 |
| Paid skins | — | ✅ | ✅ |
| Unattended runs / audit export | — | ✅ / — | ✅ / ✅ |

- **Guests are free**: joining someone else's room with an invite never requires a license.
- **Self-hostable**: `tools/relay-server.mjs` is the full relay — run it yourself and issue your own keys for free.
- Entitlements are literally in [`lib/license.js`](lib/license.js); the money flow is documented in [`docs/COMMERCE.md`](docs/COMMERCE.md).

## Docs

| Doc | What's inside |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | The nine core capabilities mapped to code and evidence; retention design; roadmap |
| [`docs/COMMERCE.md`](docs/COMMERCE.md) | How to actually take money: issuing keys, message templates, support, when to build a backend |
| [`docs/MARKET.md`](docs/MARKET.md) | Store listing copy, PR body, screenshot list |
| [`docs/PUBLISH.md`](docs/PUBLISH.md) | Open-source + release checklist: repo setup, the five dry-run gates, real publish, market PR, troubleshooting |
| [`docs/host-api.md`](docs/host-api.md) | Host API shapes and the traps (read this before writing a plugin) |
| [`docs/transports.md`](docs/transports.md) | All five transports and the ADBP protocol |
| [`docs/PET.md`](docs/PET.md) | Pet profile format, habit algorithm, skin spec, visit/meeting protocol |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | Inter-module contracts (read before changing code) |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) · [`docs/VISION.md`](docs/VISION.md) | Competitive research and product vision |
| [`docs/host-api.md`](docs/host-api.md) | Measured notes on the DSH host API (host 0.2.1-rc.5): evidence E1–E6, service matrix, the four registration surfaces, degradation matrix, `ctx.llm.stream` contract, the three easiest traps, install log |
| [`docs/evidence/`](docs/evidence/) | Proof: e2e self-check, real-agent runs, two vendors' agents really shipping a project, tarball install + headless execution |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to add a new agent, test requirements, three hard rules |

**Verify it yourself** (three commands, offline, no model quota burned):

```bash
node --test --test-concurrency=1 "tests/*.test.mjs"   # 281 tests
node tests/e2e-local.mjs                              # 5-step end-to-end, writes a proof file
node tools/real-agents-check.mjs                      # actually run the agents installed on your machine
```

## Roadmap

- **1.4.1 (this release)**: fixes from real-machine acceptance — license **and pet profile** are now machine-level (`$DSH_HOME`, follows the person across projects, auto-migrated), tarball install goes through the host's own `dsh plugin add`, plus a two-vendor (Claude Code + Codex) project acceptance run.
- **1.4.0**: super agent + any-agent ingress + parallel role teams + task board + **cross-machine rooms** + **license tiers** + **pet profile/skins**.
- **1.5.0**: pet visits, pet meetings, daily standup, habit → one-click skills.
- **1.6.0**: online activation (Worker `/v1/activate`, `/v1/usage`), metered quota, remote revocation.
- **2.0.0**: team spaces — shared long-term project memory, cross-device hand-off, org permissions.

## License

Code is MIT (see [`LICENSE`](LICENSE)): use it, fork it, self-host it freely.
What's paid is our *hosted* service (relay / cloud rooms / quota) and art packs; the boundary is spelled out at the end of `LICENSE`.
Security issues: see [`SECURITY.md`](SECURITY.md) — note that an invite link *is* the credential to enter a room, by design.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
