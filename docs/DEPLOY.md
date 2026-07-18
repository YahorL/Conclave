# Deploying Conclave

Conclave has two pieces:

- **Hub** — the central server (HTTP/WebSocket API + SQLite) that also **serves the web app**. Runs anywhere; containerized here.
- **Daemon** — runs **on each machine where your agents live**. It owns file access and spawns the `claude` / `codex` CLIs, so it needs that host's filesystem, the real CLI binaries (with their auth), and on-machine grants. Run it directly on the host — it is intentionally not containerized.

## 1. Run the hub (Docker)

```bash
# a strong shared secret; clients and daemons both use it
export CONCLAVE_TOKEN=$(openssl rand -hex 16)

docker compose up -d --build
# → hub on http://localhost:7777, web app included
```

Open `http://localhost:7777`. The token is injected into the served page at
runtime (no rebuild needed to set or rotate it — restart the container after
changing `CONCLAVE_TOKEN`).

> **Security note:** because the token is embedded in the served page, *anyone
> who can load the web app can use the full API* — the token only protects
> against clients that can't reach the page. The compose file therefore binds
> to `127.0.0.1` by default. Only expose the port on networks where every
> client is trusted (your tailnet, a firewalled LAN) — never the open internet.

State (SQLite db + your agent registry) lives in the `conclave-data` volume,
mounted at `/data`. Put your agent registry at `/data/registry.yaml` (see below).

Config (env):

| Var | Default | Purpose |
| --- | --- | --- |
| `CONCLAVE_TOKEN` | — (required) | shared auth secret for clients + daemons |
| `CONCLAVE_BUDGET_USD` | `25` | workspace spend budget shown in the UI |
| `CONCLAVE_PORT` | `7777` | hub port inside the container |

### HTTPS (PWA / web push)

The container serves plain HTTP. For a real deployment put it behind TLS — the
simplest is Tailscale on the host: `tailscale serve https / http://localhost:7777`
gives a valid cert for your tailnet hostname. Install the PWA from the HTTPS origin.

## 2. Register agents

The hub reads agents from `registry.yaml` in its data dir (`/data/registry.yaml`).
Example:

```yaml
agents:
  - id: claude-code
    name: claude-code
    runtime: claude-code
    machine: my-laptop        # must match a daemon's CONCLAVE_MACHINE
    workspace: /home/me/proj
    role: implementer
    limits:              # optional: enables the 5h/weekly rate-limit meters
      window5hTokens: 2000000
      weeklyTokens: 20000000
  - id: codex
    name: codex
    runtime: codex
    machine: my-laptop
    workspace: /home/me/proj
```

> **Rate-limit meters:** `limits` drives the 5h/weekly window meters in the
> status strip. The percentages are estimates against caps *you* configure —
> subscriptions don't expose their quotas — and they count only usage Conclave
> observed (turns run directly in a CLI outside Conclave don't appear). The
> weekly meter is a trailing 7-day window, not calendar-anchored.

> **Editing files:** the web file viewer is an editor — saves write through the
> daemon (jailed to granted roots) and are logged as an `edited <path>` status
> message in the active thread. Unsaved edits are discarded when you navigate
> away (the file tree and chat links warn; other navigation doesn't).

## 3. Run a daemon on each machine

On every machine named in the registry (needs Node 22+ and the agent CLIs
installed + authenticated):

```bash
git clone <repo> conclave && cd conclave
npx pnpm install

# grant file access to the workspace roots you want browsable/editable (on-machine consent)
npx tsx packages/daemon/src/cli.ts grant /home/me/proj

CONCLAVE_HUB_URL=http://<hub-host>:7777 \
CONCLAVE_TOKEN=<same token as the hub> \
CONCLAVE_MACHINE=my-laptop \
CONCLAVE_GRANTS_FILE=./conclave-grants.json \
npx tsx packages/daemon/src/main.ts
```

The daemon connects to the hub over the WebSocket, reports its granted roots,
answers file-RPC requests (path-jailed to those roots), and runs delegated
tasks/debates in the agents' workspaces.

Daemon env:

| Var | Default | Purpose |
| --- | --- | --- |
| `CONCLAVE_HUB_URL` | — (required) | hub URL |
| `CONCLAVE_TOKEN` | — (required) | must match the hub's token |
| `CONCLAVE_MACHINE` | — (required) | this machine's id (matches the registry) |
| `CONCLAVE_GRANTS_FILE` | `./conclave-grants.json` | on-machine file-access grants |
| `CONCLAVE_CLAUDE_BIN` / `CONCLAVE_CODEX_BIN` | `claude` / `codex` | override CLI binaries |

Keep exactly **one daemon per machine** — two daemons for the same agent both
claim a delegated task (the loser hits the hub's transition guard).

## Notifications (web push)

Enable via the bell toggle at the bottom of the live-status strip. Requires a
secure context: `http://localhost` works as-is; any other origin needs the
HTTPS setup above (Tailscale serve). **iOS:** install the PWA first (Share →
Add to Home Screen from the HTTPS origin) — iOS only delivers web push to an
installed app.

You'll be notified when: an agent requests approval, a task fails, a thread
settles, or an agent hits its usage limit. Clicking a notification opens the
relevant thread.

VAPID keys are generated on first hub boot and stored at `/data/vapid.json`.
Deleting that file rotates the keys and silently invalidates every existing
subscription — everyone must re-enable via the bell.

### Manual smoke checklist (run after deploying; automated tests cannot cover delivery)

1. Open the app, click the bell (grant the browser permission) → it reads "notifications on".
2. Close the tab entirely. File a test approval from a terminal:
   `curl -s -X POST -H "Authorization: Bearer $CONCLAVE_TOKEN" -H "content-type: application/json" -d '{"threadId":"<an open thread id>","requestedBy":"<an agent id>","action":"smoke test — ignore","idempotencyKey":"smoke-1"}' http://localhost:7777/api/approvals`
3. A "Approval needed" notification appears on the device → click it → the app opens focused on that thread.
4. Deny the approval in the UI (cleanup). Bell → "notifications off" unsubscribes.

## Terminals

Terminals are real PTYs spawned by the **daemon** (node-pty), streamed through the
hub, and rendered in the web app. Default deny — enable per machine, on the machine:

```bash
npx tsx packages/daemon/src/cli.ts grant-terminals
# and make sure at least one folder is granted; spawn cwds start under granted roots
npx tsx packages/daemon/src/cli.ts grant /home/me/proj
```

Turn the capability back off with `npx tsx packages/daemon/src/cli.ts revoke-terminals`
(then restart the daemon).

Requirements on the daemon machine: build tools for node-pty (python3, make, g++ —
same set better-sqlite3 needs). If node-pty fails to build, the daemon still runs;
terminals just show as unavailable.

> **Security note:** anyone who can reach the web app gets an interactive shell
> running as the daemon's user on every machine that granted `terminals`; the
> granted folders only constrain where the shell *starts*, not what it can reach.
> Grant it only on machines you're comfortable exposing to everyone on the hub's
> network. Keep the hub localhost/tailnet-only.

Manual smoke checklist (record the result; automated tests cover spawn/route/replay,
not real TUI fidelity):

1. `grant-terminals` on a daemon machine, restart the daemon.
2. Web sidebar → TERMINALS → `+` → pick machine/shell/folder → spawn.
3. Type `ls`, see output; resize the window; check reflow.
4. Close the tab, reopen the terminal row — scrollback replays.
5. Spawn a `claude` terminal — the TUI renders and takes keystrokes.
6. Kill from the header — row disappears.

### Take over a headless session

An agent that has run headless in a thread can be "taken over": open its context
toolbar (⇄ take over) to launch an interactive `claude --resume <session>` /
`codex resume <session>` in a real terminal, continuing that conversation by hand.

Requirements: the agent's `workspace` must be a **granted file root** on its
machine (`grant <workspace>`), in addition to `grant-terminals`. Take-over opens
a **new, independent** terminal — it never interrupts the running headless
process; resuming a session the agent is still actively writing opens a parallel
view of it. If the agent has no stored session for that thread yet, take-over
starts a fresh interactive session in the workspace instead.

Manual smoke (automated tests cover the resume ARGS and plumbing, not that the
CLI actually restores the conversation): run a headless turn for an agent in a
thread, then ⇄ take over → confirm the resumed TUI shows the prior context.

## Mobile layout

Below 768px the web app renders a bottom-tab mobile shell (Workspace · Chats ·
Terminals · Status) instead of the desktop three-column layout — same hub URL, no
extra setup; add it to the home screen via the existing PWA manifest. Notes:

- The Chats tab badge counts threads with pending approvals (Conclave has no
  read/unread tracking).
- Terminal take-over is desktop-only for now: its entry point (the context
  toolbar's ⇄ button) is not rendered on mobile. Agent terminals opened from the
  Terminals tab are still fully interactive.
- Epic Mode / Fork (context toolbar) are likewise desktop-only.
- Navigating away from an unsaved editor via the tab bar discards edits silently
  (same documented limitation as desktop navigation); the in-editor back button
  asks for confirmation.

Manual smoke on a real phone/browser (four tabs, chat/terminal/editor flows,
rotation across 768px, safe areas, Teal) has NOT been run — no browser in the
build sandbox.
