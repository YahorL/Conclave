import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.js";
import { loadPty, TerminalService } from "../src/terminal-service.js";
import { wireTerminals } from "../src/terminal-wiring.js";

const ptyMod = await loadPty();

function realService(dir: string): TerminalService {
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ files: [dir], terminals: true }));
  return new TerminalService(ptyMod!, new GrantStore(grantsFile), {
    machine: "m1", shellBin: "/bin/sh", claudeBin: "claude", codexBin: "codex",
  });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("wireTerminals", () => {
  it("without a service or grant, spawn requests produce term-error", () => {
    const sent: Array<Record<string, unknown>> = [];
    const { onTerm } = wireTerminals({ service: null, granted: false, send: (f) => sent.push(f as Record<string, unknown>) });
    onTerm({ type: "term-spawn", kind: "shell", cwd: "/w" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!["type"]).toBe("term-error");
  });

  it.skipIf(!ptyMod)("spawn → term-list; attach → term-replay; exit → term-exit + term-list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-twire-"));
    const svc = realService(dir);
    const sent: Array<Record<string, unknown>> = [];
    const { onTerm, sendList } = wireTerminals({ service: svc, granted: true, send: (f) => sent.push(f as Record<string, unknown>) });

    sendList();
    expect(sent.filter((f) => f["type"] === "term-list")).toHaveLength(1);

    onTerm({ type: "term-spawn", kind: "shell", cwd: dir });
    const lists = sent.filter((f) => f["type"] === "term-list");
    expect(lists.length).toBeGreaterThanOrEqual(2);
    const last = lists[lists.length - 1] as { terminals: Array<{ id: string }> };
    const id = last.terminals[0]!.id;

    onTerm({ type: "term-data", terminalId: id, data: Buffer.from("echo wired\n").toString("base64") });
    await waitFor(() => sent.some((f) => f["type"] === "term-data" &&
      Buffer.from(String(f["data"]), "base64").toString().includes("wired")));

    onTerm({ type: "term-attach", terminalId: id, requestId: "req-1" });
    const replay = sent.find((f) => f["type"] === "term-replay") as { requestId: string; data: string };
    expect(replay.requestId).toBe("req-1");
    expect(Buffer.from(replay.data, "base64").toString()).toContain("wired");

    onTerm({ type: "term-kill", terminalId: id });
    await waitFor(() => sent.some((f) => f["type"] === "term-exit"));
  }, 15000);
});
