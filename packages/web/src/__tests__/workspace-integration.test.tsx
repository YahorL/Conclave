import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.js";

// Full-App integration for browse-and-pick: a hydrated workspace shows as a
// window tab, and switching to the Files rail lists a connected machine.

const WORKSPACE = {
  id: "w1", name: "payments-service", machine: "local", folderPath: "/w",
  createdAt: "2026-07-13T21:00:00Z",
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
  if (u.includes("/api/workspaces")) return new Response(JSON.stringify([WORKSPACE]));
  if (u.includes("/api/machines")) return new Response(JSON.stringify([{ machine: "local", files: ["/w"], lastSeen: "x" }]));
  if (u.includes("/api/artifacts")) return new Response(JSON.stringify([]));
  return new Response("[]");
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => seededFetch(url)));
});

afterEach(() => vi.unstubAllGlobals());

it("shows a hydrated workspace tab and lists a machine in the Files rail", async () => {
  render(<App />);
  // Workspace tab from hydrate.
  expect(await screen.findByText("payments-service")).toBeInTheDocument();

  // Switch to the Files rail; the connected machine appears in the picker.
  await userEvent.click(screen.getByLabelText("files"));
  expect(await screen.findByText("local")).toBeInTheDocument();
});
