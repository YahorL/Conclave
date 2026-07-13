import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Message } from "@conclave/shared";

const baseMsg = (over: Partial<Message>): Message => ({
  id: 1, threadId: "t1", from: "you", to: [], type: "text", body: "hi",
  artifacts: [], ts: new Date().toISOString(), ...over,
});

describe("conclave store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("appends message frames under their thread, in id order, deduped", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "message", message: baseMsg({ id: 2, body: "second" }) });
    applyFrame({ type: "message", message: baseMsg({ id: 1, body: "first" }) });
    applyFrame({ type: "message", message: baseMsg({ id: 2, body: "second" }) }); // dup
    const msgs = useConclaveStore.getState().messagesByThread["t1"];
    expect(msgs.map((m) => m.id)).toEqual([1, 2]);
  });

  it("stores latest status per agent from agent-status frames", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "agent-status", status: { agent: "codex", status: "running", activity: "x", ts: "2026-07-13T10:00:00Z" } });
    applyFrame({ type: "agent-status", status: { agent: "codex", status: "idle", activity: "", ts: "2026-07-13T10:01:00Z" } });
    expect(useConclaveStore.getState().statusByAgent["codex"].status).toBe("idle");
  });
});
