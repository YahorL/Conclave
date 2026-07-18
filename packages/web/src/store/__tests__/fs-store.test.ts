import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";

describe("fs editor store state", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("fsDirty flag round-trips and resets", () => {
    useConclaveStore.getState().setFsDirty(true);
    expect(useConclaveStore.getState().fsDirty).toBe(true);
    useConclaveStore.getState().reset();
    expect(useConclaveStore.getState().fsDirty).toBe(false);
  });

  it("setActiveFsFile carries an optional line", () => {
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/a.ts", line: 41 });
    expect(useConclaveStore.getState().activeFsFile?.line).toBe(41);
  });

  it("activation setters that discard the editor also clear fsDirty", () => {
    const dirty = () => {
      useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/a.ts" });
      useConclaveStore.getState().setFsDirty(true);
    };

    dirty();
    useConclaveStore.getState().setActiveThread("th1");
    expect(useConclaveStore.getState().fsDirty).toBe(false);

    dirty();
    useConclaveStore.getState().setActiveArtifact("a1");
    expect(useConclaveStore.getState().fsDirty).toBe(false);

    dirty();
    useConclaveStore.getState().setActiveTerminal("t1");
    expect(useConclaveStore.getState().fsDirty).toBe(false);
  });

  it("setActiveTerminal(null) does not touch fsDirty", () => {
    useConclaveStore.getState().setFsDirty(true);
    useConclaveStore.getState().setActiveTerminal(null);
    expect(useConclaveStore.getState().fsDirty).toBe(true);
  });
});
