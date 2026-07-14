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
  - id: codex
    name: codex
    runtime: codex
    machine: my-laptop
    workspace: /home/me/proj
```

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
