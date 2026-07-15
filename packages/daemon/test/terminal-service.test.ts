import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { GrantStore, PathJailError } from "../src/grants.js";
import { loadPty, TerminalService, TerminalsNotGrantedError } from "../src/terminal-service.js";

const ptyMod = await loadPty();

function makeService(dir: string, granted = true): TerminalService {
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ files: [dir], terminals: granted }));
  return new TerminalService(ptyMod!, new GrantStore(grantsFile), {
    machine: "m1",
    shellBin: "/bin/sh",
    claudeBin: "claude",
    codexBin: "codex",
  });
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!ptyMod)("TerminalService (real PTYs)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conclave-term-"));
  });

  it("spawns a shell, echoes input, buffers for replay, and reports exit", async () => {
    const svc = makeService(dir);
    const chunks: string[] = [];
    const exits: number[] = [];
    svc.events.on("data", (_id: string, data: string) => chunks.push(Buffer.from(data, "base64").toString()));
    svc.events.on("exit", (_id: string, code: number) => exits.push(code));

    const info = svc.spawn({ kind: "shell", cwd: dir });
    expect(info.machine).toBe("m1");
    expect(info.kind).toBe("shell");
    expect(info.label).toBe("sh · you");
    expect(svc.list().map((t) => t.id)).toContain(info.id);

    svc.write(info.id, b64("echo pty-round-trip\n"));
    await waitFor(() => chunks.join("").includes("pty-round-trip"));

    // replay carries the same bytes from the ring buffer
    expect(Buffer.from(svc.replay(info.id), "base64").toString()).toContain("pty-round-trip");

    svc.write(info.id, b64("exit\n"));
    await waitFor(() => exits.length > 0);
    expect(svc.list()).toHaveLength(0);
  }, 15000);

  it("kill ends the pty and emits exit", async () => {
    const svc = makeService(dir);
    const exits: number[] = [];
    svc.events.on("exit", (_id: string, code: number) => exits.push(code));
    const info = svc.spawn({ kind: "shell", cwd: dir });
    svc.kill(info.id);
    await waitFor(() => exits.length > 0);
    expect(svc.list()).toHaveLength(0);
  }, 15000);

  it("rejects cwd outside granted roots", () => {
    const svc = makeService(dir);
    expect(() => svc.spawn({ kind: "shell", cwd: "/etc" })).toThrow(PathJailError);
  });

  it("refuses to spawn without the terminals grant", () => {
    const svc = makeService(dir, false);
    expect(() => svc.spawn({ kind: "shell", cwd: dir })).toThrow(TerminalsNotGrantedError);
  });
});
