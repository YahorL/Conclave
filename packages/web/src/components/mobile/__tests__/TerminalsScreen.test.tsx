import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";

// Real xterm cannot run under jsdom (matchMedia/canvas) — same mocks as
// components/__tests__/TerminalView.test.tsx.
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

import { TerminalsScreen } from "../TerminalsScreen.js";

const term = {
  id: "t1",
  machine: "m1",
  kind: "claude" as const,
  label: "claude-code · pnpm test",
  cwd: "/w",
  agentId: "claude-code",
  startedAt: "2026-07-18T10:00:00.000Z",
};

describe("TerminalsScreen", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("lists terminals when none is active", () => {
    useConclaveStore.setState({ terminals: [term] });
    render(<TerminalsScreen />);
    expect(screen.getByTestId("terminals-section")).toBeTruthy();
    expect(screen.getByText("claude-code · pnpm test")).toBeTruthy();
  });

  it("opens the terminal view when a terminal is active, back returns to the list", () => {
    useConclaveStore.setState({ terminals: [term], activeTerminalId: "t1" });
    render(<TerminalsScreen />);
    expect(screen.getByTestId("terminal-view")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
  });
});
