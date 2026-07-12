# Conclave — Personal Agent Orchestration Tool: Architecture Design

**Date:** 2026-07-12
**Status:** Approved for planning

## 1. Goal

A personal tool that orchestrates multiple coding-agent CLIs (Claude Code, Codex; Gemini later) so they can:

- Debate PRs and free-form decisions with each other and the user in shared chat threads.
- Delegate tasks to one another across machines (e.g. dev agent → deploy agent, research agent → implementation agent), including file handoff.
- Be controlled from laptop and phone.

Single user, personal infrastructure. The UI implements the Conclave design handoff (`design_handoff_conclave/`, section 4a "Black" canonical, Teal as second theme).

## 2. Constraints & standing decisions

- **Subscriptions, not APIs.** Agents run as headless CLI sessions (`claude -p --resume`, `codex exec`) using existing subscriptions. Usage limits are the budget → sequential-by-default execution, per-machine auth.
- **Thin gateway.** The CLIs own reasoning, tools, and context. We build only routing, scheduling, coordination, and UI.
- **Hub-and-spoke.** Machines never talk directly to each other; everything relays through the hub.
- **Tailnet only.** All traffic over Tailscale; nothing publicly exposed. Bearer token per device/daemon on top (revocable per machine).
- **A2A-shaped data model.** Agent cards, task states (incl. `input-required`), artifacts mirror the A2A protocol's shapes so a later transport swap is possible. Full A2A is explicitly not adopted now.
- **TypeScript everywhere.** Node hub + daemon, React web app, monorepo.

## 3. Topology

```
┌────────── container (anywhere on tailnet) ──────────┐
│  HUB — one Node/TS process                          │
│  ├─ SQLite, WAL mode (volume: /data)                │
│  ├─ HTTP + WebSocket API (one protocol,             │
│  │   client role and daemon role)                   │
│  ├─ Mailbox / threads / artifacts                   │
│  ├─ Orchestrator (debates, tasks, delegation)       │
│  ├─ Agent registry + ACLs + approvals               │
│  ├─ Web push                                        │
│  └─ Serves web app (static)                         │
└──────────────────────┬──────────────────────────────┘
                Tailscale tailnet
   ┌───────────┬───────┴──────┬──────────────┐
 daemon      daemon         laptop         phone
(machine A) (machine B)  browser/Tauri   browser/PWA
   │           │
 spawn headless CLI sessions (cwd = workspace folder)
 local MCP server bridging sessions → hub
 file RPCs (opt-in, on-machine consent)
```

- **Hub** runs in a Docker container; stateless except one mounted volume for SQLite + artifact blobs. Never touches project folders.
- **Daemons** (systemd units) connect outbound to the hub via WebSocket; auto-reconnect with catch-up ("everything after message id N"). Nothing listens on agent machines.
- **Clients**: one React web app; desktop browsers get the full Conclave three-column layout, mobile a chat-first responsive layout, installable as PWA. **Tauri desktop app** wraps the same frontend (webview → hub URL, bundled build as fallback) adding tray icon + native notifications only.

## 4. Runner: agent invocation

Each daemon owns a runner with per-runtime adapters behind one interface:

```ts
interface RuntimeAdapter {
  start(task: TaskSpec): Session          // spawn in workspace folder
  resume(sessionId: string, prompt: string): Session
  events(session: Session): AsyncIterable<Event>  // text, tool use, result, cost
  stop(session: Session): void
}
```

- `ClaudeCodeAdapter`: `claude -p --output-format stream-json --resume`.
- `CodexAdapter`: `codex exec` with JSON output / resume support.
- `GeminiAdapter`: future, out of launch scope; the interface is the contract.
- Sessions are resumable conversations, not one-shots. A debate turn = `resume(sessionId, newMessages)`. This preserves context without re-feeding transcripts and keeps subscription usage affordable.
- Concurrency: per-runtime limit of 1 per machine (configurable); daemon-side queue. Cost/usage parsed from CLI output feeds the UI usage meters.
- Every session gets one **local MCP server** (stdio) exposing hub tools: `send_message`, `check_inbox`, `wait_for_reply`, `end_thread(verdict)`, `create_artifact`, `request_approval`. The MCP server proxies to the hub over the daemon's WebSocket; CLIs never talk to the hub directly.

## 5. Data model

```
Agent      { id, name, runtime, machine, project, role, color,
             allowedTools, status, usage { windowPct, weekPct, resetsAt },
             tokens, cost }                        // "agent card"
Machine    { id, name, tailnetAddr, daemonVersion, lastSeen,
             fileAccess: none | granted(scopes) }
Workspace  { id, name, machine, folderPath, agents[], budget }
Thread     { id, kind: chat|debate|task|dm, workspace, participants[],
             state: open|input-required|settled|closed, verdicts{} }
Message    { id (monotonic), thread_id, from, to[],
             type: text|proposal|verdict|file|approval-request|status,
             body, artifacts[], ts }
Artifact   { id, name, mime, size, sha256, origin_machine, blob }
Task       { id, thread_id, spec, assignee,
             state: queued|running|input-required|done|failed, artifacts[] }
Approval   { id, task_id, action, requested_by,
             state: pending|approved|denied, decided_via }
```

- Humans are first-class participants (`from: "you"`).
- Artifacts (file handoff): uploading daemon POSTs blob to hub; receiving daemon downloads by id. Size cap ~50 MB; larger files rejected with a clear error (out of scope).

## 6. Orchestration

### Debates & decision chats
Covers PR reviews and free-form decision discussions.

- Orchestrator runs round-robin turns: each participant is `resume`d with messages since its last turn.
- Min 2 rounds (fights premature agreement), max 4 (configurable), then forced verdicts.
- Agents exit via `end_thread(verdict)`; verdict required (approve / reject / position summary). Thread settles when all participants have verdicts or round cap hits; orchestrator posts a synthesized summary.
- PR flavor: thread pre-seeded with diff — local (`git diff`) or GitHub (`gh pr diff`); GitHub-sourced debates can post the outcome back as a PR comment.
- User can interject anytime; the message simply joins the next round's context.

### Delegation
- `/task` from the user (or `send_message` from another agent, if ACL-allowed) creates a Task for a registry agent. Hub queues; target daemon picks it up, spawns the session in the agent's workspace folder, streams progress into the thread.
- Gated actions (per-agent `dangerousActions` patterns, e.g. deploy scripts): daemon pauses the session, files an Approval, hub sends web push; user approves/denies from any client; daemon resumes or aborts. Approvals are idempotency-keyed so a retried task cannot execute a gated action twice.
- Agent-to-agent chat/DM is **deny-by-default**; ACL matrix opens specific pairs (e.g. dev↔deploy), per-workspace or global.

## 7. Registry & multi-project

- `registry.yaml` on the hub volume (web-UI editing later): agents (name, runtime, machine, workspace, role prompt, allowed tools, dangerous-action patterns) + ACL pairs. Daemons pull their slice on connect; hot-reload on change.
- **AGENTS.md is canonical** per project; `CLAUDE.md` imports it, so all runtimes share instructions. The runner injects role + thread context via prompt, never by editing instruction files.
- UI: workspace = window tab (per the design); scopes chats, terminals, agents, artifacts, spend meters.

## 8. Workspace folders & file access

- **Workspace = (machine, folderPath).** Creation flow: pick machine → browse its filesystem via the daemon → select folder.
- Daemon file RPCs, tunneled through the hub: `listDir`, `readFile`, `writeFile`, `stat`.
- **Default deny + on-machine consent.** Daemons ship with file RPCs disabled. Enabling requires an action on the machine itself (`conclaved grant files --workspace <path>`, or local config edit). Grants are per-machine and per-scope: specific workspace roots, or a time-limited machine-wide grant for the browse-and-pick flow. The hub cannot grant itself access; UI shows "file access: not granted on this machine" until granted. A compromised hub or stolen client token cannot read arbitrary files.
- Outside the browse flow, RPCs are path-jailed to granted workspace roots.
- Web app: per-workspace file tree, single-file viewer/editor (CodeMirror, syntax highlighting), save writes back through the daemon. Not an IDE: no LSP, no cross-file search at launch. File links in chat (`path/file.ts:41`) open here.
- Edits are user actions — no approval gate, but every write is logged as a status message in the workspace thread.

## 9. Web app & Tauri shell

- React + Vite. Implements the handoff pixel-faithfully: Black (default) + Teal themes as CSS-variable token sets, IBM Plex Sans / JetBrains Mono, five regions (window tab strip, sidebar, session tabs, group chat, status strip). Mobile: chat-first, drawers for sidebar/status.
- "Terminals" are **read-only streams** of headless session output (stream-json rendered log). Interactive PTYs are future work; the design's "take over" affordance maps to sending a message / opening an approval.
- One WebSocket protocol for daemons and clients (role-differentiated). Web push for: approval requests, thread settled, task failed, usage threshold crossed.
- Tauri: webview onto the hub URL, tray + native notifications. Nothing else Tauri-specific at launch.

## 10. Error handling & resilience

- Daemon offline → agents marked `unreachable`, tasks queue; catch-up replay on reconnect via monotonic message ids.
- CLI crash / usage-limit → task `failed` with stderr tail in-thread. Usage-limit errors detected specially → "rate-limited until HH:MM" status. Debates continue without a dead participant when remaining verdicts suffice, else settle `inconclusive`.
- Hub restart → all state in SQLite; daemons reconnect and resume. In-flight CLI sessions keep running; daemons buffer output until reconnect.

## 11. Testing

- Unit (Vitest): envelope schema, ACL matrix, debate state machine (min/max rounds, dead-participant settlement), path-jail logic.
- Integration: **fake adapter** (scripted CLI stand-in) so orchestration tests never burn subscription quota; full debate and delegation flows run against it in CI.
- One smoke test per real adapter behind a manual flag.

## 12. Build order

Each step independently usable:

1. Monorepo + hub skeleton: mailbox, SQLite, WS/HTTP API, envelope schema.
2. Daemon + Claude Code adapter + MCP bridge (single machine; drive an agent via curl).
3. Codex adapter + debate orchestrator (agents argue in a thread).
4. Web app MVP: chat, threads, status (Black theme).
5. Multi-machine: Docker packaging (hub), systemd packaging (daemon), artifacts, delegation tasks, workspace browse-and-pick with on-machine grants.
6. ACLs + approvals + web push.
7. UI completion: terminals view, usage meters, file viewer/editor, Teal theme, mobile layout, Tauri shell.

## 13. Out of scope (explicit)

- API-key usage of any model provider.
- Full A2A protocol adoption (data model mirrored only).
- Interactive PTY terminals in the UI.
- LSP / cross-file search / IDE features in the file viewer.
- Artifacts > ~50 MB.
- Multi-user auth, tenancy, or public exposure.
- Gemini adapter (interface reserved).
- Telegram bot (superseded by web push decision).
