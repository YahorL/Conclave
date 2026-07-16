# Terminals 7.2 — Take-Over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Take over" a headless agent session from the thread you're viewing — open an interactive PTY resumed from that agent's CLI session id (`claude --resume <id>` / `codex resume <id>`), reusing the 7.1 terminal machinery.

**Architecture:** The session id lives only in the daemon's `DaemonState` keyed by `(threadId, agentId)`. Take-over sends `(machine, agentId, threadId)`; the daemon resolves cwd+runtime from its agent registry and the session id from `DaemonState`, then spawns an interactive PTY with runtime-specific resume args. A new `term-takeover` hub→daemon frame + `POST /api/terminals/takeover` route carry it; a `⇄ take over` control in the web `ContextToolbar` triggers it and auto-opens the resulting terminal.

**Tech Stack:** Existing — Zod schemas (shared), node-pty (daemon, already installed), Fastify/ws (hub), React/Zustand (web). No new dependencies.

## Global Constraints

- Work on branch `feat/terminals-takeover` (created in Task 1); merge to `main` with `--no-ff` after the whole plan.
- Backend tests run from the REPO ROOT: `npx vitest run packages/<pkg>/test/<file>.test.ts`. Web tests: `npx pnpm --filter @conclave/web exec vitest run <path relative to packages/web>`; never run the full web suite in foreground (it hangs on teardown — kill after the summary prints). `pnpm` is not on PATH — use `npx pnpm ...`.
- **MEMORY: ~12 GB RAM machine that has OOM-killed a session.** One heavy thing at a time; never overlap full suites.
- After any `packages/shared` change run `npx pnpm -r typecheck` (all 4 packages).
- Resume args are EXACT (from the existing adapters): `claude` → `["--resume", <id>]` (claude-adapter.ts:25), `codex` → `["resume", <id>]` (codex-adapter.ts:17). No session id → `[]` (fresh session).
- Take-over terminals are labelled `` `${kind} ⇄ ${basename(cwd)}` `` (the ⇄ distinguishes them from a plain spawn's `` `${kind} · ${basename(cwd)}` ``).
- Take-over still requires the `terminals` grant (same 403 gate as spawn) AND the agent's workspace must be a granted file root (spawn `resolveJailed`s it).
- All web colors via theme tokens (no hardcoded hex).
- Commit message body ends with:
  `Claude-Session: https://claude.ai/code/session_01MJ8FKhtSEmDL7SuhNtRrGN`

---

### Task 1: shared take-over frame + TerminalService resume/takeover support

**Files:**
- Modify: `packages/shared/src/terminal.ts` (add `TermTakeoverFrameSchema` to the union; add `TakeoverTerminalSchema`)
- Modify: `packages/daemon/src/terminal-service.ts` (`spawn` gains `resumeSessionId?`/`takeover?`)
- Test: `packages/shared/test/terminal.test.ts` (extend), `packages/daemon/test/terminal-service-takeover.test.ts` (new, fake PtyModule)

**Interfaces:**
- Consumes: existing `TerminalKindSchema`, `TermToDaemonFrameSchema`, `PtyModule`/`PtyLike` (terminal-service.ts).
- Produces: `TermTakeoverFrameSchema` (`{type:"term-takeover", agentId, threadId}`) as a member of `TermToDaemonFrameSchema`; `TakeoverTerminalSchema` (`{machine, agentId, threadId}`); `TerminalService.spawn(req: { kind: TerminalKind; cwd: string; resumeSessionId?: string; takeover?: boolean }): TerminalInfo` — Task 2 calls it with the takeover shape.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/terminals-takeover
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/shared/test/terminal.test.ts` (inside the existing `describe("terminal schemas", …)`):

```ts
  it("includes term-takeover in the daemon-bound union", () => {
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-takeover", agentId: "codex", threadId: "t1" }).success).toBe(true);
    expect(TermToDaemonFrameSchema.safeParse({ type: "term-takeover", agentId: "codex" }).success).toBe(false);
  });

  it("parses a TakeoverTerminal request", () => {
    expect(TakeoverTerminalSchema.safeParse({ machine: "m1", agentId: "codex", threadId: "t1" }).success).toBe(true);
    expect(TakeoverTerminalSchema.safeParse({ machine: "m1", agentId: "codex" }).success).toBe(false);
  });
```

Add `TakeoverTerminalSchema` to the imports at the top of that test file (alongside the existing `TermToDaemonFrameSchema` import).

Create `packages/daemon/test/terminal-service-takeover.test.ts` (a fake PtyModule — no real PTYs, so no skipIf):

```ts
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
```

This test also requires `PtyLike`/`PtyModule` to be exported from terminal-service.ts (they are, per 7.1 — verify; if `PtyLike` is not exported, add `export` to it).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/shared/test/terminal.test.ts packages/daemon/test/terminal-service-takeover.test.ts`
Expected: FAIL — `TakeoverTerminalSchema` undefined; `spawn` rejects `resumeSessionId`/`takeover` (type error) or ignores them (args `[]`, `·` label).

- [ ] **Step 4: Implement**

In `packages/shared/src/terminal.ts`, add the frame schema next to the other `Term*FrameSchema` definitions:

```ts
export const TermTakeoverFrameSchema = z.object({
  type: z.literal("term-takeover"),
  agentId: z.string().min(1),
  threadId: z.string().min(1),
});
```

Add `TermTakeoverFrameSchema` as a member of the `TermToDaemonFrameSchema` discriminated union (append it to the array passed to `z.discriminatedUnion("type", [ … ])`).

Add the REST body schema (near `SpawnTerminalSchema`):

```ts
export const TakeoverTerminalSchema = z.object({
  machine: z.string().min(1),
  agentId: z.string().min(1),
  threadId: z.string().min(1),
});
```

(No new inferred type export is required by later tasks, but add `export type TakeoverTerminal = z.infer<typeof TakeoverTerminalSchema>;` for symmetry with the other exports.)

In `packages/daemon/src/terminal-service.ts`, change `spawn` — replace the signature and the label/bin/pty-spawn lines. New `spawn` head through the pty spawn:

```ts
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
```

Everything after `const pty = …` (the `live`, `onData`, `onExit`, `list-changed`, `return info`) is unchanged. Ensure `TerminalKind` is imported in terminal-service.ts (it already imports from `@conclave/shared`; add `TerminalKind` if missing). If `PtyLike` lacks `export`, add it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/test/terminal.test.ts packages/daemon/test/terminal-service-takeover.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, run affected suites, commit**

Run: `npx pnpm -r typecheck`, then `npx vitest run packages/shared/test packages/daemon/test`.

```bash
git add packages/shared packages/daemon
git commit -m "feat(shared,daemon): term-takeover frame + TerminalService resume/takeover spawn"
```

---

### Task 2: daemon wiring — term-takeover handling + main.ts resolveTakeover

**Files:**
- Modify: `packages/daemon/src/terminal-wiring.ts` (`resolveTakeover` dep + `term-takeover` branch + ungranted term-error)
- Modify: `packages/daemon/src/main.ts` (build `resolveTakeover`, pass to `wireTerminals`)
- Test: `packages/daemon/test/terminal-wiring.test.ts` (extend, fake service)

**Interfaces:**
- Consumes: `TerminalService.spawn({kind, cwd, resumeSessionId?, takeover?})` (Task 1); `DaemonState.getSession(threadId, agentId)` (daemon-state.ts); `agents: AgentConfig[]` (already in main.ts).
- Produces: `TerminalWiringDeps.resolveTakeover?: (agentId: string, threadId: string) => { kind: TerminalKind; cwd: string; resumeSessionId?: string } | null`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/daemon/test/terminal-wiring.test.ts`. Add `import { EventEmitter } from "node:events";` to the file's TOP-LEVEL imports (not inside a describe), then add a fake-service helper and a fresh `describe` (the file already imports `wireTerminals`):

```ts
// top-of-file import: import { EventEmitter } from "node:events";

function fakeService(): { service: any; spawns: Array<Record<string, unknown>> } {
  const spawns: Array<Record<string, unknown>> = [];
  const events = new EventEmitter();
  const service = {
    events,
    list: () => [],
    spawn: (req: Record<string, unknown>) => { spawns.push(req); return { id: "term-x" }; },
    kill: () => {}, write: () => {}, resize: () => {}, replay: () => "",
  };
  return { service, spawns };
}

describe("wireTerminals take-over", () => {
  it("term-takeover resolves and spawns with resume args", () => {
    const { service, spawns } = fakeService();
    const sent: Array<Record<string, unknown>> = [];
    const { onTerm } = wireTerminals({
      service: service as never, granted: true, send: (f) => sent.push(f as Record<string, unknown>),
      resolveTakeover: (agentId, threadId) =>
        agentId === "codex" && threadId === "t1"
          ? { kind: "codex", cwd: "/w", resumeSessionId: "sess-1" }
          : null,
    });
    onTerm({ type: "term-takeover", agentId: "codex", threadId: "t1" });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual({ kind: "codex", cwd: "/w", resumeSessionId: "sess-1", takeover: true });
    expect(sent.some((f) => f["type"] === "term-error")).toBe(false);
  });

  it("term-takeover for an unknown agent sends term-error, no spawn", () => {
    const { service, spawns } = fakeService();
    const sent: Array<Record<string, unknown>> = [];
    const { onTerm } = wireTerminals({
      service: service as never, granted: true, send: (f) => sent.push(f as Record<string, unknown>),
      resolveTakeover: () => null,
    });
    onTerm({ type: "term-takeover", agentId: "ghost", threadId: "t1" });
    expect(spawns).toHaveLength(0);
    expect(sent.find((f) => f["type"] === "term-error")).toBeTruthy();
  });

  it("term-takeover when ungranted sends term-error", () => {
    const sent: Array<Record<string, unknown>> = [];
    const { onTerm } = wireTerminals({ service: null, granted: false, send: (f) => sent.push(f as Record<string, unknown>) });
    onTerm({ type: "term-takeover", agentId: "codex", threadId: "t1" });
    expect(sent.find((f) => f["type"] === "term-error")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/test/terminal-wiring.test.ts`
Expected: FAIL — `term-takeover` isn't handled (no spawn; and ungranted path only term-errors on `term-spawn`).

- [ ] **Step 3: Implement**

In `packages/daemon/src/terminal-wiring.ts`:

Add to `TerminalWiringDeps`:

```ts
  resolveTakeover?: (
    agentId: string,
    threadId: string,
  ) => { kind: import("@conclave/shared").TerminalKind; cwd: string; resumeSessionId?: string } | null;
```

(or add `TerminalKind` to the existing `import type { TermToDaemonFrame } from "@conclave/shared";` line and use it bare.)

Change the ungranted early-return so take-over also gets a term-error:

```ts
    if (!service || !deps.granted) {
      if (f.type === "term-spawn" || f.type === "term-takeover")
        send({ type: "term-error", message: "terminals not available on this machine" });
      return;
    }
```

Add a `case` to the `switch` (before the `term-detach` case):

```ts
        case "term-takeover": {
          const r = deps.resolveTakeover?.(f.agentId, f.threadId);
          if (!r) {
            send({ type: "term-error", message: `unknown agent: ${f.agentId}` });
            break;
          }
          service.spawn({ kind: r.kind, cwd: r.cwd, resumeSessionId: r.resumeSessionId, takeover: true });
          break; // list-changed event sends the updated term-list
        }
```

In `packages/daemon/src/main.ts`, extend the `wireTerminals({ … })` call with the resolver (the `agents` array and `state` `DaemonState` are already in scope — verify their local names; the 7.1 wiring already reads `agents`):

```ts
  const terminals = wireTerminals({
    service: terminalService,
    granted: termsGranted,
    send: (frame) => socket.send(frame),
    resolveTakeover: (agentId, threadId) => {
      const a = agents.find((x) => x.id === agentId);
      if (!a) return null;
      const kind = a.runtime === "claude-code" ? "claude" : a.runtime === "codex" ? "codex" : null;
      if (!kind) return null;
      return { kind, cwd: a.workspace, resumeSessionId: state.getSession(threadId, agentId) };
    },
  });
```

Match the existing `wireTerminals({...})` call site exactly (7.1 assigns it via the `let terminals` holder); only ADD the `resolveTakeover` property. Confirm the `DaemonState` variable is named `state` in main.ts (per grep it is: `const state = new DaemonState(...)`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/test/terminal-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Full daemon suite + typecheck, commit**

Run: `npx vitest run packages/daemon/test` then `npx pnpm -r typecheck`.

```bash
git add packages/daemon
git commit -m "feat(daemon): term-takeover wiring + resolveTakeover from agents/DaemonState"
```

---

### Task 3: hub — POST /api/terminals/takeover route

**Files:**
- Modify: `packages/hub/src/server.ts` (new route + `TakeoverTerminalSchema` import)
- Test: `packages/hub/test/terminals.test.ts` (extend)

**Interfaces:**
- Consumes: `TakeoverTerminalSchema` (Task 1); existing `machines` registry + `conn.terminals`.
- Produces: `POST /api/terminals/takeover {machine, agentId, threadId}` → 400/503/403/202, relaying `{type:"term-takeover", agentId, threadId}` to the machine's daemon socket.

- [ ] **Step 1: Write the failing test**

Append to `packages/hub/test/terminals.test.ts`. Reuse the file's existing helpers (`makeApp`/`connect`/`daemon`/`waitFor` — match their actual names in the file; the 7.1 test defines a `daemon(port)` helper that connects a ws, sends `hello` with `terminals:true`, and a `term-list`). Add:

```ts
  it("POST /api/terminals/takeover relays term-takeover; 400/503/403 gates", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;

    // no machine -> 503
    let res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex", threadId: "t1" },
    });
    expect(res.statusCode).toBe(503);

    // bad body -> 400
    res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex" },
    });
    expect(res.statusCode).toBe(400);

    const d = await daemon(port); // connects m1 with terminals:true + a term-list
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/terminals", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });

    res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex", threadId: "t1" },
    });
    expect(res.statusCode).toBe(202);
    await waitFor(() => d.seen.some((f) =>
      f["type"] === "term-takeover" && f["agentId"] === "codex" && f["threadId"] === "t1"));
  }, 15000);

  it("takeover on an ungranted machine -> 403", async () => {
    ({ app } = await makeApp());
    const port = (app.server.address() as AddressInfo).port;
    const ws = await connect(port);
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "hello", machine: "m1", files: ["/w"], terminals: false }));
    await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: "/api/machines", headers: { authorization: `Bearer ${TOKEN}` } });
      return (JSON.parse(r.payload) as unknown[]).length === 1;
    });
    const res = await app.inject({
      method: "POST", url: "/api/terminals/takeover",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { machine: "m1", agentId: "codex", threadId: "t1" },
    });
    expect(res.statusCode).toBe(403);
  }, 15000);
```

If the file's `daemon(port)` helper returns a different shape than `{ ws, seen }`, adapt the assertion to however it exposes the daemon's received frames (the 7.1 test captures them via a `frames(ws)` array).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/terminals.test.ts`
Expected: FAIL — route 404s.

- [ ] **Step 3: Implement**

In `packages/hub/src/server.ts`, add `TakeoverTerminalSchema` to the `@conclave/shared` import (next to `SpawnTerminalSchema`). Add the route immediately after the existing `app.post("/api/terminals", …)`:

```ts
  app.post("/api/terminals/takeover", async (req, reply) => {
    const parsed = TakeoverTerminalSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid takeover request" });
    const conn = machines.get(parsed.data.machine);
    if (!conn) return reply.code(503).send({ error: `machine unreachable: ${parsed.data.machine}` });
    if (!conn.terminals) return reply.code(403).send({ error: `terminals not granted on ${parsed.data.machine}` });
    conn.socket.send(JSON.stringify({ type: "term-takeover", agentId: parsed.data.agentId, threadId: parsed.data.threadId }));
    return reply.code(202).send({ ok: true });
  });
```

Note the route path: `/api/terminals/takeover` must be registered so it doesn't collide with `DELETE /api/terminals/:id` — it won't (different method + literal segment beats the param on POST), but keep it after the POST `/api/terminals` route for readability.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/terminals.test.ts`
Expected: PASS.

- [ ] **Step 5: Full hub suite + typecheck, commit**

Run: `npx vitest run packages/hub/test` then `npx pnpm -r typecheck`.

```bash
git add packages/hub
git commit -m "feat(hub): POST /api/terminals/takeover route relaying term-takeover"
```

---

### Task 4: web — hubClient method, store auto-open, machines hydrate

**Files:**
- Modify: `packages/web/src/lib/hubClient.ts` (`takeoverTerminal`)
- Modify: `packages/web/src/store/useConclaveStore.ts` (`pendingTakeover` state + `setPendingTakeover`; auto-open in the `terminal-list` case)
- Modify: `packages/web/src/store/sync.ts` (hydrate `machines`)
- Test: `packages/web/src/store/__tests__/takeover-store.test.ts` (new)

**Interfaces:**
- Consumes: `TerminalInfo` (has `agentId`), the `terminal-list` frame, existing `setMachines`/`setActiveTerminal`.
- Produces: `hubClient.takeoverTerminal(machine, agentId, threadId): Promise<{ok:boolean}>`; store `pendingTakeover: { agentId: string } | null`, `setPendingTakeover(v: { agentId: string } | null)`; the `terminal-list` reducer auto-activates a newly-appeared terminal whose `agentId` matches `pendingTakeover` and clears the marker.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/store/__tests__/takeover-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";

const term = (id: string, agentId?: string) => ({
  id, machine: "m1", kind: "claude" as const, label: `claude ⇄ w`,
  cwd: "/w", agentId, startedAt: "2026-07-15T12:00:00.000Z",
});

describe("take-over auto-open", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("activates a newly-appeared terminal matching a pending take-over and clears the marker", () => {
    const s = useConclaveStore.getState();
    s.setTerminals([term("t-old", "codex")]);
    s.setPendingTakeover({ agentId: "codex" });
    // a new terminal for codex appears
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [term("t-old", "codex"), term("t-new", "codex")] });
    expect(useConclaveStore.getState().activeTerminalId).toBe("t-new");
    expect(useConclaveStore.getState().pendingTakeover).toBeNull();
  });

  it("does not activate when no pending take-over is set", () => {
    const s = useConclaveStore.getState();
    s.setTerminals([]);
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [term("t-new", "codex")] });
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
  });

  it("ignores a new terminal whose agentId does not match the pending take-over", () => {
    const s = useConclaveStore.getState();
    s.setTerminals([]);
    s.setPendingTakeover({ agentId: "codex" });
    useConclaveStore.getState().applyFrame({ type: "terminal-list", terminals: [term("t-new", "claude-code")] });
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
    expect(useConclaveStore.getState().pendingTakeover).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/takeover-store.test.ts`
Expected: FAIL — `setPendingTakeover` undefined; no auto-open.

- [ ] **Step 3: Implement**

`packages/web/src/store/useConclaveStore.ts`:
- `State` gains: `pendingTakeover: { agentId: string } | null;` and `setPendingTakeover(v: { agentId: string } | null): void;`
- `initial` gains: `pendingTakeover: null as { agentId: string } | null,`
- action: `setPendingTakeover: (v) => set({ pendingTakeover: v }),`
- Replace the `terminal-list` case in `applyFrame` (currently `return { terminals: f.terminals };`) with an auto-open-aware version:

```ts
        case "terminal-list": {
          const pending = s.pendingTakeover;
          if (pending) {
            const prevIds = new Set(s.terminals.map((t) => t.id));
            const fresh = f.terminals
              .filter((t) => !prevIds.has(t.id) && t.agentId === pending.agentId)
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
            if (fresh.length > 0) {
              return {
                terminals: f.terminals,
                activeTerminalId: fresh[0]!.id,
                activeArtifactId: null,
                activeFsFile: null,
                pendingTakeover: null,
              };
            }
          }
          return { terminals: f.terminals };
        }
```

- `reset()` must include `pendingTakeover: null` (extend the reset object / `...initial` spread — check how reset is written and match it).

`packages/web/src/lib/hubClient.ts` — add after `killTerminal`:

```ts
  takeoverTerminal: (machine: string, agentId: string, threadId: string) =>
    req<{ ok: boolean }>("POST", "/api/terminals/takeover", { machine, agentId, threadId }),
```

`packages/web/src/store/sync.ts` — in `hydrate()`, add a machines fetch alongside the existing terminal fetch (both fire-and-forget):

```ts
    void hubClient.listMachines().then((m) => useConclaveStore.getState().setMachines(m)).catch(() => {});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/takeover-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, commit**

Run: `npx pnpm -r typecheck`.

```bash
git add packages/web
git commit -m "feat(web): takeoverTerminal client + auto-open store logic + machines hydrate"
```

---

### Task 5: web — ContextToolbar take-over control + DEPLOY.md

**Files:**
- Modify: `packages/web/src/components/ContextToolbar.tsx` (the ⇄ control)
- Modify: `packages/web/src/components/ContextToolbar.module.css` (control styling, tokens only)
- Modify: `docs/DEPLOY.md` (take-over note under the Terminals section)
- Test: `packages/web/src/components/__tests__/ContextToolbar.test.tsx` (new or extend)

**Interfaces:**
- Consumes: `hubClient.takeoverTerminal`, store `setPendingTakeover`, `agents`, `machines`, active `thread` (with `participants`).
- Produces: a take-over control (testid `takeover`; per-agent items `takeover-<agentId>` when ≥2 candidates).

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/__tests__/ContextToolbar.test.tsx` (mock hubClient like the TerminalsSection test does):

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextToolbar } from "../ContextToolbar.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => ({ takeoverTerminal: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../lib/hubClient.js", () => ({ hubClient: mocks }));

const thread = (participants: string[]) => ({
  id: "t1", kind: "chat" as const, workspace: "proj", participants,
  state: "open" as const, verdicts: {}, createdAt: "2026-07-15T12:00:00.000Z",
});
const agent = (id: string, machine = "m1") => ({
  id, name: id, runtime: "codex" as const, machine, workspace: "/w",
  role: "", allowedTools: [], dangerousActions: [],
});

function seed(participants: string[], agents: ReturnType<typeof agent>[]) {
  const s = useConclaveStore.getState();
  s.reset();
  s.setThreads([thread(participants)]);
  s.setActiveThread("t1");
  s.setAgents(agents);
  s.setMachines([{ machine: "m1", files: ["/w"], terminals: true, lastSeen: "" }]);
}

describe("ContextToolbar take-over", () => {
  beforeEach(() => mocks.takeoverTerminal.mockClear());

  it("hides the control when the thread has no agent participants", () => {
    seed(["you"], []);
    render(<ContextToolbar />);
    expect(screen.queryByTestId("takeover")).toBeNull();
  });

  it("single candidate: clicking take over calls takeoverTerminal(machine, agentId, threadId)", async () => {
    seed(["you", "codex"], [agent("codex")]);
    render(<ContextToolbar />);
    await userEvent.click(screen.getByTestId("takeover"));
    // if the single-candidate control is a direct button this is the click;
    // if it opens a menu first, click the agent item next — implement as a direct button for one candidate.
    expect(mocks.takeoverTerminal).toHaveBeenCalledWith("m1", "codex", "t1");
    expect(useConclaveStore.getState().pendingTakeover).toEqual({ agentId: "codex" });
  });

  it("multiple candidates: opens a menu and takes over the chosen agent", async () => {
    seed(["you", "codex", "reviewer"], [agent("codex"), agent("reviewer")]);
    render(<ContextToolbar />);
    await userEvent.click(screen.getByTestId("takeover"));
    await userEvent.click(screen.getByTestId("takeover-reviewer"));
    expect(mocks.takeoverTerminal).toHaveBeenCalledWith("m1", "reviewer", "t1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/ContextToolbar.test.tsx`
Expected: FAIL — no `takeover` testid.

- [ ] **Step 3: Implement**

`packages/web/src/components/ContextToolbar.tsx` — add the control. Add these selectors near the existing ones:

```tsx
  const agents = useConclaveStore((s) => s.agents);
  const machines = useConclaveStore((s) => s.machines);
  const setPendingTakeover = useConclaveStore((s) => s.setPendingTakeover);
  const [menuOpen, setMenuOpen] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
```

Compute candidates (thread participants that are known agents; prefer terminal-granted machines, but if machine grant info hasn't loaded, don't hide — see spec):

```tsx
  const grantedMachine = (m: string): boolean => {
    const known = machines.find((x) => x.machine === m);
    return known ? known.terminals : machines.length === 0; // unknown-yet → allow (403 will surface)
  };
  const candidates = (thread?.participants ?? [])
    .filter((p) => p !== "you")
    .map((p) => agents.find((a) => a.id === p))
    .filter((a): a is NonNullable<typeof a> => !!a && grantedMachine(a.machine));

  const takeover = (a: { id: string; machine: string }): void => {
    if (!thread) return;
    setTakeoverError(null);
    setPendingTakeover({ agentId: a.id });
    void hubClient.takeoverTerminal(a.machine, a.id, thread.id).catch((e: unknown) => {
      setPendingTakeover(null);
      setTakeoverError(`take over failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    setMenuOpen(false);
  };
```

Render (append inside the toolbar `<div>`, after the existing spans). One candidate → a direct button; ≥2 → a toggle button + menu:

```tsx
      {candidates.length === 1 && (
        <button className={styles.takeover} data-testid="takeover" onClick={() => takeover(candidates[0]!)}>
          ⇄ take over
        </button>
      )}
      {candidates.length > 1 && (
        <span className={styles.takeoverWrap}>
          <button className={styles.takeover} data-testid="takeover" onClick={() => setMenuOpen((o) => !o)}>
            ⇄ take over ▾
          </button>
          {menuOpen && (
            <span className={styles.takeoverMenu}>
              {candidates.map((a) => (
                <button key={a.id} data-testid={`takeover-${a.id}`} className={styles.takeoverItem} onClick={() => takeover(a)}>
                  {a.id}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      {takeoverError && <span className={styles.takeoverError} data-testid="takeover-error">{takeoverError}</span>}
```

Add the imports at the top: `import { useState } from "react";`, `import { hubClient } from "../lib/hubClient.js";`.

`packages/web/src/components/ContextToolbar.module.css` — append tokens-only styles (check ContextToolbar.module.css for the existing `.item`/`.state` idiom and match it):

```css
.takeover {
  background: none;
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
}
.takeover:hover { color: var(--text-primary); }
.takeoverWrap { position: relative; }
.takeoverMenu {
  position: absolute;
  top: 100%;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  z-index: 10;
}
.takeoverItem {
  background: none;
  border: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  padding: 4px 12px;
  text-align: left;
  cursor: pointer;
}
.takeoverItem:hover { color: var(--text-primary); }
.takeoverError { color: var(--warn, var(--text-muted)); font-size: 11px; }
```

(Use the token names that exist in `packages/web/src/styles/tokens.css` — the review of 7.1 confirmed `--border`, `--border-strong`, `--card`, `--text-secondary`, `--text-primary`, `--text-muted`, `--warn` exist; verify and substitute the nearest if any is missing.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/ContextToolbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Update DEPLOY.md**

In `docs/DEPLOY.md`, under the existing "## Terminals" section, append a take-over note:

```markdown
### Take over a headless session

An agent that has run headless in a thread can be "taken over": open its context
toolbar (⇄ take over) to launch an interactive `claude --resume <session>` /
`codex resume <session>` in a real terminal, continuing that conversation by hand.

Requirements: the agent's `workspace` must be a **granted file root** on its
machine (`grant <workspace>`), in addition to `grant-terminals`. Take-over opens
a **new, independent** terminal — it never interrupts the running headless
process; resuming a session the agent is still actively writing opens a parallel
view of it. If the agent has no stored session for that thread yet, take-over
starts a fresh interactive session in the workspace instead.

Manual smoke (automated tests cover the resume ARGS and plumbing, not that the
CLI actually restores the conversation): run a headless turn for an agent in a
thread, then ⇄ take over → confirm the resumed TUI shows the prior context.
```

- [ ] **Step 6: Web checks + full backend + commit**

Run the ContextToolbar test again, then `npx pnpm -r typecheck`, then the web suite in background (kill after the summary prints — it hangs on teardown), then `npx vitest run` (full backend) once.

```bash
git add packages/web docs/DEPLOY.md
git commit -m "feat(web): ContextToolbar take-over control; document take-over in DEPLOY"
```

---

## Coverage vs spec (self-check)

- shared frame + REST schema: Task 1. TerminalService resume args + ⇄ label: Task 1. Daemon wiring + resolveTakeover (agents+DaemonState, runtime→kind, fresh-on-no-session): Task 2. Hub route 400/503/403/202 + relay: Task 3. Web client + auto-open + machines hydrate: Task 4. ContextToolbar control (0/1/≥2 candidates, granted-machine filter with load fallback, error surface) + DEPLOY.md (workspace-grant requirement, parallel-session note, manual smoke): Task 5.
- No new end-to-end test: take-over reuses the 7.1 client↔hub↔daemon↔pty chain (already e2e-proven); the resume ARGS are unit-proven with a fake PtyModule (Task 1), and the frame relay is proven at the hub (Task 3) and wiring (Task 2). A real `claude --resume` is manual-smoke only (DEPLOY.md), per the spec's honesty note.
- Error handling: unknown agent / non-claude-codex runtime → daemon `term-error` (Task 2); 400/503/403 at the hub (Task 3); workspace-not-granted → `PathJailError` → `term-error` (inherited from 7.1 spawn, exercised implicitly).
