import { describe, expect, it } from "vitest";
import { NewTaskSchema, TaskSchema } from "../src/orchestration.js";

describe("task schemas", () => {
  it("accepts a new task and defaults artifacts on a full task", () => {
    expect(NewTaskSchema.parse({ assignee: "codex", spec: "add tests" }).assignee).toBe("codex");
    const t = TaskSchema.parse({
      id: "t1", threadId: "th1", assignee: "codex", spec: "x", state: "queued",
      artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
    });
    expect(t.state).toBe("queued");
  });

  it("rejects an unknown state", () => {
    expect(() =>
      TaskSchema.parse({
        id: "t1", threadId: "th1", assignee: "c", spec: "x", state: "nope",
        artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
      }),
    ).toThrow();
  });
});
