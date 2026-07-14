import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Artifact } from "@conclave/shared";

const art: Artifact = {
  id: "a1", name: "plan.md", mime: "text/markdown", size: 6, sha256: "abc",
  createdBy: "codex", createdAt: "2026-07-13T10:00:00Z",
};

describe("artifacts in the store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("upserts artifacts and toggles the active artifact", () => {
    const s = useConclaveStore.getState();
    s.applyFrame({ type: "artifact", artifact: art });
    expect(useConclaveStore.getState().artifactsById["a1"].name).toBe("plan.md");
    s.setActiveArtifact("a1");
    expect(useConclaveStore.getState().activeArtifactId).toBe("a1");
  });

  it("selecting a thread clears the active artifact", () => {
    const s = useConclaveStore.getState();
    s.setActiveArtifact("a1");
    s.setActiveThread("t1");
    expect(useConclaveStore.getState().activeArtifactId).toBeNull();
  });
});
