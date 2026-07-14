import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { WindowStrip } from "../WindowStrip.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({ type: "workspace", workspace: { id: "w1", name: "svc", machine: "local", folderPath: "/w", createdAt: "2026-07-13T10:00:00Z" } });
});

it("shows a workspace tab and activates it on click", async () => {
  render(<WindowStrip />);
  await userEvent.click(screen.getByText("svc"));
  expect(useConclaveStore.getState().activeWorkspaceId).toBe("w1");
});
