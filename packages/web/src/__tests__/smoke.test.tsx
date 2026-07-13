import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.js";

// App mounts startSync() which opens a socket and hydrates over fetch.
// Stub both so the shell renders inertly in jsdom.
class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/registry")) return new Response(JSON.stringify({ agents: [] }));
      if (u.includes("/api/usage/summary"))
        return new Response(JSON.stringify({ perAgent: [], totalCostUsd: 0, budgetUsd: 25 }));
      return new Response("[]");
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

it("renders the app shell with all regions", () => {
  render(<App />);
  expect(screen.getByTestId("app-root")).toBeInTheDocument();
  expect(screen.getByTestId("window-strip")).toBeInTheDocument();
  expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  expect(screen.getByTestId("group-chat")).toBeInTheDocument();
  expect(screen.getByTestId("status-strip")).toBeInTheDocument();
});
