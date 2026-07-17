import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";
import { getUsageSummary } from "../src/usage.js";

const TOKEN = "usage-win-token";

function freshDb(): Database.Database {
  return openDb(join(mkdtempSync(join(tmpdir(), "conclave-uw-")), "t.db"));
}

function seed(db: Database.Database, agent: string, tokens: number, agoMs: number): void {
  db.prepare(
    `INSERT INTO usage (agent, thread_id, input_tokens, output_tokens, cost_usd, ts)
     VALUES (?, NULL, ?, 0, 0.01, ?)`,
  ).run(agent, tokens, new Date(Date.now() - agoMs).toISOString());
}

const H = 3600_000;
const D = 24 * H;

describe("trailing usage windows", () => {
  it("sums only rows inside each window", () => {
    const db = freshDb();
    seed(db, "codex", 100, 1 * H);   // inside 5h and 7d
    seed(db, "codex", 200, 6 * H);   // outside 5h, inside 7d
    seed(db, "codex", 400, 3 * D);   // outside 5h, inside 7d
    seed(db, "codex", 800, 8 * D);   // outside both
    const s = getUsageSummary(db, 25);
    const u = s.perAgent.find((a) => a.agent === "codex")!;
    expect(u.window5hTokens).toBe(100);
    expect(u.weeklyTokens).toBe(700);
    expect(u.window5hPct).toBeUndefined(); // no caps passed
  });

  it("merges caps into rounded percentages, only where configured", () => {
    const db = freshDb();
    seed(db, "codex", 350, 1 * H);
    seed(db, "claude-code", 500, 1 * H);
    const s = getUsageSummary(db, 25, {
      codex: { window5hTokens: 1000 },            // 5h cap only
      "claude-code": { weeklyTokens: 1000 },      // weekly cap only
    });
    const codex = s.perAgent.find((a) => a.agent === "codex")!;
    expect(codex.window5hPct).toBe(35);
    expect(codex.weeklyPct).toBeUndefined();
    const cc = s.perAgent.find((a) => a.agent === "claude-code")!;
    expect(cc.window5hPct).toBeUndefined();
    expect(cc.weeklyPct).toBe(50);
  });

  it("pct can exceed 100 (no clamping server-side)", () => {
    const db = freshDb();
    seed(db, "codex", 1370, 1 * H);
    const s = getUsageSummary(db, 25, { codex: { window5hTokens: 1000 } });
    expect(s.perAgent.find((a) => a.agent === "codex")!.window5hPct).toBe(137);
  });
});

describe("usage frame broadcast", () => {
  let app: FastifyInstance;
  let ws: WebSocket;
  afterEach(async () => {
    ws?.close();
    await app.close();
  });

  it("POST /api/usage broadcasts {type:'usage'} with the fresh summary", async () => {
    const db = freshDb();
    app = await buildServer({
      mailbox: new Mailbox(db), token: TOKEN, db,
      registry: {
        agents: [{
          id: "codex", name: "codex", runtime: "codex", machine: "m1",
          workspace: "/w", role: "", allowedTools: [], dangerousActions: [],
          limits: { window5hTokens: 1000 },
        }],
        acl: [],
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const seen: Array<Record<string, unknown>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const res = await app.inject({
      method: "POST", url: "/api/usage",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { agent: "codex", inputTokens: 250, outputTokens: 250, costUsd: 0.05 },
    });
    expect(res.statusCode).toBe(201);

    const start = Date.now();
    while (!seen.some((f) => f["type"] === "usage")) {
      if (Date.now() - start > 5000) throw new Error("no usage frame");
      await new Promise((r) => setTimeout(r, 20));
    }
    const frame = seen.find((f) => f["type"] === "usage") as {
      summary: { perAgent: Array<{ agent: string; window5hTokens: number; window5hPct?: number }> };
    };
    const u = frame.summary.perAgent.find((a) => a.agent === "codex")!;
    expect(u.window5hTokens).toBe(500);
    expect(u.window5hPct).toBe(50);
  }, 15000);
});
