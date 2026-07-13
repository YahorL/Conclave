# Delegation Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/task @agent <spec>` delegates a tracked unit of work to a registry agent; the assignee's daemon runs it in the agent's workspace and streams state (queued→running→done/failed) plus the final result into a dedicated task thread the web app renders.

**Architecture:** A new `Task` record + hub state machine on top of the existing turn machinery. Creation goes hub → `task`-kind thread + `queued` Task + `{type:"task"}` WS frame; the assignee's daemon picks it up (live frame or persisted-task catch-up on reconnect), runs `adapter.runTurn` in the agent workspace via the existing per-agent `TurnQueue`, posts the result, and reports state transitions. Reuses `runTurn`, `reportTurn`, `reportStatus`, `TurnQueue`, and the web chat.

**Tech Stack:** Existing Fastify hub (better-sqlite3, Zod), the daemon (`HubSocket`/`AgentLoop`/`HubClient`), `@conclave/web` (React + Zustand). Vitest throughout.

## Global Constraints

- **TypeScript everywhere**, ESM. Run pnpm as `npx pnpm ...` (not on PATH).
- **Test invocation:** backend (shared/hub/daemon) tests run from **repo root** — `npx vitest run <path>` (the root `vitest.config.ts` include is `packages/*/test/**`; `--filter pkg exec vitest` finds no config from a package cwd). Web tests use the web package's own config — `npx pnpm --filter @conclave/web exec vitest run`. Typecheck: per-package `npx pnpm --filter <pkg> typecheck`, or all via `npx pnpm -r typecheck`.
- **Zod v4**; export schema + inferred type. Shared types imported with `.js` specifiers.
- **Auth:** every hub route except `/health` needs `Authorization: Bearer <token>` or `?token=`.
- **Commit trailer:** end every commit message with `Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue`.
- Commit after every green step. TDD: failing test first.

## File Structure

**shared:** `packages/shared/src/orchestration.ts` (add Task schemas), re-exported already via index.
**hub:** `packages/hub/src/db.ts` (tasks table), `packages/hub/src/tasks.ts` (create — `TaskStore` + `createTask` + errors), `packages/hub/src/mailbox.ts` (emit `thread` on create), `packages/hub/src/server.ts` (routes + `task` WS frame), `packages/hub/src/main.ts` (pass `TaskStore`).
**daemon:** `packages/daemon/src/hub-client.ts` (`listTasks`, `setTaskState`), `packages/daemon/src/hub-socket.ts` (`onTask`), `packages/daemon/src/agent-loop.ts` (`handleTask`/`runTask`/`buildTaskPrompt`/`runTaskCatchUp`), `packages/daemon/src/main.ts` (wire).
**web:** `packages/web/src/lib/hubClient.ts` (`createTask`/`getTask`/`listTasks`), `packages/web/src/lib/socket.ts` (`task` frame), `packages/web/src/store/useConclaveStore.ts` (`tasksById`), `packages/web/src/components/Composer.tsx` (`/task`), `packages/web/src/components/ContextToolbar.tsx` (task state).

---

## Task 1: Shared Task schemas

**Files:**
- Modify: `packages/shared/src/orchestration.ts`
- Test: `packages/shared/test/task.test.ts`

**Interfaces:**
- Produces: `TaskStateSchema` = enum `queued|running|input-required|done|failed`; `TaskSchema` = `{ id, threadId, assignee, spec, state, artifacts: string[], createdAt, updatedAt }`; `NewTaskSchema` = `{ assignee, spec, workspace? }`; types `TaskState`, `Task`, `NewTask`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/task.test.ts
import { describe, expect, it } from "vitest";
import { NewTaskSchema, TaskSchema } from "../src/orchestration.js";

describe("task schemas", () => {
  it("accepts a new task and defaults artifacts on a full task", () => {
    expect(NewTaskSchema.parse({ assignee: "codex", spec: "add tests" }).assignee).toBe("codex");
    const t = TaskSchema.parse({
      id: "t1", threadId: "th1", assignee: "codex", spec: "x", state: "queued",
      artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
    });
    expect(t.state).toBe("queued");
  });

  it("rejects an unknown state", () => {
    expect(() =>
      TaskSchema.parse({
        id: "t1", threadId: "th1", assignee: "c", spec: "x", state: "nope",
        artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/task.test.ts`
Expected: FAIL — `NewTaskSchema`/`TaskSchema` not exported.

- [ ] **Step 3: Add the schemas**

Append to `packages/shared/src/orchestration.ts`:
```ts
export const TaskStateSchema = z.enum([
  "queued",
  "running",
  "input-required",
  "done",
  "failed",
]);

export const TaskSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  assignee: z.string().min(1),
  spec: z.string().min(1),
  state: TaskStateSchema,
  artifacts: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const NewTaskSchema = z.object({
  assignee: z.string().min(1),
  spec: z.string().min(1),
  workspace: z.string().optional(),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type NewTask = z.infer<typeof NewTaskSchema>;
```
(`orchestration.ts` already imports `z` and is re-exported by `src/index.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/test/task.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx pnpm --filter @conclave/shared typecheck
git add packages/shared/src/orchestration.ts packages/shared/test/task.test.ts
git commit -m "feat(shared): task schemas for delegation

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 2: Hub tasks table + TaskStore with transition guard

**Files:**
- Modify: `packages/hub/src/db.ts` (add `tasks` table)
- Create: `packages/hub/src/tasks.ts` (`TaskStore`, `InvalidTransitionError`)
- Test: `packages/hub/test/tasks-store.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskState` (Task 1).
- Produces:
  - `class InvalidTransitionError extends Error`.
  - `class TaskStore { create(task: Task): Task; get(id): Task | undefined; list(): Task[]; listByAssigneeState(assignee: string, state: TaskState): Task[]; updateState(id: string, state: TaskState): Task }` — `updateState` enforces allowed transitions (`queued→running`, `running→done`, `running→failed`, `queued→failed`), stamps `updatedAt`, throws `InvalidTransitionError` on illegal transitions and a plain `Error` if the task is missing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/test/tasks-store.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Task } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { InvalidTransitionError, TaskStore } from "../src/tasks.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "conclave-tasks-"));
  return openDb(join(dir, "t.db"));
}

function seed(store: TaskStore, over: Partial<Task> = {}): Task {
  return store.create({
    id: "t1", threadId: "th1", assignee: "codex", spec: "do x", state: "queued",
    artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z", ...over,
  });
}

describe("TaskStore", () => {
  it("creates, gets, and filters by assignee+state", () => {
    const store = new TaskStore(freshDb());
    seed(store);
    seed(store, { id: "t2", assignee: "claude-code" });
    expect(store.get("t1")?.assignee).toBe("codex");
    expect(store.listByAssigneeState("codex", "queued").map((t) => t.id)).toEqual(["t1"]);
    expect(store.listByAssigneeState("codex", "running")).toEqual([]);
  });

  it("allows queued->running->done and bumps updatedAt", () => {
    const store = new TaskStore(freshDb());
    seed(store);
    store.updateState("t1", "running");
    const done = store.updateState("t1", "done");
    expect(done.state).toBe("done");
    expect(done.updatedAt).not.toBe("2026-07-13T10:00:00Z");
  });

  it("rejects an illegal transition", () => {
    const store = new TaskStore(freshDb());
    seed(store);
    expect(() => store.updateState("t1", "done")).toThrow(InvalidTransitionError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/tasks-store.test.ts`
Expected: FAIL — cannot resolve `../src/tasks.js`.

- [ ] **Step 3: Add the tasks table**

In `packages/hub/src/db.ts`, inside the `migrate` `db.exec(\`...\`)` block, append after the `usage` table:
```sql
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL REFERENCES threads(id),
      assignee   TEXT NOT NULL,
      spec       TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'queued',
      artifacts  TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_state ON tasks(assignee, state);
```

- [ ] **Step 4: Implement TaskStore**

```ts
// packages/hub/src/tasks.ts
import type Database from "better-sqlite3";
import type { Task, TaskState } from "@conclave/shared";

export class InvalidTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`invalid task transition: ${from} -> ${to}`);
  }
}

const ALLOWED: Record<TaskState, TaskState[]> = {
  queued: ["running", "failed"],
  running: ["done", "failed"],
  "input-required": ["running", "failed"],
  done: [],
  failed: [],
};

interface TaskRow {
  id: string;
  thread_id: string;
  assignee: string;
  spec: string;
  state: string;
  artifacts: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    threadId: r.thread_id,
    assignee: r.assignee,
    spec: r.spec,
    state: r.state as TaskState,
    artifacts: JSON.parse(r.artifacts) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class TaskStore {
  constructor(private readonly db: Database.Database) {}

  create(task: Task): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, thread_id, assignee, spec, state, artifacts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id, task.threadId, task.assignee, task.spec, task.state,
        JSON.stringify(task.artifacts), task.createdAt, task.updatedAt,
      );
    return task;
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as TaskRow[]).map(
      rowToTask,
    );
  }

  listByAssigneeState(assignee: string, state: TaskState): Task[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE assignee = ? AND state = ? ORDER BY created_at ASC")
        .all(assignee, state) as TaskRow[]
    ).map(rowToTask);
  }

  updateState(id: string, state: TaskState): Task {
    const current = this.get(id);
    if (!current) throw new Error(`task not found: ${id}`);
    if (!ALLOWED[current.state].includes(state)) {
      throw new InvalidTransitionError(current.state, state);
    }
    const updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(state, updatedAt, id);
    return { ...current, state, updatedAt };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/tasks-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx pnpm --filter @conclave/hub typecheck
git add packages/hub/src/db.ts packages/hub/src/tasks.ts packages/hub/test/tasks-store.test.ts
git commit -m "feat(hub): tasks table and TaskStore with transition guard

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 3: createTask service + createThread thread-event

**Files:**
- Modify: `packages/hub/src/mailbox.ts` (emit `thread` on create)
- Modify: `packages/hub/src/tasks.ts` (add `createTask`, `UnknownAssigneeError`)
- Test: `packages/hub/test/create-task.test.ts`

**Interfaces:**
- Consumes: `Mailbox` (emits `message`/`thread`/`task` on `.events`), `TaskStore`, `Registry`, `NewTask`.
- Produces:
  - `class UnknownAssigneeError extends Error`.
  - `createTask(deps: { mailbox: Mailbox; store: TaskStore; registry: Registry }, input: NewTask): Task` — resolves assignee in registry (throws `UnknownAssigneeError`), creates a `task` thread `participants: [assignee, "you"]`, inserts a `queued` Task, appends the spec message `from:"you", to:[]`, emits `mailbox.events.emit("task", task)`, returns the Task.
  - `Mailbox.createThread` now emits `this.events.emit("thread", thread)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/test/create-task.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Registry, Task } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { TaskStore, UnknownAssigneeError, createTask } from "../src/tasks.js";

const REGISTRY: Registry = {
  agents: [{ id: "codex", name: "codex", runtime: "codex", machine: "m", workspace: "/w", role: "", allowedTools: [] }],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "conclave-ct-"));
  const db = openDb(join(dir, "t.db"));
  const mailbox = new Mailbox(db);
  const store = new TaskStore(db);
  return { mailbox, store };
}

describe("createTask", () => {
  it("creates a task thread with a non-triggering spec message and emits a task event", () => {
    const { mailbox, store } = setup();
    const taskEvents: Task[] = [];
    mailbox.events.on("task", (t: Task) => taskEvents.push(t));

    const task = createTask({ mailbox, store, registry: REGISTRY }, { assignee: "codex", spec: "add tests" });

    expect(task.state).toBe("queued");
    const thread = mailbox.getThread(task.threadId);
    expect(thread?.kind).toBe("task");
    expect(thread?.participants).toEqual(["codex", "you"]);
    const msgs = mailbox.listMessages(task.threadId);
    expect(msgs[0]).toMatchObject({ from: "you", to: [], body: "add tests" });
    expect(taskEvents).toHaveLength(1);
  });

  it("rejects an unknown assignee", () => {
    const { mailbox, store } = setup();
    expect(() => createTask({ mailbox, store, registry: REGISTRY }, { assignee: "ghost", spec: "x" })).toThrow(
      UnknownAssigneeError,
    );
  });

  it("createThread emits a thread event", () => {
    const { mailbox } = setup();
    const seen = vi.fn();
    mailbox.events.on("thread", seen);
    mailbox.createThread({ kind: "chat", participants: ["you"] });
    expect(seen).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/create-task.test.ts`
Expected: FAIL — `createTask`/`UnknownAssigneeError` not exported; no `thread` event.

- [ ] **Step 3: Emit thread event on create**

In `packages/hub/src/mailbox.ts`, at the end of `createThread`, before `return thread;`:
```ts
    this.events.emit("thread", thread);
```

- [ ] **Step 4: Implement createTask**

Append to `packages/hub/src/tasks.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { NewTask, Registry } from "@conclave/shared";
import type { Mailbox } from "./mailbox.js";

export class UnknownAssigneeError extends Error {
  constructor(assignee: string) {
    super(`unknown assignee: ${assignee}`);
  }
}

export function createTask(
  deps: { mailbox: Mailbox; store: TaskStore; registry: Registry },
  input: NewTask,
): Task {
  const agent = deps.registry.agents.find((a) => a.id === input.assignee);
  if (!agent) throw new UnknownAssigneeError(input.assignee);

  const thread = deps.mailbox.createThread({
    kind: "task",
    participants: [input.assignee, "you"],
    workspace: input.workspace,
  });
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    threadId: thread.id,
    assignee: input.assignee,
    spec: input.spec,
    state: "queued",
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  deps.store.create(task);
  // to:[] — the task frame is the sole execution trigger; this message is a visible record.
  deps.mailbox.appendMessage(thread.id, {
    from: "you", to: [], type: "text", body: input.spec, artifacts: [],
  });
  deps.mailbox.events.emit("task", task);
  return task;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/create-task.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck, run full hub suite (thread-event change), commit**

```bash
npx pnpm --filter @conclave/hub typecheck
npx vitest run packages/hub
git add packages/hub/src/mailbox.ts packages/hub/src/tasks.ts packages/hub/test/create-task.test.ts
git commit -m "feat(hub): createTask service; createThread broadcasts thread event

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 4: Hub task routes + WS task frame

**Files:**
- Modify: `packages/hub/src/server.ts` (`ServerOptions.tasks`, routes, `task` WS frame, error mapping)
- Modify: `packages/hub/src/main.ts` (construct `TaskStore`, pass it)
- Test: `packages/hub/test/tasks-api.test.ts`

**Interfaces:**
- Consumes: `TaskStore`, `createTask`, `InvalidTransitionError`, `UnknownAssigneeError`; `NewTaskSchema`, `TaskStateSchema`.
- Produces:
  - `ServerOptions.tasks?: TaskStore`.
  - `POST /api/tasks` (body `NewTaskSchema`) → 201 Task | 400 unknown assignee | 503 no store.
  - `GET /api/tasks` (optional `?assignee=&state=`) → Task[].
  - `GET /api/tasks/:id` → Task | 404.
  - `POST /api/tasks/:id/state` (body `{ state }`) → 200 Task | 409 invalid transition | 404 | 503.
  - `/ws` frame `{ type: "task", task }` on the `mailbox.events` `"task"` event; `POST /state` emits `"task"` after updating.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/test/tasks-api.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Registry, Task } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { TaskStore } from "../src/tasks.js";
import { buildServer } from "../src/server.js";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REGISTRY: Registry = {
  agents: [{ id: "codex", name: "codex", runtime: "codex", machine: "m", workspace: "/w", role: "", allowedTools: [] }],
};

async function freshServer(): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-tapi-"));
  const db = openDb(join(dir, "t.db"));
  const mailbox = new Mailbox(db);
  return buildServer({ mailbox, token: TOKEN, db, registry: REGISTRY, tasks: new TaskStore(db) });
}

describe("tasks API", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await freshServer();
  });

  it("creates a task, lists by assignee+state, and advances state", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/tasks", headers: AUTH,
      payload: { assignee: "codex", spec: "add tests" },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<Task>();
    expect(task.state).toBe("queued");

    const queued = await app.inject({
      method: "GET", url: "/api/tasks?assignee=codex&state=queued", headers: AUTH,
    });
    expect(queued.json<Task[]>().map((t) => t.id)).toEqual([task.id]);

    const running = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/state`, headers: AUTH, payload: { state: "running" },
    });
    expect(running.json<Task>().state).toBe("running");
  });

  it("400 on unknown assignee, 409 on illegal transition", async () => {
    const bad = await app.inject({
      method: "POST", url: "/api/tasks", headers: AUTH, payload: { assignee: "ghost", spec: "x" },
    });
    expect(bad.statusCode).toBe(400);

    const created = (
      await app.inject({ method: "POST", url: "/api/tasks", headers: AUTH, payload: { assignee: "codex", spec: "x" } })
    ).json<Task>();
    const illegal = await app.inject({
      method: "POST", url: `/api/tasks/${created.id}/state`, headers: AUTH, payload: { state: "done" },
    });
    expect(illegal.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/tasks-api.test.ts`
Expected: FAIL — routes 404 / options unknown.

- [ ] **Step 3: Wire the server**

In `packages/hub/src/server.ts`:

Imports — extend the `@conclave/shared` value import to include `NewTaskSchema, TaskStateSchema`, the type import to include `Task`, and add:
```ts
import { TaskStore, createTask, InvalidTransitionError, UnknownAssigneeError } from "./tasks.js";
```

`ServerOptions` — add:
```ts
  tasks?: TaskStore;
```

Error handler — add before the ZodError line:
```ts
    if (err instanceof UnknownAssigneeError) return reply.code(400).send({ error: err.message });
    if (err instanceof InvalidTransitionError) return reply.code(409).send({ error: err.message });
```

Routes — add near the other `/api` routes (e.g. after `/api/debates`):
```ts
  const TaskStateBodySchema = z.object({ state: TaskStateSchema });

  app.post("/api/tasks", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const body = parseOr400(NewTaskSchema, req.body, reply);
    if (!body) return;
    const task = createTask({ mailbox, store: opts.tasks, registry }, body);
    return reply.code(201).send(task);
  });

  app.get("/api/tasks", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const q = req.query as { assignee?: string; state?: string };
    if (q.assignee && q.state) {
      const state = TaskStateSchema.safeParse(q.state);
      if (!state.success) return reply.code(400).send({ error: "invalid state" });
      return opts.tasks.listByAssigneeState(q.assignee, state.data);
    }
    return opts.tasks.list();
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const task = opts.tasks.get(id);
    if (!task) return reply.code(404).send({ error: `task not found: ${id}` });
    return task;
  });

  app.post("/api/tasks/:id/state", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(TaskStateBodySchema, req.body, reply);
    if (!body) return;
    if (!opts.tasks.get(id)) return reply.code(404).send({ error: `task not found: ${id}` });
    const task = opts.tasks.updateState(id, body.state);
    mailbox.events.emit("task", task);
    return task;
  });
```

`/ws` handler — add the frame + cleanup (alongside the existing message/thread/turn/status frames):
```ts
    const onTask = (task: Task): void => {
      socket.send(JSON.stringify({ type: "task", task }));
    };
    mailbox.events.on("task", onTask);
```
and in `socket.on("close", ...)`:
```ts
      mailbox.events.off("task", onTask);
```

- [ ] **Step 4: Wire main.ts**

In `packages/hub/src/main.ts`:
- Import: `import { TaskStore } from "./tasks.js";`
- After `const status = ...`:
```ts
const tasks = new TaskStore(db);
```
- Extend the `buildServer` call options with `tasks`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/tasks-api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck, full hub suite, commit**

```bash
npx pnpm --filter @conclave/hub typecheck
npx vitest run packages/hub
git add packages/hub/src/server.ts packages/hub/src/main.ts packages/hub/test/tasks-api.test.ts
git commit -m "feat(hub): task routes and ws task frame

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 5: Daemon HubClient task methods + HubSocket onTask

**Files:**
- Modify: `packages/daemon/src/hub-client.ts` (`listTasks`, `setTaskState`)
- Modify: `packages/daemon/src/hub-socket.ts` (`onTask`)
- Test: `packages/daemon/test/hub-socket-task.test.ts`

**Interfaces:**
- Consumes: `Task`, `TaskState`, `TaskSchema` (Task 1).
- Produces:
  - `HubClient.listTasks(assignee: string, state: TaskState): Promise<Task[]>` → `GET /api/tasks?assignee=&state=`.
  - `HubClient.setTaskState(id: string, state: TaskState): Promise<void>` → `POST /api/tasks/:id/state`.
  - `HubSocketOptions.onTask?: (task: Task) => void`; `{type:"task"}` frames parsed with `TaskSchema` and dispatched.

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/hub-socket-task.test.ts
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { Task } from "@conclave/shared";
import { HubSocket } from "../src/hub-socket.js";

const TASK: Task = {
  id: "t1", threadId: "th1", assignee: "codex", spec: "x", state: "queued",
  artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
};

describe("HubSocket task frames", () => {
  it("dispatches {type:task} frames to onTask", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "task", task: TASK })));

    const onTask = vi.fn();
    const socket = new HubSocket({
      hubUrl: `http://127.0.0.1:${port}`, token: "t",
      onMessage: () => undefined, onTask,
    });
    socket.start();
    await vi.waitFor(() => expect(onTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" })));
    socket.stop();
    wss.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/test/hub-socket-task.test.ts`
Expected: FAIL — `onTask` not handled.

- [ ] **Step 3: Add HubClient methods**

In `packages/daemon/src/hub-client.ts`:
- Extend the `@conclave/shared` type import with `Task, TaskState`.
- Add:
```ts
  listTasks(assignee: string, state: TaskState): Promise<Task[]> {
    return this.request(
      "GET",
      `/api/tasks?assignee=${encodeURIComponent(assignee)}&state=${encodeURIComponent(state)}`,
    );
  }

  async setTaskState(id: string, state: TaskState): Promise<void> {
    await this.request("POST", `/api/tasks/${id}/state`, { state });
  }
```

- [ ] **Step 4: Handle task frames in HubSocket**

In `packages/daemon/src/hub-socket.ts`:
- Extend imports: add `TaskSchema, type Task`.
- Add to `HubSocketOptions`: `onTask?: (task: Task) => void;`
- In `handleData`, after the `turn` branch:
```ts
        if (candidate.type === "task" && this.opts.onTask) {
          const parsedTask = TaskSchema.safeParse((candidate as { task?: unknown }).task);
          if (parsedTask.success) this.opts.onTask(parsedTask.data);
          return;
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/test/hub-socket-task.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npx pnpm --filter @conclave/daemon typecheck
git add packages/daemon/src/hub-client.ts packages/daemon/src/hub-socket.ts packages/daemon/test/hub-socket-task.test.ts
git commit -m "feat(daemon): hub-client task methods and socket task frames

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 6: Daemon runs delegated tasks (handleTask + runTask + catch-up)

**Files:**
- Modify: `packages/daemon/src/agent-loop.ts` (`buildTaskPrompt`, `handleTask`, `runTask`, `runTaskCatchUp`, started-set)
- Modify: `packages/daemon/src/main.ts` (wire `onTask` + task catch-up)
- Test: `packages/daemon/test/task-run.test.ts`

**Interfaces:**
- Consumes: `Task` (Task 1); `HubClient.setTaskState`/`listTasks` (Task 5); existing `adapter.runTurn`, `reportTurn`, `reportStatus`, `TurnQueue`, `bridgeConfig`.
- Produces:
  - `buildTaskPrompt(agent: AgentConfig, task: Task): string` (exported).
  - `AgentLoop.handleTask(task: Task): void` — no-op unless assignee is a local agent, `state === "queued"`, and not already started (dedupe `Set<string>`); else `queue.run(assignee, () => runTask)`.
  - `runTaskCatchUp(hub: HubClient, agents: AgentConfig[], handle: (t: Task) => void): Promise<number>` (exported) — for each agent, `listTasks(agent.id, "queued")` → `handle` each; returns count.

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/task-run.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, Task } from "@conclave/shared";
import { AgentLoop } from "../src/agent-loop.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { HubClient } from "../src/hub-client.js";
import type { RuntimeAdapter, TurnResult } from "../src/adapter.js";

const AGENT: AgentConfig = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1",
  workspace: "/tmp/ws", role: "", allowedTools: [],
};

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", threadId: "th1", assignee: "codex", spec: "add tests", state: "queued",
    artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z", ...over,
  };
}

function fakeHub() {
  const states: string[] = [];
  const messages: string[] = [];
  const hub = {
    setTaskState: vi.fn(async (_id: string, s: string) => { states.push(s); }),
    postMessage: vi.fn(async (_t: string, m: { body: string }) => { messages.push(m.body); }),
    postUsage: vi.fn(async () => undefined),
    postStatus: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
  } as unknown as HubClient;
  return { hub, states, messages };
}

function loopWith(adapter: RuntimeAdapter, hub: HubClient): AgentLoop {
  const dir = mkdtempSync(join(tmpdir(), "conclave-taskrun-"));
  return new AgentLoop({
    agents: [AGENT], hub, adapters: { codex: adapter }, state: new DaemonState(join(dir, "s.json")),
    queue: new TurnQueue(), hubUrl: "http://h", token: "t", allowAgentTriggers: false,
    bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
  });
}

describe("daemon task execution", () => {
  it("runs a queued task: running -> done, posts the result", async () => {
    const result: TurnResult = { sessionId: "s", text: "done: added tests", isError: false, costUsd: 0 };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, states, messages } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleTask(task());
    await loop.idle();
    expect(states).toEqual(["running", "done"]);
    expect(messages).toContain("done: added tests");
  });

  it("marks failed on an error result", async () => {
    const result: TurnResult = { sessionId: "s", text: "boom", isError: true, costUsd: 0 };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, states } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleTask(task());
    await loop.idle();
    expect(states).toEqual(["running", "failed"]);
  });

  it("runs a double-delivered task only once (dedupe)", async () => {
    const result: TurnResult = { sessionId: "s", text: "ok", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async () => result);
    const { hub } = fakeHub();
    const loop = loopWith({ runTurn }, hub);
    loop.handleTask(task());
    loop.handleTask(task());
    await loop.idle();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("ignores tasks for agents on other machines", async () => {
    const runTurn = vi.fn();
    const { hub } = fakeHub();
    const loop = loopWith({ runTurn }, hub);
    loop.handleTask(task({ assignee: "someone-else" }));
    await loop.idle();
    expect(runTurn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/test/task-run.test.ts`
Expected: FAIL — `handleTask` not defined.

- [ ] **Step 3: Implement in agent-loop.ts**

Add `Task` to the `@conclave/shared` type import.

Add the exported helpers (top-level, near `buildDebatePrompt`):
```ts
export function buildTaskPrompt(agent: AgentConfig, task: Task): string {
  const role = agent.role ? `${agent.role}\n\n` : "";
  return (
    `${role}You are agent "${agent.id}" in Conclave task thread ${task.threadId}. ` +
    `Hub MCP tools are available: send_message, check_inbox, wait_for_reply, end_thread. ` +
    `Delegated task:\n\n${task.spec}\n\n` +
    `Work in this workspace. Your final response text is posted as the task result.`
  );
}

export async function runTaskCatchUp(
  hub: HubClient,
  agents: AgentConfig[],
  handle: (t: Task) => void,
): Promise<number> {
  let total = 0;
  for (const agent of agents) {
    const queued = await hub.listTasks(agent.id, "queued");
    for (const t of queued) handle(t);
    total += queued.length;
  }
  return total;
}
```

Add a started-set field to `AgentLoop`:
```ts
  private readonly startedTasks = new Set<string>();
```

Add `handleTask` + `runTask` methods:
```ts
  handleTask(task: Task): void {
    if (this.startedTasks.has(task.id)) return;
    if (task.state !== "queued") return;
    const agent = this.opts.agents.find((a) => a.id === task.assignee);
    if (!agent) return;
    this.startedTasks.add(task.id);
    const work = this.opts.queue.run(agent.id, () => this.runTask(agent, task)).catch(() => undefined);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

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
      await this.reportTurn(agent, task.threadId, result);
      await this.reportTurnStatus(agent, task.threadId, result);
      if (result.isError) {
        await hub.setTaskState(task.id, "failed");
        return;
      }
      if (result.text.trim()) {
        await hub.postMessage(task.threadId, {
          from: agent.id, to: [], type: "text", body: result.text, artifacts: [],
        });
      }
      await hub.setTaskState(task.id, "done");
    } catch (e) {
      await this.postFailure(agent, task.threadId, e);
      await this.reportStatus(agent, "idle", "", task.threadId);
      try {
        await hub.setTaskState(task.id, "failed");
      } catch (stateErr) {
        console.error(
          `agent ${agent.id}: failed to mark task ${task.id} failed:`,
          stateErr instanceof Error ? stateErr.message : stateErr,
        );
      }
    }
  }
```

- [ ] **Step 4: Wire main.ts**

In `packages/daemon/src/main.ts`:
- In the `HubSocket` options, add `onTask`:
```ts
    onTask: (task) => {
      loop.handleTask(task);
    },
```
- In `onOpen`, after the message catch-up, add task catch-up:
```ts
      const caughtTasks = await runTaskCatchUp(hub, agents, (t) => loop.handleTask(t));
      if (caughtTasks > 0) console.log(`task catch-up: picked up ${caughtTasks} task(s)`);
```
- Import `runTaskCatchUp` alongside `runCatchUp` from `./agent-loop.js`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/test/task-run.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck, full daemon suite, commit**

```bash
npx pnpm --filter @conclave/daemon typecheck
npx vitest run packages/daemon
git add packages/daemon/src/agent-loop.ts packages/daemon/src/main.ts packages/daemon/test/task-run.test.ts
git commit -m "feat(daemon): run delegated tasks with state reporting and catch-up

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 7: Web hubClient tasks + store task frame

**Files:**
- Modify: `packages/web/src/lib/hubClient.ts` (`createTask`, `getTask`, `listTasks`)
- Modify: `packages/web/src/lib/socket.ts` (`task` frame in `WsFrame`)
- Modify: `packages/web/src/store/useConclaveStore.ts` (`tasksById`, `applyFrame` task)
- Test: `packages/web/src/store/__tests__/task-store.test.ts`

**Interfaces:**
- Consumes: `Task`, `NewTask` (Task 1).
- Produces:
  - `hubClient.createTask(input: NewTask): Promise<Task>`, `getTask(id)`, `listTasks()`.
  - `WsFrame` gains `{ type: "task"; task: Task }`.
  - Store: `tasksById: Record<string, Task>`; `applyFrame` upserts on `"task"`; `reset` clears it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/store/__tests__/task-store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Task } from "@conclave/shared";

const task: Task = {
  id: "t1", threadId: "th1", assignee: "codex", spec: "x", state: "queued",
  artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
};

describe("task frames in the store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("upserts tasks by id from task frames", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "task", task });
    applyFrame({ type: "task", task: { ...task, state: "running" } });
    expect(useConclaveStore.getState().tasksById["t1"].state).toBe("running");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/task-store.test.ts`
Expected: FAIL — `tasksById` undefined / `task` frame not in the union.

- [ ] **Step 3: Add the frame type**

In `packages/web/src/lib/socket.ts`:
- Import `Task` from `@conclave/shared`.
- Add to `WsFrame`: `| { type: "task"; task: Task }`.

- [ ] **Step 4: Add hubClient methods**

In `packages/web/src/lib/hubClient.ts`, extend the shared type import with `NewTask, Task` and add to the object:
```ts
  createTask: (input: NewTask) => req<Task>("POST", "/api/tasks", input),
  getTask: (id: string) => req<Task>("GET", `/api/tasks/${id}`),
  listTasks: () => req<Task[]>("GET", "/api/tasks"),
```

- [ ] **Step 5: Add store state**

In `packages/web/src/store/useConclaveStore.ts`:
- Import `Task`.
- Add `tasksById: Record<string, Task>;` to `State`.
- Add `tasksById: {} as Record<string, Task>,` to `initial`.
- In `applyFrame`, add a case:
```ts
        case "task":
          return { tasksById: { ...s.tasksById, [f.task.id]: f.task } };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/task-store.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npx pnpm --filter @conclave/web typecheck
git add packages/web/src/lib/hubClient.ts packages/web/src/lib/socket.ts packages/web/src/store/useConclaveStore.ts packages/web/src/store/__tests__/task-store.test.ts
git commit -m "feat(web): task hub-client methods and task frame in store

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 8: Web /task command + toolbar task state

**Files:**
- Modify: `packages/web/src/components/Composer.tsx` (`/task` parsing + create + select)
- Modify: `packages/web/src/components/ContextToolbar.tsx` (task state on task threads)
- Test: `packages/web/src/components/__tests__/ComposerTask.test.tsx`, `packages/web/src/components/__tests__/ContextToolbar.test.tsx`

**Interfaces:**
- Consumes: `hubClient.createTask`/`listMessages`/`getThread`, store (`applyFrame`, `setActiveThread`, `setMessages`), `tasksById`.
- Produces: `/task @agent <spec>` in the composer creates a task and switches to its thread; `ContextToolbar` renders `● task: <state>` for `kind:"task"` threads.

- [ ] **Step 1: Write the failing tests**

```tsx
// packages/web/src/components/__tests__/ComposerTask.test.tsx
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

it("/task @agent spec creates a task and selects its thread", async () => {
  vi.spyOn(hubClient, "createTask").mockResolvedValue({
    id: "task1", threadId: "th-new", assignee: "codex", spec: "write the migration", state: "queued",
    artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
  });
  vi.spyOn(hubClient, "getThread").mockResolvedValue({
    id: "th-new", kind: "task", workspace: "w", participants: ["codex", "you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z",
  });
  vi.spyOn(hubClient, "listMessages").mockResolvedValue([]);

  render(<Composer />);
  await userEvent.type(screen.getByRole("textbox"), "/task @codex write the migration{Enter}");
  expect(hubClient.createTask).toHaveBeenCalledWith(expect.objectContaining({ assignee: "codex", spec: "write the migration" }));
});
```

```tsx
// packages/web/src/components/__tests__/ContextToolbar.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ContextToolbar } from "../ContextToolbar.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([{ id: "th1", kind: "task", workspace: "w", participants: ["codex", "you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" }]);
  s.setActiveThread("th1");
  s.applyFrame({ type: "task", task: { id: "task1", threadId: "th1", assignee: "codex", spec: "x", state: "running", artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z" } });
});

it("shows task state for a task thread", () => {
  render(<ContextToolbar />);
  expect(screen.getByText(/task: running/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/ComposerTask.test.tsx src/components/__tests__/ContextToolbar.test.tsx`
Expected: FAIL — `/task` not handled; toolbar has no task state.

- [ ] **Step 3: Handle /task in the composer**

In `packages/web/src/components/Composer.tsx`, add a store accessor for `applyFrame`, `setActiveThread`, `setMessages` (via `useConclaveStore`), and branch inside `send` before the normal post:
```ts
  const applyFrame = useConclaveStore((s) => s.applyFrame);
  const setActiveThread = useConclaveStore((s) => s.setActiveThread);
  const setMessages = useConclaveStore((s) => s.setMessages);
```
Replace the body of `send` with:
```ts
  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body) return;

    const taskMatch = /^\/task\s+@([\w-]+)\s+([\s\S]+)$/.exec(body);
    if (taskMatch) {
      const [, assignee, spec] = taskMatch;
      if (!agents.some((a) => a.id === assignee)) return; // unknown agent — leave text for correction
      setText("");
      const task = await hubClient.createTask({ assignee, spec, workspace: active?.workspace });
      const thread = await hubClient.getThread(task.threadId);
      applyFrame({ type: "thread", thread });
      setActiveThread(task.threadId);
      setMessages(task.threadId, await hubClient.listMessages(task.threadId));
      return;
    }

    if (!activeThreadId) return;
    const ids = new Set(participantAgents.map((a) => a.id));
    const to = [
      ...new Set([...body.matchAll(/@([\w-]+)/g)].map((m) => m[1]).filter((id) => ids.has(id))),
    ];
    setText("");
    await hubClient.postMessage(activeThreadId, { from: "you", to, type: "text", body, artifacts: [] });
  };
```

- [ ] **Step 4: Show task state in the toolbar**

In `packages/web/src/components/ContextToolbar.tsx`:
```tsx
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./ContextToolbar.module.css";

export function ContextToolbar(): JSX.Element {
  const activeId = useConclaveStore((s) => s.activeThreadId);
  const thread = useConclaveStore((s) => s.threads.find((t) => t.id === activeId));
  const tasksById = useConclaveStore((s) => s.tasksById);
  const count = (thread?.participants ?? []).filter((p) => p !== "you").length;

  const task =
    thread?.kind === "task"
      ? Object.values(tasksById).find((t) => t.threadId === thread.id)
      : undefined;

  return (
    <div className={styles.toolbar} data-testid="context-toolbar">
      <span className={styles.item}>{count} agents ▾</span>
      <span className={styles.sep}>·</span>
      <span className={styles.item}>▣ {thread?.workspace ?? "workspace"}</span>
      {task ? (
        <span className={styles.state} data-task-state={task.state}>● task: {task.state}</span>
      ) : (
        <span className={styles.state}>● {thread?.state ?? "open"}</span>
      )}
    </div>
  );
}
```
Add to `ContextToolbar.module.css`:
```css
.state[data-task-state="running"] { color: var(--live); }
.state[data-task-state="failed"] { color: var(--danger); }
.state[data-task-state="done"] { color: var(--text-secondary-2); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/ComposerTask.test.tsx src/components/__tests__/ContextToolbar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck, full web suite, commit**

```bash
npx pnpm --filter @conclave/web typecheck
npx pnpm --filter @conclave/web exec vitest run
git add packages/web/src/components/Composer.tsx packages/web/src/components/ContextToolbar.tsx packages/web/src/components/ContextToolbar.module.css packages/web/src/components/__tests__/ComposerTask.test.tsx packages/web/src/components/__tests__/ContextToolbar.test.tsx
git commit -m "feat(web): /task command and task state in the context toolbar

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 9: End-to-end verification (live hub + fake adapter)

**Files:**
- Create: `packages/web/src/__tests__/task-integration.test.tsx` (App-level delegation render)
- Modify: `packages/daemon/README.md` (smoke checklist: delegation)

**Interfaces:** none (verification).

- [ ] **Step 1: Full-app integration test for a task thread**

Add an integration test that mounts `<App/>` (WebSocket + fetch stubbed as in `integration.test.tsx`) with a seeded **task** thread + a `task` frame, and asserts the toolbar shows `task: running` and the spec message renders. (Model it on `packages/web/src/__tests__/integration.test.tsx`; seed `threads` with a `kind:"task"` thread, push a `{type:"task"}` frame via the store, and assert `/task: running/`.)

- [ ] **Step 2: Run it**

Run: `npx pnpm --filter @conclave/web exec vitest run src/__tests__/task-integration.test.tsx`
Expected: PASS.

- [ ] **Step 3: Manual live drive (hub + fake adapter)**

Seed a live check (hub on an alt port, e.g. 7799, token `dev`):
```bash
# create a task via the API and confirm the task thread + queued state
H=http://localhost:7799; Q=token=dev; CT=content-type:application/json
curl -s -H "$CT" -X POST "$H/api/tasks?$Q" -d '{"assignee":"codex","spec":"add a unit test for the parser"}'
# GET /api/tasks?assignee=codex&state=queued shows it; a connected daemon with a fake
# adapter transitions it running->done and posts the result into the task thread.
```
Point the web app at the hub (`VITE_CONCLAVE_TOKEN=dev`, `CONCLAVE_HUB_URL=...`), run `/task @codex ...` from the composer, and confirm the new task thread opens and its state advances. (A real daemon+CLI run belongs to the manual smoke checklist — quota-gated.)

- [ ] **Step 4: Update the daemon smoke checklist**

Append to `packages/daemon/README.md` (manual smoke checklist):
```
6. Delegation: POST /api/tasks (or /task from the web composer) for a registry agent;
   confirm the daemon picks it up (running), the agent works in its workspace, the
   result posts to the task thread, and the task ends `done` (or `failed` with reason).
   Restart the daemon while a task is `queued` and confirm task catch-up picks it up.
```

- [ ] **Step 5: Full monorepo green + commit**

```bash
npx pnpm -r typecheck
npx vitest run
npx pnpm --filter @conclave/web exec vitest run
git add packages/web/src/__tests__/task-integration.test.tsx packages/daemon/README.md
git commit -m "test(delegation): app-level task render; smoke checklist entry

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Self-Review Notes

- **Spec coverage:** §3 data model → Task 1; §4.1 store → Task 2; §4.2 createTask + §4.5 thread-event → Task 3; §4.3 routes + §4.4 WS frame → Task 4; §5 daemon socket/client → Task 5, run/catch-up → Task 6; §6 web → Tasks 7–8; §8 testing → tests in every task + Task 9. §7 deferrals honored (no ACL/approval/streaming/artifacts tasks).
- **Type consistency:** `Task`/`NewTask`/`TaskState`, `TaskStore` methods (`create`/`get`/`list`/`listByAssigneeState`/`updateState`), `createTask({mailbox,store,registry}, input)`, `handleTask`/`runTask`/`buildTaskPrompt`/`runTaskCatchUp`, `HubClient.listTasks`/`setTaskState`, web `createTask`/`getTask`/`listTasks`, store `tasksById` + `task` frame — used identically across tasks.
- **Trigger safety:** the spec message is posted `to: []` so `shouldTrigger` never fires the chat path; the `task` frame is the sole execution trigger. Dedupe via `startedTasks` guards double-delivery (frame + catch-up).
- **Deferred (not gaps):** input-required interactive tasks, approvals/web-push (step 6), agent-to-agent task creation (ACLs), live streaming, usage-threshold refusal, task artifacts — all called out in the spec §7.
