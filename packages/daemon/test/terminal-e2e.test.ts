import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { GrantStore } from "../src/grants.js";
import { HubSocket } from "../src/hub-socket.js";
import { loadPty, TerminalService } from "../src/terminal-service.js";
import { wireTerminals } from "../src/terminal-wiring.js";

const TOKEN = "term-e2e-token";
const ptyMod = await loadPty();

// Array.prototype.findLast needs lib es2023; the repo targets ES2022.
function lastListFrame(seen: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  for (let i = seen.length - 1; i >= 0; i--) {
    if (seen[i]!["type"] === "terminal-list") return seen[i];
  }
  return undefined;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!ptyMod)("terminal end-to-end: browser-like client ↔ hub ↔ daemon pty", () => {
  let app: FastifyInstance;
  let daemonSocket: HubSocket;
  let client: WebSocket;

  afterEach(async () => {
    daemonSocket.stop();
    client.close();
    await app.close();
  });

  it("spawn → list → attach/replay → echo → kill → exit", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-te2e-")), "t.db"));
    app = await buildServer({ mailbox: new Mailbox(db), token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;

    // daemon side, wired exactly like main.ts
    const dir = mkdtempSync(join(tmpdir(), "conclave-te2e-w-"));
    const grantsFile = join(dir, "grants.json");
    writeFileSync(grantsFile, JSON.stringify({ files: [dir], terminals: true }));
    const grants = new GrantStore(grantsFile);
    const service = new TerminalService(ptyMod!, grants, {
      machine: "m1", shellBin: "/bin/sh", claudeBin: "claude", codexBin: "codex",
    });
    let terminals!: ReturnType<typeof wireTerminals>;
    daemonSocket = new HubSocket({
      hubUrl, token: TOKEN,
      onOpen: () => {
        daemonSocket.send({ type: "hello", machine: "m1", files: grants.roots(), terminals: true });
        terminals.sendList();
      },
      onMessage: () => {},
      onTerm: (f) => terminals.onTerm(f),
    });
    terminals = wireTerminals({ service, granted: true, send: (f) => daemonSocket.send(f) });
    daemonSocket.start();

    // browser-like client — listener attached before open so the hub's
    // terminal-list snapshot-on-connect is captured, not missed.
    const seen: Array<Record<string, unknown>> = [];
    client = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    client.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>((resolve) => client.on("open", () => resolve()));

    // the daemon socket connects asynchronously — wait until its hello
    // registered machine m1 with the hub before spawning via REST.
    await waitFor(async () => {
      const res = await fetch(`${hubUrl}/api/machines`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const machines = (await res.json()) as Array<{ machine: string; terminals: boolean }>;
      return machines.some((m) => m.machine === "m1" && m.terminals);
    });

    // spawn via REST
    const spawnRes = await fetch(`${hubUrl}/api/terminals`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ machine: "m1", kind: "shell", cwd: dir }),
    });
    expect(spawnRes.status).toBe(202);

    await waitFor(() => seen.some((f) =>
      f["type"] === "terminal-list" && (f["terminals"] as unknown[]).length === 1));
    const list = lastListFrame(seen) as unknown as { terminals: Array<{ id: string }> };
    const id = list.terminals[0]!.id;

    // attach → replay arrives (possibly empty), then echo round-trip
    client.send(JSON.stringify({ type: "term-attach", terminalId: id, requestId: "r1" }));
    await waitFor(() => seen.some((f) => f["type"] === "term-replay" && f["requestId"] === "r1"));

    client.send(JSON.stringify({
      type: "term-data", terminalId: id,
      data: Buffer.from("echo e2e-round-trip\n").toString("base64"),
    }));
    await waitFor(() => seen.filter((f) => f["type"] === "term-data")
      .some((f) => Buffer.from(String(f["data"]), "base64").toString().includes("e2e-round-trip")));

    // kill via REST → exit + empty list. The hub also sends an empty
    // terminal-list snapshot on connect, so assert on the LATEST list frame
    // rather than "some frame is empty".
    const killRes = await fetch(`${hubUrl}/api/terminals/${id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(killRes.status).toBe(200);
    await waitFor(() => seen.some((f) => f["type"] === "term-exit"));
    await waitFor(() => {
      const last = lastListFrame(seen);
      return last !== undefined && (last["terminals"] as unknown[]).length === 0;
    });
  }, 20000);
});
