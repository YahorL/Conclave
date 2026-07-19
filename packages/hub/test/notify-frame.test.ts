import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer, type HubApp } from "../src/server.js";

const TOKEN = "t0";

interface Frame {
  type: string;
  payload?: { title?: string; url?: string };
}

describe("broadcastNotify", () => {
  let app: HubApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("sends a notify frame to connected ws sockets", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-notifyframe-")), "t.db"));
    const mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const seen: Frame[] = [];
    ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Frame));
    await new Promise((r) => ws.on("open", r));

    app.broadcastNotify({ title: "t", body: "b", url: "/?thread=th1", tag: "x" });
    await new Promise((r) => setTimeout(r, 50));

    const notify = seen.find((f) => f.type === "notify");
    expect(notify).toBeDefined();
    expect(notify!.payload).toMatchObject({ title: "t", url: "/?thread=th1" });
    ws.close();
  });

  it("delivers the notify frame to every connected socket (broadcast fan-out)", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-notifyframe-")), "t.db"));
    const mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const connect = async (): Promise<{ ws: WebSocket; seen: Frame[] }> => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
      const seen: Frame[] = [];
      ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Frame));
      await new Promise((r) => ws.on("open", r));
      return { ws, seen };
    };

    const a = await connect();
    const b = await connect();

    app.broadcastNotify({ title: "t", body: "b", url: "/?thread=th2", tag: "x" });
    await new Promise((r) => setTimeout(r, 50));

    for (const c of [a, b]) {
      const notify = c.seen.find((f) => f.type === "notify");
      expect(notify).toBeDefined();
      expect(notify!.payload).toMatchObject({ title: "t", url: "/?thread=th2" });
    }
    a.ws.close();
    b.ws.close();
  });

  // Coverage note: broadcastNotify routes through the internal `broadcastRaw`
  // helper, which wraps each `socket.send` in a per-socket try/catch so one
  // throwing socket cannot abort delivery to the rest. A synchronous throw
  // cannot be reliably provoked through the real `ws` public API — `ws.send()`
  // on a CLOSING/CLOSED socket reports the failure via its callback / an
  // 'error' event rather than throwing synchronously, and `wsSockets` has no
  // injection point for a fake throwing socket. The fan-out test above proves
  // every registered socket is visited; the try/catch guarantees a throw at one
  // does not skip the others.
});
