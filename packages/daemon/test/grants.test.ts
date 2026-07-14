import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore, PathJailError } from "../src/grants.js";

function withGrants(files: string[]): GrantStore {
  const dir = mkdtempSync(join(tmpdir(), "conclave-grants-"));
  const gf = join(dir, "grants.json");
  writeFileSync(gf, JSON.stringify({ files }));
  return new GrantStore(gf);
}

describe("GrantStore", () => {
  it("allows paths inside a granted root and rejects outside / traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const store = withGrants([root]);
    expect(store.resolveJailed(join(root, "a/b.txt"))).toBe(join(root, "a/b.txt"));
    expect(() => store.resolveJailed(join(root, "../escape"))).toThrow(PathJailError);
    expect(() => store.resolveJailed("/etc/passwd")).toThrow(PathJailError);
  });
  it("empty grants deny everything", () => {
    const store = withGrants([]);
    expect(store.roots()).toEqual([]);
    expect(() => store.resolveJailed("/anything")).toThrow(PathJailError);
  });
});
