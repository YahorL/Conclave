import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import type { Message } from "@conclave/shared";
import { ThreadClosedError, ThreadNotFoundError, NotAParticipantError } from "../src/mailbox.js";
import type { Thread } from "@conclave/shared";

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

describe("Mailbox messages", () => {
  let mailbox: Mailbox;
  beforeEach(() => {
    mailbox = freshMailbox();
  });

  it("appends and lists messages with monotonic ids", () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "codex"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["codex"], type: "text", body: "first", artifacts: [],
    });
    const m2 = mailbox.appendMessage(t.id, {
      from: "codex", to: ["you"], type: "text", body: "second", artifacts: [],
    });
    expect(m2.id).toBeGreaterThan(m1.id);
    expect(mailbox.listMessages(t.id).map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("supports catch-up via afterId", () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "old", artifacts: [],
    });
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "new", artifacts: [],
    });
    const caughtUp = mailbox.listMessages(t.id, m1.id);
    expect(caughtUp.map((m) => m.body)).toEqual(["new"]);
  });

  it("emits a message event on append", () => {
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    const seen: Message[] = [];
    mailbox.events.on("message", (m: Message) => seen.push(m));
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "ping", artifacts: [],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe("ping");
  });

  it("rejects messages to unknown or closed threads", () => {
    expect(() =>
      mailbox.appendMessage("nope", {
        from: "you", to: [], type: "text", body: "x", artifacts: [],
      }),
    ).toThrow(ThreadNotFoundError);

    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.closeThread(t.id);
    expect(() =>
      mailbox.appendMessage(t.id, {
        from: "you", to: [], type: "text", body: "x", artifacts: [],
      }),
    ).toThrow(ThreadClosedError);
  });
});

describe("Mailbox verdicts", () => {
  let mailbox: Mailbox;
  beforeEach(() => {
    mailbox = freshMailbox();
  });

  it("stores verdicts and settles when all participants voted", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    const afterFirst = mailbox.setVerdict(t.id, "claude-code", "approve");
    expect(afterFirst.state).toBe("open");
    const afterSecond = mailbox.setVerdict(t.id, "codex", "reject");
    expect(afterSecond.state).toBe("settled");
    expect(afterSecond.verdicts).toEqual({ "claude-code": "approve", codex: "reject" });
  });

  it("rejects verdicts from non-participants", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    expect(() => mailbox.setVerdict(t.id, "intruder", "approve")).toThrow(NotAParticipantError);
  });

  it("emits thread events on verdict and close", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code"] });
    const seen: Thread[] = [];
    mailbox.events.on("thread", (th: Thread) => seen.push(th));
    mailbox.setVerdict(t.id, "claude-code", "approve");
    expect(seen.at(-1)!.state).toBe("settled");
    const t2 = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.closeThread(t2.id);
    expect(seen.at(-1)!.state).toBe("closed");
  });

  it("persists verdicts", () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["claude-code", "codex"] });
    mailbox.setVerdict(t.id, "claude-code", "approve");
    expect(mailbox.getThread(t.id)!.verdicts).toEqual({ "claude-code": "approve" });
  });
});
