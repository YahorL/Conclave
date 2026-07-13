import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Artifact } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { ArtifactStore } from "../src/artifacts.js";
import { buildServer } from "../src/server.js";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function freshServer(): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-aapi-"));
  const db = openDb(join(dir, "t.db"));
  return buildServer({ mailbox: new Mailbox(db), token: TOKEN, db, artifacts: new ArtifactStore(db) });
}

describe("artifacts API", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await freshServer();
  });

  it("creates, lists, and serves the blob with its mime", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/artifacts", headers: AUTH,
      payload: { name: "plan.md", mime: "text/markdown", content: "# Plan" },
    });
    expect(created.statusCode).toBe(201);
    const art = created.json<Artifact>();

    const list = await app.inject({ method: "GET", url: "/api/artifacts", headers: AUTH });
    expect(list.json<Artifact[]>().map((a) => a.id)).toEqual([art.id]);

    const blob = await app.inject({ method: "GET", url: `/api/artifacts/${art.id}/blob`, headers: AUTH });
    expect(blob.statusCode).toBe(200);
    expect(blob.headers["content-type"]).toContain("text/markdown");
    expect(blob.body).toBe("# Plan");
  });

  it("404 for an unknown blob", async () => {
    const res = await app.inject({ method: "GET", url: "/api/artifacts/nope/blob", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
