import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";

const TERM = {
  id: "t1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("terminal store state", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("applyFrame terminal-list replaces the list", () => {
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [TERM] });
    expect(useConclaveStore.getState().terminals).toEqual([TERM]);
  });

  it("setActiveTerminal is exclusive with artifact/fsFile/thread views", () => {
    const s = useConclaveStore.getState();
    s.setActiveArtifact("a1");
    s.setActiveTerminal("t1");
    expect(useConclaveStore.getState().activeTerminalId).toBe("t1");
    expect(useConclaveStore.getState().activeArtifactId).toBeNull();

    useConclaveStore.getState().setActiveThread("th1");
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();

    useConclaveStore.getState().setActiveTerminal("t1");
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/x" });
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
  });
});
