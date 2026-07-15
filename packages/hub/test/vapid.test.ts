import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateVapid } from "../src/vapid.js";

describe("loadOrCreateVapid", () => {
  it("generates once and returns the same keys on subsequent calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-vapid-"));
    const first = loadOrCreateVapid(dir);
    expect(first.publicKey).toBeTruthy();
    expect(first.privateKey).toBeTruthy();
    expect(loadOrCreateVapid(dir)).toEqual(first);
  });

  it("writes vapid.json with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-vapid-"));
    loadOrCreateVapid(dir);
    expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
  });
});
