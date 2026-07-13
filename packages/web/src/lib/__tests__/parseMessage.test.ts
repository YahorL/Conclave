import { describe, expect, it } from "vitest";
import { parseMessageBody } from "../parseMessage.js";

describe("parseMessageBody", () => {
  it("extracts mentions only for known agents", () => {
    const blocks = parseMessageBody("hi @codex and @nobody", ["codex", "claude-code"]);
    const segs = blocks[0].kind === "para" ? blocks[0].segments : [];
    expect(segs.find((s) => s.kind === "mention")).toMatchObject({ id: "codex" });
    expect(segs.some((s) => s.kind === "text" && s.text.includes("@nobody"))).toBe(true);
  });

  it("parses inline code and file paths", () => {
    const blocks = parseMessageBody("see `key` in payments/idem.ts:41", []);
    const segs = blocks[0].kind === "para" ? blocks[0].segments : [];
    expect(segs.some((s) => s.kind === "code" && s.text === "key")).toBe(true);
    expect(segs.some((s) => s.kind === "file" && s.path === "payments/idem.ts:41")).toBe(true);
  });

  it("splits fenced code blocks into their own block with lines", () => {
    const body = "before\n```\nline1\nline2\n```\nafter";
    const blocks = parseMessageBody(body, []);
    const cb = blocks.find((b) => b.kind === "codeblock");
    expect(cb).toBeTruthy();
    expect(cb?.kind === "codeblock" && cb.lines).toEqual(["line1", "line2"]);
  });
});
