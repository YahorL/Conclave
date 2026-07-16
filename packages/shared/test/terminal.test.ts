import { describe, expect, it } from "vitest";
import {
  HelloSchema,
  SpawnTerminalSchema,
  TakeoverTerminalSchema,
  TerminalInfoSchema,
  TermToDaemonFrameSchema,
} from "../src/index.js";

describe("terminal schemas", () => {
  it("parses a TerminalInfo and rejects a bad kind", () => {
    const ok = TerminalInfoSchema.safeParse({
      id: "term-1", machine: "m1", kind: "shell", label: "zsh · you",
      cwd: "/home/me/proj", startedAt: "2026-07-15T12:00:00.000Z",
    });
    expect(ok.success).toBe(true);
    const bad = TerminalInfoSchema.safeParse({
      id: "term-1", machine: "m1", kind: "bash", label: "x", cwd: "/x",
      startedAt: "2026-07-15T12:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });

  it("parses SpawnTerminal", () => {
    expect(SpawnTerminalSchema.safeParse({ machine: "m1", kind: "claude", cwd: "/w" }).success).toBe(true);
    expect(SpawnTerminalSchema.safeParse({ machine: "m1", kind: "claude" }).success).toBe(false);
  });

  it("discriminates daemon-bound term frames by type", () => {
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-spawn", kind: "shell", cwd: "/w" }).success).toBe(true);
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-data", terminalId: "t1", data: "aGk=" }).success).toBe(true);
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-resize", terminalId: "t1", cols: 80, rows: 24 }).success).toBe(true);
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-attach", terminalId: "t1", requestId: "r1" }).success).toBe(true);
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-nope", terminalId: "t1" }).success).toBe(false);
  });

  it("includes term-takeover in the daemon-bound union", () => {
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-takeover", agentId: "codex", threadId: "t1" }).success).toBe(true);
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-takeover", agentId: "codex" }).success).toBe(false);
  });

  it("parses a TakeoverTerminal request", () => {
    expect(TakeoverTerminalSchema.safeParse({ machine: "m1", agentId: "codex", threadId: "t1" }).success).toBe(true);
    expect(TakeoverTerminalSchema.safeParse({ machine: "m1", agentId: "codex" }).success).toBe(false);
  });

  it("hello defaults terminals to false and accepts true", () => {
    const legacy = HelloSchema.parse({ machine: "m1", files: [] });
    expect(legacy.terminals).toBe(false);
    const on = HelloSchema.parse({ machine: "m1", files: ["/w"], terminals: true });
    expect(on.terminals).toBe(true);
  });
});
