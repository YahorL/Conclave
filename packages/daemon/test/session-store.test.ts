import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-ss-")), "state.json");
}

describe("SessionStore", () => {
  it("stores and retrieves per thread+agent, persisting across instances", () => {
    const path = tmpPath();
    const store = new SessionStore(path);
    expect(store.get("t1", "a1")).toBeUndefined();
    store.set("t1", "a1", "sess-1");
    store.set("t1", "a2", "sess-2");
    expect(store.get("t1", "a1")).toBe("sess-1");
    const reloaded = new SessionStore(path);
    expect(reloaded.get("t1", "a2")).toBe("sess-2");
  });

  it("survives a corrupt state file", () => {
    const path = tmpPath();
    writeFileSync(path, "{corrupt");
    const store = new SessionStore(path);
    expect(store.get("t", "a")).toBeUndefined();
    store.set("t", "a", "s");
    expect(new SessionStore(path).get("t", "a")).toBe("s");
  });
});
