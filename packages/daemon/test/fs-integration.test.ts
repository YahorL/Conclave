import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubSocket } from "../src/hub-socket.js";
import { GrantStore } from "../src/grants.js";
import { FileService } from "../src/file-service.js";

const TOKEN = "fs-int";
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe("file access: hub <-> daemon fs round-trip", () => {
  let app: FastifyInstance;
  let socket: HubSocket;
  afterEach(async () => {
    socket?.stop();
    await app?.close();
  });

  it("registers the machine and lists/reads jailed, rejects outside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsint-"));
    const db = openDb(join(dir, "t.db"));
    const mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const root = mkdtempSync(join(tmpdir(), "granted-"));
    writeFileSync(join(root, "hello.txt"), "world");
    const gf = join(mkdtempSync(join(tmpdir(), "gf-")), "grants.json");
    writeFileSync(gf, JSON.stringify({ files: [root] }));
    const svc = new FileService(new GrantStore(gf));

    socket = new HubSocket({
      hubUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      onMessage: () => undefined,
      onOpen: () => socket.send({ type: "hello", machine: "local", files: [root] }),
      onFsRequest: (req) => {
        void (async () => socket.send({ type: "fs-response", ...(await svc.handle(req)) }))();
      },
    });
    socket.start();

    // wait for the daemon's hello to register the machine
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({ method: "GET", url: "/api/machines", headers: AUTH });
      if ((res.json() as unknown[]).length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const machines = (await app.inject({ method: "GET", url: "/api/machines", headers: AUTH })).json();
    expect(machines).toMatchObject([{ machine: "local", files: [root] }]);

    const list = await app.inject({
      method: "POST", url: "/api/fs/local/list", headers: AUTH, payload: { path: root },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ name: string }>).map((e) => e.name)).toContain("hello.txt");

    const jailed = await app.inject({
      method: "POST", url: "/api/fs/local/read", headers: AUTH, payload: { path: "/etc/passwd" },
    });
    expect(jailed.statusCode).toBe(422);
  }, 20_000);
});
