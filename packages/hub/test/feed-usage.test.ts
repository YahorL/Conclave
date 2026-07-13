import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Message } from "@conclave/shared";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";
import { listUsage, recordUsage } from "../src/usage.js";

const TOKEN = "fu-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let db: Database.Database;
let mailbox: Mailbox;
let app: FastifyInstance;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-fu-"));
  db = openDb(join(dir, "t.db"));
  mailbox = new Mailbox(db);
  app = await buildServer({ mailbox, token: TOKEN, db });
});

describe("global message feed", () => {
  it("returns messages across threads ascending, honoring after and limit", async () => {
    const t1 = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const t2 = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(t1.id, { from: "you", to: [], type: "text", body: "a", artifacts: [] });
    mailbox.appendMessage(t2.id, { from: "you", to: [], type: "text", body: "b", artifacts: [] });
    mailbox.appendMessage(t1.id, { from: "you", to: [], type: "text", body: "c", artifacts: [] });

    expect(mailbox.listAllMessages().map((m) => m.body)).toEqual(["a", "b", "c"]);
    expect(mailbox.listAllMessages(m1.id).map((m) => m.body)).toEqual(["b", "c"]);
    expect(mailbox.listAllMessages(0, 2).map((m) => m.body)).toEqual(["a", "b"]);

    const res = await app.inject({
      method: "GET", url: `/api/messages?after=${m1.id}&limit=1`, headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Message[]>().map((m) => m.body)).toEqual(["b"]);
    expect((await app.inject({ method: "GET", url: "/api/messages" })).statusCode).toBe(401);
  });
});

describe("usage", () => {
  it("records and lists usage rows", () => {
    recordUsage(db, { agent: "codex", threadId: "t1", inputTokens: 10, outputTokens: 5, costUsd: 0 });
    recordUsage(db, { agent: "claude-code", inputTokens: 1, outputTokens: 2, costUsd: 0.03 });
    const rows = listUsage(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.agent).toBe("claude-code"); // newest first
    expect(rows[0]!.threadId).toBeUndefined();
    expect(rows[1]!.inputTokens).toBe(10);
  });

  it("accepts usage over http and lists it back", async () => {
    const posted = await app.inject({
      method: "POST", url: "/api/usage", headers: AUTH,
      payload: { agent: "codex", inputTokens: 7, outputTokens: 3 },
    });
    expect(posted.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: "/api/usage", headers: AUTH });
    expect(listed.json<Array<{ agent: string }>>()[0]!.agent).toBe("codex");
    const bad = await app.inject({
      method: "POST", url: "/api/usage", headers: AUTH, payload: { inputTokens: 7 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
