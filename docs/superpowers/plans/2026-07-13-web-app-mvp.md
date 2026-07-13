# Conclave Web App MVP (Step 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a browser client that renders the Conclave canonical screen (design handoff section `4a`, Black theme) pixel-faithfully and drives it with real hub data — group chat with @mentions, thread/session tabs, a sidebar of chats + agents, and a right rail of live agent status and usage.

**Architecture:** Additive backend first (hub gains an ephemeral agent-status model and a usage-summary read model; the daemon reports status at turn boundaries), then a new `packages/web` React+Vite client that hydrates over HTTP and stays live over the existing `/ws` stream. Real data or a clean absence — no fabricated numbers, no dead controls.

**Tech Stack:** React 18, Vite, TypeScript, Zustand (client stores), @fontsource (IBM Plex Sans + JetBrains Mono), lucide-react (icons), Vitest + @testing-library/react + jsdom (tests), Playwright (visual check). Backend: existing Fastify hub, better-sqlite3, Zod, the daemon's `HubClient`/`AgentLoop`.

## Global Constraints

- **TypeScript everywhere**, ESM (`"type": "module"`), monorepo via pnpm workspaces. Run pnpm as `npx pnpm ...` (pnpm is not on PATH in this environment).
- **Package manager:** `npx pnpm` for install/scripts; per-package `typecheck` script is `tsc -p tsconfig.json`.
- **Shared types** live in `@conclave/shared` and are imported with `.js` extension specifiers (NodeNext resolution), e.g. `import { AgentStatus } from "@conclave/shared"`.
- **Zod v4** (`zod@^4.4.3`) for all schemas; export both the schema and the inferred type.
- **Auth:** every hub route except `/health` requires `Authorization: Bearer <token>` or `?token=<token>`.
- **No hardcoded colors in the web app.** Every color is a CSS custom property from the Black-theme token set; structure tokens so the Teal set (step 8) is a drop-in with no component edits.
- **No runtime CDN fetches** (fonts via @fontsource, bundled). The app must work offline once loaded.
- **Fidelity target:** design handoff `design_handoff_conclave/README.md` + `screenshots/4a-black-main.png`, section `4a`. Exact tokens/spacing are in the README (sidebar 272px, right strip 280px, window strip 44px, radii 7–10px, etc.).
- **Tests:** Vitest. Never call live CLIs in tests; the daemon already has fake adapters. Commit after every green step.
- **Commit trailer:** end every commit message with `Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue`.

---

## File Structure

**Backend (modify/create):**
- `packages/shared/src/status.ts` (create) — agent-status + usage-summary schemas/types.
- `packages/shared/src/index.ts` (modify) — re-export `./status.js`.
- `packages/hub/src/status.ts` (create) — `AgentStatusStore` (in-memory, ephemeral).
- `packages/hub/src/usage.ts` (modify) — add `getUsageSummary`.
- `packages/hub/src/server.ts` (modify) — `/api/status` GET+POST, `/api/usage/summary`, `agent-status` WS frame.
- `packages/hub/src/main.ts` (modify) — construct `AgentStatusStore`, read `CONCLAVE_BUDGET_USD`.
- `packages/daemon/src/hub-client.ts` (modify) — `postStatus`.
- `packages/daemon/src/agent-loop.ts` (modify) — report status at turn boundaries + `parseResetTime`.

**Frontend (create) — `packages/web/`:**
- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `vitest.config.ts`.
- `src/main.tsx` — entry; imports fonts + global css; mounts `<App/>`.
- `src/styles/tokens.css` — Black theme custom properties.
- `src/styles/global.css` — resets, base typography.
- `src/lib/config.ts` — reads `VITE_CONCLAVE_TOKEN`, base URL.
- `src/lib/hubClient.ts` — typed HTTP methods.
- `src/lib/socket.ts` — `/ws` connection + frame union.
- `src/lib/agents.ts` — agent identity color/label helpers.
- `src/lib/parseMessage.ts` — message-body → render AST.
- `src/store/useConclaveStore.ts` — Zustand store (threads, messages, agents+status, usage, active session).
- `src/store/sync.ts` — hydrate + apply WS frames.
- `src/App.tsx` + region components under `src/components/` each with a co-located `.module.css`:
  - `WindowStrip.tsx`, `Sidebar.tsx`, `SessionTabs.tsx`, `ContextToolbar.tsx`, `GroupChat.tsx`, `ChatMessage.tsx`, `Composer.tsx`, `StatusStrip.tsx`, `Avatar.tsx`.
- `src/components/__tests__/*.test.tsx`, `src/lib/__tests__/*.test.ts` — unit/component tests.
- `e2e/visual.spec.ts` — Playwright screenshot vs `4a-black-main.png`.

---

## Task 1: Shared agent-status + usage-summary schemas

**Files:**
- Create: `packages/shared/src/status.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/status.test.ts`

**Interfaces:**
- Produces:
  - `AgentStatusReportSchema` / `AgentStatusReport` = `{ agent: string, status: "running"|"blocked"|"idle", activity: string, threadId?: string, resetsAt?: string }` (daemon → hub body; hub stamps `ts`).
  - `AgentStatusSchema` / `AgentStatus` = `AgentStatusReport & { ts: string }`.
  - `AgentUsage` = `{ agent: string, inputTokens: number, outputTokens: number, costUsd: number }`.
  - `UsageSummary` = `{ perAgent: AgentUsage[], totalCostUsd: number, budgetUsd: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/status.test.ts
import { describe, expect, it } from "vitest";
import { AgentStatusReportSchema, AgentStatusSchema } from "../src/status.js";

describe("agent status schemas", () => {
  it("accepts a minimal running report and defaults optionals absent", () => {
    const parsed = AgentStatusReportSchema.parse({
      agent: "claude-code",
      status: "running",
      activity: "debating idempotency",
    });
    expect(parsed.status).toBe("running");
    expect(parsed.threadId).toBeUndefined();
    expect(parsed.resetsAt).toBeUndefined();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      AgentStatusReportSchema.parse({ agent: "x", status: "sleeping", activity: "" }),
    ).toThrow();
  });

  it("stored status requires ts", () => {
    expect(() =>
      AgentStatusSchema.parse({ agent: "x", status: "idle", activity: "" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/shared exec vitest run test/status.test.ts`
Expected: FAIL — cannot resolve `../src/status.js`.

- [ ] **Step 3: Create the schema module**

```ts
// packages/shared/src/status.ts
import { z } from "zod";

export const AgentLiveStatusSchema = z.enum(["running", "blocked", "idle"]);

export const AgentStatusReportSchema = z.object({
  agent: z.string().min(1),
  status: AgentLiveStatusSchema,
  activity: z.string().default(""),
  threadId: z.string().optional(),
  resetsAt: z.string().datetime().optional(),
});

export const AgentStatusSchema = AgentStatusReportSchema.extend({
  ts: z.string().datetime(),
});

export const AgentUsageSchema = z.object({
  agent: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export const UsageSummarySchema = z.object({
  perAgent: z.array(AgentUsageSchema),
  totalCostUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative(),
});

export type AgentLiveStatus = z.infer<typeof AgentLiveStatusSchema>;
export type AgentStatusReport = z.infer<typeof AgentStatusReportSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
```

- [ ] **Step 4: Re-export from the package index**

```ts
// packages/shared/src/index.ts
export * from "./envelope.js";
export * from "./registry.js";
export * from "./orchestration.js";
export * from "./status.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/shared exec vitest run test/status.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx pnpm --filter @conclave/shared typecheck
git add packages/shared/src/status.ts packages/shared/src/index.ts packages/shared/test/status.test.ts
git commit -m "feat(shared): agent-status and usage-summary schemas

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 2: Hub agent-status store + `/api/status` + WS frame

**Files:**
- Create: `packages/hub/src/status.ts`
- Modify: `packages/hub/src/server.ts` (import store type into `ServerOptions`; add routes; extend `/ws`)
- Test: `packages/hub/test/status-api.test.ts`

**Interfaces:**
- Consumes: `AgentStatusReport`, `AgentStatus` (Task 1).
- Produces:
  - `class AgentStatusStore { readonly events: EventEmitter; set(report: AgentStatusReport): AgentStatus; list(): AgentStatus[] }` — `set` stamps `ts` (ISO now), stores latest per `agent`, emits `"agent-status"` with the stored `AgentStatus`.
  - `ServerOptions.status?: AgentStatusStore`.
  - Routes: `POST /api/status` (body `AgentStatusReportSchema` → 201 `AgentStatus`), `GET /api/status` → `AgentStatus[]`.
  - WS frame: `{ type: "agent-status", status: AgentStatus }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/test/status-api.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentStatus } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { AgentStatusStore } from "../src/status.js";
import { buildServer } from "../src/server.js";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function freshServer(): Promise<{ app: FastifyInstance; status: AgentStatusStore }> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-status-"));
  const mailbox = new Mailbox(openDb(join(dir, "test.db")));
  const status = new AgentStatusStore();
  const app = await buildServer({ mailbox, token: TOKEN, status });
  return { app, status };
}

describe("agent status API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await freshServer());
  });

  it("stores latest status per agent and stamps ts", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: AUTH,
      payload: { agent: "codex", status: "running", activity: "reviewing PR" },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json<AgentStatus>().ts).toBeTruthy();

    await app.inject({
      method: "POST",
      url: "/api/status",
      headers: AUTH,
      payload: { agent: "codex", status: "idle", activity: "" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/status", headers: AUTH });
    const all = listed.json<AgentStatus[]>();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ agent: "codex", status: "idle" });
  });

  it("rejects an invalid status body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: AUTH,
      payload: { agent: "codex", status: "nope", activity: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth", async () => {
    expect((await app.inject({ method: "GET", url: "/api/status" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/hub exec vitest run test/status-api.test.ts`
Expected: FAIL — cannot resolve `../src/status.js`.

- [ ] **Step 3: Create the status store**

```ts
// packages/hub/src/status.ts
import { EventEmitter } from "node:events";
import type { AgentStatus, AgentStatusReport } from "@conclave/shared";

export class AgentStatusStore {
  readonly events = new EventEmitter();
  private readonly byAgent = new Map<string, AgentStatus>();

  constructor() {
    this.events.setMaxListeners(0);
  }

  set(report: AgentStatusReport): AgentStatus {
    const status: AgentStatus = { ...report, ts: new Date().toISOString() };
    this.byAgent.set(report.agent, status);
    this.events.emit("agent-status", status);
    return status;
  }

  list(): AgentStatus[] {
    return [...this.byAgent.values()];
  }
}
```

- [ ] **Step 4: Wire routes + WS into the server**

In `packages/hub/src/server.ts`:

Add imports at top:
```ts
import { AgentStatusReportSchema } from "@conclave/shared";
import type { AgentStatus } from "@conclave/shared";
import type { AgentStatusStore } from "./status.js";
```

Add to `ServerOptions`:
```ts
  status?: AgentStatusStore;
```

Add routes (place after the `/api/usage` routes, before `/api/debates`):
```ts
  app.post("/api/status", async (req, reply) => {
    if (!opts.status) return reply.code(503).send({ error: "status store not configured" });
    const body = parseOr400(AgentStatusReportSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(opts.status.set(body));
  });

  app.get("/api/status", async (_req, reply) => {
    if (!opts.status) return reply.code(503).send({ error: "status store not configured" });
    return opts.status.list();
  });
```

Extend the `/ws` handler to also forward status frames — inside the `app.get("/ws", ...)` callback add:
```ts
    const onStatus = (status: AgentStatus): void => {
      socket.send(JSON.stringify({ type: "agent-status", status }));
    };
    if (opts.status) opts.status.events.on("agent-status", onStatus);
```
and in the existing `socket.on("close", ...)` cleanup add:
```ts
      if (opts.status) opts.status.events.off("agent-status", onStatus);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/hub exec vitest run test/status-api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck, run full hub suite, commit**

```bash
npx pnpm --filter @conclave/hub typecheck
npx pnpm --filter @conclave/hub exec vitest run
git add packages/hub/src/status.ts packages/hub/src/server.ts packages/hub/test/status-api.test.ts
git commit -m "feat(hub): agent-status store, /api/status routes, ws frame

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 3: Hub usage-summary read model + budget config

**Files:**
- Modify: `packages/hub/src/usage.ts` (add `getUsageSummary`)
- Modify: `packages/hub/src/server.ts` (`ServerOptions.budgetUsd`; `GET /api/usage/summary`)
- Modify: `packages/hub/src/main.ts` (read `CONCLAVE_BUDGET_USD`, pass store + budget)
- Test: `packages/hub/test/usage-summary.test.ts`

**Interfaces:**
- Consumes: `UsageSummary`, `AgentUsage` (Task 1); `AgentStatusStore` (Task 2).
- Produces:
  - `getUsageSummary(db: Database.Database, budgetUsd: number): UsageSummary` — SQL `SUM(...) GROUP BY agent` over `usage`; `totalCostUsd` = sum of all rows.
  - `ServerOptions.budgetUsd?: number` (default `25`).
  - Route `GET /api/usage/summary` → `UsageSummary` (503 if no `db`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/test/usage-summary.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { UsageSummary } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { getUsageSummary, recordUsage } from "../src/usage.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "conclave-usum-"));
  return openDb(join(dir, "test.db"));
}

describe("getUsageSummary", () => {
  it("aggregates per agent and totals, and echoes budget", () => {
    const db = freshDb();
    recordUsage(db, { agent: "codex", inputTokens: 100, outputTokens: 50, costUsd: 1.5 });
    recordUsage(db, { agent: "codex", inputTokens: 20, outputTokens: 10, costUsd: 0.5 });
    recordUsage(db, { agent: "claude-code", inputTokens: 5, outputTokens: 5, costUsd: 0.25 });

    const summary: UsageSummary = getUsageSummary(db, 25);
    expect(summary.budgetUsd).toBe(25);
    expect(summary.totalCostUsd).toBeCloseTo(2.25, 5);
    const codex = summary.perAgent.find((a) => a.agent === "codex");
    expect(codex).toMatchObject({ inputTokens: 120, outputTokens: 60 });
    expect(codex?.costUsd).toBeCloseTo(2.0, 5);
  });

  it("returns an empty summary when there is no usage", () => {
    const summary = getUsageSummary(freshDb(), 10);
    expect(summary.perAgent).toEqual([]);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.budgetUsd).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/hub exec vitest run test/usage-summary.test.ts`
Expected: FAIL — `getUsageSummary` is not exported.

- [ ] **Step 3: Implement `getUsageSummary`**

Append to `packages/hub/src/usage.ts`:
```ts
import type { UsageSummary, AgentUsage } from "@conclave/shared";

interface SummaryRow {
  agent: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function getUsageSummary(db: Database.Database, budgetUsd: number): UsageSummary {
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
  const perAgent: AgentUsage[] = rows.map((r) => ({
    agent: r.agent,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    costUsd: r.cost_usd ?? 0,
  }));
  const totalCostUsd = perAgent.reduce((sum, a) => sum + a.costUsd, 0);
  return { perAgent, totalCostUsd, budgetUsd };
}
```

- [ ] **Step 4: Add the route + option**

In `packages/hub/src/server.ts` add to `ServerOptions`:
```ts
  budgetUsd?: number;
```
Import: change `import { listUsage, recordUsage } from "./usage.js";` to also import `getUsageSummary`.
Add route (after `GET /api/usage`):
```ts
  app.get("/api/usage/summary", async (_req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    return getUsageSummary(opts.db, opts.budgetUsd ?? 25);
  });
```

- [ ] **Step 5: Wire main.ts**

In `packages/hub/src/main.ts`:
- Add import: `import { AgentStatusStore } from "./status.js";`
- After `const orchestrator = ...` add:
```ts
const status = new AgentStatusStore();
const budgetUsd = Number(process.env["CONCLAVE_BUDGET_USD"] ?? 25);
```
- Change the `buildServer` call to:
```ts
const app = await buildServer({ mailbox, token, registry, db, orchestrator, status, budgetUsd });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/hub exec vitest run test/usage-summary.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npx pnpm --filter @conclave/hub typecheck
npx pnpm --filter @conclave/hub exec vitest run
git add packages/hub/src/usage.ts packages/hub/src/server.ts packages/hub/src/main.ts packages/hub/test/usage-summary.test.ts
git commit -m "feat(hub): usage-summary read model, budget config, /api/usage/summary

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 4: Daemon reports agent status at turn boundaries

**Files:**
- Modify: `packages/daemon/src/hub-client.ts` (add `postStatus`)
- Modify: `packages/daemon/src/agent-loop.ts` (`parseResetTime`, `reportStatus`, calls in `runTurn`/`runDebateTurn`)
- Test: `packages/daemon/test/agent-status.test.ts`

**Interfaces:**
- Consumes: `AgentStatusReport` (Task 1); `HubClient` (existing).
- Produces:
  - `HubClient.postStatus(report: AgentStatusReport): Promise<void>` (POST `/api/status`, best-effort).
  - `parseResetTime(text: string): string | undefined` — exported from `agent-loop.ts`; parses an ISO/`HH:MM` reset hint from rate-limit error text, returns ISO or `undefined`.
  - Behavior: `running` (activity from thread topic) before `adapter.runTurn`; `idle` after success; `blocked` (+`resetsAt`) on `isError && rateLimited`; `idle` on thrown failure.

- [ ] **Step 1: Add `postStatus` to HubClient**

In `packages/daemon/src/hub-client.ts`:
- Add `AgentStatusReport` to the type import from `@conclave/shared`.
- Add method:
```ts
  async postStatus(report: AgentStatusReport): Promise<void> {
    await this.request("POST", "/api/status", report);
  }
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/daemon/test/agent-status.test.ts
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, Message } from "@conclave/shared";
import { AgentLoop, parseResetTime } from "../src/agent-loop.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { RuntimeAdapter, TurnResult } from "../src/adapter.js";

const AGENT: AgentConfig = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1",
  workspace: "/tmp/ws", role: "", allowedTools: [],
};

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 1, threadId: "t1", from: "you", to: ["codex"], type: "text",
    body: "hi", artifacts: [], ts: new Date().toISOString(), ...over,
  };
}

function fakeHub() {
  const statuses: Array<{ status: string; activity: string; resetsAt?: string }> = [];
  return {
    statuses,
    hub: {
      postStatus: vi.fn(async (r: { status: string; activity: string; resetsAt?: string }) => {
        statuses.push({ status: r.status, activity: r.activity, resetsAt: r.resetsAt });
      }),
      postMessage: vi.fn(async () => undefined),
      postUsage: vi.fn(async () => undefined),
    } as unknown as import("../src/hub-client.js").HubClient,
  };
}

function loopWith(adapter: RuntimeAdapter, hub: import("../src/hub-client.js").HubClient): AgentLoop {
  return new AgentLoop({
    agents: [AGENT], hub, adapters: { codex: adapter }, state: new DaemonState(),
    queue: new TurnQueue(), hubUrl: "http://h", token: "t", allowAgentTriggers: false,
  });
}

describe("daemon agent status reporting", () => {
  it("reports running then idle around a successful turn", async () => {
    const result: TurnResult = { text: "ok", isError: false, costUsd: 0, sessionId: "s", tokens: undefined };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, statuses } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleMessage(msg());
    await loop.idle();
    expect(statuses.map((s) => s.status)).toEqual(["running", "idle"]);
  });

  it("reports blocked with resetsAt on a rate-limit error", async () => {
    const result: TurnResult = {
      text: "429 rate limit exceeded; resets at 2026-07-13T16:40:00Z",
      isError: true, costUsd: 0, sessionId: undefined, tokens: undefined,
    };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, statuses } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleMessage(msg());
    await loop.idle();
    const blocked = statuses.find((s) => s.status === "blocked");
    expect(blocked?.resetsAt).toBe("2026-07-13T16:40:00Z");
  });

  it("parseResetTime extracts ISO timestamps", () => {
    expect(parseResetTime("try again at 2026-07-13T16:40:00Z")).toBe("2026-07-13T16:40:00Z");
    expect(parseResetTime("nothing here")).toBeUndefined();
  });
});
```

> Note: confirm the exact `TurnResult` shape from `packages/daemon/src/stream-json.ts` (`ParsedTurn`) when writing the test — fields used here are `text`, `isError`, `costUsd`, `sessionId`, `tokens`. Adjust literals to match.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/daemon exec vitest run test/agent-status.test.ts`
Expected: FAIL — `parseResetTime` not exported; no status reported.

- [ ] **Step 4: Implement in `agent-loop.ts`**

Add the exported helper (top-level):
```ts
export function parseResetTime(text: string): string | undefined {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (iso) return iso[0];
  return undefined;
}
```

Add a private method to `AgentLoop`:
```ts
  private async reportStatus(
    agent: AgentConfig,
    status: "running" | "blocked" | "idle",
    activity: string,
    threadId: string,
    resetsAt?: string,
  ): Promise<void> {
    try {
      await this.opts.hub.postStatus({ agent: agent.id, status, activity, threadId, resetsAt });
    } catch (e) {
      console.error(
        `agent ${agent.id}: failed to post status:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
```

In `runTurn`, wrap the adapter call:
- Before `const result = await adapter.runTurn(...)`:
  `await this.reportStatus(agent, "running", `replying in thread ${m.threadId}`, m.threadId);`
- After `await this.reportTurn(agent, m.threadId, result);` add:
```ts
      if (result.isError && /rate.?limit|usage limit|too many requests|429/i.test(result.text)) {
        await this.reportStatus(agent, "blocked", "rate-limited", m.threadId, parseResetTime(result.text));
      } else {
        await this.reportStatus(agent, "idle", "", m.threadId);
      }
```
- In the `catch (e)` block, after `await this.postFailure(...)`, add:
  `await this.reportStatus(agent, "idle", "", m.threadId);`

Apply the same three edits in `runDebateTurn` using `turn.threadId` and activity `` `debating in thread ${turn.threadId}` ``.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/daemon exec vitest run test/agent-status.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck, full daemon suite, commit**

```bash
npx pnpm --filter @conclave/daemon typecheck
npx pnpm --filter @conclave/daemon exec vitest run
git add packages/daemon/src/hub-client.ts packages/daemon/src/agent-loop.ts packages/daemon/test/agent-status.test.ts
git commit -m "feat(daemon): report agent status at turn boundaries

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 5: Scaffold `packages/web` (Vite + React + TS + Vitest)

**Files:**
- Create: `packages/web/package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`
- Create: `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`
- Create: `src/styles/tokens.css`, `src/styles/global.css`
- Create: `src/lib/config.ts`
- Modify: root `pnpm-workspace.yaml` already globs `packages/*` (verify).
- Test: `src/__tests__/smoke.test.tsx`

**Interfaces:**
- Produces: a runnable Vite app (`npx pnpm --filter @conclave/web dev`) proxying `/api` + `/ws` to the hub; `config` with `{ baseUrl: string, token: string, wsUrl(): string }`.

- [ ] **Step 1: Create the package manifest**

```json
// packages/web/package.json
{
  "name": "@conclave/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@conclave/shared": "workspace:*",
    "@fontsource/ibm-plex-sans": "^5.1.0",
    "@fontsource/jetbrains-mono": "^5.1.0",
    "lucide-react": "^0.400.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zustand": "^4.5.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig, vite config, vitest config, entry HTML**

```jsonc
// packages/web/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["vitest/globals", "@testing-library/jest-dom"],
    "noEmit": true
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

```ts
// packages/web/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HUB = process.env.CONCLAVE_HUB_URL ?? "http://localhost:7777";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      "/api": { target: HUB, changeOrigin: true },
      "/ws": { target: HUB, ws: true, changeOrigin: true },
    },
  },
});
```

```ts
// packages/web/vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    css: false,
  },
});
```

```html
<!-- packages/web/index.html -->
<!doctype html>
<html lang="en" data-theme="black">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Conclave</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```ts
// packages/web/src/test-setup.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Create tokens.css (Black theme — exact handoff values)**

```css
/* packages/web/src/styles/tokens.css */
:root[data-theme="black"] {
  --chrome: #000000;
  --surface: #0d0d0d;
  --rail: #050505;
  --card: #0d0d0d;
  --border-strong: #333333;
  --border: #1f1f1f;
  --border-2: #262626;
  --hairline: #1a1a1a;
  --hover: #171717;
  --chip: #1f1f1f;

  --text-primary: #f5f5f5;
  --text-body: #c9c9c9;
  --text-secondary: #8a8a8a;
  --text-secondary-2: #737373;
  --text-muted: #555555;
  --text-code: #a3a3a3;
  --code-bg: #000000;
  --inline-code-bg: #171717;

  --live: #2dd4bf;
  --blocked: #facc15;
  --warn: #f2a65a;
  --danger: #f87171;
  --usage-normal: #d4d4d4;

  --sel-bg: #f5f5f5;
  --sel-text: #0a0a0a;

  --agent-claude-code: #e8a06a;
  --agent-claude-code-text: #1a0f06;
  --agent-codex: #7dd3fc;
  --agent-codex-text: #06121a;
  --agent-reviewer: #c4b5fd;
  --agent-reviewer-text: #120a1f;
  --agent-default: #8a8a8a;
  --agent-default-text: #0a0a0a;

  --artifact-plan: #f28b82;
  --artifact-ticket: #fbbf24;

  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

```css
/* packages/web/src/styles/global.css */
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--chrome);
  color: var(--text-body);
  font-family: var(--font-sans);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
```

- [ ] **Step 4: Create config, entry, and a placeholder App**

```ts
// packages/web/src/lib/config.ts
const token = import.meta.env.VITE_CONCLAVE_TOKEN ?? "";

export const config = {
  token,
  apiHeaders(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  },
  wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${proto}://${location.host}/ws${q}`;
  },
};
```

```ts
// packages/web/src/vite-env.d.ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_CONCLAVE_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

```tsx
// packages/web/src/App.tsx
export function App(): JSX.Element {
  return <div data-testid="app-root">Conclave</div>;
}
```

```tsx
// packages/web/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/tokens.css";
import "./styles/global.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 5: Write the smoke test**

```tsx
// packages/web/src/__tests__/smoke.test.tsx
import { render, screen } from "@testing-library/react";
import { App } from "../App.js";

it("renders the app root", () => {
  render(<App />);
  expect(screen.getByTestId("app-root")).toBeInTheDocument();
});
```

- [ ] **Step 6: Install, typecheck, test**

```bash
npx pnpm install
npx pnpm --filter @conclave/web exec vitest run
npx pnpm --filter @conclave/web typecheck
```
Expected: install succeeds; smoke test PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(web): scaffold vite+react+ts app with black-theme tokens

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 6: Hub HTTP client + WebSocket frame stream

**Files:**
- Create: `packages/web/src/lib/hubClient.ts`
- Create: `packages/web/src/lib/socket.ts`
- Test: `packages/web/src/lib/__tests__/hubClient.test.ts`

**Interfaces:**
- Consumes: `config` (Task 5); shared types `Thread`, `Message`, `NewMessage`, `AgentConfig`, `AgentStatus`, `UsageSummary`.
- Produces:
  - `hubClient` object: `listThreads()`, `getThread(id)`, `listMessages(threadId, after?)`, `postMessage(threadId, msg: NewMessage)`, `getRegistry()`, `getStatus()`, `getUsageSummary()` — all return typed Promises.
  - `socket.ts`: `type WsFrame = { type:"message"; message: Message } | { type:"thread"; thread: Thread } | { type:"turn"; turn: TurnRequest } | { type:"agent-status"; status: AgentStatus }`; `connectSocket(onFrame: (f: WsFrame) => void): () => void` (returns a close fn; auto-reconnects with backoff).

- [ ] **Step 1: Write the failing test (fetch mocked)**

```ts
// packages/web/src/lib/__tests__/hubClient.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { hubClient } from "../hubClient.js";

afterEach(() => vi.restoreAllMocks());

describe("hubClient", () => {
  it("GET /api/threads returns parsed json with auth header", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "t1" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const threads = await hubClient.listThreads();
    expect(threads).toEqual([{ id: "t1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/threads", expect.objectContaining({ method: "GET" }));
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(hubClient.listThreads()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/hubClient.test.ts`
Expected: FAIL — cannot resolve `../hubClient.js`.

- [ ] **Step 3: Implement the client**

```ts
// packages/web/src/lib/hubClient.ts
import type {
  AgentConfig, AgentStatus, Message, NewMessage, Registry, Thread, UsageSummary,
} from "@conclave/shared";
import { config } from "./config.js";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...config.apiHeaders(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hub ${method} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const hubClient = {
  listThreads: () => req<Thread[]>("GET", "/api/threads"),
  getThread: (id: string) => req<Thread>("GET", `/api/threads/${id}`),
  listMessages: (threadId: string, after = 0) =>
    req<Message[]>("GET", `/api/threads/${threadId}/messages?after=${after}`),
  postMessage: (threadId: string, msg: NewMessage) =>
    req<Message>("POST", `/api/threads/${threadId}/messages`, msg),
  getRegistry: async () => (await req<Registry>("GET", "/api/registry")).agents as AgentConfig[],
  getStatus: () => req<AgentStatus[]>("GET", "/api/status"),
  getUsageSummary: () => req<UsageSummary>("GET", "/api/usage/summary"),
};
```

- [ ] **Step 4: Implement the socket**

```ts
// packages/web/src/lib/socket.ts
import type { AgentStatus, Message, Thread, TurnRequest } from "@conclave/shared";
import { config } from "./config.js";

export type WsFrame =
  | { type: "message"; message: Message }
  | { type: "thread"; thread: Thread }
  | { type: "turn"; turn: TurnRequest }
  | { type: "agent-status"; status: AgentStatus };

export function connectSocket(onFrame: (f: WsFrame) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const open = (): void => {
    if (closed) return;
    ws = new WebSocket(config.wsUrl());
    ws.onopen = () => { backoff = 500; };
    ws.onmessage = (ev) => {
      try {
        onFrame(JSON.parse(ev.data as string) as WsFrame);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
  };
  open();

  return () => {
    closed = true;
    ws?.close();
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/hubClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx pnpm --filter @conclave/web typecheck
git add packages/web/src/lib/hubClient.ts packages/web/src/lib/socket.ts packages/web/src/lib/__tests__/hubClient.test.ts
git commit -m "feat(web): hub http client and websocket frame stream

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 7: Agent identity helpers + Zustand store + sync

**Files:**
- Create: `packages/web/src/lib/agents.ts`
- Create: `packages/web/src/store/useConclaveStore.ts`
- Create: `packages/web/src/store/sync.ts`
- Test: `packages/web/src/store/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `hubClient` (Task 6), `WsFrame` (Task 6), shared types.
- Produces:
  - `agents.ts`: `agentColorVar(agentId: string): { bg: string; text: string }` returning CSS `var(--agent-*)` strings (known ids: claude-code, codex, reviewer; else default); `initials(name: string): string`.
  - `useConclaveStore` (Zustand) state: `threads: Thread[]`, `messagesByThread: Record<string, Message[]>`, `agents: AgentConfig[]`, `statusByAgent: Record<string, AgentStatus>`, `usage: UsageSummary | null`, `activeThreadId: string | null`, `openThreadIds: string[]`; actions `setActiveThread(id)`, `openThread(id)`, and frame-applying `applyFrame(f: WsFrame)`, plus `hydrate()`.
  - `sync.ts`: `startSync(): () => void` — hydrates the store then subscribes the socket; returns a teardown fn.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/store/__tests__/store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Message } from "@conclave/shared";

const baseMsg = (over: Partial<Message>): Message => ({
  id: 1, threadId: "t1", from: "you", to: [], type: "text", body: "hi",
  artifacts: [], ts: new Date().toISOString(), ...over,
});

describe("conclave store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("appends message frames under their thread, in id order, deduped", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "message", message: baseMsg({ id: 2, body: "second" }) });
    applyFrame({ type: "message", message: baseMsg({ id: 1, body: "first" }) });
    applyFrame({ type: "message", message: baseMsg({ id: 2, body: "second" }) }); // dup
    const msgs = useConclaveStore.getState().messagesByThread["t1"];
    expect(msgs.map((m) => m.id)).toEqual([1, 2]);
  });

  it("stores latest status per agent from agent-status frames", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "agent-status", status: { agent: "codex", status: "running", activity: "x", ts: "2026-07-13T10:00:00Z" } });
    applyFrame({ type: "agent-status", status: { agent: "codex", status: "idle", activity: "", ts: "2026-07-13T10:01:00Z" } });
    expect(useConclaveStore.getState().statusByAgent["codex"].status).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/store.test.ts`
Expected: FAIL — cannot resolve `../useConclaveStore.js`.

- [ ] **Step 3: Implement agent helpers**

```ts
// packages/web/src/lib/agents.ts
const KNOWN = new Set(["claude-code", "codex", "reviewer"]);

export function agentColorVar(agentId: string): { bg: string; text: string } {
  const key = KNOWN.has(agentId) ? agentId : "default";
  return { bg: `var(--agent-${key})`, text: `var(--agent-${key}-text)` };
}

export function initials(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
```

- [ ] **Step 4: Implement the store**

```ts
// packages/web/src/store/useConclaveStore.ts
import { create } from "zustand";
import type { AgentConfig, AgentStatus, Message, Thread, UsageSummary } from "@conclave/shared";
import type { WsFrame } from "../lib/socket.js";

interface State {
  threads: Thread[];
  messagesByThread: Record<string, Message[]>;
  agents: AgentConfig[];
  statusByAgent: Record<string, AgentStatus>;
  usage: UsageSummary | null;
  activeThreadId: string | null;
  openThreadIds: string[];
  setThreads(t: Thread[]): void;
  setMessages(threadId: string, m: Message[]): void;
  setAgents(a: AgentConfig[]): void;
  setStatuses(s: AgentStatus[]): void;
  setUsage(u: UsageSummary): void;
  setActiveThread(id: string): void;
  openThread(id: string): void;
  applyFrame(f: WsFrame): void;
  reset(): void;
}

function upsertMessage(list: Message[], m: Message): Message[] {
  if (list.some((x) => x.id === m.id)) return list;
  return [...list, m].sort((a, b) => a.id - b.id);
}

const initial = {
  threads: [] as Thread[],
  messagesByThread: {} as Record<string, Message[]>,
  agents: [] as AgentConfig[],
  statusByAgent: {} as Record<string, AgentStatus>,
  usage: null as UsageSummary | null,
  activeThreadId: null as string | null,
  openThreadIds: [] as string[],
};

export const useConclaveStore = create<State>((set) => ({
  ...initial,
  setThreads: (threads) => set({ threads }),
  setMessages: (threadId, m) =>
    set((s) => ({ messagesByThread: { ...s.messagesByThread, [threadId]: m } })),
  setAgents: (agents) => set({ agents }),
  setStatuses: (list) =>
    set({ statusByAgent: Object.fromEntries(list.map((x) => [x.agent, x])) }),
  setUsage: (usage) => set({ usage }),
  setActiveThread: (id) =>
    set((s) => ({
      activeThreadId: id,
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  openThread: (id) =>
    set((s) => ({
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
  applyFrame: (f) =>
    set((s) => {
      switch (f.type) {
        case "message": {
          const cur = s.messagesByThread[f.message.threadId] ?? [];
          return {
            messagesByThread: {
              ...s.messagesByThread,
              [f.message.threadId]: upsertMessage(cur, f.message),
            },
          };
        }
        case "thread": {
          const rest = s.threads.filter((t) => t.id !== f.thread.id);
          return { threads: [f.thread, ...rest] };
        }
        case "agent-status":
          return { statusByAgent: { ...s.statusByAgent, [f.status.agent]: f.status } };
        case "turn":
          return {};
        default:
          return {};
      }
    }),
  reset: () => set({ ...initial }),
}));
```

- [ ] **Step 5: Implement sync**

```ts
// packages/web/src/store/sync.ts
import { hubClient } from "../lib/hubClient.js";
import { connectSocket } from "../lib/socket.js";
import { useConclaveStore } from "./useConclaveStore.js";

export function startSync(): () => void {
  const store = useConclaveStore.getState();

  const hydrate = async (): Promise<void> => {
    const [threads, agents, statuses, usage] = await Promise.all([
      hubClient.listThreads(),
      hubClient.getRegistry(),
      hubClient.getStatus().catch(() => []),
      hubClient.getUsageSummary().catch(() => null),
    ]);
    store.setThreads(threads);
    store.setAgents(agents);
    store.setStatuses(statuses);
    if (usage) store.setUsage(usage);
    if (!useConclaveStore.getState().activeThreadId && threads.length > 0) {
      store.setActiveThread(threads[0].id);
      store.setMessages(threads[0].id, await hubClient.listMessages(threads[0].id));
    }
  };

  void hydrate();
  const close = connectSocket((f) => useConclaveStore.getState().applyFrame(f));
  return close;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
npx pnpm --filter @conclave/web typecheck
git add packages/web/src/lib/agents.ts packages/web/src/store
git commit -m "feat(web): agent identity helpers, zustand store, live sync

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 8: Message-body parser (mentions, inline code, file paths, code blocks)

**Files:**
- Create: `packages/web/src/lib/parseMessage.ts`
- Test: `packages/web/src/lib/__tests__/parseMessage.test.ts`

**Interfaces:**
- Produces:
  - `type InlineSeg = { kind:"text"; text:string } | { kind:"mention"; id:string } | { kind:"code"; text:string } | { kind:"file"; path:string }`
  - `type Block = { kind:"para"; segments: InlineSeg[] } | { kind:"codeblock"; lines: string[] }`
  - `parseMessageBody(body: string, knownAgentIds: string[]): Block[]`
  - Rules: fenced ` ``` ` blocks → `codeblock` (split into `lines`); `@id` where id ∈ knownAgentIds → `mention`; backtick `` `x` `` → inline `code`; `word/segments.ext:NN` → `file`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/lib/__tests__/parseMessage.test.ts
import { describe, expect, it } from "vitest";
import { parseMessageBody } from "../parseMessage.js";

describe("parseMessageBody", () => {
  it("extracts mentions only for known agents", () => {
    const blocks = parseMessageBody("hi @codex and @nobody", ["codex", "claude-code"]);
    const segs = blocks[0].kind === "para" ? blocks[0].segments : [];
    expect(segs.find((s) => s.kind === "mention")).toMatchObject({ id: "codex" });
    expect(segs.some((s) => s.kind === "text" && s.text.includes("@nobody"))).toBe(true);
  });

  it("parses inline code and file paths", () => {
    const blocks = parseMessageBody("see `key` in payments/idem.ts:41", []);
    const segs = blocks[0].kind === "para" ? blocks[0].segments : [];
    expect(segs.some((s) => s.kind === "code" && s.text === "key")).toBe(true);
    expect(segs.some((s) => s.kind === "file" && s.path === "payments/idem.ts:41")).toBe(true);
  });

  it("splits fenced code blocks into their own block with lines", () => {
    const body = "before\n```\nline1\nline2\n```\nafter";
    const blocks = parseMessageBody(body, []);
    const cb = blocks.find((b) => b.kind === "codeblock");
    expect(cb).toBeTruthy();
    expect(cb?.kind === "codeblock" && cb.lines).toEqual(["line1", "line2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/parseMessage.test.ts`
Expected: FAIL — cannot resolve `../parseMessage.js`.

- [ ] **Step 3: Implement the parser**

```ts
// packages/web/src/lib/parseMessage.ts
export type InlineSeg =
  | { kind: "text"; text: string }
  | { kind: "mention"; id: string }
  | { kind: "code"; text: string }
  | { kind: "file"; path: string };

export type Block =
  | { kind: "para"; segments: InlineSeg[] }
  | { kind: "codeblock"; lines: string[] };

const FILE_RE = /(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,8}(?::\d+)?/;
const MENTION_RE = /@([\w-]+)/;
const CODE_RE = /`([^`]+)`/;

function parseInline(text: string, known: Set<string>): InlineSeg[] {
  const segs: InlineSeg[] = [];
  let rest = text;
  while (rest.length > 0) {
    const code = CODE_RE.exec(rest);
    const file = FILE_RE.exec(rest);
    const mention = MENTION_RE.exec(rest);
    const cands = [
      code && { idx: code.index, len: code[0].length, seg: { kind: "code", text: code[1] } as InlineSeg },
      file && { idx: file.index, len: file[0].length, seg: { kind: "file", path: file[0] } as InlineSeg },
      mention && known.has(mention[1])
        ? { idx: mention.index, len: mention[0].length, seg: { kind: "mention", id: mention[1] } as InlineSeg }
        : null,
    ].filter(Boolean) as Array<{ idx: number; len: number; seg: InlineSeg }>;

    if (cands.length === 0) {
      segs.push({ kind: "text", text: rest });
      break;
    }
    const next = cands.reduce((a, b) => (b.idx < a.idx ? b : a));
    if (next.idx > 0) segs.push({ kind: "text", text: rest.slice(0, next.idx) });
    segs.push(next.seg);
    rest = rest.slice(next.idx + next.len);
  }
  return segs;
}

export function parseMessageBody(body: string, knownAgentIds: string[]): Block[] {
  const known = new Set(knownAgentIds);
  const blocks: Block[] = [];
  const parts = body.split(/```/);
  parts.forEach((part, i) => {
    const fenced = i % 2 === 1;
    if (fenced) {
      const lines = part.replace(/^\n/, "").replace(/\n$/, "").split("\n");
      blocks.push({ kind: "codeblock", lines });
    } else if (part.trim().length > 0) {
      for (const line of part.split("\n")) {
        if (line.trim().length === 0) continue;
        blocks.push({ kind: "para", segments: parseInline(line, known) });
      }
    }
  });
  return blocks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/parseMessage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx pnpm --filter @conclave/web typecheck
git add packages/web/src/lib/parseMessage.ts packages/web/src/lib/__tests__/parseMessage.test.ts
git commit -m "feat(web): message-body parser for mentions, code, file paths

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 9: Layout shell + Avatar (five regions, tokenized)

**Files:**
- Create: `packages/web/src/components/Avatar.tsx` (+ `Avatar.module.css`)
- Rewrite: `packages/web/src/App.tsx` (+ `App.module.css`)
- Create placeholder region components (filled in later tasks): `WindowStrip.tsx`, `Sidebar.tsx`, `SessionTabs.tsx`, `ContextToolbar.tsx`, `GroupChat.tsx`, `Composer.tsx`, `StatusStrip.tsx` (each + `.module.css`)
- Test: `packages/web/src/components/__tests__/Avatar.test.tsx`

**Interfaces:**
- Consumes: `agentColorVar`, `initials` (Task 7).
- Produces:
  - `Avatar({ name, kind }: { name: string; kind: "agent" | "human"; size?: number })` — square (radius 5px) for agents in the agent color; circle (50%) for humans in white.
  - `App` renders the CSS grid: window strip (44px) / [sidebar 272px | main | status 280px].

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/Avatar.test.tsx
import { render, screen } from "@testing-library/react";
import { Avatar } from "../Avatar.js";

it("renders agent initials in a square", () => {
  render(<Avatar name="claude-code" kind="agent" />);
  expect(screen.getByText("CL")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/Avatar.test.tsx`
Expected: FAIL — cannot resolve `../Avatar.js`.

- [ ] **Step 3: Implement Avatar**

```tsx
// packages/web/src/components/Avatar.tsx
import { agentColorVar, initials } from "../lib/agents.js";
import styles from "./Avatar.module.css";

export function Avatar({
  name, kind, size = 26,
}: { name: string; kind: "agent" | "human"; size?: number }): JSX.Element {
  const isAgent = kind === "agent";
  const color = isAgent
    ? agentColorVar(name)
    : { bg: "var(--sel-bg)", text: "var(--sel-text)" };
  return (
    <span
      className={styles.avatar}
      data-kind={kind}
      style={{
        width: size, height: size,
        borderRadius: isAgent ? 5 : "50%",
        background: color.bg, color: color.text,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {initials(name)}
    </span>
  );
}
```

```css
/* packages/web/src/components/Avatar.module.css */
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-weight: 700;
  flex: none;
  user-select: none;
}
```

- [ ] **Step 4: Create region placeholders**

For each of `WindowStrip`, `Sidebar`, `SessionTabs`, `ContextToolbar`, `GroupChat`, `Composer`, `StatusStrip`, create a minimal component exporting the named function returning a labelled container, e.g.:

```tsx
// packages/web/src/components/WindowStrip.tsx
import styles from "./WindowStrip.module.css";
export function WindowStrip(): JSX.Element {
  return <div className={styles.strip} data-testid="window-strip" />;
}
```
```css
/* packages/web/src/components/WindowStrip.module.css */
.strip { height: 44px; background: var(--chrome); border-bottom: 1px solid var(--border); }
```
Repeat with the correct region dimensions from the handoff: `Sidebar` (`width:272px; background:var(--rail); border-right:1px solid var(--border)`), `StatusStrip` (`width:280px; background:var(--rail); border-left:1px solid var(--border)`), `SessionTabs` (`background:var(--rail); border-bottom:1px solid var(--border)`), `ContextToolbar`, `GroupChat` (`background:var(--surface); flex:1`), `Composer`.

- [ ] **Step 5: Assemble App**

```tsx
// packages/web/src/App.tsx
import { useEffect } from "react";
import { startSync } from "./store/sync.js";
import { WindowStrip } from "./components/WindowStrip.js";
import { Sidebar } from "./components/Sidebar.js";
import { SessionTabs } from "./components/SessionTabs.js";
import { ContextToolbar } from "./components/ContextToolbar.js";
import { GroupChat } from "./components/GroupChat.js";
import { Composer } from "./components/Composer.js";
import { StatusStrip } from "./components/StatusStrip.js";
import styles from "./App.module.css";

export function App(): JSX.Element {
  useEffect(() => startSync(), []);
  return (
    <div className={styles.app} data-testid="app-root">
      <WindowStrip />
      <div className={styles.body}>
        <Sidebar />
        <main className={styles.main}>
          <SessionTabs />
          <ContextToolbar />
          <GroupChat />
          <Composer />
        </main>
        <StatusStrip />
      </div>
    </div>
  );
}
```

```css
/* packages/web/src/App.module.css */
.app { display: flex; flex-direction: column; height: 100%; }
.body { display: flex; flex: 1; min-height: 0; }
.main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
```

> Note: `startSync` runs a real fetch/WS on mount. In the smoke/component tests, stub `fetch` and `WebSocket` (jsdom lacks WS) — add `vi.stubGlobal("WebSocket", class { close() {} } as unknown)` in `src/test-setup.ts` or per-test. Update the existing smoke test to still pass (it asserts `app-root`).

- [ ] **Step 6: Run tests, typecheck**

Run: `npx pnpm --filter @conclave/web exec vitest run`
Expected: PASS (Avatar + smoke). Fix WS/fetch stubs if App mount throws.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): layout shell, region scaffolds, avatar

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 10: Sidebar — CHATS + AGENTS wired to the store

**Files:**
- Rewrite: `packages/web/src/components/Sidebar.tsx` (+ `Sidebar.module.css`)
- Test: `packages/web/src/components/__tests__/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `useConclaveStore` (threads, agents, statusByAgent, activeThreadId; `setActiveThread`), `Avatar`, `agentColorVar`.
- Produces: a 272px sidebar with an icon rail (Chats icon active only), a CHATS section (thread rows; selected = white pill; DM rows styled), and an AGENTS section (rows with live status dots).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/Sidebar.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { Sidebar } from "../Sidebar.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([
    { id: "t1", kind: "debate", workspace: "payments", participants: ["you", "codex"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" },
  ]);
  s.setAgents([
    { id: "codex", name: "codex", runtime: "codex", machine: "m1", workspace: "/w", role: "", allowedTools: [] },
  ]);
  s.setStatuses([{ agent: "codex", status: "running", activity: "x", ts: "2026-07-13T10:00:00Z" }]);
});

it("lists chats and agents and selects a thread on click", async () => {
  render(<Sidebar />);
  expect(screen.getByText(/payments/i)).toBeInTheDocument();
  expect(screen.getByText("codex")).toBeInTheDocument();
  await userEvent.click(screen.getByText(/payments/i));
  expect(useConclaveStore.getState().activeThreadId).toBe("t1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/Sidebar.test.tsx`
Expected: FAIL — Sidebar renders only the placeholder.

- [ ] **Step 3: Implement the Sidebar**

```tsx
// packages/web/src/components/Sidebar.tsx
import { MessageCircle } from "lucide-react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { agentColorVar } from "../lib/agents.js";
import { Avatar } from "./Avatar.js";
import styles from "./Sidebar.module.css";

function threadLabel(workspace: string | null, kind: string): string {
  if (workspace) return workspace;
  return kind === "dm" ? "direct message" : "thread";
}

export function Sidebar(): JSX.Element {
  const threads = useConclaveStore((s) => s.threads);
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const setActiveThread = useConclaveStore((s) => s.setActiveThread);
  const setMessages = useConclaveStore((s) => s.setMessages);

  const openThread = async (id: string): Promise<void> => {
    setActiveThread(id);
    const { hubClient } = await import("../lib/hubClient.js");
    setMessages(id, await hubClient.listMessages(id));
  };

  return (
    <aside className={styles.sidebar} data-testid="sidebar">
      <div className={styles.rail}>
        <button className={styles.railBtnActive} aria-label="chats"><MessageCircle size={16} /></button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>chats</div>
        {threads.map((t) => {
          const selected = t.id === activeThreadId;
          return (
            <button
              key={t.id}
              className={selected ? styles.rowSelected : styles.row}
              onClick={() => void openThread(t.id)}
            >
              <span className={styles.rowLabel}>{threadLabel(t.workspace, t.kind)}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>agents</div>
        {agents.map((a) => {
          const st = statusByAgent[a.id]?.status ?? "idle";
          return (
            <div key={a.id} className={styles.agentRow}>
              <Avatar name={a.id} kind="agent" size={18} />
              <span className={styles.agentName} style={{ color: agentColorVar(a.id).bg }}>{a.name}</span>
              <span
                className={styles.dot}
                data-status={st}
                style={{ background: st === "running" ? "var(--live)" : st === "blocked" ? "var(--blocked)" : "transparent" }}
              />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
```

```css
/* packages/web/src/components/Sidebar.module.css */
.sidebar { width: 272px; flex: none; background: var(--rail); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow-y: auto; }
.rail { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid var(--hairline); }
.railBtnActive { width: 32px; height: 30px; display: flex; align-items: center; justify-content: center;
  background: var(--hover); border-bottom: 2px solid var(--sel-bg); color: var(--text-primary); }
.section { padding: 10px 8px; }
.sectionHeader { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--text-muted); padding: 4px 6px 8px; }
.row, .rowSelected { display: flex; align-items: center; width: 100%; text-align: left;
  padding: 8px 12px; border-radius: 7px; font-size: 12.5px; }
.row { color: var(--text-secondary); }
.row:hover { background: var(--hover); }
.rowSelected { background: var(--sel-bg); color: var(--sel-text); font-weight: 600; }
.agentRow { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.agentName { font-size: 12.5px; flex: 1; }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot[data-status="running"] { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
```

- [ ] **Step 4: Run tests, typecheck**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/Sidebar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Sidebar.tsx packages/web/src/components/Sidebar.module.css packages/web/src/components/__tests__/Sidebar.test.tsx
git commit -m "feat(web): sidebar chats and agents wired to store

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 11: Group chat + ChatMessage rendering + typing indicator

**Files:**
- Rewrite: `packages/web/src/components/GroupChat.tsx` (+ `.module.css`)
- Create: `packages/web/src/components/ChatMessage.tsx` (+ `.module.css`)
- Test: `packages/web/src/components/__tests__/ChatMessage.test.tsx`

**Interfaces:**
- Consumes: `useConclaveStore` (activeThreadId, messagesByThread, agents, statusByAgent), `parseMessageBody` (Task 8), `Avatar`, `agentColorVar`.
- Produces:
  - `ChatMessage({ message })` — avatar (square agent / circle human), agent-colored name, timestamp, type badge (`proposal`→"plan", `verdict`, `status`→muted system line), body rendered from `parseMessageBody` (mention chips, inline code, file links, line-per-block code blocks).
  - `GroupChat` — scrolls messages of the active thread + a typing indicator for any participant whose live status is `running` on this thread.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/ChatMessage.test.tsx
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Message } from "@conclave/shared";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ChatMessage } from "../ChatMessage.js";

const msg: Message = {
  id: 1, threadId: "t1", from: "codex", to: [], type: "proposal",
  body: "use `key` in payments/idem.ts:41 cc @claude-code",
  artifacts: [], ts: "2026-07-13T10:00:00Z",
};

it("renders name, plan badge, inline code, file link and mention", () => {
  useConclaveStore.getState().reset();
  useConclaveStore.getState().setAgents([
    { id: "claude-code", name: "claude-code", runtime: "claude-code", machine: "m", workspace: "/w", role: "", allowedTools: [] },
  ]);
  render(<ChatMessage message={msg} />);
  expect(screen.getByText("codex")).toBeInTheDocument();
  expect(screen.getByText("plan")).toBeInTheDocument();
  expect(screen.getByText("key")).toBeInTheDocument();
  expect(screen.getByText("payments/idem.ts:41")).toBeInTheDocument();
  expect(screen.getByText("@claude-code")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/ChatMessage.test.tsx`
Expected: FAIL — cannot resolve `../ChatMessage.js`.

- [ ] **Step 3: Implement ChatMessage**

```tsx
// packages/web/src/components/ChatMessage.tsx
import type { Message } from "@conclave/shared";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { agentColorVar } from "../lib/agents.js";
import { parseMessageBody, type Block, type InlineSeg } from "../lib/parseMessage.js";
import { Avatar } from "./Avatar.js";
import styles from "./ChatMessage.module.css";

const BADGE: Partial<Record<Message["type"], string>> = { proposal: "plan", verdict: "verdict" };

function hhmm(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Inline({ seg }: { seg: InlineSeg }): JSX.Element {
  switch (seg.kind) {
    case "mention": return <span className={styles.mention}>@{seg.id}</span>;
    case "code": return <code className={styles.inlineCode}>{seg.text}</code>;
    case "file": return <a className={styles.file} href="#" onClick={(e) => e.preventDefault()}>{seg.path}</a>;
    default: return <>{seg.text}</>;
  }
}

function renderBlock(b: Block, i: number): JSX.Element {
  if (b.kind === "codeblock") {
    return (
      <pre key={i} className={styles.codeblock}>
        {b.lines.map((l, j) => <div key={j} className={styles.codeline}>{l || " "}</div>)}
      </pre>
    );
  }
  return <p key={i} className={styles.para}>{b.segments.map((s, j) => <Inline key={j} seg={s} />)}</p>;
}

export function ChatMessage({ message }: { message: Message }): JSX.Element {
  const agentIds = useConclaveStore((s) => s.agents.map((a) => a.id));
  const isHuman = message.from === "you";
  const badge = BADGE[message.type];

  if (message.type === "status") {
    return <div className={styles.systemLine} data-testid="status-line">{message.body}</div>;
  }

  const blocks = parseMessageBody(message.body, agentIds);
  return (
    <div className={styles.message}>
      <Avatar name={message.from} kind={isHuman ? "human" : "agent"} />
      <div className={styles.content}>
        <div className={styles.header}>
          <span className={styles.name} style={{ color: isHuman ? "var(--text-primary)" : agentColorVar(message.from).bg }}>
            {message.from}
          </span>
          <span className={styles.ts}>{hhmm(message.ts)}</span>
          {badge && <span className={styles.badge}>{badge}</span>}
        </div>
        <div className={styles.body}>{blocks.map(renderBlock)}</div>
      </div>
    </div>
  );
}
```

```css
/* packages/web/src/components/ChatMessage.module.css */
.message { display: flex; gap: 12px; }
.content { flex: 1; min-width: 0; }
.header { display: flex; align-items: baseline; gap: 8px; }
.name { font-weight: 600; font-size: 13px; }
.ts { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }
.badge { border: 1px solid var(--border-strong); color: var(--usage-normal); border-radius: 9px;
  padding: 0 7px; font-size: 10.5px; }
.body { font-size: 13px; line-height: 1.65; color: var(--text-body); }
.para { margin: 4px 0; }
.mention { background: var(--chip); color: var(--text-primary); padding: 0 5px; border-radius: 4px; }
.inlineCode { background: var(--inline-code-bg); color: #e5e5e5; font-family: var(--font-mono);
  font-size: 12px; border-radius: 4px; padding: 0 3px; }
.file { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
.codeblock { background: var(--code-bg); border: 1px solid var(--border); border-radius: 7px;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-code); padding: 12px 14px; overflow-x: auto; }
.codeline { white-space: pre; }
.systemLine { font-size: 12px; color: var(--text-secondary-2); font-style: italic; padding: 2px 0 2px 38px; }
```

- [ ] **Step 4: Implement GroupChat**

```tsx
// packages/web/src/components/GroupChat.tsx
import { useConclaveStore } from "../store/useConclaveStore.js";
import { ChatMessage } from "./ChatMessage.js";
import styles from "./GroupChat.module.css";

export function GroupChat(): JSX.Element {
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const messages = useConclaveStore((s) => (activeThreadId ? s.messagesByThread[activeThreadId] : undefined)) ?? [];
  const threads = useConclaveStore((s) => s.threads);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);

  const active = threads.find((t) => t.id === activeThreadId);
  const typing = (active?.participants ?? []).filter(
    (p) => p !== "you" && statusByAgent[p]?.status === "running" && statusByAgent[p]?.threadId === activeThreadId,
  );

  return (
    <div className={styles.chat} data-testid="group-chat">
      {messages.map((m) => <ChatMessage key={m.id} message={m} />)}
      {typing.map((p) => (
        <div key={p} className={styles.typing}>{p} is thinking<span className={styles.cursor}>▮</span></div>
      ))}
    </div>
  );
}
```

```css
/* packages/web/src/components/GroupChat.module.css */
.chat { flex: 1; min-height: 0; overflow-y: auto; background: var(--surface);
  padding: 20px 26px; display: flex; flex-direction: column; gap: 16px; }
.typing { color: var(--text-secondary-2); font-size: 12px; }
.cursor { margin-left: 4px; animation: blink 1.1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }
```

- [ ] **Step 5: Run tests, typecheck**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/ChatMessage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/GroupChat.tsx packages/web/src/components/GroupChat.module.css packages/web/src/components/ChatMessage.tsx packages/web/src/components/ChatMessage.module.css packages/web/src/components/__tests__/ChatMessage.test.tsx
git commit -m "feat(web): group chat with message rendering and typing indicator

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 12: Composer with @mention autocomplete → `to[]`

**Files:**
- Rewrite: `packages/web/src/components/Composer.tsx` (+ `.module.css`)
- Test: `packages/web/src/components/__tests__/Composer.test.tsx`

**Interfaces:**
- Consumes: `useConclaveStore` (activeThreadId, threads, agents), `hubClient.postMessage`.
- Produces: a composer that, on ⏎ (no Shift), posts `{ from:"you", to: mentionedAgentIds, body }` to the active thread and clears; `@` shows an autocomplete list of the thread's agent participants; picking one inserts `@id `. Mentioned known-agent ids are parsed out of the body into `to[]` on send.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/Composer.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { Composer } from "../Composer.js";
import { hubClient } from "../../lib/hubClient.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([{ id: "t1", kind: "chat", workspace: "w", participants: ["you", "codex"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" }]);
  s.setAgents([{ id: "codex", name: "codex", runtime: "codex", machine: "m", workspace: "/w", role: "", allowedTools: [] }]);
  s.setActiveThread("t1");
});

it("sends a message with mentioned agents in to[]", async () => {
  const spy = vi.spyOn(hubClient, "postMessage").mockResolvedValue({} as never);
  render(<Composer />);
  const box = screen.getByRole("textbox");
  await userEvent.type(box, "hey @codex ping{Enter}");
  expect(spy).toHaveBeenCalledWith("t1", expect.objectContaining({ from: "you", to: ["codex"], body: "hey @codex ping" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/Composer.test.tsx`
Expected: FAIL — Composer is a placeholder.

- [ ] **Step 3: Implement the Composer**

```tsx
// packages/web/src/components/Composer.tsx
import { useMemo, useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./Composer.module.css";

export function Composer(): JSX.Element {
  const [text, setText] = useState("");
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const threads = useConclaveStore((s) => s.threads);
  const agents = useConclaveStore((s) => s.agents);

  const active = threads.find((t) => t.id === activeThreadId);
  const participantAgents = useMemo(
    () => agents.filter((a) => active?.participants.includes(a.id)),
    [agents, active],
  );
  const mentionQuery = /(?:^|\s)@([\w-]*)$/.exec(text)?.[1];
  const suggestions = mentionQuery !== undefined
    ? participantAgents.filter((a) => a.id.startsWith(mentionQuery))
    : [];

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || !activeThreadId) return;
    const ids = new Set(participantAgents.map((a) => a.id));
    const to = [...new Set([...body.matchAll(/@([\w-]+)/g)].map((m) => m[1]).filter((id) => ids.has(id)))];
    setText("");
    await hubClient.postMessage(activeThreadId, { from: "you", to, type: "text", body, artifacts: [] });
  };

  const pick = (id: string): void => setText((t) => t.replace(/@[\w-]*$/, `@${id} `));

  return (
    <div className={styles.wrap}>
      {suggestions.length > 0 && (
        <div className={styles.suggest}>
          {suggestions.map((a) => (
            <button key={a.id} className={styles.suggestItem} onClick={() => pick(a.id)}>@{a.id}</button>
          ))}
        </div>
      )}
      <div className={styles.composer}>
        <span className={styles.glyph}>›</span>
        <textarea
          className={styles.input}
          rows={1}
          value={text}
          placeholder="Message war-room — @agent to direct, /task to assign"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <span className={styles.hint}>⏎ send</span>
      </div>
    </div>
  );
}
```

```css
/* packages/web/src/components/Composer.module.css */
.wrap { padding: 0 26px 16px; position: relative; }
.composer { display: flex; align-items: center; gap: 10px; background: var(--rail);
  border: 1px solid var(--border-strong); border-radius: 10px; padding: 13px 16px; }
.glyph { color: var(--text-primary); }
.input { flex: 1; resize: none; background: none; border: none; color: var(--text-body);
  font-family: var(--font-sans); font-size: 13px; outline: none; }
.input::placeholder { color: var(--text-muted); }
.hint { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }
.suggest { position: absolute; bottom: 60px; left: 26px; background: var(--card);
  border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.suggestItem { display: block; width: 100%; text-align: left; padding: 6px 12px; font-size: 12.5px; color: var(--text-body); }
.suggestItem:hover { background: var(--hover); }
```

- [ ] **Step 4: Run tests, typecheck**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/Composer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Composer.tsx packages/web/src/components/Composer.module.css packages/web/src/components/__tests__/Composer.test.tsx
git commit -m "feat(web): composer with @mention autocomplete and to[] routing

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 13: Right status strip — LIVE STATUS + USAGE LIMITS

**Files:**
- Rewrite: `packages/web/src/components/StatusStrip.tsx` (+ `.module.css`)
- Test: `packages/web/src/components/__tests__/StatusStrip.test.tsx`

**Interfaces:**
- Consumes: `useConclaveStore` (agents, statusByAgent, usage), `agentColorVar`.
- Produces: LIVE STATUS cards per agent (swatch, name, running/blocked pill, activity line, indeterminate progress bar while running); USAGE LIMITS card per agent (real tokens + cost, cost-vs-budget meter, `resets HH:MM` when blocked with `resetsAt`); footer `$spent / $budget`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/StatusStrip.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { StatusStrip } from "../StatusStrip.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setAgents([{ id: "codex", name: "codex", runtime: "codex", machine: "m", workspace: "/w", role: "", allowedTools: [] }]);
  s.setStatuses([{ agent: "codex", status: "running", activity: "reviewing PR", ts: "2026-07-13T10:00:00Z" }]);
  s.setUsage({ perAgent: [{ agent: "codex", inputTokens: 100, outputTokens: 50, costUsd: 4.82 }], totalCostUsd: 4.82, budgetUsd: 25 });
});

it("shows live activity and workspace spend", () => {
  render(<StatusStrip />);
  expect(screen.getByText("reviewing PR")).toBeInTheDocument();
  expect(screen.getByText(/\$4\.82 \/ \$25/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/StatusStrip.test.tsx`
Expected: FAIL — StatusStrip is a placeholder.

- [ ] **Step 3: Implement StatusStrip**

```tsx
// packages/web/src/components/StatusStrip.tsx
import { useConclaveStore } from "../store/useConclaveStore.js";
import { agentColorVar } from "../lib/agents.js";
import styles from "./StatusStrip.module.css";

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function StatusStrip(): JSX.Element {
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const usage = useConclaveStore((s) => s.usage);
  const budget = usage?.budgetUsd ?? 0;

  return (
    <aside className={styles.strip} data-testid="status-strip">
      <div className={styles.sectionHeader}>live status</div>
      {agents.map((a) => {
        const st = statusByAgent[a.id];
        const status = st?.status ?? "idle";
        return (
          <div key={a.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.swatch} style={{ background: agentColorVar(a.id).bg }} />
              <span className={styles.name}>{a.name}</span>
              <span className={styles.status} data-status={status}>
                ● {status}
              </span>
            </div>
            <div className={styles.activity}>{st?.activity || "idle"}</div>
            <div className={styles.progressTrack}>
              <div className={status === "running" ? styles.progressRunning : styles.progressIdle} />
            </div>
          </div>
        );
      })}

      <div className={styles.sectionHeader}>usage limits</div>
      {(usage?.perAgent ?? []).map((u) => {
        const st = statusByAgent[u.agent];
        const pct = budget > 0 ? Math.min(100, Math.round((u.costUsd / budget) * 100)) : 0;
        return (
          <div key={u.agent} className={styles.usageRow}>
            <span className={styles.swatch} style={{ background: agentColorVar(u.agent).bg }} />
            <span className={styles.name}>{u.agent}</span>
            <span className={styles.metric}>
              {(u.inputTokens + u.outputTokens).toLocaleString()} tok · ${u.costUsd.toFixed(2)}
              {st?.status === "blocked" && st.resetsAt ? ` · resets ${hhmm(st.resetsAt)}` : ""}
            </span>
            <div className={styles.usageTrack}><div className={styles.usageFill} style={{ width: `${pct}%` }} /></div>
          </div>
        );
      })}

      <div className={styles.footer}>
        <span>workspace today</span>
        <span className={styles.spend}>${(usage?.totalCostUsd ?? 0).toFixed(2)} / ${budget}</span>
      </div>
    </aside>
  );
}
```

```css
/* packages/web/src/components/StatusStrip.module.css */
.strip { width: 280px; flex: none; background: var(--rail); border-left: 1px solid var(--border);
  padding: 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.sectionHeader { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--text-muted); margin-top: 8px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.cardHead { display: flex; align-items: center; gap: 8px; }
.swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
.name { font-weight: 600; color: var(--text-primary); font-size: 12.5px; flex: 1; }
.status { font-size: 11px; font-family: var(--font-mono); }
.status[data-status="running"] { color: var(--live); }
.status[data-status="blocked"] { color: var(--blocked); }
.status[data-status="idle"] { color: var(--text-muted); }
.activity { color: var(--text-secondary-2); font-size: 11px; margin: 6px 0; }
.progressTrack { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
.progressRunning { height: 100%; width: 40%; background: var(--sel-bg); border-radius: 2px;
  animation: indeterminate 1.6s ease-in-out infinite; }
.progressIdle { height: 100%; width: 0; }
@keyframes indeterminate { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
.usageRow { display: grid; grid-template-columns: 12px 1fr auto; column-gap: 8px; align-items: center; padding: 4px 0; }
.metric { grid-column: 1 / -1; font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary-2); }
.usageTrack { grid-column: 1 / -1; height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; }
.usageFill { height: 100%; background: var(--usage-normal); }
.footer { display: flex; justify-content: space-between; border-top: 1px solid var(--border);
  padding-top: 10px; margin-top: auto; font-size: 11px; color: var(--text-secondary-2); }
.spend { font-family: var(--font-mono); color: var(--text-primary); }
```

- [ ] **Step 4: Run tests, typecheck**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/StatusStrip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/StatusStrip.tsx packages/web/src/components/StatusStrip.module.css packages/web/src/components/__tests__/StatusStrip.test.tsx
git commit -m "feat(web): right status strip with live status and usage meters

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 14: Window strip, session tabs, context toolbar

**Files:**
- Rewrite: `packages/web/src/components/WindowStrip.tsx`, `SessionTabs.tsx`, `ContextToolbar.tsx` (+ their `.module.css`)
- Test: `packages/web/src/components/__tests__/SessionTabs.test.tsx`

**Interfaces:**
- Consumes: `useConclaveStore` (threads, openThreadIds, activeThreadId, usage, agents; `setActiveThread`).
- Produces:
  - `WindowStrip` — one workspace tab (derived from the active thread's `workspace`, else "workspace"), settings ⚙ + history icons, right-aligned live spend `$X · Ntok` from usage.
  - `SessionTabs` — a tab per `openThreadIds`; active tab has the 2px white top border; clicking activates.
  - `ContextToolbar` — `N agents ▾` (active thread participant count), workspace label, right-aligned derived thread-state text (`● open`/`● settled`/`● closed`). No Epic Mode / Fork.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/SessionTabs.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { SessionTabs } from "../SessionTabs.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([
    { id: "t1", kind: "chat", workspace: "alpha", participants: ["you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" },
    { id: "t2", kind: "chat", workspace: "beta", participants: ["you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" },
  ]);
  s.setActiveThread("t1");
  s.openThread("t2");
});

it("switches active thread when a tab is clicked", async () => {
  render(<SessionTabs />);
  await userEvent.click(screen.getByText(/beta/i));
  expect(useConclaveStore.getState().activeThreadId).toBe("t2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/SessionTabs.test.tsx`
Expected: FAIL — SessionTabs is a placeholder.

- [ ] **Step 3: Implement the three components**

```tsx
// packages/web/src/components/SessionTabs.tsx
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./SessionTabs.module.css";

export function SessionTabs(): JSX.Element {
  const threads = useConclaveStore((s) => s.threads);
  const openIds = useConclaveStore((s) => s.openThreadIds);
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const setActive = useConclaveStore((s) => s.setActiveThread);

  const label = (id: string): string => threads.find((t) => t.id === id)?.workspace ?? "thread";

  return (
    <div className={styles.tabs} data-testid="session-tabs">
      {openIds.map((id) => (
        <button key={id} className={id === activeId ? styles.tabActive : styles.tab} onClick={() => setActive(id)}>
          <span className={styles.glyph}>❖</span>{label(id)}
        </button>
      ))}
    </div>
  );
}
```

```css
/* packages/web/src/components/SessionTabs.module.css */
.tabs { display: flex; gap: 2px; background: var(--rail); border-bottom: 1px solid var(--border); padding: 0 8px; }
.tab, .tabActive { display: flex; align-items: center; gap: 6px; padding: 9px 14px; font-size: 12.5px;
  border-top: 2px solid transparent; }
.tab { color: var(--text-secondary-2); }
.tabActive { color: var(--text-primary); background: var(--surface); border-top-color: var(--sel-bg); }
.glyph { color: var(--text-secondary); }
```

```tsx
// packages/web/src/components/ContextToolbar.tsx
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./ContextToolbar.module.css";

export function ContextToolbar(): JSX.Element {
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const thread = useConclaveStore((s) => s.threads.find((t) => t.id === activeId));
  const count = (thread?.participants ?? []).filter((p) => p !== "you").length;

  return (
    <div className={styles.toolbar} data-testid="context-toolbar">
      <span className={styles.item}>{count} agents ▾</span>
      <span className={styles.sep}>·</span>
      <span className={styles.item}>▣ {thread?.workspace ?? "workspace"}</span>
      <span className={styles.state}>● {thread?.state ?? "open"}</span>
    </div>
  );
}
```

```css
/* packages/web/src/components/ContextToolbar.module.css */
.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 20px; font-size: 12px;
  color: var(--text-secondary); background: var(--surface); border-bottom: 1px solid var(--hairline); }
.sep { color: var(--text-muted); }
.state { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
```

```tsx
// packages/web/src/components/WindowStrip.tsx
import { Settings, History } from "lucide-react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./WindowStrip.module.css";

export function WindowStrip(): JSX.Element {
  const usage = useConclaveStore((s) => s.usage);
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const ws = useConclaveStore((s) => s.threads.find((t) => t.id === activeId)?.workspace) ?? "workspace";
  const tokens = (usage?.perAgent ?? []).reduce((n, a) => n + a.inputTokens + a.outputTokens, 0);

  return (
    <div className={styles.strip} data-testid="window-strip">
      <div className={styles.tabActive}>{ws}<span className={styles.close}>×</span></div>
      <div className={styles.right}>
        <Settings size={14} className={styles.icon} />
        <History size={14} className={styles.icon} />
        <span className={styles.spend}>${(usage?.totalCostUsd ?? 0).toFixed(2)} · {(tokens / 1000).toFixed(0)}k tok</span>
      </div>
    </div>
  );
}
```

```css
/* packages/web/src/components/WindowStrip.module.css */
.strip { height: 44px; display: flex; align-items: flex-end; gap: 8px; padding: 0 12px;
  background: var(--chrome); border-bottom: 1px solid var(--border); }
.tabActive { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: var(--surface);
  border: 1px solid var(--border-2); border-bottom: none; border-radius: 8px 8px 0 0; color: var(--text-primary); font-size: 12.5px; }
.close { color: var(--text-muted); }
.right { display: flex; align-items: center; gap: 12px; margin-left: auto; padding-bottom: 8px; }
.icon { color: var(--text-muted); }
.spend { font-family: var(--font-mono); font-size: 12px; color: #e5e5e5; }
```

- [ ] **Step 4: Run tests, typecheck, full web suite**

Run: `npx pnpm --filter @conclave/web exec vitest run`
Expected: all web tests PASS. `npx pnpm --filter @conclave/web typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components
git commit -m "feat(web): window strip, session tabs, context toolbar

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 15: End-to-end verification against section 4a

**Files:**
- Create: `packages/web/e2e/visual.spec.ts`
- Create: `packages/web/.env.local.example` (documents `VITE_CONCLAVE_TOKEN`)
- Modify: `packages/daemon/README.md` — add a "run the web app" section to the smoke checklist.

**Interfaces:** none (verification only).

- [ ] **Step 1: Seed a hub with realistic data**

Start a hub with a token and budget, create a debate thread, and post a few messages (text + a proposal + a code block) so the chat renders content resembling `4a`:
```bash
export CONCLAVE_TOKEN=dev CONCLAVE_BUDGET_USD=25 CONCLAVE_DATA_DIR=./data-dev
npx pnpm --filter @conclave/hub exec tsx src/main.ts &
# create a thread + messages via curl (see packages/daemon/README.md smoke checklist for the curl recipes)
```
Post at least one `agent-status` (POST `/api/status`) and one `usage` (POST `/api/usage`) so the right rail shows live data.

- [ ] **Step 2: Run the web app against the hub**

```bash
VITE_CONCLAVE_TOKEN=dev npx pnpm --filter @conclave/web dev
```
Open `http://localhost:5273`.

- [ ] **Step 3: Drive it with the run/verify skill + Playwright**

Use the `verify` skill (or the Playwright MCP browser tools) to load the page, confirm: sidebar lists the thread + agents with live dots, chat renders messages with mention chips / inline code / code blocks, composer @mention autocomplete appears and sending routes to `to[]` (watch the hub receive the message), and the right rail shows live status + usage/spend. Take a screenshot.

- [ ] **Step 4: Compare to the canonical screenshot**

```ts
// packages/web/e2e/visual.spec.ts — a Playwright test that navigates to the running app,
// waits for [data-testid="group-chat"], and screenshots full-page for manual diff vs
// design_handoff_conclave/screenshots/4a-black-main.png. (Pixel-diff is manual this step.)
```
Visually diff the screenshot against `design_handoff_conclave/screenshots/4a-black-main.png`. Note deviations; fix token/spacing regressions where cheap, log the rest.

- [ ] **Step 5: Full monorepo green**

```bash
npx pnpm -r typecheck
npx pnpm -r exec vitest run
```
Expected: all packages typecheck and all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/e2e packages/web/.env.local.example packages/daemon/README.md
git commit -m "test(web): e2e visual check vs section 4a; smoke checklist for web app

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Self-Review Notes

- **Spec coverage:** §3 stack → Tasks 5–7; §4.1 agent status → Tasks 1,2,4; §4.2 usage summary → Tasks 1,3; §5.1 data layer → Tasks 6,7; §5.2 regions → window strip/session tabs/toolbar (14), sidebar (10), group chat (11), composer (12), status strip (13); §6 testing → tests in every task + Task 15; §7 deferrals → honored (no terminals/artifacts/Teal/file-nav/Epic/Fork tasks). 
- **Deferred-by-design (not gaps):** unread badges and workspace-tab multiplexing are represented minimally (single workspace tab, no unread count) — acceptable for MVP; note if the user wants them promoted. DM-row ⇄ treatment is folded into the sidebar row styling; a dedicated DM glyph can be added when DM threads exist in seed data.
- **Type consistency:** `AgentStatus`/`AgentStatusReport`, `UsageSummary`/`AgentUsage`, `WsFrame`, and store action names (`applyFrame`, `setActiveThread`, `setMessages`, `reset`) are used identically across tasks.
- **Known follow-up:** `parseResetTime` only extracts ISO timestamps; `HH:MM`-only reset hints fall through to `undefined` (documented; refine when live-adapter rate-limit formats are known — spec decision 3 defers full windows anyway).
