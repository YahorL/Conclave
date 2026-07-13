import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { Sidebar } from "../Sidebar.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({ type: "artifact", artifact: { id: "a1", name: "idempotency-plan.md", mime: "text/markdown", size: 6, sha256: "abc", createdBy: "codex", createdAt: "2026-07-13T10:00:00Z" } });
});

it("lists artifacts and opens one on click", async () => {
  render(<Sidebar />);
  const row = screen.getByText("idempotency-plan.md");
  expect(row).toBeInTheDocument();
  await userEvent.click(row);
  expect(useConclaveStore.getState().activeArtifactId).toBe("a1");
});
