import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalsSection } from "../TerminalsSection.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => ({
  listMachines: vi.fn(async () => [
    { machine: "m1", files: ["/w"], terminals: true, lastSeen: "" },
    { machine: "m2", files: ["/x"], terminals: false, lastSeen: "" },
    { machine: "m3", files: ["/x"], terminals: true, lastSeen: "" },
  ]),
  spawnTerminal: vi.fn(async () => ({ ok: true })),
  handlers: new Set<(f: unknown) => void>(),
}));
vi.mock("../../lib/hubClient.js", () => ({ hubClient: mocks }));
vi.mock("../../lib/socket.js", () => ({
  onTermFrame: (fn: (f: unknown) => void) => {
    mocks.handlers.add(fn);
    return () => mocks.handlers.delete(fn);
  },
}));

const TERM = {
  id: "t1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("TerminalsSection", () => {
  beforeEach(() => {
    useConclaveStore.getState().reset();
    mocks.spawnTerminal.mockClear();
    mocks.handlers.clear();
  });

  it("lists terminals and activates on click", async () => {
    useConclaveStore.getState().setTerminals([TERM]);
    render(<TerminalsSection />);
    await userEvent.click(screen.getByTestId("terminal-row-t1"));
    expect(useConclaveStore.getState().activeTerminalId).toBe("t1");
  });

  it("spawn picker offers only terminal-granted machines and submits a spawn", async () => {
    render(<TerminalsSection />);
    await userEvent.click(screen.getByTestId("spawn-terminal"));
    const machineSelect = await screen.findByLabelText("machine");
    expect(machineSelect).toHaveTextContent("m1");
    expect(machineSelect).not.toHaveTextContent("m2");
    await userEvent.click(screen.getByTestId("spawn-submit"));
    expect(mocks.spawnTerminal).toHaveBeenCalledWith("m1", "shell", "/w");
  });

  it("resets the folder to the new machine's first granted root when the machine changes", async () => {
    render(<TerminalsSection />);
    await userEvent.click(screen.getByTestId("spawn-terminal"));
    const machineSelect = await screen.findByLabelText("machine");
    await userEvent.selectOptions(screen.getByLabelText("folder"), "/w");
    await userEvent.selectOptions(machineSelect, "m3");
    await userEvent.click(screen.getByTestId("spawn-submit"));
    expect(mocks.spawnTerminal).toHaveBeenCalledWith("m3", "shell", "/x");
  });

  it("surfaces a term-error frame as an inline notice", () => {
    render(<TerminalsSection />);
    act(() => {
      for (const fn of mocks.handlers) fn({ type: "term-error", message: "node-pty unavailable" });
    });
    expect(screen.getByTestId("terminal-error")).toHaveTextContent("node-pty unavailable");
  });

  it("surfaces a rejected spawn as an inline notice", async () => {
    mocks.spawnTerminal.mockRejectedValueOnce(new Error("hub POST /api/terminals -> 503"));
    render(<TerminalsSection />);
    await userEvent.click(screen.getByTestId("spawn-terminal"));
    await userEvent.click(screen.getByTestId("spawn-submit"));
    expect(await screen.findByTestId("terminal-error")).toHaveTextContent(/spawn failed/);
  });
});
