import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, Message } from "@conclave/shared";
import { AgentLoop, parseResetTime } from "../src/agent-loop.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { HubClient } from "../src/hub-client.js";
import type { RuntimeAdapter, TurnResult } from "../src/adapter.js";

const AGENT: AgentConfig = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1",
  workspace: "/tmp/ws", role: "", allowedTools: [],
};

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 1, threadId: "t1", from: "you", to: ["codex"], type: "text",
    body: "hi", artifacts: [], ts: new Date().toISOString(), ...over,
  };
}

interface RecordedStatus {
  status: string;
  activity: string;
  resetsAt?: string;
}

function fakeHub(): { hub: HubClient; statuses: RecordedStatus[] } {
  const statuses: RecordedStatus[] = [];
  const hub = {
    postStatus: vi.fn(async (r: RecordedStatus) => {
      statuses.push({ status: r.status, activity: r.activity, resetsAt: r.resetsAt });
    }),
    postMessage: vi.fn(async () => undefined),
    postUsage: vi.fn(async () => undefined),
  } as unknown as HubClient;
  return { hub, statuses };
}

function loopWith(adapter: RuntimeAdapter, hub: HubClient): AgentLoop {
  const dir = mkdtempSync(join(tmpdir(), "conclave-status-loop-"));
  return new AgentLoop({
    agents: [AGENT], hub, adapters: { codex: adapter }, state: new DaemonState(join(dir, "state.json")),
    queue: new TurnQueue(), hubUrl: "http://h", token: "t", allowAgentTriggers: false,
    bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
  });
}

describe("daemon agent status reporting", () => {
  it("reports running then idle around a successful turn", async () => {
    const result: TurnResult = { sessionId: "s", text: "ok", isError: false, costUsd: 0 };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, statuses } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleMessage(msg());
    await loop.idle();
    expect(statuses.map((s) => s.status)).toEqual(["running", "idle"]);
  });

  it("reports blocked with resetsAt on a rate-limit error", async () => {
    const result: TurnResult = {
      sessionId: "s",
      text: "429 rate limit exceeded; resets at 2026-07-13T16:40:00Z",
      isError: true, costUsd: 0,
    };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, statuses } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleMessage(msg());
    await loop.idle();
    const blocked = statuses.find((s) => s.status === "blocked");
    expect(blocked?.resetsAt).toBe("2026-07-13T16:40:00Z");
  });

  it("parseResetTime extracts ISO timestamps", () => {
    expect(parseResetTime("try again at 2026-07-13T16:40:00Z")).toBe("2026-07-13T16:40:00Z");
    expect(parseResetTime("nothing here")).toBeUndefined();
  });
});
