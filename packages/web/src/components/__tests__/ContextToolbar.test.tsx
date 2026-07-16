import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextToolbar } from "../ContextToolbar.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => ({ takeoverTerminal: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../lib/hubClient.js", () => ({ hubClient: mocks }));

it("shows task state for a task thread", () => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([{ id: "th1", kind: "task", workspace: "w", participants: ["codex", "you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" }]);
  s.setActiveThread("th1");
  s.applyFrame({ type: "task", task: { id: "task1", threadId: "th1", assignee: "codex", spec: "x", state: "running", artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z" } });
  render(<ContextToolbar />);
  expect(screen.getByText(/task: running/)).toBeInTheDocument();
});

const thread = (participants: string[]) => ({
  id: "t1", kind: "chat" as const, workspace: "proj", participants,
  state: "open" as const, verdicts: {}, createdAt: "2026-07-15T12:00:00.000Z",
});
const agent = (id: string, machine = "m1") => ({
  id, name: id, runtime: "codex" as const, machine, workspace: "/w",
  role: "", allowedTools: [], dangerousActions: [],
});

function seed(participants: string[], agents: ReturnType<typeof agent>[]) {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([thread(participants)]);
  s.setActiveThread("t1");
  s.setAgents(agents);
  s.setMachines([{ machine: "m1", files: ["/w"], terminals: true, lastSeen: "" }]);
}

describe("ContextToolbar take-over", () => {
  beforeEach(() => mocks.takeoverTerminal.mockClear());

  it("hides the control when the thread has no agent participants", () => {
    seed(["you"], []);
    render(<ContextToolbar />);
    expect(screen.queryByTestId("takeover")).toBeNull();
  });

  it("single candidate: clicking take over calls takeoverTerminal(machine, agentId, threadId)", async () => {
    seed(["you", "codex"], [agent("codex")]);
    render(<ContextToolbar />);
    await userEvent.click(screen.getByTestId("takeover"));
    expect(mocks.takeoverTerminal).toHaveBeenCalledWith("m1", "codex", "t1");
    expect(useConclaveStore.getState().pendingTakeover).toEqual({ agentId: "codex" });
  });

  it("multiple candidates: opens a menu and takes over the chosen agent", async () => {
    seed(["you", "codex", "reviewer"], [agent("codex"), agent("reviewer")]);
    render(<ContextToolbar />);
    await userEvent.click(screen.getByTestId("takeover"));
    await userEvent.click(screen.getByTestId("takeover-reviewer"));
    expect(mocks.takeoverTerminal).toHaveBeenCalledWith("m1", "reviewer", "t1");
  });

  it("REST failure: surfaces the error inline and clears pendingTakeover", async () => {
    mocks.takeoverTerminal.mockRejectedValueOnce(new Error("403 no terminal grant"));
    seed(["you", "codex"], [agent("codex")]);
    render(<ContextToolbar />);
    await userEvent.click(screen.getByTestId("takeover"));
    expect(await screen.findByTestId("takeover-error")).toHaveTextContent("403 no terminal grant");
    expect(useConclaveStore.getState().pendingTakeover).toBeNull();
  });
});
