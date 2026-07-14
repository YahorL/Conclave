import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { WorkspaceStore } from "../src/workspaces.js";

function store(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), "conclave-ws-"));
  return new WorkspaceStore(openDb(join(dir, "t.db")));
}

describe("WorkspaceStore", () => {
  it("creates with a default name (basename) and lists", () => {
    const s = store();
    const w = s.create({ machine: "local", folderPath: "/home/me/payments-service" });
    expect(w.name).toBe("payments-service");
    expect(s.get(w.id)?.machine).toBe("local");
    expect(s.list().map((x) => x.id)).toEqual([w.id]);
  });
  it("honors an explicit name", () => {
    expect(store().create({ name: "custom", machine: "m", folderPath: "/w" }).name).toBe("custom");
  });
});
