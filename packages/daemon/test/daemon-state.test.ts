import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonState } from "../src/daemon-state.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-dst-")), "state.json");
}

describe("DaemonState", () => {
  it("persists sessions, cursor, and watermarks across instances", () => {
    const path = tmpPath();
    const s = new DaemonState(path);
    expect(s.getCursor()).toBe(0);
    expect(s.getWatermark("t", "a")).toBe(0);
    s.setSession("t", "a", "sess-1");
    s.setCursor(42);
    s.setWatermark("t", "a", 40);
    const reloaded = new DaemonState(path);
    expect(reloaded.getSession("t", "a")).toBe("sess-1");
    expect(reloaded.getCursor()).toBe(42);
    expect(reloaded.getWatermark("t", "a")).toBe(40);
  });

  it("cursor and watermarks are monotonic", () => {
    const s = new DaemonState(tmpPath());
    s.setCursor(10);
    s.setCursor(5);
    expect(s.getCursor()).toBe(10);
    s.setWatermark("t", "a", 7);
    s.setWatermark("t", "a", 3);
    expect(s.getWatermark("t", "a")).toBe(7);
  });

  it("migrates a legacy flat SessionStore file", () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ '["t1","a1"]': "sess-legacy" }));
    const s = new DaemonState(path);
    expect(s.getSession("t1", "a1")).toBe("sess-legacy");
    expect(s.getCursor()).toBe(0);
  });

  it("survives corrupt files", () => {
    const path = tmpPath();
    writeFileSync(path, "{nope");
    const s = new DaemonState(path);
    expect(s.getCursor()).toBe(0);
    s.setCursor(1);
    expect(new DaemonState(path).getCursor()).toBe(1);
  });
});
