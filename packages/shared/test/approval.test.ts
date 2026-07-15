import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  ApprovalDecisionSchema,
  ApprovalSchema,
  NewApprovalSchema,
} from "../src/index.js";

describe("approval schemas", () => {
  it("parses a full approval", () => {
    const a = ApprovalSchema.parse({
      id: "a1",
      threadId: "th1",
      taskId: "t1",
      requestedBy: "codex",
      action: "run scripts/deploy.sh prod",
      idempotencyKey: "k1",
      state: "pending",
      createdAt: "2026-07-14T10:00:00Z",
    });
    expect(a.taskId).toBe("t1");
    expect(a.note).toBeUndefined();
    expect(a.decidedAt).toBeUndefined();
  });

  it("rejects unknown states", () => {
    expect(
      ApprovalSchema.safeParse({
        id: "a1", threadId: "th1", requestedBy: "codex", action: "x",
        idempotencyKey: "k", state: "maybe", createdAt: "2026-07-14T10:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("NewApproval requires threadId, requestedBy, action, idempotencyKey; taskId optional", () => {
    const n = NewApprovalSchema.parse({
      threadId: "th1", requestedBy: "codex", action: "deploy", idempotencyKey: "k1",
    });
    expect(n.taskId).toBeUndefined();
    expect(NewApprovalSchema.safeParse({ threadId: "th1" }).success).toBe(false);
  });

  it("ApprovalDecision accepts approved/denied with optional note", () => {
    expect(ApprovalDecisionSchema.parse({ decision: "denied", note: "not now" }).note).toBe("not now");
    expect(ApprovalDecisionSchema.safeParse({ decision: "pending" }).success).toBe(false);
  });

  it("AgentConfig defaults dangerousActions to []", () => {
    const a = AgentConfigSchema.parse({
      id: "codex", name: "codex", runtime: "codex", machine: "m1", workspace: "/w",
    });
    expect(a.dangerousActions).toEqual([]);
  });
});
