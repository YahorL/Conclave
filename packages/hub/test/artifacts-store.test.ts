import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { ArtifactStore, ArtifactTooLargeError } from "../src/artifacts.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "conclave-art-"));
  return openDb(join(dir, "t.db"));
}

describe("ArtifactStore", () => {
  it("stores metadata + blob, computes size and sha256", () => {
    const store = new ArtifactStore(freshDb());
    const content = "# Plan\nbody";
    const art = store.create({ name: "plan.md", mime: "text/markdown", content });
    expect(art.size).toBe(Buffer.byteLength(content));
    expect(art.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(store.getBlob(art.id)?.toString("utf-8")).toBe(content);
    expect(store.list().map((a) => a.id)).toEqual([art.id]);
  });

  it("rejects content over 50MB", () => {
    const store = new ArtifactStore(freshDb());
    const huge = "x".repeat(50 * 1024 * 1024 + 1);
    expect(() => store.create({ name: "big", mime: "text/plain", content: huge })).toThrow(
      ArtifactTooLargeError,
    );
  });
});
