import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";

// Real xterm cannot run under jsdom (matchMedia/canvas) — same mocks as
// components/__tests__/TerminalView.test.tsx (steering to the terminals tab
// with an active terminal mounts TerminalView).
const mocks = vi.hoisted(() => {
  const term = {
    loadAddon: vi.fn(), open: vi.fn(), write: vi.fn(), dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })), cols: 80, rows: 24,
  };
  return {
    Terminal: vi.fn(function Terminal() { return term; }),
    FitAddon: vi.fn(function FitAddon() { return { fit: vi.fn() }; }),
  };
});
vi.mock("@xterm/xterm", () => ({ Terminal: mocks.Terminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: mocks.FitAddon }));
vi.mock("../../../lib/socket.js", () => ({
  sendFrame: vi.fn(() => true),
  onTermFrame: vi.fn(() => () => {}),
}));

import { MobileShell } from "../MobileShell.js";

vi.mock("../../../lib/hubClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/hubClient.js")>();
  return {
    ...mod,
    hubClient: { ...mod.hubClient, listMessages: vi.fn().mockResolvedValue([]), listMachines: vi.fn().mockResolvedValue([]) },
  };
});

describe("MobileShell", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("renders the workspace screen and tab bar initially", () => {
    render(<MobileShell />);
    expect(screen.getByTestId("mobile-shell")).toBeTruthy();
    expect(screen.getByTestId("workspace-screen")).toBeTruthy();
    expect(screen.getByTestId("mobile-tab-bar")).toBeTruthy();
  });

  it("switches screens via the tab bar", () => {
    render(<MobileShell />);
    fireEvent.click(screen.getByTestId("mobile-tab-status"));
    expect(screen.getByTestId("status-screen")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-tab-terminals"));
    expect(screen.getByTestId("terminals-screen")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-tab-chats"));
    expect(screen.getByTestId("chats-screen")).toBeTruthy();
  });

  it("shows the pending-approval badge on the Chats tab", () => {
    useConclaveStore.setState({
      approvalsById: {
        a1: { id: "a1", threadId: "th-1", state: "pending" },
        a2: { id: "a2", threadId: "th-2", state: "pending" },
        a3: { id: "a3", threadId: "th-1", state: "approved" },
      } as never,
    });
    render(<MobileShell />);
    expect(screen.getByTestId("mobile-chats-badge").textContent).toBe("2");
  });

  it("store steering moves the shell to the right tab", () => {
    render(<MobileShell />);
    act(() => useConclaveStore.getState().setActiveTerminal("t-x"));
    expect(screen.getByTestId("terminals-screen")).toBeTruthy();
  });
});
