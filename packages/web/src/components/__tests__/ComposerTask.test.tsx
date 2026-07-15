import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { Composer } from "../Composer.js";
import { hubClient } from "../../lib/hubClient.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([{ id: "t1", kind: "chat", workspace: "w", participants: ["you", "codex"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" }]);
  s.setAgents([{ id: "codex", name: "codex", runtime: "codex", machine: "m", workspace: "/w", role: "", allowedTools: [], dangerousActions: [] }]);
  s.setActiveThread("t1");
});

it("/task @agent spec creates a task and selects its thread", async () => {
  vi.spyOn(hubClient, "createTask").mockResolvedValue({
    id: "task1", threadId: "th-new", assignee: "codex", spec: "write the migration", state: "queued",
    artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
  });
  vi.spyOn(hubClient, "getThread").mockResolvedValue({
    id: "th-new", kind: "task", workspace: "w", participants: ["codex", "you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z",
  });
  vi.spyOn(hubClient, "listMessages").mockResolvedValue([]);

  render(<Composer />);
  await userEvent.type(screen.getByRole("textbox"), "/task @codex write the migration{Enter}");
  expect(hubClient.createTask).toHaveBeenCalledWith(expect.objectContaining({ assignee: "codex", spec: "write the migration" }));
});
