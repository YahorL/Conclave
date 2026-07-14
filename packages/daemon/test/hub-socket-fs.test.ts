import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { HubSocket } from "../src/hub-socket.js";
import { GrantStore } from "../src/grants.js";
import { FileService } from "../src/file-service.js";

interface FsResp {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

describe("HubSocket fs-request round-trip", () => {
  it("answers a jailed list with fs-response", async () => {
    const root = mkdtempSync(join(tmpdir(), "hsfs-"));
    writeFileSync(join(root, "a.txt"), "hi");
    const gf = join(mkdtempSync(join(tmpdir(), "gf-")), "grants.json");
    writeFileSync(gf, JSON.stringify({ files: [root] }));
    const svc = new FileService(new GrantStore(gf));

    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    const got = new Promise<FsResp>((res) => {
      wss.on("connection", (ws) => {
        ws.on("message", (d) => res(JSON.parse(String(d)) as FsResp));
        ws.send(JSON.stringify({ type: "fs-request", id: "1", op: "list", path: root }));
      });
    });

    const socket = new HubSocket({
      hubUrl: `http://127.0.0.1:${port}`, token: "t",
      onMessage: () => undefined,
      onFsRequest: (req) => {
        void (async () => socket.send({ type: "fs-response", ...(await svc.handle(req)) }))();
      },
    });
    socket.start();
    const resp = await got;
    expect(resp).toMatchObject({ id: "1", ok: true });
    expect((resp.result as Array<{ name: string }>).map((e) => e.name)).toContain("a.txt");
    socket.stop();
    wss.close();
  });
});
