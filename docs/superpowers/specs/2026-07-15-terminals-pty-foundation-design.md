# Terminals 7.1 — PTY Foundation (design)

Date: 2026-07-15
Status: approved (user: "looks good")
Step: build-order step 7, sub-project 1 of 2 (7.2 = take-over from headless sessions, separate spec)
Parent spec: docs/superpowers/specs/2026-07-12-conclave-architecture-design.md §8, §8a, §9

## Goal

Real interactive terminals in the web app: daemon-spawned PTYs (plain shells and
`claude`/`codex` TUIs), streamed through the hub, rendered with xterm.js, gated by a
new on-machine `terminals` grant. Tmux-style: terminals survive client disconnects and
are re-attachable with scrollback replay.

## User-approved decisions

1. **Decomposition:** two sub-projects. 7.1 (this spec) = PTY foundation end-to-end,
   including agent TUIs (a TUI is just a PTY running `claude`/`codex`). 7.2 = take-over
   (`claude --resume <session-id>`) later, building on 7.1.
2. **Transport:** the existing single `/ws` connection per client/daemon, new JSON frame
   types with base64-encoded byte chunks. No new endpoints, no binary frames. The ~33%
   base64 overhead is irrelevant at TUI output rates.

## Out of scope (7.1)

- Take-over from headless agent sessions (7.2).
- The embedded terminal-card-in-chat from the design mock (belongs with headless output
  streaming, later).
- Terminal persistence across daemon restarts (PTYs and ring buffers are in-memory; a
  daemon restart ends all its terminals).
- Mobile drawer polish (step 8); the terminal view should still render on small screens.
- Per-terminal ACLs — terminals are user-driven sessions; agents cannot spawn or attach
  to them in 7.1.

## Security model

- New `terminals` capability in the daemon grants file, **default deny**, granted only
  by on-machine CLI action: `conclave-daemon grant-terminals` / `revoke-terminals`.
  Grants file shape becomes `{ "files": string[], "terminals": boolean }` (absent key =
  false; existing files-only grant files stay valid).
- Spawnable working directories are the machine's **granted file roots** (same path
  jail as fs RPCs, `GrantStore.resolveJailed`). No file roots ⇒ nothing to spawn, even
  with the terminals capability on.
- The daemon reports the capability in its `hello` frame; the web UI shows spawn
  affordances only for machines that granted it.
- The hub never interprets terminal bytes — it routes frames by terminal id. All
  terminal REST/WS traffic sits behind the existing bearer-token auth. Trust model
  unchanged: single shared token; anyone with the token gets a shell on granted
  machines — this is the documented Conclave trust boundary (localhost/tailnet only),
  now with strictly higher stakes, so DEPLOY.md must call it out.

## Components

### shared: `packages/shared/src/terminal.ts`

```ts
export const TerminalKindSchema = z.enum(["shell", "claude", "codex"]);
export const TerminalInfoSchema = z.object({
  id: z.string().min(1),          // daemon-generated, e.g. "term-<random>"
  machine: z.string().min(1),
  kind: TerminalKindSchema,
  label: z.string().min(1),       // "zsh · you", "claude · conclave"
  cwd: z.string().min(1),
  agentId: z.string().optional(), // owning agent for claude/codex rows (color in UI)
  startedAt: z.string(),          // ISO
});
export const SpawnTerminalSchema = z.object({
  machine: z.string().min(1),
  kind: TerminalKindSchema,
  cwd: z.string().min(1),
});
```

`HelloSchema` gains `terminals: z.boolean().default(false)` — **default, not required**
(the required-field change in step 6.2 broke sibling packages' typecheck twice; defaults
avoid that class of fallout).

New WS frame payloads (all as Zod schemas in terminal.ts):

| frame | direction | payload |
| --- | --- | --- |
| `term-spawn` | hub → daemon | `SpawnTerminal` minus `machine` (the daemon IS the machine) — relayed from POST /api/terminals |
| `term-kill` | hub → daemon | `{ terminalId }` — relayed from DELETE /api/terminals/:id |
| `term-list` | daemon → hub → clients | `{ terminals: TerminalInfo[] }` (full list for that machine; sent on hello, spawn, exit, kill) |
| `term-data` | both (client input ↔ pty output) | `{ terminalId, data }` — `data` base64 |
| `term-resize` | client → hub → daemon | `{ terminalId, cols, rows }` |
| `term-attach` / `term-detach` | client → hub → daemon | `{ terminalId, requestId? }` — attach marks the client a subscriber at the hub and requests replay |
| `term-replay` | daemon → hub → ONE client | `{ terminalId, requestId, data }` — ring-buffer snapshot; hub routes it only to the client whose `term-attach` carried that `requestId` (pending-request map, fs-tunnel pattern), so already-attached clients don't get duplicate scrollback |
| `term-exit` | daemon → hub → clients | `{ terminalId, exitCode }` |
| `term-error` | daemon → hub → clients | `{ message }` — async spawn/cwd-jail failures (spawn REST already returned 202); broadcast, shown as an inline notice |

Envelope pattern as today: frames carry `type`; the fs-tunnel precedent
(`{type:"fs-response", ...payload}`) applies.

### daemon: `packages/daemon/src/terminal-service.ts`

- Dep: `node-pty` (native module). **Lazy import**: if require fails (build missing on
  this machine), the daemon logs once and reports `terminals: false` in hello regardless
  of the grant — degrade, never crash.
- `TerminalService(grants: GrantStore, config)`:
  - `spawn({kind, cwd}) → TerminalInfo` — validates the terminals capability and
    `grants.resolveJailed(cwd)`; command by kind: `shell` → `process.env.SHELL ?? "/bin/sh"`,
    `claude` → `cfg.claudeBin`, `codex` → `cfg.codexBin` (same bins as the adapters);
    spawns via node-pty with `cols/rows 80×24` initial, `cwd`, env = `childEnv()`
    (CONCLAVE_TOKEN already stripped — same hardening as adapter spawns).
  - `write(id, bytes)`, `resize(id, cols, rows)`, `kill(id)`, `list() → TerminalInfo[]`.
  - Per terminal a **ring buffer of raw output bytes, 1 MiB cap** (drop oldest); replay
    on attach. Buffer holds bytes, not lines — VT sequences must replay intact.
  - onData → emits output events; onExit → emits exit, removes terminal.
- `hub-socket` wiring: handle `term-spawn`/`term-data`/`term-resize`/`term-attach`/
  `term-kill` frames from the hub; send `term-list`, `term-data` (output),
  `term-replay`, `term-exit`, `term-error` upstream.
  Labels: `shell` → `<basename($SHELL)> · you`; `claude`/`codex` → `<kind> · <basename(cwd)>`,
  with `agentId` set when the machine's registry has a matching agent (first agent on
  this machine with that runtime, else unset).

### hub: `packages/hub/src/terminal-registry.ts` + routes + relay

- `TerminalRegistry`: in-memory, like `MachineRegistry`. Tracks `TerminalInfo[]` per
  machine (replaced wholesale on each `term-list`), plus which client sockets are
  attached to which terminal id.
- Relay rules in the `/ws` handler:
  - daemon `term-list` → update registry, broadcast `{type:"terminal-list"}` to all clients.
  - daemon `term-data`/`term-exit` → forward to **attached** clients only (not all).
  - client `term-data`/`term-resize`/`term-attach`/`term-detach` → route to the owning
    machine's daemon socket (unknown terminal id: drop silently, log).
  - client disconnect → auto-detach its subscriptions.
- REST (fs-tunnel error conventions):
  - `GET /api/terminals` → `TerminalInfo[]` (all machines).
  - `POST /api/terminals` `{machine, kind, cwd}` → 202 with the spawn relayed to the
    daemon (spawn is async; the new terminal arrives via the next `term-list`
    broadcast); 503 machine unreachable; 403 terminals not granted (registry knows
    capability from hello); 400 bad body.
  - `DELETE /api/terminals/:id` → relays kill; 404 unknown id; 503 unreachable.

### web

- Deps: `@xterm/xterm` + `@xterm/addon-fit`.
- Store: `terminals: TerminalInfo[]`, `activeTerminalId`, session-tab union gains
  `terminal`. Socket handlers for `terminal-list`, `term-data`, `term-exit`.
- `TerminalView`: xterm instance per open terminal tab; on mount sends `term-attach`
  with a fresh `requestId` (ring replay arrives as `term-replay`, then live `term-data`
  follows), pipes keystrokes as base64 `term-data`,
  fit-addon resize → `term-resize`; on unmount sends `term-detach` and disposes the
  xterm (terminal keeps running). Kill button (`✕ kill`) → `DELETE /api/terminals/:id`;
  on `term-exit` the view shows "exited (<code>)" and the row disappears.
- Sidebar TERMINALS section (handoff 4a): mono rows, `❯_` glyph tinted with the owning
  agent's color (neutral for `you` shells), pulsing dot while running, `+` opens a spawn
  picker: machine (only those with `terminals` granted) → kind (shell/claude/codex) →
  cwd (that machine's granted roots). Rows open/focus the terminal session tab.
- Theme: all colors via existing tokens; terminal background uses the code/terminal
  token (`--surface`-family), JetBrains Mono 11px per the handoff.

## Data flow (happy path)

spawn: web `+` → POST /api/terminals → hub → daemon frame → node-pty spawn →
`term-list` → hub registry + broadcast → sidebar row appears → user clicks →
tab opens → `term-attach` → daemon replays ring buffer → live `term-data` both ways →
close tab = detach (terminal lives) → kill button or process exit → `term-exit` +
updated `term-list` → row/tab cleanup.

## Error handling

- Spawn on unreachable machine → 503 (fs-tunnel convention). No grant → 403 with
  `terminals not granted on <machine>`.
- cwd outside granted roots → daemon refuses (PathJailError), surfaces as a failed
  spawn notice frame → hub logs, spawn REST already returned 202, so the UI learns via
  absence + a `term-error` frame `{message}` shown as a toast/inline notice.
- Daemon disconnect → hub clears that machine's terminals from the registry and
  broadcasts an updated list; attached views show "connection lost".
- node-pty missing/build-failed → capability off (see daemon section); UI never shows
  spawn affordances for that machine.
- Backpressure: if a client socket's buffered amount exceeds a threshold (e.g. 4 MiB),
  the hub drops output frames for that client (terminal output is resumable via
  re-attach replay; correctness not required mid-stream).

## Testing

- **daemon** (real PTYs, no mocks): spawn `sh`, write `echo hi\n`, expect output;
  ring-buffer replay after re-attach; 1 MiB cap eviction; cwd jail rejection; grant
  gate off ⇒ spawn refused; kill ⇒ exit event. Guard: skip suite if node-pty failed to
  load (CI parity with the degrade path).
- **hub**: registry update/broadcast on term-list; term-data routed only to attached
  clients; auto-detach on client disconnect; REST 400/403/404/503 paths (fake daemon
  socket, as fs-tunnel tests do).
- **web**: store handlers for terminal-list/term-exit; spawn picker gating by
  capability; TerminalView smoke (mock socket; xterm renders into jsdom — smoke-level
  only, no canvas assertions).
- **Honesty note:** automated tests prove spawn/route/replay plumbing. Full-TUI
  fidelity (claude/codex rendering, keystroke latency) needs a manual smoke: spawn each
  kind against a real daemon, type, resize, detach/re-attach, kill. Record result or
  "not-run" — never claim TUIs work from unit tests alone.

## Risks

- `node-pty` native build fails on some machine → degrade path above; DEPLOY.md notes
  build-tools requirement (python3/make/g++ — same as better-sqlite3).
- Single-socket head-of-line: a firehose terminal shares the WS with chat frames.
  Accepted at TUI rates; backpressure rule caps the damage. Revisit (dedicated socket)
  only if real usage shows lag.
- Security stake increase: token ⇒ shell on granted machines. Called out in DEPLOY.md;
  mitigated by default-deny grant + localhost/tailnet guidance.
