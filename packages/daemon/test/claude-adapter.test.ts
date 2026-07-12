import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/claude-adapter.js";
import type { CliEvent } from "../src/stream-json.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

interface Capture {
  args: string[];
  stdin: string;
  cwd: string;
}

function captureFile(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-cap-")), "cap.ndjson");
}

function readCaptures(path: string): Capture[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Capture);
}

describe("ClaudeCodeAdapter", () => {
  it("spawns with the contract flags, pipes prompt via stdin, runs in cwd", async () => {
    const cap = captureFile();
    process.env["FAKE_CLAUDE_CAPTURE"] = cap;
    const cwd = mkdtempSync(join(tmpdir(), "conclave-ws-"));
    const adapter = new ClaudeCodeAdapter(FAKE);
    const events: CliEvent[] = [];

    const result = await adapter.runTurn({
      cwd,
      prompt: "hello agent",
      allowedTools: ["Read", "mcp__hub__send_message"],
      mcpServers: { hub: { command: "node", args: ["bridge.js"] } },
      onEvent: (e) => events.push(e),
    });

    expect(result.sessionId).toBe("fake-sess-new");
    expect(result.text).toBe("echo: hello agent");
    expect(result.costUsd).toBe(0.01);
    expect(events.map((e) => e.type)).toEqual(["system", "result"]);

    const [c] = readCaptures(cap);
    expect(c!.stdin).toBe("hello agent");
    expect(c!.cwd).toBe(cwd);
    expect(c!.args).toContain("-p");
    expect(c!.args).toContain("--strict-mcp-config");
    expect(c!.args).not.toContain("--resume");
    const toolsIdx = c!.args.indexOf("--allowedTools");
    expect(c!.args[toolsIdx + 1]).toBe("Read,mcp__hub__send_message");
    const mcpIdx = c!.args.indexOf("--mcp-config");
    expect(JSON.parse(c!.args[mcpIdx + 1]!)).toEqual({
      mcpServers: { hub: { command: "node", args: ["bridge.js"] } },
    });
  });

  it("passes --resume and keeps the session id", async () => {
    const cap = captureFile();
    process.env["FAKE_CLAUDE_CAPTURE"] = cap;
    const adapter = new ClaudeCodeAdapter(FAKE);
    const result = await adapter.runTurn({
      cwd: process.cwd(),
      prompt: "again",
      sessionId: "sess-42",
      allowedTools: ["Read"],
    });
    expect(result.sessionId).toBe("sess-42");
    const [c] = readCaptures(cap);
    const resumeIdx = c!.args.indexOf("--resume");
    expect(c!.args[resumeIdx + 1]).toBe("sess-42");
  });

  it("rejects when the CLI dies without a result event", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "no-result";
    const adapter = new ClaudeCodeAdapter(FAKE);
    await expect(
      adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [] }),
    ).rejects.toThrow(/no result event|exit/);
    delete process.env["FAKE_CLAUDE_MODE"];
  });

  it("kills and rejects on timeout", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    const adapter = new ClaudeCodeAdapter(FAKE);
    await expect(
      adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [], timeoutMs: 500 }),
    ).rejects.toThrow(/timeout/i);
    delete process.env["FAKE_CLAUDE_MODE"];
  }, 10_000);
});
