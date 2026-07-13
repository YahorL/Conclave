import { describe, expect, it } from "vitest";
import { NewDebateSchema, TurnRequestSchema, UsageReportSchema } from "../src/index.js";

describe("TurnRequestSchema", () => {
  it("parses with default sinceMessageId", () => {
    const turn = TurnRequestSchema.parse({ threadId: "t1", agentId: "codex" });
    expect(turn.sinceMessageId).toBe(0);
    expect(turn.instruction).toBeUndefined();
  });

  it("rejects negative sinceMessageId", () => {
    expect(
      TurnRequestSchema.safeParse({ threadId: "t", agentId: "a", sinceMessageId: -1 }).success,
    ).toBe(false);
  });
});

describe("NewDebateSchema", () => {
  it("applies round defaults", () => {
    const d = NewDebateSchema.parse({ topic: "tabs vs spaces", participants: ["a", "b"] });
    expect(d.minRounds).toBe(2);
    expect(d.maxRounds).toBe(4);
  });

  it("rejects fewer than 2 participants and max < min", () => {
    expect(NewDebateSchema.safeParse({ topic: "x", participants: ["a"] }).success).toBe(false);
    expect(
      NewDebateSchema.safeParse({
        topic: "x", participants: ["a", "b"], minRounds: 3, maxRounds: 2,
      }).success,
    ).toBe(false);
  });
});

describe("UsageReportSchema", () => {
  it("defaults counters to zero", () => {
    const u = UsageReportSchema.parse({ agent: "codex" });
    expect(u).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("rejects negative counters", () => {
    expect(UsageReportSchema.safeParse({ agent: "a", inputTokens: -1 }).success).toBe(false);
  });
});
