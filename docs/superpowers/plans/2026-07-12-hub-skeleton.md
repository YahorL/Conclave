# Conclave Step 1: Monorepo + Hub Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running hub server: SQLite-backed mailbox (threads/messages/verdicts) with a bearer-token HTTP + WebSocket API, in a pnpm monorepo — drivable end-to-end with curl.

**Architecture:** Two workspace packages: `@conclave/shared` (zod envelope schemas, the system-wide contract per spec §5) and `@conclave/hub` (better-sqlite3 storage + `Mailbox` domain class + Fastify HTTP/WS server). The `Mailbox` emits events on an `EventEmitter`; long-poll and WebSocket push both consume it. No build pipeline yet — packages export TypeScript source directly; everything runs via `tsx`/`vitest` (bundling/Docker arrives in build step 5).

**Tech Stack:** Node ≥ 22, pnpm workspaces, TypeScript (strict, ESM), zod, better-sqlite3 (WAL), Fastify 5 + @fastify/websocket, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` (§3 topology, §5 data model). This plan implements build-order step 1 only.
- SQLite in **WAL mode**; message ids are **monotonic** (`INTEGER PRIMARY KEY AUTOINCREMENT`), catch-up = "everything after id N".
- Auth: single bearer token, env `CONCLAVE_TOKEN`, accepted as `Authorization: Bearer <t>` or `?token=<t>` (for browser WebSocket). `/health` is the only unauthenticated route.
- Thread states: `open | input-required | settled | closed`; message types: `text | proposal | verdict | file | approval-request | status` — exact strings from spec §5.
- Envelope fields `from`/`to` keep those names in JSON/API; SQLite columns are `sender`/`recipients` (avoids keyword friction).
- TypeScript `strict: true`, `"type": "module"` everywhere. No `any` in committed code.
- Commits: conventional style (`feat:`, `test:`, `chore:`), no attribution trailers.
- Orchestrator, daemon, MCP bridge, artifacts, ACLs are **later steps** — do not stub them.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `vitest.config.ts`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `packages/hub/package.json`, `packages/hub/tsconfig.json`, `packages/hub/src/index.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: workspace layout; `@conclave/shared` importable from `@conclave/hub` as `workspace:*`; root commands `pnpm test` and `pnpm typecheck`.

- [ ] **Step 1: Create workspace config**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`package.json` (root):
```json
{
  "name": "conclave",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Create package skeletons**

`packages/shared/package.json`:
```json
{
  "name": "@conclave/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/shared/src/index.ts`:
```ts
export {};
```

`packages/hub/package.json`:
```json
{
  "name": "@conclave/hub",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "dev": "tsx src/main.ts"
  }
}
```

`packages/hub/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/hub/src/index.ts`:
```ts
export {};
```

- [ ] **Step 3: Install root dev dependencies**

Run:
```bash
pnpm add -w -D typescript vitest @types/node
```
Expected: `node_modules` created, lockfile written, no errors.

- [ ] **Step 4: Verify typecheck and test runner**

Run: `pnpm typecheck`
Expected: both packages pass (empty sources).

Run: `pnpm test`
Expected: exits reporting no test files found (that's fine — first tests arrive in Task 2). If vitest exits non-zero on empty suites, add `"passWithNoTests": true` to the `test` block in `vitest.config.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo (shared + hub packages)"
```

---

### Task 2: Envelope schemas in @conclave/shared

**Files:**
- Create: `packages/shared/src/envelope.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/envelope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - Schemas: `ThreadKindSchema`, `ThreadStateSchema`, `MessageTypeSchema`, `ThreadSchema`, `NewThreadSchema`, `MessageSchema`, `NewMessageSchema`
  - Types: `Thread`, `NewThread`, `Message`, `NewMessage`, `ThreadKind`, `ThreadState`, `MessageType`
  - `Message.id` is `number` (monotonic); `Thread.id` is a uuid `string`; timestamps are ISO strings.

- [ ] **Step 1: Add zod dependency**

Run:
```bash
pnpm --filter @conclave/shared add zod
```

- [ ] **Step 2: Write the failing test**

`packages/shared/test/envelope.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  MessageSchema,
  NewMessageSchema,
  NewThreadSchema,
  ThreadSchema,
} from "../src/index.js";

describe("ThreadSchema", () => {
  it("accepts a valid thread", () => {
    const thread = {
      id: "8f14e45f-ea4c-4f34-a2b0-9d3d7b3a1c11",
      kind: "debate",
      workspace: null,
      participants: ["claude-code", "codex"],
      state: "open",
      verdicts: {},
      createdAt: new Date().toISOString(),
    };
    expect(ThreadSchema.parse(thread)).toEqual(thread);
  });

  it("rejects an unknown state", () => {
    const result = ThreadSchema.safeParse({
      id: "x",
      kind: "debate",
      workspace: null,
      participants: ["a"],
      state: "paused",
      verdicts: {},
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty participants", () => {
    const result = NewThreadSchema.safeParse({ kind: "chat", participants: [] });
    expect(result.success).toBe(false);
  });
});

describe("MessageSchema", () => {
  it("accepts a valid message", () => {
    const message = {
      id: 1,
      threadId: "t1",
      from: "claude-code",
      to: ["codex"],
      type: "proposal",
      body: "I think we should split the module.",
      artifacts: [],
      ts: new Date().toISOString(),
    };
    expect(MessageSchema.parse(message)).toEqual(message);
  });

  it("applies defaults on NewMessage", () => {
    const parsed = NewMessageSchema.parse({ from: "you", body: "hello" });
    expect(parsed.to).toEqual([]);
    expect(parsed.type).toBe("text");
    expect(parsed.artifacts).toEqual([]);
  });

  it("rejects an empty body", () => {
    expect(NewMessageSchema.safeParse({ from: "you", body: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/shared`
Expected: FAIL — `envelope.ts` / exports do not exist.

- [ ] **Step 4: Implement the schemas**

`packages/shared/src/envelope.ts`:
```ts
import { z } from "zod";

export const ThreadKindSchema = z.enum(["chat", "debate", "task", "dm"]);
export const ThreadStateSchema = z.enum(["open", "input-required", "settled", "closed"]);
export const MessageTypeSchema = z.enum([
  "text",
  "proposal",
  "verdict",
  "file",
  "approval-request",
  "status",
]);

export const ThreadSchema = z.object({
  id: z.string().min(1),
  kind: ThreadKindSchema,
  workspace: z.string().nullable(),
  participants: z.array(z.string().min(1)).min(1),
  state: ThreadStateSchema,
  verdicts: z.record(z.string()),
  createdAt: z.string().datetime(),
});

export const NewThreadSchema = z.object({
  kind: ThreadKindSchema,
  participants: z.array(z.string().min(1)).min(1),
  workspace: z.string().optional(),
});

export const MessageSchema = z.object({
  id: z.number().int().positive(),
  threadId: z.string().min(1),
  from: z.string().min(1),
  to: z.array(z.string()),
  type: MessageTypeSchema,
  body: z.string(),
  artifacts: z.array(z.string()),
  ts: z.string().datetime(),
});

export const NewMessageSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string()).default([]),
  type: MessageTypeSchema.default("text"),
  body: z.string().min(1),
  artifacts: z.array(z.string()).default([]),
});

export type ThreadKind = z.infer<typeof ThreadKindSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type MessageType = z.infer<typeof MessageTypeSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type NewThread = z.infer<typeof NewThreadSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type NewMessage = z.infer<typeof NewMessageSchema>;
```

`packages/shared/src/index.ts` (replace contents):
```ts
export * from "./envelope.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/shared`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): envelope schemas for threads and messages"
```

---

### Task 3: Hub database + thread storage

**Files:**
- Create: `packages/hub/src/db.ts`, `packages/hub/src/mailbox.ts`
- Test: `packages/hub/test/mailbox.test.ts`

**Interfaces:**
- Consumes: `Thread`, `NewThread` types from `@conclave/shared`.
- Produces:
  - `openDb(path: string): Database.Database` — opens SQLite with WAL + runs migrations (idempotent).
  - `class Mailbox { constructor(db); readonly events: EventEmitter }` with `createThread(input: NewThread): Thread`, `getThread(id: string): Thread | undefined`, `listThreads(): Thread[]`.
  - Error classes: `ThreadNotFoundError`, `ThreadClosedError`, `NotAParticipantError` (all `extends Error`, constructor takes the offending id/name).

- [ ] **Step 1: Add hub dependencies**

Run:
```bash
pnpm --filter @conclave/hub add better-sqlite3 zod tsx fastify @fastify/websocket "@conclave/shared@workspace:*"
pnpm --filter @conclave/hub add -D @types/better-sqlite3 ws @types/ws
```
(Fastify/ws are used from Task 6 on; installing once here keeps later tasks dependency-free.)

- [ ] **Step 2: Write the failing test**

`packages/hub/test/mailbox.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";

function freshMailbox(): Mailbox {
  const dir = mkdtempSync(join(tmpdir(), "conclave-test-"));
  return new Mailbox(openDb(join(dir, "test.db")));
}

describe("Mailbox threads", () => {
  let mailbox: Mailbox;
  beforeEach(() => {
    mailbox = freshMailbox();
  });

  it("creates and fetches a thread", () => {
    const thread = mailbox.createThread({
      kind: "debate",
      participants: ["claude-code", "codex"],
    });
    expect(thread.id).toMatch(/[0-9a-f-]{36}/);
    expect(thread.state).toBe("open");
    expect(thread.workspace).toBeNull();
    expect(mailbox.getThread(thread.id)).toEqual(thread);
  });

  it("returns undefined for a missing thread", () => {
    expect(mailbox.getThread("nope")).toBeUndefined();
  });

  it("lists threads newest-first", () => {
    const a = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const b = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const ids = mailbox.listThreads().map((t) => t.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it("persists across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-test-"));
    const path = join(dir, "test.db");
    const first = new Mailbox(openDb(path));
    const thread = first.createThread({ kind: "task", participants: ["deploy"], workspace: "ws1" });
    const second = new Mailbox(openDb(path));
    expect(second.getThread(thread.id)).toEqual(thread);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/hub`
Expected: FAIL — `db.ts` / `mailbox.ts` do not exist.

- [ ] **Step 4: Implement db + thread storage**

`packages/hub/src/db.ts`:
```ts
import Database from "better-sqlite3";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      workspace    TEXT,
      participants TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'open',
      verdicts     TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  TEXT NOT NULL REFERENCES threads(id),
      sender     TEXT NOT NULL,
      recipients TEXT NOT NULL,
      type       TEXT NOT NULL,
      body       TEXT NOT NULL,
      artifacts  TEXT NOT NULL DEFAULT '[]',
      ts         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
  `);
}
```

`packages/hub/src/mailbox.ts`:
```ts
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NewThread, Thread } from "@conclave/shared";

export class ThreadNotFoundError extends Error {
  constructor(id: string) {
    super(`thread not found: ${id}`);
  }
}

export class ThreadClosedError extends Error {
  constructor(id: string) {
    super(`thread is closed: ${id}`);
  }
}

export class NotAParticipantError extends Error {
  constructor(agent: string) {
    super(`not a participant: ${agent}`);
  }
}

interface ThreadRow {
  id: string;
  kind: string;
  workspace: string | null;
  participants: string;
  state: string;
  verdicts: string;
  created_at: string;
}

export class Mailbox {
  readonly events = new EventEmitter();

  constructor(private readonly db: Database.Database) {}

  createThread(input: NewThread): Thread {
    const thread: Thread = {
      id: randomUUID(),
      kind: input.kind,
      workspace: input.workspace ?? null,
      participants: input.participants,
      state: "open",
      verdicts: {},
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO threads (id, kind, workspace, participants, state, verdicts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.kind,
        thread.workspace,
        JSON.stringify(thread.participants),
        thread.state,
        JSON.stringify(thread.verdicts),
        thread.createdAt,
      );
    return thread;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? rowToThread(row) : undefined;
  }

  listThreads(): Thread[] {
    const rows = this.db
      .prepare("SELECT * FROM threads ORDER BY created_at DESC, id DESC")
      .all() as ThreadRow[];
    return rows.map(rowToThread);
  }
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    kind: row.kind as Thread["kind"],
    workspace: row.workspace,
    participants: JSON.parse(row.participants) as string[],
    state: row.state as Thread["state"],
    verdicts: JSON.parse(row.verdicts) as Record<string, string>,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/hub pnpm-lock.yaml
git commit -m "feat(hub): sqlite storage and thread mailbox"
```

---

### Task 4: Messages — append, list, monotonic catch-up

**Files:**
- Modify: `packages/hub/src/mailbox.ts`
- Test: `packages/hub/test/mailbox.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: `Mailbox`, error classes from Task 3; `NewMessage`, `Message` from shared.
- Produces:
  - `Mailbox.appendMessage(threadId: string, input: NewMessage): Message` — throws `ThreadNotFoundError` / `ThreadClosedError`; emits `events.emit("message", message)`.
  - `Mailbox.listMessages(threadId: string, afterId?: number): Message[]` — ascending id, strictly greater than `afterId` (default 0).

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/test/mailbox.test.ts` (inside the file, new top-level describe; reuse the `freshMailbox` helper):
```ts
import type { Message } from "@conclave/shared";
import { ThreadClosedError, ThreadNotFoundError } from "../src/mailbox.js";

describe("Mailbox messages", () => {
  let mailbox: Mailbox;
  beforeEach(() => {
    mailbox = freshMailbox();
  });

  it("appends and lists messages with monotonic ids", () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "codex"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["codex"], type: "text", body: "first", artifacts: [],
    });
    const m2 = mailbox.appendMessage(t.id, {
      from: "codex", to: ["you"], type: "text", body: "second", artifacts: [],
    });
    expect(m2.id).toBeGreaterThan(m1.id);
    expect(mailbox.listMessages(t.id).map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("supports catch-up via afterId", () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "old", artifacts: [],
    });
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "new", artifacts: [],
    });
    const caughtUp = mailbox.listMessages(t.id, m1.id);
    expect(caughtUp.map((m) => m.body)).toEqual(["new"]);
  });

  it("emits a message event on append", () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const seen: Message[] = [];
    mailbox.events.on("message", (m: Message) => seen.push(m));
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "ping", artifacts: [],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe("ping");
  });

  it("rejects messages to unknown or closed threads", () => {
    expect(() =>
      mailbox.appendMessage("nope", {
        from: "you", to: [], type: "text", body: "x", artifacts: [],
      }),
    ).toThrow(ThreadNotFoundError);

    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.closeThread(t.id);
    expect(() =>
      mailbox.appendMessage(t.id, {
        from: "you", to: [], type: "text", body: "x", artifacts: [],
      }),
    ).toThrow(ThreadClosedError);
  });
});
```
Note: `closeThread` is implemented in Task 5 — for this task, add a minimal `closeThread` as part of making the last test pass (Task 5 extends it with events and verdict logic).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub`
Expected: FAIL — `appendMessage` / `listMessages` / `closeThread` not defined.

- [ ] **Step 3: Implement messages**

Add to `packages/hub/src/mailbox.ts` (inside `class Mailbox`), plus the `MessageRow` interface and `rowToMessage` helper at module level, and extend the shared imports:
```ts
import type { Message, NewMessage, NewThread, Thread } from "@conclave/shared";
```

```ts
  appendMessage(threadId: string, input: NewMessage): Message {
    const thread = this.requireOpenThread(threadId);
    const ts = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO messages (thread_id, sender, recipients, type, body, artifacts, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        input.from,
        JSON.stringify(input.to),
        input.type,
        input.body,
        JSON.stringify(input.artifacts),
        ts,
      );
    const message: Message = {
      id: Number(info.lastInsertRowid),
      threadId: thread.id,
      from: input.from,
      to: input.to,
      type: input.type,
      body: input.body,
      artifacts: input.artifacts,
      ts,
    };
    this.events.emit("message", message);
    return message;
  }

  listMessages(threadId: string, afterId = 0): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id ASC")
      .all(threadId, afterId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  closeThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    this.db.prepare("UPDATE threads SET state = 'closed' WHERE id = ?").run(threadId);
    return { ...thread, state: "closed" };
  }

  private requireOpenThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    if (thread.state === "closed") throw new ThreadClosedError(threadId);
    return thread;
  }
```

Module-level additions:
```ts
interface MessageRow {
  id: number;
  thread_id: string;
  sender: string;
  recipients: string;
  type: string;
  body: string;
  artifacts: string;
  ts: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    from: row.sender,
    to: JSON.parse(row.recipients) as string[],
    type: row.type as Message["type"],
    body: row.body,
    artifacts: JSON.parse(row.artifacts) as string[],
    ts: row.ts,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): append/list messages with monotonic ids and events"
```

---

### Task 5: Verdicts, settlement, close events

**Files:**
- Modify: `packages/hub/src/mailbox.ts`
- Test: `packages/hub/test/mailbox.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: Task 3/4 `Mailbox`.
- Produces:
  - `Mailbox.setVerdict(threadId: string, agent: string, verdict: string): Thread` — throws `NotAParticipantError` for non-participants; when **all** participants have verdicts, state becomes `"settled"`. Emits `events.emit("thread", thread)` on every change.
  - `Mailbox.closeThread(threadId: string): Thread` — now also emits `"thread"`.
  - Settlement rule is intentionally dumb ("all participants"); orchestrator-level nuance (round caps, human exemption) is build step 3's job, not the mailbox's.

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/test/mailbox.test.ts`:
```ts
import { NotAParticipantError } from "../src/mailbox.js";
import type { Thread } from "@conclave/shared";

describe("Mailbox verdicts", () => {
  let mailbox: Mailbox;
  beforeEach(() => {
    mailbox = freshMailbox();
  });

  it("stores verdicts and settles when all participants voted", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    const afterFirst = mailbox.setVerdict(t.id, "claude-code", "approve");
    expect(afterFirst.state).toBe("open");
    const afterSecond = mailbox.setVerdict(t.id, "codex", "reject");
    expect(afterSecond.state).toBe("settled");
    expect(afterSecond.verdicts).toEqual({ "claude-code": "approve", codex: "reject" });
  });

  it("rejects verdicts from non-participants", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    expect(() => mailbox.setVerdict(t.id, "intruder", "approve")).toThrow(NotAParticipantError);
  });

  it("emits thread events on verdict and close", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    const seen: Thread[] = [];
    mailbox.events.on("thread", (th: Thread) => seen.push(th));
    mailbox.setVerdict(t.id, "claude-code", "approve");
    expect(seen.at(-1)!.state).toBe("settled");
    const t2 = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.closeThread(t2.id);
    expect(seen.at(-1)!.state).toBe("closed");
  });

  it("persists verdicts", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    mailbox.setVerdict(t.id, "claude-code", "approve");
    expect(mailbox.getThread(t.id)!.verdicts).toEqual({ "claude-code": "approve" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub`
Expected: FAIL — `setVerdict` not defined; close-event assertion fails.

- [ ] **Step 3: Implement verdicts and events**

In `packages/hub/src/mailbox.ts`, add `setVerdict` and replace `closeThread`:
```ts
  setVerdict(threadId: string, agent: string, verdict: string): Thread {
    const thread = this.requireOpenThread(threadId);
    if (!thread.participants.includes(agent)) throw new NotAParticipantError(agent);
    const verdicts = { ...thread.verdicts, [agent]: verdict };
    const settled = thread.participants.every((p) => verdicts[p] !== undefined);
    const state: Thread["state"] = settled ? "settled" : thread.state;
    this.db
      .prepare("UPDATE threads SET verdicts = ?, state = ? WHERE id = ?")
      .run(JSON.stringify(verdicts), state, threadId);
    const updated: Thread = { ...thread, verdicts, state };
    this.events.emit("thread", updated);
    return updated;
  }

  closeThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    this.db.prepare("UPDATE threads SET state = 'closed' WHERE id = ?").run(threadId);
    const updated: Thread = { ...thread, state: "closed" };
    this.events.emit("thread", updated);
    return updated;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): verdicts with settlement and thread events"
```

---

### Task 6: HTTP API with bearer auth

**Files:**
- Create: `packages/hub/src/server.ts`
- Test: `packages/hub/test/api.test.ts`

**Interfaces:**
- Consumes: `Mailbox` + error classes (Tasks 3–5); `NewThreadSchema`, `NewMessageSchema` from shared.
- Produces:
  - `buildServer(opts: { mailbox: Mailbox; token: string }): Promise<FastifyInstance>` — used by Tasks 7–9.
  - Routes (all JSON, all authed except `/health`):
    - `GET  /health` → `{ ok: true }`
    - `POST /api/threads` (NewThread body) → 201 Thread
    - `GET  /api/threads` → Thread[]
    - `GET  /api/threads/:id` → Thread | 404
    - `POST /api/threads/:id/messages` (NewMessage body) → 201 Message
    - `GET  /api/threads/:id/messages?after=N` → Message[]
    - `POST /api/threads/:id/verdict` (`{ agent, verdict }`) → Thread
    - `POST /api/threads/:id/close` → Thread
  - Error mapping: zod → 400, `ThreadNotFoundError` → 404, `ThreadClosedError` → 409, `NotAParticipantError` → 403, bad token → 401.

- [ ] **Step 1: Write the failing tests**

`packages/hub/test/api.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Message, Thread } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function freshServer(): Promise<{ app: FastifyInstance; mailbox: Mailbox }> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-api-"));
  const mailbox = new Mailbox(openDb(join(dir, "test.db")));
  const app = await buildServer({ mailbox, token: TOKEN });
  return { app, mailbox };
}

describe("HTTP API", () => {
  let app: FastifyInstance;
  let mailbox: Mailbox;

  beforeEach(async () => {
    ({ app, mailbox } = await freshServer());
  });

  it("health is open, everything else needs the token", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/threads" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/threads", headers: AUTH })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/api/threads?token=${TOKEN}` })).statusCode,
    ).toBe(200);
  });

  it("creates a thread and posts a message", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: AUTH,
      payload: { kind: "debate", participants: ["claude-code", "codex"] },
    });
    expect(created.statusCode).toBe(201);
    const thread = created.json<Thread>();

    const posted = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: AUTH,
      payload: { from: "claude-code", body: "opening argument" },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json<Message>().type).toBe("text");

    const listed = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/messages`,
      headers: AUTH,
    });
    expect(listed.json<Message[]>().map((m) => m.body)).toEqual(["opening argument"]);
  });

  it("supports after for catch-up", async () => {
    const thread = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(thread.id, {
      from: "you", to: [], type: "text", body: "one", artifacts: [],
    });
    mailbox.appendMessage(thread.id, {
      from: "you", to: [], type: "text", body: "two", artifacts: [],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/messages?after=${m1.id}`,
      headers: AUTH,
    });
    expect(res.json<Message[]>().map((m) => m.body)).toEqual(["two"]);
  });

  it("maps domain errors to status codes", async () => {
    expect(
      (
        await app.inject({ method: "GET", url: "/api/threads/nope", headers: AUTH })
      ).statusCode,
    ).toBe(404);

    const bad = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: AUTH,
      payload: { kind: "nonsense", participants: [] },
    });
    expect(bad.statusCode).toBe(400);

    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/verdict`,
      headers: AUTH,
      payload: { agent: "intruder", verdict: "approve" },
    });
    expect(forbidden.statusCode).toBe(403);

    mailbox.closeThread(t.id);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/messages`,
      headers: AUTH,
      payload: { from: "claude-code", body: "too late" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("settles via the verdict endpoint", async () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    const res = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/verdict`,
      headers: AUTH,
      payload: { agent: "claude-code", verdict: "approve" },
    });
    expect(res.json<Thread>().state).toBe("settled");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/test/api.test.ts`
Expected: FAIL — `server.ts` does not exist.

- [ ] **Step 3: Implement the server**

`packages/hub/src/server.ts`:
```ts
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { NewMessageSchema, NewThreadSchema } from "@conclave/shared";
import {
  Mailbox,
  NotAParticipantError,
  ThreadClosedError,
  ThreadNotFoundError,
} from "./mailbox.js";

export interface ServerOptions {
  mailbox: Mailbox;
  token: string;
}

const VerdictBodySchema = z.object({
  agent: z.string().min(1),
  verdict: z.string().min(1),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { mailbox, token } = opts;
  const app = Fastify();
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const header = req.headers.authorization;
    const query = req.query as { token?: string };
    if (header === `Bearer ${token}` || query.token === token) return;
    await reply.code(401).send({ error: "unauthorized" });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ThreadNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ThreadClosedError) return reply.code(409).send({ error: err.message });
    if (err instanceof NotAParticipantError) return reply.code(403).send({ error: err.message });
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/threads", async (req, reply) => {
    const body = parseOr400(NewThreadSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(mailbox.createThread(body));
  });

  app.get("/api/threads", async () => mailbox.listThreads());

  app.get("/api/threads/:id", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const thread = mailbox.getThread(id);
    if (!thread) return reply.code(404).send({ error: `thread not found: ${id}` });
    return thread;
  });

  app.post("/api/threads/:id/messages", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(NewMessageSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(mailbox.appendMessage(id, body));
  });

  app.get("/api/threads/:id/messages", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    if (!mailbox.getThread(id)) return reply.code(404).send({ error: `thread not found: ${id}` });
    const query = req.query as { after?: string };
    const after = Number(query.after ?? 0);
    return mailbox.listMessages(id, Number.isFinite(after) ? after : 0);
  });

  app.post("/api/threads/:id/verdict", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(VerdictBodySchema, req.body, reply);
    if (!body) return;
    return mailbox.setVerdict(id, body.agent, body.verdict);
  });

  app.post("/api/threads/:id/close", async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    return mailbox.closeThread(id);
  });

  return app;
}

function parseOr400<T>(
  schema: z.ZodType<T>,
  input: unknown,
  reply: FastifyReply,
): T | undefined {
  const result = schema.safeParse(input);
  if (!result.success) {
    void reply.code(400).send({ error: "invalid body", issues: result.error.issues });
    return undefined;
  }
  return result.data;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub`
Expected: PASS (17 tests). Also run `pnpm typecheck` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): http api with bearer auth and error mapping"
```

---

### Task 7: Long-poll on the messages endpoint

**Files:**
- Modify: `packages/hub/src/server.ts` (the `GET /api/threads/:id/messages` route)
- Test: `packages/hub/test/api.test.ts` (append tests)

**Interfaces:**
- Consumes: `mailbox.events` `"message"` events (Task 4).
- Produces: `GET /api/threads/:id/messages?after=N&wait=S` — when the result would be empty and `wait > 0` (seconds, capped at 60), the request parks until a message lands in that thread or the timeout expires, then re-reads. This is the primitive `wait_for_reply` (build step 2) is built on.

- [ ] **Step 1: Write the failing tests**

Append to `packages/hub/test/api.test.ts`:
```ts
describe("long-poll", () => {
  let app: FastifyInstance;
  let mailbox: Mailbox;

  beforeEach(async () => {
    ({ app, mailbox } = await freshServer());
  });

  it("parks until a message arrives", async () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const pending = app.inject({
      method: "GET",
      url: `/api/threads/${t.id}/messages?after=0&wait=5`,
      headers: AUTH,
    });
    setTimeout(() => {
      mailbox.appendMessage(t.id, {
        from: "you", to: [], type: "text", body: "late arrival", artifacts: [],
      });
    }, 50);
    const res = await pending;
    expect(res.json<Message[]>().map((m) => m.body)).toEqual(["late arrival"]);
  });

  it("returns empty after timeout", async () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const started = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${t.id}/messages?after=0&wait=1`,
      headers: AUTH,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(res.json<Message[]>()).toEqual([]);
  });

  it("returns immediately when messages already exist", async () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "already here", artifacts: [],
    });
    const started = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${t.id}/messages?after=0&wait=5`,
      headers: AUTH,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.json<Message[]>()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/hub/test/api.test.ts`
Expected: FAIL — the `wait` param is ignored, so "parks until a message arrives" gets `[]`.

- [ ] **Step 3: Implement long-poll**

In `packages/hub/src/server.ts`, replace the `GET /api/threads/:id/messages` handler and add the helper:
```ts
  app.get("/api/threads/:id/messages", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    if (!mailbox.getThread(id)) return reply.code(404).send({ error: `thread not found: ${id}` });
    const query = req.query as { after?: string; wait?: string };
    const afterRaw = Number(query.after ?? 0);
    const after = Number.isFinite(afterRaw) ? afterRaw : 0;
    const waitRaw = Number(query.wait ?? 0);
    const waitMs = Math.min(Number.isFinite(waitRaw) ? waitRaw : 0, 60) * 1000;

    let messages = mailbox.listMessages(id, after);
    if (messages.length === 0 && waitMs > 0) {
      await waitForThreadMessage(mailbox, id, waitMs);
      messages = mailbox.listMessages(id, after);
    }
    return messages;
  });
```

Module-level helper (bottom of `server.ts`):
```ts
import type { Message } from "@conclave/shared";

function waitForThreadMessage(
  mailbox: Mailbox,
  threadId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function onMessage(message: Message): void {
      if (message.threadId === threadId) done();
    }
    function done(): void {
      clearTimeout(timer);
      mailbox.events.off("message", onMessage);
      resolve();
    }
    mailbox.events.on("message", onMessage);
  });
}
```
(Merge the `Message` import into the existing `@conclave/shared` import line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub`
Expected: PASS (20 tests; the timeout test takes ~1s).

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): long-poll wait on message listing"
```

---

### Task 8: WebSocket event push

**Files:**
- Modify: `packages/hub/src/server.ts` (add `/ws` route)
- Test: `packages/hub/test/ws.test.ts`

**Interfaces:**
- Consumes: `mailbox.events` `"message"` and `"thread"` events; auth hook from Task 6 (it already covers upgrade requests).
- Produces: `GET /ws` (WebSocket upgrade, `?token=` auth) pushing JSON frames:
  - `{ "type": "message", "message": Message }` on every appended message
  - `{ "type": "thread", "thread": Thread }` on every thread state/verdict change
  - This is the transport daemons (step 2) and web clients (step 4) subscribe to; roles/selective subscription come later.

- [ ] **Step 1: Write the failing test**

`packages/hub/test/ws.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "ws-token";

describe("WebSocket push", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function listen(): Promise<{ mailbox: Mailbox; port: number }> {
    const dir = mkdtempSync(join(tmpdir(), "conclave-ws-"));
    const mailbox = new Mailbox(openDb(join(dir, "test.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return { mailbox, port };
  }

  it("rejects a bad token", async () => {
    const { port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("open", () => resolve(false));
    });
    expect(failed).toBe(true);
  });

  it("pushes message and thread events", async () => {
    const { mailbox, port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const frames: unknown[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));

    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    mailbox.appendMessage(t.id, {
      from: "claude-code", to: [], type: "text", body: "hello room", artifacts: [],
    });
    mailbox.setVerdict(t.id, "claude-code", "approve");

    await new Promise((resolve) => setTimeout(resolve, 200));
    ws.close();

    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ body: "hello room" }),
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "thread",
        thread: expect.objectContaining({ state: "settled" }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/hub/test/ws.test.ts`
Expected: FAIL — `/ws` route does not exist (open fails / no frames).

- [ ] **Step 3: Implement the WebSocket route**

In `packages/hub/src/server.ts`, after the REST routes (inside `buildServer`), add:
```ts
  app.get("/ws", { websocket: true }, (socket) => {
    const onMessage = (message: Message): void => {
      socket.send(JSON.stringify({ type: "message", message }));
    };
    const onThread = (thread: Thread): void => {
      socket.send(JSON.stringify({ type: "thread", thread }));
    };
    mailbox.events.on("message", onMessage);
    mailbox.events.on("thread", onThread);
    socket.on("close", () => {
      mailbox.events.off("message", onMessage);
      mailbox.events.off("thread", onThread);
    });
  });
```
Extend the shared type import in `server.ts`:
```ts
import type { Message, Thread } from "@conclave/shared";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/hub`
Expected: PASS (22 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub
git commit -m "feat(hub): websocket push for message and thread events"
```

---

### Task 9: Entrypoint, config, smoke run

**Files:**
- Create: `packages/hub/src/main.ts`, `packages/hub/README.md`
- Modify: `.gitignore` (add hub data dir)

**Interfaces:**
- Consumes: `openDb`, `Mailbox`, `buildServer`.
- Produces: `pnpm --filter @conclave/hub dev` starts the hub. Env contract (used by Docker packaging in build step 5): `CONCLAVE_TOKEN` (required), `CONCLAVE_PORT` (default `7777`), `CONCLAVE_DATA_DIR` (default `./data`, created if missing).

- [ ] **Step 1: Implement the entrypoint**

`packages/hub/src/main.ts`:
```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Mailbox } from "./mailbox.js";
import { buildServer } from "./server.js";

const token = process.env["CONCLAVE_TOKEN"];
if (!token) {
  console.error("CONCLAVE_TOKEN is required");
  process.exit(1);
}

const port = Number(process.env["CONCLAVE_PORT"] ?? 7777);
const dataDir = process.env["CONCLAVE_DATA_DIR"] ?? "./data";
mkdirSync(dataDir, { recursive: true });

const mailbox = new Mailbox(openDb(join(dataDir, "conclave.db")));
const app = await buildServer({ mailbox, token });
await app.listen({ port, host: "0.0.0.0" });
console.log(`conclave hub listening on :${port}`);
```

Add to `.gitignore` (repo root), under the "Build output" section:
```
packages/hub/data/
```

- [ ] **Step 2: Smoke-test manually**

Run:
```bash
CONCLAVE_TOKEN=dev pnpm --filter @conclave/hub dev &
sleep 2
curl -s http://localhost:7777/health
curl -s -X POST http://localhost:7777/api/threads \
  -H "Authorization: Bearer dev" -H "Content-Type: application/json" \
  -d '{"kind":"chat","participants":["you","claude-code"]}'
```
Expected: `{"ok":true}` then a JSON thread with a uuid `id`. Post a message to it and list it back the same way, then `kill %1`.

- [ ] **Step 3: Write the hub README**

`packages/hub/README.md`:
```markdown
# @conclave/hub

Mailbox hub: SQLite-backed threads/messages with an HTTP + WebSocket API.
See `docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §3, §5.

## Run

CONCLAVE_TOKEN=dev pnpm --filter @conclave/hub dev

Env: `CONCLAVE_TOKEN` (required) · `CONCLAVE_PORT` (default 7777) · `CONCLAVE_DATA_DIR` (default ./data)

## API

All routes need `Authorization: Bearer $TOKEN` (or `?token=`), except `GET /health`.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/threads` | `{kind, participants, workspace?}` | 201 Thread |
| `GET /api/threads` | – | Thread[] |
| `GET /api/threads/:id` | – | Thread |
| `POST /api/threads/:id/messages` | `{from, body, to?, type?, artifacts?}` | 201 Message |
| `GET /api/threads/:id/messages?after=N&wait=S` | – | Message[] (long-polls up to S≤60s) |
| `POST /api/threads/:id/verdict` | `{agent, verdict}` | Thread (settles when all voted) |
| `POST /api/threads/:id/close` | – | Thread |
| `GET /ws` | WebSocket | pushes `{type:"message"|"thread", ...}` frames |
```

- [ ] **Step 4: Full verification**

Run: `pnpm test && pnpm typecheck`
Expected: all 28 tests pass across both packages, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(hub): runnable entrypoint with env config and readme"
```
