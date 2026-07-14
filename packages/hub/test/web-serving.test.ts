import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "web-token";

function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "conclave-web-"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><script>window.__CONCLAVE_TOKEN__="CONCLAVE_TOKEN_PLACEHOLDER";</script></head><body><div id="root"></div></body></html>`,
  );
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('hi')");
  return dir;
}

async function fresh(): Promise<FastifyInstance> {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-webhub-")), "t.db"));
  return buildServer({ mailbox: new Mailbox(db), token: TOKEN, webDir: makeWebDir() });
}

describe("hub serves the web app", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await fresh();
  });

  it("serves index.html at / with the runtime token injected, no auth needed", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain(`window.__CONCLAVE_TOKEN__="web-token"`);
    expect(res.body).not.toContain("CONCLAVE_TOKEN_PLACEHOLDER");
  });

  it("serves SPA routes (fallback to index) and static assets without auth", async () => {
    const spa = await app.inject({ method: "GET", url: "/some/deep/route" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("id=\"root\"");
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
  });

  it("still requires the token for /api", async () => {
    expect((await app.inject({ method: "GET", url: "/api/threads" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/threads", headers: { authorization: `Bearer ${TOKEN}` } }))
        .statusCode,
    ).toBe(200);
  });
});
