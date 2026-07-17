import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusStrip } from "../StatusStrip.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const usage = (agent: string, extra: Record<string, unknown>) => ({
  agent, inputTokens: 1000, outputTokens: 500, costUsd: 1.5,
  window5hTokens: 0, weeklyTokens: 0, ...extra,
});

function seed(perAgent: Array<Record<string, unknown>>): void {
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({
    type: "usage",
    summary: { perAgent, totalCostUsd: 1.5, budgetUsd: 25 },
  } as never);
}

describe("rate-limit window meters", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("applyFrame updates store usage from the ws frame", () => {
    seed([usage("codex", { window5hTokens: 420, window5hPct: 42 })]);
    expect(useConclaveStore.getState().usage?.perAgent[0]?.window5hPct).toBe(42);
  });

  it("renders pct bars with severity classes at 42/71/91", () => {
    seed([
      usage("codex", { window5hTokens: 420, window5hPct: 42, weeklyTokens: 710, weeklyPct: 71 }),
      usage("claude-code", { window5hTokens: 910, window5hPct: 91 }),
    ]);
    render(<StatusStrip />);
    const codex5h = screen.getByTestId("win-5h-codex");
    expect(codex5h.textContent).toContain("42%");
    expect(codex5h.querySelector("[data-severity='normal']")).toBeTruthy();
    const codexWk = screen.getByTestId("win-wk-codex");
    expect(codexWk.querySelector("[data-severity='nearing']")).toBeTruthy();
    const cc5h = screen.getByTestId("win-5h-claude-code");
    expect(cc5h.querySelector("[data-severity='critical']")).toBeTruthy();
  });

  it("over-100 pct clamps the bar width but prints the real number", () => {
    seed([usage("codex", { window5hTokens: 1370, window5hPct: 137 })]);
    render(<StatusStrip />);
    const el = screen.getByTestId("win-5h-codex");
    expect(el.textContent).toContain("137%");
    const fill = el.querySelector("[data-severity]") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("uncapped agent shows token text, no bar", () => {
    seed([usage("codex", { window5hTokens: 128_400, weeklyTokens: 900_000 })]);
    render(<StatusStrip />);
    const el = screen.getByTestId("win-5h-codex");
    expect(el.textContent).toContain("128.4k");
    expect(el.querySelector("[data-severity]")).toBeNull();
  });
});
