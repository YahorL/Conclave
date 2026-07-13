import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex-adapter.js";
import { parseStreamLine, summarizeCodexTurn } from "../src/stream-json.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

interface Capture { args: string[]; stdin: string; cwd: string }

function captureFile(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-cxc-")), "cap.ndjson");
}
function readCaptures(path: string): Capture[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Capture);
}

afterEach(() => {
  delete process.env["FAKE_CODEX_MODE"];
  delete process.env["FAKE_CODEX_CAPTURE"];
});

describe("summarizeCodexTurn", () => {
  it("extracts session, text, tokens", () => {
    const lines = [
      `{"type":"thread.started","thread_id":"th-1"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}`,
      `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}`,
    ];
    const turn = summarizeCodexTurn(lines.map((l) => parseStreamLine(l)!));
    expect(turn).toMatchObject({
      sessionId: "th-1", text: "hello", isError: false, costUsd: 0,
      tokens: { input: 10, output: 4 },
    });
  });

  it("flags turn.failed and throws on unrecognizable output", () => {
    const failed = summarizeCodexTurn([
      parseStreamLine(`{"type":"turn.failed","error":{"message":"usage limit reached"}}`)!,
    ], "th-fallback");
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("usage limit");
    expect(failed.sessionId).toBe("th-fallback");
    expect(() => summarizeCodexTurn([parseStreamLine(`{"type":"noise"}`)!])).toThrow(
      /no recognizable codex events/,
    );
  });
});

describe("CodexAdapter", () => {
  it("spawns exec with contract flags, mcp overrides, stdin prompt", async () => {
    const cap = captureFile();
    process.env["FAKE_CODEX_CAPTURE"] = cap;
    const cwd = mkdtempSync(join(tmpdir(), "conclave-cxw-"));
    const adapter = new CodexAdapter(FAKE);
    const result = await adapter.runTurn({
      cwd, prompt: "review this", allowedTools: ["Read"],
      mcpServers: { hub: { command: "node", args: ["b.js"], env: { CONCLAVE_TOKEN: "t" } } },
    });
    expect(result.sessionId).toBe("codex-thread-new");
    expect(result.text).toBe("codex says: review this");
    expect(result.tokens).toEqual({ input: 100, output: 25 });
    const [c] = readCaptures(cap);
    expect(c!.stdin).toBe("review this");
    expect(c!.cwd).toBe(cwd);
    expect(c!.args[0]).toBe("exec");
    expect(c!.args).not.toContain("resume");
    expect(c!.args).toContain("--json");
    expect(c!.args).toContain("approval_policy=never");
    expect(c!.args).toContain('mcp_servers.hub.command="node"');
    expect(c!.args).toContain('mcp_servers.hub.args=["b.js"]');
    expect(c!.args).toContain('mcp_servers.hub.env.CONCLAVE_TOKEN="t"');
    expect(c!.args).not.toContain("--allowedTools");
  });

  it("resumes via exec resume <id>", async () => {
    const cap = captureFile();
    process.env["FAKE_CODEX_CAPTURE"] = cap;
    const adapter = new CodexAdapter(FAKE);
    const result = await adapter.runTurn({
      cwd: process.cwd(), prompt: "again", sessionId: "th-42", allowedTools: [],
    });
    expect(result.sessionId).toBe("th-42");
    const [c] = readCaptures(cap);
    expect(c!.args.slice(0, 3)).toEqual(["exec", "resume", "th-42"]);
  });

  it("surfaces turn.failed as isError result, not rejection", async () => {
    process.env["FAKE_CODEX_MODE"] = "fail";
    const adapter = new CodexAdapter(FAKE);
    const result = await adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("usage limit");
  });

  it("kills and rejects on timeout", async () => {
    process.env["FAKE_CODEX_MODE"] = "hang";
    const adapter = new CodexAdapter(FAKE);
    await expect(
      adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [], timeoutMs: 500 }),
    ).rejects.toThrow(/timeout/i);
  }, 10_000);
});
