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
