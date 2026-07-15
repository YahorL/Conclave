import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalsSection } from "../TerminalsSection.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => ({
  listMachines: vi.fn(async () => [
    { machine: "m1", files: ["/w"], terminals: true, lastSeen: "" },
    { machine: "m2", files: ["/x"], terminals: false, lastSeen: "" },
  ]),
  spawnTerminal: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/hubClient.js", () => ({ hubClient: mocks }));

const TERM = {
  id: "t1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("TerminalsSection", () => {
  beforeEach(() => {
    useConclaveStore.getState().reset();
    mocks.spawnTerminal.mockClear();
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
});
