# Terminals 7.1 — PTY Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real interactive terminals in the web app — daemon-spawned PTYs (shell/claude/codex) streamed through the hub over the existing WebSocket, rendered with xterm.js, gated by an on-machine `terminals` grant, tmux-style re-attachable with scrollback replay.

**Architecture:** The daemon gains a `TerminalService` (node-pty, lazy-loaded, ring-buffered). The hub gains a `TerminalRegistry` + relay branches in the `/ws` handler (it never interprets terminal bytes) + three REST control routes. The web gains a send-capable socket layer, a `TerminalView` (xterm.js), and a TERMINALS sidebar section. All byte payloads are base64 strings inside the existing JSON frames.

**Tech Stack:** node-pty (daemon, optionalDependency), @xterm/xterm + @xterm/addon-fit (web), Zod schemas in shared, existing Fastify/ws/Zustand plumbing.

## Global Constraints

- Work on branch `feat/terminals` (created in Task 1); merge to `main` with `--no-ff` after the whole plan (finish-branch flow, not part of this plan).
- Backend tests run from the REPO ROOT: `npx vitest run packages/<pkg>/test/<file>.test.ts` (NOT via `pnpm --filter`). Web tests: `npx pnpm --filter @conclave/web exec vitest run <path relative to packages/web>`; never run the full web suite in foreground (it hangs on teardown after printing results — kill it; the printed results count). `pnpm` is not on PATH — use `npx pnpm ...`.
- **MEMORY: 9–12 GB RAM machine that has OOM-killed a session.** One heavy thing at a time; never overlap full suites.
- `HelloSchema` gains `terminals` as `.default(false)` — NOT required (a required shared-field change broke sibling packages' typecheck twice in step 6.2). Still run `npx pnpm -r typecheck` after every shared change.
- Frame payload contract (exact): `term-data`/`term-replay` carry `data` as **base64**; scrollback ring buffer caps at **1 MiB per terminal** (bytes, not lines); spawn cwd must pass `GrantStore.resolveJailed`.
- The web frame type for the aggregated list is `terminal-list` — note it also matches a `term-` prefix test; the web socket layer MUST dispatch by explicit type-set membership, not prefix.
- All web colors via theme tokens (`var(--…)`); terminal row tinting via the existing `agentColorVar()`; JetBrains Mono 11px / line-height 1.7 for terminal text (handoff).
- `node-pty` is an **optionalDependency** of the daemon (a failed native build must not break `pnpm install`); `pnpm-workspace.yaml` `allowBuilds` gains `node-pty: true` (it NEEDS its postinstall gyp build — unlike sharp).
- Commit message body ends with:
  `Claude-Session: https://claude.ai/code/session_01MJ8FKhtSEmDL7SuhNtRrGN`

---

### Task 1: Shared terminal schemas + `terminals` grant (store + CLI)

**Files:**
- Create: `packages/shared/src/terminal.ts`
- Modify: `packages/shared/src/index.ts` (add export)
- Modify: `packages/shared/src/fs.ts` (HelloSchema gains `terminals` default)
- Modify: `packages/daemon/src/grants.ts` (add `terminalsGranted()`)
- Modify: `packages/daemon/src/cli.ts` (grant-terminals / revoke-terminals, preserve `terminals` key in save)
- Test: `packages/shared/test/terminal.test.ts`, `packages/daemon/test/grants-terminals.test.ts`

**Interfaces:**
- Consumes: existing `GrantStore` (`roots()`, `resolveJailed()`), existing `HelloSchema {machine, files}`.
- Produces: `TerminalKindSchema`/`TerminalKind`, `TerminalInfoSchema`/`TerminalInfo`, `SpawnTerminalSchema`/`SpawnTerminal`, `TermToDaemonFrameSchema`/`TermToDaemonFrame`, `TermListFrameSchema`, `TermReplayFrameSchema`, `TermExitFrameSchema`, `TermErrorFrameSchema` from `@conclave/shared`; `GrantStore.terminalsGranted(): boolean`; CLI commands `grant-terminals`/`revoke-terminals`; `Hello.terminals: boolean` (defaults false).

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/terminals
```

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/terminal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  HelloSchema,
  SpawnTerminalSchema,
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

  it("hello defaults terminals to false and accepts true", () => {
    const legacy = HelloSchema.parse({ machine: "m1", files: [] });
    expect(legacy.terminals).toBe(false);
    const on = HelloSchema.parse({ machine: "m1", files: ["/w"], terminals: true });
    expect(on.terminals).toBe(true);
  });
});
```

`packages/daemon/test/grants-terminals.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.js";
import { runCli } from "../src/cli.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-tgrant-")), "grants.json");
}

describe("terminals grant", () => {
  it("is false when the file is absent or lacks the key", () => {
    const f = tmpFile();
    expect(new GrantStore(f).terminalsGranted()).toBe(false);
    writeFileSync(f, JSON.stringify({ files: ["/w"] }));
    expect(new GrantStore(f).terminalsGranted()).toBe(false);
  });

  it("grant-terminals turns it on and preserves file roots; revoke turns it off", () => {
    const f = tmpFile();
    runCli(["grant", "/w"], f);
    runCli(["grant-terminals"], f);
    expect(new GrantStore(f).terminalsGranted()).toBe(true);
    expect(new GrantStore(f).roots()).toEqual(["/w"]);
    // a later files grant must not wipe the terminals flag
    runCli(["grant", "/w2"], f);
    expect(new GrantStore(f).terminalsGranted()).toBe(true);
    runCli(["revoke-terminals"], f);
    expect(new GrantStore(f).terminalsGranted()).toBe(false);
    const raw = JSON.parse(readFileSync(f, "utf8")) as { files: string[]; terminals: boolean };
    expect(raw.files).toEqual(["/w", "/w2"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/shared/test/terminal.test.ts packages/daemon/test/grants-terminals.test.ts`
Expected: FAIL — `terminal.js` module not found / `terminalsGranted is not a function` / unknown CLI command.

- [ ] **Step 4: Implement**

`packages/shared/src/terminal.ts`:

```ts
import { z } from "zod";

export const TerminalKindSchema = z.enum(["shell", "claude", "codex"]);

export const TerminalInfoSchema = z.object({
  id: z.string().min(1),
  machine: z.string().min(1),
  kind: TerminalKindSchema,
  label: z.string().min(1),
  cwd: z.string().min(1),
  agentId: z.string().optional(),
  startedAt: z.string(),
});

export const SpawnTerminalSchema = z.object({
  machine: z.string().min(1),
  kind: TerminalKindSchema,
  cwd: z.string().min(1),
});

// hub -> daemon (and client -> hub -> daemon) control/stream frames
export const TermSpawnFrameSchema = z.object({
  type: z.literal("term-spawn"),
  kind: TerminalKindSchema,
  cwd: z.string().min(1),
});
export const TermKillFrameSchema = z.object({
  type: z.literal("term-kill"),
  terminalId: z.string().min(1),
});
export const TermDataFrameSchema = z.object({
  type: z.literal("term-data"),
  terminalId: z.string().min(1),
  data: z.string(), // base64
});
export const TermResizeFrameSchema = z.object({
  type: z.literal("term-resize"),
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const TermAttachFrameSchema = z.object({
  type: z.literal("term-attach"),
  terminalId: z.string().min(1),
  requestId: z.string().min(1),
});
export const TermDetachFrameSchema = z.object({
  type: z.literal("term-detach"),
  terminalId: z.string().min(1),
});
export const TermToDaemonFrameSchema = z.discriminatedUnion("type", [
  TermSpawnFrameSchema,
  TermKillFrameSchema,
  TermDataFrameSchema,
  TermResizeFrameSchema,
  TermAttachFrameSchema,
  TermDetachFrameSchema,
]);

// daemon -> hub frames (term-data reuses TermDataFrameSchema)
export const TermListFrameSchema = z.object({
  type: z.literal("term-list"),
  terminals: z.array(TerminalInfoSchema),
});
export const TermReplayFrameSchema = z.object({
  type: z.literal("term-replay"),
  terminalId: z.string().min(1),
  requestId: z.string().min(1),
  data: z.string(), // base64 ring-buffer snapshot
});
export const TermExitFrameSchema = z.object({
  type: z.literal("term-exit"),
  terminalId: z.string().min(1),
  exitCode: z.number().int(),
});
export const TermErrorFrameSchema = z.object({
  type: z.literal("term-error"),
  message: z.string(),
});

export type TerminalKind = z.infer<typeof TerminalKindSchema>;
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;
export type SpawnTerminal = z.infer<typeof SpawnTerminalSchema>;
export type TermToDaemonFrame = z.infer<typeof TermToDaemonFrameSchema>;
```

`packages/shared/src/index.ts`: append `export * from "./terminal.js";`

`packages/shared/src/fs.ts` — HelloSchema becomes:

```ts
export const HelloSchema = z.object({
  machine: z.string().min(1),
  files: z.array(z.string()),
  terminals: z.boolean().default(false),
});
```

`packages/daemon/src/grants.ts` — add inside `GrantStore`:

```ts
  terminalsGranted(): boolean {
    if (!existsSync(this.grantsFile)) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.grantsFile, "utf8")) as { terminals?: unknown };
      return parsed.terminals === true;
    } catch {
      return false;
    }
  }
```

`packages/daemon/src/cli.ts` — replace `load`/`save` and extend `runCli` (full new body):

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

interface Grants {
  files: string[];
  terminals: boolean;
}

function load(file: string): Grants {
  if (!existsSync(file)) return { files: [], terminals: false };
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as { files?: unknown; terminals?: unknown };
    return {
      files: Array.isArray(p.files) ? (p.files as string[]) : [],
      terminals: p.terminals === true,
    };
  } catch {
    return { files: [], terminals: false };
  }
}

function save(file: string, grants: Grants): void {
  writeFileSync(file, JSON.stringify(grants, null, 2));
}

export function runCli(argv: string[], grantsFile: string): void {
  const [cmd, arg] = argv;
  const grants = load(grantsFile);
  if (cmd === "grant") {
    if (!arg) throw new Error("usage: conclave-daemon grant <path>");
    const abs = resolve(arg);
    if (!grants.files.includes(abs)) grants.files.push(abs);
    save(grantsFile, grants);
    console.log(`granted files: ${abs}`);
  } else if (cmd === "revoke") {
    if (!arg) throw new Error("usage: conclave-daemon revoke <path>");
    grants.files = grants.files.filter((r) => r !== resolve(arg));
    save(grantsFile, grants);
    console.log(`revoked files: ${resolve(arg)}`);
  } else if (cmd === "grant-terminals") {
    grants.terminals = true;
    save(grantsFile, grants);
    console.log("granted terminals");
  } else if (cmd === "revoke-terminals") {
    grants.terminals = false;
    save(grantsFile, grants);
    console.log("revoked terminals");
  } else if (cmd === "grants") {
    for (const r of grants.files) console.log(r);
    console.log(`terminals: ${grants.terminals ? "on" : "off"}`);
  } else {
    console.error("usage: conclave-daemon <grant|revoke|grant-terminals|revoke-terminals|grants> [path]");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2), process.env["CONCLAVE_GRANTS_FILE"] ?? "./conclave-grants.json");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/test/terminal.test.ts packages/daemon/test/grants-terminals.test.ts`
Expected: PASS. If an existing CLI test (`packages/daemon/test/cli.test.ts` or similar) asserts on the old `grants` output format, update its expectation to include the new `terminals: off` line — that is the only sanctioned out-of-list edit.

- [ ] **Step 6: Typecheck everything, run affected suites, commit**

Run: `npx pnpm -r typecheck` (all four packages must pass — Hello default should be fallout-free, verify), then `npx vitest run packages/shared/test packages/daemon/test`.

```bash
git add packages/shared packages/daemon
git commit -m "feat(shared,daemon): terminal schemas + terminals grant"
```

---

### Task 2: Daemon TerminalService (node-pty, ring buffer)

**Files:**
- Create: `packages/daemon/src/ring-buffer.ts`
- Create: `packages/daemon/src/terminal-service.ts`
- Modify: `packages/daemon/package.json` (optionalDependencies)
- Modify: `pnpm-workspace.yaml` (allowBuilds `node-pty: true`)
- Test: `packages/daemon/test/ring-buffer.test.ts`, `packages/daemon/test/terminal-service.test.ts`

**Interfaces:**
- Consumes: `GrantStore` (`terminalsGranted()`, `resolveJailed()` — throws `PathJailError`), `childEnv()`, `TerminalInfo`/`TerminalKind` from Task 1.
- Produces: `loadPty(): Promise<PtyModule | null>`; `class TerminalService` with `spawn({kind, cwd}): TerminalInfo`, `write(id, dataB64)`, `resize(id, cols, rows)`, `kill(id)`, `list(): TerminalInfo[]`, `replay(id): string` (base64), and `events: EventEmitter` emitting `"data" (terminalId: string, dataB64: string)`, `"exit" (terminalId: string, exitCode: number)`, `"list-changed" ()`; `TerminalsNotGrantedError`; `RingBuffer` with `push(b: Buffer)`, `snapshot(): Buffer`.

- [ ] **Step 1: Add the dependency**

In `packages/daemon/package.json` add:

```json
  "optionalDependencies": {
    "node-pty": "^1.0.0"
  }
```

In `pnpm-workspace.yaml`, under the existing `allowBuilds:` key (added in step 6.3 with `sharp: false`), add `node-pty: true` — node-pty REQUIRES its node-gyp postinstall build. Then from the repo root:

```bash
npx pnpm install
node -e "import('node-pty').then(m => console.log('node-pty ok', typeof m.spawn))"
```

Expected: `node-pty ok function`. If the build fails, install build tools (python3/make/g++) — the Dockerfile already requires them for better-sqlite3, and the dev machine has them.

- [ ] **Step 2: Write the failing tests**

`packages/daemon/test/ring-buffer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("returns everything under the cap, in order", () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from("hello "));
    rb.push(Buffer.from("world"));
    expect(rb.snapshot().toString()).toBe("hello world");
  });

  it("evicts oldest chunks beyond the byte cap", () => {
    const rb = new RingBuffer(10);
    rb.push(Buffer.from("aaaaa"));
    rb.push(Buffer.from("bbbbb"));
    rb.push(Buffer.from("cc"));
    const out = rb.snapshot().toString();
    expect(out.endsWith("bbbbbcc")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.includes("a")).toBe(false); // the whole oldest chunk was dropped
  });
});
```

`packages/daemon/test/terminal-service.test.ts` (real PTYs; whole suite skips when node-pty is unavailable — the degrade path):

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/daemon/test/ring-buffer.test.ts packages/daemon/test/terminal-service.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`packages/daemon/src/ring-buffer.ts`:

```ts
// Byte-capped FIFO of output chunks. Whole oldest chunks are evicted when the
// cap is exceeded — VT escape sequences may be split across chunk boundaries
// either way, and xterm.js tolerates a mid-sequence start on replay.
export class RingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly capBytes: number) {}

  push(b: Buffer): void {
    this.chunks.push(b);
    this.bytes += b.length;
    while (this.bytes > this.capBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.length;
    }
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
```

`packages/daemon/src/terminal-service.ts`:

```ts
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { SpawnTerminal, TerminalInfo, TerminalKind } from "@conclave/shared";
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

  spawn(req: Omit<SpawnTerminal, "machine">): TerminalInfo {
    if (!this.grants.terminalsGranted()) throw new TerminalsNotGrantedError();
    const cwd = this.grants.resolveJailed(req.cwd);
    const shell = this.opts.shellBin ?? process.env["SHELL"] ?? "/bin/sh";
    const bin = req.kind === "shell" ? shell : req.kind === "claude" ? this.opts.claudeBin : this.opts.codexBin;
    const label =
      req.kind === "shell" ? `${basename(shell)} · you` : `${req.kind} · ${basename(cwd)}`;
    const info: TerminalInfo = {
      id: `term-${randomUUID()}`,
      machine: this.opts.machine,
      kind: req.kind,
      label,
      cwd,
      agentId: req.kind === "shell" ? undefined : this.opts.resolveAgentId?.(req.kind),
      startedAt: new Date().toISOString(),
    };
    const pty = this.ptyMod.spawn(bin, [], {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/test/ring-buffer.test.ts packages/daemon/test/terminal-service.test.ts`
Expected: PASS (real `/bin/sh` PTYs echo and exit).

- [ ] **Step 6: Typecheck, commit**

Run: `npx pnpm -r typecheck`, then:

```bash
git add packages/daemon pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(daemon): TerminalService with node-pty and ring-buffered scrollback"
```

---

### Task 3: Daemon wiring — HubSocket term frames + main.ts

**Files:**
- Create: `packages/daemon/src/terminal-wiring.ts`
- Modify: `packages/daemon/src/hub-socket.ts` (add `onTerm` option + dispatch branch)
- Modify: `packages/daemon/src/main.ts` (load pty, construct service, wire frames, hello carries capability)
- Test: `packages/daemon/test/terminal-wiring.test.ts`

**Interfaces:**
- Consumes: `TerminalService` (Task 2 — `spawn/write/resize/kill/list/replay`, `events`), `TermToDaemonFrame`/`TermToDaemonFrameSchema` (Task 1), `HubSocket.send(frame)`.
- Produces: `HubSocketOptions.onTerm?: (f: TermToDaemonFrame) => void`; `wireTerminals(deps: {service: TerminalService | null; granted: boolean; send: (frame: unknown) => void}): {onTerm: (f: TermToDaemonFrame) => void; sendList: () => void}` — Task 4's hub relays frames this handler consumes; Task 7 wires it against a live hub.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/terminal-wiring.test.ts` (drives the handler with a fake service-shaped object where cheap, and a real service where the behavior matters):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/test/terminal-wiring.test.ts`
Expected: FAIL — `terminal-wiring.js` not found.

- [ ] **Step 3: Implement**

`packages/daemon/src/terminal-wiring.ts`:

```ts
import type { TermToDaemonFrame } from "@conclave/shared";
import type { TerminalService } from "./terminal-service.js";

export interface TerminalWiringDeps {
  service: TerminalService | null;
  granted: boolean;
  send: (frame: unknown) => void;
}

// Frame handler for hub->daemon terminal traffic plus upstream event wiring.
// The daemon never tracks attached clients — the hub owns subscriptions; this
// side only answers attach with a ring-buffer replay.
export function wireTerminals(deps: TerminalWiringDeps): {
  onTerm: (f: TermToDaemonFrame) => void;
  sendList: () => void;
} {
  const { service, send } = deps;
  const sendList = (): void => {
    send({ type: "term-list", terminals: service?.list() ?? [] });
  };

  if (service) {
    service.events.on("data", (terminalId: string, data: string) => {
      send({ type: "term-data", terminalId, data });
    });
    service.events.on("exit", (terminalId: string, exitCode: number) => {
      send({ type: "term-exit", terminalId, exitCode });
    });
    service.events.on("list-changed", sendList);
  }

  const onTerm = (f: TermToDaemonFrame): void => {
    if (!service || !deps.granted) {
      if (f.type === "term-spawn") send({ type: "term-error", message: "terminals not available on this machine" });
      return;
    }
    try {
      switch (f.type) {
        case "term-spawn":
          service.spawn({ kind: f.kind, cwd: f.cwd });
          break; // list-changed event already sent the updated term-list
        case "term-kill":
          service.kill(f.terminalId);
          break;
        case "term-data":
          service.write(f.terminalId, f.data);
          break;
        case "term-resize":
          service.resize(f.terminalId, f.cols, f.rows);
          break;
        case "term-attach":
          send({ type: "term-replay", terminalId: f.terminalId, requestId: f.requestId, data: service.replay(f.terminalId) });
          break;
        case "term-detach":
          break; // hub-side bookkeeping only
      }
    } catch (err) {
      send({ type: "term-error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return { onTerm, sendList };
}
```

`packages/daemon/src/hub-socket.ts` — two edits:

1. `HubSocketOptions` gains:

```ts
  onTerm?: (f: TermToDaemonFrame) => void;
```

with `TermToDaemonFrameSchema, type TermToDaemonFrame` added to the `@conclave/shared` import.

2. In `handleData`, after the `fs-request` branch, add:

```ts
        if (typeof candidate.type === "string" && candidate.type.startsWith("term-") && this.opts.onTerm) {
          const parsedTerm = TermToDaemonFrameSchema.safeParse(frame);
          if (parsedTerm.success) this.opts.onTerm(parsedTerm.data);
          return;
        }
```

`packages/daemon/src/main.ts` — wire it (edits shown in context):

```ts
import { loadPty, TerminalService } from "./terminal-service.js";
import { wireTerminals } from "./terminal-wiring.js";
```

after `const fileService = new FileService(grants);`:

```ts
  const ptyMod = await loadPty();
  const termsGranted = grants.terminalsGranted() && ptyMod !== null;
  if (grants.terminalsGranted() && !ptyMod) {
    console.warn("terminals granted but node-pty failed to load — terminals disabled");
  }
  const terminalService = ptyMod
    ? new TerminalService(ptyMod, grants, {
        machine: cfg.machine,
        claudeBin: cfg.claudeBin,
        codexBin: cfg.codexBin,
        resolveAgentId: (kind) =>
          agents.find((a) => (kind === "claude" ? a.runtime === "claude-code" : a.runtime === "codex"))?.id,
      })
    : null;
```

after the `const socket = new HubSocket({ ... })` declaration is where the circular send dependency bites — construct the wiring first with a late-bound sender:

```ts
  const terminals = wireTerminals({
    service: terminalService,
    granted: termsGranted,
    send: (frame) => socket.send(frame),
  });
```

Place this AFTER `const socket = ...` (the arrow closes over `socket`, which is initialized by the time any frame flows). Then inside the `HubSocket` options:
- add `onTerm: (f) => terminals.onTerm(f),` — since `terminals` is declared after `socket`, instead declare a holder before the socket: `let terminals: ReturnType<typeof wireTerminals>;` and use `onTerm: (f) => terminals.onTerm(f),`, assigning `terminals = wireTerminals({...})` right after the socket declaration.
- change the hello line inside `onOpen` to:

```ts
      socket.send({ type: "hello", machine: cfg.machine, files: grants.roots(), terminals: termsGranted });
      terminals.sendList();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/test/terminal-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Full daemon suite + typecheck, commit**

Run: `npx vitest run packages/daemon/test` then `npx pnpm -r typecheck`.

```bash
git add packages/daemon
git commit -m "feat(daemon): terminal frame wiring over the hub socket"
```

---

### Task 4: Hub — TerminalRegistry, /ws relay, REST routes

**Files:**
- Create: `packages/hub/src/terminal-registry.ts`
- Modify: `packages/hub/src/fs-tunnel.ts` (MachineConn gains `terminals`, `register` gains param, add `machineOfSocket`)
- Modify: `packages/hub/src/server.ts` (ws-client set, term frame branches, 3 REST routes)
- Test: `packages/hub/test/terminals.test.ts`

**Interfaces:**
- Consumes: `TerminalInfo`, `SpawnTerminalSchema`, `TermListFrameSchema` (Task 1); `MachineRegistry`; daemon frames from Task 3.
- Produces: REST `GET /api/terminals → TerminalInfo[]`, `POST /api/terminals {machine,kind,cwd} → 202 {ok:true} | 400 | 403 | 503`, `DELETE /api/terminals/:id → {ok:true} | 404 | 503`; ws broadcast frame `{type:"terminal-list", terminals: TerminalInfo[]}` (aggregated, all machines); `GET /api/machines` rows gain `terminals: boolean`. `class TerminalRegistry` with `setList(machine, terms)`, `list()`, `machineOf(id)`, `clearMachine(machine)`, `attach(id, socket)`, `detach(id, socket)`, `detachSocket(socket)`, `attached(id): FsSocket[]`, `notePendingAttach(requestId, socket)`, `takePendingAttach(requestId): FsSocket | undefined`.

- [ ] **Step 1: Write the failing tests**

`packages/hub/test/terminals.test.ts` — real hub over real ws sockets (a "daemon" ws that sends `hello`, and client ws sockets):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "term-test-token";

async function makeApp(): Promise<{ app: FastifyInstance; port: number }> {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-termhub-")), "t.db"));
  const app = await buildServer({ mailbox: new Mailbox(db), token: TOKEN });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, port: (app.server.address() as AddressInfo).port };
}

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function frames(ws: WebSocket): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Record<string, unknown>));
  return seen;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const TERM = {
  id: "term-1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("hub terminal relay", () => {
  let app: FastifyInstance;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await app.close();
  });

  async function daemon(port: number): Promise<{ ws: WebSocket; seen: Array<Record<string, unknown>> }> {
    const ws = await connect(port);
    sockets.push(ws);
    const seen = frames(ws);
    ws.send(JSON.stringify({ type: "hello", machine: "m1", files: ["/w"], terminals: true }));
    ws.send(JSON.stringify({ type: "term-list", terminals: [TERM] }));
    return { ws, seen };
  }

  it("broadcasts terminal-list, routes input to the daemon, output only to attached clients", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;
    const d = await daemon(port);
    const attached = await connect(port);
    const bystander = await connect(port);
    sockets.push(attached, bystander);
    const attachedSeen = frames(attached);
    const bystanderSeen = frames(bystander);

    await waitFor(() => attachedSeen.some((f) => f["type"] === "terminal-list"));

    attached.send(JSON.stringify({ type: "term-attach", terminalId: "term-1", requestId: "r1" }));
    await waitFor(() => d.seen.some((f) => f["type"] === "term-attach"));

    // replay goes ONLY to the requester
    d.ws.send(JSON.stringify({ type: "term-replay", terminalId: "term-1", requestId: "r1", data: "cmVwbGF5" }));
    await waitFor(() => attachedSeen.some((f) => f["type"] === "term-replay"));
    expect(bystanderSeen.some((f) => f["type"] === "term-replay")).toBe(false);

    // client input routes to the daemon
    attached.send(JSON.stringify({ type: "term-data", terminalId: "term-1", data: "aW5wdXQ=" }));
    await waitFor(() => d.seen.some((f) => f["type"] === "term-data" && f["data"] === "aW5wdXQ="));

    // daemon output reaches attached, not the bystander
    d.ws.send(JSON.stringify({ type: "term-data", terminalId: "term-1", data: "b3V0cHV0" }));
    await waitFor(() => attachedSeen.some((f) => f["type"] === "term-data" && f["data"] === "b3V0cHV0"));
    expect(bystanderSeen.some((f) => f["type"] === "term-data")).toBe(false);

    // exit is forwarded to attached clients
    d.ws.send(JSON.stringify({ type: "term-exit", terminalId: "term-1", exitCode: 0 }));
    await waitFor(() => attachedSeen.some((f) => f["type"] === "term-exit"));
  }, 15000);

  it("REST: list/spawn/kill with 403/503/404 gates", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;

    // no machine at all -> spawn 503
    let res = await app.inject({
      method: "POST", url: "/api/terminals",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", kind: "shell", cwd: "/w" },
    });
    expect(res.statusCode).toBe(503);

    const d = await daemon(port);

    // list reflects the daemon's term-list once the frames land
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });
    const listRes = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
    expect((JSON.parse(listRes.payload) as Array<{ id: string }>)[0]!.id).toBe("term-1");

    // spawn relays term-spawn to the daemon
    res = await app.inject({
      method: "POST", url: "/api/terminals",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", kind: "shell", cwd: "/w" },
    });
    expect(res.statusCode).toBe(202);
    await waitFor(() => d.seen.some((f) => f["type"] === "term-spawn"));

    // kill relays term-kill
    res = await app.inject({
      method: "DELETE", url: "/api/terminals/term-1", headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => d.seen.some((f) => f["type"] === "term-kill"));

    // unknown terminal id -> 404
    res = await app.inject({
      method: "DELETE", url: "/api/terminals/nope", headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);

    // machines list carries the capability
    res = await app.inject({ method: "GET", url: "/api/machines", headers: { authorization: `Bearer ${TOKEN}` } });
    expect((JSON.parse(res.payload) as Array<{ terminals: boolean }>)[0]!.terminals).toBe(true);
  }, 15000);

  it("403 when the machine lacks the terminals grant; daemon disconnect clears its terminals", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;
    const ws = await connect(port);
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "hello", machine: "m1", files: ["/w"], terminals: false }));
    ws.send(JSON.stringify({ type: "term-list", terminals: [TERM] }));

    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });

    const res = await app.inject({
      method: "POST", url: "/api/terminals",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", kind: "shell", cwd: "/w" },
    });
    expect(res.statusCode).toBe(403);

    const client = await connect(port);
    sockets.push(client);
    const clientSeen = frames(client);
    ws.close();
    await waitFor(() => clientSeen.some((f) =>
      f["type"] === "terminal-list" && (f["terminals"] as unknown[]).length === 0));
  }, 15000);
});
```

Note for the implementer: the two `waitFor(async () => …)` casts above are awkward — replace them with a small async-aware `waitForAsync(cond: () => Promise<boolean>)` helper in the test file if you prefer; the behavior asserted (list eventually reflects the daemon's term-list) is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/terminals.test.ts`
Expected: FAIL — routes 404, no terminal-list broadcast.

- [ ] **Step 3: Implement**

`packages/hub/src/terminal-registry.ts`:

```ts
import type { TerminalInfo } from "@conclave/shared";
import type { FsSocket } from "./fs-tunnel.js";

export class TerminalRegistry {
  private readonly byMachine = new Map<string, TerminalInfo[]>();
  private readonly attachments = new Map<string, Set<FsSocket>>();
  private readonly pendingAttach = new Map<string, FsSocket>();

  setList(machine: string, terminals: TerminalInfo[]): void {
    this.byMachine.set(machine, terminals);
    // drop attachments for terminals that no longer exist on any machine
    const liveIds = new Set(this.list().map((t) => t.id));
    for (const id of [...this.attachments.keys()]) {
      if (!liveIds.has(id)) this.attachments.delete(id);
    }
  }

  list(): TerminalInfo[] {
    return [...this.byMachine.values()].flat();
  }

  machineOf(id: string): string | undefined {
    for (const [machine, terms] of this.byMachine) {
      if (terms.some((t) => t.id === id)) return machine;
    }
    return undefined;
  }

  clearMachine(machine: string): void {
    this.byMachine.delete(machine);
  }

  attach(id: string, socket: FsSocket): void {
    const set = this.attachments.get(id) ?? new Set<FsSocket>();
    set.add(socket);
    this.attachments.set(id, set);
  }

  detach(id: string, socket: FsSocket): void {
    this.attachments.get(id)?.delete(socket);
  }

  detachSocket(socket: FsSocket): void {
    for (const set of this.attachments.values()) set.delete(socket);
    for (const [reqId, s] of this.pendingAttach) {
      if (s === socket) this.pendingAttach.delete(reqId);
    }
  }

  attached(id: string): FsSocket[] {
    return [...(this.attachments.get(id) ?? [])];
  }

  notePendingAttach(requestId: string, socket: FsSocket): void {
    this.pendingAttach.set(requestId, socket);
  }

  takePendingAttach(requestId: string): FsSocket | undefined {
    const s = this.pendingAttach.get(requestId);
    this.pendingAttach.delete(requestId);
    return s;
  }
}
```

`packages/hub/src/fs-tunnel.ts` edits:

```ts
export interface MachineConn {
  socket: FsSocket;
  roots: string[];
  terminals: boolean;
  lastSeen: string;
}
```

```ts
  register(machine: string, socket: FsSocket, roots: string[], terminals = false): void {
    this.byMachine.set(machine, { socket, roots, terminals, lastSeen: new Date().toISOString() });
  }
```

```ts
  machineOfSocket(socket: FsSocket): string | undefined {
    for (const [machine, conn] of this.byMachine) {
      if (conn.socket === socket) return machine;
    }
    return undefined;
  }
```

and `list()` gains `terminals: c.terminals` in its mapped row.

`packages/hub/src/server.ts` edits:

Imports: add `SpawnTerminalSchema, TermListFrameSchema` to the `@conclave/shared` import and `import { TerminalRegistry } from "./terminal-registry.js";`

Next to `const machines = new MachineRegistry();`:

```ts
  const terminals = new TerminalRegistry();
  const wsSockets = new Set<{ send(data: string): void }>();
  const broadcastTerminalList = (): void => {
    const payload = JSON.stringify({ type: "terminal-list", terminals: terminals.list() });
    for (const s of wsSockets) s.send(payload);
  };
```

In the `/ws` handler: `wsSockets.add(socket);` first thing. The `hello` branch becomes:

```ts
      if (f.type === "hello") {
        const parsed = HelloSchema.safeParse(frame);
        if (parsed.success) machines.register(parsed.data.machine, socket, parsed.data.files, parsed.data.terminals);
      }
```

After the `fs-response` branch add the term relay (raw is re-serialized once; the hub never decodes `data`):

```ts
      else if (typeof f.type === "string" && f.type.startsWith("term-")) {
        const raw2 = JSON.stringify(frame);
        const fromMachine = machines.machineOfSocket(socket);
        const t = frame as { type: string; terminalId?: string; requestId?: string };
        if (fromMachine) {
          // daemon-origin frames
          if (t.type === "term-list") {
            const parsed = TermListFrameSchema.safeParse(frame);
            if (parsed.success) {
              terminals.setList(fromMachine, parsed.data.terminals);
              broadcastTerminalList();
            }
          } else if (t.type === "term-replay" && t.requestId) {
            terminals.takePendingAttach(t.requestId)?.send(raw2);
          } else if ((t.type === "term-data" || t.type === "term-exit") && t.terminalId) {
            for (const c of terminals.attached(t.terminalId)) c.send(raw2);
          } else if (t.type === "term-error") {
            for (const s of wsSockets) s.send(raw2);
          }
        } else {
          // client-origin frames
          if (t.type === "term-attach" && t.terminalId && t.requestId) {
            terminals.attach(t.terminalId, socket);
            terminals.notePendingAttach(t.requestId, socket);
          } else if (t.type === "term-detach" && t.terminalId) {
            terminals.detach(t.terminalId, socket);
            return;
          }
          const machine = t.terminalId ? terminals.machineOf(t.terminalId) : undefined;
          if (machine) machines.get(machine)?.socket.send(raw2);
        }
      }
```

In the `close` handler, before `machines.unregisterSocket(socket)`:

```ts
      wsSockets.delete(socket);
      terminals.detachSocket(socket);
      const machine = machines.machineOfSocket(socket);
      machines.unregisterSocket(socket);
      if (machine) {
        terminals.clearMachine(machine);
        broadcastTerminalList();
      }
```

(replacing the existing bare `machines.unregisterSocket(socket);` line).

REST routes, placed right after the `/api/machines` route:

```ts
  app.get("/api/terminals", async () => terminals.list());

  app.post("/api/terminals", async (req, reply) => {
    const parsed = SpawnTerminalSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid spawn request" });
    const conn = machines.get(parsed.data.machine);
    if (!conn) return reply.code(503).send({ error: `machine unreachable: ${parsed.data.machine}` });
    if (!conn.terminals) return reply.code(403).send({ error: `terminals not granted on ${parsed.data.machine}` });
    conn.socket.send(JSON.stringify({ type: "term-spawn", kind: parsed.data.kind, cwd: parsed.data.cwd }));
    return reply.code(202).send({ ok: true });
  });

  app.delete("/api/terminals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const machine = terminals.machineOf(id);
    if (!machine) return reply.code(404).send({ error: "unknown terminal" });
    const conn = machines.get(machine);
    if (!conn) return reply.code(503).send({ error: `machine unreachable: ${machine}` });
    conn.socket.send(JSON.stringify({ type: "term-kill", terminalId: id }));
    return { ok: true };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/terminals.test.ts`
Expected: PASS.

- [ ] **Step 5: Full hub suite + typecheck, commit**

Run: `npx vitest run packages/hub/test` then `npx pnpm -r typecheck`. The `MachineConn.terminals` addition may break existing fs-tunnel test literals that construct conns directly — fix them by adding `terminals: false` (the register default keeps callers safe).

```bash
git add packages/hub
git commit -m "feat(hub): terminal registry, ws relay, and REST control routes"
```

---

### Task 5: Web data layer — send-capable socket, store, hubClient

**Files:**
- Create: `packages/web/src/lib/base64.ts`
- Modify: `packages/web/src/lib/socket.ts` (sendFrame, term-frame tap, terminal-list frame)
- Modify: `packages/web/src/store/useConclaveStore.ts` (terminals state + activation exclusivity)
- Modify: `packages/web/src/lib/hubClient.ts` (3 methods, MachineInfo.terminals)
- Modify: `packages/web/src/store/sync.ts` (hydrate terminals)
- Test: `packages/web/src/lib/__tests__/base64.test.ts`, `packages/web/src/lib/__tests__/term-socket.test.ts`, `packages/web/src/store/__tests__/terminals-store.test.ts`

**Interfaces:**
- Consumes: `TerminalInfo` from `@conclave/shared`; hub REST routes + `terminal-list` frame (Task 4).
- Produces (Task 6 relies on these exact names): `sendFrame(frame: unknown): boolean` and `onTermFrame(fn: (f: TermStreamFrame) => void): () => void` from `lib/socket.ts` where `TermStreamFrame = { type: "term-data" | "term-replay" | "term-exit" | "term-error"; terminalId?: string; requestId?: string; data?: string; exitCode?: number; message?: string }`; `b64encode(s: string): string` / `b64decode(b64: string): Uint8Array` from `lib/base64.ts`; store fields `terminals: TerminalInfo[]`, `activeTerminalId: string | null`, actions `setTerminals(t: TerminalInfo[])`, `setActiveTerminal(id: string | null)`; hubClient `listTerminals()`, `spawnTerminal(machine, kind, cwd)`, `killTerminal(id)`; `MachineInfo` gains `terminals: boolean`.

- [ ] **Step 1: Write the failing tests**

`packages/web/src/lib/__tests__/base64.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { b64decode, b64encode } from "../base64.js";

describe("base64 helpers", () => {
  it("round-trips ascii and multibyte text", () => {
    for (const s of ["ls -la\n", "échò ünïcode ✓", ""]) {
      const decoded = new TextDecoder().decode(b64decode(b64encode(s)));
      expect(decoded).toBe(s);
    }
  });
  it("encodes to standard base64", () => {
    expect(b64encode("hi")).toBe("aGk=");
  });
});
```

`packages/web/src/lib/__tests__/term-socket.test.ts` (fake WebSocket global, same pattern as existing socket tests if present — otherwise this standalone fake):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSocket, onTermFrame, sendFrame, type WsFrame } from "../socket.js";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.onclose?.();
  }
}

describe("socket term plumbing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWS.instances = [];
  });

  it("dispatches term stream frames to onTermFrame subscribers, not applyFrame; terminal-list goes to applyFrame", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const frames: WsFrame[] = [];
    const close = connectSocket((f) => frames.push(f));
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();

    const termSeen: unknown[] = [];
    const off = onTermFrame((f) => termSeen.push(f));

    ws.onmessage?.({ data: JSON.stringify({ type: "term-data", terminalId: "t1", data: "aGk=" }) });
    ws.onmessage?.({ data: JSON.stringify({ type: "terminal-list", terminals: [] }) });

    expect(termSeen).toHaveLength(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("terminal-list");

    off();
    ws.onmessage?.({ data: JSON.stringify({ type: "term-exit", terminalId: "t1", exitCode: 0 }) });
    expect(termSeen).toHaveLength(1);
    close();
  });

  it("sendFrame serializes to the open socket and reports false when closed", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const close = connectSocket(() => {});
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();
    expect(sendFrame({ type: "term-detach", terminalId: "t1" })).toBe(true);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "term-detach", terminalId: "t1" });
    close();
    expect(sendFrame({ type: "term-detach", terminalId: "t1" })).toBe(false);
  });
});
```

`packages/web/src/store/__tests__/terminals-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";

const TERM = {
  id: "t1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("terminal store state", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("applyFrame terminal-list replaces the list", () => {
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [TERM] });
    expect(useConclaveStore.getState().terminals).toEqual([TERM]);
  });

  it("setActiveTerminal is exclusive with artifact/fsFile/thread views", () => {
    const s = useConclaveStore.getState();
    s.setActiveArtifact("a1");
    s.setActiveTerminal("t1");
    expect(useConclaveStore.getState().activeTerminalId).toBe("t1");
    expect(useConclaveStore.getState().activeArtifactId).toBeNull();

    useConclaveStore.getState().setActiveThread("th1");
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();

    useConclaveStore.getState().setActiveTerminal("t1");
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/x" });
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/base64.test.ts src/lib/__tests__/term-socket.test.ts src/store/__tests__/terminals-store.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement**

`packages/web/src/lib/base64.ts`:

```ts
export function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

`packages/web/src/lib/socket.ts` — full new version:

```ts
import type { AgentStatus, Approval, Artifact, Message, Task, TerminalInfo, Thread, TurnRequest, Workspace } from "@conclave/shared";
import { config } from "./config.js";

export type WsFrame =
  | { type: "message"; message: Message }
  | { type: "thread"; thread: Thread }
  | { type: "turn"; turn: TurnRequest }
  | { type: "agent-status"; status: AgentStatus }
  | { type: "task"; task: Task }
  | { type: "artifact"; artifact: Artifact }
  | { type: "workspace"; workspace: Workspace }
  | { type: "approval"; approval: Approval }
  | { type: "terminal-list"; terminals: TerminalInfo[] };

export type TermStreamFrame = {
  type: "term-data" | "term-replay" | "term-exit" | "term-error";
  terminalId?: string;
  requestId?: string;
  data?: string;
  exitCode?: number;
  message?: string;
};

// High-frequency terminal frames bypass the Zustand store: TerminalView
// subscribes directly. NOTE "terminal-list" also starts with "term-", so
// dispatch is by explicit membership, never prefix.
const TERM_STREAM_TYPES = new Set(["term-data", "term-replay", "term-exit", "term-error"]);

const termHandlers = new Set<(f: TermStreamFrame) => void>();
let current: WebSocket | null = null;

export function onTermFrame(fn: (f: TermStreamFrame) => void): () => void {
  termHandlers.add(fn);
  return () => termHandlers.delete(fn);
}

export function sendFrame(frame: unknown): boolean {
  if (!current || current.readyState !== WebSocket.OPEN) return false;
  current.send(JSON.stringify(frame));
  return true;
}

export function connectSocket(onFrame: (f: WsFrame) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const open = (): void => {
    if (closed) return;
    ws = new WebSocket(config.wsUrl());
    ws.onopen = () => {
      backoff = 500;
      current = ws;
    };
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data as string) as { type?: string };
        if (typeof frame.type === "string" && TERM_STREAM_TYPES.has(frame.type)) {
          for (const fn of termHandlers) fn(frame as TermStreamFrame);
        } else {
          onFrame(frame as WsFrame);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (current === ws) current = null;
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
  };
  open();

  return () => {
    closed = true;
    if (current === ws) current = null;
    ws?.close();
  };
}
```

`packages/web/src/store/useConclaveStore.ts` edits:
- import `TerminalInfo` from `@conclave/shared`.
- `State` gains: `terminals: TerminalInfo[];`, `activeTerminalId: string | null;`, `setTerminals(t: TerminalInfo[]): void;`, `setActiveTerminal(id: string | null): void;`
- `initial` gains: `terminals: [],` and `activeTerminalId: null,`
- actions:

```ts
  setTerminals: (t) => set({ terminals: t }),
  setActiveTerminal: (id) =>
    set(id ? { activeTerminalId: id, activeArtifactId: null, activeFsFile: null } : { activeTerminalId: id }),
```

- existing activation setters each also null the terminal: `setActiveThread` adds `activeTerminalId: null,`; `setActiveArtifact` becomes `set({ activeArtifactId: id, activeFsFile: null, activeTerminalId: null })`; `setActiveFsFile` becomes `set({ activeFsFile: f, activeArtifactId: null, activeTerminalId: null })`.
- `applyFrame` gains:

```ts
        case "terminal-list":
          return { terminals: f.terminals };
```

- `reset()` must include `terminals: [], activeTerminalId: null` (match how reset handles the other new-ish fields — check the existing reset object and extend it).

`packages/web/src/lib/hubClient.ts` edits:
- `MachineInfo` becomes `{ machine: string; files: string[]; terminals: boolean; lastSeen: string }`.
- import `TerminalInfo, TerminalKind` types from `@conclave/shared`; add methods:

```ts
  listTerminals: () => req<TerminalInfo[]>("GET", "/api/terminals"),
  spawnTerminal: (machine: string, kind: TerminalKind, cwd: string) =>
    req<{ ok: boolean }>("POST", "/api/terminals", { machine, kind, cwd }),
  killTerminal: (id: string) => req<{ ok: boolean }>("DELETE", `/api/terminals/${id}`),
```

`packages/web/src/store/sync.ts` — in `hydrate()`, alongside the other initial fetches, add:

```ts
  void hubClient.listTerminals().then((t) => useConclaveStore.getState().setTerminals(t)).catch(() => {});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/base64.test.ts src/lib/__tests__/term-socket.test.ts src/store/__tests__/terminals-store.test.ts`
Expected: PASS. Also run any existing tests that build `MachineInfo` fixtures (FilesPanel/store tests) and add `terminals: false` where they now fail to typecheck.

- [ ] **Step 5: Typecheck, commit**

Run: `npx pnpm -r typecheck`.

```bash
git add packages/web
git commit -m "feat(web): terminal data layer — send-capable socket, store state, hub client"
```

---

### Task 6: Web UI — TerminalView, tabs, TERMINALS sidebar

**Files:**
- Create: `packages/web/src/components/TerminalView.tsx`, `packages/web/src/components/TerminalView.module.css`
- Create: `packages/web/src/components/TerminalsSection.tsx`
- Modify: `packages/web/package.json` (`@xterm/xterm`, `@xterm/addon-fit`)
- Modify: `packages/web/src/components/SessionTabs.tsx` (terminal tab)
- Modify: `packages/web/src/App.tsx` (precedence)
- Modify: `packages/web/src/components/Sidebar.tsx` (+ `Sidebar.module.css`) — render `<TerminalsSection />` after the artifacts section
- Test: `packages/web/src/components/__tests__/TerminalsSection.test.tsx`, `packages/web/src/components/__tests__/TerminalView.test.tsx`

**Interfaces:**
- Consumes: everything Task 5 produced (`sendFrame`, `onTermFrame`, `b64encode`/`b64decode`, store fields, hubClient methods), `agentColorVar` from `lib/agents.ts`.
- Produces: `<TerminalView />` (renders the active terminal), `<TerminalsSection />` (sidebar rows + spawn picker, testids `terminals-section`, `terminal-row-<id>`, `spawn-terminal`, `spawn-submit`), terminal session tab (testid `terminal-tab`).

- [ ] **Step 1: Add deps**

In `packages/web/package.json` dependencies add `"@xterm/xterm": "^5.5.0"` and `"@xterm/addon-fit": "^0.10.0"`, then `npx pnpm install` from the repo root (no build scripts involved).

- [ ] **Step 2: Write the failing tests**

`packages/web/src/components/__tests__/TerminalsSection.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalsSection } from "../TerminalsSection.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => ({
  listMachines: vi.fn(async () => [
    { machine: "m1", files: ["/w"], terminals: true, lastSeen: "" },
    { machine: "m2", files: ["/x"], terminals: false, lastSeen: "" },
  ]),
  spawnTerminal: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/hubClient.js", () => ({ hubClient: mocks }));

const TERM = {
  id: "t1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("TerminalsSection", () => {
  beforeEach(() => {
    useConclaveStore.getState().reset();
    mocks.spawnTerminal.mockClear();
  });

  it("lists terminals and activates on click", async () => {
    useConclaveStore.getState().setTerminals([TERM]);
    render(<TerminalsSection />);
    await userEvent.click(screen.getByTestId("terminal-row-t1"));
    expect(useConclaveStore.getState().activeTerminalId).toBe("t1");
  });

  it("spawn picker offers only terminal-granted machines and submits a spawn", async () => {
    render(<TerminalsSection />);
    await userEvent.click(screen.getByTestId("spawn-terminal"));
    const machineSelect = await screen.findByLabelText("machine");
    expect(machineSelect).toHaveTextContent("m1");
    expect(machineSelect).not.toHaveTextContent("m2");
    await userEvent.click(screen.getByTestId("spawn-submit"));
    expect(mocks.spawnTerminal).toHaveBeenCalledWith("m1", "shell", "/w");
  });
});
```

`packages/web/src/components/__tests__/TerminalView.test.tsx` (xterm fully mocked — jsdom cannot run the real renderer):

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => {
  const term = {
    loadAddon: vi.fn(), open: vi.fn(), write: vi.fn(), dispose: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })), cols: 80, rows: 24,
  };
  return {
    term,
    Terminal: vi.fn(() => term),
    FitAddon: vi.fn(() => ({ fit: vi.fn() })),
    sendFrame: vi.fn(() => true),
    handlers: new Set<(f: unknown) => void>(),
  };
});
vi.mock("@xterm/xterm", () => ({ Terminal: mocks.Terminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: mocks.FitAddon }));
vi.mock("../../lib/socket.js", () => ({
  sendFrame: mocks.sendFrame,
  onTermFrame: (fn: (f: unknown) => void) => {
    mocks.handlers.add(fn);
    return () => mocks.handlers.delete(fn);
  },
}));

import { TerminalView } from "../TerminalView.js";

const TERM = {
  id: "t1", machine: "m1", kind: "shell" as const, label: "sh · you",
  cwd: "/w", startedAt: "2026-07-15T12:00:00.000Z",
};

describe("TerminalView", () => {
  beforeEach(() => {
    useConclaveStore.getState().reset();
    mocks.sendFrame.mockClear();
    mocks.term.write.mockClear();
    useConclaveStore.getState().setTerminals([TERM]);
    useConclaveStore.getState().setActiveTerminal("t1");
  });

  it("attaches on mount, writes replay + live data for its terminal only", () => {
    render(<TerminalView />);
    const attach = mocks.sendFrame.mock.calls.find((c) => (c[0] as { type: string }).type === "term-attach")?.[0] as {
      terminalId: string; requestId: string };
    expect(attach.terminalId).toBe("t1");

    for (const fn of mocks.handlers) {
      fn({ type: "term-replay", terminalId: "t1", requestId: attach.requestId, data: "aGk=" });
      fn({ type: "term-data", terminalId: "OTHER", data: "eA==" });
      fn({ type: "term-data", terminalId: "t1", data: "eSE=" });
    }
    expect(mocks.term.write).toHaveBeenCalledTimes(2);
  });

  it("shows the label and an exited notice on term-exit", () => {
    render(<TerminalView />);
    expect(screen.getByText("sh · you")).toBeInTheDocument();
    for (const fn of mocks.handlers) fn({ type: "term-exit", terminalId: "t1", exitCode: 0 });
    expect(screen.getByText(/exited/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/TerminalsSection.test.tsx src/components/__tests__/TerminalView.test.tsx`
Expected: FAIL — components don't exist.

- [ ] **Step 4: Implement**

`packages/web/src/components/TerminalView.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onTermFrame, sendFrame } from "../lib/socket.js";
import { b64decode, b64encode } from "../lib/base64.js";
import { hubClient } from "../lib/hubClient.js";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./TerminalView.module.css";

function tokenColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function TerminalView(): JSX.Element | null {
  const id = useConclaveStore((s) => s.activeTerminalId);
  const info = useConclaveStore((s) => s.terminals.find((t) => t.id === s.activeTerminalId));
  const ref = useRef<HTMLDivElement>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    if (!id || !ref.current) return;
    setExitCode(null);
    const term = new Terminal({
      fontSize: 11,
      fontFamily: '"JetBrains Mono", monospace',
      theme: {
        background: tokenColor("--surface", "#0d0d0d"),
        foreground: tokenColor("--text-primary", "#f5f5f5"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    try {
      fit.fit();
    } catch {
      /* jsdom / zero-size container */
    }

    const requestId = crypto.randomUUID();
    const off = onTermFrame((f) => {
      if (f.type === "term-replay" && f.requestId === requestId && f.terminalId === id && f.data) {
        term.write(b64decode(f.data));
      } else if (f.type === "term-data" && f.terminalId === id && f.data) {
        term.write(b64decode(f.data));
      } else if (f.type === "term-exit" && f.terminalId === id) {
        setExitCode(f.exitCode ?? 0);
      }
    });
    sendFrame({ type: "term-attach", terminalId: id, requestId });

    const input = term.onData((d) => sendFrame({ type: "term-data", terminalId: id, data: b64encode(d) }));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendFrame({ type: "term-resize", terminalId: id, cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      input.dispose();
      off();
      sendFrame({ type: "term-detach", terminalId: id });
      term.dispose();
    };
  }, [id]);

  if (!id) return null;

  return (
    <div className={styles.wrap} data-testid="terminal-view">
      <div className={styles.header}>
        <span className={styles.label}>{info?.label ?? id}</span>
        {exitCode !== null ? (
          <span className={styles.exited}>exited ({exitCode})</span>
        ) : (
          <button className={styles.kill} onClick={() => void hubClient.killTerminal(id)}>
            ✕ kill
          </button>
        )}
      </div>
      <div className={styles.term} ref={ref} />
    </div>
  );
}
```

`packages/web/src/components/TerminalView.module.css`:

```css
.wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--surface);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: var(--text-muted);
}
.label {
  letter-spacing: 1px;
}
.exited {
  color: var(--text-muted);
}
.kill {
  background: none;
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 10px;
  padding: 2px 8px;
  cursor: pointer;
}
.kill:hover {
  color: var(--text-primary);
}
.term {
  flex: 1;
  min-height: 0;
  padding: 8px;
}
```

`packages/web/src/components/TerminalsSection.tsx`:

```tsx
import { useState } from "react";
import type { TerminalKind } from "@conclave/shared";
import { hubClient, type MachineInfo } from "../lib/hubClient.js";
import { agentColorVar } from "../lib/agents.js";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./Sidebar.module.css";

export function TerminalsSection(): JSX.Element {
  const terminals = useConclaveStore((s) => s.terminals);
  const setActiveTerminal = useConclaveStore((s) => s.setActiveTerminal);
  const machines = useConclaveStore((s) => s.machines);
  const setMachines = useConclaveStore((s) => s.setMachines);
  const [picking, setPicking] = useState(false);
  const [machine, setMachine] = useState("");
  const [kind, setKind] = useState<TerminalKind>("shell");
  const [cwd, setCwd] = useState("");

  const grantedMachines = machines.filter((m: MachineInfo) => m.terminals);
  const selected = grantedMachines.find((m) => m.machine === (machine || grantedMachines[0]?.machine));

  const openPicker = (): void => {
    setPicking((p) => !p);
    if (machines.length === 0) void hubClient.listMachines().then(setMachines);
  };

  const spawn = (): void => {
    const m = selected;
    if (!m) return;
    const dir = cwd || m.files[0];
    if (!dir) return;
    void hubClient.spawnTerminal(m.machine, kind, dir);
    setPicking(false);
  };

  return (
    <div className={styles.section} data-testid="terminals-section">
      <div className={styles.sectionHeader}>
        terminals
        <button className={styles.spawnBtn} data-testid="spawn-terminal" aria-label="new terminal" onClick={openPicker}>
          +
        </button>
      </div>
      {terminals.map((t) => (
        <button
          key={t.id}
          className={styles.terminalRow}
          data-testid={`terminal-row-${t.id}`}
          onClick={() => setActiveTerminal(t.id)}
        >
          <span className={styles.termGlyph} style={t.agentId ? { color: agentColorVar(t.agentId).bg } : undefined}>
            ❯_
          </span>
          <span className={styles.termLabel}>{t.label}</span>
          <span className={styles.runningDot} />
        </button>
      ))}
      {picking && (
        <div className={styles.spawnPicker}>
          <label>
            machine
            <select aria-label="machine" value={selected?.machine ?? ""} onChange={(e) => setMachine(e.target.value)}>
              {grantedMachines.map((m) => (
                <option key={m.machine} value={m.machine}>
                  {m.machine}
                </option>
              ))}
            </select>
          </label>
          <label>
            kind
            <select aria-label="kind" value={kind} onChange={(e) => setKind(e.target.value as TerminalKind)}>
              <option value="shell">shell</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </label>
          <label>
            folder
            <select aria-label="folder" value={cwd || selected?.files[0] || ""} onChange={(e) => setCwd(e.target.value)}>
              {(selected?.files ?? []).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <button data-testid="spawn-submit" onClick={spawn}>
            spawn
          </button>
        </div>
      )}
    </div>
  );
}
```

`packages/web/src/components/Sidebar.module.css` — append:

```css
.spawnBtn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  float: right;
}
.spawnBtn:hover {
  color: var(--text-primary);
}
.terminalRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font-family: "JetBrains Mono", monospace;
  font-size: 12.5px;
  color: var(--text-secondary);
  text-align: left;
}
.terminalRow:hover {
  color: var(--text-primary);
}
.termGlyph {
  color: var(--text-muted);
  font-size: 11px;
}
.termLabel {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runningDot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent, var(--text-muted));
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
```

(If `--accent` doesn't exist in tokens.css, use `var(--text-muted)` alone — check tokens.css and keep tokens-only.)

`packages/web/src/components/Sidebar.tsx`: import `{ TerminalsSection }` and render `<TerminalsSection />` immediately after the artifacts section block (inside the chats view, sibling of the other `styles.section` divs).

`packages/web/src/components/SessionTabs.tsx`: mirror the artifact-tab pattern. Add selectors:

```tsx
  const activeTerminalId = useConclaveStore((s) => s.activeTerminalId);
  const terminals = useConclaveStore((s) => s.terminals);
  const activeTerminal = activeTerminalId ? terminals.find((t) => t.id === activeTerminalId) : undefined;
```

change the thread-tab active condition to `id === activeId && !activeArtifactId && !activeTerminalId`, and after the artifact tab block add:

```tsx
      {activeTerminal && (
        <button className={styles.tabActive} data-testid="terminal-tab" onClick={() => undefined}>
          <span className={styles.glyph}>❯_</span>
          {activeTerminal.label}
        </button>
      )}
```

`packages/web/src/App.tsx`: add `const activeTerminalId = useConclaveStore((s) => s.activeTerminalId);` and make the main-column precedence `activeTerminalId ? <TerminalView /> : activeFsFile ? <FsFileView /> : activeArtifactId ? <ArtifactView /> : <chat>` (import `TerminalView`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/TerminalsSection.test.tsx src/components/__tests__/TerminalView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full web checks, commit**

Run the web suite in background and kill after the summary prints (`npx pnpm --filter @conclave/web exec vitest run` — it hangs on teardown; the printed summary counts), then `npx pnpm -r typecheck`, then `npx pnpm --filter @conclave/web build` (xterm.css must resolve in the build).

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(web): xterm terminal view, TERMINALS sidebar, terminal session tab"
```

---

### Task 7: End-to-end integration test + docs

**Files:**
- Test: `packages/daemon/test/terminal-e2e.test.ts`
- Modify: `docs/DEPLOY.md` (terminals section)

**Interfaces:**
- Consumes: everything — real hub (`buildServer`), real daemon pieces (`HubSocket`, `TerminalService`, `wireTerminals`), a raw `ws` client standing in for the browser.
- Produces: proof the full chain works: grant → hello → spawn via REST → term-list broadcast → attach/replay → echo round-trip → kill → exit.

- [ ] **Step 1: Write the test**

`packages/daemon/test/terminal-e2e.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { GrantStore } from "../src/grants.js";
import { HubSocket } from "../src/hub-socket.js";
import { loadPty, TerminalService } from "../src/terminal-service.js";
import { wireTerminals } from "../src/terminal-wiring.js";

const TOKEN = "term-e2e-token";
const ptyMod = await loadPty();

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!ptyMod)("terminal end-to-end: browser-like client ↔ hub ↔ daemon pty", () => {
  let app: FastifyInstance;
  let daemonSocket: HubSocket;
  let client: WebSocket;

  afterEach(async () => {
    daemonSocket.stop();
    client.close();
    await app.close();
  });

  it("spawn → list → attach/replay → echo → kill → exit", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-te2e-")), "t.db"));
    app = await buildServer({ mailbox: new Mailbox(db), token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;

    // daemon side, wired exactly like main.ts
    const dir = mkdtempSync(join(tmpdir(), "conclave-te2e-w-"));
    const grantsFile = join(dir, "grants.json");
    writeFileSync(grantsFile, JSON.stringify({ files: [dir], terminals: true }));
    const grants = new GrantStore(grantsFile);
    const service = new TerminalService(ptyMod!, grants, {
      machine: "m1", shellBin: "/bin/sh", claudeBin: "claude", codexBin: "codex",
    });
    let terminals!: ReturnType<typeof wireTerminals>;
    daemonSocket = new HubSocket({
      hubUrl, token: TOKEN,
      onOpen: () => {
        daemonSocket.send({ type: "hello", machine: "m1", files: grants.roots(), terminals: true });
        terminals.sendList();
      },
      onMessage: () => {},
      onTerm: (f) => terminals.onTerm(f),
    });
    terminals = wireTerminals({ service, granted: true, send: (f) => daemonSocket.send(f) });
    daemonSocket.start();

    // browser-like client
    const seen: Array<Record<string, unknown>> = [];
    client = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    client.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>((resolve) => client.on("open", () => resolve()));

    // spawn via REST
    const spawnRes = await fetch(`${hubUrl}/api/terminals`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ machine: "m1", kind: "shell", cwd: dir }),
    });
    expect(spawnRes.status).toBe(202);

    await waitFor(() => seen.some((f) =>
      f["type"] === "terminal-list" && (f["terminals"] as unknown[]).length === 1));
    const list = seen.findLast((f) => f["type"] === "terminal-list") as { terminals: Array<{ id: string }> };
    const id = list.terminals[0]!.id;

    // attach → replay arrives (possibly empty), then echo round-trip
    client.send(JSON.stringify({ type: "term-attach", terminalId: id, requestId: "r1" }));
    await waitFor(() => seen.some((f) => f["type"] === "term-replay" && f["requestId"] === "r1"));

    client.send(JSON.stringify({
      type: "term-data", terminalId: id,
      data: Buffer.from("echo e2e-round-trip\n").toString("base64"),
    }));
    await waitFor(() => seen.filter((f) => f["type"] === "term-data")
      .some((f) => Buffer.from(String(f["data"]), "base64").toString().includes("e2e-round-trip")));

    // kill via REST → exit + empty list
    const killRes = await fetch(`${hubUrl}/api/terminals/${id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(killRes.status).toBe(200);
    await waitFor(() => seen.some((f) => f["type"] === "term-exit"));
    await waitFor(() => seen.some((f) =>
      f["type"] === "terminal-list" && (f["terminals"] as unknown[]).length === 0));
  }, 20000);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run packages/daemon/test/terminal-e2e.test.ts`
Expected: PASS. This is the plan's proof of the whole chain — if it fails, the bug is real; fix the product code, not the test.

- [ ] **Step 3: Update DEPLOY.md**

Append to `docs/DEPLOY.md` after the Notifications section:

```markdown
## Terminals

Terminals are real PTYs spawned by the **daemon** (node-pty), streamed through the
hub, and rendered in the web app. Default deny — enable per machine, on the machine:

```bash
npx tsx packages/daemon/src/cli.ts grant-terminals
# and make sure at least one folder is granted; spawn cwds are jailed to granted roots
npx tsx packages/daemon/src/cli.ts grant /home/me/proj
```

Requirements on the daemon machine: build tools for node-pty (python3, make, g++ —
same set better-sqlite3 needs). If node-pty fails to build, the daemon still runs;
terminals just show as unavailable.

> **Security note:** anyone who can reach the web app (and thus the token) gets an
> interactive shell on every machine that granted `terminals`, jailed only by which
> folders you granted. Grant it only on machines you're comfortable exposing to
> everyone on the hub's network. Keep the hub localhost/tailnet-only.

Manual smoke checklist (record the result; automated tests cover spawn/route/replay,
not real TUI fidelity):

1. `grant-terminals` on a daemon machine, restart the daemon.
2. Web sidebar → TERMINALS → `+` → pick machine/shell/folder → spawn.
3. Type `ls`, see output; resize the window; check reflow.
4. Close the tab, reopen the terminal row — scrollback replays.
5. Spawn a `claude` terminal — the TUI renders and takes keystrokes.
6. Kill from the header — row disappears.
```

- [ ] **Step 4: Full backend suite + typecheck, commit**

Run: `npx vitest run` (root — all backend suites, one run) and `npx pnpm -r typecheck`.

```bash
git add packages/daemon/test/terminal-e2e.test.ts docs/DEPLOY.md
git commit -m "test(daemon): terminal end-to-end over live hub; document terminals deploy"
```

---

## Coverage vs spec (self-check)

- Grant (CLI + store + hello): Task 1. TerminalService + ring buffer + jail + childEnv: Task 2. Daemon wiring + degrade path: Tasks 2–3. Hub registry/relay/REST + disconnect cleanup + capability on /api/machines: Task 4. Web socket/store/hubClient/hydrate: Task 5. xterm view, sidebar, tabs, kill, detach-on-close: Task 6. End-to-end + DEPLOY.md security note + manual smoke honesty: Task 7.
- Spec's backpressure rule (drop frames to a slow client) is deliberately NOT implemented: ws `send()` here is fire-and-forget and the buffered-amount check adds real complexity for a single-user localhost app. Documented deviation — revisit if a real firehose terminal lags the UI (the spec itself marks this "revisit only if real usage shows lag").
- Spec's "pulsing dot while running" is static-on for 7.1 (all listed terminals ARE running; exited ones leave the list) — the CSS pulse animation ships, keyed to presence.
