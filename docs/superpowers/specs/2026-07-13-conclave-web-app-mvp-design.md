# Conclave Web App MVP (Step 4) — Design

**Date:** 2026-07-13
**Build-order step:** 4 of 8 (`docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §12)
**Scope:** Web app MVP — chat, threads, live status. Black theme, desktop layout.
**Depends on:** steps 1–3 (hub mailbox/threads/messages/registry/usage/debates + `/ws`; daemon adapters). All merged to `main`.

## 1. Goal

A browser client that renders the canonical Conclave screen (design handoff section `4a`, Black
theme) pixel-faithfully and drives it with **real data from the hub** — group chat with @mentions,
thread/session tabs, a left sidebar of chats + agents, and a right rail of live agent status and
usage. The organizing principle: **real data or a clean absence — never fabricated numbers or dead
controls.** Regions whose data models belong to later build-order steps are omitted now, not
stubbed with fake data.

## 2. Standing decisions (from brainstorming)

1. **Live agent status is backed by real data.** The hub gains a small agent-status model; the
   daemon reports status at turn boundaries. (Chosen over deriving-from-activity or dropping the
   status rail.)
2. **Epic Mode, Fork, Promote/artifact flows, and terminal take-over are omitted from the UI**
   entirely until specified — not rendered as inert controls.
3. **Usage rail = cost/tokens-vs-budget (real now) + a real "resets HH:MM" when rate-limited.**
   Full 5h/week rate-limit window percentages require live-CLI rate-limit parsing and are deferred
   to adapter hardening (step 5+). The daemon already detects 429/usage-limit errors; we parse the
   reset time from that error and surface it.

## 3. Stack & structure

- New workspace package **`packages/web`**: React 18 + Vite + TypeScript, consuming
  `@conclave/shared` for all shared types (existing + new status/usage-summary schemas).
- **Zustand** for live client stores (threads, messages-by-thread, agents+status, usage summary).
  Chosen over plain context+reducer for low-boilerplate cross-cutting updates from a single WS
  stream. (If rejected in review, fall back to `useReducer` + context; no other code depends on the
  choice.)
- **@fontsource** for IBM Plex Sans + JetBrains Mono — self-hosted, no runtime CDN fetch (the hub is
  served over Tailscale and installed as a PWA; external font CDNs are undesirable).
- **lucide-react** for icons (the handoff's named equivalents: layout-list, terminal, git-branch,
  columns, sparkle, file-text, arrows-left-right, git-fork, message-circle).
- **Theming:** Black-theme tokens as CSS custom properties (`--color-*`) on a `:root[data-theme]`
  set, structured so the Teal token set (step 8) is a drop-in with no component changes. Only Black
  ships this step; no visible scheme-switcher yet (nothing to switch to).
- **Dev/serve model:** Vite dev server proxies `/api` and `/ws` to the hub
  (`CONCLAVE_HUB_URL`, default `http://localhost:7777`). Auth token from `VITE_CONCLAVE_TOKEN` —
  `Authorization: Bearer` on fetch, `?token=` on the WS URL. **Assumption:** hub-serves-static
  build output is packaging work and stays in step 5; MVP runs Vite dev against a locally-running
  hub.

## 4. Backend extensions (additive; no rework of existing paths)

### 4.1 Agent status

New schema in `packages/shared/src/orchestration.ts` (or a sibling `status.ts`):

```
AgentStatusSchema = {
  agent:    string,                          // agent id
  status:   "running" | "blocked" | "idle",
  activity: string,                          // one-line, e.g. "debating idempotency-war-room"
  threadId: string | undefined,              // the thread the activity is about
  resetsAt: string | undefined,              // ISO 8601, set when blocked/rate-limited
  ts:       string,                          // ISO 8601 report time
}
```

Hub (`packages/hub/src/server.ts` + a small `status.ts` store):
- In-memory `Map<agentId, AgentStatus>` (status is ephemeral live state; on hub restart it is empty
  and agents re-report on their next turn — no persistence needed).
- `POST /api/status` — authed, daemon→hub; validates `AgentStatusSchema`, stores latest, emits a
  mailbox/`events` `"agent-status"` event.
- `GET /api/status` — client reads current map as an array.
- `/ws` broadcasts `{ type: "agent-status", status }` alongside the existing message/thread/turn
  frames.

Daemon (`packages/daemon/src/agent-loop.ts`):
- Add a `reportStatus(agent, status, activity, threadId?, resetsAt?)` helper that POSTs to
  `/api/status` (best-effort; log-and-continue on failure, matching existing `reportTurn`).
- In `runTurn` and `runDebateTurn`: report `running` (activity derived from the thread/topic)
  immediately before `adapter.runTurn`; `idle` on success; `blocked` with `resetsAt` when
  `result.isError && rateLimited` (reuse the existing rate-limit regex; parse a reset time from the
  error text when present, else omit `resetsAt`). Report `idle` in the failure path too so a dead
  agent doesn't appear stuck "running".

### 4.2 Usage summary

Hub `GET /api/usage/summary` → aggregated read model over the existing `usage` rows:

```
{
  perAgent:     [{ agent, inputTokens, outputTokens, costUsd }],  // SUM grouped by agent
  totalCostUsd: number,
  budgetUsd:    number,   // from CONCLAVE_BUDGET_USD hub config (default e.g. 25)
}
```

Keeps aggregation server-side (SQL `SUM ... GROUP BY agent`) so the client stays dumb and we don't
ship raw rows. Requires the hub `db` (returns 503 if usage store not configured, matching the
existing `/api/usage` guard). `budgetUsd` is read from hub config passed through `ServerOptions`.

## 5. Frontend architecture

### 5.1 Data layer

- `hubClient.ts` — typed fetch wrapper (auth header, base URL) with methods for the endpoints used
  (list/get threads, list/post messages, get registry, get status, get usage summary, post message).
- `socket.ts` — opens `/ws`, exposes a subscription for `message | thread | turn | agent-status`
  frames; auto-reconnect with a refetch-of-initial-state on reconnect (spec §10 resilience). If the
  socket is unavailable, thread views fall back to long-poll `GET /api/threads/:id/messages?after=&wait=`.
- Stores (Zustand): `threadsStore`, `messagesStore` (by threadId), `agentsStore` (registry +
  latest status), `usageStore` (summary). Initial hydrate via GET on mount, then live WS patches.

### 5.2 Regions (design handoff §"Screens / Views", section 4a)

1. **Window tab strip** (44px) — workspace tab(s) derived from registry agents' `workspace` +
   threads' `workspace`; settings ⚙ and history icons; live spend `$X · Ntok` from usage summary.
2. **Left sidebar** (272px):
   - Icon rail — **only the Chats view is wired this step.** Terminal/git/panels/invite icons are
     added when their build-order steps land (7, 5/8, 8, 6); not rendered as dead buttons now.
   - **CHATS** — rows from threads (`kind` chat/debate/dm). Selected row = white pill; DM rows use
     the ⇄ treatment and agent-color glyph; unread badges from WS message counts on non-active
     threads.
   - **AGENTS** — rows from registry: square agent-color avatar, name, real status dot (teal
     pulsing = running, `#facc15` = blocked, none = idle).
   - TERMINALS and ARTIFACTS sections omitted (steps 7 and 5/8 — no data model yet).
3. **Session tabs** — chat sessions only (one per opened thread). Terminal/artifact tabs = steps 7/8.
4. **Context toolbar** — `N agents ▾` participant count, workspace/repo label, right-aligned derived
   thread state (e.g. `● settled` / `● open`). Epic Mode and Fork omitted (decision 2).
5. **Group chat** — full message rendering for the active thread:
   - Avatars: agent = 26px square in identity color with initials; human (`you`) = white circle.
   - Header: name in agent color (600) + timestamp + message-type badge where relevant
     (`proposal` → "plan"-style pill; `verdict`; `status` rendered as a muted system line;
     `approval-request` rendered as a system line, interactive approvals = step 6).
   - Body: @mention chips, inline code, **line-per-block** code blocks (per handoff note), file-path
     links styled correctly (underline, offset) — actual navigation opens in the step-8 file viewer,
     so links are visually faithful but non-navigating this step.
   - **Typing indicator is real** — shown as "X is thinking ▮" when a thread participant's status is
     `running` and scoped to this thread.
   - Embedded terminal card omitted (step 7).
6. **Composer** — textarea with `›` glyph and the handoff placeholder copy; ⏎ sends
   `POST /api/threads/:id/messages` as `from:"you"`. **`@mention` autocomplete is real and
   functional**: selecting an agent adds it to the message `to[]`, which is exactly what triggers
   that agent server-side (`shouldTrigger` checks `to.includes(agentId)`). `/task` slash command
   deferred to step 5 (delegation).
7. **Right status strip** (280px):
   - **LIVE STATUS** — one card per agent from registry + status store: color swatch, name,
     `● running`/`● blocked`, one-line activity, and a 3px progress bar that is an **indeterminate
     animation while running** (CLIs emit no numeric progress; we do not fabricate a percentage).
   - **USAGE LIMITS** — per-agent from usage summary: real cumulative input/output tokens + cost;
     the meter renders cost-as-share-of-budget; `resets HH:MM` appears when that agent's status is
     `blocked` with a `resetsAt`. Full 5h/week window % deferred (decision 3).
   - Footer — `workspace today $spent / $budget` from the usage summary (both real).

## 6. Testing (Vitest; spec §11)

- **Hub** (`packages/hub/test`): `/api/status` post→get→broadcast; `/api/usage/summary` aggregation
  (grouping, totals, budget passthrough, 503 without db).
- **Daemon** (`packages/daemon/test/agent-loop.test.ts`): status reported `running` before the
  adapter runs, `idle` on success, `blocked` (+`resetsAt` when parseable) on rate-limit error, and
  `idle`/failure path never leaves an agent "running".
- **Web** (`packages/web`, jsdom): pure-logic units for message parsing (mentions, inline code,
  file paths, code blocks), mention→`to[]` construction, and WS-frame store reducers;
  `@testing-library/react` component tests for chat rendering, composer autocomplete, and the status
  rail. Playwright screenshot of the running app compared against `screenshots/4a-black-main.png` in
  verification.

## 7. Explicitly deferred (with owning step)

- Terminals, embedded terminal card, take-over — **step 7**.
- Artifacts section, Promote/artifact flows — **step 5 / 8**.
- File-link navigation, single-file viewer/editor — **step 8**.
- Teal theme + visible color-scheme switcher, mobile/PWA layout, Tauri shell — **step 8**.
- `/task` slash command + delegation tasks — **step 5**.
- Approvals/decision buttons, ACLs, web push — **step 6**.
- Full 5h/week rate-limit window percentages — **step 5+** (live-adapter hardening).
- Hub-serves-static build output — **step 5** (packaging).
- Epic Mode, Fork — unspecified; omitted until brainstormed separately.

Tokens are structured for theming now so the Teal set drops in without component changes.

## 8. Implementation order (for the plan)

1. Backend: shared status schema + usage-summary types; hub `/api/status`, `/api/usage/summary`,
   WS `agent-status` broadcast, budget config; hub tests.
2. Daemon: status reporting at turn boundaries (running/idle/blocked+resetsAt); daemon tests.
3. Web scaffold: Vite+React+TS package, fonts, `tokens.css` (Black), hubClient + socket + stores.
4. Layout shell: five regions, tokenized, static structure.
5. Wire live data: chat (threads/messages), agents+status rail, usage rail, composer post + @mention.
6. Message-rendering fidelity (mentions/code/file-paths/badges/typing).
7. Tests + Playwright visual check + verification against 4a.
