import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";

const term = (id: string, agentId?: string) => ({
  id, machine: "m1", kind: "claude" as const, label: `claude ⇄ w`,
  cwd: "/w", agentId, startedAt: "2026-07-15T12:00:00.000Z",
});

describe("take-over auto-open", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("activates a newly-appeared terminal matching a pending take-over and clears the marker", () => {
    const s = useConclaveStore.getState();
    s.setTerminals([term("t-old", "codex")]);
    s.setPendingTakeover({ agentId: "codex" });
    // a new terminal for codex appears
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [term("t-old", "codex"), term("t-new", "codex")] });
    expect(useConclaveStore.getState().activeTerminalId).toBe("t-new");
    expect(useConclaveStore.getState().pendingTakeover).toBeNull();
  });

  it("does not activate when no pending take-over is set", () => {
    const s = useConclaveStore.getState();
    s.setTerminals([]);
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [term("t-new", "codex")] });
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
  });

  it("ignores a new terminal whose agentId does not match the pending take-over", () => {
    const s = useConclaveStore.getState();
    s.setTerminals([]);
    s.setPendingTakeover({ agentId: "codex" });
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [term("t-new", "claude-code")] });
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
    expect(useConclaveStore.getState().pendingTakeover).not.toBeNull();
  });
});
