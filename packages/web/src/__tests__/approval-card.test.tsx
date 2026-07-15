import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Approval, Message } from "@conclave/shared";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { ChatMessage } from "../components/ChatMessage.js";

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", taskId: "t1", requestedBy: "codex",
    action: "run deploy.sh", idempotencyKey: "k1", state: "pending",
    createdAt: "2026-07-14T10:00:00Z", ...over,
  };
}

function requestMessage(): Message {
  return {
    id: 1, threadId: "th1", from: "codex", to: [], type: "approval-request",
    body: JSON.stringify({ approvalId: "a1", action: "run deploy.sh" }),
    artifacts: [], ts: "2026-07-14T10:00:00Z",
  };
}

describe("ApprovalCard", () => {
  beforeEach(() => {
    cleanup();
    useConclaveStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("renders a pending card with action, chip, and decide buttons", () => {
    useConclaveStore.getState().setApprovals([approval()]);
    render(<ChatMessage message={requestMessage()} />);
    expect(screen.getByTestId("approval-card")).toBeTruthy();
    expect(screen.getByText("run deploy.sh")).toBeTruthy();
    expect(screen.getByTestId("approval-state").textContent).toBe("PENDING");
    expect(screen.getByTestId("approval-approve")).toBeTruthy();
    expect(screen.getByTestId("approval-deny")).toBeTruthy();
  });

  it("renders a decided card without buttons, with the note", () => {
    useConclaveStore.getState().setApprovals([approval({ state: "denied", note: "not in prod" })]);
    render(<ChatMessage message={requestMessage()} />);
    expect(screen.getByTestId("approval-state").textContent).toBe("DENIED");
    expect(screen.queryByTestId("approval-approve")).toBeNull();
    expect(screen.getByText(/not in prod/)).toBeTruthy();
  });

  it("clicking approve posts the decision with the note", () => {
    useConclaveStore.getState().setApprovals([approval()]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(approval({ state: "approved" })), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatMessage message={requestMessage()} />);
    fireEvent.change(screen.getByTestId("approval-note"), { target: { value: "ship it" } });
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/a1/decide",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approved", note: "ship it" }) }),
    );
  });

  it("card without a store approval renders pending without buttons", () => {
    render(<ChatMessage message={requestMessage()} />);
    expect(screen.getByTestId("approval-state").textContent).toBe("PENDING");
    expect(screen.queryByTestId("approval-approve")).toBeNull();
  });
});
