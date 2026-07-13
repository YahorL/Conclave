import { describe, expect, it } from "vitest";
import {
  MessageSchema,
  NewMessageSchema,
  NewThreadSchema,
  ThreadSchema,
} from "../src/index.js";

describe("ThreadSchema", () => {
  it("accepts a valid thread", () => {
    const thread = {
      id: "8f14e45f-ea4c-4f34-a2b0-9d3d7b3a1c11",
      kind: "debate",
      workspace: null,
      participants: ["claude-code", "codex"],
      state: "open",
      verdicts: {},
      createdAt: new Date().toISOString(),
    };
    expect(ThreadSchema.parse(thread)).toEqual(thread);
  });

  it("rejects an unknown state", () => {
    const result = ThreadSchema.safeParse({
      id: "x",
      kind: "debate",
      workspace: null,
      participants: ["a"],
      state: "paused",
      verdicts: {},
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty participants", () => {
    const result = NewThreadSchema.safeParse({ kind: "chat", participants: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(
      NewThreadSchema.safeParse({ kind: "party", participants: ["a"] }).success,
    ).toBe(false);
  });

  it("rejects empty participants on ThreadSchema too", () => {
    expect(
      ThreadSchema.safeParse({
        id: "t", kind: "chat", workspace: null, participants: [],
        state: "open", verdicts: {}, createdAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("MessageSchema", () => {
  it("accepts a valid message", () => {
    const message = {
      id: 1,
      threadId: "t1",
      from: "claude-code",
      to: ["codex"],
      type: "proposal",
      body: "I think we should split the module.",
      artifacts: [],
      ts: new Date().toISOString(),
    };
    expect(MessageSchema.parse(message)).toEqual(message);
  });

  it("applies defaults on NewMessage", () => {
    const parsed = NewMessageSchema.parse({ from: "you", body: "hello" });
    expect(parsed.to).toEqual([]);
    expect(parsed.type).toBe("text");
    expect(parsed.artifacts).toEqual([]);
  });

  it("rejects an empty body", () => {
    expect(NewMessageSchema.safeParse({ from: "you", body: "" }).success).toBe(false);
  });

  it("rejects non-positive and non-integer message ids", () => {
    const base = {
      threadId: "t", from: "a", to: [], type: "text",
      body: "x", artifacts: [], ts: new Date().toISOString(),
    };
    expect(MessageSchema.safeParse({ ...base, id: 0 }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, id: 1.5 }).success).toBe(false);
  });
});
