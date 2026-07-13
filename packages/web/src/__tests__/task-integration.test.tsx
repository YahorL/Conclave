import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { useConclaveStore } from "../store/useConclaveStore.js";

// Full-App integration for a delegated task: mounts the real App with a seeded
// task thread + task frame and asserts the task state + spec render through the
// real store -> component pipeline. CI-safe complement to a live daemon run.

const THREAD_ID = "task-thread-1";

const SEED = {
  threads: [
    { id: THREAD_ID, kind: "task", workspace: "payments-service", participants: ["codex", "you"], state: "open", verdicts: {}, createdAt: "2026-07-13T21:00:00Z" },
  ],
  registry: {
    agents: [{ id: "codex", name: "codex", runtime: "codex", machine: "local", workspace: "/tmp/ws", role: "", allowedTools: [] }],
  },
  messages: [
    { id: 1, threadId: THREAD_ID, from: "you", to: [], type: "text", body: "add a unit test for the parser", artifacts: [], ts: "2026-07-13T21:00:30Z" },
  ],
};

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void {}
}

function seededFetch(url: string): Response {
  const u = String(url);
  if (u.includes("/api/registry")) return new Response(JSON.stringify(SEED.registry));
  if (u.includes("/api/usage/summary")) return new Response(JSON.stringify({ perAgent: [], totalCostUsd: 0, budgetUsd: 25 }));
  if (u.includes("/api/status")) return new Response(JSON.stringify([]));
  if (u.includes(`/api/threads/${THREAD_ID}/messages`)) return new Response(JSON.stringify(SEED.messages));
  if (u.includes("/api/threads")) return new Response(JSON.stringify(SEED.threads));
  return new Response("[]");
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => seededFetch(url)));
});

afterEach(() => vi.unstubAllGlobals());

it("renders a delegated task thread with live task state", async () => {
  render(<App />);
  // Spec message renders in the task thread.
  expect(await screen.findByText("add a unit test for the parser")).toBeInTheDocument();

  // A task frame (as the WS would deliver) advances the toolbar state to running.
  useConclaveStore.getState().applyFrame({
    type: "task",
    task: {
      id: "task1", threadId: THREAD_ID, assignee: "codex", spec: "x", state: "running",
      artifacts: [], createdAt: "2026-07-13T21:00:00Z", updatedAt: "2026-07-13T21:00:00Z",
    },
  });
  expect(await screen.findByText(/task: running/)).toBeInTheDocument();
});
