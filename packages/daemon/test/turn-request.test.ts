import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentConfig, Message, TurnRequest } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubClient } from "../src/hub-client.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import { HubSocket } from "../src/hub-socket.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import { AgentLoop, buildDebatePrompt } from "../src/agent-loop.js";

const TOKEN = "tr-token";

const AGENT: AgentConfig = {
  id: "codex", name: "Codex", runtime: "codex", machine: "dev-box",
  workspace: "/tmp/codex-ws", role: "You are the skeptic.", allowedTools: [], dangerousActions: [],
};

class FakeAdapter implements RuntimeAdapter {
  calls: TurnOptions[] = [];
  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    this.calls.push(opts);
    return { sessionId: "codex-sess", text: "my rebuttal", isError: false, costUsd: 0 };
  }
}

function turnOf(threadId: string, over: Partial<TurnRequest> = {}): TurnRequest {
  return { threadId, agentId: "codex", sinceMessageId: 0, ...over };
}

describe("buildDebatePrompt", () => {
  const msg = (id: number, from: string, body: string): Message => ({
    id, threadId: "t", from, to: [], type: "text", body, artifacts: [],
    ts: new Date().toISOString(),
  });

  it("first turn carries role, intro, transcript, instruction", () => {
    const p = buildDebatePrompt(
      AGENT, turnOf("t", { instruction: "Round 1/4. Do NOT call end_thread yet" }),
      [msg(1, "you", "topic"), msg(2, "claude-code", "opening")], true,
    );
    expect(p).toContain("You are the skeptic.");
    expect(p).toContain("end_thread");
    expect(p).toContain("[you]: topic");
    expect(p).toContain("[claude-code]: opening");
    expect(p).toContain("Instruction from orchestrator: Round 1/4");
  });

  it("later turns carry only new messages and instruction", () => {
    const p = buildDebatePrompt(AGENT, turnOf("t"), [msg(3, "claude-code", "rebuttal")], false);
    expect(p).not.toContain("You are the skeptic.");
    expect(p).toContain("New messages:");
    expect(p).toContain("[claude-code]: rebuttal");
  });
});

describe("turn requests end to end", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-tr-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const adapter = new FakeAdapter();
    const state = new DaemonState(join(dir, "state.json"));
    const loop = new AgentLoop({
      agents: [AGENT], hub: new HubClient(hubUrl, TOKEN),
      adapters: { "claude-code": adapter, codex: adapter }, state,
      queue: new TurnQueue(), hubUrl, token: TOKEN, allowAgentTriggers: false,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    return { mailbox, adapter, loop, state, hubUrl };
  }

  it("runs a debate turn from a turn frame delivered over the socket", async () => {
    const { mailbox, adapter, loop, hubUrl } = await setup();
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "proposal", body: "topic", artifacts: [] });

    const socket = new HubSocket({
      hubUrl, token: TOKEN,
      onMessage: () => undefined,
      onTurn: (turn) => loop.handleTurnRequest(turn),
    });
    socket.start();
    await new Promise((r) => setTimeout(r, 400));
    mailbox.events.emit("turn", turnOf(t.id, { instruction: "argue" }));
    await new Promise((r) => setTimeout(r, 400));
    await loop.idle();
    socket.stop();

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.prompt).toContain("[you]: topic");
    expect(adapter.calls[0]!.prompt).toContain("Instruction from orchestrator: argue");
    const bodies = mailbox.listMessages(t.id).map((m) => m.body);
    expect(bodies).toContain("my rebuttal");
    const reply = mailbox.listMessages(t.id).find((m) => m.body === "my rebuttal")!;
    expect(reply.to).toEqual([]);
  }, 15_000);

  it("uses watermarks so consecutive turns only see new messages", async () => {
    const { mailbox, adapter, loop } = await setup();
    const t = mailbox.createThread({ kind: "debate", participants: ["codex"] });
    mailbox.appendMessage(t.id, { from: "you", to: [], type: "proposal", body: "first", artifacts: [] });
    loop.handleTurnRequest(turnOf(t.id));
    await loop.idle();
    mailbox.appendMessage(t.id, { from: "claude-code", to: [], type: "text", body: "second", artifacts: [] });
    loop.handleTurnRequest(turnOf(t.id));
    await loop.idle();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]!.prompt).toContain("second");
    expect(adapter.calls[1]!.prompt).not.toContain("first");
    expect(adapter.calls[1]!.sessionId).toBe("codex-sess");
  });

  it("ignores turn frames for agents it does not own", async () => {
    const { adapter, loop, mailbox } = await setup();
    const t = mailbox.createThread({ kind: "debate", participants: ["other"] });
    loop.handleTurnRequest({ threadId: t.id, agentId: "other", sinceMessageId: 0 });
    await loop.idle();
    expect(adapter.calls).toHaveLength(0);
  });
});
