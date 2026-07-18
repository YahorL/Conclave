import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { WorkspaceScreen } from "../WorkspaceScreen.js";

vi.mock("../../../lib/hubClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/hubClient.js")>();
  return {
    ...mod,
    hubClient: {
      ...mod.hubClient,
      listMessages: vi.fn().mockResolvedValue([]),
      listMachines: vi.fn().mockResolvedValue([]),
    },
  };
});

function seed(): void {
  useConclaveStore.setState({
    workspacesById: {
      w1: { id: "w1", name: "payments-service", machine: "m1", folderPath: "/w", createdAt: "2026-07-18T09:00:00.000Z" },
    } as never,
    activeWorkspaceId: "w1",
    threads: [
      { id: "th-1", kind: "group", workspace: "payments-service", participants: ["you", "claude-code"], state: "open", verdicts: {}, createdAt: "2026-07-18T09:00:00.000Z" },
    ] as never,
    agents: [{ id: "claude-code", name: "claude-code", runtime: "claude", machine: "m1" }] as never,
    statusByAgent: {
      "claude-code": { agent: "claude-code", status: "running", activity: "writing migration", ts: "2026-07-18T10:00:00.000Z" },
    } as never,
    usage: { perAgent: [], totalCostUsd: 4.82, budgetUsd: 25 } as never,
    approvalsById: {
      ap1: { id: "ap1", threadId: "th-1", state: "pending" },
    } as never,
    artifactsById: {
      art1: { id: "art1", name: "idempotency plan", threadId: "th-1" },
    } as never,
  });
}

describe("WorkspaceScreen", () => {
  beforeEach(() => {
    useConclaveStore.getState().reset();
    seed();
  });

  it("shows workspace header with machine + spend sub-line", () => {
    render(<WorkspaceScreen />);
    // "payments-service" also appears as the chat-card label (thread label =
    // workspace name), so target the heading specifically.
    expect(screen.getByRole("heading", { name: "payments-service" })).toBeTruthy();
    expect(screen.getByText("m1 · $4.82 / $25 today")).toBeTruthy();
  });

  it("chat card tap activates the thread and steers to the chats tab", () => {
    render(<WorkspaceScreen />);
    fireEvent.click(screen.getByTestId("mobile-chat-th-1"));
    expect(useConclaveStore.getState().activeThreadId).toBe("th-1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
  });

  it("shows the pending-approval badge on the chat card", () => {
    render(<WorkspaceScreen />);
    expect(screen.getByTestId("mobile-approval-badge").textContent).toBe("!");
  });

  it("lists agents with status and artifacts, and opens artifacts", () => {
    render(<WorkspaceScreen />);
    expect(screen.getByText("● running")).toBeTruthy();
    fireEvent.click(screen.getByText("idempotency plan"));
    expect(useConclaveStore.getState().activeArtifactId).toBe("art1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
  });

  it("gear opens the settings modal", () => {
    render(<WorkspaceScreen />);
    fireEvent.click(screen.getByTestId("mobile-settings-open"));
    expect(screen.getByTestId("settings-backdrop")).toBeTruthy();
  });

  it("renders empty states without data", () => {
    useConclaveStore.getState().reset();
    render(<WorkspaceScreen />);
    expect(screen.getByText("no chats")).toBeTruthy();
  });
});
