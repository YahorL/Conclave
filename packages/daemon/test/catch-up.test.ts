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
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { runCatchUp } from "../src/agent-loop.js";
import { HubSocket } from "../src/hub-socket.js";

const TOKEN = "cu-token";

describe("catch-up", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function liveHub() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-cu-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return {
      mailbox,
      dir,
      url: `http://127.0.0.1:${port}`,
      client: new HubClient(`http://127.0.0.1:${port}`, TOKEN),
    };
  }

  it("replays only messages after the cursor", async () => {
    const { mailbox, dir, client } = await liveHub();
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "old", artifacts: [] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "new1", artifacts: [] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "new2", artifacts: [] });

    const state = new DaemonState(join(dir, "state.json"));
    state.setCursor(m1.id);
    const seen: string[] = [];
    const count = await runCatchUp(client, state, (m) => seen.push(m.body));
    expect(count).toBe(2);
    expect(seen).toEqual(["new1", "new2"]);
  });

  it("buffers live frames until onOpen completes", async () => {
    const { mailbox, url } = await liveHub();
    const order: string[] = [];
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((r) => (releaseOpen = r));

    const socket = new HubSocket({
      hubUrl: url,
      token: TOKEN,
      onOpen: async () => {
        order.push("open-start");
        await openGate;
        order.push("open-done");
      },
      onMessage: (m: Message) => order.push(`msg:${m.body}`),
    });
    socket.start();
    // wait for onOpen to begin
    await new Promise((r) => setTimeout(r, 400));
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "text", body: "during", artifacts: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(["open-start"]); // buffered, not delivered
    releaseOpen();
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(["open-start", "open-done", "msg:during"]);
    socket.stop();
  }, 15_000);
});
