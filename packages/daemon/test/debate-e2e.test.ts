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
import { DebateStore } from "@conclave/hub/src/debates.js";
import { DebateOrchestrator } from "@conclave/hub/src/orchestrator.js";
import { listUsage } from "@conclave/hub/src/usage.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import { HubSocket } from "../src/hub-socket.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import { AgentLoop } from "../src/agent-loop.js";

const TOKEN = "e2e-token";

function agentCfg(id: string, runtime: AgentConfig["runtime"]): AgentConfig {
  return { id, name: id, runtime, machine: "m", workspace: `/tmp/${id}`, role: `You are ${id}.`, allowedTools: [] };
}

// Simulates a real agent: replies once, then calls end_thread (via setVerdict,
// which is what the MCP bridge's end_thread does) when the orchestrator's
// final/verdict instruction appears in the prompt.
class DebatingAdapter implements RuntimeAdapter {
  turns = 0;
  constructor(private readonly client: HubClient, private readonly agentId: string) {}

  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    this.turns += 1;
    const env = (opts.mcpServers?.["hub"] as { env: Record<string, string> }).env;
    const threadId = env["CONCLAVE_THREAD_ID"]!;
    const mustEnd =
      opts.prompt.includes("MUST call end_thread") ||
      (this.turns >= 2 && opts.prompt.includes("call end_thread with your verdict"));
    if (mustEnd) {
      await this.client.setVerdict(threadId, this.agentId, `approve (${this.agentId})`);
      return { sessionId: `${this.agentId}-s`, text: "", isError: false, costUsd: 0 };
    }
    return {
      sessionId: `${this.agentId}-s`,
      text: `${this.agentId} argues in turn ${this.turns}`,
      isError: false, costUsd: 0.01, tokens: { input: 10, output: 5 },
    };
  }
}

describe("full debate end to end", () => {
  let app: FastifyInstance;
  let socket: HubSocket | undefined;
  afterEach(async () => {
    socket?.stop();
    await app.close();
  });

  it("orchestrator + websocket + daemon loop reach settlement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-e2e-"));
    const db = openDb(join(dir, "t.db"));
    const mailbox = new Mailbox(db);
    const store = new DebateStore(db);
    const orchestrator = new DebateOrchestrator(mailbox, store, {
      turnTimeoutMs: 5000, finaleTimeoutMs: 3000,
    });
    app = await buildServer({ mailbox, token: TOKEN, db, orchestrator });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const client = new HubClient(hubUrl, TOKEN);

    const agents = [agentCfg("claude-code", "claude-code"), agentCfg("codex", "codex")];
    const loop = new AgentLoop({
      agents, hub: client,
      adapters: {
        "claude-code": new DebatingAdapter(client, "claude-code"),
        codex: new DebatingAdapter(client, "codex"),
      },
      state: new DaemonState(join(dir, "state.json")), queue: new TurnQueue(),
      hubUrl, token: TOKEN, allowAgentTriggers: false,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    socket = new HubSocket({
      hubUrl, token: TOKEN,
      onMessage: (m) => loop.handleMessage(m),
      onTurn: (turn) => loop.handleTurnRequest(turn),
    });
    socket.start();
    await new Promise((r) => setTimeout(r, 400));

    const res = await app.inject({
      method: "POST", url: "/api/debates",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        topic: "Should Conclave use tabs or spaces?",
        participants: ["claude-code", "codex"],
        minRounds: 1, maxRounds: 3,
      },
    });
    expect(res.statusCode).toBe(201);
    const rec = res.json<{ id: string; threadId: string }>();

    await orchestrator.idle();
    await loop.idle();

    const thread = mailbox.getThread(rec.threadId)!;
    expect(thread.state).toBe("settled");
    expect(thread.verdicts["claude-code"]).toContain("approve");
    expect(thread.verdicts["codex"]).toContain("approve");

    const bodies = mailbox.listMessages(rec.threadId).map((m) => m.body);
    expect(bodies.some((b) => b.includes("claude-code argues"))).toBe(true);
    expect(bodies.some((b) => b.includes("codex argues"))).toBe(true);
    expect(bodies.some((b) => b.startsWith("debate finished"))).toBe(true);

    expect(listUsage(db).length).toBeGreaterThan(0);
    expect(store.get(rec.id)!.state).toBe("settled");
  }, 60_000);
});
