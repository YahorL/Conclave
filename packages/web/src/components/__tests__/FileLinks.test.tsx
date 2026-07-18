import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessage } from "../ChatMessage.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const msg = (body: string) => ({
  id: 1, threadId: "th-1", from: "codex", to: ["you"], type: "text" as const,
  body, artifacts: [], ts: "2026-07-17T12:00:00.000Z",
});

function seedWorkspace(): void {
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({
    type: "workspace",
    workspace: { id: "w1", name: "proj", machine: "m1", folderPath: "/home/me/proj", createdAt: "2026-07-17T00:00:00.000Z" },
  });
  s.setActiveWorkspace("w1");
}

describe("chat file links", () => {
  beforeEach(seedWorkspace);
  afterEach(() => vi.restoreAllMocks());

  it("clicking a resolvable link opens the file with its line", async () => {
    render(<ChatMessage message={msg("see src/idem.ts:41 for the fix")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(useConclaveStore.getState().activeFsFile).toEqual({
      machine: "m1", path: "/home/me/proj/src/idem.ts", line: 41,
    });
  });

  it("an unresolvable link stays inert", async () => {
    useConclaveStore.getState().reset(); // no workspace, no machines
    render(<ChatMessage message={msg("see src/idem.ts:41")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(useConclaveStore.getState().activeFsFile).toBeNull();
  });

  it("dirty guard: cancel keeps the current file", async () => {
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/other.ts" });
    useConclaveStore.getState().setFsDirty(true);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ChatMessage message={msg("see src/idem.ts:41")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(window.confirm).toHaveBeenCalled();
    expect(useConclaveStore.getState().activeFsFile?.path).toBe("/other.ts");
  });

  it("dirty guard: confirm proceeds", async () => {
    useConclaveStore.getState().setFsDirty(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ChatMessage message={msg("see src/idem.ts:41")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(useConclaveStore.getState().activeFsFile?.path).toBe("/home/me/proj/src/idem.ts");
  });
});
