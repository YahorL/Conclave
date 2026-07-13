import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { TurnRequest } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { DebateStore } from "../src/debates.js";
import {
  DebateOrchestrator, composeInstruction, waitForAgentActivity,
} from "../src/orchestrator.js";

let db: Database.Database;
let mailbox: Mailbox;
let store: DebateStore;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-orch-"));
  db = openDb(join(dir, "t.db"));
  mailbox = new Mailbox(db);
  store = new DebateStore(db);
});

describe("composeInstruction", () => {
  it("forbids early verdicts before minRounds and invites them after", () => {
    expect(composeInstruction("skeptic", 1, 2, 4)).toContain("Do NOT call end_thread yet");
    expect(composeInstruction("skeptic", 1, 2, 4)).toContain("skeptic");
    expect(composeInstruction("advocate", 2, 2, 4)).toContain("end_thread");
    expect(composeInstruction("advocate", 2, 2, 4)).not.toContain("Do NOT");
  });
});

describe("waitForAgentActivity", () => {
  it("resolves replied / verdict / timeout", async () => {
    const t = mailbox.createThread({ kind: "debate", participants: ["a", "b"] });
    const p1 = waitForAgentActivity(mailbox, t.id, "a", 0, 2000);
    mailbox.appendMessage(t.id, { from: "a", to: [], type: "text", body: "hi", artifacts: [] });
    expect(await p1).toBe("replied");

    const p2 = waitForAgentActivity(mailbox, t.id, "b", 99, 2000);
    mailbox.setVerdict(t.id, "b", "approve");
    expect(await p2).toBe("verdict");

    const t2 = mailbox.createThread({ kind: "debate", participants: ["a"] });
    expect(await waitForAgentActivity(mailbox, t2.id, "a", 0, 100)).toBe("timeout");
  });
});

describe("DebateOrchestrator", () => {
  function fakeDaemon(behavior: (turn: TurnRequest, count: number) => void): void {
    const counts = new Map<string, number>();
    mailbox.events.on("turn", (turn: TurnRequest) => {
      const key = `${turn.threadId}:${turn.agentId}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      setTimeout(() => behavior(turn, count), 10);
    });
  }

  it("runs rounds, collects verdicts, settles, posts summary", async () => {
    const orch = new DebateOrchestrator(mailbox, store, {
      turnTimeoutMs: 2000, finaleTimeoutMs: 500,
    });
    fakeDaemon((turn, count) => {
      if (count < 2) {
        mailbox.appendMessage(turn.threadId, {
          from: turn.agentId, to: [], type: "text",
          body: `${turn.agentId} argues (${count})`, artifacts: [],
        });
      } else {
        mailbox.setVerdict(turn.threadId, turn.agentId, "approve");
      }
    });

    const rec = orch.startDebate({
      topic: "Should we use tabs?", participants: ["claude-code", "codex"],
      minRounds: 1, maxRounds: 3,
    });
    expect(rec.stances["claude-code"]).toBe("advocate");
    expect(rec.stances["codex"]).toBe("skeptic");
    await orch.idle();

    const thread = mailbox.getThread(rec.threadId)!;
    expect(thread.state).toBe("settled");
    expect(thread.verdicts).toEqual({ "claude-code": "approve", codex: "approve" });
    const bodies = mailbox.listMessages(rec.threadId).map((m) => m.body);
    expect(bodies[0]).toBe("Should we use tabs?");
    expect(bodies.some((b) => b.includes("claude-code argues"))).toBe(true);
    const summary = mailbox.listMessages(rec.threadId).find(
      (m) => m.from === "orchestrator" && m.type === "status",
    );
    expect(summary!.body).toContain("codex: approve");
    expect(store.get(rec.id)!.state).toBe("settled");
  });

  it("times out silent agents with a no-response verdict", async () => {
    const orch = new DebateOrchestrator(mailbox, store, {
      turnTimeoutMs: 150, finaleTimeoutMs: 100,
    });
    fakeDaemon((turn) => {
      if (turn.agentId === "codex") {
        mailbox.setVerdict(turn.threadId, "codex", "reject");
      } // claude-code stays silent
    });
    const rec = orch.startDebate({
      topic: "silence test", participants: ["claude-code", "codex"],
      minRounds: 1, maxRounds: 2,
    });
    await orch.idle();
    const thread = mailbox.getThread(rec.threadId)!;
    expect(thread.verdicts["codex"]).toBe("reject");
    expect(thread.verdicts["claude-code"]).toContain("no-response");
    expect(thread.state).toBe("settled");
    expect(store.get(rec.id)!.state).toBe("settled");
  }, 15_000);

  it("respects explicit stance overrides", () => {
    const orch = new DebateOrchestrator(mailbox, store, { turnTimeoutMs: 100, finaleTimeoutMs: 50 });
    const rec = orch.startDebate({
      topic: "x", participants: ["a", "b"], minRounds: 1, maxRounds: 1,
      stances: { a: "contrarian" },
    });
    expect(rec.stances["a"]).toBe("contrarian");
    expect(rec.stances["b"]).toBe("skeptic");
    return orch.idle();
  });
});
