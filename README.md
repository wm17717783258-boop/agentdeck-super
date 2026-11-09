# agentdeck-super · super agent + bring-your-own-agent teams + cross-machine war rooms

[![npm](https://img.shields.io/npm/v/agentdeck-super.svg)](https://www.npmjs.com/package/agentdeck-super)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![repo](https://img.shields.io/badge/source-GitHub-181717.svg)](https://github.com/wm17717783258-boop/agentdeck-super)

> A DeepSeek Harness plugin that gives you **one agent that can actually do the work**, **a war room where other agents can join through a supported protocol**, and **a room your teammates can walk into from a link**.
>
> **Three ways to install — pick one**
>
> | You have | Run this |
> | --- | --- |
> | **Claude Code** | `/plugin install nexi --marketplace wm17717783258-boop/agentdeck-super` |
> | Any machine, simplest | `npx -y agentdeck-super@latest --all` |
> | Already on DSH | `dsh plugin add agentdeck-super` |
>
> **Then run `nexi doctor`** — it tells you, in plain words, whether this machine is usable;
> if not, it says exactly what is missing and prints a report you can paste back.
>
> Testing on several machines: repeat the same line on each, then run `nexi doctor` there.
> Full walkthrough: [`docs/install-and-multi-device.md`](docs/install-and-multi-device.md).

> Source (AGPL-3.0 core, Apache-2.0 adapters — see [`LICENSING.md`](LICENSING.md)): https://github.com/wm17717783258-boop/agentdeck-super

| Capability | What it means |
| --- | --- |
| 🦾 **Super agent** | Reads files, edits code, runs commands, greps repos, fetches the web, maintains a task board — an executor, not a chat window |
| 👥 **Mainstream agents can join** | Local CLIs (claude / codex / dsh / gemini …), ACP over HTTP, OpenAI-compatible endpoints, desktop apps via CDP, and your own agent in any language via the ADBP bridge (~20 lines) |
| 🧩 **Parallel delivery** | Splits a brief into roles (architect / coder / reviewer / tester / scribe), builds a DAG, runs lanes in parallel, requires acceptance gates, ships a real project instead of a transcript |
| 📋 **Task board** | Who is doing what, how far along, how many retries — plus an exportable run log |
| 🌐 **Cross-machine rooms** | Send a teammate an invite link: **guests need no license or config**, and a browser landing page explains the one-line install if they do not have DSH yet. Local rooms work offline |
| 🐾 **Desk pet (your digital twin)** | Records how you work as explicit, confirmable habits (statistics, not machine learning); skins are swappable; it can visit a friend's room and hold meetings with other pets, turning conclusions into real tasks |

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
# Any MCP host, one command after npm publication
npx -y agentdeck-super@latest --all

# DSH plugin
dsh plugin add agentdeck-super

# Offline / before npm publication: run from the unpacked delivery folder
node install.mjs --bundle .\agentdeck-super-1.11.9.tgz

# Local source checkout (development only)
node install.mjs --dev codex
```

The installer copies into a fixed home (`%LOCALAPPDATA%\Nexi` on Windows), writes the
stable launcher `<home>\bin\nexi.mjs`, and registers that launcher with every detected
host. Updates switch `current.json`; the host config path does not change.

```bash
node <home>\bin\nexi.mjs pair help       # two-machine pairing after install
node <home>\bin\nexi.mjs update --bundle .\agentdeck-super-1.11.9.tgz
node <home>\bin\nexi.mjs rollback
```

Restart the host; the tools show up in the agent's tool list. Type `/deck` for status.

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

**2. Put other agents on the same team**

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

Self-host the relay (AGPL-3.0, no payment needed):

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
| `agent_passport` | Issue / verify / list / revoke an offline Ed25519 capability card (`NEXP1.…`): works across machines with no shared key dir, optionally pinned to a `kid` |
| `team_board` | Inspect the board: progress, failures, export the run log |
| `deck_room` | Create / join / leave a cross-machine room, share invites, sync tasks (paid tier for cloud rooms; local rooms free) |
| `deck_license` | Show or activate a license, inspect tier entitlements |
| `pet_visit` / `pet_meeting` / `pet_skin` | Visit a friend's room, hold a pet meeting, switch skins |
| `twin_remember` / `twin_recall` / `twin_brief` / `twin_forget` / `twin_habit` | Digital-twin memory: store a fact with source + visibility, recall it from another host, today's brief, delete, propose a habit |
| `deck_meeting` | Multi-agent meeting: open → every agent submits its opinion verbatim → conclude with a decision and split it into board tasks |
| `deck_automation` | Scheduled or one-off jobs: approval queue, per-job run cap, global `stop` / `resume`, run log |

`/deck` is the shortcut: `/deck`, `/deck room`, `/deck license`, `/deck pet`.

**Don't want to type commands? Open `/deck/console`.** That is the test bench: every button there makes one real tool call and prints the raw return verbatim (no prettifying). Create a team, add a task, issue or verify a passport, store a memory, look at skins, open a meeting — all clickable. Under read-only mode (`mcp.readOnly`) the 6 state-changing buttons are greyed out with the reason, and the **server** blocks them too (the greyed button is a hint, not the gate).

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
- Rooms sync **task state and room events only** (chat events can travel through the relay event stream; `deck_room` has no separate `send` action) — never your files. Members of a room are trusted by default (same-team usage).
- No telemetry. The board is a single file at `$DSH_HOME/agentdeck-super/state.json`, the pet profile sits next to it, cross-machine room sessions live in `<workspace>/.agentdeck/rooms/`. Delete them to reset.

## Lending it out: read-only mode + host certification

**Read-only (`mcp.readOnly`)** — when you let someone else's model drive your local Hub, switch off the write half:

```yaml
mcp:
  readOnly: true      # default false
```

Then `tools/list` drops from 23 to 19 (`super_agent`, `team_orchestrate`, `pet_meeting` and `twin_remember` are gone entirely; `agent_passport` keeps `show`/`verify`/`list`), `team_board`'s description states which actions survive, and every write answers `isError` naming the knob to turn off — **the board file never grows**. `GET /v1/mcp` reports `readOnly: true` and lists only what is actually callable; the stdio path gets the same via `nexi mcp --read-only` or `NEXI_MCP_READONLY=1`.

**Agent passports (`agent_passport`)** — an Ed25519 capability card you can hand to someone else, verified offline by the other side:

```bash
nexi call agent_passport '{"action":"issue","name":"小犀","agent":"dsh","capabilities":["team_board","pet_visit"]}'
# → prints a NEXP1.<payload>.<sig> line; the public key travels inside the payload
nexi call agent_passport '{"action":"verify","card":"NEXP1.…"}'          # any machine, no shared key dir, no network
nexi call agent_passport '{"action":"verify","card":"NEXP1.…","kid":"kid_…"}'  # pin the issuer
```

What it proves: the card was not edited, it was issued by the holder of that `kid`, and it is still inside its validity window. What it does **not** prove: who is sitting at the keyboard. There is no CA, no real-name check and no revocation centre — so `kid` is the thing to remember, and revoking only marks your local ledger (the card still verifies on the other machine; the tool says so in plain words). Evidence: `docs/evidence/passport-1.8.0.txt`.

**Host certification (`nexi verify-host`)** — don't claim support, make the host report it:

```bash
nexi verify-host claude-code      # install → let the host confirm → uninstall → byte-exact restore
nexi verify-host --all --record   # all 8, matrix written to docs/evidence/hosts-<version>.txt
```

Measured on this machine (`docs/evidence/hosts-1.11.2.txt`):

| Host | Result |
| --- | --- |
| Codex | ✅ certified (`codex mcp list`) |
| Claude Code / Claude Desktop / Cursor / Windsurf / Cline / Continue / Gemini CLI | ⚪ not installed here — **it refuses to fake a config** |

## Free vs paid

| | Free | Collab ¥29/mo (¥288/yr) | Studio ¥99/mo (¥999/yr, 3 seats, +¥25/seat) | Business ¥30,000/yr and up |
| --- | --- | --- | --- | --- |
| Super agent + toolbelt | ✅ | ✅ | ✅ | ✅ |
| Mainstream agents can join | ✅ | ✅ | ✅ | ✅ |
| Local group rooms / seat cap | ✅ 3 / 3 | ✅ 20 / 8 | ✅ 50 / 30 | ✅ 999 / 200 |
| Parallel lanes | 1 | 3 | 6 | 10 |
| **Cross-machine cloud rooms** | — | 20 | 50 | 200 |
| Paid skins | — | ✅ | ✅ | ✅ |
| Unattended runs / audit export | — | ✅ / — | ✅ / ✅ | ✅ / ✅ |

- **Guests are free**: joining someone else's room with an invite never requires a license.
- **Business (¥30,000/yr and up)**: 200 seats, 200 cloud rooms, 10 parallel lanes, dedicated support — same `TIERS` table. Private deployment is **not implemented** and is not sold as available.
- **Self-hostable**: `tools/relay-server.mjs` is the full relay — run it yourself and issue your own keys for free.
- Entitlements are literally in [`lib/license.js`](lib/license.js); the money flow is documented in an internal operations doc (not shipped with the package).

## Docs

| Doc | What's inside |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | The nine core capabilities mapped to code and evidence; retention design; roadmap |
| [`docs/PASSPORT.md`](docs/PASSPORT.md) | Agent passports: issuing, verifying, pinning the issuing `kid`, the read-only boundary, and what a card does *not* prove |
| an internal operations doc (not shipped with the package) | How to actually take money: issuing keys, message templates, support, when to build a backend |
| 内部运营资料（上架文案，不随包发布） | Store listing copy, PR body, screenshot list |
| 内部运营资料（发布检查表，不随包发布） | Open-source + release checklist: repo setup, the five dry-run gates, real publish, market PR, troubleshooting |
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
npm test                                              # enumerates tests/*.test.mjs explicitly on Windows
node tests/e2e-local.mjs                              # 5-step end-to-end, writes a proof file
node tools/real-agents-check.mjs                      # actually run the agents installed on your machine
node tools/verify-public.mjs --provider cloudflared    # public MCP over HTTPS: healthz/401/handshake/tools
```

## Roadmap

> Current test build: **1.11.9**. The "this release" wording in older entries below is historical.

- **1.11.9 (this build)**: **the buying side moves back into the open core.** In 1.11.5–1.11.8 the whole marketplace lived in the closed layer (`pro/`), which made the revenue side a deadlock: the buyer would have to pay before paying. This build redraws the line — catalog, ledger, ordering, manual confirmation, refunds and the 80/20 split (~2100 lines) return to `lib/market/`; only seller-side tools and channel details (online billing, reconciliation, invoices, theme packs) stay closed. **This is a step back, not forward**: the open surface is larger than before, and nothing moved from open to closed. Four real defects found during self-review are fixed: (1) **two read-modify-write paths had no mutex** — when two hosts confirmed at once the later write clobbered the earlier one; measured 3 processes × 5 orders leaving 5 orders and 2 sales rows (now `withFileLock` uses an O_EXCL lock file, steals stale locks by mtime, and fails honestly instead of forcing a write); (2) **unrecognised ledger rows were dropped silently** and the next write persisted the loss (they now go into `quarantined` verbatim with a warning); (3) **`nexi rollback --help` actually rolled the install back** and `nexi pet --help` actually opened a window (any subcommand with `--help` now explains and does nothing); (4) **`.gitignore`'s `market/` pattern also swallowed `lib/market/`** — the GitHub build would have been missing an entire layer and failed on clone (now `/market/`, plus a guard rule that core sources must never be ignored). Also fixed: `place` said "sell" where it meant "buy", and the open build told users to set `AGENTDECK_PAY_*` even though that module is not installed. **Three more layers on the buyer side** (same release — "can buy" and "does the purchase count" are two different problems): (1) **ledger seal** — `orders.json` / `ledger.json` are written with an `hmac-sha256` seal (key at `market/.integrity.key`, mode 0600), so adding a purchase row in an editor is no longer a purchase: the shelf says "seal mismatch, local purchase credentials not trusted this round"; (2) **two-source cross-check** — every purchase row needs a matching `delivered` order with the same skin id and amount, which stops a hand-forged ledger on a clean machine; (3) **signed licences (ADSK1) actually wired in** — `license-cli issue --skins` codes are stored with the order, so moving to a new computer needs only that string; measured: **a one-character signature edit, `skins` rewritten to `["*"]`, an expired code, and a code signed by someone else's key are all rejected**; a refund now revokes the signed credential too (previously refunding kept the skin — a real hole). Paid SKUs go from 1 to **4** (Aurora ¥18 / Nebula ¥28 / Jade ¥38 / Ember ¥48, generated by `tools/make-skins.mjs`, every SVG id prefixed per skin so two skins on one page cannot clip each other). **The missing half of manual payment — where the money goes** — is now in: `deck_market action="payinfo"` stores payout methods (alipay / wechat / bank / paypal / stripe, up to 5) and every order carries them; without it the tool says so and prints the command instead of stalling the buyer at step one. The three-step device move is documented in `docs/PAY.md` (read the code on the old machine → `deck_license activate` on the new one → no repurchase), together with the honest boundary that **an offline signed code cannot be revoked**. One real accessibility bug fixed too: the placeholder for a locked skin hard-coded `aria-label="asset missing"`, so a screen reader announced "this skin needs a licence, ¥38" as "the skin is broken". New `tools/verify-twoinstances.mjs` runs the full cash loop across two isolated instances (separate seal keys) plus four forgeries and a refund: **28/28**. Regression: **1153 tests / 1138 pass / 0 fail / 15 skipped**, all 5 boundary rules green, public package 277 files with zero `pro/` hits.

- **1.11.8**: **the release loop actually turns — one command from "code changed" to "live on npm", no browser, no OTP**. Published for real: `npx -y agentdeck-super@latest --all`. Two new tools: `tools/release.mjs` (redact → hygiene → full tests → pack → install in a temp dir and call a real tool → publish → confirm against the registry, opt-in via `--publish`) and `tools/dev.mjs` (pack → install into every host on this machine → let each host report itself → check the written config is portable → smoke-call a tool). Publishing uses a granular token with 2FA bypass in `~/.npmrc`. **Four bugs that turned success into failure, fixed**: (1) `npm view` serves a ~5-minute CDN cache, so checking right after publish reads a stale doc (now queries the registry document directly with cache-busting); (2) npm's publish is now **asynchronous** — the PUT answers 409 "being processed" and the version shows up 1–3 minutes later (now waits instead of bailing); (3) `test-summary.mjs` only matched `ℹ tests`, not the TAP `# tests` printed on non-TTY, so a green run could read as empty; (4) `release.mjs` used `spawnSync('npm')` with `shell:false` on Windows, which ENOENTs because npm is a `.cmd` shim. Two real defects fixed too: `bin/nexi-pet.mjs` had no shebang (`Exec format error` after `npm i -g` on macOS/Linux), and `@deepseek-ai/cordis` was a hard peer while nothing imports it (now optional). Verified: **1109 tests / 1094 pass / 0 fail / 15 skipped**; installing back from the public registry gives **6/6 hosts confirming, 6/6 configs portable, 23 tools with a real call succeeding**. **Boundaries:** Zed / VS Code / OpenCode / Cursor / Windsurf / Cline / Continue are not installed on this machine — only their documented config shape was checked, so they are **not verified**; macOS and Linux are untested; npm has announced the bypass-2FA direct-publish path ends in January 2027, after which it is `stage publish` plus web approval.

- **1.11.5 (historical)**: **one-command install, atomic update, and `nexi pair` as the stable post-install test entry**. The installer now uses a fixed home and stable launcher: host configs only point at `<home>\bin\nexi.mjs`; updates switch `current.json`, keep old versions, and can roll back. Pairing state lives in `<home>\pair` so upgrades do not lose it. Verified this run: **1075 tests / 1060 pass / 0 fail / 15 skipped / 98 files**, **18/18** acceptance (two-machine simulation 28/28, real NIC 16/16, visits 39/39, meetings 41/41, portability 4/4), installer 7/7. **Boundaries:** the npm package, MCP Registry entry, and GitHub Release are not published yet; current distribution is the `.tgz` or source tree. There is no single plugin-search marketplace shared by all hosts. No second physical PC was available in this run.
- **1.11.4 (historical)**: **named multi-device seats and an admin roster**. `nexi-pair guest` now accepts `--name "person-team"` and falls back to the machine hostname; `nexi-pair members` prints the room's complete seat list; MCP `deck_room join` accepts `memberName`. Targeted regressions: `pair-tooling` 4/4 and `pair-seats` 3/3. **Boundaries unchanged:** a room is still capped at 200 seats, every device consumes one seat, and this is not an unlimited-seat control plane. No second physical PC was available in this run.

- **1.11.2**: **five self-check rounds, honest boundaries, and a release gate that cannot hide a red test**. The brain configuration path was fixed so `llm` settings are passed to `createBrain()` as flat fields (with a regression test); acceptance now keeps the complete test transcript at `docs/evidence/tests-1.11.2.txt`; the invite-recovery test no longer waits on TEST-NET timeouts. Five rounds were rerun against the isolated real DSH host with an explicit `NEXI_E2E_BASE`: **1064 tests / 1064 pass / 0 fail / 0 skipped (95 files)**, **15/15** release gates, **18/18** acceptance items, **162/162** end-to-end action assertions, **26/26** MCP stdio, **21/21** Streamable HTTP, **53/53** local HTTP payment/refund, **26/26** Stripe-shaped adapter, **11/11** red-team. Evidence: `round32-gate-console-1.11.2.txt`, `round32-acceptance-console-1.11.2.txt`, `round33-verify-all-console-1.11.2.txt`, `round34-gate-console-1.11.2.txt`, `round35-acceptance-console-1.11.2.txt`. Without an explicit host address the 15 external-host assertions skip cleanly instead of probing a fixed port. **Boundaries:** only **Codex 1/8** hosts is really certified here; the other seven are not installed; public MCP passed through a temporary Cloudflare tunnel, but no second physical PC, Windows↔Linux/macOS, real merchant charge, official hosted relay, or 24/7 hosted twin is claimed as verified.

- **1.11.1 (historical)**: **public-path acceptance is now real, and the last environment traps are fixed**. `--tunnel cloudflared` falls back to Program Files and WinGet Links when PATH is stale, and an explicitly requested but unavailable provider now fails with a readable message instead of spawning an empty command. New `node tools/verify-public.mjs --provider cloudflared` verifies `/healthz` 200, unauthenticated 401, Bearer handshake 200 and `tools/list` with 23 tools from the public side; a public relay run then joins a room with 2 members and completes claim + done. Final result: **1054 tests / 1039 pass / 0 fail / 15 skipped (93 files)**, **15/15** release gates, **18/18** acceptance items. **Boundaries:** public pairing used two independent installs on the same physical machine; a real second PC, Windows↔Linux/macOS, a live merchant charge and a 24/7 hosted twin are still not claimed as verified.

- **1.10.0 (historical)**: **meetings, visits, audit, gateway and the desktop pet move from "demoable" to "proven across real processes", plus a governance layer and end-to-end encryption**. **(a) Two real people visit each other, and the note is genuinely encrypted.** `node tools/verify-visit.mjs` runs two separate node processes with two unrelated `DSH_HOME`s and two independent Ed25519 identities: A issues an invite, B verifies the signature, accepts and returns its own card, B leaves an ask-note, A accepts it and **really lands it on the task board**. Flip one character in the token and it fails; let it expire and it fails. Each machine keeps its own half of the log. **39 assertions, all green** (`docs/evidence/visit-2user-1.10.0.txt`). **(b) Private visits are end-to-end encrypted** (the 1.10.0 hard gate): each workspace holds an X25519 identity key, the invite carries the issuer's public key, and the accepting machine derives a shared secret **without any network call or shared key directory**; the secret is run through HKDF-SHA256 and the body is sealed with **AES-256-GCM**, with the note id / kind / both public keys bound into the AAD — so swapping the header fails too. **An encrypted note carries no `payload` field at all: not one character of plaintext goes on the wire.** When it cannot be opened the receiver **refuses explicitly** (`no_box_key` / `cannot_decrypt`) rather than silently falling back to treating it as plaintext. Old plaintext notes still work. **14 unit tests plus a cross-process run** (`docs/evidence/e2ee-1.10.0.txt`). **The boundary is written down**: this is anonymous key agreement and does **not** stop a man in the middle (no CA, no out-of-band fingerprint comparison — the same level as every "scan to connect" product); signing and encryption are separate jobs done separately. **(c) Three agents hold a real meeting.** `node tools/verify-meeting.mjs` connects claude / codex / dsh as three separate processes on one project: each files an opinion, a genuine disagreement is raised, votes are cast (2:1), agenda items are resolved one by one, the meeting concludes, and **the decision really becomes 2 tasks**. It also verifies the negative case: **concluding with unresolved agenda items is blocked, and not a single task leaks out** — the governance gate works and leaves no half-finished side effects. **41 assertions, all green** (`docs/evidence/meeting-3agent-1.10.0.txt`). **(d) A 2D floating desktop pet with no Electron.** `nexi pet` uses the machine's own Edge in `--app` mode to open a **real chrome-less, tab-less window** with adjustable size, position and corner; the page is self-contained (inline SVG, zero external references, no network, no disk writes). Real-machine evidence in `docs/evidence/pet-client-1.10.0.txt`. **The boundary is written down, not glossed over**: a browser window cannot do per-pixel transparency or click-through, so this is a frameless rounded card; true transparency needs Electron or a native layered window, which conflicts with staying a lightweight plugin — so we say so instead of pretending. **(e) Action policy and audit are genuinely wired in.** Rules written to `deck_policy` are evaluated **before every tool actually executes** — a `deny`ed tool does not run (it returns one line, 【策略拒绝】), confirm-level actions require `confirm:true`, and every call appends a record that `deck_audit` can read back. `tests/policy-wiring.test.mjs` pulls `execute` straight out of the host tool belt and calls it, so what is proven is the *wiring*, not that "the engine computes correctly". **(f) Automation gained three things**: **webhook** callbacks on fire (a real HTTP server receives the POST; a failed callback never fails the job), **failure retry** (exponential backoff, counter cleared on success) and a **daily cap** (over the cap it skips for the day and records why). **(g) Twin memory gained two dimensions**: **scope** (personal/project/team/global, where global always counts) and **TTL** (expired entries stop being recalled and are swept on the next write; pinned entries never expire). **(h) An outward protocol gateway**: an OpenAPI **3.1** document plus an **A2A** agent card on root paths, where the path count in `/v1/openapi.json` and the skill count in `/v1/a2a/agent-card.json` both equal the **real tool count of 23** — so HTTP-only platforms and other agents can attach directly. **(i) One more host genuinely certified**: Gemini CLI moved from "not installed" to a **real certification** (install → host self-reports → uninstall → byte-exact restore), giving **1 certified / 0 failed on this machine (Codex; the other 7 were not installed and refused to fake configs)** on this machine; that also fixed two real bugs — judging installation purely by "does the config file exist" (which falsely reported an installed host as missing), and leaving a stray empty file behind when restoring a host whose config never existed. **(j) Quota wording is consistent again**: group rooms 3/20/50/999, meetings and automations per tier, and the business tier uses `Infinity` rather than 999; the `/deck` quota card shows real local usage. **(m) Reconciliation (new in 1.10.0)**: the last piece of real payment is not "it can pay" but **the books add up**. `deck_market action=reconcile` takes a channel statement and matches it line by line against local orders, reporting six classes of difference — missing here, missing there (possibly never actually charged), amount mismatch, state mismatch, reference mismatch, duplicate at the channel — and **only reports; it never rewrites the books**. It accepts the usual channel field names (`out_trade_no`, `transaction_id`, `total_amount`, …) and handles amounts given in yuan via `unit:"yuan"`. **It needs no merchant account to verify**: 15 unit tests plus four live tool scenarios all pass (`docs/evidence/reconcile-1.10.0.txt`). **(n) Invoice data (new in 1.10.0)**: a paid order can be turned into an invoice record with a stable number and the full set of fields (title, tax ID, amount split, tax amount, line items, channel reference), queryable and exportable; re-issuing for the same order returns the original instead of duplicating; a company title without a tax ID is refused outright. It **says plainly that it is not a tax-compliant e-invoice**, and when no tax rate is configured it writes "not configured" rather than inventing a 6% to look inclusive. 13 unit tests plus three live tool scenarios (`docs/evidence/invoice-1.10.0.txt`). **(k) How it is proven**: `node tools/verify-acceptance.mjs` now runs **18 acceptance items, 18/18 pass, 0 fail, 0 skipped** (full suite, real host, two-machine simulation, real NIC, visits, meetings, payments, recovery, packaging and portability); this round's `npm test` result is **1035 total / 1020 pass / 0 fail / 15 skipped / 88 files**, with 23 tools and 19 advertised in read-only mode. **(l) Three real bugs caught on the live host and nailed shut**: the gateway asks for `hub.list()` while the host facade only had `names()`, so `paths` came back empty (the unit tests passed because they used a fake hub that *did* have `list`, while the real host was broken); "installed but not connected" showed a green dot; and the pet window could compute negative coordinates on a small screen. Each got a regression test that **actually goes red** on the old code.
- **1.9.0**: **skin market, payments and quota — closed loops, actually run**. **(a) A new tool, `deck_market`** — `catalog` / `health` / `buy` / `orders` / `refund`. Buying walks price (in cents) → order in `orders.json` → provider receipt → ledger entry in `ledger.json` (80% creator / 20% platform split) → delivery code → the skin **really renders unlocked**; refunding reverses the ledger entry and the skin asks for a license again. **(b) No merchant account, no lying** — without `AGENTDECK_PAY_PROVIDER` + `AGENTDECK_PAY_URL` (optional `AGENTDECK_PAY_TOKEN`), `buy` returns `{ok:false, code:'billing_unconfigured', reason:'环境未配'}`, the order stays `created`, no `payment` field is written and no receipt is invented; with them configured the charge is a real HTTP POST, and only `paid === true` from the provider releases the goods; re-confirming the same order is idempotent (no second charge). That is literally what the "买 ¥18" button on `/deck` answers. **(c) Quota is computed, not claimed** — cloud rooms and seats for `free / plus / studio / business` now come straight from `TIERS` in `lib/license.js` (1.9.0 deleted the second, contradictory table and left a comment forbidding it to come back); meetings / automations / memory are metered by `lib/quota.js`; the `/deck` card shows real local usage (e.g. meetings 0/3, memory 1/200, seats 1/3); and any internal error in the quota path **lets the action through** — never block someone's work on a metering bug. **(d) Proof** — `node tools/verify-pay.mjs` starts a **real HTTP payment gateway** on `127.0.0.1`, charges over the wire, writes to disk, unlocks the skin, refuses to mark an order paid when the gateway declines, does not double-charge on re-confirm, and revokes the license after a refund: **37/37 assertions** (`docs/evidence/pay-1.9.0.txt`). Honest boundary: there is no merchant account on this machine, so "real money received" stays open — the script does not pretend otherwise. **(e)** `node tools/verify-all.mjs` now runs 7 suites (gate / readonly / passport / mcp-http / recovery / console / pay) and passes **7/7**; 520 unit tests green; 18 tools, 14 advertised in read-only mode.
- **1.7.0**: multi-agent meetings and local automation, both offline-first. `deck_meeting` opens a meeting, records every agent's opinion verbatim (no LLM in the middle), and on conclude writes the minutes plus creates the tasks on the real board — the minutes footer says opinions are kept as spoken. `deck_automation` runs scheduled or one-off jobs through an approval queue with a per-job run cap, a global `stop` / `resume` whose state lives on disk (so `nexi stop` from a terminal stops the running host's ticker on its next tick), and a run log. Both ship `output: TOOL_OUTPUT` so the host renders them instead of falling back. The count then was 16 tools, 351 tests.
- **1.8.0**: **agent passports + recovery drills**. **(a) Passports** — a new tool, `agent_passport`, that issues and verifies an Ed25519 capability card offline. `issue` mints `NEXP1.<payload>.<sig>` with the public key *inside* the payload, so the receiving machine verifies with no shared key directory, no server and no network; `kid` is derived from the public-key fingerprint, so pinning it on repeat verification answers "is this still the same issuer?"; `verify` reports machine-readable codes (`bad_signature` / `kid_mismatch` / `missing_capability` / `expired`), and the private key never leaves the issuing machine (the verifier's `show` honestly says "no identity key yet" instead of minting one). Read-only mode keeps `show`/`verify`/`list` but blocks `issue`/`revoke`, so a lent-out Hub can check a card without being able to forge one. Honest boundary: this proves tamper-resistance and key continuity, **not** personhood — there is no CA and no revocation centre, so a revoke only marks your local ledger and the card still verifies elsewhere (the tool says exactly that). Evidence: `docs/evidence/passport-1.8.0.txt` (10 live cases across two processes). **(b) Four failure drills, really run** — `node tools/verify-recovery.mjs` takes offline / crash / upgrade / migrate and performs each one: with the relay unreachable the Hub still starts and teams, tasks and memories are still written to disk (room ops fail gracefully with a human sentence); a half-sent JSON-RPC request that gets `SIGKILL`ed leaves the next process unpolluted, a `state.json` torn in half neither crashes nor loses the readable content, and eight rounds of write-then-`SIGKILL` produced **zero torn files** (atomic write holds); a low-`version` state carrying an old field is read and written back without dropping it; and moving the whole state tree to another "machine" keeps the same `teamId`, the memories and the license, while a machine that did not get the license honestly falls back to free. Evidence: `docs/evidence/recovery-1.8.0.txt` (27 assertions). **(c) One command for all of it** — `node tools/verify-all.mjs` runs every acceptance script, writes each evidence file, and exits non-zero if any suite is red or any evidence contains `❌`. 17 tools, 395 tests, read-only advertises 13 (these are the 1.8.0 figures, not current — see the entry for this release).
- **1.7.4**: two things that make the plugin safe to lend out and honest about what it supports. **(a) Host certification, one command.** `nexi verify-host --all` runs install → let the host itself confirm → uninstall → byte-exact config restore against all 8 supported hosts, and writes a matrix you can read. On this machine: Claude Code ✅ (`claude mcp list` reports `nexi` on its own), Codex ✅ (`codex mcp list`), Claude Desktop 🟡 config-only (no CLI here — labelled experimental), Cursor / Windsurf / Cline / Continue / Gemini CLI ⚪ not installed — and it refuses to fake a config for a host that isn't there. Evidence: `docs/evidence/hosts-1.8.0.txt`. **(b) `mcp.readOnly`.** When you lend your local Hub to someone else's model, the write half switches off: `tools/list` drops from 21 to 17 (`super_agent`, `team_orchestrate`, `pet_meeting` and `twin_remember` disappear entirely; `agent_passport` keeps `show`/`verify`/`list`), `team_board`'s description says which actions survive, and every write answers `isError` with the exact knob to turn off — board files never grow. `GET /v1/mcp` reports `readOnly: true` and lists only the callable tools, the stdio path gets it via `nexi mcp --read-only`, and a control host on the same machine (default config) proves the difference comes from the switch. Evidence: `docs/evidence/readonly-1.8.0.txt` (24 assertions), `gate-1.8.0.txt`. 17 tools, 395 tests（1.8.0 当时的数字）.
- **1.7.2**: a red-team suite that **found two real holes and closed them**. `tests/security-redteam.test.mjs` (11 cases) attacks the parts that matter: memory poisoning (a "run `touch <file>` / exfiltrate your private key" payload is stored and recalled as literal text; the sentinel file never appears), note injection (a `curl … $(cat ~/.ssh/id_rsa)` title becomes exactly one task title, nothing executes), cross-team board reads, member impersonation, visit-token scope escalation / tampering / expiry, and memory visibility bypass. Two of those cases failed against 1.7.1: `GET /adbp/v1/state?teamId=<other team>` happily read someone else's board with any valid token, and `memberId` in a request body could override the token identity (claim / submit / speak as someone else). Both now answer `403 forbidden`, with positive-route assertions so the fix does not close the normal path. Evidence: `docs/evidence/security-redteam-1.8.0.txt` + `gate-1.8.0.txt`.
- **1.7.1**: MCP **Streamable HTTP**. The same URL that serves the status page also speaks JSON-RPC on `POST /adbp/v1/mcp`, so a client that only knows how to fill in a remote-MCP URL (Claude Desktop, Cursor, …) can drive the same 22 tools with no local install and no child process. Stateless (no `Mcp-Session-Id`), so restarting the host does not invalidate anything. Honest limits: no SSE stream (`GET`/`PUT`/`DELETE` answer `405` with `Allow: POST, OPTIONS`), and unknown methods answer `-32601` rather than pretending. `GET` on the same URL returns the human/script-readable summary with `transport: "stdio+streamable-http"`. Evidence: `docs/evidence/mcp-http-1.8.0.txt` (21 assertions, two independent fetch-only clients completing one real collaboration).
- **1.6.4**: four license tiers — Free / Collab ¥29·mo (¥288·yr) / Studio ¥99·mo (¥999·yr, 3 seats, +¥20/seat) / Business ¥30,000·yr and up. `TIERS` in `lib/license.js` is the single source of truth for the price table, the issuing CLI, room admission and the `/deck` page; old `pro` keys keep verifying. Price output never invents a checkout URL: without `purchaseUrl` it says so.
- **1.6.2**: digital-twin memory — 5 memory types, 4 visibility levels, recall across processes, habit proposals → confirm → rollback (`twin_*` tools).
- **1.5.0**: pet visits, pet meetings, paid skins.
- **1.4.1**: fixes from real-machine acceptance — license **and pet profile** are now machine-level (`$DSH_HOME`, follows the person across projects, auto-migrated), tarball install goes through the host's own `dsh plugin add`, plus a two-vendor (Claude Code + Codex) project acceptance run.
- **1.4.0**: super agent + any-agent ingress + parallel role teams + task board + **cross-machine rooms** + **license tiers** + **pet profile/skins**.
- **Planned, not shipped** (do not read as features): a real merchant account + live webhooks for the marketplace; an official hosted relay; a 24/7 cloud-hosted twin; SSO / SCIM / private deployment; automatic multi-device discovery; remote revocation with an online authority.

## License

Core is **AGPL-3.0** (see [`LICENSE`](LICENSE)); the MCP/adapters layer and the protocol docs are **Apache-2.0** (see [`LICENSING.md`](LICENSING.md)). Use it, fork it, self-host it freely — and if you run it as a network service, publish what you changed (AGPL §13).
What's paid is our *hosted* service (relay / cloud rooms / quota) and art packs; the boundary is spelled out at the end of `LICENSE`.
Security issues: see [`SECURITY.md`](SECURITY.md) — note that an invite link *is* the credential to enter a room, by design.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)


