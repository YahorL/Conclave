import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { useConclaveStore } from "../store/useConclaveStore.js";

// Full-App integration for artifacts: the ARTIFACTS sidebar lists a hydrated
// artifact, and opening it renders ArtifactView with the fetched blob text.

const ARTIFACT = {
  id: "a1", name: "idempotency-plan.md", mime: "text/markdown", size: 12, sha256: "abc",
  createdBy: "codex", createdAt: "2026-07-13T21:00:00Z",
};

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void {}
}

function seededFetch(url: string): Response {
  const u = String(url);
  if (u.includes("/api/registry")) return new Response(JSON.stringify({ agents: [] }));
  if (u.includes("/api/usage/summary")) return new Response(JSON.stringify({ perAgent: [], totalCostUsd: 0, budgetUsd: 25 }));
  if (u.includes("/api/status")) return new Response(JSON.stringify([]));
  if (u.includes(`/api/artifacts/${ARTIFACT.id}/blob`)) return new Response("# Idempotency Plan\n- 24h TTL");
  if (u.includes("/api/artifacts")) return new Response(JSON.stringify([ARTIFACT]));
  return new Response("[]");
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => seededFetch(url)));
});

afterEach(() => vi.unstubAllGlobals());

it("lists a hydrated artifact and opens it read-only", async () => {
  render(<App />);
  // Sidebar row appears after hydrate.
  expect(await screen.findByText("idempotency-plan.md")).toBeInTheDocument();

  // Open it (as a click would) and confirm the view renders the fetched blob.
  useConclaveStore.getState().setActiveArtifact(ARTIFACT.id);
  expect(await screen.findByTestId("artifact-view")).toBeInTheDocument();
  expect(await screen.findByText(/# Idempotency Plan/)).toBeInTheDocument();
});
