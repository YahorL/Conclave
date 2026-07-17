# Rate-Limit-Window Meters (design) — step 8.2

Date: 2026-07-16
Status: approved (user: "yes")
Step: build-order step 8, sub-project 2 of 5 (8.1 Teal done; then editor save-back, mobile, Tauri)
Parent: arch spec §usage (`usage { windowPct, weekPct, resetsAt }`), design handoff §usage-bar gradients

## Goal

Surface the coding-agent subscriptions' 5-hour and weekly rate-limit windows as
live meters in the status strip, computed from usage the hub already records,
with per-agent caps configured in the registry. Meters update after every turn.

## User-approved decisions

1. **Caps come from registry.yaml, per agent, optional**: `limits: {
   window5hTokens?, weeklyTokens? }` on `AgentConfig`. No cap → the meter shows
   the raw token count in the window, no percentage. No fake denominators.
2. **Meters only** — the orchestrator usage-threshold refusal gate (arch spec:
   refuse new tasks/debates above ~80% of the 5h window) is a follow-up once
   the meters have earned trust against real usage.

## What is real vs configured

- **Real:** per-turn usage rows already exist (`usage` table: agent, thread_id,
  input/output tokens, cost, ts as `new Date().toISOString()`); trailing 5h/7d
  sums are SQL over that. The `resetsAt` countdown on an actual rate-limit hit
  (parsed from CLI output) already ships and stays as-is.
- **Configured:** the caps. Subscriptions don't expose quotas; percentages are
  honest only relative to a user-stated cap.

## Components

### shared

- `AgentLimitsSchema = z.object({ window5hTokens: z.number().int().positive().optional(), weeklyTokens: z.number().int().positive().optional() })`;
  `AgentConfigSchema` gains `limits: AgentLimitsSchema.default({})` — DEFAULTED,
  never required (step-6 lesson: required shared fields break sibling
  typechecks).
- `AgentUsageSchema` gains `window5hTokens: z.number().default(0)`,
  `weeklyTokens: z.number().default(0)` (tokens used in each trailing window)
  and `window5hPct: z.number().optional()`, `weeklyPct: z.number().optional()`
  (only present when the agent has the matching cap). Defaults keep existing
  fixtures parsing.

### hub

- `getUsageSummary(db, budgetUsd, limitsByAgent)` — third parameter
  `Record<string, { window5hTokens?: number; weeklyTokens?: number }>` (built by
  the route from the registry). Adds two window queries per summary:
  `SELECT agent, SUM(input_tokens + output_tokens) AS toks FROM usage WHERE ts >= ? GROUP BY agent`
  run twice with JS-computed cutoffs. **Correctness pin:** `ts` is stored as
  ISO-with-`T` (`toISOString()`); SQLite's `datetime('now','-5 hours')` emits
  space-separated format, and lexicographic comparison between the two formats
  is WRONG ('T' > ' '). Cutoffs must be
  `new Date(Date.now() - 5 * 3600_000).toISOString()` and
  `new Date(Date.now() - 7 * 24 * 3600_000).toISOString()`, passed as
  parameters. Pct = `round(100 * used / cap)` when the cap exists, else absent
  (uncapped, not 0).
- **Live updates:** `POST /api/usage`, after `recordUsage`, broadcasts
  `{ type: "usage", summary: getUsageSummary(...) }` to all `/ws` sockets
  (reuse the `wsSockets` set introduced in 7.1; daemons ignore unknown frames).
  This fixes the existing staleness (summary was fetched once at hydrate).

### web

- Socket `WsFrame` union gains `{ type: "usage"; summary: UsageSummary }`;
  store `applyFrame` case sets `usage`.
- **StatusStrip usage rows** gain a second line under the existing cost line:
  two mini-bars labeled `5h` and `wk` (mono 10px, same idiom as existing rows).
  - Cap configured: 5px bar on `var(--progress-track)`, filled to pct, with the
    handoff severity gradients built from theme tokens:
    - normal (< 70%): `var(--usage-normal)`
    - nearing (≥ 70%): `linear-gradient(90deg, var(--usage-normal), var(--blocked))`
    - critical (≥ 90%): `linear-gradient(90deg, var(--blocked), var(--danger))`
    Thresholds 70/90 are this spec's choice (the handoff names the tiers and
    colors but no numbers). Pct text right-aligned (`42%`).
  - No cap: text only — `5h 128.4k tok` (compact k-format ≥ 1000), no bar.
- **Existing cost-vs-budget bar** adopts the same three-tier severity fill
  (it is flat `--usage-normal` today; the handoff's gradients apply to usage
  bars generally). Same 70/90 thresholds against budget pct.
- No new REST calls: hydrate keeps the one summary fetch; the `usage` frame
  keeps it fresh afterward.

## Data flow

turn ends → daemon POST /api/usage → hub recordUsage + broadcast usage frame →
web store.usage updates → StatusStrip re-renders bars. Registry caps flow:
registry.yaml → hub route builds limitsByAgent → summary pcts.

## Error handling

- Malformed/absent `limits` in registry.yaml → Zod default `{}` (no caps, raw
  counts). Zero/negative cap rejected by `positive()` at registry load.
- Pct can exceed 100 (cap misconfigured low or a window burst) → clamp the BAR
  fill at 100% but show the real number (`137%`) in critical style.
- No usage rows for an agent → windows are 0 (and 0% when capped).

## Testing

- **hub** (`usage.test.ts` extension): seed rows with controlled `ts` values
  (e.g. now-1h, now-6h, now-3d, now-8d) → 5h window counts only the first, 7d
  counts the first three; pct only for capped agents; the ISO-cutoff
  correctness is implicitly pinned by these fixtures. Route test: POST
  /api/usage broadcasts a `usage` frame carrying the updated summary (ws client
  pattern from the terminals tests).
- **web**: store applies the usage frame; StatusStrip renders — capped agent at
  42% (normal), 71% (nearing class), 91% (critical class), >100% (clamped bar,
  real number shown); uncapped agent shows `5h … tok` text and no bar. Fixture
  updates for the extended AgentUsage shape.
- **shared**: AgentConfig without `limits` parses (default `{}`); AgentUsage
  without window fields parses (defaults 0). Run `npx pnpm -r typecheck` after
  the shared change.
- **Honesty note:** the meters measure Conclave-recorded usage only — turns run
  outside Conclave (direct CLI use) don't count, so the meter can undercount
  the subscription's real window. Document this in the registry example and
  DEPLOY.md ("estimates based on what Conclave observed").

## Out of scope

- Orchestrator refusal gate (follow-up), auto-learning caps from rate-limit
  events, codex-specific window semantics, weekly-reset anchoring (trailing 7d
  window, not calendar-anchored — noted in DEPLOY.md wording).
