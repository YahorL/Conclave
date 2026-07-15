import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Approval } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { AlreadyDecidedError, ApprovalStore } from "../src/approvals.js";

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a1", threadId: "th1", requestedBy: "codex", action: "deploy prod",
    idempotencyKey: "k1", state: "pending", createdAt: "2026-07-14T10:00:00Z", ...over,
  };
}

describe("ApprovalStore", () => {
  let store: ApprovalStore;
  beforeEach(() => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-appr-")), "t.db"));
    db.prepare(
      "INSERT INTO threads (id, kind, workspace, participants, state, verdicts, created_at) VALUES ('th1','task',NULL,'[]','open','{}','2026-07-14T10:00:00Z')",
    ).run();
    store = new ApprovalStore(db);
  });

  it("creates and reads back an approval (round-trip incl. optional fields)", () => {
    store.create(approval({ taskId: "t1" }));
    const got = store.get("a1");
    expect(got?.taskId).toBe("t1");
    expect(got?.state).toBe("pending");
    expect(got?.note).toBeUndefined();
    expect(got?.decidedAt).toBeUndefined();
  });

  it("findByKey returns the row for (requestedBy, idempotencyKey)", () => {
    store.create(approval());
    expect(store.findByKey("codex", "k1")?.id).toBe("a1");
    expect(store.findByKey("codex", "other")).toBeUndefined();
    expect(store.findByKey("claude-code", "k1")).toBeUndefined();
  });

  it("lists all or by state", () => {
    store.create(approval());
    store.create(approval({ id: "a2", idempotencyKey: "k2" }));
    store.decide("a2", "approved");
    expect(store.list().map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(store.list("pending").map((a) => a.id)).toEqual(["a1"]);
    expect(store.list("approved").map((a) => a.id)).toEqual(["a2"]);
  });

  it("decide sets state, note, decidedAt", () => {
    store.create(approval());
    const decided = store.decide("a1", "denied", "not today");
    expect(decided.state).toBe("denied");
    expect(decided.note).toBe("not today");
    expect(decided.decidedAt).toBeTruthy();
    expect(store.get("a1")?.state).toBe("denied");
  });

  it("deciding twice throws AlreadyDecidedError", () => {
    store.create(approval());
    store.decide("a1", "approved");
    expect(() => store.decide("a1", "denied")).toThrow(AlreadyDecidedError);
  });

  it("deciding an unknown id throws", () => {
    expect(() => store.decide("nope", "approved")).toThrow(/not found/);
  });
});
