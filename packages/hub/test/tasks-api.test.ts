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
