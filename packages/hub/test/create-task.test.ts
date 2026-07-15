import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Registry, Task } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { TaskStore, UnknownAssigneeError, createTask } from "../src/tasks.js";

const REGISTRY: Registry = {
  agents: [{ id: "codex", name: "codex", runtime: "codex", machine: "m", workspace: "/w", role: "", allowedTools: [], dangerousActions: [] }],
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
