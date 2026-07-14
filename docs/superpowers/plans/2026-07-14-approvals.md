# Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent about to do something dangerous calls `request_approval`, the task pauses (`input-required`), the user approves/denies from the web app, and the daemon resumes the session with the decision.

**Architecture:** Advisory + turn-split (spec: `docs/superpowers/specs/2026-07-14-approvals-design.md`). New `Approval` entity in shared; hub gets an idempotency-keyed `ApprovalStore`, `fileApproval`/`decideApproval` side-effect helpers, `/api/approvals` routes, and an `approval` WS frame; daemon gets a `request_approval` MCP tool and resume-on-decision in the agent loop; web renders `approval-request` messages as an approval card with Approve/Deny.

**Tech Stack:** TypeScript ESM (`.js` import specifiers), Zod v4, better-sqlite3, Fastify, ws, MCP SDK, React 18 + Zustand, Vitest.

## Global Constraints

- Work on branch `feat/approvals` (created in Task 1); merge to `main` with `--no-ff` only after the whole plan is done (finish-branch flow, not part of this plan).
- Backend tests MUST run from the repo root: `npx vitest run packages/<pkg>/test/<file>.test.ts`. Running vitest via `pnpm --filter` for hub/daemon/shared finds no config and fails.
- Web tests run via `npx pnpm --filter @conclave/web exec vitest run <path relative to packages/web>`. Do NOT run the full web suite in foreground — it hangs on teardown after printing the summary; run single files, or background the full suite to a log and grep the summary.
- All colors in web CSS come from theme tokens (`var(--…)`) — never hardcode colors. Monochrome UI; state carried by text/border weight, not color.
- Zod v4: use `z.enum([...])`, `.default()`, `z.string().datetime()` — matching existing schema style in `packages/shared/src/`.
- Every commit message body ends with:
  `Claude-Session: https://claude.ai/code/session_01TbrECLcmYg1meokreDbPi4`

---

### Task 1: Shared Approval schemas + `dangerousActions` on AgentConfig

**Files:**
- Create: `packages/shared/src/approval.ts`
- Modify: `packages/shared/src/index.ts` (add export)
- Modify: `packages/shared/src/registry.ts:5-13` (add `dangerousActions`)
- Test: `packages/shared/test/approval.test.ts`
- Modify (fixture fallout): every test/file that builds an `AgentConfig` object literal gains `dangerousActions: []` — find them with `grep -rln "allowedTools: \[\]" packages` (daemon tests, hub tests, web tests/fixtures).

**Interfaces:**
- Produces: `ApprovalStateSchema` (`"pending" | "approved" | "denied"`), `ApprovalSchema`, `NewApprovalSchema`, `ApprovalDecisionSchema`, types `Approval`, `ApprovalState`, `NewApproval`, `ApprovalDecision`; `AgentConfig` gains required `dangerousActions: string[]` (schema default `[]`).

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/approvals
```

- [ ] **Step 2: Write the failing test**

`packages/shared/test/approval.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  ApprovalDecisionSchema,
  ApprovalSchema,
  NewApprovalSchema,
} from "../src/index.js";

describe("approval schemas", () => {
  it("parses a full approval", () => {
    const a = ApprovalSchema.parse({
      id: "a1",
      threadId: "th1",
      taskId: "t1",
      requestedBy: "codex",
      action: "run scripts/deploy.sh prod",
      idempotencyKey: "k1",
      state: "pending",
      createdAt: "2026-07-14T10:00:00Z",
    });
    expect(a.taskId).toBe("t1");
    expect(a.note).toBeUndefined();
    expect(a.decidedAt).toBeUndefined();
  });

  it("rejects unknown states", () => {
    expect(
      ApprovalSchema.safeParse({
        id: "a1", threadId: "th1", requestedBy: "codex", action: "x",
        idempotencyKey: "k", state: "maybe", createdAt: "2026-07-14T10:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("NewApproval requires threadId, requestedBy, action, idempotencyKey; taskId optional", () => {
    const n = NewApprovalSchema.parse({
      threadId: "th1", requestedBy: "codex", action: "deploy", idempotencyKey: "k1",
    });
    expect(n.taskId).toBeUndefined();
    expect(NewApprovalSchema.safeParse({ threadId: "th1" }).success).toBe(false);
  });

  it("ApprovalDecision accepts approved/denied with optional note", () => {
    expect(ApprovalDecisionSchema.parse({ decision: "denied", note: "not now" }).note).toBe("not now");
    expect(ApprovalDecisionSchema.safeParse({ decision: "pending" }).success).toBe(false);
  });

  it("AgentConfig defaults dangerousActions to []", () => {
    const a = AgentConfigSchema.parse({
      id: "codex", name: "codex", runtime: "codex", machine: "m1", workspace: "/w",
    });
    expect(a.dangerousActions).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/approval.test.ts`
Expected: FAIL — `ApprovalSchema` is not exported.

- [ ] **Step 4: Implement**

`packages/shared/src/approval.ts`:

```ts
import { z } from "zod";

export const ApprovalStateSchema = z.enum(["pending", "approved", "denied"]);

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  requestedBy: z.string().min(1),
  action: z.string().min(1),
  idempotencyKey: z.string().min(1),
  state: ApprovalStateSchema,
  note: z.string().optional(),
  createdAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
});

export const NewApprovalSchema = z.object({
  threadId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  requestedBy: z.string().min(1),
  action: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  note: z.string().optional(),
});

export type ApprovalState = z.infer<typeof ApprovalStateSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type NewApproval = z.infer<typeof NewApprovalSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
```

In `packages/shared/src/index.ts` add:

```ts
export * from "./approval.js";
```

In `packages/shared/src/registry.ts`, add to `AgentConfigSchema` after `allowedTools`:

```ts
  dangerousActions: z.array(z.string()).default([]),
```

- [ ] **Step 5: Fix AgentConfig fixture fallout**

`dangerousActions` is required on the inferred `AgentConfig` type, so every object literal typed as `AgentConfig` must gain `dangerousActions: []`. Find and fix:

```bash
grep -rln "allowedTools: \[\]" packages | grep -v node_modules
```

(Known spots: `packages/daemon/test/task-run.test.ts`, `packages/daemon/test/agent-loop.test.ts`, other daemon tests with an `AGENT` fixture, hub registry tests with agent literals, `packages/web/src` test fixtures.) Then verify with typechecks:

```bash
npx pnpm -r typecheck
```

Expected: clean.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/shared/test/approval.test.ts && npx vitest run packages/shared packages/hub packages/daemon`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/daemon packages/hub packages/web
git commit -m "feat(shared): approval schemas + dangerousActions on AgentConfig"
```

---

### Task 2: Hub ApprovalStore (idempotent create, guarded decide)

**Files:**
- Create: `packages/hub/src/approvals.ts` (store only in this task; helpers come in Task 3)
- Modify: `packages/hub/src/db.ts` (add `approvals` table to `migrate()`)
- Test: `packages/hub/test/approvals-store.test.ts`

**Interfaces:**
- Consumes: `Approval`, `ApprovalState` from `@conclave/shared`.
- Produces: `class ApprovalStore { constructor(db: Database.Database); create(a: Approval): Approval; findByKey(requestedBy: string, key: string): Approval | undefined; get(id: string): Approval | undefined; list(state?: ApprovalState): Approval[]; decide(id: string, decision: "approved" | "denied", note?: string): Approval }`; `class AlreadyDecidedError extends Error`.

- [ ] **Step 1: Write the failing test**

`packages/hub/test/approvals-store.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { AlreadyDecidedError, ApprovalStore } from "../src/approvals.js";

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", requestedBy: "codex", action: "deploy prod",
    idempotencyKey: "k1", state: "pending", createdAt: "2026-07-14T10:00:00Z", ...over,
  };
}

describe("ApprovalStore", () => {
  let store: ApprovalStore;
  beforeEach(() => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-appr-")), "t.db"));
    store = new ApprovalStore(db);
  });

  it("creates and reads back an approval (round-trip incl. optional fields)", () => {
    store.create(approval({ taskId: "t1" }));
    const got = store.get("a1");
    expect(got?.taskId).toBe("t1");
    expect(got?.state).toBe("pending");
    expect(got?.note).toBeUndefined();
    expect(got?.decidedAt).toBeUndefined();
  });

  it("findByKey returns the row for (requestedBy, idempotencyKey)", () => {
    store.create(approval());
    expect(store.findByKey("codex", "k1")?.id).toBe("a1");
    expect(store.findByKey("codex", "other")).toBeUndefined();
    expect(store.findByKey("claude-code", "k1")).toBeUndefined();
  });

  it("lists all or by state", () => {
    store.create(approval());
    store.create(approval({ id: "a2", idempotencyKey: "k2" }));
    store.decide("a2", "approved");
    expect(store.list().map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(store.list("pending").map((a) => a.id)).toEqual(["a1"]);
    expect(store.list("approved").map((a) => a.id)).toEqual(["a2"]);
  });

  it("decide sets state, note, decidedAt", () => {
    store.create(approval());
    const decided = store.decide("a1", "denied", "not today");
    expect(decided.state).toBe("denied");
    expect(decided.note).toBe("not today");
    expect(decided.decidedAt).toBeTruthy();
    expect(store.get("a1")?.state).toBe("denied");
  });

  it("deciding twice throws AlreadyDecidedError", () => {
    store.create(approval());
    store.decide("a1", "approved");
    expect(() => store.decide("a1", "denied")).toThrow(AlreadyDecidedError);
  });

  it("deciding an unknown id throws", () => {
    expect(() => store.decide("nope", "approved")).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/approvals-store.test.ts`
Expected: FAIL — cannot resolve `../src/approvals.js`.

- [ ] **Step 3: Implement**

Add to `migrate()` in `packages/hub/src/db.ts` (inside the same `db.exec` template, after `workspaces`):

```sql
    CREATE TABLE IF NOT EXISTS approvals (
      id              TEXT PRIMARY KEY,
      thread_id       TEXT NOT NULL REFERENCES threads(id),
      task_id         TEXT,
      requested_by    TEXT NOT NULL,
      action          TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'pending',
      note            TEXT,
      created_at      TEXT NOT NULL,
      decided_at      TEXT,
      UNIQUE (requested_by, idempotency_key)
    );
```

`packages/hub/src/approvals.ts`:

```ts
import type Database from "better-sqlite3";
import type { Approval, ApprovalState } from "@conclave/shared";

export class AlreadyDecidedError extends Error {
  constructor(id: string, state: ApprovalState) {
    super(`approval ${id} already decided: ${state}`);
  }
}

interface ApprovalRow {
  id: string;
  thread_id: string;
  task_id: string | null;
  requested_by: string;
  action: string;
  idempotency_key: string;
  state: string;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    threadId: r.thread_id,
    ...(r.task_id ? { taskId: r.task_id } : {}),
    requestedBy: r.requested_by,
    action: r.action,
    idempotencyKey: r.idempotency_key,
    state: r.state as ApprovalState,
    ...(r.note ? { note: r.note } : {}),
    createdAt: r.created_at,
    ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
  };
}

export class ApprovalStore {
  constructor(private readonly db: Database.Database) {}

  create(a: Approval): Approval {
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, thread_id, task_id, requested_by, action, idempotency_key, state, note, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.threadId, a.taskId ?? null, a.requestedBy, a.action,
        a.idempotencyKey, a.state, a.note ?? null, a.createdAt, a.decidedAt ?? null,
      );
    return a;
  }

  findByKey(requestedBy: string, key: string): Approval | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE requested_by = ? AND idempotency_key = ?")
      .get(requestedBy, key) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  list(state?: ApprovalState): Approval[] {
    const rows = state
      ? (this.db
          .prepare("SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC")
          .all(state) as ApprovalRow[])
      : (this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as ApprovalRow[]);
    return rows.map(rowToApproval);
  }

  decide(id: string, decision: "approved" | "denied", note?: string): Approval {
    const current = this.get(id);
    if (!current) throw new Error(`approval not found: ${id}`);
    if (current.state !== "pending") throw new AlreadyDecidedError(id, current.state);
    const decidedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE approvals SET state = ?, note = ?, decided_at = ? WHERE id = ?")
      .run(decision, note ?? null, decidedAt, id);
    return { ...current, state: decision, ...(note ? { note } : {}), decidedAt };
  }
}
```

Note: the test inserts approvals with `thread_id = 'th1'` without a matching thread. SQLite enforces `REFERENCES threads(id)` because `foreign_keys = ON` — so the store test must create a thread first OR the column must drop the FK. **Use the FK and fix the test fixture instead**: in the test `beforeEach`, after `openDb`, run

```ts
db.prepare(
  "INSERT INTO threads (id, kind, workspace, participants, state, verdicts, created_at) VALUES ('th1','task',NULL,'[]','open','{}','2026-07-14T10:00:00Z')",
).run();
```

(keep `db` in a variable). This mirrors how tasks tests handle the same constraint.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/hub/test/approvals-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/approvals.ts packages/hub/src/db.ts packages/hub/test/approvals-store.test.ts
git commit -m "feat(hub): ApprovalStore with idempotency key and guarded decide"
```

---

### Task 3: Hub fileApproval/decideApproval helpers + TaskStore.getByThread

**Files:**
- Modify: `packages/hub/src/approvals.ts` (append helpers)
- Modify: `packages/hub/src/tasks.ts` (add `getByThread`)
- Test: `packages/hub/test/approvals-flow.test.ts`

**Interfaces:**
- Consumes: `ApprovalStore` (Task 2), `Mailbox` (`createThread`, `appendMessage`, `events` EventEmitter), `TaskStore` (`create`, `get`, `updateState`).
- Produces:
  - `TaskStore.getByThread(threadId: string): Task | undefined`
  - `fileApproval(deps: { mailbox: Mailbox; store: ApprovalStore; tasks?: TaskStore }, input: NewApproval): Approval`
  - `decideApproval(deps: { mailbox: Mailbox; store: ApprovalStore; tasks?: TaskStore }, id: string, decision: "approved" | "denied", note?: string): Approval`
  - Both emit `mailbox.events.emit("approval", approval)`; task-coupled calls also emit `"task"` with the updated task.

- [ ] **Step 1: Write the failing test**

`packages/hub/test/approvals-flow.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Approval, Registry, Task } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { TaskStore, createTask } from "../src/tasks.js";
import { ApprovalStore, decideApproval, fileApproval } from "../src/approvals.js";

const REGISTRY: Registry = {
  agents: [{
    id: "codex", name: "codex", runtime: "codex", machine: "m1",
    workspace: "/w", role: "", allowedTools: [], dangerousActions: [],
  }],
};

describe("fileApproval / decideApproval", () => {
  let mailbox: Mailbox;
  let tasks: TaskStore;
  let store: ApprovalStore;
  let task: Task;

  beforeEach(() => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-aflow-")), "t.db"));
    mailbox = new Mailbox(db);
    tasks = new TaskStore(db);
    store = new ApprovalStore(db);
    task = createTask({ mailbox, store: tasks, registry: REGISTRY }, {
      assignee: "codex", spec: "deploy the app",
    });
    tasks.updateState(task.id, "running");
  });

  it("getByThread finds the task for its thread", () => {
    expect(tasks.getByThread(task.threadId)?.id).toBe(task.id);
    expect(tasks.getByThread("nope")).toBeUndefined();
  });

  it("filing posts an approval-request message, pauses the task, emits approval", () => {
    const emitted: Approval[] = [];
    mailbox.events.on("approval", (a: Approval) => emitted.push(a));
    const approval = fileApproval({ mailbox, store, tasks }, {
      threadId: task.threadId, requestedBy: "codex",
      action: "run deploy.sh", idempotencyKey: "k1",
    });
    expect(approval.state).toBe("pending");
    expect(approval.taskId).toBe(task.id); // resolved from threadId
    const msg = mailbox.listMessages(task.threadId).find((m) => m.type === "approval-request");
    expect(msg).toBeTruthy();
    expect(JSON.parse(msg!.body)).toEqual({ approvalId: approval.id, action: "run deploy.sh" });
    expect(tasks.get(task.id)?.state).toBe("input-required");
    expect(emitted.map((a) => a.id)).toEqual([approval.id]);
  });

  it("filing with a seen idempotency key returns the existing approval, no side effects", () => {
    const first = fileApproval({ mailbox, store, tasks }, {
      threadId: task.threadId, requestedBy: "codex", action: "run deploy.sh", idempotencyKey: "k1",
    });
    const before = mailbox.listMessages(task.threadId).length;
    const second = fileApproval({ mailbox, store, tasks }, {
      threadId: task.threadId, requestedBy: "codex", action: "run deploy.sh", idempotencyKey: "k1",
    });
    expect(second.id).toBe(first.id);
    expect(mailbox.listMessages(task.threadId).length).toBe(before);
  });

  it("deciding resumes the task, posts a status message, emits approval", () => {
    const approval = fileApproval({ mailbox, store, tasks }, {
      threadId: task.threadId, requestedBy: "codex", action: "run deploy.sh", idempotencyKey: "k1",
    });
    const decided = decideApproval({ mailbox, store, tasks }, approval.id, "approved", "go ahead");
    expect(decided.state).toBe("approved");
    expect(tasks.get(task.id)?.state).toBe("running");
    const status = mailbox
      .listMessages(task.threadId)
      .find((m) => m.type === "status" && m.body.includes("approved"));
    expect(status?.body).toBe("you approved: run deploy.sh — go ahead");
  });

  it("works without a task (chat thread): no task coupling, still messages + approval", () => {
    const chat = mailbox.createThread({ kind: "chat", participants: ["you", "codex"] });
    const approval = fileApproval({ mailbox, store, tasks }, {
      threadId: chat.id, requestedBy: "codex", action: "push to main", idempotencyKey: "k9",
    });
    expect(approval.taskId).toBeUndefined();
    decideApproval({ mailbox, store, tasks }, approval.id, "denied");
    const status = mailbox.listMessages(chat.id).find((m) => m.type === "status");
    expect(status?.body).toBe("you denied: push to main");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/approvals-flow.test.ts`
Expected: FAIL — `fileApproval` not exported / `getByThread` not a function.

- [ ] **Step 3: Implement**

Add to `packages/hub/src/tasks.ts` (inside `TaskStore`, after `get`):

```ts
  getByThread(threadId: string): Task | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(threadId) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }
```

Append to `packages/hub/src/approvals.ts` (new imports at top: `import { randomUUID } from "node:crypto";`, `import type { NewApproval } from "@conclave/shared";`, `import type { Mailbox } from "./mailbox.js";`, `import type { TaskStore } from "./tasks.js";` — merge with existing type imports):

```ts
export interface ApprovalDeps {
  mailbox: Mailbox;
  store: ApprovalStore;
  tasks?: TaskStore;
}

export function fileApproval(deps: ApprovalDeps, input: NewApproval): Approval {
  const existing = deps.store.findByKey(input.requestedBy, input.idempotencyKey);
  if (existing) return existing;

  const task = input.taskId
    ? deps.tasks?.get(input.taskId)
    : deps.tasks?.getByThread(input.threadId);
  const approval: Approval = {
    id: randomUUID(),
    threadId: input.threadId,
    ...(task ? { taskId: task.id } : {}),
    requestedBy: input.requestedBy,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    state: "pending",
    createdAt: new Date().toISOString(),
  };
  deps.store.create(approval);
  deps.mailbox.appendMessage(input.threadId, {
    from: input.requestedBy,
    to: [],
    type: "approval-request",
    body: JSON.stringify({ approvalId: approval.id, action: approval.action }),
    artifacts: [],
  });
  if (task && deps.tasks && task.state === "running") {
    const updated = deps.tasks.updateState(task.id, "input-required");
    deps.mailbox.events.emit("task", updated);
  }
  deps.mailbox.events.emit("approval", approval);
  return approval;
}

export function decideApproval(
  deps: ApprovalDeps,
  id: string,
  decision: "approved" | "denied",
  note?: string,
): Approval {
  const approval = deps.store.decide(id, decision, note);
  deps.mailbox.appendMessage(approval.threadId, {
    from: "you",
    to: [],
    type: "status",
    body: `you ${decision}: ${approval.action}${note ? ` — ${note}` : ""}`,
    artifacts: [],
  });
  if (approval.taskId && deps.tasks) {
    const t = deps.tasks.get(approval.taskId);
    if (t && t.state === "input-required") {
      const updated = deps.tasks.updateState(approval.taskId, "running");
      deps.mailbox.events.emit("task", updated);
    }
  }
  deps.mailbox.events.emit("approval", approval);
  return approval;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/approvals-flow.test.ts packages/hub/test/approvals-store.test.ts packages/hub/test/tasks-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/approvals.ts packages/hub/src/tasks.ts packages/hub/test/approvals-flow.test.ts
git commit -m "feat(hub): fileApproval/decideApproval side-effect helpers + TaskStore.getByThread"
```

---

### Task 4: Hub routes + `approval` WS frame

**Files:**
- Modify: `packages/hub/src/server.ts` (ServerOptions, routes, WS broadcast)
- Modify: `packages/hub/src/main.ts` (construct + pass `ApprovalStore`)
- Test: `packages/hub/test/approvals-api.test.ts`

**Interfaces:**
- Consumes: `ApprovalStore`, `AlreadyDecidedError`, `fileApproval`, `decideApproval` (Tasks 2–3); `NewApprovalSchema`, `ApprovalDecisionSchema`, `ApprovalStateSchema` from shared.
- Produces:
  - `ServerOptions.approvals?: ApprovalStore`
  - `POST /api/approvals` → 201 `Approval` (200-equivalent existing row on idempotency hit — still 201), 400 invalid, 503 unconfigured
  - `GET /api/approvals` (`?state=pending|approved|denied`) → `Approval[]`, 400 invalid state
  - `GET /api/approvals/:id` → `Approval` | 404
  - `POST /api/approvals/:id/decide` (`{decision, note?}`) → `Approval` | 404 | 409 already decided
  - WS frame `{type: "approval", approval: Approval}` on file and decide (from the `"approval"` mailbox event)

- [ ] **Step 1: Write the failing test**

`packages/hub/test/approvals-api.test.ts` (follow `tasks-api.test.ts` style — `buildServer` + `app.inject`):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Approval, Registry, Task } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { TaskStore, createTask } from "../src/tasks.js";
import { ApprovalStore } from "../src/approvals.js";
import { buildServer } from "../src/server.js";

const TOKEN = "appr-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REGISTRY: Registry = {
  agents: [{
    id: "codex", name: "codex", runtime: "codex", machine: "m1",
    workspace: "/w", role: "", allowedTools: [], dangerousActions: [],
  }],
};

describe("approvals API", () => {
  let app: FastifyInstance;
  let mailbox: Mailbox;
  let tasks: TaskStore;
  let task: Task;

  beforeEach(async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-aapi-")), "t.db"));
    mailbox = new Mailbox(db);
    tasks = new TaskStore(db);
    app = await buildServer({
      mailbox, token: TOKEN, registry: REGISTRY, tasks, approvals: new ApprovalStore(db),
    });
    task = createTask({ mailbox, store: tasks, registry: REGISTRY }, {
      assignee: "codex", spec: "deploy",
    });
    tasks.updateState(task.id, "running");
  });

  function file(): Promise<Approval> {
    return app
      .inject({
        method: "POST", url: "/api/approvals", headers: AUTH,
        payload: {
          threadId: task.threadId, requestedBy: "codex",
          action: "run deploy.sh", idempotencyKey: "k1",
        },
      })
      .then((r) => {
        expect(r.statusCode).toBe(201);
        return r.json() as Approval;
      });
  }

  it("requires auth", async () => {
    expect((await app.inject({ method: "GET", url: "/api/approvals" })).statusCode).toBe(401);
  });

  it("files an approval and pauses the task", async () => {
    const a = await file();
    expect(a.state).toBe("pending");
    expect(a.taskId).toBe(task.id);
    expect(tasks.get(task.id)?.state).toBe("input-required");
  });

  it("filing twice with the same key returns the same approval", async () => {
    const first = await file();
    const second = await file();
    expect(second.id).toBe(first.id);
  });

  it("lists, filters by state, 400s bad state", async () => {
    await file();
    const all = (await app.inject({ method: "GET", url: "/api/approvals", headers: AUTH })).json() as Approval[];
    expect(all).toHaveLength(1);
    const pending = (
      await app.inject({ method: "GET", url: "/api/approvals?state=pending", headers: AUTH })
    ).json() as Approval[];
    expect(pending).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: "/api/approvals?state=bogus", headers: AUTH })).statusCode,
    ).toBe(400);
  });

  it("gets one by id, 404s unknown", async () => {
    const a = await file();
    const got = await app.inject({ method: "GET", url: `/api/approvals/${a.id}`, headers: AUTH });
    expect((got.json() as Approval).id).toBe(a.id);
    expect(
      (await app.inject({ method: "GET", url: "/api/approvals/nope", headers: AUTH })).statusCode,
    ).toBe(404);
  });

  it("decides: resumes the task; second decide 409s; unknown 404s", async () => {
    const a = await file();
    const decided = await app.inject({
      method: "POST", url: `/api/approvals/${a.id}/decide`, headers: AUTH,
      payload: { decision: "approved", note: "ship it" },
    });
    expect(decided.statusCode).toBe(200);
    expect((decided.json() as Approval).state).toBe("approved");
    expect(tasks.get(task.id)?.state).toBe("running");
    const again = await app.inject({
      method: "POST", url: `/api/approvals/${a.id}/decide`, headers: AUTH,
      payload: { decision: "denied" },
    });
    expect(again.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST", url: "/api/approvals/nope/decide", headers: AUTH,
          payload: { decision: "approved" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("503s when the store is not configured", async () => {
    const db2 = openDb(join(mkdtempSync(join(tmpdir(), "conclave-aapi2-")), "t.db"));
    const bare = await buildServer({ mailbox: new Mailbox(db2), token: TOKEN });
    expect(
      (await bare.inject({ method: "GET", url: "/api/approvals", headers: AUTH })).statusCode,
    ).toBe(503);
    await bare.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/approvals-api.test.ts`
Expected: FAIL — routes 404 / `approvals` not a known ServerOptions key (TS error).

- [ ] **Step 3: Implement**

In `packages/hub/src/server.ts`:

1. Imports: add `ApprovalStateSchema, NewApprovalSchema, ApprovalDecisionSchema` to the `@conclave/shared` import (values), `Approval` to the type import; add
   `import { AlreadyDecidedError, ApprovalStore, decideApproval, fileApproval } from "./approvals.js";` (ApprovalStore as type-only if lint requires).
2. `ServerOptions`: add `approvals?: ApprovalStore;`.
3. Routes (place after the `/api/tasks` block, mirroring its guard style):

```ts
  app.post("/api/approvals", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const body = parseOr400(NewApprovalSchema, req.body, reply);
    if (!body) return;
    const approval = fileApproval({ mailbox, store: opts.approvals, tasks: opts.tasks }, body);
    return reply.code(201).send(approval);
  });

  app.get("/api/approvals", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const q = req.query as { state?: string };
    if (q.state) {
      const state = ApprovalStateSchema.safeParse(q.state);
      if (!state.success) return reply.code(400).send({ error: "invalid state" });
      return opts.approvals.list(state.data);
    }
    return opts.approvals.list();
  });

  app.get("/api/approvals/:id", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const approval = opts.approvals.get(id);
    if (!approval) return reply.code(404).send({ error: `approval not found: ${id}` });
    return approval;
  });

  app.post("/api/approvals/:id/decide", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(ApprovalDecisionSchema, req.body, reply);
    if (!body) return;
    if (!opts.approvals.get(id)) return reply.code(404).send({ error: `approval not found: ${id}` });
    try {
      return decideApproval(
        { mailbox, store: opts.approvals, tasks: opts.tasks },
        id, body.decision, body.note,
      );
    } catch (e) {
      if (e instanceof AlreadyDecidedError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });
```

4. WS broadcast — in the `/ws` handler, alongside `onTask`/`onArtifact`:

```ts
    const onApproval = (approval: Approval): void => {
      socket.send(JSON.stringify({ type: "approval", approval }));
    };
```

register `mailbox.events.on("approval", onApproval);` with the others and `mailbox.events.off("approval", onApproval);` in the `close` handler.

In `packages/hub/src/main.ts`: `import { ApprovalStore } from "./approvals.js";`, `const approvals = new ApprovalStore(db);`, add `approvals` to the `buildServer({...})` options object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/hub`
Expected: all hub tests PASS (including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/server.ts packages/hub/src/main.ts packages/hub/test/approvals-api.test.ts
git commit -m "feat(hub): /api/approvals routes and approval WS frame"
```

---

### Task 5: Daemon HubClient methods + `request_approval` MCP tool

**Files:**
- Modify: `packages/daemon/src/hub-client.ts` (add `createApproval`, `getTask`)
- Modify: `packages/daemon/src/mcp-bridge.ts` (register `request_approval`)
- Test: `packages/daemon/test/approval-tool.test.ts`

**Interfaces:**
- Consumes: `POST /api/approvals`, `GET /api/tasks/:id` (Task 4); `Approval`, `NewApproval`, `Task` from shared.
- Produces:
  - `HubClient.createApproval(input: NewApproval): Promise<Approval>`
  - `HubClient.getTask(id: string): Promise<Task>`
  - MCP tool `request_approval({ action: string, idempotency_key?: string })` → JSON text `{state, approvalId, message}`; default key = sha256 of `` `${threadId}:${action}` ``.

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/approval-tool.test.ts` (same live-hub-over-stdio pattern as `mcp-bridge.test.ts`):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Registry } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { TaskStore, createTask } from "@conclave/hub/src/tasks.js";
import { ApprovalStore, decideApproval } from "@conclave/hub/src/approvals.js";
import { buildServer } from "@conclave/hub/src/server.js";

const TOKEN = "appr-bridge-token";
const BRIDGE = fileURLToPath(new URL("../src/mcp-bridge.ts", import.meta.url));
const REGISTRY: Registry = {
  agents: [{
    id: "codex", name: "codex", runtime: "codex", machine: "m1",
    workspace: "/w", role: "", allowedTools: [], dangerousActions: [],
  }],
};

function text(res: unknown): string {
  return (res as { content: Array<{ type: string; text: string }> }).content[0]!.text;
}

describe("request_approval MCP tool against a live hub", () => {
  let app: FastifyInstance;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await app.close();
  });

  it("files pending, is idempotent, returns the decision once decided", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-atool-")), "t.db"));
    const mailbox = new Mailbox(db);
    const tasks = new TaskStore(db);
    const approvals = new ApprovalStore(db);
    app = await buildServer({ mailbox, token: TOKEN, registry: REGISTRY, tasks, approvals });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const task = createTask({ mailbox, store: tasks, registry: REGISTRY }, {
      assignee: "codex", spec: "deploy",
    });
    tasks.updateState(task.id, "running");

    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", BRIDGE],
        env: {
          ...process.env,
          CONCLAVE_HUB_URL: `http://127.0.0.1:${port}`,
          CONCLAVE_TOKEN: TOKEN,
          CONCLAVE_THREAD_ID: task.threadId,
          CONCLAVE_AGENT_ID: "codex",
        },
      }),
    );

    const first = JSON.parse(text(await client.callTool({
      name: "request_approval", arguments: { action: "run deploy.sh" },
    }))) as { state: string; approvalId: string; message: string };
    expect(first.state).toBe("pending");
    expect(first.message).toContain("end your turn");
    expect(tasks.get(task.id)?.state).toBe("input-required");
    const msg = mailbox.listMessages(task.threadId).find((m) => m.type === "approval-request");
    expect(msg).toBeTruthy();

    // same action, no explicit key → same approval (default key is derived)
    const second = JSON.parse(text(await client.callTool({
      name: "request_approval", arguments: { action: "run deploy.sh" },
    }))) as { approvalId: string };
    expect(second.approvalId).toBe(first.approvalId);

    // once decided, a retried request returns the decision instead of pending
    decideApproval({ mailbox, store: approvals, tasks }, first.approvalId, "approved", "go");
    const third = JSON.parse(text(await client.callTool({
      name: "request_approval", arguments: { action: "run deploy.sh" },
    }))) as { state: string; note?: string };
    expect(third.state).toBe("approved");
    expect(third.note).toBe("go");
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/test/approval-tool.test.ts`
Expected: FAIL — tool `request_approval` not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/hub-client.ts` — add `Approval, NewApproval` to the type import, and two methods:

```ts
  createApproval(input: NewApproval): Promise<Approval> {
    return this.request("POST", "/api/approvals", input);
  }

  getTask(id: string): Promise<Task> {
    return this.request("GET", `/api/tasks/${id}`);
  }
```

`packages/daemon/src/mcp-bridge.ts` — add `import { createHash } from "node:crypto";` and register after `create_artifact`:

```ts
  server.registerTool(
    "request_approval",
    {
      description:
        "Request user approval before a dangerous action. If the result is pending, " +
        "end your turn — you will be resumed with the decision.",
      inputSchema: {
        action: z.string().min(1)
          .describe("What you want to do, e.g. 'run scripts/deploy.sh prod'"),
        idempotency_key: z.string().min(1).optional()
          .describe("Stable key so a retried request cannot double-file; defaults to a hash of the action"),
      },
    },
    async ({ action, idempotency_key }) => {
      try {
        const key =
          idempotency_key ?? createHash("sha256").update(`${threadId}:${action}`).digest("hex");
        const approval = await client.createApproval({
          threadId, requestedBy: agentId, action, idempotencyKey: key,
        });
        if (approval.state !== "pending") {
          return ok({
            state: approval.state,
            approvalId: approval.id,
            ...(approval.note ? { note: approval.note } : {}),
            message: `already decided: ${approval.state}${approval.note ? ` — ${approval.note}` : ""}`,
          });
        }
        return ok({
          state: "pending",
          approvalId: approval.id,
          message:
            "Approval pending. End your turn now — you will be resumed with the decision.",
        });
      } catch (e) {
        return err(e);
      }
    },
  );
```

Also update the tool-list assertion in `packages/daemon/test/mcp-bridge.test.ts:59-61` to include `"request_approval"` (sorted):

```ts
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "check_inbox", "create_artifact", "end_thread", "request_approval", "send_message", "wait_for_reply",
    ]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/test/approval-tool.test.ts packages/daemon/test/mcp-bridge.test.ts packages/daemon/test/hub-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/hub-client.ts packages/daemon/src/mcp-bridge.ts packages/daemon/test
git commit -m "feat(daemon): request_approval MCP tool + hub-client approval methods"
```

---

### Task 6: Daemon agent-loop — danger clause, pause on input-required, resume on decision

**Files:**
- Modify: `packages/daemon/src/agent-loop.ts`
- Modify: `packages/daemon/src/hub-socket.ts` (parse `approval` frame)
- Modify: `packages/daemon/src/main.ts` (wire `onApproval`)
- Modify: `packages/daemon/test/task-run.test.ts` (fakeHub gains `getTask`; existing assertions unchanged)
- Test: `packages/daemon/test/approval-resume.test.ts`

**Interfaces:**
- Consumes: `HubClient.getTask` (Task 5), `Approval`/`ApprovalSchema` from shared, `DaemonState.getSession/setSession`, `TurnQueue.run`.
- Produces:
  - `HUB_MCP_TOOLS` includes `"mcp__hub__request_approval"`
  - `buildTaskPrompt(agent, task)` appends the dangerous-actions clause; `buildTurnPrompt`/`buildDebatePrompt` append it on first turns
  - `buildApprovalResumePrompt(a: Approval): string` (exported)
  - `AgentLoop.handleApproval(a: Approval): void`
  - `HubSocketOptions.onApproval?: (a: Approval) => void`

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/approval-resume.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, Approval, Task } from "@conclave/shared";
import { AgentLoop, buildApprovalResumePrompt, buildTaskPrompt } from "../src/agent-loop.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { HubClient } from "../src/hub-client.js";
import type { RuntimeAdapter, TurnResult } from "../src/adapter.js";

const AGENT: AgentConfig = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1",
  workspace: "/tmp/ws", role: "", allowedTools: [], dangerousActions: ["deploys"],
};

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", taskId: "t1", requestedBy: "codex",
    action: "run deploy.sh", idempotencyKey: "k1", state: "approved",
    createdAt: "2026-07-14T10:00:00Z", decidedAt: "2026-07-14T10:05:00Z", ...over,
  };
}

function fakeHub(taskState: () => string) {
  const states: string[] = [];
  const hub = {
    setTaskState: vi.fn(async (_id: string, s: string) => { states.push(s); }),
    postMessage: vi.fn(async () => undefined),
    postUsage: vi.fn(async () => undefined),
    postStatus: vi.fn(async () => undefined),
    getTask: vi.fn(async (): Promise<Task> => ({
      id: "t1", threadId: "th1", assignee: "codex", spec: "deploy the app",
      state: taskState() as Task["state"], artifacts: [],
      createdAt: "2026-07-14T09:00:00Z", updatedAt: "2026-07-14T10:00:00Z",
    })),
  } as unknown as HubClient;
  return { hub, states };
}

function makeLoop(adapter: RuntimeAdapter, hub: HubClient): { loop: AgentLoop; state: DaemonState } {
  const state = new DaemonState(join(mkdtempSync(join(tmpdir(), "conclave-ares-")), "s.json"));
  const loop = new AgentLoop({
    agents: [AGENT], hub, adapters: { codex: adapter }, state,
    queue: new TurnQueue(), hubUrl: "http://h", token: "t", allowAgentTriggers: false,
    bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
  });
  return { loop, state };
}

describe("approval resume", () => {
  it("resumes the stored session with the decision prompt and finishes the task", async () => {
    const result: TurnResult = { sessionId: "s1", text: "deployed", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async () => result);
    const { hub, states } = fakeHub(() => "running");
    const { loop, state } = makeLoop({ runTurn }, hub);
    state.setSession("th1", "codex", "s1");

    loop.handleApproval(approval());
    await loop.idle();

    expect(runTurn).toHaveBeenCalledOnce();
    const opts = runTurn.mock.calls[0]![0] as { prompt: string; sessionId?: string };
    expect(opts.sessionId).toBe("s1");
    expect(opts.prompt).toContain("was approved");
    expect(opts.prompt).toContain("run deploy.sh");
    expect(states).toEqual(["done"]);
  });

  it("includes the note on denial and still resumes", async () => {
    const result: TurnResult = { sessionId: "s1", text: "ok, skipped", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async () => result);
    const { hub } = fakeHub(() => "running");
    const { loop, state } = makeLoop({ runTurn }, hub);
    state.setSession("th1", "codex", "s1");
    loop.handleApproval(approval({ state: "denied", note: "not in prod" }));
    await loop.idle();
    const opts = runTurn.mock.calls[0]![0] as { prompt: string };
    expect(opts.prompt).toContain("was denied: not in prod");
  });

  it("falls back to full task prompt when no session is stored", async () => {
    const result: TurnResult = { sessionId: "s2", text: "done", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async () => result);
    const { hub } = fakeHub(() => "running");
    const { loop } = makeLoop({ runTurn }, hub);
    loop.handleApproval(approval());
    await loop.idle();
    const opts = runTurn.mock.calls[0]![0] as { prompt: string; sessionId?: string };
    expect(opts.sessionId).toBeUndefined();
    expect(opts.prompt).toContain("deploy the app"); // task spec included
    expect(opts.prompt).toContain("was approved");
  });

  it("ignores pending, task-less, duplicate, and foreign approvals", async () => {
    const runTurn = vi.fn();
    const { hub } = fakeHub(() => "running");
    const { loop } = makeLoop({ runTurn }, hub);
    loop.handleApproval(approval({ state: "pending" }));
    loop.handleApproval(approval({ id: "a2", taskId: undefined }));
    loop.handleApproval(approval({ id: "a3", requestedBy: "someone-else" }));
    loop.handleApproval(approval());
    loop.handleApproval(approval()); // duplicate id a1
    await loop.idle();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("skips resume when the task is no longer running", async () => {
    const runTurn = vi.fn();
    const { hub } = fakeHub(() => "done");
    const { loop } = makeLoop({ runTurn }, hub);
    loop.handleApproval(approval());
    await loop.idle();
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("dangerous-actions prompt clause", () => {
  it("buildTaskPrompt lists dangerousActions and names request_approval", () => {
    const p = buildTaskPrompt(AGENT, {
      id: "t1", threadId: "th1", assignee: "codex", spec: "deploy", state: "queued",
      artifacts: [], createdAt: "2026-07-14T09:00:00Z", updatedAt: "2026-07-14T09:00:00Z",
    });
    expect(p).toContain("request_approval");
    expect(p).toContain("deploys");
  });

  it("buildApprovalResumePrompt renders both decisions", () => {
    expect(buildApprovalResumePrompt(approval())).toContain('was approved');
    expect(buildApprovalResumePrompt(approval({ state: "denied", note: "no" }))).toContain("was denied: no");
  });
});
```

Also extend `packages/daemon/test/task-run.test.ts`:

1. `fakeHub()` gains a `getTask` mock (default: state `"running"`) so the new completion check works — add to the `hub` object:

```ts
    getTask: vi.fn(async () => task({ state: "running" })),
```

2. New test — task pauses instead of completing when the hub says `input-required`:

```ts
  it("leaves the task paused when an approval flipped it to input-required", async () => {
    const result: TurnResult = { sessionId: "s", text: "requested approval", isError: false, costUsd: 0 };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, states } = fakeHub();
    (hub.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(task({ state: "input-required" }));
    const loop = loopWith(adapter, hub);
    loop.handleTask(task());
    await loop.idle();
    expect(states).toEqual(["running"]); // no done/failed
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/daemon/test/approval-resume.test.ts packages/daemon/test/task-run.test.ts`
Expected: FAIL — `buildApprovalResumePrompt`/`handleApproval` missing.

- [ ] **Step 3: Implement in `packages/daemon/src/agent-loop.ts`**

1. Import `Approval` type from shared. Add `"mcp__hub__request_approval"` to `HUB_MCP_TOOLS`.
2. Danger clause helper + prompt updates:

```ts
function dangerClause(agent: AgentConfig): string {
  if (agent.dangerousActions.length === 0) return "";
  return (
    `\n\nDANGEROUS ACTIONS — before doing any of the following you MUST call the ` +
    `request_approval tool and then end your turn to wait for the decision: ` +
    `${agent.dangerousActions.join("; ")}.`
  );
}
```

- `buildTaskPrompt`: append `${dangerClause(agent)}` at the end of the returned string.
- `buildTurnPrompt` and `buildDebatePrompt`: append `${dangerClause(agent)}` to the first-turn variant only (the branch that includes the role preamble).

3. Resume prompt:

```ts
export function buildApprovalResumePrompt(a: Approval): string {
  const note = a.note ? `: ${a.note}` : "";
  return (
    `Your approval request "${a.action}" was ${a.state}${note}. ` +
    `Continue the task accordingly; if denied, adapt or wrap up and report what you did.`
  );
}
```

4. Refactor `runTask` completion into shared helpers and persist the session id. Replace the body of `runTask` after the adapter turn, and add two private methods:

```ts
  private async runTask(agent: AgentConfig, task: Task): Promise<void> {
    const { hub } = this.opts;
    try {
      await hub.setTaskState(task.id, "running");
      await this.reportStatus(agent, "running", `task ${task.id}`, task.threadId);
      const adapter = this.opts.adapters[agent.runtime];
      if (!adapter) throw new Error(`no adapter for runtime ${agent.runtime}`);
      const result = await adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildTaskPrompt(agent, task),
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(task.threadId, agent.id),
      });
      if (result.sessionId) this.opts.state.setSession(task.threadId, agent.id, result.sessionId);
      await this.finishTaskTurn(agent, task.id, task.threadId, result);
    } catch (e) {
      await this.failTask(agent, task.id, task.threadId, e);
    }
  }

  // Shared completion for task turns (initial and approval-resumed): report,
  // post the result, then either pause (a pending approval flipped the task to
  // input-required), finish, or leave an already-finished task alone.
  private async finishTaskTurn(
    agent: AgentConfig,
    taskId: string,
    threadId: string,
    result: TurnResult,
  ): Promise<void> {
    const { hub } = this.opts;
    await this.reportTurn(agent, threadId, result);
    await this.reportTurnStatus(agent, threadId, result);
    if (result.isError) {
      await hub.setTaskState(taskId, "failed");
      return;
    }
    if (result.text.trim()) {
      await hub.postMessage(threadId, {
        from: agent.id, to: [], type: "text", body: result.text, artifacts: [],
      });
    }
    const current = await hub.getTask(taskId);
    if (current.state === "input-required") {
      await this.reportStatus(agent, "blocked", "awaiting approval", threadId);
      return;
    }
    if (current.state === "running") await hub.setTaskState(taskId, "done");
  }

  private async failTask(agent: AgentConfig, taskId: string, threadId: string, e: unknown): Promise<void> {
    await this.postFailure(agent, threadId, e);
    await this.reportStatus(agent, "idle", "", threadId);
    try {
      await this.opts.hub.setTaskState(taskId, "failed");
    } catch (stateErr) {
      console.error(
        `agent ${agent.id}: failed to mark task ${taskId} failed:`,
        stateErr instanceof Error ? stateErr.message : stateErr,
      );
    }
  }
```

5. Approval handling (new field + methods on `AgentLoop`):

```ts
  private readonly handledApprovals = new Set<string>();

  handleApproval(approval: Approval): void {
    if (approval.state === "pending" || !approval.taskId) return;
    if (this.handledApprovals.has(approval.id)) return;
    const agent = this.opts.agents.find((a) => a.id === approval.requestedBy);
    if (!agent) return;
    this.handledApprovals.add(approval.id);
    const work = this.opts.queue
      .run(agent.id, () => this.resumeAfterApproval(agent, approval))
      .catch(() => undefined);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async resumeAfterApproval(agent: AgentConfig, approval: Approval): Promise<void> {
    const { hub, state } = this.opts;
    const taskId = approval.taskId!;
    const threadId = approval.threadId;
    try {
      // The hub flips input-required → running on decide; anything else means
      // the task already finished (or another turn owns it) — do not resume.
      const task = await hub.getTask(taskId);
      if (task.state !== "running") return;
      await this.reportStatus(agent, "running", `task ${taskId}`, threadId);
      const adapter = this.opts.adapters[agent.runtime];
      if (!adapter) throw new Error(`no adapter for runtime ${agent.runtime}`);
      const sessionId = state.getSession(threadId, agent.id);
      const prompt = sessionId
        ? buildApprovalResumePrompt(approval)
        : `${buildTaskPrompt(agent, task)}\n\n${buildApprovalResumePrompt(approval)}`;
      const result = await adapter.runTurn({
        cwd: agent.workspace,
        prompt,
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(threadId, agent.id),
      });
      if (result.sessionId) state.setSession(threadId, agent.id, result.sessionId);
      await this.finishTaskTurn(agent, taskId, threadId, result);
    } catch (e) {
      await this.failTask(agent, taskId, threadId, e);
    }
  }
```

6. `packages/daemon/src/hub-socket.ts`: import `ApprovalSchema, type Approval` from shared; add `onApproval?: (a: Approval) => void;` to `HubSocketOptions`; in `handleData` after the `task` branch:

```ts
        if (candidate.type === "approval" && this.opts.onApproval) {
          const parsedApproval = ApprovalSchema.safeParse((candidate as { approval?: unknown }).approval);
          if (parsedApproval.success) this.opts.onApproval(parsedApproval.data);
          return;
        }
```

7. `packages/daemon/src/main.ts`: in the `HubSocket` options add:

```ts
    onApproval: (a) => {
      loop.handleApproval(a);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon`
Expected: all daemon tests PASS (including pre-existing task-run/agent-loop/debate tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src packages/daemon/test
git commit -m "feat(daemon): pause tasks on approval, resume session with the decision"
```

---

### Task 7: Web plumbing — hubClient, socket frame, store, sync

**Files:**
- Modify: `packages/web/src/lib/hubClient.ts` (add `listApprovals`, `decideApproval`)
- Modify: `packages/web/src/lib/socket.ts` (add `approval` to `WsFrame`)
- Modify: `packages/web/src/store/useConclaveStore.ts` (`approvalsById`, `setApprovals`, frame case)
- Modify: `packages/web/src/store/sync.ts` (hydrate approvals)
- Test: `packages/web/src/store/__tests__/approval-store.test.ts`

**Interfaces:**
- Consumes: `Approval` from `@conclave/shared`; `GET /api/approvals`, `POST /api/approvals/:id/decide` (Task 4).
- Produces:
  - `hubClient.listApprovals(): Promise<Approval[]>`
  - `hubClient.decideApproval(id: string, decision: "approved" | "denied", note?: string): Promise<Approval>`
  - store: `approvalsById: Record<string, Approval>`, `setApprovals(a: Approval[]): void`, `applyFrame` handles `{type: "approval", approval}`

- [ ] **Step 1: Write the failing test**

`packages/web/src/store/__tests__/approval-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "@conclave/shared";
import { useConclaveStore } from "../useConclaveStore.js";

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", taskId: "t1", requestedBy: "codex",
    action: "run deploy.sh", idempotencyKey: "k1", state: "pending",
    createdAt: "2026-07-14T10:00:00Z", ...over,
  };
}

describe("approval store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("setApprovals indexes by id", () => {
    useConclaveStore.getState().setApprovals([approval(), approval({ id: "a2" })]);
    expect(Object.keys(useConclaveStore.getState().approvalsById).sort()).toEqual(["a1", "a2"]);
  });

  it("approval frames upsert (pending then decided)", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "approval", approval: approval() });
    expect(useConclaveStore.getState().approvalsById["a1"]?.state).toBe("pending");
    applyFrame({ type: "approval", approval: approval({ state: "approved", note: "go" }) });
    const got = useConclaveStore.getState().approvalsById["a1"];
    expect(got?.state).toBe("approved");
    expect(got?.note).toBe("go");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/approval-store.test.ts`
Expected: FAIL — `setApprovals` undefined / frame type error.

- [ ] **Step 3: Implement**

`packages/web/src/lib/socket.ts` — add `Approval` to the shared type import and a variant to `WsFrame`:

```ts
  | { type: "approval"; approval: Approval }
```

`packages/web/src/lib/hubClient.ts` — add `Approval` to the type import and two entries to the `hubClient` object:

```ts
  listApprovals: () => req<Approval[]>("GET", "/api/approvals"),
  decideApproval: (id: string, decision: "approved" | "denied", note?: string) =>
    req<Approval>("POST", `/api/approvals/${id}/decide`, { decision, ...(note ? { note } : {}) }),
```

`packages/web/src/store/useConclaveStore.ts`:
- Import type `Approval`; add to `State`: `approvalsById: Record<string, Approval>;` and `setApprovals(a: Approval[]): void;`
- Add to `initial`: `approvalsById: {} as Record<string, Approval>,`
- Implement: `setApprovals: (list) => set({ approvalsById: Object.fromEntries(list.map((a) => [a.id, a])) }),`
- `applyFrame` switch, after `"workspace"`:

```ts
        case "approval":
          return { approvalsById: { ...s.approvalsById, [f.approval.id]: f.approval } };
```

`packages/web/src/store/sync.ts` — in `hydrate()`, after the workspaces block:

```ts
    const approvals = await hubClient.listApprovals().catch(() => []);
    store.setApprovals(approvals);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/approval-store.test.ts src/store/__tests__/store.test.ts`
Expected: PASS. Also `npx pnpm --filter @conclave/web typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib packages/web/src/store
git commit -m "feat(web): approval frame, store slice, and hub-client methods"
```

---

### Task 8: Web UI — ApprovalCard, toolbar indicator, sidebar badge

**Files:**
- Create: `packages/web/src/components/ApprovalCard.tsx`, `packages/web/src/components/ApprovalCard.module.css`
- Modify: `packages/web/src/components/ChatMessage.tsx` (route `approval-request` to the card)
- Modify: `packages/web/src/components/ContextToolbar.tsx` (pending indicator)
- Modify: `packages/web/src/components/Sidebar.tsx` + `Sidebar.module.css` (thread badge)
- Test: `packages/web/src/__tests__/approval-card.test.tsx`

**Interfaces:**
- Consumes: store `approvalsById` + `hubClient.decideApproval` (Task 7); message body JSON `{approvalId, action}` (Task 3).
- Produces: `ApprovalCard({ message }: { message: Message }): JSX.Element` — testids `approval-card`, `approval-approve`, `approval-deny`, `approval-note`, `approval-state`; toolbar testid `approval-indicator`; sidebar testid `approval-badge`.

- [ ] **Step 1: Write the failing test**

`packages/web/src/__tests__/approval-card.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Approval, Message } from "@conclave/shared";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { ChatMessage } from "../components/ChatMessage.js";

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", taskId: "t1", requestedBy: "codex",
    action: "run deploy.sh", idempotencyKey: "k1", state: "pending",
    createdAt: "2026-07-14T10:00:00Z", ...over,
  };
}

function requestMessage(): Message {
  return {
    id: 1, threadId: "th1", from: "codex", to: [], type: "approval-request",
    body: JSON.stringify({ approvalId: "a1", action: "run deploy.sh" }),
    artifacts: [], ts: "2026-07-14T10:00:00Z",
  };
}

describe("ApprovalCard", () => {
  beforeEach(() => {
    cleanup();
    useConclaveStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("renders a pending card with action, chip, and decide buttons", () => {
    useConclaveStore.getState().setApprovals([approval()]);
    render(<ChatMessage message={requestMessage()} />);
    expect(screen.getByTestId("approval-card")).toBeTruthy();
    expect(screen.getByText("run deploy.sh")).toBeTruthy();
    expect(screen.getByTestId("approval-state").textContent).toBe("PENDING");
    expect(screen.getByTestId("approval-approve")).toBeTruthy();
    expect(screen.getByTestId("approval-deny")).toBeTruthy();
  });

  it("renders a decided card without buttons, with the note", () => {
    useConclaveStore.getState().setApprovals([approval({ state: "denied", note: "not in prod" })]);
    render(<ChatMessage message={requestMessage()} />);
    expect(screen.getByTestId("approval-state").textContent).toBe("DENIED");
    expect(screen.queryByTestId("approval-approve")).toBeNull();
    expect(screen.getByText(/not in prod/)).toBeTruthy();
  });

  it("clicking approve posts the decision with the note", () => {
    useConclaveStore.getState().setApprovals([approval()]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(approval({ state: "approved" })), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatMessage message={requestMessage()} />);
    fireEvent.change(screen.getByTestId("approval-note"), { target: { value: "ship it" } });
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/a1/decide",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approved", note: "ship it" }) }),
    );
  });

  it("card without a store approval renders pending without buttons", () => {
    render(<ChatMessage message={requestMessage()} />);
    expect(screen.getByTestId("approval-state").textContent).toBe("PENDING");
    expect(screen.queryByTestId("approval-approve")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/__tests__/approval-card.test.tsx`
Expected: FAIL — approval-request renders as a normal message (no `approval-card` testid).

- [ ] **Step 3: Implement**

`packages/web/src/components/ApprovalCard.tsx`:

```tsx
import { useState } from "react";
import type { Message } from "@conclave/shared";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./ApprovalCard.module.css";

function parseBody(body: string): { approvalId: string; action: string } {
  try {
    const parsed = JSON.parse(body) as { approvalId?: string; action?: string };
    return { approvalId: parsed.approvalId ?? "", action: parsed.action ?? body };
  } catch {
    return { approvalId: "", action: body };
  }
}

export function ApprovalCard({ message }: { message: Message }): JSX.Element {
  const { approvalId, action } = parseBody(message.body);
  const approval = useConclaveStore((s) => (approvalId ? s.approvalsById[approvalId] : undefined));
  const [note, setNote] = useState("");
  const state = approval?.state ?? "pending";
  const canDecide = approval?.state === "pending";

  const decide = (decision: "approved" | "denied"): void => {
    if (!approval) return;
    void hubClient.decideApproval(approval.id, decision, note.trim() || undefined).catch(() => undefined);
  };

  return (
    <div className={styles.card} data-testid="approval-card">
      <div className={styles.header}>
        <span className={styles.title}>approval requested by {message.from}</span>
        <span className={styles.chip} data-state={state} data-testid="approval-state">
          {state.toUpperCase()}
        </span>
      </div>
      <div className={styles.action}>{action}</div>
      {approval?.note && <div className={styles.note}>note: {approval.note}</div>}
      {canDecide && (
        <div className={styles.controls}>
          <input
            className={styles.noteInput}
            data-testid="approval-note"
            placeholder="optional note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className={styles.approve} data-testid="approval-approve" onClick={() => decide("approved")}>
            Approve
          </button>
          <button className={styles.deny} data-testid="approval-deny" onClick={() => decide("denied")}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
```

`packages/web/src/components/ApprovalCard.module.css` (monochrome, theme tokens only):

```css
.card {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--text-primary);
  background: var(--chip);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.title {
  color: var(--text-muted);
  font-size: 11px;
  text-transform: lowercase;
}
.chip {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
}
.chip[data-state="pending"] {
  font-weight: 700;
}
.action {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-body);
}
.note {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.controls {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.noteInput {
  flex: 1;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-body);
  font-size: 11px;
  padding: 3px 6px;
}
.approve,
.deny {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text-primary);
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
}
.approve {
  font-weight: 700;
}
```

`packages/web/src/components/ChatMessage.tsx` — import the card and route the type before the `status` branch:

```tsx
import { ApprovalCard } from "./ApprovalCard.js";
```

```tsx
  if (message.type === "approval-request") {
    return <ApprovalCard message={message} />;
  }
```

`packages/web/src/components/ContextToolbar.tsx` — add below the `tasksById` selector:

```tsx
  const approvalsById = useConclaveStore((s) => s.approvalsById);
  const pendingApprovals = Object.values(approvalsById).filter(
    (a) => a.threadId === activeId && a.state === "pending",
  ).length;
```

and render after the task/state span (inside the toolbar div):

```tsx
      {pendingApprovals > 0 && (
        <span className={styles.state} data-testid="approval-indicator">
          ⚠ {pendingApprovals} approval{pendingApprovals > 1 ? "s" : ""} waiting
        </span>
      )}
```

`packages/web/src/components/Sidebar.tsx` — add selector:

```tsx
  const approvalsById = useConclaveStore((s) => s.approvalsById);
```

before the return, compute:

```tsx
  const pendingApprovalThreads = new Set(
    Object.values(approvalsById)
      .filter((a) => a.state === "pending")
      .map((a) => a.threadId),
  );
```

and inside the chat-row button, after the `rowLabel` span:

```tsx
              {pendingApprovalThreads.has(t.id) && (
                <span className={styles.approvalBadge} data-testid="approval-badge">!</span>
              )}
```

`packages/web/src/components/Sidebar.module.css` — append:

```css
.approvalBadge {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
  padding: 0 5px;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/__tests__/approval-card.test.tsx && npx pnpm --filter @conclave/web typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Run the full suites (backgrounded web suite)**

```bash
npx vitest run 2>&1 | tail -4
npx pnpm --filter @conclave/web exec vitest run > /tmp/claude-1000/-home-nyx-ai-Projects-Conclave/d72ac626-53b6-4068-a137-1681ebdb5c73/scratchpad/web-tests.log 2>&1 &
# wait ~60s, then:
grep -E "Test Files|Tests " /tmp/claude-1000/-home-nyx-ai-Projects-Conclave/d72ac626-53b6-4068-a137-1681ebdb5c73/scratchpad/web-tests.log
```

Expected: root suite all green; web suite summary all green (the process may hang after the summary — kill it, that's a known teardown quirk).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): approval card with approve/deny, toolbar indicator, sidebar badge"
```

---

## Known limitation (documented, deliberate)

If the daemon is offline when a decision lands, the `approval` WS frame is missed and the task stays `running` without a live turn — there is deliberately **no approval catch-up on reconnect**, because re-resuming after a restart could double-execute an approved action (the in-memory `handledApprovals` dedupe does not survive restarts). Surface this in the docs if it bites; the safe fix later is persisting handled-approval ids in `DaemonState`.
