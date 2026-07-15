import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { RegistrySchema, type Registry } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "acl-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REGISTRY: Registry = RegistrySchema.parse({
  agents: [
    { id: "dev", name: "dev", runtime: "codex", machine: "m", workspace: "/w" },
    { id: "deploy", name: "deploy", runtime: "codex", machine: "m", workspace: "/w" },
    { id: "audit", name: "audit", runtime: "codex", machine: "m", workspace: "/w" },
  ],
  acl: [["dev", "deploy"]],
});

describe("message ACL enforcement", () => {
  let app: FastifyInstance;
  let mailbox: Mailbox;
  let threadId: string;

  beforeEach(async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-aclmsg-")), "t.db"));
    mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN, registry: REGISTRY });
    threadId = mailbox.createThread({ kind: "chat", participants: ["dev", "deploy", "audit"] }).id;
  });

  function post(from: string, to: string[]) {
    return app.inject({
      method: "POST", url: `/api/threads/${threadId}/messages`, headers: AUTH,
      payload: { from, to, type: "text", body: "hi", artifacts: [] },
    });
  }

  it("allows an allowed agent pair (201)", async () => {
    expect((await post("dev", ["deploy"])).statusCode).toBe(201);
  });

  it("allows the human to message anyone (201)", async () => {
    expect((await post("you", ["dev", "audit"])).statusCode).toBe(201);
  });

  it("allows to:[] and to:[\"you\"] from an agent (201)", async () => {
    expect((await post("dev", [])).statusCode).toBe(201);
    expect((await post("dev", ["you"])).statusCode).toBe(201);
  });

  it("rejects a disallowed agent pair (403) and does not store it", async () => {
    const before = mailbox.listMessages(threadId).length;
    const res = await post("dev", ["audit"]);
    expect(res.statusCode).toBe(403);
    expect(mailbox.listMessages(threadId).length).toBe(before);
  });

  it("rejects a multi-recipient message if any recipient is disallowed (403)", async () => {
    expect((await post("dev", ["deploy", "audit"])).statusCode).toBe(403);
  });
});
