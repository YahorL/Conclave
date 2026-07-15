import { beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "@conclave/shared";
import { useConclaveStore } from "../useConclaveStore.js";

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", taskId: "t1", requestedBy: "codex",
    action: "run deploy.sh", idempotencyKey: "k1", state: "pending",
    createdAt: "2026-07-14T10:00:00Z", ...over,
  };
}

describe("approval store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("setApprovals indexes by id", () => {
    useConclaveStore.getState().setApprovals([approval(), approval({ id: "a2" })]);
    expect(Object.keys(useConclaveStore.getState().approvalsById).sort()).toEqual(["a1", "a2"]);
  });

  it("approval frames upsert (pending then decided)", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "approval", approval: approval() });
    expect(useConclaveStore.getState().approvalsById["a1"]?.state).toBe("pending");
    applyFrame({ type: "approval", approval: approval({ state: "approved", note: "go" }) });
    const got = useConclaveStore.getState().approvalsById["a1"];
    expect(got?.state).toBe("approved");
    expect(got?.note).toBe("go");
  });
});
