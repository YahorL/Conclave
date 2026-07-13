import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Task } from "@conclave/shared";

const task: Task = {
  id: "t1", threadId: "th1", assignee: "codex", spec: "x", state: "queued",
  artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
};

describe("task frames in the store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("upserts tasks by id from task frames", () => {
    const { applyFrame } = useConclaveStore.getState();
    applyFrame({ type: "task", task });
    applyFrame({ type: "task", task: { ...task, state: "running" } });
    expect(useConclaveStore.getState().tasksById["t1"].state).toBe("running");
  });
});
