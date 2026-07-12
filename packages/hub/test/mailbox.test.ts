import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";

function freshMailbox(): Mailbox {
  const dir = mkdtempSync(join(tmpdir(), "conclave-test-"));
  return new Mailbox(openDb(join(dir, "test.db")));
}

describe("Mailbox threads", () => {
  let mailbox: Mailbox;
  beforeEach(() => {
    mailbox = freshMailbox();
  });

  it("creates and fetches a thread", () => {
    const thread = mailbox.createThread({
      kind: "debate",
      participants: ["claude-code", "codex"],
    });
    expect(thread.id).toMatch(/[0-9a-f-]{36}/);
    expect(thread.state).toBe("open");
    expect(thread.workspace).toBeNull();
    expect(mailbox.getThread(thread.id)).toEqual(thread);
  });

  it("returns undefined for a missing thread", () => {
    expect(mailbox.getThread("nope")).toBeUndefined();
  });

  it("lists threads newest-first", () => {
    const a = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const b = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const ids = mailbox.listThreads().map((t) => t.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it("persists across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-test-"));
    const path = join(dir, "test.db");
    const first = new Mailbox(openDb(path));
    const thread = first.createThread({ kind: "task", participants: ["deploy"], workspace: "ws1" });
    const second = new Mailbox(openDb(path));
    expect(second.getThread(thread.id)).toEqual(thread);
  });
});
