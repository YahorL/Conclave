import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSync } from "../store/sync.js";
import { useConclaveStore } from "../store/useConclaveStore.js";

const THREADS = [
  { id: "th1", kind: "chat", workspace: null, participants: ["you"], state: "open", verdicts: {}, createdAt: "2026-07-15T10:00:00Z" },
  { id: "th2", kind: "chat", workspace: null, participants: ["you"], state: "open", verdicts: {}, createdAt: "2026-07-15T10:00:00Z" },
];

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/threads/") && u.includes("/messages")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/api/threads")) return new Response(JSON.stringify(THREADS), { status: 200 });
    if (u.includes("/api/registry")) return new Response(JSON.stringify({ agents: [], acl: [] }), { status: 200 });
    if (u.includes("/api/status")) return new Response(JSON.stringify([]), { status: 200 });
    if (u.includes("/api/usage/summary")) {
      return new Response(JSON.stringify({ perAgent: [], totalCostUsd: 0, budgetUsd: 25 }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  }));
  vi.stubGlobal("WebSocket", class { close(): void {} } as unknown as typeof WebSocket);
}

describe("deep link ?thread=", () => {
  let close: (() => void) | undefined;

  beforeEach(() => {
    useConclaveStore.getState().reset();
    stubFetch();
  });

  afterEach(() => {
    close?.();
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
  });

  it("activates the thread named in the URL", async () => {
    history.replaceState(null, "", "/?thread=th2");
    close = startSync();
    await vi.waitFor(() =>
      expect(useConclaveStore.getState().activeThreadId).toBe("th2"),
    );
  });

  it("falls back to the first thread without the param", async () => {
    close = startSync();
    await vi.waitFor(() =>
      expect(useConclaveStore.getState().activeThreadId).toBe("th1"),
    );
  });

  it("hydrate auto-select does not steer the mobile tab off workspace", async () => {
    close = startSync();
    await vi.waitFor(() =>
      expect(useConclaveStore.getState().activeThreadId).toBe("th1"),
    );
    expect(useConclaveStore.getState().mobileTab).toBe("workspace");
    expect(useConclaveStore.getState().chatListOpen).toBe(false);
    expect(useConclaveStore.getState().openThreadIds).toContain("th1");
  });
});
