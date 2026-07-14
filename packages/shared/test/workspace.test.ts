import { describe, expect, it } from "vitest";
import { NewWorkspaceSchema, WorkspaceSchema } from "../src/workspace.js";

describe("workspace schemas", () => {
  it("parses new + full workspace", () => {
    expect(NewWorkspaceSchema.parse({ machine: "local", folderPath: "/w" }).machine).toBe("local");
    expect(() => NewWorkspaceSchema.parse({ machine: "local" })).toThrow();
    const w = WorkspaceSchema.parse({
      id: "w1", name: "svc", machine: "local", folderPath: "/w", createdAt: "2026-07-13T10:00:00Z",
    });
    expect(w.name).toBe("svc");
  });
});
