import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { TerminalInfo, TerminalKind } from "@conclave/shared";
import { childEnv } from "./child-env.js";
import { RingBuffer } from "./ring-buffer.js";
import type { GrantStore } from "./grants.js";

const RING_CAP_BYTES = 1024 * 1024; // 1 MiB scrollback per terminal

export class TerminalsNotGrantedError extends Error {
  constructor() {
    super("terminals not granted on this machine");
  }
}

export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): PtyLike;
}

// node-pty is a native module and an optionalDependency: a machine without a
// working build simply has no terminals capability. Never let it crash boot.
export async function loadPty(): Promise<PtyModule | null> {
  try {
    return (await import("node-pty")) as unknown as PtyModule;
  } catch {
    return null;
  }
}

export interface TerminalServiceOptions {
  machine: string;
  shellBin?: string; // default: $SHELL or /bin/sh
  claudeBin: string;
  codexBin: string;
  resolveAgentId?: (kind: TerminalKind) => string | undefined;
}

interface LiveTerminal {
  info: TerminalInfo;
  pty: PtyLike;
  ring: RingBuffer;
}

export class TerminalService {
  readonly events = new EventEmitter();
  private readonly byId = new Map<string, LiveTerminal>();

  constructor(
    private readonly ptyMod: PtyModule,
    private readonly grants: GrantStore,
    private readonly opts: TerminalServiceOptions,
  ) {}

  spawn(req: { kind: TerminalKind; cwd: string; resumeSessionId?: string; takeover?: boolean }): TerminalInfo {
    if (!this.grants.terminalsGranted()) throw new TerminalsNotGrantedError();
    const cwd = this.grants.resolveJailed(req.cwd);
    const shell = this.opts.shellBin ?? process.env["SHELL"] ?? "/bin/sh";
    const bin = req.kind === "shell" ? shell : req.kind === "claude" ? this.opts.claudeBin : this.opts.codexBin;
    const resumeArgs =
      req.resumeSessionId && req.kind !== "shell"
        ? req.kind === "claude"
          ? ["--resume", req.resumeSessionId]
          : ["resume", req.resumeSessionId]
        : [];
    const label =
      req.kind === "shell"
        ? `${basename(shell)} · you`
        : req.takeover
          ? `${req.kind} ⇄ ${basename(cwd)}`
          : `${req.kind} · ${basename(cwd)}`;
    const info: TerminalInfo = {
      id: `term-${randomUUID()}`,
      machine: this.opts.machine,
      kind: req.kind,
      label,
      cwd,
      agentId: req.kind === "shell" ? undefined : this.opts.resolveAgentId?.(req.kind),
      startedAt: new Date().toISOString(),
    };
    const pty = this.ptyMod.spawn(bin, resumeArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: childEnv(),
    });
    const live: LiveTerminal = { info, pty, ring: new RingBuffer(RING_CAP_BYTES) };
    this.byId.set(info.id, live);
    pty.onData((data) => {
      const buf = Buffer.from(data, "utf8");
      live.ring.push(buf);
      this.events.emit("data", info.id, buf.toString("base64"));
    });
    pty.onExit(({ exitCode }) => {
      this.byId.delete(info.id);
      this.events.emit("exit", info.id, exitCode);
      this.events.emit("list-changed");
    });
    this.events.emit("list-changed");
    return info;
  }

  write(id: string, dataB64: string): void {
    this.byId.get(id)?.pty.write(Buffer.from(dataB64, "base64").toString("utf8"));
  }

  resize(id: string, cols: number, rows: number): void {
    this.byId.get(id)?.pty.resize(cols, rows);
  }

  kill(id: string): void {
    this.byId.get(id)?.pty.kill();
  }

  list(): TerminalInfo[] {
    return [...this.byId.values()].map((t) => t.info);
  }

  replay(id: string): string {
    return this.byId.get(id)?.ring.snapshot().toString("base64") ?? "";
  }
}
