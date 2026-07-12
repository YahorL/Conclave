import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "ws-token";

describe("WebSocket push", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  async function listen(): Promise<{ mailbox: Mailbox; port: number }> {
    const dir = mkdtempSync(join(tmpdir(), "conclave-ws-"));
    const mailbox = new Mailbox(openDb(join(dir, "test.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return { mailbox, port };
  }

  it("rejects a bad token", async () => {
    const { port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on("error", () => resolve(true));
      ws.on("open", () => resolve(false));
    });
    expect(failed).toBe(true);
  });

  it("pushes message and thread events", async () => {
    const { mailbox, port } = await listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    const frames: unknown[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));

    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    mailbox.appendMessage(t.id, {
      from: "claude-code", to: [], type: "text", body: "hello room", artifacts: [],
    });
    mailbox.setVerdict(t.id, "claude-code", "approve");

    await new Promise((resolve) => setTimeout(resolve, 200));
    ws.close();

    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ body: "hello room" }),
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "thread",
        thread: expect.objectContaining({ state: "settled" }),
      }),
    );
  });
});
