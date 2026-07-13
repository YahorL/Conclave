import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentStatus } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { AgentStatusStore } from "../src/status.js";
import { buildServer } from "../src/server.js";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function freshServer(): Promise<{ app: FastifyInstance; status: AgentStatusStore }> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-status-"));
  const mailbox = new Mailbox(openDb(join(dir, "test.db")));
  const status = new AgentStatusStore();
  const app = await buildServer({ mailbox, token: TOKEN, status });
  return { app, status };
}

describe("agent status API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await freshServer());
  });

  it("stores latest status per agent and stamps ts", async () => {
    const posted = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: AUTH,
      payload: { agent: "codex", status: "running", activity: "reviewing PR" },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json<AgentStatus>().ts).toBeTruthy();

    await app.inject({
      method: "POST",
      url: "/api/status",
      headers: AUTH,
      payload: { agent: "codex", status: "idle", activity: "" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/status", headers: AUTH });
    const all = listed.json<AgentStatus[]>();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ agent: "codex", status: "idle" });
  });

  it("rejects an invalid status body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/status",
      headers: AUTH,
      payload: { agent: "codex", status: "nope", activity: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires auth", async () => {
    expect((await app.inject({ method: "GET", url: "/api/status" })).statusCode).toBe(401);
  });
});
