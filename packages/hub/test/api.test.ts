import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Message, Thread } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function freshServer(): Promise<{ app: FastifyInstance; mailbox: Mailbox }> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-api-"));
  const mailbox = new Mailbox(openDb(join(dir, "test.db")));
  const app = await buildServer({ mailbox, token: TOKEN });
  return { app, mailbox };
}

describe("HTTP API", () => {
  let app: FastifyInstance;
  let mailbox: Mailbox;

  beforeEach(async () => {
    ({ app, mailbox } = await freshServer());
  });

  it("health is open, everything else needs the token", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/threads" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/threads", headers: AUTH })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/api/threads?token=${TOKEN}` })).statusCode,
    ).toBe(200);
  });

  it("creates a thread and posts a message", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: AUTH,
      payload: { kind: "debate", participants: ["claude-code", "codex"] },
    });
    expect(created.statusCode).toBe(201);
    const thread = created.json<Thread>();

    const posted = await app.inject({
      method: "POST",
      url: `/api/threads/${thread.id}/messages`,
      headers: AUTH,
      payload: { from: "claude-code", body: "opening argument" },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json<Message>().type).toBe("text");

    const listed = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/messages`,
      headers: AUTH,
    });
    expect(listed.json<Message[]>().map((m) => m.body)).toEqual(["opening argument"]);
  });

  it("supports after for catch-up", async () => {
    const thread = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(thread.id, {
      from: "you", to: [], type: "text", body: "one", artifacts: [],
    });
    mailbox.appendMessage(thread.id, {
      from: "you", to: [], type: "text", body: "two", artifacts: [],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${thread.id}/messages?after=${m1.id}`,
      headers: AUTH,
    });
    expect(res.json<Message[]>().map((m) => m.body)).toEqual(["two"]);
  });

  it("maps domain errors to status codes", async () => {
    expect(
      (
        await app.inject({ method: "GET", url: "/api/threads/nope", headers: AUTH })
      ).statusCode,
    ).toBe(404);

    const bad = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: AUTH,
      payload: { kind: "nonsense", participants: [] },
    });
    expect(bad.statusCode).toBe(400);

    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/verdict`,
      headers: AUTH,
      payload: { agent: "intruder", verdict: "approve" },
    });
    expect(forbidden.statusCode).toBe(403);

    mailbox.closeThread(t.id);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/messages`,
      headers: AUTH,
      payload: { from: "claude-code", body: "too late" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("settles via the verdict endpoint", async () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    const res = await app.inject({
      method: "POST",
      url: `/api/threads/${t.id}/verdict`,
      headers: AUTH,
      payload: { agent: "claude-code", verdict: "approve" },
    });
    expect(res.json<Thread>().state).toBe("settled");
  });

  it("maps malformed JSON to 400, not 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("health bypasses auth even with a query string", async () => {
    const res = await app.inject({ method: "GET", url: "/health?probe=1" });
    expect(res.statusCode).toBe(200);
  });
});

describe("long-poll", () => {
  let app: FastifyInstance;
  let mailbox: Mailbox;

  beforeEach(async () => {
    ({ app, mailbox } = await freshServer());
  });

  it("parks until a message arrives", async () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const pending = app.inject({
      method: "GET",
      url: `/api/threads/${t.id}/messages?after=0&wait=5`,
      headers: AUTH,
    });
    setTimeout(() => {
      mailbox.appendMessage(t.id, {
        from: "you", to: [], type: "text", body: "late arrival", artifacts: [],
      });
    }, 50);
    const res = await pending;
    expect(res.json<Message[]>().map((m) => m.body)).toEqual(["late arrival"]);
  });

  it("returns empty after timeout", async () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const started = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${t.id}/messages?after=0&wait=1`,
      headers: AUTH,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(res.json<Message[]>()).toEqual([]);
  });

  it("returns immediately when messages already exist", async () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "already here", artifacts: [],
    });
    const started = Date.now();
    const res = await app.inject({
      method: "GET",
      url: `/api/threads/${t.id}/messages?after=0&wait=5`,
      headers: AUTH,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.json<Message[]>()).toHaveLength(1);
  });
});
