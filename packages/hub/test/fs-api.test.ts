import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "t"; const AUTH = { authorization: `Bearer ${TOKEN}` };

async function fresh(): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-fsapi-"));
  const mailbox = new Mailbox(openDb(join(dir, "t.db")));
  return buildServer({ mailbox, token: TOKEN });
}

describe("fs API", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await fresh(); });

  it("503 when the machine is not connected", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/fs/ghost/list", headers: AUTH, payload: { path: "/w" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("lists machines (empty when none connected)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/machines", headers: AUTH });
    expect(res.json()).toEqual([]);
  });
});
