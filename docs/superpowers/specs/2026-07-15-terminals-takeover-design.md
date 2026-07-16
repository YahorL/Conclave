# Terminals 7.2 — Take-Over (design)

Date: 2026-07-15
Status: approved (user: "proceed")
Step: build-order step 7, sub-project 2 of 2 (7.1 = PTY foundation, merged a212311)
Parent specs: docs/superpowers/specs/2026-07-12-conclave-architecture-design.md §8a; docs/superpowers/specs/2026-07-15-terminals-pty-foundation-design.md

## Goal

"Take over" a headless agent session: from the thread you're viewing, open an
**interactive** PTY resumed from that agent's CLI session (`claude --resume <id>`
/ `codex resume <id>`), reusing the 7.1 terminal machinery. Never hijacks the
running headless process — always a new, independent PTY.

## User-approved decisions

1. **Trigger:** a "take over" affordance in the thread's context toolbar; resumes
   the agent(s) that participated in THAT thread (session is per `(thread, agent)`).
2. **No stored session → fresh interactive session** (spawn the TUI without resume
   args). Take-over never dead-ends.
3. **Always available**, regardless of agent status (running/idle/blocked). The
   resumed TUI is a separate process; it does not touch the headless run.

## Key constraint that shapes everything

The CLI session id lives ONLY in the daemon's `DaemonState`, keyed by
`(threadId, agentId)` (`packages/daemon/src/daemon-state.ts` `getSession`). The
hub and web never see it. So take-over sends `(machine, agentId, threadId)`; the
**daemon** resolves locally:
- cwd + runtime from its own agent registry (`AgentConfig.workspace` / `.runtime`),
- session id from `DaemonState.getSession(threadId, agentId)`,
then spawns an interactive PTY with the runtime-specific resume args.

Resume args (verbatim from the existing adapters): `claude` →
`["--resume", <id>]` (claude-adapter.ts:25), `codex` → `["resume", <id>]`
(codex-adapter.ts:17). No session id → `[]` (fresh session).

## Out of scope

- Multi-agent "take over all participants" in one click (per-agent only).
- Any change to how headless sessions run or how session ids are stored.
- Persisting take-over terminals across daemon restart (7.1 terminals are
  in-memory; unchanged).

## Components

### shared: `packages/shared/src/terminal.ts` (extend)

- New hub→daemon frame:
  ```ts
  export const TermTakeoverFrameSchema = z.object({
    type: z.literal("term-takeover"),
    agentId: z.string().min(1),
    threadId: z.string().min(1),
  });
  ```
  Add it to `TermToDaemonFrameSchema` (the discriminated union the daemon parses).
- New REST body schema:
  ```ts
  export const TakeoverTerminalSchema = z.object({
    machine: z.string().min(1),
    agentId: z.string().min(1),
    threadId: z.string().min(1),
  });
  ```
- `TerminalKind` is unchanged: a take-over terminal is still `claude` or `codex`.
  Take-over is distinguished by an `agentId` (already on `TerminalInfo`) plus the
  ⇄ label (below), not by a new kind.

### daemon

- **`TerminalService.spawn` (terminal-service.ts) — extend the argument object**
  to `{ kind, cwd, resumeSessionId?, takeover? }`:
  - Build pty args: `resumeSessionId` present →
    `kind === "claude" ? ["--resume", resumeSessionId] : ["resume", resumeSessionId]`;
    absent → `[]`. Pass these as the `node-pty` `spawn(bin, args, …)` second arg
    (7.1 currently passes `[]`).
  - Label: `takeover` truthy → `` `${kind} ⇄ ${basename(cwd)}` ``; else the
    existing `` `${kind} · ${basename(cwd)}` ``. (Take-over always sets
    `takeover: true`, whether or not a session id was found — the ⇄ marks intent.)
  - Everything else (ring buffer, events, jail, childEnv) is unchanged.
- **`wireTerminals` (terminal-wiring.ts) — new dep + branch.** Add
  `resolveTakeover?: (agentId: string, threadId: string) => { kind: TerminalKind; cwd: string; resumeSessionId?: string } | null`
  to its deps. On a `term-takeover` frame: if no service/grant → `term-error`
  (same as spawn); else `const r = resolveTakeover?.(f.agentId, f.threadId)`;
  `null` → `term-error "unknown agent: <id>"`; otherwise
  `service.spawn({ kind: r.kind, cwd: r.cwd, resumeSessionId: r.resumeSessionId, takeover: true })`.
  The `list-changed` event emits the updated `term-list` as usual.
- **`main.ts` — build `resolveTakeover`** from the already-available `agents`
  list + `DaemonState`:
  ```ts
  resolveTakeover: (agentId, threadId) => {
    const a = agents.find((x) => x.id === agentId);
    if (!a) return null;
    const kind = a.runtime === "claude-code" ? "claude" : a.runtime === "codex" ? "codex" : null;
    if (!kind) return null;
    return { kind, cwd: a.workspace, resumeSessionId: state.getSession(threadId, agentId) };
  }
  ```
  (`state` is the `DaemonState` already constructed in main.ts.) cwd is the
  agent's own workspace — take-over does NOT go through the grant-root cwd
  picker, but `TerminalService.spawn` still `resolveJailed`s it, so the agent's
  workspace must be a granted file root (document in DEPLOY.md).

### hub

- **`POST /api/terminals/takeover`** (server.ts, next to the existing
  `/api/terminals` routes): parse `TakeoverTerminalSchema` (400 on bad body);
  `machines.get(machine)` → 503 unreachable; `!conn.terminals` → 403 not granted;
  else relay `{ type: "term-takeover", agentId, threadId }` to the daemon socket
  and reply `202 { ok: true }`. Same shape/precedence as `POST /api/terminals`.
- No `TerminalRegistry` change — the resulting terminal arrives via the normal
  daemon `term-list` broadcast.

### web

- **`hubClient.takeoverTerminal(machine, agentId, threadId)`** →
  `POST /api/terminals/takeover` (returns `{ ok }`).
- **Auto-open the resulting terminal.** Take-over spawn is async (202, terminal
  arrives later via `term-list`). Keep a `pendingTakeover: { agentId: string;
  since: number } | null` in the store (set on click). When a `terminal-list`
  frame arrives, if there is a pending take-over and the new list contains a
  terminal with that `agentId` that was NOT in the previous list, `setActiveTerminal`
  it and clear the pending marker. (Match on agentId + "new since last list";
  if several arrive, take the newest by `startedAt`.) A stale pending marker
  (no matching terminal within a few list updates) is harmless — it clears on
  the next matching take-over or can be dropped after a timeout; keep it simple:
  clear it as soon as any matching new terminal appears.
- **`ContextToolbar` (ContextToolbar.tsx) — the take-over control.** It already
  has the active `thread`. Candidate agents = `thread.participants` minus `"you"`,
  intersected with the store's `agents` (need each agent's `machine`). Render a
  ⇄ "take over" control:
  - 0 candidates → hide it.
  - 1 candidate → a single button (testid `takeover`), label e.g. `⇄ take over`.
  - ≥2 candidates → a small menu (testid `takeover`, items `takeover-<agentId>`).
  - Click an agent → `hubClient.takeoverTerminal(agent.machine, agent.id,
    thread.id)`, set `pendingTakeover`, and surface REST errors the same way the
    spawn picker does (an inline notice via the `term-error` path already exists
    in `TerminalsSection`; a `.catch` on this call should set a visible message —
    reuse the existing error surface or a local toast).
  - Prefer to show only candidates whose machine has terminals granted (store's
    `machines` list, `m.terminals`), mirroring the spawn picker. BUT `machines`
    is currently hydrated lazily (only when the Files sidebar opens), so this
    filter would hide the control until then. Fix: add a `listMachines()` fetch
    to `sync.ts` `hydrate()` so grant info is app-wide from load. Fallback: if
    `machines` is still empty (pre-hydrate), show all participant candidates and
    let a 403 surface inline — never hide the control purely because machine
    grants haven't loaded.

## Data flow

user in thread → ContextToolbar ⇄ → pick agent → POST /api/terminals/takeover
{machine, agentId, threadId} → hub 202 + relay `term-takeover` → daemon
`resolveTakeover` → `TerminalService.spawn({kind, cwd, resumeSessionId, takeover})`
→ `<bin> --resume <id>` (or fresh) PTY → `term-list` broadcast → web auto-opens
the new terminal tab → normal 7.1 attach/stream/kill from there.

## Error handling

- Unknown/absent machine → 503; terminals not granted → 403; bad body → 400
  (hub, before relay).
- Unknown agent id, or an agent whose runtime is neither claude-code nor codex
  → daemon `term-error "unknown agent: <id>"` (broadcast, shown inline). The
  202 has already returned, so the UI learns via the error frame + absence of a
  new terminal.
- Agent workspace not a granted file root → `TerminalService.spawn` throws
  `PathJailError` → `term-error` (caught in `wireTerminals`). Documented as an
  operator requirement in DEPLOY.md.
- No stored session id → fresh interactive session (not an error), per decision 2.

## Testing

- **daemon TerminalService** (fake `PtyModule` capturing `(file, args)` — no real
  CLIs): `resumeSessionId` + kind `claude` → args `["--resume", id]`; kind
  `codex` → `["resume", id]`; absent → `[]`; `takeover: true` → ⇄ label. This is
  the core correctness test and needs no real `claude`.
- **wireTerminals**: `term-takeover` with a resolver returning a claude target →
  `service.spawn` called with the right `{kind, cwd, resumeSessionId, takeover}`;
  resolver returning `null` → `term-error`; no grant → `term-error`. (Fake
  service capturing spawn calls.)
- **hub**: `POST /api/terminals/takeover` → 400/503/403/202 and relays a
  `term-takeover` frame to the daemon socket (fake daemon ws, as the 7.1 hub
  tests do).
- **web**: `ContextToolbar` renders the control only with ≥1 granted candidate;
  single vs menu; click calls `takeoverTerminal(machine, agentId, threadId)`;
  the auto-open store logic activates a newly-appeared terminal matching a
  pending take-over's agentId.
- **Honesty note:** unit/integration tests prove the resume ARGS and the
  spawn/relay plumbing. That a real `claude --resume <id>` actually restores the
  prior conversation is **manual smoke only** — the DEPLOY.md checklist gains a
  take-over step; never claim resume-fidelity from these tests.

## Risks

- Resuming a session file the headless run is still appending to could confuse
  the CLI (accepted per decision 3; it's a separate process and rare). Note it
  in DEPLOY.md.
- `resolveTakeover` maps runtime→kind by string (`"claude-code"`→`claude`,
  `"codex"`→`codex`); a new runtime would return `null` (no take-over) rather
  than mis-spawn — safe default.
