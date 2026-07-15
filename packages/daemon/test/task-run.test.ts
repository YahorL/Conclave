import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, Task } from "@conclave/shared";
import { AgentLoop } from "../src/agent-loop.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { HubClient } from "../src/hub-client.js";
import type { RuntimeAdapter, TurnResult } from "../src/adapter.js";

const AGENT: AgentConfig = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1",
  workspace: "/tmp/ws", role: "", allowedTools: [], dangerousActions: [],
};

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1", threadId: "th1", assignee: "codex", spec: "add tests", state: "queued",
    artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z", ...over,
  };
}

function fakeHub() {
  const states: string[] = [];
  const messages: string[] = [];
  const hub = {
    setTaskState: vi.fn(async (_id: string, s: string) => { states.push(s); }),
    postMessage: vi.fn(async (_t: string, m: { body: string }) => { messages.push(m.body); }),
    postUsage: vi.fn(async () => undefined),
    postStatus: vi.fn(async () => undefined),
    listTasks: vi.fn(async () => []),
  } as unknown as HubClient;
  return { hub, states, messages };
}

function loopWith(adapter: RuntimeAdapter, hub: HubClient): AgentLoop {
  const dir = mkdtempSync(join(tmpdir(), "conclave-taskrun-"));
  return new AgentLoop({
    agents: [AGENT], hub, adapters: { codex: adapter }, state: new DaemonState(join(dir, "s.json")),
    queue: new TurnQueue(), hubUrl: "http://h", token: "t", allowAgentTriggers: false,
    bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
  });
}

describe("daemon task execution", () => {
  it("runs a queued task: running -> done, posts the result", async () => {
    const result: TurnResult = { sessionId: "s", text: "done: added tests", isError: false, costUsd: 0 };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, states, messages } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleTask(task());
    await loop.idle();
    expect(states).toEqual(["running", "done"]);
    expect(messages).toContain("done: added tests");
  });

  it("marks failed on an error result", async () => {
    const result: TurnResult = { sessionId: "s", text: "boom", isError: true, costUsd: 0 };
    const adapter: RuntimeAdapter = { runTurn: vi.fn(async () => result) };
    const { hub, states } = fakeHub();
    const loop = loopWith(adapter, hub);
    loop.handleTask(task());
    await loop.idle();
    expect(states).toEqual(["running", "failed"]);
  });

  it("runs a double-delivered task only once (dedupe)", async () => {
    const result: TurnResult = { sessionId: "s", text: "ok", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async () => result);
    const { hub } = fakeHub();
    const loop = loopWith({ runTurn }, hub);
    loop.handleTask(task());
    loop.handleTask(task());
    await loop.idle();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("ignores tasks for agents on other machines", async () => {
    const runTurn = vi.fn();
    const { hub } = fakeHub();
    const loop = loopWith({ runTurn }, hub);
    loop.handleTask(task({ assignee: "someone-else" }));
    await loop.idle();
    expect(runTurn).not.toHaveBeenCalled();
  });
});
