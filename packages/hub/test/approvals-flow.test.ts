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
