import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, Approval, Task, Thread } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { PushStore } from "../src/push-store.js";
import { Notifier, approvalPayload, statusPayload, taskPayload, threadPayload, type NotifyPayload } from "../src/notifier.js";

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", requestedBy: "codex", action: "run deploy.sh",
    idempotencyKey: "k1", state: "pending", createdAt: "2026-07-15T10:00:00Z", ...over,
  };
}
function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", threadId: "th2", assignee: "codex", spec: "ship the release", state: "failed",
    artifacts: [], createdAt: "2026-07-15T10:00:00Z", updatedAt: "2026-07-15T10:00:00Z", ...over,
  };
}
function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "th3", kind: "debate", workspace: null, participants: ["dev", "codex"],
    state: "settled", verdicts: { dev: "approve", codex: "approve" },
    createdAt: "2026-07-15T10:00:00Z", ...over,
  };
}
function blocked(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    agent: "codex", status: "blocked", activity: "rate-limited",
    resetsAt: "2026-07-15T14:30:00Z", ts: "2026-07-15T10:00:00Z", ...over,
  };
}

describe("payload mappers", () => {
  it("approval: pending fires, decided does not", () => {
    const p = approvalPayload(approval())!;
    expect(p.title).toBe("Approval needed");
    expect(p.body).toBe("run deploy.sh");
    expect(p.url).toBe("/?thread=th1");
    expect(p.tag).toBe("approval-a1");
    expect(approvalPayload(approval({ state: "approved" }))).toBeNull();
  });

  it("task: failed fires, others do not", () => {
    const p = taskPayload(task())!;
    expect(p.title).toBe("Task failed");
    expect(p.url).toBe("/?thread=th2");
    expect(taskPayload(task({ state: "running" }))).toBeNull();
    expect(taskPayload(task({ state: "done" }))).toBeNull();
  });

  it("thread: settled fires with verdicts, open does not", () => {
    const p = threadPayload(thread())!;
    expect(p.title).toBe("Thread settled");
    expect(p.body).toContain("approve");
    expect(threadPayload(thread({ state: "open" }))).toBeNull();
  });

  it("status: blocked fires with reset time, running does not", () => {
    const p = statusPayload(blocked())!;
    expect(p.title).toBe("codex blocked");
    expect(p.body).toMatch(/resets \d{2}:\d{2}/);
    expect(statusPayload(blocked({ resetsAt: undefined }))!.body).toBe("usage limit reached");
    expect(statusPayload(blocked({ status: "running" }))).toBeNull();
  });
});

describe("Notifier", () => {
  let store: PushStore;
  let mailboxEvents: EventEmitter;
  let statusEvents: EventEmitter;
  let sent: Array<{ endpoint: string; payload: NotifyPayload }>;
  let notifier: Notifier;

  function makeNotifier(send?: (sub: { endpoint: string }, p: NotifyPayload) => Promise<void>): Notifier {
    const n = new Notifier({
      mailboxEvents, statusEvents, store,
      send: send ?? (async (sub, payload) => {
        sent.push({ endpoint: sub.endpoint, payload });
      }),
    });
    n.start();
    return n;
  }

  beforeEach(() => {
    store = new PushStore(openDb(join(mkdtempSync(join(tmpdir(), "conclave-notif-")), "t.db")));
    store.upsert({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } });
    store.upsert({ endpoint: "https://push.example/2", keys: { p256dh: "p", auth: "a" } });
    mailboxEvents = new EventEmitter();
    statusEvents = new EventEmitter();
    sent = [];
  });

  it("fans a pending approval out to every subscription", async () => {
    notifier = makeNotifier();
    mailboxEvents.emit("approval", approval());
    await notifier.idle();
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.endpoint).sort()).toEqual([
      "https://push.example/1", "https://push.example/2",
    ]);
    expect(sent[0]!.payload.tag).toBe("approval-a1");
    notifier.stop();
  });

  it("sends nothing for non-trigger states", async () => {
    notifier = makeNotifier();
    mailboxEvents.emit("approval", approval({ state: "approved" }));
    mailboxEvents.emit("task", task({ state: "running" }));
    mailboxEvents.emit("thread", thread({ state: "open" }));
    statusEvents.emit("agent-status", blocked({ status: "idle" }));
    await notifier.idle();
    expect(sent).toEqual([]);
    notifier.stop();
  });

  it("prunes a subscription on a 410 rejection, keeps others on other errors", async () => {
    notifier = makeNotifier(async (sub) => {
      if (sub.endpoint.endsWith("/1")) {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      }
      throw Object.assign(new Error("flaky"), { statusCode: 500 });
    });
    mailboxEvents.emit("task", task());
    await notifier.idle();
    expect(store.list().map((s) => s.endpoint)).toEqual(["https://push.example/2"]);
    notifier.stop();
  });

  it("stop() detaches listeners", async () => {
    notifier = makeNotifier();
    notifier.stop();
    mailboxEvents.emit("approval", approval());
    await notifier.idle();
    expect(sent).toEqual([]);
  });
});
