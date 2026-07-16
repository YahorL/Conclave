import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "term-test-token";

async function makeApp(): Promise<{ app: FastifyInstance; port: number }> {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-termhub-")), "t.db"));
  const app = await buildServer({ mailbox: new Mailbox(db), token: TOKEN });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, port: (app.server.address() as AddressInfo).port };
}

type Frame = Record<string, unknown>;

// The message listener is attached before the socket opens so no frame the hub
// sends on connect (e.g. the terminal-list snapshot) can slip past unobserved.
function connect(port: number): Promise<{ ws: WebSocket; seen: Frame[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
  const seen: Frame[] = [];
  ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Frame));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, seen }));
    ws.on("error", reject);
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const TERM = {
  id: "term-1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("hub terminal relay", () => {
  let app: FastifyInstance;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await app.close();
  });

  async function daemon(port: number): Promise<{ ws: WebSocket; seen: Frame[] }> {
    const { ws, seen } = await connect(port);
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "hello", machine: "m1", files: ["/w"], terminals: true }));
    ws.send(JSON.stringify({ type: "term-list", terminals: [TERM] }));
    return { ws, seen };
  }

  it("broadcasts terminal-list, routes input to the daemon, output only to attached clients", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;
    const d = await daemon(port);
    const { ws: attached, seen: attachedSeen } = await connect(port);
    const { ws: bystander, seen: bystanderSeen } = await connect(port);
    sockets.push(attached, bystander);

    await waitFor(() => attachedSeen.some((f) => f["type"] === "terminal-list"));

    attached.send(JSON.stringify({ type: "term-attach", terminalId: "term-1", requestId: "r1" }));
    await waitFor(() => d.seen.some((f) => f["type"] === "term-attach"));

    // replay goes ONLY to the requester
    d.ws.send(JSON.stringify({ type: "term-replay", terminalId: "term-1", requestId: "r1", data: "cmVwbGF5" }));
    await waitFor(() => attachedSeen.some((f) => f["type"] === "term-replay"));
    expect(bystanderSeen.some((f) => f["type"] === "term-replay")).toBe(false);

    // client input routes to the daemon
    attached.send(JSON.stringify({ type: "term-data", terminalId: "term-1", data: "aW5wdXQ=" }));
    await waitFor(() => d.seen.some((f) => f["type"] === "term-data" && f["data"] === "aW5wdXQ="));

    // daemon output reaches attached, not the bystander
    d.ws.send(JSON.stringify({ type: "term-data", terminalId: "term-1", data: "b3V0cHV0" }));
    await waitFor(() => attachedSeen.some((f) => f["type"] === "term-data" && f["data"] === "b3V0cHV0"));
    expect(bystanderSeen.some((f) => f["type"] === "term-data")).toBe(false);

    // exit is forwarded to attached clients
    d.ws.send(JSON.stringify({ type: "term-exit", terminalId: "term-1", exitCode: 0 }));
    await waitFor(() => attachedSeen.some((f) => f["type"] === "term-exit"));
  }, 15000);

  it("REST: list/spawn/kill with 403/503/404 gates", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;

    // no machine at all -> spawn 503
    let res = await app.inject({
      method: "POST", url: "/api/terminals",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", kind: "shell", cwd: "/w" },
    });
    expect(res.statusCode).toBe(503);

    const d = await daemon(port);

    // list reflects the daemon's term-list once the frames land
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });
    const listRes = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
    expect((JSON.parse(listRes.payload) as Array<{ id: string }>)[0]!.id).toBe("term-1");

    // spawn relays term-spawn to the daemon
    res = await app.inject({
      method: "POST", url: "/api/terminals",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", kind: "shell", cwd: "/w" },
    });
    expect(res.statusCode).toBe(202);
    await waitFor(() => d.seen.some((f) => f["type"] === "term-spawn"));

    // kill relays term-kill
    res = await app.inject({
      method: "DELETE", url: "/api/terminals/term-1", headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => d.seen.some((f) => f["type"] === "term-kill"));

    // unknown terminal id -> 404
    res = await app.inject({
      method: "DELETE", url: "/api/terminals/nope", headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);

    // machines list carries the capability
    res = await app.inject({ method: "GET", url: "/api/machines", headers: { authorization: `Bearer ${TOKEN}` } });
    expect((JSON.parse(res.payload) as Array<{ terminals: boolean }>)[0]!.terminals).toBe(true);
  }, 15000);

  it("403 when the machine lacks the terminals grant; daemon disconnect clears its terminals", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;
    const { ws } = await connect(port);
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "hello", machine: "m1", files: ["/w"], terminals: false }));
    ws.send(JSON.stringify({ type: "term-list", terminals: [TERM] }));

    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });

    const res = await app.inject({
      method: "POST", url: "/api/terminals",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", kind: "shell", cwd: "/w" },
    });
    expect(res.statusCode).toBe(403);

    const { ws: client, seen: clientSeen } = await connect(port);
    sockets.push(client);
    ws.close();
    await waitFor(() => clientSeen.some((f) =>
      f["type"] === "terminal-list" && (f["terminals"] as unknown[]).length === 0));
  }, 15000);

  it("POST /api/terminals/takeover relays term-takeover; 400/503/403 gates", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;

    // no machine -> 503
    let res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex", threadId: "t1" },
    });
    expect(res.statusCode).toBe(503);

    // bad body -> 400
    res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex" },
    });
    expect(res.statusCode).toBe(400);

    const d = await daemon(port); // connects m1 with terminals:true + a term-list
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });

    res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex", threadId: "t1" },
    });
    expect(res.statusCode).toBe(202);
    await waitFor(() => d.seen.some((f) =>
      f["type"] === "term-takeover" && f["agentId"] === "codex" && f["threadId"] === "t1"));
  }, 15000);

  it("takeover on an ungranted machine -> 403", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;
    const { ws } = await connect(port);
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "hello", machine: "m1", files: ["/w"], terminals: false }));
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/machines", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });
    const res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex", threadId: "t1" },
    });
    expect(res.statusCode).toBe(403);
  }, 15000);
});
