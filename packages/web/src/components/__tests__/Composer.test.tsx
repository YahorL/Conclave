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

it("sends a message with mentioned agents in to[]", async () => {
  const spy = vi.spyOn(hubClient, "postMessage").mockResolvedValue({} as never);
  render(<Composer />);
  const box = screen.getByRole("textbox");
  await userEvent.type(box, "hey @codex ping{Enter}");
  expect(spy).toHaveBeenCalledWith("t1", expect.objectContaining({ from: "you", to: ["codex"], body: "hey @codex ping" }));
});
