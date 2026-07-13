import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { DebateStore, type DebateRecord } from "../src/debates.js";
import { Mailbox } from "../src/mailbox.js";

let db: Database.Database;
let store: DebateStore;
let mailbox: Mailbox;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-ds-"));
  db = openDb(join(dir, "t.db"));
  store = new DebateStore(db);
  mailbox = new Mailbox(db);
});

function rec(threadId: string, overrides: Partial<DebateRecord> = {}): DebateRecord {
  return {
    id: `deb-${Math.random().toString(36).slice(2)}`,
    threadId,
    participants: ["claude-code", "codex"],
    stances: { "claude-code": "advocate", codex: "skeptic" },
    minRounds: 2,
    maxRounds: 4,
    round: 0,
    state: "running",
    ...overrides,
  };
}

describe("DebateStore", () => {
  it("creates, gets, updates", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    const r = rec(t.id);
    store.create(r);
    expect(store.get(r.id)).toEqual(r);
    store.update(r.id, { round: 2, state: "settled" });
    expect(store.get(r.id)).toMatchObject({ round: 2, state: "settled" });
  });

  it("marks all running debates interrupted", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["a", "b"] });
    const r1 = rec(t.id);
    const r2 = rec(t.id, { state: "settled" });
    store.create(r1);
    store.create(r2);
    expect(store.markRunningInterrupted()).toBe(1);
    expect(store.get(r1.id)!.state).toBe("interrupted");
    expect(store.get(r2.id)!.state).toBe("settled");
  });
});
