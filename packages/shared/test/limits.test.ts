import { describe, expect, it } from "vitest";
import { AgentConfigSchema, AgentLimitsSchema, AgentUsageSchema } from "../src/index.js";

const BASE_AGENT = {
  id: "codex", name: "codex", runtime: "codex", machine: "m1", workspace: "/w",
};

describe("agent limits + usage window fields", () => {
  it("AgentConfig without limits parses (limits stays undefined — optional, not defaulted)", () => {
    const a = AgentConfigSchema.parse(BASE_AGENT);
    expect(a.limits).toBeUndefined();
  });

  it("AgentConfig accepts partial limits and rejects non-positive caps", () => {
    const a = AgentConfigSchema.parse({ ...BASE_AGENT, limits: { window5hTokens: 500_000 } });
    expect(a.limits?.window5hTokens).toBe(500_000);
    expect(a.limits?.weeklyTokens).toBeUndefined();
    expect(AgentConfigSchema.safeParse({ ...BASE_AGENT, limits: { window5hTokens: 0 } }).success).toBe(false);
    expect(AgentConfigSchema.safeParse({ ...BASE_AGENT, limits: { weeklyTokens: -1 } }).success).toBe(false);
  });

  it("AgentUsage defaults window fields and keeps pct optional", () => {
    const u = AgentUsageSchema.parse({ agent: "codex", inputTokens: 1, outputTokens: 2, costUsd: 0.1 });
    expect(u.window5hTokens).toBe(0);
    expect(u.weeklyTokens).toBe(0);
    expect(u.window5hPct).toBeUndefined();
    const capped = AgentUsageSchema.parse({
      agent: "codex", inputTokens: 1, outputTokens: 2, costUsd: 0.1,
      window5hTokens: 100, weeklyTokens: 900, window5hPct: 10, weeklyPct: 9,
    });
    expect(capped.window5hPct).toBe(10);
  });

  it("exports AgentLimitsSchema", () => {
    expect(AgentLimitsSchema.parse({})).toEqual({});
  });
});
