import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workspace } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { WorkspaceStore } from "../src/workspaces.js";
import { buildServer } from "../src/server.js";

const TOKEN = "t"; const AUTH = { authorization: `Bearer ${TOKEN}` };
async function fresh(): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-wsapi-"));
  const db = openDb(join(dir, "t.db"));
  return buildServer({ mailbox: new Mailbox(db), token: TOKEN, workspaces: new WorkspaceStore(db) });
}

describe("workspaces API", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await fresh(); });
  it("creates and lists a workspace", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/workspaces", headers: AUTH,
      payload: { machine: "local", folderPath: "/home/me/svc" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<Workspace>().name).toBe("svc");
    const list = await app.inject({ method: "GET", url: "/api/workspaces", headers: AUTH });
    expect(list.json<Workspace[]>()).toHaveLength(1);
  });
});
