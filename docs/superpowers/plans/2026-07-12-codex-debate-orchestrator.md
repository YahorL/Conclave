# Conclave Step 3: Codex Adapter + Debate Orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents argue: a hub-side debate orchestrator runs stance-assigned, round-capped debates between agents (Claude Code and Codex), driving turns through a dedicated turn-request channel — plus the step-2 review prerequisites: persisted message cursor with catch-up, rate-limit/error surfacing, and token-usage reporting.

**Architecture:** The orchestrator lives in the hub process next to the Mailbox and emits `turn` frames over the existing WebSocket (a control channel the daemon consumes directly, bypassing the @-mention trigger rules). The daemon gains: a `DaemonState` (persisted cursor + per-thread turn watermarks + sessions, replacing both `SessionStore` and the in-memory dedup set), a catch-up scan on every (re)connect with frame buffering so nothing interleaves out of order, a `CodexAdapter` speaking `codex exec --json` JSONL, and a per-runtime adapters map. Debate messages use `to: []` everywhere so the mention path stays silent; only turn frames drive debate turns.

**Tech Stack:** Existing monorepo (Node ≥22, TS strict ESM, Vitest). No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §6 (debates: min 2 / max 4 rounds, forced verdicts, settle rules, anti-convergence stances, orchestrator posts synthesized summary; usage-aware scheduling is deliberately DEFERRED to a later step — do not build it). PR-flavored seeding: the topic text tells agents which branch/PR to review **in their own workspace using their own tools** (`git diff`, `gh pr diff`); the containerized hub never touches repos. Posting verdicts back to GitHub is out of scope.
- **Codex CLI contract (verified against installed codex-cli 0.144.1):** turn = `codex exec --json --sandbox workspace-write -c approval_policy=never` (resume = `codex exec resume <thread_id>` + same flags), prompt via **stdin** (no PROMPT arg), cwd = spawn cwd. JSONL events: `thread.started {thread_id}`, `item.completed {item:{type:"agent_message", text}}`, `turn.completed {usage:{input_tokens, cached_input_tokens, output_tokens,...}}`, `turn.failed {error:{message}}`. Per-invocation MCP via `-c mcp_servers.<name>.command="..."`, `-c mcp_servers.<name>.args=[...]`, `-c mcp_servers.<name>.env.KEY="..."` (TOML values — `JSON.stringify` produces valid TOML basic strings/arrays here). No `--ask-for-approval` flag on exec; no `--allowedTools` equivalent (sandbox is the control; `AgentConfig.allowedTools` applies to claude-code only). No dollar cost in output — tokens only. `--dangerously-bypass-approvals-and-sandbox` is forbidden.
- **Turn-request rule:** orchestrator-driven turns bypass `shouldTrigger` entirely via `{type:"turn"}` WS frames. Do NOT set `CONCLAVE_ALLOW_AGENT_TRIGGERS=1` anywhere in this step. Debate seed messages and all agent debate replies use `to: []` (never @-mention) so the mention path cannot double-fire.
- **Cursor rule:** the daemon processes inbound messages exactly once across live frames, catch-up, and restarts, keyed on the persisted cursor. Catch-up must complete before buffered live frames flush (HubSocket buffers during `onOpen`).
- Orchestrator timeout semantics: single-strike — an agent that produces neither a reply nor a verdict within `turnTimeoutMs` gets `setVerdict(agent, "no-response (timeout)")` plus a status message, and is skipped thereafter. Finale: non-settled agents get one forced-verdict turn (`finaleTimeoutMs`), then `"no-response"`.
- Tests never invoke real `claude` or `codex` binaries (fixtures only). Integration tests use in-process hubs. TypeScript strict, no `any`. Conventional commits, no attribution trailers. TDD per task. `npx pnpm ...`.
- Baseline before Task 1: 74 tests (12 shared + 32 hub + 30 daemon), typecheck clean. Briefs' expected counts are per-task deltas — report REAL totals.

---

### Task 1: Shared schemas — TurnRequest, NewDebate, UsageReport

**Files:**
- Create: `packages/shared/src/orchestration.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/orchestration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact names later tasks import):
  - `TurnRequestSchema` / `TurnRequest { threadId: string; agentId: string; sinceMessageId: number (default 0); instruction?: string }`
  - `NewDebateSchema` / `NewDebate { topic: string; participants: string[] (min 2); workspace?: string; minRounds: number (default 2); maxRounds: number (default 4, must be ≥ minRounds); stances?: Record<string,string> }`
  - `UsageReportSchema` / `UsageReport { agent: string; threadId?: string; inputTokens: number (default 0); outputTokens: number (default 0); costUsd: number (default 0) }`

- [ ] **Step 1: Write the failing test**

`packages/shared/test/orchestration.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { NewDebateSchema, TurnRequestSchema, UsageReportSchema } from "../src/index.js";

describe("TurnRequestSchema", () => {
  it("parses with default sinceMessageId", () => {
    const turn = TurnRequestSchema.parse({ threadId: "t1", agentId: "codex" });
    expect(turn.sinceMessageId).toBe(0);
    expect(turn.instruction).toBeUndefined();
  });

  it("rejects negative sinceMessageId", () => {
    expect(
      TurnRequestSchema.safeParse({ threadId: "t", agentId: "a", sinceMessageId: -1 }).success,
    ).toBe(false);
  });
});

describe("NewDebateSchema", () => {
  it("applies round defaults", () => {
    const d = NewDebateSchema.parse({ topic: "tabs vs spaces", participants: ["a", "b"] });
    expect(d.minRounds).toBe(2);
    expect(d.maxRounds).toBe(4);
  });

  it("rejects fewer than 2 participants and max < min", () => {
    expect(NewDebateSchema.safeParse({ topic: "x", participants: ["a"] }).success).toBe(false);
    expect(
      NewDebateSchema.safeParse({
        topic: "x", participants: ["a", "b"], minRounds: 3, maxRounds: 2,
      }).success,
    ).toBe(false);
  });
});

describe("UsageReportSchema", () => {
  it("defaults counters to zero", () => {
    const u = UsageReportSchema.parse({ agent: "codex" });
    expect(u).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("rejects negative counters", () => {
    expect(UsageReportSchema.safeParse({ agent: "a", inputTokens: -1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/shared` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`packages/shared/src/orchestration.ts`:
```ts
import { z } from "zod";

export const TurnRequestSchema = z.object({
  threadId: z.string().min(1),
  agentId: z.string().min(1),
  sinceMessageId: z.number().int().nonnegative().default(0),
  instruction: z.string().optional(),
});

export const NewDebateSchema = z
  .object({
    topic: z.string().min(1),
    participants: z.array(z.string().min(1)).min(2),
    workspace: z.string().optional(),
    minRounds: z.number().int().positive().default(2),
    maxRounds: z.number().int().positive().default(4),
    stances: z.record(z.string(), z.string()).optional(),
  })
  .refine((d) => d.maxRounds >= d.minRounds, { message: "maxRounds must be >= minRounds" });

export const UsageReportSchema = z.object({
  agent: z.string().min(1),
  threadId: z.string().optional(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
});

export type TurnRequest = z.infer<typeof TurnRequestSchema>;
export type NewDebate = z.infer<typeof NewDebateSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
```

`packages/shared/src/index.ts` (append):
```ts
export * from "./orchestration.js";
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/shared` — Expected: PASS (+6 tests → 18 shared).

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): turn request, debate, and usage report schemas"
```

---

### Task 2: Hub — migrations, global message feed, usage endpoints

**Files:**
- Modify: `packages/hub/src/db.ts` (migrate), `packages/hub/src/mailbox.ts` (listAllMessages), `packages/hub/src/server.ts` (two routes), `packages/hub/src/index.ts` (export usage fns)
- Create: `packages/hub/src/usage.ts`
- Test: `packages/hub/test/feed-usage.test.ts`

**Interfaces:**
- Consumes: `UsageReportSchema` (Task 1).
- Produces:
  - `Mailbox.listAllMessages(afterId = 0, limit = 500): Message[]` — ascending id across ALL threads, `id > afterId`, at most `limit`.
  - `recordUsage(db: Database.Database, report: UsageReport): void`; `listUsage(db: Database.Database, limit = 100): UsageRow[]` where `UsageRow = UsageReport & { id: number; ts: string }` (threadId null → undefined).
  - Routes (authed): `GET /api/messages?after=N&limit=M` → Message[]; `POST /api/usage` (UsageReport body) → 201 `{ok:true}`; `GET /api/usage` → UsageRow[].
  - db gains `debates` and `usage` tables (debates consumed in Task 3).

- [ ] **Step 1: Write the failing test**

`packages/hub/test/feed-usage.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Message } from "@conclave/shared";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";
import { listUsage, recordUsage } from "../src/usage.js";

const TOKEN = "fu-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let db: Database.Database;
let mailbox: Mailbox;
let app: FastifyInstance;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-fu-"));
  db = openDb(join(dir, "t.db"));
  mailbox = new Mailbox(db);
  app = await buildServer({ mailbox, token: TOKEN, db });
});

describe("global message feed", () => {
  it("returns messages across threads ascending, honoring after and limit", async () => {
    const t1 = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const t2 = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(t1.id, { from: "you", to: [], type: "text", body: "a", artifacts: [] });
    mailbox.appendMessage(t2.id, { from: "you", to: [], type: "text", body: "b", artifacts: [] });
    mailbox.appendMessage(t1.id, { from: "you", to: [], type: "text", body: "c", artifacts: [] });

    expect(mailbox.listAllMessages().map((m) => m.body)).toEqual(["a", "b", "c"]);
    expect(mailbox.listAllMessages(m1.id).map((m) => m.body)).toEqual(["b", "c"]);
    expect(mailbox.listAllMessages(0, 2).map((m) => m.body)).toEqual(["a", "b"]);

    const res = await app.inject({
      method: "GET", url: `/api/messages?after=${m1.id}&limit=1`, headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Message[]>().map((m) => m.body)).toEqual(["b"]);
    expect((await app.inject({ method: "GET", url: "/api/messages" })).statusCode).toBe(401);
  });
});

describe("usage", () => {
  it("records and lists usage rows", () => {
    recordUsage(db, { agent: "codex", threadId: "t1", inputTokens: 10, outputTokens: 5, costUsd: 0 });
    recordUsage(db, { agent: "claude-code", inputTokens: 1, outputTokens: 2, costUsd: 0.03 });
    const rows = listUsage(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.agent).toBe("claude-code"); // newest first
    expect(rows[0]!.threadId).toBeUndefined();
    expect(rows[1]!.inputTokens).toBe(10);
  });

  it("accepts usage over http and lists it back", async () => {
    const posted = await app.inject({
      method: "POST", url: "/api/usage", headers: AUTH,
      payload: { agent: "codex", inputTokens: 7, outputTokens: 3 },
    });
    expect(posted.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/api/usage", headers: AUTH });
    expect(listed.json<Array<{ agent: string }>>()[0]!.agent).toBe("codex");
    const bad = await app.inject({
      method: "POST", url: "/api/usage", headers: AUTH, payload: { inputTokens: 7 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/hub/test/feed-usage.test.ts` — Expected: FAIL (usage.ts missing; buildServer rejects `db` opt).

- [ ] **Step 3: Implement**

`packages/hub/src/db.ts` — append inside the existing `migrate()` `db.exec` SQL string:
```sql
    CREATE TABLE IF NOT EXISTS debates (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL REFERENCES threads(id),
      participants TEXT NOT NULL,
      stances      TEXT NOT NULL DEFAULT '{}',
      min_rounds   INTEGER NOT NULL,
      max_rounds   INTEGER NOT NULL,
      round        INTEGER NOT NULL DEFAULT 0,
      state        TEXT NOT NULL DEFAULT 'running',
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent         TEXT NOT NULL,
      thread_id     TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      ts            TEXT NOT NULL
    );
```

`packages/hub/src/mailbox.ts` — add inside `class Mailbox`:
```ts
  listAllMessages(afterId = 0, limit = 500): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }
```

`packages/hub/src/usage.ts`:
```ts
import type Database from "better-sqlite3";
import type { UsageReport } from "@conclave/shared";

export interface UsageRow extends UsageReport {
  id: number;
  ts: string;
}

interface DbUsageRow {
  id: number;
  agent: string;
  thread_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ts: string;
}

export function recordUsage(db: Database.Database, report: UsageReport): void {
  db.prepare(
    `INSERT INTO usage (agent, thread_id, input_tokens, output_tokens, cost_usd, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    report.agent,
    report.threadId ?? null,
    report.inputTokens,
    report.outputTokens,
    report.costUsd,
    new Date().toISOString(),
  );
}

export function listUsage(db: Database.Database, limit = 100): UsageRow[] {
  const rows = db
    .prepare("SELECT * FROM usage ORDER BY id DESC LIMIT ?")
    .all(limit) as DbUsageRow[];
  return rows.map((r) => ({
    id: r.id,
    agent: r.agent,
    threadId: r.thread_id ?? undefined,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    ts: r.ts,
  }));
}
```

`packages/hub/src/server.ts` — extend options and add routes (after the registry route):
```ts
import type Database from "better-sqlite3";
import { UsageReportSchema } from "@conclave/shared";
import { listUsage, recordUsage } from "./usage.js";

export interface ServerOptions {
  mailbox: Mailbox;
  token: string;
  registry?: Registry;
  db?: Database.Database;
}
```
Routes inside `buildServer`:
```ts
  app.get("/api/messages", async (req) => {
    const query = req.query as { after?: string; limit?: string };
    const after = Number(query.after ?? 0);
    const limit = Number(query.limit ?? 500);
    return mailbox.listAllMessages(
      Number.isFinite(after) ? after : 0,
      Number.isFinite(limit) ? Math.min(limit, 500) : 500,
    );
  });

  app.post("/api/usage", async (req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    const body = parseOr400(UsageReportSchema, req.body, reply);
    if (!body) return;
    recordUsage(opts.db, body);
    return reply.code(201).send({ ok: true });
  });

  app.get("/api/usage", async (_req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    return listUsage(opts.db);
  });
```

`packages/hub/src/main.ts` — pass the db through: change `const mailbox = new Mailbox(openDb(...))` to
```ts
const db = openDb(join(dataDir, "conclave.db"));
const mailbox = new Mailbox(db);
```
and add `db` to the `buildServer({ ... })` call.

`packages/hub/src/index.ts` (append):
```ts
export { listUsage, recordUsage, type UsageRow } from "./usage.js";
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/hub` — Expected: PASS (+3 tests → 35 hub). `npx pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): global message feed, usage store, debates table"
```

---

### Task 3: Hub — DebateStore + turn-frame forwarding over /ws

**Files:**
- Create: `packages/hub/src/debates.ts`
- Modify: `packages/hub/src/server.ts` (/ws handler)
- Test: `packages/hub/test/debates-store.test.ts`, `packages/hub/test/ws.test.ts` (one appended test)

**Interfaces:**
- Consumes: `debates` table (Task 2), `TurnRequest` (Task 1).
- Produces:
  - `interface DebateRecord { id: string; threadId: string; participants: string[]; stances: Record<string,string>; minRounds: number; maxRounds: number; round: number; state: "running"|"settled"|"inconclusive"|"interrupted" }`
  - `class DebateStore { constructor(db) }` with `create(rec: DebateRecord): void`, `get(id: string): DebateRecord | undefined`, `update(id: string, patch: Partial<Pick<DebateRecord,"round"|"state">>): void`, `markRunningInterrupted(): number` (returns count).
  - `/ws` forwards `mailbox.events` `"turn"` events as `{type:"turn", turn: TurnRequest}` frames (listener removed on close, same as message/thread).

- [ ] **Step 1: Write the failing tests**

`packages/hub/test/debates-store.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { DebateStore, type DebateRecord } from "../src/debates.js";
import { Mailbox } from "../src/mailbox.js";

let db: Database.Database;
let store: DebateStore;
let mailbox: Mailbox;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-ds-"));
  db = openDb(join(dir, "t.db"));
  store = new DebateStore(db);
  mailbox = new Mailbox(db);
});

function rec(threadId: string, overrides: Partial<DebateRecord> = {}): DebateRecord {
  return {
    id: `deb-${Math.random().toString(36).slice(2)}`,
    threadId,
    participants: ["claude-code", "codex"],
    stances: { "claude-code": "advocate", codex: "skeptic" },
    minRounds: 2,
    maxRounds: 4,
    round: 0,
    state: "running",
    ...overrides,
  };
}

describe("DebateStore", () => {
  it("creates, gets, updates", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    const r = rec(t.id);
    store.create(r);
    expect(store.get(r.id)).toEqual(r);
    store.update(r.id, { round: 2, state: "settled" });
    expect(store.get(r.id)).toMatchObject({ round: 2, state: "settled" });
  });

  it("marks all running debates interrupted", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["a", "b"] });
    const r1 = rec(t.id);
    const r2 = rec(t.id, { state: "settled" });
    store.create(r1);
    store.create(r2);
    expect(store.markRunningInterrupted()).toBe(1);
    expect(store.get(r1.id)!.state).toBe("interrupted");
    expect(store.get(r2.id)!.state).toBe("settled");
  });
});
```

Append to the describe in `packages/hub/test/ws.test.ts`:
```ts
  it("forwards turn events as turn frames", async () => {
    const { mailbox, port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    const frames: unknown[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    mailbox.events.emit("turn", {
      threadId: "t1", agentId: "codex", sinceMessageId: 0, instruction: "go",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    ws.close();
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "turn",
        turn: expect.objectContaining({ agentId: "codex", instruction: "go" }),
      }),
    );
  });
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/hub` — Expected: FAIL (debates.ts missing; no turn frame).

- [ ] **Step 3: Implement**

`packages/hub/src/debates.ts`:
```ts
import type Database from "better-sqlite3";

export interface DebateRecord {
  id: string;
  threadId: string;
  participants: string[];
  stances: Record<string, string>;
  minRounds: number;
  maxRounds: number;
  round: number;
  state: "running" | "settled" | "inconclusive" | "interrupted";
}

interface DebateRow {
  id: string;
  thread_id: string;
  participants: string;
  stances: string;
  min_rounds: number;
  max_rounds: number;
  round: number;
  state: string;
  created_at: string;
}

export class DebateStore {
  constructor(private readonly db: Database.Database) {}

  create(rec: DebateRecord): void {
    this.db
      .prepare(
        `INSERT INTO debates (id, thread_id, participants, stances, min_rounds, max_rounds, round, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.threadId,
        JSON.stringify(rec.participants),
        JSON.stringify(rec.stances),
        rec.minRounds,
        rec.maxRounds,
        rec.round,
        rec.state,
        new Date().toISOString(),
      );
  }

  get(id: string): DebateRecord | undefined {
    const row = this.db.prepare("SELECT * FROM debates WHERE id = ?").get(id) as
      | DebateRow
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      threadId: row.thread_id,
      participants: JSON.parse(row.participants) as string[],
      stances: JSON.parse(row.stances) as Record<string, string>,
      minRounds: row.min_rounds,
      maxRounds: row.max_rounds,
      round: row.round,
      state: row.state as DebateRecord["state"],
    };
  }

  update(id: string, patch: Partial<Pick<DebateRecord, "round" | "state">>): void {
    if (patch.round !== undefined) {
      this.db.prepare("UPDATE debates SET round = ? WHERE id = ?").run(patch.round, id);
    }
    if (patch.state !== undefined) {
      this.db.prepare("UPDATE debates SET state = ? WHERE id = ?").run(patch.state, id);
    }
  }

  markRunningInterrupted(): number {
    const info = this.db
      .prepare("UPDATE debates SET state = 'interrupted' WHERE state = 'running'")
      .run();
    return info.changes;
  }
}
```

`packages/hub/src/server.ts` — in the `/ws` handler, alongside `onMessage`/`onThread`:
```ts
    const onTurn = (turn: TurnRequest): void => {
      socket.send(JSON.stringify({ type: "turn", turn }));
    };
    mailbox.events.on("turn", onTurn);
```
and in the close handler: `mailbox.events.off("turn", onTurn);`. Extend the shared type import with `TurnRequest`.

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/hub` — Expected: PASS (+3 tests → 38 hub). Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): debate store and turn-frame forwarding over websocket"
```

---

### Task 4: Hub — DebateOrchestrator engine + POST /api/debates

**Files:**
- Create: `packages/hub/src/orchestrator.ts`
- Modify: `packages/hub/src/server.ts` (route + opts), `packages/hub/src/main.ts` (wire + interrupted-on-boot), `packages/hub/src/index.ts` (exports)
- Test: `packages/hub/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Mailbox` (+events), `DebateStore`/`DebateRecord` (Task 3), `NewDebate`/`TurnRequest` (Task 1).
- Produces:
  - `class DebateOrchestrator { constructor(mailbox: Mailbox, store: DebateStore, opts?: { turnTimeoutMs?: number; finaleTimeoutMs?: number }) }` — defaults 600 000 / 120 000 ms.
  - `startDebate(input: NewDebate): DebateRecord` — creates the debate thread (kind `"debate"`, participants = input.participants, workspace), assigns stances (explicit `input.stances` entries win; missing ones cycle `["advocate","skeptic","risk-reviewer"]`), seeds `{from:"you", to:[], type:"proposal", body: topic}`, persists the record, launches the async round loop (fire-and-forget, tracked).
  - `idle(): Promise<void>` — resolves when all running debates finish (tests/shutdown).
  - Round loop: for round 1..maxRounds, for each participant without a verdict: emit `"turn"` on `mailbox.events` with `sinceMessageId` = id of that agent's own latest message in the thread (or 0) and `instruction = composeInstruction(stance, round, minRounds, maxRounds)`; await `waitForAgentActivity`; on `"timeout"` → `setVerdict(agent, "no-response (timeout)")` + status message. Stop when thread leaves `"open"`. Finale: each non-settled participant gets one turn with `FINAL_INSTRUCTION`, wait `finaleTimeoutMs`, then `setVerdict(agent, "no-response")`. Afterwards post `{from:"orchestrator", to:[], type:"status"}` summary listing verdicts, and `store.update(state: settled ? "settled" : "inconclusive")`.
  - `composeInstruction(stance: string, round: number, minRounds: number, maxRounds: number): string` (exported for tests): `round < minRounds` → contains "Do NOT call end_thread yet"; otherwise → contains "call end_thread with your verdict".
  - `waitForAgentActivity(mailbox, threadId, agentId, afterMessageId, timeoutMs): Promise<"replied"|"verdict"|"settled"|"timeout">` (exported): resolves `"replied"` on a message in the thread from that agent with id > afterMessageId; `"verdict"` when a thread event shows `verdicts[agentId]` set; `"settled"` when thread state leaves open; `"timeout"` otherwise. All listeners removed on every path.
  - Route: `POST /api/debates` (NewDebate body) → 201 DebateRecord; 503 when no orchestrator configured. `buildServer` opts gain `orchestrator?: DebateOrchestrator`.

- [ ] **Step 1: Write the failing tests**

`packages/hub/test/orchestrator.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { TurnRequest } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { DebateStore } from "../src/debates.js";
import {
  DebateOrchestrator, composeInstruction, waitForAgentActivity,
} from "../src/orchestrator.js";

let db: Database.Database;
let mailbox: Mailbox;
let store: DebateStore;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-orch-"));
  db = openDb(join(dir, "t.db"));
  mailbox = new Mailbox(db);
  store = new DebateStore(db);
});

describe("composeInstruction", () => {
  it("forbids early verdicts before minRounds and invites them after", () => {
    expect(composeInstruction("skeptic", 1, 2, 4)).toContain("Do NOT call end_thread yet");
    expect(composeInstruction("skeptic", 1, 2, 4)).toContain("skeptic");
    expect(composeInstruction("advocate", 2, 2, 4)).toContain("end_thread");
    expect(composeInstruction("advocate", 2, 2, 4)).not.toContain("Do NOT");
  });
});

describe("waitForAgentActivity", () => {
  it("resolves replied / verdict / timeout", async () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["a", "b"] });
    const p1 = waitForAgentActivity(mailbox, t.id, "a", 0, 2000);
    mailbox.appendMessage(t.id, { from: "a", to: [], type: "text", body: "hi", artifacts: [] });
    expect(await p1).toBe("replied");

    const p2 = waitForAgentActivity(mailbox, t.id, "b", 99, 2000);
    mailbox.setVerdict(t.id, "b", "approve");
    expect(await p2).toBe("verdict");

    const t2 = mailbox.createThread({ kind: "debate", participants: ["a"] });
    expect(await waitForAgentActivity(mailbox, t2.id, "a", 0, 100)).toBe("timeout");
  });
});

describe("DebateOrchestrator", () => {
  function fakeDaemon(behavior: (turn: TurnRequest, count: number) => void): void {
    const counts = new Map<string, number>();
    mailbox.events.on("turn", (turn: TurnRequest) => {
      const key = `${turn.threadId}:${turn.agentId}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      setTimeout(() => behavior(turn, count), 10);
    });
  }

  it("runs rounds, collects verdicts, settles, posts summary", async () => {
    const orch = new DebateOrchestrator(mailbox, store, {
      turnTimeoutMs: 2000, finaleTimeoutMs: 500,
    });
    fakeDaemon((turn, count) => {
      if (count < 2) {
        mailbox.appendMessage(turn.threadId, {
          from: turn.agentId, to: [], type: "text",
          body: `${turn.agentId} argues (${count})`, artifacts: [],
        });
      } else {
        mailbox.setVerdict(turn.threadId, turn.agentId, "approve");
      }
    });

    const rec = orch.startDebate({
      topic: "Should we use tabs?", participants: ["claude-code", "codex"],
      minRounds: 1, maxRounds: 3,
    });
    expect(rec.stances["claude-code"]).toBe("advocate");
    expect(rec.stances["codex"]).toBe("skeptic");
    await orch.idle();

    const thread = mailbox.getThread(rec.threadId)!;
    expect(thread.state).toBe("settled");
    expect(thread.verdicts).toEqual({ "claude-code": "approve", codex: "approve" });
    const bodies = mailbox.listMessages(rec.threadId).map((m) => m.body);
    expect(bodies[0]).toBe("Should we use tabs?");
    expect(bodies.some((b) => b.includes("claude-code argues"))).toBe(true);
    const summary = mailbox.listMessages(rec.threadId).find(
      (m) => m.from === "orchestrator" && m.type === "status",
    );
    expect(summary!.body).toContain("codex: approve");
    expect(store.get(rec.id)!.state).toBe("settled");
  });

  it("times out silent agents with a no-response verdict", async () => {
    const orch = new DebateOrchestrator(mailbox, store, {
      turnTimeoutMs: 150, finaleTimeoutMs: 100,
    });
    fakeDaemon((turn) => {
      if (turn.agentId === "codex") {
        mailbox.setVerdict(turn.threadId, "codex", "reject");
      } // claude-code stays silent
    });
    const rec = orch.startDebate({
      topic: "silence test", participants: ["claude-code", "codex"],
      minRounds: 1, maxRounds: 2,
    });
    await orch.idle();
    const thread = mailbox.getThread(rec.threadId)!;
    expect(thread.verdicts["codex"]).toBe("reject");
    expect(thread.verdicts["claude-code"]).toContain("no-response");
    expect(thread.state).toBe("settled");
    expect(store.get(rec.id)!.state).toBe("settled");
  }, 15_000);

  it("respects explicit stance overrides", () => {
    const orch = new DebateOrchestrator(mailbox, store, { turnTimeoutMs: 100, finaleTimeoutMs: 50 });
    const rec = orch.startDebate({
      topic: "x", participants: ["a", "b"], minRounds: 1, maxRounds: 1,
      stances: { a: "contrarian" },
    });
    expect(rec.stances["a"]).toBe("contrarian");
    expect(rec.stances["b"]).toBe("skeptic");
    return orch.idle();
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/hub/test/orchestrator.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`packages/hub/src/orchestrator.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { Message, NewDebate, Thread, TurnRequest } from "@conclave/shared";
import type { Mailbox } from "./mailbox.js";
import type { DebateRecord, DebateStore } from "./debates.js";

const STANCE_PRESETS = ["advocate", "skeptic", "risk-reviewer"];
const FINAL_INSTRUCTION =
  "Final call: you MUST call end_thread now with your verdict (approve / reject / short position summary).";

export function composeInstruction(
  stance: string,
  round: number,
  minRounds: number,
  maxRounds: number,
): string {
  const base = `Round ${round}/${maxRounds}. Your stance: ${stance}.`;
  if (round < minRounds) {
    return `${base} Engage directly with the other participants' arguments. Do NOT call end_thread yet — minimum ${minRounds} rounds.`;
  }
  return `${base} If your position is final, call end_thread with your verdict; otherwise rebut the strongest counterargument.`;
}

export function waitForAgentActivity(
  mailbox: Mailbox,
  threadId: string,
  agentId: string,
  afterMessageId: number,
  timeoutMs: number,
): Promise<"replied" | "verdict" | "settled" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    function onMessage(m: Message): void {
      if (m.threadId === threadId && m.from === agentId && m.id > afterMessageId) done("replied");
    }
    function onThread(t: Thread): void {
      if (t.id !== threadId) return;
      if (t.verdicts[agentId] !== undefined) return done("verdict");
      if (t.state !== "open") done("settled");
    }
    function done(result: "replied" | "verdict" | "settled" | "timeout"): void {
      clearTimeout(timer);
      mailbox.events.off("message", onMessage);
      mailbox.events.off("thread", onThread);
      resolve(result);
    }
    mailbox.events.on("message", onMessage);
    mailbox.events.on("thread", onThread);
  });
}

function assignStances(
  participants: string[],
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const stances: Record<string, string> = {};
  participants.forEach((p, i) => {
    stances[p] = overrides?.[p] ?? STANCE_PRESETS[i % STANCE_PRESETS.length]!;
  });
  return stances;
}

export interface OrchestratorOptions {
  turnTimeoutMs?: number;
  finaleTimeoutMs?: number;
}

export class DebateOrchestrator {
  private readonly running = new Set<Promise<void>>();
  private readonly turnTimeoutMs: number;
  private readonly finaleTimeoutMs: number;

  constructor(
    private readonly mailbox: Mailbox,
    private readonly store: DebateStore,
    opts: OrchestratorOptions = {},
  ) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 600_000;
    this.finaleTimeoutMs = opts.finaleTimeoutMs ?? 120_000;
  }

  startDebate(input: NewDebate): DebateRecord {
    const thread = this.mailbox.createThread({
      kind: "debate",
      participants: input.participants,
      workspace: input.workspace,
    });
    const rec: DebateRecord = {
      id: randomUUID(),
      threadId: thread.id,
      participants: input.participants,
      stances: assignStances(input.participants, input.stances),
      minRounds: input.minRounds,
      maxRounds: input.maxRounds,
      round: 0,
      state: "running",
    };
    this.store.create(rec);
    this.mailbox.appendMessage(thread.id, {
      from: "you", to: [], type: "proposal", body: input.topic, artifacts: [],
    });
    const run = this.run(rec).catch((err: unknown) => {
      this.store.update(rec.id, { state: "interrupted" });
      console.error(`debate ${rec.id} crashed:`, err instanceof Error ? err.message : err);
    });
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
    return rec;
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  private emitTurn(turn: TurnRequest): void {
    this.mailbox.events.emit("turn", turn);
  }

  private latestMessageIdFrom(threadId: string, agentId: string): number {
    const own = this.mailbox.listMessages(threadId).filter((m) => m.from === agentId);
    return own.at(-1)?.id ?? 0;
  }

  private async run(rec: DebateRecord): Promise<void> {
    for (let round = 1; round <= rec.maxRounds; round++) {
      this.store.update(rec.id, { round });
      for (const agent of rec.participants) {
        const thread = this.mailbox.getThread(rec.threadId);
        if (!thread || thread.state !== "open") break;
        if (thread.verdicts[agent] !== undefined) continue;
        const lastSeen = this.mailbox.listMessages(rec.threadId).at(-1)?.id ?? 0;
        this.emitTurn({
          threadId: rec.threadId,
          agentId: agent,
          sinceMessageId: this.latestMessageIdFrom(rec.threadId, agent),
          instruction: composeInstruction(rec.stances[agent]!, round, rec.minRounds, rec.maxRounds),
        });
        const outcome = await waitForAgentActivity(
          this.mailbox, rec.threadId, agent, lastSeen, this.turnTimeoutMs,
        );
        if (outcome === "timeout") {
          this.mailbox.setVerdict(rec.threadId, agent, "no-response (timeout)");
          this.mailbox.appendMessage(rec.threadId, {
            from: "orchestrator", to: [], type: "status",
            body: `${agent} did not respond within the turn timeout`, artifacts: [],
          });
        }
        if (outcome === "settled") break;
      }
      const t = this.mailbox.getThread(rec.threadId);
      if (!t || t.state !== "open") break;
    }

    let thread = this.mailbox.getThread(rec.threadId);
    if (thread && thread.state === "open") {
      for (const agent of rec.participants) {
        thread = this.mailbox.getThread(rec.threadId);
        if (!thread || thread.state !== "open") break;
        if (thread.verdicts[agent] !== undefined) continue;
        const lastSeen = this.mailbox.listMessages(rec.threadId).at(-1)?.id ?? 0;
        this.emitTurn({
          threadId: rec.threadId,
          agentId: agent,
          sinceMessageId: this.latestMessageIdFrom(rec.threadId, agent),
          instruction: FINAL_INSTRUCTION,
        });
        const outcome = await waitForAgentActivity(
          this.mailbox, rec.threadId, agent, lastSeen, this.finaleTimeoutMs,
        );
        const after = this.mailbox.getThread(rec.threadId);
        if (outcome !== "settled" && after && after.verdicts[agent] === undefined) {
          this.mailbox.setVerdict(rec.threadId, agent, "no-response");
        }
      }
    }

    const final = this.mailbox.getThread(rec.threadId);
    if (!final) return;
    const summary = Object.entries(final.verdicts)
      .map(([a, v]) => `${a}: ${v}`)
      .join("\n");
    this.mailbox.appendMessage(rec.threadId, {
      from: "orchestrator", to: [], type: "status",
      body: `debate finished (${final.state}). verdicts:\n${summary}`, artifacts: [],
    });
    this.store.update(rec.id, {
      state: final.state === "settled" ? "settled" : "inconclusive",
    });
  }
}
```

`packages/hub/src/server.ts` — opts gain `orchestrator?: DebateOrchestrator` (type import from `./orchestrator.js`); route after `/api/usage`:
```ts
  app.post("/api/debates", async (req, reply) => {
    if (!opts.orchestrator) return reply.code(503).send({ error: "orchestrator not configured" });
    const body = parseOr400(NewDebateSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(opts.orchestrator.startDebate(body));
  });
```
(`NewDebateSchema` joins the shared value imports.)

`packages/hub/src/main.ts` — wire it:
```ts
import { DebateStore } from "./debates.js";
import { DebateOrchestrator } from "./orchestrator.js";
// after mailbox creation:
const debateStore = new DebateStore(db);
const interrupted = debateStore.markRunningInterrupted();
if (interrupted > 0) console.warn(`${interrupted} debate(s) marked interrupted from previous run`);
const orchestrator = new DebateOrchestrator(mailbox, debateStore);
// add `orchestrator` to buildServer opts
```

`packages/hub/src/index.ts` (append):
```ts
export { DebateStore, type DebateRecord } from "./debates.js";
export { DebateOrchestrator, composeInstruction, waitForAgentActivity } from "./orchestrator.js";
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/hub` — Expected: PASS (+5 tests → 43 hub). Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): debate orchestrator with rounds, stances, timeouts, summary"
```

---

### Task 5: Daemon — DaemonState (cursor + watermarks + sessions)

**Files:**
- Create: `packages/daemon/src/daemon-state.ts`
- Test: `packages/daemon/test/daemon-state.test.ts`
- (Do NOT delete `session-store.ts` yet — Task 6 swaps consumers, then deletes it.)

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 6–8 use these exact names):
  - `class DaemonState { constructor(filePath: string) }` with:
    - `getSession(threadId, agentId): string | undefined` / `setSession(threadId, agentId, sessionId): void`
    - `getCursor(): number` / `setCursor(id: number): void` — monotonic (setting a lower value is a no-op)
    - `getWatermark(threadId, agentId): number` (default 0) / `setWatermark(threadId, agentId, id): void` — monotonic per key
    - Persists synchronously on every mutation. File shape `{ sessions: Record<string,string>; cursor: number; watermarks: Record<string,number> }`; keys are `JSON.stringify([threadId, agentId])`.
    - **Legacy migration:** a file whose values are all strings (step-2 `SessionStore` flat shape) loads as `{ sessions: <that object>, cursor: 0, watermarks: {} }`. Missing/corrupt file → empty state; never throws on load.

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/daemon-state.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonState } from "../src/daemon-state.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-dst-")), "state.json");
}

describe("DaemonState", () => {
  it("persists sessions, cursor, and watermarks across instances", () => {
    const path = tmpPath();
    const s = new DaemonState(path);
    expect(s.getCursor()).toBe(0);
    expect(s.getWatermark("t", "a")).toBe(0);
    s.setSession("t", "a", "sess-1");
    s.setCursor(42);
    s.setWatermark("t", "a", 40);
    const reloaded = new DaemonState(path);
    expect(reloaded.getSession("t", "a")).toBe("sess-1");
    expect(reloaded.getCursor()).toBe(42);
    expect(reloaded.getWatermark("t", "a")).toBe(40);
  });

  it("cursor and watermarks are monotonic", () => {
    const s = new DaemonState(tmpPath());
    s.setCursor(10);
    s.setCursor(5);
    expect(s.getCursor()).toBe(10);
    s.setWatermark("t", "a", 7);
    s.setWatermark("t", "a", 3);
    expect(s.getWatermark("t", "a")).toBe(7);
  });

  it("migrates a legacy flat SessionStore file", () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ '["t1","a1"]': "sess-legacy" }));
    const s = new DaemonState(path);
    expect(s.getSession("t1", "a1")).toBe("sess-legacy");
    expect(s.getCursor()).toBe(0);
  });

  it("survives corrupt files", () => {
    const path = tmpPath();
    writeFileSync(path, "{nope");
    const s = new DaemonState(path);
    expect(s.getCursor()).toBe(0);
    s.setCursor(1);
    expect(new DaemonState(path).getCursor()).toBe(1);
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/daemon-state.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/daemon/src/daemon-state.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface StateShape {
  sessions: Record<string, string>;
  cursor: number;
  watermarks: Record<string, number>;
}

const EMPTY: StateShape = { sessions: {}, cursor: 0, watermarks: {} };

export class DaemonState {
  private state: StateShape;

  constructor(private readonly filePath: string) {
    this.state = { ...EMPTY, sessions: {}, watermarks: {} };
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj["cursor"] === "number" &&
        typeof obj["sessions"] === "object" &&
        obj["sessions"] !== null
      ) {
        this.state = {
          sessions: obj["sessions"] as Record<string, string>,
          cursor: obj["cursor"],
          watermarks: (obj["watermarks"] ?? {}) as Record<string, number>,
        };
      } else if (Object.values(obj).every((v) => typeof v === "string")) {
        // legacy step-2 SessionStore flat file
        this.state = { sessions: obj as Record<string, string>, cursor: 0, watermarks: {} };
      }
    } catch {
      // corrupt file — start empty
    }
  }

  private key(threadId: string, agentId: string): string {
    return JSON.stringify([threadId, agentId]);
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getSession(threadId: string, agentId: string): string | undefined {
    return this.state.sessions[this.key(threadId, agentId)];
  }

  setSession(threadId: string, agentId: string, sessionId: string): void {
    this.state.sessions[this.key(threadId, agentId)] = sessionId;
    this.persist();
  }

  getCursor(): number {
    return this.state.cursor;
  }

  setCursor(id: number): void {
    if (id <= this.state.cursor) return;
    this.state.cursor = id;
    this.persist();
  }

  getWatermark(threadId: string, agentId: string): number {
    return this.state.watermarks[this.key(threadId, agentId)] ?? 0;
  }

  setWatermark(threadId: string, agentId: string, id: number): void {
    if (id <= this.getWatermark(threadId, agentId)) return;
    this.state.watermarks[this.key(threadId, agentId)] = id;
    this.persist();
  }
}
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (+4 → 34 daemon).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): unified persistent state with cursor and watermarks"
```

---

### Task 6: Daemon — cursor dedup + catch-up on connect

**Files:**
- Modify: `packages/daemon/src/agent-loop.ts` (DaemonState swap, cursor dedup, drop dispatched Set), `packages/daemon/src/hub-client.ts` (listAllMessages), `packages/daemon/src/hub-socket.ts` (async onOpen with frame buffering), `packages/daemon/src/main.ts` (wire catch-up), `packages/daemon/test/agent-loop.test.ts` (state swap in setup)
- Delete: `packages/daemon/src/session-store.ts`, `packages/daemon/test/session-store.test.ts` (superseded — DaemonState carries the same tested behaviors)
- Test: `packages/daemon/test/catch-up.test.ts`

**Interfaces:**
- Consumes: `DaemonState` (Task 5), `Mailbox.listAllMessages` via hub route (Task 2).
- Produces:
  - `HubClient.listAllMessages(after = 0, limit = 500): Promise<Message[]>` → `GET /api/messages?after&limit`.
  - `AgentLoopOptions.store: SessionStore` becomes `state: DaemonState` (all `store.get/set` call sites become `state.getSession/setSession`).
  - `AgentLoop.handleMessage(m)`: FIRST checks `if (m.id <= state.getCursor()) return;` then `state.setCursor(m.id);` then the existing per-agent trigger logic. The `dispatched` Set and its key logic are DELETED (cursor supersedes them).
  - `HubSocketOptions.onOpen?: () => void | Promise<void>` — invoked on every successful connect (initial + reconnect). While `onOpen` runs, incoming `message`/`turn` frames are buffered and flushed in arrival order after it resolves (errors in onOpen: log via console.error, still flush).
  - `runCatchUp(hub: HubClient, state: DaemonState, handle: (m: Message) => void): Promise<number>` (exported from `agent-loop.ts`): pages `listAllMessages(state.getCursor(), 500)` until a page is shorter than 500, feeding each message to `handle`, returns count fetched.
- Note: `AgentLoop`'s constructor still takes the same other options; tests updated mechanically from `store: new SessionStore(...)` to `state: new DaemonState(...)`.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/catch-up.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Message } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { runCatchUp } from "../src/agent-loop.js";
import { HubSocket } from "../src/hub-socket.js";

const TOKEN = "cu-token";

describe("catch-up", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function liveHub() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-cu-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return {
      mailbox,
      dir,
      url: `http://127.0.0.1:${port}`,
      client: new HubClient(`http://127.0.0.1:${port}`, TOKEN),
    };
  }

  it("replays only messages after the cursor", async () => {
    const { mailbox, dir, client } = await liveHub();
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "old", artifacts: [] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "new1", artifacts: [] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "new2", artifacts: [] });

    const state = new DaemonState(join(dir, "state.json"));
    state.setCursor(m1.id);
    const seen: string[] = [];
    const count = await runCatchUp(client, state, (m) => seen.push(m.body));
    expect(count).toBe(2);
    expect(seen).toEqual(["new1", "new2"]);
  });

  it("buffers live frames until onOpen completes", async () => {
    const { mailbox, url } = await liveHub();
    const order: string[] = [];
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((r) => (releaseOpen = r));

    const socket = new HubSocket({
      hubUrl: url,
      token: TOKEN,
      onOpen: async () => {
        order.push("open-start");
        await openGate;
        order.push("open-done");
      },
      onMessage: (m: Message) => order.push(`msg:${m.body}`),
    });
    socket.start();
    // wait for onOpen to begin
    await new Promise((r) => setTimeout(r, 400));
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "during", artifacts: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(["open-start"]); // buffered, not delivered
    releaseOpen();
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(["open-start", "open-done", "msg:during"]);
    socket.stop();
  }, 15_000);
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/catch-up.test.ts` — Expected: FAIL (no runCatchUp/DaemonState wiring/onOpen).

- [ ] **Step 3: Implement**

`packages/daemon/src/hub-client.ts` — add:
```ts
  listAllMessages(after = 0, limit = 500): Promise<Message[]> {
    return this.request("GET", `/api/messages?after=${after}&limit=${limit}`);
  }
```

`packages/daemon/src/agent-loop.ts`:
- Replace `import type { SessionStore } ...` with `import type { DaemonState } from "./daemon-state.js";`; `AgentLoopOptions.store: SessionStore` → `state: DaemonState`; every `this.opts.store.get(...)` → `this.opts.state.getSession(...)`, `.set(...)` → `.setSession(...)`.
- Delete the `dispatched` Set field and its check/insert lines in `handleMessage`; replace with cursor logic at the top:
```ts
  handleMessage(m: Message): void {
    if (m.id <= this.opts.state.getCursor()) return;
    this.opts.state.setCursor(m.id);
    for (const agent of this.opts.agents) {
      if (!shouldTrigger(agent, m, this.opts.allowAgentTriggers)) continue;
      const turn = this.opts.queue
        .run(agent.id, () => this.runTurn(agent, m))
        .catch(() => undefined);
      this.inFlight.add(turn);
      void turn.finally(() => this.inFlight.delete(turn));
    }
  }
```
- Add at module level:
```ts
import type { HubClient } from "./hub-client.js";

export async function runCatchUp(
  hub: HubClient,
  state: DaemonState,
  handle: (m: Message) => void,
): Promise<number> {
  let total = 0;
  for (;;) {
    const page = await hub.listAllMessages(state.getCursor(), 500);
    for (const m of page) handle(m);
    total += page.length;
    if (page.length < 500) return total;
  }
}
```
(Note: `handle` is `loop.handleMessage`, which advances the cursor itself — paging terminates.)

`packages/daemon/src/hub-socket.ts` — add `onOpen?: () => void | Promise<void>` to `HubSocketOptions`. In `connect()`, buffer frames while onOpen runs:
```ts
    let buffering = this.opts.onOpen !== undefined;
    const buffer: Array<Buffer | string> = [];

    const handleData = (data: Buffer | string): void => {
      try {
        const frame: unknown = JSON.parse(String(data));
        const candidate = frame as { type?: unknown; message?: unknown };
        if (candidate.type !== "message") return;
        const parsed = MessageSchema.safeParse(candidate.message);
        if (parsed.success) this.opts.onMessage(parsed.data);
      } catch {
        // ignore unparseable frames
      }
    };

    ws.on("message", (data: Buffer) => {
      if (buffering) buffer.push(data);
      else handleData(data);
    });

    ws.on("open", () => {
      if (!this.opts.onOpen) return;
      void Promise.resolve()
        .then(() => this.opts.onOpen!())
        .catch((err: unknown) => {
          console.error("onOpen failed:", err instanceof Error ? err.message : err);
        })
        .finally(() => {
          buffering = false;
          for (const data of buffer.splice(0)) handleData(data);
        });
    });
```
(Refactor the existing inline message handler into `handleData`; keep the identity-guarded reconnect logic untouched. Task 7 extends `handleData` for turn frames.)

`packages/daemon/src/main.ts` — swap `SessionStore` for `DaemonState`, and wire catch-up:
```ts
import { DaemonState } from "./daemon-state.js";
import { AgentLoop, runCatchUp } from "./agent-loop.js";
// state:
const state = new DaemonState(cfg.stateFile);
// loop opts: state instead of store
// socket:
const socket = new HubSocket({
  hubUrl: cfg.hubUrl,
  token: cfg.token,
  onOpen: async () => {
    const caught = await runCatchUp(hub, state, (m) => loop.handleMessage(m));
    if (caught > 0) console.log(`catch-up: processed ${caught} message(s)`);
  },
  onMessage: (m) => {
    loop.handleMessage(m);
  },
});
```

`packages/daemon/test/agent-loop.test.ts` — mechanical setup swap: `new SessionStore(join(dir, "state.json"))` → `new DaemonState(join(dir, "state.json"))` (and the import). The "does not trigger on its own replies" test still passes — the cursor now provides the dedup the Set used to.

Delete `packages/daemon/src/session-store.ts` and `packages/daemon/test/session-store.test.ts`.

- [ ] **Step 4: GREEN + full suite**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (2 new, 3 session-store tests removed → 33 daemon). `npx pnpm test` + `npx pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A packages/daemon
git commit -m "feat(daemon): persisted cursor dedup and catch-up scan on connect"
```

---

### Task 7: Daemon — turn frames end to end

**Files:**
- Modify: `packages/daemon/src/hub-socket.ts` (turn frames), `packages/daemon/src/agent-loop.ts` (handleTurnRequest + buildDebatePrompt), `packages/daemon/src/main.ts` (onTurn wiring)
- Test: `packages/daemon/test/turn-request.test.ts`

**Interfaces:**
- Consumes: `TurnRequestSchema` (Task 1), hub turn-frame forwarding (Task 3), `DaemonState` watermarks (Task 5).
- Produces:
  - `HubSocketOptions.onTurn?: (turn: TurnRequest) => void` — fired for `{type:"turn"}` frames validated by `TurnRequestSchema`; buffered during onOpen like messages.
  - `buildDebatePrompt(agent: AgentConfig, turn: TurnRequest, messages: Message[], isFirstTurn: boolean): string` (exported) — first turn: role + debate intro naming end_thread + rendered `[from]: body` transcript + `Instruction from orchestrator: ...` when present; later turns: `New messages:` + transcript + instruction.
  - `AgentLoop.handleTurnRequest(turn: TurnRequest): void` — ignores unknown agentIds; enqueues on the agent's queue; inside: `since = max(state.getWatermark(threadId, agentId), turn.sinceMessageId)`; fetch `hub.listMessages(threadId, since)`, filter out the agent's own; run the adapter turn (cwd/allowedTools/mcpServers/bridge env exactly like the mention path); update watermark to the max fetched message id; store session; post non-empty result text as `{from: agent.id, to: [], type: "text"}`; error path identical to the mention path (status message, never throws). Counted by `idle()`.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/turn-request.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentConfig, Message, TurnRequest } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import { HubSocket } from "../src/hub-socket.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import { AgentLoop, buildDebatePrompt } from "../src/agent-loop.js";

const TOKEN = "tr-token";

const AGENT: AgentConfig = {
  id: "codex", name: "Codex", runtime: "codex", machine: "dev-box",
  workspace: "/tmp/codex-ws", role: "You are the skeptic.", allowedTools: [],
};

class FakeAdapter implements RuntimeAdapter {
  calls: TurnOptions[] = [];
  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    this.calls.push(opts);
    return { sessionId: "codex-sess", text: "my rebuttal", isError: false, costUsd: 0 };
  }
}

function turnOf(threadId: string, over: Partial<TurnRequest> = {}): TurnRequest {
  return { threadId, agentId: "codex", sinceMessageId: 0, ...over };
}

describe("buildDebatePrompt", () => {
  const msg = (id: number, from: string, body: string): Message => ({
    id, threadId: "t", from, to: [], type: "text", body, artifacts: [],
    ts: new Date().toISOString(),
  });

  it("first turn carries role, intro, transcript, instruction", () => {
    const p = buildDebatePrompt(
      AGENT, turnOf("t", { instruction: "Round 1/4. Do NOT call end_thread yet" }),
      [msg(1, "you", "topic"), msg(2, "claude-code", "opening")], true,
    );
    expect(p).toContain("You are the skeptic.");
    expect(p).toContain("end_thread");
    expect(p).toContain("[you]: topic");
    expect(p).toContain("[claude-code]: opening");
    expect(p).toContain("Instruction from orchestrator: Round 1/4");
  });

  it("later turns carry only new messages and instruction", () => {
    const p = buildDebatePrompt(AGENT, turnOf("t"), [msg(3, "claude-code", "rebuttal")], false);
    expect(p).not.toContain("You are the skeptic.");
    expect(p).toContain("New messages:");
    expect(p).toContain("[claude-code]: rebuttal");
  });
});

describe("turn requests end to end", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-tr-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const adapter = new FakeAdapter();
    const state = new DaemonState(join(dir, "state.json"));
    const loop = new AgentLoop({
      agents: [AGENT], hub: new HubClient(hubUrl, TOKEN), adapter, state,
      queue: new TurnQueue(), hubUrl, token: TOKEN, allowAgentTriggers: false,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    return { mailbox, adapter, loop, state, hubUrl };
  }

  it("runs a debate turn from a turn frame delivered over the socket", async () => {
    const { mailbox, adapter, loop, hubUrl } = await setup();
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "proposal", body: "topic", artifacts: [] });

    const socket = new HubSocket({
      hubUrl, token: TOKEN,
      onMessage: () => undefined,
      onTurn: (turn) => loop.handleTurnRequest(turn),
    });
    socket.start();
    await new Promise((r) => setTimeout(r, 400));
    mailbox.events.emit("turn", turnOf(t.id, { instruction: "argue" }));
    await new Promise((r) => setTimeout(r, 400));
    await loop.idle();
    socket.stop();

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.prompt).toContain("[you]: topic");
    expect(adapter.calls[0]!.prompt).toContain("Instruction from orchestrator: argue");
    const bodies = mailbox.listMessages(t.id).map((m) => m.body);
    expect(bodies).toContain("my rebuttal");
    const reply = mailbox.listMessages(t.id).find((m) => m.body === "my rebuttal")!;
    expect(reply.to).toEqual([]);
  }, 15_000);

  it("uses watermarks so consecutive turns only see new messages", async () => {
    const { mailbox, adapter, loop } = await setup();
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "proposal", body: "first", artifacts: [] });
    loop.handleTurnRequest(turnOf(t.id));
    await loop.idle();
    mailbox.appendMessage(t.id, { from: "claude-code", to: [], type: "text", body: "second", artifacts: [] });
    loop.handleTurnRequest(turnOf(t.id));
    await loop.idle();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.prompt).toContain("second");
    expect(adapter.calls[1]!.prompt).not.toContain("first");
    expect(adapter.calls[1]!.sessionId).toBe("codex-sess");
  });

  it("ignores turn frames for agents it does not own", async () => {
    const { adapter, loop, mailbox } = await setup();
    const t = mailbox.createThread({ kind: "debate", participants: ["other"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "other", sinceMessageId: 0 });
    await loop.idle();
    expect(adapter.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/turn-request.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/daemon/src/hub-socket.ts` — extend options and `handleData`:
```ts
import { MessageSchema, TurnRequestSchema, type Message, type TurnRequest } from "@conclave/shared";
// options:
  onTurn?: (turn: TurnRequest) => void;
// in handleData, after the message branch:
      if (candidate.type === "turn" && this.opts.onTurn) {
        const parsedTurn = TurnRequestSchema.safeParse((frame as { turn?: unknown }).turn);
        if (parsedTurn.success) this.opts.onTurn(parsedTurn.data);
        return;
      }
```
(Restructure `handleData` so it checks `candidate.type` once: `"message"` → existing path, `"turn"` → above, else ignore.)

`packages/daemon/src/agent-loop.ts` — add:
```ts
import type { TurnRequest } from "@conclave/shared";

export function buildDebatePrompt(
  agent: AgentConfig,
  turn: TurnRequest,
  messages: Message[],
  isFirstTurn: boolean,
): string {
  const rendered = messages.map((m) => `[${m.from}]: ${m.body}`).join("\n\n");
  const instruction = turn.instruction
    ? `\n\nInstruction from orchestrator: ${turn.instruction}`
    : "";
  if (!isFirstTurn) return `New messages:\n\n${rendered}${instruction}`;
  const role = agent.role ? `${agent.role}\n\n` : "";
  return (
    `${role}You are agent "${agent.id}" in Conclave debate thread ${turn.threadId}. ` +
    `Hub MCP tools are available: send_message, check_inbox, wait_for_reply, end_thread. ` +
    `When your position is final, call end_thread with a verdict (approve / reject / short ` +
    `position summary). Your final response text is posted to the thread automatically.` +
    `\n\nThread so far:\n\n${rendered}${instruction}`
  );
}
```
and inside `class AgentLoop`:
```ts
  handleTurnRequest(turn: TurnRequest): void {
    const agent = this.opts.agents.find((a) => a.id === turn.agentId);
    if (!agent) return;
    const work = this.opts.queue
      .run(agent.id, () => this.runDebateTurn(agent, turn))
      .catch(() => undefined);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async runDebateTurn(agent: AgentConfig, turn: TurnRequest): Promise<void> {
    const { hub, state } = this.opts;
    try {
      const since = Math.max(state.getWatermark(turn.threadId, agent.id), turn.sinceMessageId);
      const messages = (await hub.listMessages(turn.threadId, since)).filter(
        (m) => m.from !== agent.id,
      );
      const sessionId = state.getSession(turn.threadId, agent.id);
      const result = await this.opts.adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildDebatePrompt(agent, turn, messages, sessionId === undefined),
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(turn.threadId, agent.id),
      });
      const maxSeen = messages.at(-1)?.id;
      if (maxSeen !== undefined) state.setWatermark(turn.threadId, agent.id, maxSeen);
      if (result.sessionId) state.setSession(turn.threadId, agent.id, result.sessionId);
      if (result.text.trim()) {
        await hub.postMessage(turn.threadId, {
          from: agent.id, to: [], type: "text", body: result.text, artifacts: [],
        });
      }
    } catch (e) {
      await this.postFailure(agent, turn.threadId, e);
    }
  }
```
Refactor the shared pieces out of the existing `runTurn`: extract `bridgeConfig(threadId: string, agentId: string)` (returns the existing `mcpServers` object) and `postFailure(agent, threadId, e)` (the existing catch body with its console.error), and use both from `runTurn` and `runDebateTurn`.

`packages/daemon/src/main.ts` — add to the HubSocket options:
```ts
  onTurn: (turn) => {
    loop.handleTurnRequest(turn);
  },
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (+5 → 38 daemon). Full `npx pnpm test` + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): orchestrator turn requests with watermarked debate prompts"
```

---

### Task 8: Daemon — CodexAdapter + per-runtime adapters map

**Files:**
- Create: `packages/daemon/src/codex-adapter.ts`, `packages/daemon/test/fixtures/fake-codex.mjs`
- Modify: `packages/daemon/src/stream-json.ts` (ParsedTurn.tokens + summarizeCodexTurn), `packages/daemon/src/agent-loop.ts` (adapters map), `packages/daemon/src/main.ts` (both adapters, no runtime filter), `packages/daemon/test/agent-loop.test.ts` + `packages/daemon/test/turn-request.test.ts` (opts rename `adapter:` → `adapters:`)
- Test: `packages/daemon/test/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `parseStreamLine`, `CliEvent`, `RuntimeAdapter`/`TurnOptions` (unchanged).
- Produces:
  - `ParsedTurn` gains `tokens?: { input: number; output: number }` (optional — no existing test changes needed).
  - `summarizeCodexTurn(events: CliEvent[], fallbackSessionId?: string): ParsedTurn` (in `stream-json.ts`): sessionId from `thread.started`.`thread_id` else fallback else `""`; text = LAST `item.completed` event whose `item.type === "agent_message"` (`item.text`), else `turn.failed`.`error.message`, else `""`; isError = a `turn.failed` event exists; tokens from `turn.completed`.`usage` (`input_tokens`/`output_tokens`); costUsd always 0. Throws `"no recognizable codex events in CLI output"` when events contain none of thread.started / turn.completed / turn.failed / agent_message items.
  - `class CodexAdapter implements RuntimeAdapter { constructor(bin = "codex") }` — argv: `["exec", ...(sessionId ? ["resume", sessionId] : []), "--json", "--sandbox", "workspace-write", "-c", "approval_policy=never", ...mcpOverrides]` where mcpOverrides per server named `n`: `["-c", `mcp_servers.${n}.command=${JSON.stringify(cmd)}`, "-c", `mcp_servers.${n}.args=${JSON.stringify(args)}`]` plus per env entry `["-c", `mcp_servers.${n}.env.${KEY}=${JSON.stringify(value)}`]`. Prompt via stdin. Same process handling as ClaudeCodeAdapter (readline, stderr cap 8192, timeout default 600 000 SIGKILL, stdin error guard, settle-once). `opts.allowedTools` intentionally unused (sandbox governs Codex) — document with a comment.
  - `AgentLoopOptions.adapter: RuntimeAdapter` becomes `adapters: Partial<Record<AgentRuntime, RuntimeAdapter>>`; turn paths resolve `this.opts.adapters[agent.runtime]`; missing adapter → `postFailure` with `new Error(\`no adapter for runtime ${agent.runtime}\`)`.
  - `main.ts`: `adapters: { "claude-code": new ClaudeCodeAdapter(cfg.claudeBin), codex: new CodexAdapter(cfg.codexBin) }`; the `.filter((a) => a.runtime === "claude-code")` on registry agents is REMOVED. `DaemonConfig` gains `codexBin` (env `CONCLAVE_CODEX_BIN`, default `"codex"`) — add to `config.ts` and one assertion in the existing config test.

- [ ] **Step 1: Create the fake codex fixture**

`packages/daemon/test/fixtures/fake-codex.mjs`:
```js
#!/usr/bin/env node
// Emits codex-exec-shaped JSONL. Captures its invocation for assertions.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_MODE === "die-early") process.exit(1);

const stdin = readFileSync(0, "utf8");
const resumeIdx = args.indexOf("resume");
const threadId = resumeIdx === -1 ? "codex-thread-new" : args[resumeIdx + 1];

if (process.env.FAKE_CODEX_CAPTURE) {
  appendFileSync(
    process.env.FAKE_CODEX_CAPTURE,
    JSON.stringify({ args, stdin, cwd: process.cwd() }) + "\n",
  );
}

if (process.env.FAKE_CODEX_MODE === "fail") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } }));
  process.exit(1);
}
if (process.env.FAKE_CODEX_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: `codex says: ${stdin.trim()}` },
  }));
  console.log(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 25 },
  }));
}
```

- [ ] **Step 2: Write the failing tests**

`packages/daemon/test/codex-adapter.test.ts`:
```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex-adapter.js";
import { parseStreamLine, summarizeCodexTurn } from "../src/stream-json.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

interface Capture { args: string[]; stdin: string; cwd: string }

function captureFile(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-cxc-")), "cap.ndjson");
}
function readCaptures(path: string): Capture[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Capture);
}

afterEach(() => {
  delete process.env["FAKE_CODEX_MODE"];
  delete process.env["FAKE_CODEX_CAPTURE"];
});

describe("summarizeCodexTurn", () => {
  it("extracts session, text, tokens", () => {
    const lines = [
      `{"type":"thread.started","thread_id":"th-1"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}`,
    ];
    const turn = summarizeCodexTurn(lines.map((l) => parseStreamLine(l)!));
    expect(turn).toMatchObject({
      sessionId: "th-1", text: "hello", isError: false, costUsd: 0,
      tokens: { input: 10, output: 4 },
    });
  });

  it("flags turn.failed and throws on unrecognizable output", () => {
    const failed = summarizeCodexTurn([
      parseStreamLine(`{"type":"turn.failed","error":{"message":"usage limit reached"}}`)!,
    ], "th-fallback");
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("usage limit");
    expect(failed.sessionId).toBe("th-fallback");
    expect(() => summarizeCodexTurn([parseStreamLine(`{"type":"noise"}`)!])).toThrow(
      /no recognizable codex events/,
    );
  });
});

describe("CodexAdapter", () => {
  it("spawns exec with contract flags, mcp overrides, stdin prompt", async () => {
    const cap = captureFile();
    process.env["FAKE_CODEX_CAPTURE"] = cap;
    const cwd = mkdtempSync(join(tmpdir(), "conclave-cxw-"));
    const adapter = new CodexAdapter(FAKE);
    const result = await adapter.runTurn({
      cwd, prompt: "review this", allowedTools: ["Read"],
      mcpServers: { hub: { command: "node", args: ["b.js"], env: { CONCLAVE_TOKEN: "t" } } },
    });
    expect(result.sessionId).toBe("codex-thread-new");
    expect(result.text).toBe("codex says: review this");
    expect(result.tokens).toEqual({ input: 100, output: 25 });
    const [c] = readCaptures(cap);
    expect(c!.stdin).toBe("review this");
    expect(c!.cwd).toBe(cwd);
    expect(c!.args[0]).toBe("exec");
    expect(c!.args).not.toContain("resume");
    expect(c!.args).toContain("--json");
    expect(c!.args).toContain("approval_policy=never");
    expect(c!.args).toContain('mcp_servers.hub.command="node"');
    expect(c!.args).toContain('mcp_servers.hub.args=["b.js"]');
    expect(c!.args).toContain('mcp_servers.hub.env.CONCLAVE_TOKEN="t"');
    expect(c!.args).not.toContain("--allowedTools");
  });

  it("resumes via exec resume <id>", async () => {
    const cap = captureFile();
    process.env["FAKE_CODEX_CAPTURE"] = cap;
    const adapter = new CodexAdapter(FAKE);
    const result = await adapter.runTurn({
      cwd: process.cwd(), prompt: "again", sessionId: "th-42", allowedTools: [],
    });
    expect(result.sessionId).toBe("th-42");
    const [c] = readCaptures(cap);
    expect(c!.args.slice(0, 3)).toEqual(["exec", "resume", "th-42"]);
  });

  it("surfaces turn.failed as isError result, not rejection", async () => {
    process.env["FAKE_CODEX_MODE"] = "fail";
    const adapter = new CodexAdapter(FAKE);
    const result = await adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("usage limit");
  });

  it("kills and rejects on timeout", async () => {
    process.env["FAKE_CODEX_MODE"] = "hang";
    const adapter = new CodexAdapter(FAKE);
    await expect(
      adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [], timeoutMs: 500 }),
    ).rejects.toThrow(/timeout/i);
  }, 10_000);
});
```

- [ ] **Step 3: RED**

Run: `npx pnpm vitest run packages/daemon/test/codex-adapter.test.ts` — Expected: FAIL.

- [ ] **Step 4: Implement**

`packages/daemon/src/stream-json.ts` — extend `ParsedTurn` and add:
```ts
export interface ParsedTurn {
  sessionId: string;
  text: string;
  isError: boolean;
  costUsd: number;
  tokens?: { input: number; output: number };
}

interface CodexItem {
  type?: string;
  text?: string;
}

export function summarizeCodexTurn(events: CliEvent[], fallbackSessionId?: string): ParsedTurn {
  const started = events.find((e) => e.type === "thread.started");
  const completed = events.find((e) => e.type === "turn.completed");
  const failed = events.find((e) => e.type === "turn.failed");
  const agentMessages = events.filter((e) => {
    if (e.type !== "item.completed") return false;
    const item = e["item"] as CodexItem | undefined;
    return item?.type === "agent_message";
  });
  if (!started && !completed && !failed && agentMessages.length === 0) {
    throw new Error("no recognizable codex events in CLI output");
  }
  const lastText = (agentMessages.at(-1)?.["item"] as CodexItem | undefined)?.text;
  const failedMessage = (failed?.["error"] as { message?: string } | undefined)?.message;
  const usage = completed?.["usage"] as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  return {
    sessionId: (started?.["thread_id"] as string | undefined) ?? fallbackSessionId ?? "",
    text: lastText ?? failedMessage ?? "",
    isError: failed !== undefined,
    costUsd: 0,
    tokens: usage
      ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
      : undefined,
  };
}
```

`packages/daemon/src/codex-adapter.ts` — same process skeleton as `claude-adapter.ts` (spawn, readline, stderr cap 8192, timeout SIGKILL, stdin error guard, settle-once), with:
```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "./adapter.js";
import { parseStreamLine, summarizeCodexTurn, type CliEvent } from "./stream-json.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const STDERR_LIMIT = 8192;

export class CodexAdapter implements RuntimeAdapter {
  constructor(private readonly bin = "codex") {}

  runTurn(opts: TurnOptions): Promise<TurnResult> {
    // opts.allowedTools intentionally unused: Codex has no per-tool allowlist;
    // the workspace-write sandbox is the control surface.
    const args = ["exec"];
    if (opts.sessionId) args.push("resume", opts.sessionId);
    args.push("--json", "--sandbox", "workspace-write", "-c", "approval_policy=never");
    if (opts.mcpServers) {
      for (const [name, server] of Object.entries(opts.mcpServers)) {
        const s = server as { command: string; args?: string[]; env?: Record<string, string> };
        args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`);
        if (s.args) args.push("-c", `mcp_servers.${name}.args=${JSON.stringify(s.args)}`);
        for (const [key, value] of Object.entries(s.env ?? {})) {
          args.push("-c", `mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`);
        }
      }
    }

    return new Promise<TurnResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const events: CliEvent[] = [];
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        fail(new Error(`codex turn timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      function fail(err: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
      function succeed(result: TurnResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }

      child.on("error", (err) => fail(new Error(`failed to spawn ${this.bin}: ${err.message}`)));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const event = parseStreamLine(line);
        if (!event) return;
        events.push(event);
        opts.onEvent?.(event);
      });

      child.on("close", (code) => {
        try {
          succeed(summarizeCodexTurn(events, opts.sessionId));
        } catch (err) {
          const detail = stderr.trim().slice(-500);
          fail(
            new Error(
              `${(err as Error).message} (exit code ${code}${detail ? `, stderr: ${detail}` : ""})`,
            ),
          );
        }
      });

      // EPIPE when the child dies before draining stdin must not crash the
      // process; the close handler settles the turn for every death mode.
      child.stdin.on("error", () => {});
      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  }
}
```

`packages/daemon/src/agent-loop.ts` — `AgentLoopOptions.adapter: RuntimeAdapter` → `adapters: Partial<Record<AgentRuntime, RuntimeAdapter>>` (import `AgentRuntime` type from shared). In both `runTurn` and `runDebateTurn`:
```ts
      const adapter = this.opts.adapters[agent.runtime];
      if (!adapter) throw new Error(`no adapter for runtime ${agent.runtime}`);
```
(the throw lands in the existing catch → `postFailure`).

`packages/daemon/src/config.ts` — add `codexBin: env["CONCLAVE_CODEX_BIN"] ?? "codex"` to `DaemonConfig` + loader. Add to the existing defaults test: `expect(cfg.codexBin).toBe("codex");`.

`packages/daemon/src/main.ts`:
```ts
import { CodexAdapter } from "./codex-adapter.js";
// registry: remove the runtime filter entirely:
const agents = await hub.getRegistry(cfg.machine);
// loop opts:
  adapters: {
    "claude-code": new ClaudeCodeAdapter(cfg.claudeBin),
    codex: new CodexAdapter(cfg.codexBin),
  },
```

Update `agent-loop.test.ts` and `turn-request.test.ts` setups: `adapter,` → `adapters: { "claude-code": adapter, codex: adapter },` (the shared FakeAdapter serves both runtimes).

- [ ] **Step 5: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (+6 new `it` blocks — the config assertion lands inside an existing test → 44 daemon). `npx pnpm test` + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): codex adapter and per-runtime adapters map"
```

---

### Task 9: Daemon — error/rate-limit surfacing + usage reporting

**Files:**
- Modify: `packages/daemon/src/agent-loop.ts` (reportTurn), `packages/daemon/src/hub-client.ts` (postUsage), `packages/daemon/src/stream-json.ts` (claude tokens)
- Test: `packages/daemon/test/turn-report.test.ts`

**Interfaces:**
- Consumes: `POST /api/usage` (Task 2), `ParsedTurn.tokens` (Task 8).
- Produces:
  - `HubClient.postUsage(report: UsageReport): Promise<void>` → `POST /api/usage`.
  - `summarizeTurn` (claude) now also extracts `tokens` from the result event's `usage` field (`input_tokens`/`output_tokens`) when present.
  - `AgentLoop` private `reportTurn(agent, threadId, result: TurnResult): Promise<void>`, called from BOTH turn paths after the adapter resolves:
    - usage: when `result.tokens` present or `costUsd > 0` → `postUsage({agent: agent.id, threadId, inputTokens, outputTokens, costUsd})`; failures logged via console.error, never thrown.
    - error results: when `result.isError`, do NOT post the text as a normal reply; instead post a status message — body starts `agent <id> rate-limited:` when `/rate.?limit|usage limit|too many requests|429/i` matches `result.text`, else `agent <id> error:`, followed by the first 200 chars of `result.text`.
  - Both turn paths restructure to: `reportTurn(...)` always; post `result.text` as `type:"text"` only when `!result.isError && result.text.trim()`.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/turn-report.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentConfig } from "@conclave/shared";
import Database from "better-sqlite3";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { listUsage } from "@conclave/hub/src/usage.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import { AgentLoop } from "../src/agent-loop.js";

const TOKEN = "rep-token";
const AGENT: AgentConfig = {
  id: "codex", name: "Codex", runtime: "codex", machine: "m",
  workspace: "/tmp/ws", role: "", allowedTools: [],
};

class ScriptedAdapter implements RuntimeAdapter {
  constructor(private readonly result: TurnResult) {}
  async runTurn(_opts: TurnOptions): Promise<TurnResult> {
    return this.result;
  }
}

describe("turn reporting", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function setup(result: TurnResult) {
    const dir = mkdtempSync(join(tmpdir(), "conclave-rep-"));
    const db: Database.Database = openDb(join(dir, "t.db"));
    const mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN, db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const loop = new AgentLoop({
      agents: [AGENT], hub: new HubClient(hubUrl, TOKEN),
      adapters: { codex: new ScriptedAdapter(result), "claude-code": new ScriptedAdapter(result) },
      state: new DaemonState(join(dir, "state.json")), queue: new TurnQueue(),
      hubUrl, token: TOKEN, allowAgentTriggers: false,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    return { mailbox, db, loop };
  }

  it("posts usage rows for successful turns with tokens", async () => {
    const { mailbox, db, loop } = await setup({
      sessionId: "s", text: "fine", isError: false, costUsd: 0.02,
      tokens: { input: 50, output: 9 },
    });
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "codex", sinceMessageId: 0 });
    await loop.idle();
    const rows = listUsage(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "codex", threadId: t.id, inputTokens: 50, outputTokens: 9, costUsd: 0.02,
    });
    expect(mailbox.listMessages(t.id).map((m) => m.body)).toContain("fine");
  });

  it("posts rate-limited status instead of a reply on error results", async () => {
    const { mailbox, loop } = await setup({
      sessionId: "s", text: "usage limit reached, resets 16:00", isError: true, costUsd: 0,
    });
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "codex", sinceMessageId: 0 });
    await loop.idle();
    const messages = mailbox.listMessages(t.id);
    const status = messages.find((m) => m.type === "status");
    expect(status!.body).toContain("agent codex rate-limited:");
    expect(messages.filter((m) => m.type === "text")).toHaveLength(0);
  });

  it("posts plain error status for non-rate-limit errors", async () => {
    const { mailbox, loop } = await setup({
      sessionId: "s", text: "segfault in tool", isError: true, costUsd: 0,
    });
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "codex", sinceMessageId: 0 });
    await loop.idle();
    const status = mailbox.listMessages(t.id).find((m) => m.type === "status");
    expect(status!.body).toContain("agent codex error:");
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/turn-report.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/daemon/src/hub-client.ts`:
```ts
import type { ..., UsageReport } from "@conclave/shared";

  async postUsage(report: UsageReport): Promise<void> {
    await this.request("POST", "/api/usage", report);
  }
```

`packages/daemon/src/stream-json.ts` — in `summarizeTurn` (claude), before the return:
```ts
  const usage = result["usage"] as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
```
and add to the returned object:
```ts
    tokens: usage
      ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
      : undefined,
```

`packages/daemon/src/agent-loop.ts` — add the private method and rewire both paths:
```ts
  private async reportTurn(
    agent: AgentConfig,
    threadId: string,
    result: TurnResult,
  ): Promise<void> {
    if (result.tokens || result.costUsd > 0) {
      try {
        await this.opts.hub.postUsage({
          agent: agent.id,
          threadId,
          inputTokens: result.tokens?.input ?? 0,
          outputTokens: result.tokens?.output ?? 0,
          costUsd: result.costUsd,
        });
      } catch (e) {
        console.error(
          `agent ${agent.id}: failed to post usage:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    if (result.isError) {
      const rateLimited = /rate.?limit|usage limit|too many requests|429/i.test(result.text);
      const label = rateLimited ? "rate-limited" : "error";
      await this.opts.hub.postMessage(threadId, {
        from: agent.id, to: [], type: "status",
        body: `agent ${agent.id} ${label}: ${result.text.slice(0, 200)}`, artifacts: [],
      });
    }
  }
```
In `runTurn` and `runDebateTurn`, after session/watermark bookkeeping:
```ts
      await this.reportTurn(agent, <threadId>, result);
      if (!result.isError && result.text.trim()) {
        await hub.postMessage(<threadId>, { from: agent.id, to: <existing>, type: "text", body: result.text, artifacts: [] });
      }
```
(`<existing>`: `[m.from]` in the mention path, `[]` in the debate path — unchanged.)

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (+3 → 47 daemon; report real). Full suite + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): rate-limit/error status posts and usage reporting"
```

---

### Task 10: E2E debate + docs + manual smoke checklist

**Files:**
- Test: `packages/daemon/test/debate-e2e.test.ts`
- Modify: `packages/daemon/README.md`, `packages/hub/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: proof the full loop works — hub + orchestrator + WS turn frames + daemon loop + two fake adapters (one per runtime) debating to settlement — plus operator docs.

- [ ] **Step 1: Write the E2E test**

`packages/daemon/test/debate-e2e.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentConfig } from "@conclave/shared";
import Database from "better-sqlite3";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { DebateStore } from "@conclave/hub/src/debates.js";
import { DebateOrchestrator } from "@conclave/hub/src/orchestrator.js";
import { listUsage } from "@conclave/hub/src/usage.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import { HubSocket } from "../src/hub-socket.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import { AgentLoop } from "../src/agent-loop.js";

const TOKEN = "e2e-token";

function agentCfg(id: string, runtime: AgentConfig["runtime"]): AgentConfig {
  return { id, name: id, runtime, machine: "m", workspace: `/tmp/${id}`, role: `You are ${id}.`, allowedTools: [] };
}

// Simulates a real agent: replies once, then calls end_thread (via setVerdict,
// which is what the MCP bridge's end_thread does) when the orchestrator's
// final/verdict instruction appears in the prompt.
class DebatingAdapter implements RuntimeAdapter {
  turns = 0;
  constructor(private readonly client: HubClient, private readonly agentId: string) {}

  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    this.turns += 1;
    const env = (opts.mcpServers?.["hub"] as { env: Record<string, string> }).env;
    const threadId = env["CONCLAVE_THREAD_ID"]!;
    const mustEnd =
      opts.prompt.includes("MUST call end_thread") ||
      (this.turns >= 2 && opts.prompt.includes("call end_thread with your verdict"));
    if (mustEnd) {
      await this.client.setVerdict(threadId, this.agentId, `approve (${this.agentId})`);
      return { sessionId: `${this.agentId}-s`, text: "", isError: false, costUsd: 0 };
    }
    return {
      sessionId: `${this.agentId}-s`,
      text: `${this.agentId} argues in turn ${this.turns}`,
      isError: false, costUsd: 0.01, tokens: { input: 10, output: 5 },
    };
  }
}

describe("full debate end to end", () => {
  let app: FastifyInstance;
  let socket: HubSocket | undefined;
  afterEach(async () => {
    socket?.stop();
    await app.close();
  });

  it("orchestrator + websocket + daemon loop reach settlement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-e2e-"));
    const db: Database.Database = openDb(join(dir, "t.db"));
    const mailbox = new Mailbox(db);
    const store = new DebateStore(db);
    const orchestrator = new DebateOrchestrator(mailbox, store, {
      turnTimeoutMs: 5000, finaleTimeoutMs: 3000,
    });
    app = await buildServer({ mailbox, token: TOKEN, db, orchestrator });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const client = new HubClient(hubUrl, TOKEN);

    const agents = [agentCfg("claude-code", "claude-code"), agentCfg("codex", "codex")];
    const loop = new AgentLoop({
      agents, hub: client,
      adapters: {
        "claude-code": new DebatingAdapter(client, "claude-code"),
        codex: new DebatingAdapter(client, "codex"),
      },
      state: new DaemonState(join(dir, "state.json")), queue: new TurnQueue(),
      hubUrl, token: TOKEN, allowAgentTriggers: false,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    socket = new HubSocket({
      hubUrl, token: TOKEN,
      onMessage: (m) => loop.handleMessage(m),
      onTurn: (turn) => loop.handleTurnRequest(turn),
    });
    socket.start();
    await new Promise((r) => setTimeout(r, 400));

    const res = await app.inject({
      method: "POST", url: "/api/debates",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        topic: "Should Conclave use tabs or spaces?",
        participants: ["claude-code", "codex"],
        minRounds: 1, maxRounds: 3,
      },
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json<{ id: string; threadId: string }>();

    await orchestrator.idle();
    await loop.idle();

    const thread = mailbox.getThread(rec.threadId)!;
    expect(thread.state).toBe("settled");
    expect(thread.verdicts["claude-code"]).toContain("approve");
    expect(thread.verdicts["codex"]).toContain("approve");

    const bodies = mailbox.listMessages(rec.threadId).map((m) => m.body);
    expect(bodies.some((b) => b.includes("claude-code argues"))).toBe(true);
    expect(bodies.some((b) => b.includes("codex argues"))).toBe(true);
    expect(bodies.some((b) => b.startsWith("debate finished"))).toBe(true);

    expect(listUsage(db).length).toBeGreaterThan(0);
    expect(store.get(rec.id)!.state).toBe("settled");
  }, 60_000);
});
```

- [ ] **Step 2: Run it**

Run: `npx pnpm vitest run packages/daemon/test/debate-e2e.test.ts`
Expected: PASS. If it hangs, the usual suspects are: turn frames not reaching the loop (check /ws forwarding), verdicts not settling (participants mismatch), or `orchestrator.idle()` racing `loop.idle()` (await orchestrator first, as written).

- [ ] **Step 3: Update the docs**

Append to `packages/hub/README.md` route table:
```markdown
| `GET /api/messages?after=N&limit=M` | – | Message[] across all threads (catch-up feed) |
| `POST /api/usage` | UsageReport | 201 |
| `GET /api/usage` | – | UsageRow[] (newest first) |
| `POST /api/debates` | `{topic, participants, minRounds?, maxRounds?, stances?, workspace?}` | 201 DebateRecord |
```

Append to `packages/daemon/README.md`:
```markdown
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

## Manual smoke checklist (burns real quota — run deliberately)

1. Claude turn: README steps above (step-2 smoke) still pass.
2. Codex turn: same flow with a codex agent — verifies `approval_policy=never`
   actually suppresses approvals in exec mode (unverified against a live turn
   so far) and that the MCP bridge connects via `-c mcp_servers` overrides.
3. `wait_for_reply` inside a real debate turn: confirm the CLI's MCP tool
   timeout tolerates the 60s long-poll (Claude: MCP_TOOL_TIMEOUT env;
   Codex: `-c mcp_servers.hub.tool_timeout_sec=90` if needed).
4. Two-agent debate with real CLIs and minRounds=1, maxRounds=2 on a toy topic.
```

- [ ] **Step 4: Full verification**

Run: `npx pnpm test && npx pnpm typecheck`
Expected: all passing (expected total 109: 18 shared + 43 hub + 48 daemon — report the real number), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon packages/hub
git commit -m "test(daemon): full debate e2e; docs and manual smoke checklist"
```
