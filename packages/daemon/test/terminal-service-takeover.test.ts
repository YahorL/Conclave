import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.js";
import { TerminalService, type PtyLike, type PtyModule } from "../src/terminal-service.js";

interface Spawned { file: string; args: string[] }

function fakePty(): { mod: PtyModule; spawns: Spawned[] } {
  const spawns: Spawned[] = [];
  const pty: PtyLike = {
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
  return {
    spawns,
    mod: {
      spawn: (file, args) => {
        spawns.push({ file, args });
        return pty;
      },
    },
  };
}

function svc(dir: string): { service: TerminalService; spawns: Spawned[] } {
  const grantsFile = join(dir, "grants.json");
  writeFileSync(grantsFile, JSON.stringify({ files: [dir], terminals: true }));
  const { mod, spawns } = fakePty();
  const service = new TerminalService(mod, new GrantStore(grantsFile), {
    machine: "m1", shellBin: "/bin/sh", claudeBin: "claude-bin", codexBin: "codex-bin",
  });
  return { service, spawns };
}

describe("TerminalService take-over / resume args", () => {
  it("claude with a session id spawns with --resume <id> and a ⇄ label", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-tk-"));
    const { service, spawns } = svc(dir);
    const info = service.spawn({ kind: "claude", cwd: dir, resumeSessionId: "sess-abc", takeover: true });
    expect(spawns[0]).toEqual({ file: "claude-bin", args: ["--resume", "sess-abc"] });
    expect(info.label).toBe(`claude ⇄ ${info.cwd.split("/").pop()}`);
  });

  it("codex with a session id spawns with resume <id>", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-tk-"));
    const { service, spawns } = svc(dir);
    service.spawn({ kind: "codex", cwd: dir, resumeSessionId: "sess-xyz", takeover: true });
    expect(spawns[0]).toEqual({ file: "codex-bin", args: ["resume", "sess-xyz"] });
  });

  it("take-over with no session id spawns fresh (no resume args) but keeps the ⇄ label", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-tk-"));
    const { service, spawns } = svc(dir);
    const info = service.spawn({ kind: "claude", cwd: dir, takeover: true });
    expect(spawns[0]!.args).toEqual([]);
    expect(info.label).toBe(`claude ⇄ ${info.cwd.split("/").pop()}`);
  });

  it("a plain (non-takeover) spawn is unchanged: no args, · label", () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-tk-"));
    const { service, spawns } = svc(dir);
    const info = service.spawn({ kind: "claude", cwd: dir });
    expect(spawns[0]!.args).toEqual([]);
    expect(info.label).toBe(`claude · ${info.cwd.split("/").pop()}`);
  });
});
