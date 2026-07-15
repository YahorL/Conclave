import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.js";

// Full-App integration: mounts the real App and drives the real
// hubClient -> store -> component pipeline with a realistic seed shaped
// exactly like the live hub responses (see packages/daemon/README.md).
// This is the CI-safe complement to the Playwright pixel diff (e2e/visual.spec.ts).

const THREAD_ID = "6c0d50bc-c388-4f85-ae8d-19d0b13df0c4";

const SEED = {
  threads: [
    { id: THREAD_ID, kind: "chat", workspace: "payments-service", participants: ["you", "claude-code", "codex", "reviewer"], state: "open", verdicts: {}, createdAt: "2026-07-13T21:00:00Z" },
  ],
  registry: {
    agents: [
      { id: "claude-code", name: "claude-code", runtime: "claude-code", machine: "local", workspace: "/tmp/ws", role: "implementer", allowedTools: [], dangerousActions: [] },
      { id: "codex", name: "codex", runtime: "codex", machine: "local", workspace: "/tmp/ws", role: "proposer", allowedTools: [], dangerousActions: [] },
      { id: "reviewer", name: "reviewer", runtime: "claude-code", machine: "local", workspace: "/tmp/ws", role: "reviewer", allowedTools: [], dangerousActions: [] },
    ],
  },
  status: [
    { agent: "claude-code", status: "running", activity: "writing migration 0043", threadId: THREAD_ID, ts: "2026-07-13T21:02:36Z" },
    { agent: "codex", status: "running", activity: "auditing retry semantics", threadId: THREAD_ID, ts: "2026-07-13T21:02:36Z" },
    { agent: "reviewer", status: "blocked", activity: "waiting on PR #612", resetsAt: "2026-07-13T16:40:00Z", ts: "2026-07-13T21:02:36Z" },
  ],
  summary: {
    perAgent: [
      { agent: "claude-code", inputTokens: 120000, outputTokens: 38000, costUsd: 2.1 },
      { agent: "codex", inputTokens: 90000, outputTokens: 24000, costUsd: 1.72 },
      { agent: "reviewer", inputTokens: 40000, outputTokens: 8000, costUsd: 1 },
    ],
    totalCostUsd: 4.82,
    budgetUsd: 25,
  },
  messages: [
    { id: 1, threadId: THREAD_ID, from: "you", to: ["claude-code", "codex"], type: "text", body: "We need idempotency keys on the charge endpoint. @claude-code propose a schema, @codex check retries.", artifacts: [], ts: "2026-07-13T21:01:00Z" },
    { id: 2, threadId: THREAD_ID, from: "claude-code", to: [], type: "proposal", body: "Proposal: keyed on (merchant_id, key). See payments/middleware/idem.ts:41\n```\nCREATE TABLE idempotency_keys (\n  merchant_id uuid NOT NULL\n);\n```", artifacts: [], ts: "2026-07-13T21:01:30Z" },
    { id: 3, threadId: THREAD_ID, from: "codex", to: [], type: "text", body: "matching TTL is right.", artifacts: [], ts: "2026-07-13T21:02:00Z" },
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
  if (u.includes("/api/usage/summary")) return new Response(JSON.stringify(SEED.summary));
  if (u.includes("/api/status")) return new Response(JSON.stringify(SEED.status));
  if (u.includes(`/api/threads/${THREAD_ID}/messages`)) return new Response(JSON.stringify(SEED.messages));
  if (u.includes("/api/threads")) return new Response(JSON.stringify(SEED.threads));
  return new Response("[]");
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => seededFetch(url)));
});

afterEach(() => vi.unstubAllGlobals());

it("hydrates the full app from hub-shaped responses and renders section-4a content", async () => {
  render(<App />);

  // Chat content (proposal badge, file link, mention chip, code block) from the message pipeline.
  expect(await screen.findByText("plan")).toBeInTheDocument();
  expect(screen.getByText("payments/middleware/idem.ts:41")).toBeInTheDocument();
  expect(screen.getByText("@claude-code")).toBeInTheDocument();
  expect(screen.getByText(/CREATE TABLE idempotency_keys/)).toBeInTheDocument();

  // Right rail: real live-status activity + cost-vs-budget footer.
  expect(screen.getByText("writing migration 0043")).toBeInTheDocument();
  expect(screen.getByText(/\$4\.82 \/ \$25/)).toBeInTheDocument();

  // Typing indicator driven by a running participant scoped to the active thread.
  // (the ▮ cursor span splits the text node, so assert on the container's text)
  expect(screen.getByTestId("group-chat").textContent).toMatch(/is thinking/);

  // Workspace label appears (window strip / sidebar / toolbar).
  expect(screen.getAllByText(/payments-service/).length).toBeGreaterThan(0);
});
