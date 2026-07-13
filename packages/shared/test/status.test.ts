import { describe, expect, it } from "vitest";
import { AgentStatusReportSchema, AgentStatusSchema } from "../src/status.js";

describe("agent status schemas", () => {
  it("accepts a minimal running report and defaults optionals absent", () => {
    const parsed = AgentStatusReportSchema.parse({
      agent: "claude-code",
      status: "running",
      activity: "debating idempotency",
    });
    expect(parsed.status).toBe("running");
    expect(parsed.threadId).toBeUndefined();
    expect(parsed.resetsAt).toBeUndefined();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      AgentStatusReportSchema.parse({ agent: "x", status: "sleeping", activity: "" }),
    ).toThrow();
  });

  it("stored status requires ts", () => {
    expect(() =>
      AgentStatusSchema.parse({ agent: "x", status: "idle", activity: "" }),
    ).toThrow();
  });
});
