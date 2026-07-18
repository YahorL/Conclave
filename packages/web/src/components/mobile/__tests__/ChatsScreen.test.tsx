import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { ChatsScreen } from "../ChatsScreen.js";

vi.mock("../../../lib/hubClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/hubClient.js")>();
  return {
    ...mod,
    hubClient: {
      ...mod.hubClient,
      listMessages: vi.fn().mockResolvedValue([]),
      fsRead: vi.fn().mockResolvedValue({ content: "" }),
    },
  };
});

function seedThread(): void {
  useConclaveStore.setState({
    threads: [
      { id: "th-1", kind: "group", workspace: "payments-service", participants: ["you", "claude-code", "codex"], state: "open", verdicts: {}, createdAt: "2026-07-18T09:00:00.000Z" },
    ] as never,
    agents: [
      { id: "claude-code", name: "claude-code", runtime: "claude", machine: "m1" },
      { id: "codex", name: "codex", runtime: "codex", machine: "m1" },
    ] as never,
    statusByAgent: {
      "claude-code": { agent: "claude-code", status: "running", activity: "x", ts: "2026-07-18T10:00:00.000Z" },
    } as never,
  });
}

describe("ChatsScreen", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("shows the thread list when no thread is active", () => {
    seedThread();
    render(<ChatsScreen />);
    expect(screen.getByTestId("mobile-chat-list")).toBeTruthy();
  });

  it("shows the active thread with back header and live sub-line", () => {
    seedThread();
    useConclaveStore.setState({ activeThreadId: "th-1" });
    render(<ChatsScreen />);
    expect(screen.getByText("payments-service")).toBeTruthy();
    expect(screen.getByText("2 agents · 1 running")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().chatListOpen).toBe(true);
  });

  it("renders the artifact view full-screen when an artifact is active", () => {
    seedThread();
    useConclaveStore.setState({
      activeThreadId: "th-1",
      activeArtifactId: "art1",
      artifactsById: { art1: { id: "art1", name: "plan", threadId: "th-1" } } as never,
    });
    render(<ChatsScreen />);
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeArtifactId).toBeNull();
  });

  it("back from a dirty editor asks for confirmation and aborts on cancel", () => {
    seedThread();
    useConclaveStore.setState({
      activeThreadId: "th-1",
      activeFsFile: { machine: "m1", path: "/w/a.ts" },
      fsDirty: true,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ChatsScreen />);
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeFsFile).not.toBeNull();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeFsFile).toBeNull();
    confirm.mockRestore();
  });
});
