# @conclave/daemon

Watches the hub; when a message @-addresses one of this machine's agents,
spawns a headless Claude Code turn in the agent's workspace and posts the
reply back. Sessions resume per (thread, agent). Each turn gets an MCP
bridge (`hub` server: send_message / check_inbox / wait_for_reply /
end_thread).

## Run

CONCLAVE_HUB_URL=http://127.0.0.1:7777 CONCLAVE_TOKEN=dev \
CONCLAVE_MACHINE=dev-box npx pnpm --filter @conclave/daemon dev

Env: CONCLAVE_HUB_URL, CONCLAVE_TOKEN, CONCLAVE_MACHINE (required) ·
CONCLAVE_CLAUDE_BIN (default `claude`) · CONCLAVE_STATE_FILE (default
`./daemon-state.json`) · CONCLAVE_ALLOW_AGENT_TRIGGERS (default 0 — agents
only respond to "you")

## Registry

Agents live in `registry.yaml` in the hub's data dir:

    agents:
      - id: claude-code
        name: Claude Code
        runtime: claude-code
        machine: dev-box
        workspace: /abs/path/to/project
        role: "You are the primary dev agent."
        allowedTools: [Read, Grep, Glob]

## Smoke test (manual — burns real quota)

1. Hub: `CONCLAVE_TOKEN=dev npx pnpm --filter @conclave/hub dev` (with a
   registry.yaml in its data dir as above, machine matching yours)
2. Daemon: as above
3. Create a thread and @ the agent:

       curl -s -X POST localhost:7777/api/threads -H "Authorization: Bearer dev" \
         -H "Content-Type: application/json" \
         -d '{"kind":"chat","participants":["you","claude-code"]}'
       curl -s -X POST localhost:7777/api/threads/<ID>/messages \
         -H "Authorization: Bearer dev" -H "Content-Type: application/json" \
         -d '{"from":"you","to":["claude-code"],"body":"Introduce yourself and use send_message to say hi twice."}'
       curl -s "localhost:7777/api/threads/<ID>/messages?after=0&wait=60" \
         -H "Authorization: Bearer dev"

Expect the agent's reply (and any extra send_message posts) in the list.

## Debates

Start one (agents must be registered and their daemon running):

    curl -s -X POST localhost:7777/api/debates \
      -H "Authorization: Bearer dev" -H "Content-Type: application/json" \
      -d '{"topic":"Review branch feat/x in your workspace: should we merge? Use git diff main...feat/x.","participants":["claude-code","codex"],"minRounds":2,"maxRounds":4}'

    curl -s "localhost:7777/api/threads/<threadId>/messages" -H "Authorization: Bearer dev"

The orchestrator assigns stances (advocate / skeptic / risk-reviewer), drives
round-robin turns via websocket turn frames, forces verdicts after maxRounds,
and posts a summary. Codex agents run `codex exec --json --sandbox
workspace-write -c approval_policy=never` (set `CONCLAVE_CODEX_BIN` to
override the binary).

## Known limitations

Debate turn requests are ephemeral `/ws` control frames — they are not
persisted or replayed across daemon restarts (catch-up only replays messages,
never turns). If this machine's daemon is disconnected or restarting when the
orchestrator emits a turn for one of its agents, that turn is dropped; the
orchestrator eventually stamps it `no-response (timeout)` rather than resuming.

## Manual smoke checklist (burns real quota — run deliberately)

1. Claude turn: README steps above (step-2 smoke) still pass.
2. Codex turn: same flow with a codex agent — verifies `approval_policy=never`
   actually suppresses approvals in exec mode (unverified against a live turn
   so far) and that the MCP bridge connects via `-c mcp_servers` overrides.
3. `wait_for_reply` inside a real debate turn: confirm the CLI's MCP tool
   timeout tolerates the 60s long-poll (Claude: MCP_TOOL_TIMEOUT env;
   Codex: `-c mcp_servers.hub.tool_timeout_sec=90` if needed).
4. Two-agent debate with real CLIs and minRounds=1, maxRounds=2 on a toy topic.
5. Web app (step 4): with a debate running, open the web client
   (`packages/web/README.md`) and confirm the group chat, sidebar agents with
   live status dots, and the right-rail live-status/usage all update as agents
   take turns. Optional pixel diff vs section 4a via `packages/web/e2e/visual.spec.ts`.
6. Delegation (step 5): `POST /api/tasks` (or `/task @agent <spec>` from the web
   composer) for a registry agent. Confirm the daemon picks it up (`running`), the
   agent works in its workspace, the result posts to the task thread, and the task
   ends `done` (or `failed` with the reason in-thread). Then create a task while
   the daemon is stopped and start it — task catch-up on connect should pick up the
   `queued` task and complete it. Verified locally end-to-end with the codex fake
   adapter: `CONCLAVE_CODEX_BIN=<fake> npx tsx packages/daemon/src/main.ts` →
   `queued → running → done`, exactly one adapter spawn, result posted in-thread.
   NOTE: run exactly one daemon per machine — two daemons for the same agent both
   claim the task; the loser hits the hub's `running→running` transition guard
   (no double completion, but a spurious `failed` status is posted).
