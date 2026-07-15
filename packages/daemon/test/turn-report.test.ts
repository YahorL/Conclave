import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentConfig } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { listUsage } from "@conclave/hub/src/usage.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import { AgentLoop } from "../src/agent-loop.js";

const TOKEN = "rep-token";
const AGENT: AgentConfig = {
  id: "codex", name: "Codex", runtime: "codex", machine: "m",
  workspace: "/tmp/ws", role: "", allowedTools: [], dangerousActions: [],
};

class ScriptedAdapter implements RuntimeAdapter {
  constructor(private readonly result: TurnResult) {}
  async runTurn(_opts: TurnOptions): Promise<TurnResult> {
    return this.result;
  }
}

describe("turn reporting", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function setup(result: TurnResult) {
    const dir = mkdtempSync(join(tmpdir(), "conclave-rep-"));
    const db = openDb(join(dir, "t.db"));
    const mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN, db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const loop = new AgentLoop({
      agents: [AGENT], hub: new HubClient(hubUrl, TOKEN),
      adapters: { codex: new ScriptedAdapter(result), "claude-code": new ScriptedAdapter(result) },
      state: new DaemonState(join(dir, "state.json")), queue: new TurnQueue(),
      hubUrl, token: TOKEN, allowAgentTriggers: false,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    return { mailbox, db, loop };
  }

  it("posts usage rows for successful turns with tokens", async () => {
    const { mailbox, db, loop } = await setup({
      sessionId: "s", text: "fine", isError: false, costUsd: 0.02,
      tokens: { input: 50, output: 9 },
    });
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "codex", sinceMessageId: 0 });
    await loop.idle();
    const rows = listUsage(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "codex", threadId: t.id, inputTokens: 50, outputTokens: 9, costUsd: 0.02,
    });
    expect(mailbox.listMessages(t.id).map((m) => m.body)).toContain("fine");
  });

  it("posts rate-limited status instead of a reply on error results", async () => {
    const { mailbox, loop } = await setup({
      sessionId: "s", text: "usage limit reached, resets 16:00", isError: true, costUsd: 0,
    });
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "codex", sinceMessageId: 0 });
    await loop.idle();
    const messages = mailbox.listMessages(t.id);
    const status = messages.find((m) => m.type === "status");
    expect(status!.body).toContain("agent codex rate-limited:");
    expect(messages.filter((m) => m.type === "text")).toHaveLength(0);
  });

  it("posts plain error status for non-rate-limit errors", async () => {
    const { mailbox, loop } = await setup({
      sessionId: "s", text: "segfault in tool", isError: true, costUsd: 0,
    });
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "codex", sinceMessageId: 0 });
    await loop.idle();
    const status = mailbox.listMessages(t.id).find((m) => m.type === "status");
    expect(status!.body).toContain("agent codex error:");
  });
});
