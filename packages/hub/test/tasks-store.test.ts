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
  const db = openDb(join(dir, "t.db"));
  // tasks.thread_id has a FK to threads; seed the referenced thread.
  db.prepare(
    `INSERT INTO threads (id, kind, workspace, participants, state, verdicts, created_at)
     VALUES ('th1', 'task', NULL, '[]', 'open', '{}', '2026-07-13T10:00:00Z')`,
  ).run();
  return db;
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
