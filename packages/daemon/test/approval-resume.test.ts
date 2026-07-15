import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, Approval, Task } from "@conclave/shared";
import { AgentLoop, buildApprovalResumePrompt, buildTaskPrompt } from "../src/agent-loop.js";
import { DaemonState } from "../src/daemon-state.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { HubClient } from "../src/hub-client.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";

const AGENT: AgentConfig = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1",
  workspace: "/tmp/ws", role: "", allowedTools: [], dangerousActions: ["deploys"],
};

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", taskId: "t1", requestedBy: "codex",
    action: "run deploy.sh", idempotencyKey: "k1", state: "approved",
    createdAt: "2026-07-14T10:00:00Z", decidedAt: "2026-07-14T10:05:00Z", ...over,
  };
}

function fakeHub(taskState: () => string) {
  const states: string[] = [];
  const hub = {
    setTaskState: vi.fn(async (_id: string, s: string) => { states.push(s); }),
    postMessage: vi.fn(async () => undefined),
    postUsage: vi.fn(async () => undefined),
    postStatus: vi.fn(async () => undefined),
    getTask: vi.fn(async (): Promise<Task> => ({
      id: "t1", threadId: "th1", assignee: "codex", spec: "deploy the app",
      state: taskState() as Task["state"], artifacts: [],
      createdAt: "2026-07-14T09:00:00Z", updatedAt: "2026-07-14T10:00:00Z",
    })),
  } as unknown as HubClient;
  return { hub, states };
}

function makeLoop(adapter: RuntimeAdapter, hub: HubClient): { loop: AgentLoop; state: DaemonState } {
  const state = new DaemonState(join(mkdtempSync(join(tmpdir(), "conclave-ares-")), "s.json"));
  const loop = new AgentLoop({
    agents: [AGENT], hub, adapters: { codex: adapter }, state,
    queue: new TurnQueue(), hubUrl: "http://h", token: "t", allowAgentTriggers: false,
    bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
  });
  return { loop, state };
}

describe("approval resume", () => {
  it("resumes the stored session with the decision prompt and finishes the task", async () => {
    const result: TurnResult = { sessionId: "s1", text: "deployed", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async (_opts: TurnOptions) => result);
    const { hub, states } = fakeHub(() => "running");
    const { loop, state } = makeLoop({ runTurn }, hub);
    state.setSession("th1", "codex", "s1");

    loop.handleApproval(approval());
    await loop.idle();

    expect(runTurn).toHaveBeenCalledOnce();
    const opts = runTurn.mock.calls[0]![0] as { prompt: string; sessionId?: string };
    expect(opts.sessionId).toBe("s1");
    expect(opts.prompt).toContain("was approved");
    expect(opts.prompt).toContain("run deploy.sh");
    expect(states).toEqual(["done"]);
  });

  it("includes the note on denial and still resumes", async () => {
    const result: TurnResult = { sessionId: "s1", text: "ok, skipped", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async (_opts: TurnOptions) => result);
    const { hub } = fakeHub(() => "running");
    const { loop, state } = makeLoop({ runTurn }, hub);
    state.setSession("th1", "codex", "s1");
    loop.handleApproval(approval({ state: "denied", note: "not in prod" }));
    await loop.idle();
    const opts = runTurn.mock.calls[0]![0] as { prompt: string };
    expect(opts.prompt).toContain("was denied: not in prod");
  });

  it("falls back to full task prompt when no session is stored", async () => {
    const result: TurnResult = { sessionId: "s2", text: "done", isError: false, costUsd: 0 };
    const runTurn = vi.fn(async (_opts: TurnOptions) => result);
    const { hub } = fakeHub(() => "running");
    const { loop } = makeLoop({ runTurn }, hub);
    loop.handleApproval(approval());
    await loop.idle();
    const opts = runTurn.mock.calls[0]![0] as { prompt: string; sessionId?: string };
    expect(opts.sessionId).toBeUndefined();
    expect(opts.prompt).toContain("deploy the app"); // task spec included
    expect(opts.prompt).toContain("was approved");
  });

  it("ignores pending, task-less, duplicate, and foreign approvals", async () => {
    const runTurn = vi.fn();
    const { hub } = fakeHub(() => "running");
    const { loop } = makeLoop({ runTurn }, hub);
    loop.handleApproval(approval({ state: "pending" }));
    loop.handleApproval(approval({ id: "a2", taskId: undefined }));
    loop.handleApproval(approval({ id: "a3", requestedBy: "someone-else" }));
    loop.handleApproval(approval());
    loop.handleApproval(approval()); // duplicate id a1
    await loop.idle();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("skips resume when the task is no longer running", async () => {
    const runTurn = vi.fn();
    const { hub } = fakeHub(() => "done");
    const { loop } = makeLoop({ runTurn }, hub);
    loop.handleApproval(approval());
    await loop.idle();
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("dangerous-actions prompt clause", () => {
  it("buildTaskPrompt lists dangerousActions and names request_approval", () => {
    const p = buildTaskPrompt(AGENT, {
      id: "t1", threadId: "th1", assignee: "codex", spec: "deploy", state: "queued",
      artifacts: [], createdAt: "2026-07-14T09:00:00Z", updatedAt: "2026-07-14T09:00:00Z",
    });
    expect(p).toContain("request_approval");
    expect(p).toContain("deploys");
  });

  it("buildApprovalResumePrompt renders both decisions", () => {
    expect(buildApprovalResumePrompt(approval())).toContain('was approved');
    expect(buildApprovalResumePrompt(approval({ state: "denied", note: "no" }))).toContain("was denied: no");
  });
});
