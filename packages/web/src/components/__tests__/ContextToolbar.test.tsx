import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ContextToolbar } from "../ContextToolbar.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([{ id: "th1", kind: "task", workspace: "w", participants: ["codex", "you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" }]);
  s.setActiveThread("th1");
  s.applyFrame({ type: "task", task: { id: "task1", threadId: "th1", assignee: "codex", spec: "x", state: "running", artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z" } });
});

it("shows task state for a task thread", () => {
  render(<ContextToolbar />);
  expect(screen.getByText(/task: running/)).toBeInTheDocument();
});
