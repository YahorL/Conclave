# Rate-Limit-Window Meters Implementation Plan (step 8.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live 5-hour and weekly rate-limit-window meters per agent in the status strip, computed from the hub's existing per-turn usage rows against optional per-agent caps from registry.yaml.

**Architecture:** Shared schemas gain defaulted `limits` (AgentConfig) and window fields (AgentUsage). `getUsageSummary` adds two trailing-window SQL sums with JS-computed ISO cutoffs and merges registry caps into percentages. `POST /api/usage` broadcasts a `{type:"usage", summary}` frame over the existing `/ws` sockets so meters tick after every turn. StatusStrip renders per-agent `5h`/`wk` mini-bars with the handoff's three-tier severity gradients (also applied to the cost-vs-budget bar).

**Tech Stack:** Existing — Zod (shared), better-sqlite3 SQL (hub), ws broadcast set from 7.1, React/Zustand (web). No new dependencies.

## Global Constraints

- Work on branch `feat/rate-limit-meters` (created in Task 1); merge to `main` with `--no-ff` after the whole plan.
- Backend tests from the REPO ROOT: `npx vitest run packages/<pkg>/test/<file>.test.ts`. Web tests per-file: `npx pnpm --filter @conclave/web exec vitest run <path>`; NEVER the full web suite in foreground. `pnpm` not on PATH — `npx pnpm ...`. One heavy command at a time (~12 GB RAM machine).
- Shared fields must not break existing object literals: `limits: AgentLimitsSchema.optional()` (NOT `.default({})` — a defaulted field is REQUIRED in the inferred output type and would break every Registry/AgentConfig literal across hub+daemon tests, the step-6.2 `acl` fallout all over again; `.optional()` is functionally identical since absent caps just mean no pct). `window5hTokens/weeklyTokens: z.number().nonnegative().default(0)` — these ARE output-required, and the only typed constructors are `getUsageSummary` (rewritten in Task 2) and test fixtures (updated in Task 3); if `npx pnpm -r typecheck` flags others, adding the two fields is the sanctioned fix. Pct fields `.optional()`. Run `npx pnpm -r typecheck` after every shared change.
- **Timestamp correctness pin (from the spec):** `usage.ts` stores `ts` via `new Date().toISOString()` (ISO-with-`T`). SQLite `datetime('now', …)` emits space-separated strings; lexicographic comparison across the two formats is WRONG. Window cutoffs MUST be computed in JS — `new Date(Date.now() - 5 * 3600_000).toISOString()` and `new Date(Date.now() - 7 * 24 * 3600_000).toISOString()` — and passed as SQL parameters.
- Severity tiers (spec's choice): normal < 70%, nearing ≥ 70%, critical ≥ 90%. Gradient fills from theme tokens only: normal `var(--usage-normal)`; nearing `linear-gradient(90deg, var(--usage-normal), var(--blocked))`; critical `linear-gradient(90deg, var(--blocked), var(--danger))`. Bar width clamps at 100%; the printed number does not (e.g. `137%`).
- Pct present ONLY when the agent has the matching cap (uncapped ≠ 0%).
- Commit message body ends with:
  `Claude-Session: https://claude.ai/code/session_01MJ8FKhtSEmDL7SuhNtRrGN`

---

### Task 1: shared schemas — AgentConfig.limits + AgentUsage window fields

**Files:**
- Modify: `packages/shared/src/registry.ts` (AgentLimitsSchema + `limits` on AgentConfigSchema)
- Modify: `packages/shared/src/status.ts` (AgentUsageSchema window fields)
- Test: `packages/shared/test/limits.test.ts` (new)

**Interfaces:**
- Produces: `AgentLimitsSchema` / `AgentLimits` (`{ window5hTokens?: number; weeklyTokens?: number }`); `AgentConfig.limits: AgentLimits` (defaults `{}`); `AgentUsage` gains `window5hTokens: number` (default 0), `weeklyTokens: number` (default 0), `window5hPct?: number`, `weeklyPct?: number`. Tasks 2–3 rely on these exact names.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/rate-limit-meters
```

- [ ] **Step 2: Write the failing test**

`packages/shared/test/limits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentConfigSchema, AgentLimitsSchema, AgentUsageSchema } from "../src/index.js";

const BASE_AGENT = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1", workspace: "/w",
};

describe("agent limits + usage window fields", () => {
  it("AgentConfig without limits parses (limits stays undefined — optional, not defaulted)", () => {
    const a = AgentConfigSchema.parse(BASE_AGENT);
    expect(a.limits).toBeUndefined();
  });

  it("AgentConfig accepts partial limits and rejects non-positive caps", () => {
    const a = AgentConfigSchema.parse({ ...BASE_AGENT, limits: { window5hTokens: 500_000 } });
    expect(a.limits?.window5hTokens).toBe(500_000);
    expect(a.limits?.weeklyTokens).toBeUndefined();
    expect(AgentConfigSchema.safeParse({ ...BASE_AGENT, limits: { window5hTokens: 0 } }).success).toBe(false);
    expect(AgentConfigSchema.safeParse({ ...BASE_AGENT, limits: { weeklyTokens: -1 } }).success).toBe(false);
  });

  it("AgentUsage defaults window fields and keeps pct optional", () => {
    const u = AgentUsageSchema.parse({ agent: "codex", inputTokens: 1, outputTokens: 2, costUsd: 0.1 });
    expect(u.window5hTokens).toBe(0);
    expect(u.weeklyTokens).toBe(0);
    expect(u.window5hPct).toBeUndefined();
    const capped = AgentUsageSchema.parse({
      agent: "codex", inputTokens: 1, outputTokens: 2, costUsd: 0.1,
      window5hTokens: 100, weeklyTokens: 900, window5hPct: 10, weeklyPct: 9,
    });
    expect(capped.window5hPct).toBe(10);
  });

  it("exports AgentLimitsSchema", () => {
    expect(AgentLimitsSchema.parse({})).toEqual({});
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/limits.test.ts`
Expected: FAIL — `AgentLimitsSchema` not exported; `limits`/window fields missing.

- [ ] **Step 4: Implement**

`packages/shared/src/registry.ts` — add above `AgentConfigSchema`:

```ts
export const AgentLimitsSchema = z.object({
  window5hTokens: z.number().int().positive().optional(),
  weeklyTokens: z.number().int().positive().optional(),
});
```

and inside `AgentConfigSchema` (after `dangerousActions`):

```ts
  limits: AgentLimitsSchema.optional(),
```

(`.optional()`, deliberately NOT `.default({})` — see Global Constraints: a default makes the field required in the inferred output type and breaks every existing AgentConfig literal.)

plus `export type AgentLimits = z.infer<typeof AgentLimitsSchema>;` next to the other type exports.

`packages/shared/src/status.ts` — `AgentUsageSchema` becomes:

```ts
export const AgentUsageSchema = z.object({
  agent: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  window5hTokens: z.number().nonnegative().default(0),
  weeklyTokens: z.number().nonnegative().default(0),
  window5hPct: z.number().optional(),
  weeklyPct: z.number().optional(),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/shared/test/limits.test.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Typecheck sweep + affected suites, commit**

Run: `npx pnpm -r typecheck` (defaulted fields should be fallout-free — but literals CONSTRUCTING AgentUsage objects, e.g. in hub usage code or web fixtures, still typecheck because the fields are output-optional via defaults; verify all 4 packages). Then `npx vitest run packages/shared/test packages/hub/test` (registry-consuming suites).

```bash
git add packages/shared
git commit -m "feat(shared): agent rate-limit caps + usage window fields"
```

---

### Task 2: hub — window sums, cap merge, live usage broadcast

**Files:**
- Modify: `packages/hub/src/usage.ts` (`getUsageSummary` third param + window queries)
- Modify: `packages/hub/src/server.ts` (summary route passes caps; POST /api/usage broadcasts)
- Test: `packages/hub/test/usage-windows.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `AgentLimits`; the `wsSockets` set already in `buildServer` scope (added in 7.1 — every `/ws` socket is added on connect).
- Produces: `getUsageSummary(db, budgetUsd, limitsByAgent?: Record<string, AgentLimits>): UsageSummary` (default `{}` keeps old call sites compiling); ws frame `{ type: "usage"; summary: UsageSummary }` broadcast after every recorded turn. Task 3's web store consumes the frame.

- [ ] **Step 1: Write the failing tests**

`packages/hub/test/usage-windows.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";
import { getUsageSummary } from "../src/usage.js";

const TOKEN = "usage-win-token";

function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), "conclave-uw-")), "t.db"));
}

function seed(db: Database.Database, agent: string, tokens: number, agoMs: number): void {
  db.prepare(
    `INSERT INTO usage (agent, thread_id, input_tokens, output_tokens, cost_usd, ts)
     VALUES (?, NULL, ?, 0, 0.01, ?)`,
  ).run(agent, tokens, new Date(Date.now() - agoMs).toISOString());
}

const H = 3600_000;
const D = 24 * H;

describe("trailing usage windows", () => {
  it("sums only rows inside each window", () => {
    const db = freshDb();
    seed(db, "codex", 100, 1 * H);   // inside 5h and 7d
    seed(db, "codex", 200, 6 * H);   // outside 5h, inside 7d
    seed(db, "codex", 400, 3 * D);   // outside 5h, inside 7d
    seed(db, "codex", 800, 8 * D);   // outside both
    const s = getUsageSummary(db, 25);
    const u = s.perAgent.find((a) => a.agent === "codex")!;
    expect(u.window5hTokens).toBe(100);
    expect(u.weeklyTokens).toBe(700);
    expect(u.window5hPct).toBeUndefined(); // no caps passed
  });

  it("merges caps into rounded percentages, only where configured", () => {
    const db = freshDb();
    seed(db, "codex", 350, 1 * H);
    seed(db, "claude-code", 500, 1 * H);
    const s = getUsageSummary(db, 25, {
      codex: { window5hTokens: 1000 },            // 5h cap only
      "claude-code": { weeklyTokens: 1000 },      // weekly cap only
    });
    const codex = s.perAgent.find((a) => a.agent === "codex")!;
    expect(codex.window5hPct).toBe(35);
    expect(codex.weeklyPct).toBeUndefined();
    const cc = s.perAgent.find((a) => a.agent === "claude-code")!;
    expect(cc.window5hPct).toBeUndefined();
    expect(cc.weeklyPct).toBe(50);
  });

  it("pct can exceed 100 (no clamping server-side)", () => {
    const db = freshDb();
    seed(db, "codex", 1370, 1 * H);
    const s = getUsageSummary(db, 25, { codex: { window5hTokens: 1000 } });
    expect(s.perAgent.find((a) => a.agent === "codex")!.window5hPct).toBe(137);
  });
});

describe("usage frame broadcast", () => {
  let app: FastifyInstance;
  let ws: WebSocket;
  afterEach(async () => {
    ws?.close();
    await app.close();
  });

  it("POST /api/usage broadcasts {type:'usage'} with the fresh summary", async () => {
    const db = freshDb();
    app = await buildServer({
      mailbox: new Mailbox(db), token: TOKEN, db,
      registry: {
        agents: [{
          id: "codex", name: "codex", runtime: "codex", machine: "m1",
          workspace: "/w", role: "", allowedTools: [], dangerousActions: [],
          limits: { window5hTokens: 1000 },
        }],
        acl: [],
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const seen: Array<Record<string, unknown>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const res = await app.inject({
      method: "POST", url: "/api/usage",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { agent: "codex", inputTokens: 250, outputTokens: 250, costUsd: 0.05 },
    });
    expect(res.statusCode).toBe(201);

    const start = Date.now();
    while (!seen.some((f) => f["type"] === "usage")) {
      if (Date.now() - start > 5000) throw new Error("no usage frame");
      await new Promise((r) => setTimeout(r, 20));
    }
    const frame = seen.find((f) => f["type"] === "usage") as {
      summary: { perAgent: Array<{ agent: string; window5hTokens: number; window5hPct?: number }> };
    };
    const u = frame.summary.perAgent.find((a) => a.agent === "codex")!;
    expect(u.window5hTokens).toBe(500);
    expect(u.window5hPct).toBe(50);
  }, 15000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/hub/test/usage-windows.test.ts`
Expected: FAIL — window fields are 0/undefined (Task 1 defaults) and no usage frame arrives.

- [ ] **Step 3: Implement**

`packages/hub/src/usage.ts` — replace `getUsageSummary` with:

```ts
import type { AgentLimits, AgentUsage, UsageReport, UsageSummary } from "@conclave/shared";
```

```ts
interface WindowRow {
  agent: string;
  toks: number;
}

export function getUsageSummary(
  db: Database.Database,
  budgetUsd: number,
  limitsByAgent: Record<string, AgentLimits> = {},
): UsageSummary {
  const rows = db
    .prepare(
      `SELECT agent,
              SUM(input_tokens)  AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost_usd)      AS cost_usd
       FROM usage
       GROUP BY agent
       ORDER BY cost_usd DESC`,
    )
    .all() as SummaryRow[];

  // ts is stored as new Date().toISOString() (ISO with 'T'); SQLite's
  // datetime('now', …) emits 'YYYY-MM-DD HH:MM:SS', and comparing the two
  // formats lexicographically is WRONG ('T' > ' '). Compute cutoffs in JS in
  // the SAME format as the stored values.
  const windowQuery = db.prepare(
    `SELECT agent, SUM(input_tokens + output_tokens) AS toks
     FROM usage WHERE ts >= ? GROUP BY agent`,
  );
  const toMap = (rows: WindowRow[]): Map<string, number> =>
    new Map(rows.map((r) => [r.agent, r.toks ?? 0]));
  const in5h = toMap(windowQuery.all(new Date(Date.now() - 5 * 3600_000).toISOString()) as WindowRow[]);
  const in7d = toMap(windowQuery.all(new Date(Date.now() - 7 * 24 * 3600_000).toISOString()) as WindowRow[]);

  const perAgent: AgentUsage[] = rows.map((r) => {
    const limits = limitsByAgent[r.agent] ?? {};
    const window5hTokens = in5h.get(r.agent) ?? 0;
    const weeklyTokens = in7d.get(r.agent) ?? 0;
    return {
      agent: r.agent,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
      window5hTokens,
      weeklyTokens,
      window5hPct: limits.window5hTokens
        ? Math.round((100 * window5hTokens) / limits.window5hTokens)
        : undefined,
      weeklyPct: limits.weeklyTokens
        ? Math.round((100 * weeklyTokens) / limits.weeklyTokens)
        : undefined,
    };
  });
  const totalCostUsd = perAgent.reduce((sum, a) => sum + a.costUsd, 0);
  return { perAgent, totalCostUsd, budgetUsd };
}
```

`packages/hub/src/server.ts`:

Add a small helper near the top of `buildServer` (after `wsSockets` is declared — it already exists from 7.1):

```ts
  const limitsByAgent = (): Record<string, import("@conclave/shared").AgentLimits> =>
    Object.fromEntries((opts.registry?.agents ?? []).map((a) => [a.id, a.limits ?? {}]));
```

Change the summary route:

```ts
  app.get("/api/usage/summary", async (_req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    return getUsageSummary(opts.db, opts.budgetUsd ?? 25, limitsByAgent());
  });
```

Change the POST route to broadcast after recording:

```ts
  app.post("/api/usage", async (req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    const body = parseOr400(UsageReportSchema, req.body, reply);
    if (!body) return;
    recordUsage(opts.db, body);
    const payload = JSON.stringify({
      type: "usage",
      summary: getUsageSummary(opts.db, opts.budgetUsd ?? 25, limitsByAgent()),
    });
    for (const s of wsSockets) s.send(payload);
    return reply.code(201).send({ ok: true });
  });
```

(Verify the actual `wsSockets` variable name in server.ts from 7.1 and use it; daemon sockets also receive the frame and ignore it — same accepted pattern as `terminal-list`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/usage-windows.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Full hub suite + typecheck, commit**

Run: `npx vitest run packages/hub/test` then `npx pnpm -r typecheck`.

```bash
git add packages/hub
git commit -m "feat(hub): trailing 5h/7d usage windows with registry caps + live usage frame"
```

---

### Task 3: web — usage frame, severity bars, docs

**Files:**
- Modify: `packages/web/src/lib/socket.ts` (WsFrame union + `usage` member)
- Modify: `packages/web/src/store/useConclaveStore.ts` (`applyFrame` usage case)
- Create: `packages/web/src/lib/severity.ts`
- Modify: `packages/web/src/components/StatusStrip.tsx` (window bars line + cost-bar severity)
- Modify: `packages/web/src/components/StatusStrip.module.css` (window-bar styles, severity fills)
- Modify: `docs/DEPLOY.md` (registry `limits` example + honesty note)
- Test: `packages/web/src/lib/__tests__/severity.test.ts`, `packages/web/src/components/__tests__/UsageMeters.test.tsx` (new)

**Interfaces:**
- Consumes: the `{type:"usage", summary}` frame (Task 2); `AgentUsage` window fields (Task 1); existing tokens `--usage-normal`, `--blocked`, `--danger`, `--progress-track`.
- Produces: `usageSeverity(pct: number): "normal" | "nearing" | "critical"` and `fmtTok(n: number): string` from `lib/severity.ts`; StatusStrip testids `win-5h-<agent>`, `win-wk-<agent>` on the bar/text spans.

- [ ] **Step 1: Write the failing tests**

`packages/web/src/lib/__tests__/severity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fmtTok, usageSeverity } from "../severity.js";

describe("usage severity + token formatting", () => {
  it("tiers at 70 and 90", () => {
    expect(usageSeverity(0)).toBe("normal");
    expect(usageSeverity(69)).toBe("normal");
    expect(usageSeverity(70)).toBe("nearing");
    expect(usageSeverity(89)).toBe("nearing");
    expect(usageSeverity(90)).toBe("critical");
    expect(usageSeverity(137)).toBe("critical");
  });

  it("formats token counts compactly", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1000)).toBe("1.0k");
    expect(fmtTok(128_400)).toBe("128.4k");
  });
});
```

`packages/web/src/components/__tests__/UsageMeters.test.tsx`:

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusStrip } from "../StatusStrip.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const usage = (agent: string, extra: Record<string, unknown>) => ({
  agent, inputTokens: 1000, outputTokens: 500, costUsd: 1.5,
  window5hTokens: 0, weeklyTokens: 0, ...extra,
});

function seed(perAgent: Array<Record<string, unknown>>): void {
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({
    type: "usage",
    summary: { perAgent, totalCostUsd: 1.5, budgetUsd: 25 },
  } as never);
}

describe("rate-limit window meters", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("applyFrame updates store usage from the ws frame", () => {
    seed([usage("codex", { window5hTokens: 420, window5hPct: 42 })]);
    expect(useConclaveStore.getState().usage?.perAgent[0]?.window5hPct).toBe(42);
  });

  it("renders pct bars with severity classes at 42/71/91", () => {
    seed([
      usage("codex", { window5hTokens: 420, window5hPct: 42, weeklyTokens: 710, weeklyPct: 71 }),
      usage("claude-code", { window5hTokens: 910, window5hPct: 91 }),
    ]);
    render(<StatusStrip />);
    const codex5h = screen.getByTestId("win-5h-codex");
    expect(codex5h.textContent).toContain("42%");
    expect(codex5h.querySelector("[data-severity='normal']")).toBeTruthy();
    const codexWk = screen.getByTestId("win-wk-codex");
    expect(codexWk.querySelector("[data-severity='nearing']")).toBeTruthy();
    const cc5h = screen.getByTestId("win-5h-claude-code");
    expect(cc5h.querySelector("[data-severity='critical']")).toBeTruthy();
  });

  it("over-100 pct clamps the bar width but prints the real number", () => {
    seed([usage("codex", { window5hTokens: 1370, window5hPct: 137 })]);
    render(<StatusStrip />);
    const el = screen.getByTestId("win-5h-codex");
    expect(el.textContent).toContain("137%");
    const fill = el.querySelector("[data-severity]") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("uncapped agent shows token text, no bar", () => {
    seed([usage("codex", { window5hTokens: 128_400, weeklyTokens: 900_000 })]);
    render(<StatusStrip />);
    const el = screen.getByTestId("win-5h-codex");
    expect(el.textContent).toContain("128.4k");
    expect(el.querySelector("[data-severity]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/severity.test.ts src/components/__tests__/UsageMeters.test.tsx`
Expected: FAIL — severity module missing; `applyFrame` drops the usage frame; no `win-*` testids.

- [ ] **Step 3: Implement**

`packages/web/src/lib/severity.ts`:

```ts
export type UsageSeverity = "normal" | "nearing" | "critical";

export function usageSeverity(pct: number): UsageSeverity {
  if (pct >= 90) return "critical";
  if (pct >= 70) return "nearing";
  return "normal";
}

export function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
```

`packages/web/src/lib/socket.ts` — add to the `WsFrame` union (import `UsageSummary` type):

```ts
  | { type: "usage"; summary: UsageSummary }
```

`packages/web/src/store/useConclaveStore.ts` — `applyFrame` gains:

```ts
        case "usage":
          return { usage: f.summary };
```

`packages/web/src/components/StatusStrip.tsx` — inside the usage-limits map, after the existing `usageTrack` div, add the windows line; and give the existing cost fill a severity. The usage row block becomes:

```tsx
      {(usage?.perAgent ?? []).map((u) => {
        const st = statusByAgent[u.agent];
        const pct = budget > 0 ? Math.round((u.costUsd / budget) * 100) : 0;
        return (
          <div key={u.agent} className={styles.usageRow}>
            <span className={styles.swatch} style={{ background: agentColorVar(u.agent).bg }} />
            <span className={styles.name}>{u.agent}</span>
            <span className={styles.metric}>
              {(u.inputTokens + u.outputTokens).toLocaleString()} tok · ${u.costUsd.toFixed(2)}
              {st?.status === "blocked" && st.resetsAt ? ` · resets ${hhmm(st.resetsAt)}` : ""}
            </span>
            <div className={styles.usageTrack}>
              <div
                className={styles.usageFill}
                data-severity={usageSeverity(pct)}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <div className={styles.windows}>
              <WindowMeter label="5h" agent={u.agent} used={u.window5hTokens} pct={u.window5hPct} />
              <WindowMeter label="wk" agent={u.agent} used={u.weeklyTokens} pct={u.weeklyPct} />
            </div>
          </div>
        );
      })}
```

with a small component in the same file (above `StatusStrip`):

```tsx
function WindowMeter({ label, agent, used, pct }: {
  label: string; agent: string; used: number; pct?: number;
}): JSX.Element {
  const key = label === "5h" ? "5h" : "wk";
  return (
    <span className={styles.window} data-testid={`win-${key}-${agent}`}>
      <span className={styles.winLabel}>{label}</span>
      {pct === undefined ? (
        <span className={styles.winText}>{fmtTok(used)} tok</span>
      ) : (
        <>
          <span className={styles.winTrack}>
            <span
              className={styles.winFill}
              data-severity={usageSeverity(pct)}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className={styles.winPct} data-severity={usageSeverity(pct)}>{pct}%</span>
        </>
      )}
    </span>
  );
}
```

Imports: `import { fmtTok, usageSeverity } from "../lib/severity.js";`

`packages/web/src/components/StatusStrip.module.css` — append, and extend `.usageFill`:

```css
.usageFill[data-severity="nearing"] {
  background: linear-gradient(90deg, var(--usage-normal), var(--blocked));
}
.usageFill[data-severity="critical"] {
  background: linear-gradient(90deg, var(--blocked), var(--danger));
}
.windows {
  grid-column: 1 / -1;
  display: flex;
  gap: 14px;
  padding-top: 2px;
}
.window {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary-2);
}
.winLabel {
  color: var(--text-muted);
}
.winTrack {
  flex: 1;
  height: 5px;
  background: var(--progress-track);
  border-radius: 3px;
  overflow: hidden;
}
.winFill {
  display: block;
  height: 100%;
  background: var(--usage-normal);
}
.winFill[data-severity="nearing"] {
  background: linear-gradient(90deg, var(--usage-normal), var(--blocked));
}
.winFill[data-severity="critical"] {
  background: linear-gradient(90deg, var(--blocked), var(--danger));
}
.winPct[data-severity="critical"] {
  color: var(--danger);
}
.winText {
  color: var(--text-secondary-2);
}
```

`docs/DEPLOY.md` — in the registry.yaml example (section "## 2. Register agents"), extend the first agent with:

```yaml
    limits:              # optional: enables the 5h/weekly rate-limit meters
      window5hTokens: 2000000
      weeklyTokens: 20000000
```

and add below the example:

```markdown
> **Rate-limit meters:** `limits` drives the 5h/weekly window meters in the
> status strip. The percentages are estimates against caps *you* configure —
> subscriptions don't expose their quotas — and they count only usage Conclave
> observed (turns run directly in a CLI outside Conclave don't appear). The
> weekly meter is a trailing 7-day window, not calendar-anchored.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/severity.test.ts src/components/__tests__/UsageMeters.test.tsx`
Expected: PASS (6/6). Also run the existing StatusStrip/integration test files per-file if present (`ls packages/web/src/components/__tests__/ packages/web/src/__tests__/`) — the usage-row markup changed; fix any selector fallout in those tests (markup additions only — existing assertions should hold unless they snapshot the row).

- [ ] **Step 5: Full checks, commit**

In order: `npx pnpm -r typecheck`; full web suite backgrounded (`timeout 180 npx pnpm --filter @conclave/web exec vitest run > /tmp/web-suite.log 2>&1; grep -E "Test Files|Tests " /tmp/web-suite.log`); `npx vitest run` (full backend); `npx pnpm --filter @conclave/web build`.

```bash
git add packages/web docs/DEPLOY.md
git commit -m "feat(web): 5h/weekly rate-limit meters with severity gradients; live usage updates"
```

---

## Coverage vs spec (self-check)

- Shared limits + usage window fields (defaulted): Task 1. Window SQL with JS ISO cutoffs, cap merge, >100 pct unclamped server-side, usage frame broadcast via wsSockets: Task 2. WsFrame/store, WindowMeter bars with 70/90 severity gradients + clamp-bar/print-real, uncapped text-only, cost-bar severity adoption, DEPLOY.md honesty note (Conclave-observed only, trailing 7d): Task 3.
- The existing `resets HH:MM` display is untouched (spec: stays as-is).
- Out of scope per spec: refusal gate, cap auto-learning, calendar anchoring.
