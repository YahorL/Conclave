import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Message } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubSocket } from "../src/hub-socket.js";

const TOKEN = "hs-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await sleep(25);
  }
}

describe("HubSocket", () => {
  let app: FastifyInstance;
  let socket: HubSocket | undefined;

  afterEach(async () => {
    socket?.stop();
    await app.close();
  });

  async function liveHub() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-hs-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return { mailbox, url: `http://127.0.0.1:${port}` };
  }

  it("delivers message events", async () => {
    const { mailbox, url } = await liveHub();
    const seen: Message[] = [];
    socket = new HubSocket({ hubUrl: url, token: TOKEN, onMessage: (m) => seen.push(m) });
    socket.start();
    await sleep(300); // let it connect
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "over the wire", artifacts: [],
    });
    await until(() => seen.length === 1);
    expect(seen[0]!.body).toBe("over the wire");
  });

  it("reconnects after the server restarts", async () => {
    const { mailbox, url } = await liveHub();
    const port = Number(new URL(url).port);
    const seen: Message[] = [];
    socket = new HubSocket({
      hubUrl: url, token: TOKEN, onMessage: (m) => seen.push(m), reconnectDelayMs: 100,
    });
    socket.start();
    await sleep(300);

    await app.close(); // drop the connection
    await sleep(200);

    // restart on the SAME port with a fresh hub sharing no state (new db, fine)
    const dir = mkdtempSync(join(tmpdir(), "conclave-hs2-"));
    const mailbox2 = new Mailbox(openDb(join(dir, "t2.db")));
    app = await buildServer({ mailbox: mailbox2, token: TOKEN });
    await app.listen({ port, host: "127.0.0.1" });

    await sleep(500); // allow reconnect
    const t = mailbox2.createThread({ kind: "chat", participants: ["you"] });
    mailbox2.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "after restart", artifacts: [],
    });
    await until(() => seen.some((m) => m.body === "after restart"));
    expect(mailbox).toBeDefined();
  }, 15_000);
});
