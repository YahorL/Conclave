import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentConfig, Message } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import {
  AgentLoop, HUB_MCP_TOOLS, buildTurnPrompt, shouldTrigger,
} from "../src/agent-loop.js";

const TOKEN = "al-token";

const AGENT: AgentConfig = {
  id: "claude-code", name: "Claude Code", runtime: "claude-code",
  machine: "dev-box", workspace: "/tmp/agent-ws", role: "You are the dev agent.",
  allowedTools: ["Read"], dangerousActions: [],
};

function msg(partial: Partial<Message>): Message {
  return {
    id: 1, threadId: "t1", from: "you", to: ["claude-code"],
    type: "text", body: "hi", artifacts: [], ts: new Date().toISOString(),
    ...partial,
  };
}

describe("shouldTrigger", () => {
  it("fires only for text/proposal addressed to the agent, not its own", () => {
    expect(shouldTrigger(AGENT, msg({}))).toBe(true);                                   // you → claude-code
    expect(shouldTrigger(AGENT, msg({ to: ["someone-else"] }))).toBe(false);            // not addressed
    expect(shouldTrigger(AGENT, msg({ from: "claude-code", to: ["claude-code"] }))).toBe(false); // own message
    expect(shouldTrigger(AGENT, msg({ type: "status" }))).toBe(false);                  // wrong type
    expect(shouldTrigger(AGENT, msg({ from: "codex" }))).toBe(true);                    // agent → agent now triggers
    expect(shouldTrigger(AGENT, msg({ type: "proposal" }))).toBe(true);
  });
});

describe("buildTurnPrompt", () => {
  it("includes role and tool hint on first turn only", () => {
    const first = buildTurnPrompt(AGENT, msg({}), true);
    expect(first).toContain("You are the dev agent.");
    expect(first).toContain("claude-code");
    expect(first).toContain("send_message");
    expect(first).toContain("hi");
    const later = buildTurnPrompt(AGENT, msg({ body: "again" }), false);
    expect(later).not.toContain("You are the dev agent.");
    expect(later).toContain("[you]: again");
  });
});

class FakeAdapter implements RuntimeAdapter {
  calls: TurnOptions[] = [];
  failNext = false;

  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    this.calls.push(opts);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated CLI crash");
    }
    return {
      sessionId: opts.sessionId ?? "fake-sess-1",
      text: "my rebuttal",
      isError: false,
      costUsd: 0.01,
    };
  }
}

describe("AgentLoop end-to-end (live hub, fake adapter)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-al-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const adapter = new FakeAdapter();
    const loop = new AgentLoop({
      agents: [AGENT],
      hub: new HubClient(hubUrl, TOKEN),
      adapters: { "claude-code": adapter, codex: adapter },
      state: new DaemonState(join(dir, "state.json")),
      queue: new TurnQueue(),
      hubUrl,
      token: TOKEN,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    return { mailbox, adapter, loop };
  }

  it("runs a turn and posts the reply; resumes on the second turn", async () => {
    const { mailbox, adapter, loop } = await setup();
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "first ask", artifacts: [],
    });

    loop.handleMessage(m1);
    await loop.idle();

    const bodies = mailbox.listMessages(t.id).map((m) => m.body);
    expect(bodies.some((b) => b.includes("first ask"))).toBe(true);
    expect(adapter.calls[0]!.sessionId).toBeUndefined();
    expect(adapter.calls[0]!.cwd).toBe("/tmp/agent-ws");
    expect(adapter.calls[0]!.allowedTools).toEqual(["Read", ...HUB_MCP_TOOLS]);
    const env = (adapter.calls[0]!.mcpServers!["hub"] as { env: Record<string, string> }).env;
    expect(env["CONCLAVE_THREAD_ID"]).toBe(t.id);
    expect(env["CONCLAVE_AGENT_ID"]).toBe("claude-code");

    const m2 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "second ask", artifacts: [],
    });
    loop.handleMessage(m2);
    await loop.idle();
    expect(adapter.calls[1]!.sessionId).toBe("fake-sess-1");
  });

  it("does not trigger on its own replies (no loops)", async () => {
    const { mailbox, adapter, loop } = await setup();
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "ask", artifacts: [],
    });
    loop.handleMessage(m1);
    await loop.idle();
    // feed the agent's own reply back through the loop, as HubSocket would
    for (const m of mailbox.listMessages(t.id)) loop.handleMessage(m);
    await loop.idle();
    expect(adapter.calls).toHaveLength(1);
  });

  it("posts a status message when a turn fails", async () => {
    const { mailbox, adapter, loop } = await setup();
    adapter.failNext = true;
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "ask", artifacts: [],
    });
    loop.handleMessage(m1);
    await loop.idle();
    const status = mailbox.listMessages(t.id).find((m) => m.type === "status");
    expect(status).toBeDefined();
    expect(status!.body).toContain("simulated CLI crash");
  });
});

describe("runTurn loop-guard", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function run(from: string): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "conclave-loopguard-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const adapter = new FakeAdapter();
    const t = mailbox.createThread({ kind: "chat", participants: ["claude-code", from] });
    const trigger = mailbox.appendMessage(t.id, {
      from, to: ["claude-code"], type: "text", body: "ping", artifacts: [],
    });
    const loop = new AgentLoop({
      agents: [AGENT], hub: new HubClient(hubUrl, TOKEN),
      adapters: { "claude-code": adapter, codex: adapter },
      state: new DaemonState(join(dir, "s.json")),
      queue: new TurnQueue(), hubUrl, token: TOKEN,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    loop.handleMessage(trigger);
    await loop.idle();
    const reply = mailbox.listMessages(t.id).find((m) => m.body === "my rebuttal");
    return reply!.to;
  }

  it("replies to a human trigger addressed back to the human", async () => {
    expect(await run("you")).toEqual(["you"]);
  });

  it("replies to an agent trigger with to:[] so it does not auto-retrigger", async () => {
    expect(await run("codex")).toEqual([]);
  });
});
