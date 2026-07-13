import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { SessionTabs } from "../SessionTabs.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([
    { id: "t1", kind: "chat", workspace: "alpha", participants: ["you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" },
    { id: "t2", kind: "chat", workspace: "beta", participants: ["you"], state: "open", verdicts: {}, createdAt: "2026-07-13T10:00:00Z" },
  ]);
  s.setActiveThread("t1");
  s.openThread("t2");
});

it("switches active thread when a tab is clicked", async () => {
  render(<SessionTabs />);
  await userEvent.click(screen.getByText(/beta/i));
  expect(useConclaveStore.getState().activeThreadId).toBe("t2");
});
