import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { Sidebar } from "../Sidebar.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([
    { id: "t1", kind: "debate", workspace: "payments", participants: ["you", "codex"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" },
  ]);
  s.setAgents([
    { id: "codex", name: "codex", runtime: "codex", machine: "m1", workspace: "/w", role: "", allowedTools: [] },
  ]);
  s.setStatuses([{ agent: "codex", status: "running", activity: "x", ts: "2026-07-13T10:00:00Z" }]);
});

afterEach(() => vi.unstubAllGlobals());

it("lists chats and agents and selects a thread on click", async () => {
  render(<Sidebar />);
  expect(screen.getByText(/payments/i)).toBeInTheDocument();
  expect(screen.getByText("codex")).toBeInTheDocument();
  await userEvent.click(screen.getByText(/payments/i));
  expect(useConclaveStore.getState().activeThreadId).toBe("t1");
});
