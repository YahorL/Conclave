import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { StatusScreen } from "../StatusScreen.js";

describe("StatusScreen", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("renders header, live status cards, and usage meters full-width", () => {
    useConclaveStore.setState({
      agents: [
        { id: "claude-code", name: "claude-code", runtime: "claude", machine: "m1" },
      ] as never,
      statusByAgent: {
        "claude-code": { agent: "claude-code", status: "running", activity: "writing migration", ts: "2026-07-18T10:00:00.000Z" },
      } as never,
      usage: {
        perAgent: [{
          agent: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 2.1,
          window5hTokens: 4200, weeklyTokens: 9000, window5hPct: 42,
        }],
        totalCostUsd: 2.1,
        budgetUsd: 25,
      } as never,
      workspacesById: {
        w1: { id: "w1", name: "payments-service", machine: "m1", folderPath: "/w", createdAt: "2026-07-18T09:00:00.000Z" },
      } as never,
      activeWorkspaceId: "w1",
    });
    render(<StatusScreen />);
    expect(screen.getByTestId("status-screen")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("payments-service · live")).toBeTruthy();
    expect(screen.getByText("● running")).toBeTruthy();
    expect(screen.getByTestId("win-5h-claude-code").textContent).toContain("42%");
    expect(screen.getByText("workspace today")).toBeTruthy();
  });

  it("renders without a workspace or usage (empty hub)", () => {
    render(<StatusScreen />);
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByText("workspace today")).toBeTruthy();
  });
});
