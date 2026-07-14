import { describe, expect, it } from "vitest";
import { ArtifactSchema, NewArtifactSchema } from "../src/artifact.js";

describe("artifact schemas", () => {
  it("defaults mime and requires content on new artifacts", () => {
    const n = NewArtifactSchema.parse({ name: "plan.md", content: "# Plan" });
    expect(n.mime).toBe("text/plain");
    expect(() => NewArtifactSchema.parse({ name: "x" })).toThrow();
  });

  it("accepts full artifact metadata", () => {
    const a = ArtifactSchema.parse({
      id: "a1", name: "plan.md", mime: "text/markdown", size: 6, sha256: "abc",
      createdBy: "codex", createdAt: "2026-07-13T10:00:00Z",
    });
    expect(a.name).toBe("plan.md");
  });
});
