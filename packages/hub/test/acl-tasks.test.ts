import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { RegistrySchema, type Registry, type Task } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { TaskStore } from "../src/tasks.js";
import { buildServer } from "../src/server.js";

const TOKEN = "acl-task-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REGISTRY: Registry = RegistrySchema.parse({
  agents: [
    { id: "dev", name: "dev", runtime: "codex", machine: "m", workspace: "/w" },
    { id: "deploy", name: "deploy", runtime: "codex", machine: "m", workspace: "/w" },
    { id: "audit", name: "audit", runtime: "codex", machine: "m", workspace: "/w" },
  ],
  acl: [["dev", "deploy"]],
});

describe("delegation ACL", () => {
  let app: FastifyInstance;
  let mailbox: Mailbox;

  beforeEach(async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-acltask-")), "t.db"));
    mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN, registry: REGISTRY, tasks: new TaskStore(db) });
  });

  function create(assignee: string, requestedBy?: string) {
    return app.inject({
      method: "POST", url: "/api/tasks", headers: AUTH,
      payload: { assignee, spec: "do the thing", ...(requestedBy ? { requestedBy } : {}) },
    });
  }

  it("allows a user task (no requestedBy → 'you') and seeds the spec message from 'you'", async () => {
    const res = await create("dev");
    expect(res.statusCode).toBe(201);
    const task = res.json() as Task;
    const spec = mailbox.listMessages(task.threadId).find((m) => m.body === "do the thing");
    expect(spec?.from).toBe("you");
  });

  it("allows an agent delegating to an allowed pair and seeds the spec message from the requester", async () => {
    const res = await create("deploy", "dev");
    expect(res.statusCode).toBe(201);
    const task = res.json() as Task;
    const spec = mailbox.listMessages(task.threadId).find((m) => m.body === "do the thing");
    expect(spec?.from).toBe("dev");
  });

  it("rejects an agent delegating to a non-paired assignee (403)", async () => {
    expect((await create("audit", "dev")).statusCode).toBe(403);
  });

  it("rejects an agent delegating to an unknown assignee (403 via ACL, before UnknownAssignee)", async () => {
    expect((await create("ghost", "dev")).statusCode).toBe(403);
  });

  it("a user task to an unknown assignee still 400s (ACL skipped for 'you')", async () => {
    expect((await create("ghost")).statusCode).toBe(400);
  });
});
