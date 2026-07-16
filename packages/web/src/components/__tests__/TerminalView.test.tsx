import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => {
  const term = {
    loadAddon: vi.fn(), open: vi.fn(), write: vi.fn(), dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })), cols: 80, rows: 24,
  };
  return {
    term,
    // Regular functions (not arrows) so `new Terminal()` works under vitest's mock.
    Terminal: vi.fn(function Terminal() { return term; }),
    FitAddon: vi.fn(function FitAddon() { return { fit: vi.fn() }; }),
    sendFrame: vi.fn((_frame: unknown) => true),
    handlers: new Set<(f: unknown) => void>(),
  };
});
vi.mock("@xterm/xterm", () => ({ Terminal: mocks.Terminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: mocks.FitAddon }));
vi.mock("../../lib/socket.js", () => ({
  sendFrame: mocks.sendFrame,
  onTermFrame: (fn: (f: unknown) => void) => {
    mocks.handlers.add(fn);
    return () => mocks.handlers.delete(fn);
  },
}));

import { TerminalView } from "../TerminalView.js";

const TERM = {
  id: "t1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("TerminalView", () => {
  beforeEach(() => {
    useConclaveStore.getState().reset();
    mocks.sendFrame.mockClear();
    mocks.term.write.mockClear();
    useConclaveStore.getState().setTerminals([TERM]);
    useConclaveStore.getState().setActiveTerminal("t1");
  });

  it("attaches on mount, writes replay + live data for its terminal only", () => {
    render(<TerminalView />);
    const attach = mocks.sendFrame.mock.calls.find((c) => (c[0] as { type: string }).type === "term-attach")?.[0] as {
      terminalId: string; requestId: string };
    expect(attach.terminalId).toBe("t1");

    for (const fn of mocks.handlers) {
      fn({ type: "term-replay", terminalId: "t1", requestId: attach.requestId, data: "aGk=" });
      fn({ type: "term-data", terminalId: "OTHER", data: "eA==" });
      fn({ type: "term-data", terminalId: "t1", data: "eSE=" });
    }
    expect(mocks.term.write).toHaveBeenCalledTimes(2);
  });

  it("shows the label and an exited notice on term-exit", () => {
    render(<TerminalView />);
    expect(screen.getByText("sh · you")).toBeInTheDocument();
    act(() => {
      for (const fn of mocks.handlers) fn({ type: "term-exit", terminalId: "t1", exitCode: 0 });
    });
    expect(screen.getByText(/exited/)).toBeInTheDocument();
  });

  it("discards term-data before the matching term-replay, then writes replay + post-replay data", () => {
    render(<TerminalView />);
    const attach = mocks.sendFrame.mock.calls.find((c) => (c[0] as { type: string }).type === "term-attach")?.[0] as {
      requestId: string };
    act(() => {
      for (const fn of mocks.handlers) {
        fn({ type: "term-data", terminalId: "t1", data: "cHJl" }); // "pre" — before replay, must be dropped
        fn({ type: "term-replay", terminalId: "t1", requestId: attach.requestId, data: "aGk=" });
        fn({ type: "term-data", terminalId: "t1", data: "eSE=" }); // post-replay, must be written
      }
    });
    // only the replay + the post-replay live data, never the pre-replay byte
    expect(mocks.term.write).toHaveBeenCalledTimes(2);
  });

  it("shows a connection-lost notice when the terminal vanishes from the list without an exit", () => {
    render(<TerminalView />);
    expect(screen.queryByTestId("terminal-lost")).toBeNull();
    act(() => {
      useConclaveStore.getState().setTerminals([]);
    });
    expect(screen.getByTestId("terminal-lost")).toBeInTheDocument();
  });
});
