import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { StatusStrip } from "../StatusStrip.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.setAgents([{ id: "codex", name: "codex", runtime: "codex", machine: "m", workspace: "/w", role: "", allowedTools: [] }]);
  s.setStatuses([{ agent: "codex", status: "running", activity: "reviewing PR", ts: "2026-07-13T10:00:00Z" }]);
  s.setUsage({ perAgent: [{ agent: "codex", inputTokens: 100, outputTokens: 50, costUsd: 4.82 }], totalCostUsd: 4.82, budgetUsd: 25 });
});

it("shows live activity and workspace spend", () => {
  render(<StatusStrip />);
  expect(screen.getByText("reviewing PR")).toBeInTheDocument();
  expect(screen.getByText(/\$4\.82 \/ \$25/)).toBeInTheDocument();
});
