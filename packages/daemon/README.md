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
