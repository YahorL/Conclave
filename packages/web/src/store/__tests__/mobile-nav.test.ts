import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalInfo } from "@conclave/shared";
import { useConclaveStore } from "../useConclaveStore.js";

const term = (id: string, agentId?: string): TerminalInfo => ({
  id,
  machine: "m1",
  kind: "claude",
  label: `t-${id}`,
  cwd: "/w",
  agentId,
  startedAt: "2026-07-18T10:00:00.000Z",
});

describe("mobile navigation state", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("starts on the workspace tab with the chat list closed", () => {
    expect(useConclaveStore.getState().mobileTab).toBe("workspace");
    expect(useConclaveStore.getState().chatListOpen).toBe(false);
  });

  it("setMobileTab and setChatListOpen update state", () => {
    useConclaveStore.getState().setMobileTab("status");
    useConclaveStore.getState().setChatListOpen(true);
    expect(useConclaveStore.getState().mobileTab).toBe("status");
    expect(useConclaveStore.getState().chatListOpen).toBe(true);
  });

  it("setActiveThread steers to chats and closes the list", () => {
    useConclaveStore.getState().setChatListOpen(true);
    useConclaveStore.getState().setActiveThread("th-1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
    expect(useConclaveStore.getState().chatListOpen).toBe(false);
  });

  it("setActiveTerminal(id) steers to terminals; clearing does not steer", () => {
    useConclaveStore.getState().setActiveTerminal("t1");
    expect(useConclaveStore.getState().mobileTab).toBe("terminals");
    useConclaveStore.getState().setMobileTab("workspace");
    useConclaveStore.getState().setActiveTerminal(null);
    expect(useConclaveStore.getState().mobileTab).toBe("workspace");
  });

  it("setActiveFsFile and setActiveArtifact steer to chats only when activating", () => {
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/a.ts" });
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
    useConclaveStore.getState().setMobileTab("status");
    useConclaveStore.getState().setActiveFsFile(null);
    expect(useConclaveStore.getState().mobileTab).toBe("status");
    useConclaveStore.getState().setActiveArtifact("art-1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
    useConclaveStore.getState().setMobileTab("status");
    useConclaveStore.getState().setActiveArtifact(null);
    expect(useConclaveStore.getState().mobileTab).toBe("status");
  });

  it("takeover auto-open steers to terminals", () => {
    useConclaveStore.getState().setPendingTakeover({ agentId: "claude-code" });
    useConclaveStore.getState().applyFrame({
      type: "terminal-list",
      terminals: [term("t9", "claude-code")],
    });
    expect(useConclaveStore.getState().activeTerminalId).toBe("t9");
    expect(useConclaveStore.getState().mobileTab).toBe("terminals");
  });
});
