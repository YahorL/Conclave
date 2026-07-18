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
});
