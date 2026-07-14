# File-access Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On-machine grant model + a request/response file-RPC tunnel through the hub so a client can list/stat/read/write files on a named machine's daemon, path-jailed to granted roots (daemon-enforced, default-deny). No web UI (curl-testable).

**Architecture:** Shared fs frame schemas → daemon `GrantStore` (path-jail) + `FileService` + `conclave-daemon` grant CLI → hub machine-registry + pending-request correlation + `POST /api/fs/:machine/:op` routes → daemon sends `hello` on connect and answers `fs-request` with `fs-response`.

**Tech Stack:** Existing hub (Fastify, ws), daemon (`HubSocket`, node:fs), `@conclave/shared` (Zod). Vitest.

## Global Constraints

- **TypeScript everywhere**, ESM, `npx pnpm ...` (not on PATH).
- **Test invocation:** backend tests from **repo root** — `npx vitest run <path>`. Typecheck per-package: `npx pnpm --filter <pkg> typecheck`.
- **Zod v4**; export schema + inferred type; `.js` import specifiers.
- **Auth:** every hub route except `/health` needs the token (Bearer or `?token=`).
- **Commit trailer:** end every commit message with `Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue`.
- TDD: failing test first; commit after every green step. Branch: `feat/file-access-foundation`.

## Parallelization

After **Task 1** (shared schemas), the **daemon track (Tasks 2–4)** and **hub track (Tasks 5–6)** touch disjoint packages and are independent — build them concurrently. **Tasks 7–8** integrate and must come after both tracks land.

## File Structure

**shared:** `src/fs.ts` (+ index re-export).
**daemon:** `src/grants.ts`, `src/file-service.ts`, `src/cli.ts` (bin `conclave-daemon`), `src/hub-socket.ts` (send + fs-request), `src/main.ts` (wire), `package.json` (bin).
**hub:** `src/fs-tunnel.ts` (`PendingRequests`, `MachineRegistry`), `src/server.ts` (ws message handling + fs routes + /api/machines).

---

## Task 1: Shared fs schemas

**Files:** Create `packages/shared/src/fs.ts`; modify `src/index.ts`; test `packages/shared/test/fs.test.ts`.

**Interfaces (Produces):** `FsOpSchema` enum `list|stat|read|write`; `FsRequestSchema {id, op, path, content?, threadId?}`; `FsResponseSchema {id, ok, result?, error?}`; `HelloSchema {machine, files: string[]}`; `FsEntrySchema {name, kind: "file"|"dir", size?}`; `FsStatSchema {kind: "file"|"dir", size, mtime}`. Types `FsOp, FsRequest, FsResponse, Hello, FsEntry, FsStat`.

- [ ] **Step 1: Failing test**

```ts
// packages/shared/test/fs.test.ts
import { describe, expect, it } from "vitest";
import { FsRequestSchema, FsResponseSchema, HelloSchema } from "../src/fs.js";

describe("fs schemas", () => {
  it("parses a request and rejects a bad op", () => {
    expect(FsRequestSchema.parse({ id: "1", op: "list", path: "/x" }).op).toBe("list");
    expect(() => FsRequestSchema.parse({ id: "1", op: "delete", path: "/x" })).toThrow();
  });
  it("parses response and hello", () => {
    expect(FsResponseSchema.parse({ id: "1", ok: true, result: [] }).ok).toBe(true);
    expect(HelloSchema.parse({ machine: "m1", files: ["/w"] }).files).toEqual(["/w"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run packages/shared/test/fs.test.ts`).

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/fs.ts
import { z } from "zod";

export const FsOpSchema = z.enum(["list", "stat", "read", "write"]);
export const FsRequestSchema = z.object({
  id: z.string().min(1),
  op: FsOpSchema,
  path: z.string().min(1),
  content: z.string().optional(),
  threadId: z.string().optional(),
});
export const FsResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export const HelloSchema = z.object({
  machine: z.string().min(1),
  files: z.array(z.string()),
});
export const FsEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative().optional(),
});
export const FsStatSchema = z.object({
  kind: z.enum(["file", "dir"]),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
});

export type FsOp = z.infer<typeof FsOpSchema>;
export type FsRequest = z.infer<typeof FsRequestSchema>;
export type FsResponse = z.infer<typeof FsResponseSchema>;
export type Hello = z.infer<typeof HelloSchema>;
export type FsEntry = z.infer<typeof FsEntrySchema>;
export type FsStat = z.infer<typeof FsStatSchema>;
```

Add to `src/index.ts`: `export * from "./fs.js";`

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Typecheck + commit** (`feat(shared): fs frame schemas for file access`).

---

## Task 2 [daemon track]: GrantStore + path-jail

**Files:** Create `packages/daemon/src/grants.ts`; test `packages/daemon/test/grants.test.ts`.

**Interfaces (Produces):** `class PathJailError extends Error`; `class GrantStore { constructor(grantsFile: string); roots(): string[]; isAllowed(p: string): boolean; resolveJailed(p: string): string }`. `roots()` reads+parses the JSON file each call (`{files:string[]}`), returns `[]` if missing/invalid. `resolveJailed` resolves to absolute and throws `PathJailError` unless inside a granted root.

- [ ] **Step 1: Failing test**

```ts
// packages/daemon/test/grants.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore, PathJailError } from "../src/grants.js";

function withGrants(files: string[]): GrantStore {
  const dir = mkdtempSync(join(tmpdir(), "conclave-grants-"));
  const gf = join(dir, "grants.json");
  writeFileSync(gf, JSON.stringify({ files }));
  return new GrantStore(gf);
}

describe("GrantStore", () => {
  it("allows paths inside a granted root and rejects outside / traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const store = withGrants([root]);
    expect(store.resolveJailed(join(root, "a/b.txt"))).toBe(join(root, "a/b.txt"));
    expect(() => store.resolveJailed(join(root, "../escape"))).toThrow(PathJailError);
    expect(() => store.resolveJailed("/etc/passwd")).toThrow(PathJailError);
  });
  it("empty grants deny everything", () => {
    const store = withGrants([]);
    expect(store.roots()).toEqual([]);
    expect(() => store.resolveJailed("/anything")).toThrow(PathJailError);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// packages/daemon/src/grants.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export class PathJailError extends Error {
  constructor(p: string) {
    super(`path not within a granted root: ${p}`);
  }
}

export class GrantStore {
  constructor(private readonly grantsFile: string) {}

  roots(): string[] {
    if (!existsSync(this.grantsFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.grantsFile, "utf8")) as { files?: unknown };
      if (!Array.isArray(parsed.files)) return [];
      return parsed.files.filter((r): r is string => typeof r === "string").map((r) => resolve(r));
    } catch {
      return [];
    }
  }

  isAllowed(p: string): boolean {
    const abs = resolve(p);
    return this.roots().some((root) => abs === root || abs.startsWith(root + sep));
  }

  resolveJailed(p: string): string {
    const abs = resolve(p);
    if (!this.isAllowed(abs)) throw new PathJailError(p);
    return abs;
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Typecheck + commit** (`feat(daemon): grant store with path-jail`).

---

## Task 3 [daemon track]: FileService

**Files:** Create `packages/daemon/src/file-service.ts`; test `packages/daemon/test/file-service.test.ts`.

**Interfaces:**
- Consumes: `GrantStore` (Task 2); `FsRequest`, `FsResponse`, `FsEntry`, `FsStat` (Task 1).
- Produces: `class FileTooLargeError extends Error`; `class FileService { constructor(grants: GrantStore); list(path): Promise<FsEntry[]>; stat(path): Promise<FsStat>; read(path): Promise<{content:string}>; write(path, content): Promise<{ok:true}>; handle(req: FsRequest): Promise<FsResponse> }`. Each op calls `grants.resolveJailed(path)`; `read` rejects > 5 MB; `handle` maps op→method and wraps success/error into an `FsResponse` (`{id, ok, result}` / `{id, ok:false, error}`).

- [ ] **Step 1: Failing test**

```ts
// packages/daemon/test/file-service.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.js";
import { FileService } from "../src/file-service.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "fsroot-"));
  writeFileSync(join(root, "a.txt"), "hello");
  const gf = join(mkdtempSync(join(tmpdir(), "gf-")), "grants.json");
  writeFileSync(gf, JSON.stringify({ files: [root] }));
  return { root, svc: new FileService(new GrantStore(gf)) };
}

describe("FileService", () => {
  it("lists, reads, writes within the jail", async () => {
    const { root, svc } = setup();
    expect((await svc.list(root)).map((e) => e.name)).toContain("a.txt");
    expect((await svc.read(join(root, "a.txt"))).content).toBe("hello");
    await svc.write(join(root, "b.txt"), "world");
    expect((await svc.read(join(root, "b.txt"))).content).toBe("world");
  });
  it("handle() wraps a jailed failure as ok:false", async () => {
    const { svc } = setup();
    const res = await svc.handle({ id: "1", op: "read", path: "/etc/passwd" });
    expect(res).toMatchObject({ id: "1", ok: false });
    expect(res.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// packages/daemon/src/file-service.ts
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FsEntry, FsRequest, FsResponse, FsStat } from "@conclave/shared";
import type { GrantStore } from "./grants.js";

const MAX_READ = 5 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(size: number) {
    super(`file too large to read: ${size} bytes (max ${MAX_READ})`);
  }
}

export class FileService {
  constructor(private readonly grants: GrantStore) {}

  async list(path: string): Promise<FsEntry[]> {
    const dir = this.grants.resolveJailed(path);
    const entries = await readdir(dir, { withFileTypes: true });
    const out: FsEntry[] = [];
    for (const e of entries) {
      if (e.isDirectory()) out.push({ name: e.name, kind: "dir" });
      else {
        const s = await stat(join(dir, e.name));
        out.push({ name: e.name, kind: "file", size: s.size });
      }
    }
    return out;
  }

  async stat(path: string): Promise<FsStat> {
    const abs = this.grants.resolveJailed(path);
    const s = await stat(abs);
    return { kind: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtime.toISOString() };
  }

  async read(path: string): Promise<{ content: string }> {
    const abs = this.grants.resolveJailed(path);
    const s = await stat(abs);
    if (s.size > MAX_READ) throw new FileTooLargeError(s.size);
    return { content: await readFile(abs, "utf8") };
  }

  async write(path: string, content: string): Promise<{ ok: true }> {
    const abs = this.grants.resolveJailed(path);
    await writeFile(abs, content, "utf8");
    return { ok: true };
  }

  async handle(req: FsRequest): Promise<FsResponse> {
    try {
      let result: unknown;
      if (req.op === "list") result = await this.list(req.path);
      else if (req.op === "stat") result = await this.stat(req.path);
      else if (req.op === "read") result = await this.read(req.path);
      else result = await this.write(req.path, req.content ?? "");
      return { id: req.id, ok: true, result };
    } catch (e) {
      return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
```
(`basename`/`join` import: keep only what you use — `join` is used.)

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Typecheck + commit** (`feat(daemon): file service (list/stat/read/write) jailed`).

---

## Task 4 [daemon track]: conclave-daemon grant CLI

**Files:** Create `packages/daemon/src/cli.ts`; modify `packages/daemon/package.json` (add `"bin": { "conclave-daemon": "src/cli.ts" }`); test `packages/daemon/test/cli.test.ts`.

**Interfaces (Produces):** `runCli(argv: string[], grantsFile: string): void` — subcommands `grant <path>` (resolve→append→dedupe), `grants` (print roots one per line), `revoke <path>` (remove). Writes `{files:[...]}` to `grantsFile`. The CLI `main` uses `CONCLAVE_GRANTS_FILE ?? "./conclave-grants.json"`.

- [ ] **Step 1: Failing test**

```ts
// packages/daemon/test/cli.test.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function gf(): string {
  return join(mkdtempSync(join(tmpdir(), "cli-")), "grants.json");
}

describe("conclave-daemon CLI", () => {
  it("grants, dedupes, and revokes roots", () => {
    const file = gf();
    runCli(["grant", "/tmp/ws"], file);
    runCli(["grant", "/tmp/ws"], file); // dedupe
    expect(JSON.parse(readFileSync(file, "utf8")).files).toEqual([resolve("/tmp/ws")]);
    runCli(["revoke", "/tmp/ws"], file);
    expect(JSON.parse(readFileSync(file, "utf8")).files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// packages/daemon/src/cli.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function load(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as { files?: unknown };
    return Array.isArray(p.files) ? (p.files as string[]) : [];
  } catch {
    return [];
  }
}

function save(file: string, files: string[]): void {
  writeFileSync(file, JSON.stringify({ files }, null, 2));
}

export function runCli(argv: string[], grantsFile: string): void {
  const [cmd, arg] = argv;
  const roots = load(grantsFile);
  if (cmd === "grant") {
    if (!arg) throw new Error("usage: conclave-daemon grant <path>");
    const abs = resolve(arg);
    if (!roots.includes(abs)) roots.push(abs);
    save(grantsFile, roots);
    console.log(`granted files: ${abs}`);
  } else if (cmd === "revoke") {
    if (!arg) throw new Error("usage: conclave-daemon revoke <path>");
    save(grantsFile, roots.filter((r) => r !== resolve(arg)));
    console.log(`revoked files: ${resolve(arg)}`);
  } else if (cmd === "grants") {
    for (const r of roots) console.log(r);
  } else {
    console.error("usage: conclave-daemon <grant|revoke|grants> [path]");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2), process.env["CONCLAVE_GRANTS_FILE"] ?? "./conclave-grants.json");
}
```

Add to `packages/daemon/package.json`:
```json
  "bin": { "conclave-daemon": "src/cli.ts" },
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Typecheck + commit** (`feat(daemon): conclave-daemon grant CLI`).

---

## Task 5 [hub track]: PendingRequests + MachineRegistry

**Files:** Create `packages/hub/src/fs-tunnel.ts`; test `packages/hub/test/fs-tunnel.test.ts`.

**Interfaces (Produces):**
- `class PendingRequests { create(id: string, timeoutMs: number): Promise<FsResponse>; settle(id: string, res: FsResponse): void }` — `create` returns a promise that rejects after `timeoutMs` (cleanup); `settle` resolves a pending id (no-op if unknown).
- `interface MachineConn { socket: FsSocket; roots: string[]; lastSeen: string }`; `type FsSocket = { send(data: string): void }`; `class MachineRegistry { register(machine: string, socket: FsSocket, roots: string[]): void; unregisterSocket(socket: FsSocket): void; get(machine: string): MachineConn | undefined; list(): Array<{ machine: string; files: string[]; lastSeen: string }> }`.

- [ ] **Step 1: Failing test**

```ts
// packages/hub/test/fs-tunnel.test.ts
import { describe, expect, it, vi } from "vitest";
import { MachineRegistry, PendingRequests } from "../src/fs-tunnel.js";

describe("PendingRequests", () => {
  it("resolves on settle and rejects on timeout", async () => {
    const p = new PendingRequests();
    const pr = p.create("1", 1000);
    p.settle("1", { id: "1", ok: true, result: 42 });
    expect((await pr).result).toBe(42);
    await expect(p.create("2", 5)).rejects.toThrow();
  });
});

describe("MachineRegistry", () => {
  it("registers by machine and unregisters by socket", () => {
    const reg = new MachineRegistry();
    const socket = { send: vi.fn() };
    reg.register("m1", socket, ["/w"]);
    expect(reg.get("m1")?.roots).toEqual(["/w"]);
    expect(reg.list()[0]).toMatchObject({ machine: "m1", files: ["/w"] });
    reg.unregisterSocket(socket);
    expect(reg.get("m1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/fs-tunnel.ts
import type { FsResponse } from "@conclave/shared";

export type FsSocket = { send(data: string): void };

export class PendingRequests {
  private readonly map = new Map<string, { resolve: (r: FsResponse) => void; timer: NodeJS.Timeout }>();

  create(id: string, timeoutMs: number): Promise<FsResponse> {
    return new Promise<FsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        reject(new Error(`fs request ${id} timed out`));
      }, timeoutMs);
      this.map.set(id, { resolve, timer });
    });
  }

  settle(id: string, res: FsResponse): void {
    const entry = this.map.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.map.delete(id);
    entry.resolve(res);
  }
}

export interface MachineConn {
  socket: FsSocket;
  roots: string[];
  lastSeen: string;
}

export class MachineRegistry {
  private readonly byMachine = new Map<string, MachineConn>();

  register(machine: string, socket: FsSocket, roots: string[]): void {
    this.byMachine.set(machine, { socket, roots, lastSeen: new Date().toISOString() });
  }

  unregisterSocket(socket: FsSocket): void {
    for (const [machine, conn] of this.byMachine) {
      if (conn.socket === socket) this.byMachine.delete(machine);
    }
  }

  get(machine: string): MachineConn | undefined {
    return this.byMachine.get(machine);
  }

  list(): Array<{ machine: string; files: string[]; lastSeen: string }> {
    return [...this.byMachine.entries()].map(([machine, c]) => ({
      machine, files: c.roots, lastSeen: c.lastSeen,
    }));
  }
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Typecheck + commit** (`feat(hub): fs-tunnel pending-requests and machine registry`).

---

## Task 6 [hub track]: hub ws hello/fs-response + fs routes + /api/machines

**Files:** Modify `packages/hub/src/server.ts`; test `packages/hub/test/fs-api.test.ts`.

**Interfaces:**
- Consumes: `PendingRequests`, `MachineRegistry` (Task 5); `HelloSchema`, `FsResponseSchema`, `FsOpSchema`.
- Produces: in `buildServer`, construct one `MachineRegistry` + one `PendingRequests`; the `/ws` handler adds `socket.on("message", ...)` parsing `hello` (→ `registry.register`) and `fs-response` (→ `pending.settle`), and `socket.on("close")` calls `registry.unregisterSocket(socket)`. `GET /api/machines` → `registry.list()`. `POST /api/fs/:machine/:op` → 503 if machine absent; else send `{type:"fs-request", id, op, path, content?, threadId?}` to the socket, await `pending.create(id, 10000)`; 504 on timeout; 422 if `!res.ok`; on `write` with `threadId`, append a status message; return `res.result`.

- [ ] **Step 1: Failing test** (drives the fs route against a fake daemon socket by registering a machine directly — see note)

```ts
// packages/hub/test/fs-api.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "t"; const AUTH = { authorization: `Bearer ${TOKEN}` };

async function fresh(): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-fsapi-"));
  const mailbox = new Mailbox(openDb(join(dir, "t.db")));
  return buildServer({ mailbox, token: TOKEN });
}

describe("fs API", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await fresh(); });

  it("503 when the machine is not connected", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/fs/ghost/list", headers: AUTH, payload: { path: "/w" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("lists machines (empty when none connected)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/machines", headers: AUTH });
    expect(res.json()).toEqual([]);
  });
});
```

> The full round-trip (register a machine + settle a response) is covered by the Task 8 integration test against a real daemon socket. For a hub-only round-trip you may expose the registry via `buildServer` return or a test hook; keep Task 6 to the 503/empty-list cases and let Task 8 prove the happy path.

- [ ] **Step 2: Run — expect FAIL** (routes 404).

- [ ] **Step 3: Implement in `server.ts`**

Imports: add `HelloSchema, FsResponseSchema, FsOpSchema` (value) from `@conclave/shared`; `import { MachineRegistry, PendingRequests } from "./fs-tunnel.js";`.

In `buildServer`, near the top (after `registry` is set): `const machines = new MachineRegistry(); const pending = new PendingRequests();`

Routes (near other `/api` routes):
```ts
  app.get("/api/machines", async () => machines.list());

  app.post("/api/fs/:machine/:op", async (req, reply) => {
    const params = req.params as { machine: string; op: string };
    const op = FsOpSchema.safeParse(params.op);
    if (!op.success) return reply.code(400).send({ error: "invalid op" });
    const conn = machines.get(params.machine);
    if (!conn) return reply.code(503).send({ error: `machine unreachable: ${params.machine}` });
    const body = (req.body ?? {}) as { path?: string; content?: string; threadId?: string };
    if (!body.path) return reply.code(400).send({ error: "path required" });
    const id = randomUUID();
    conn.socket.send(JSON.stringify({
      type: "fs-request", id, op: op.data, path: body.path,
      content: body.content, threadId: body.threadId,
    }));
    let res;
    try {
      res = await pending.create(id, 10_000);
    } catch {
      return reply.code(504).send({ error: "fs request timed out" });
    }
    if (!res.ok) return reply.code(422).send({ error: res.error ?? "fs error" });
    if (op.data === "write" && body.threadId) {
      try {
        mailbox.appendMessage(body.threadId, {
          from: "you", to: [], type: "status", body: `edited ${body.path}`, artifacts: [],
        });
      } catch { /* thread may be closed/absent — best-effort log */ }
    }
    return res.result;
  });
```
(`randomUUID` — import from `node:crypto` at the top of `server.ts`.)

`/ws` handler — add message parsing + close cleanup. Inside the `app.get("/ws", ...)` callback, after the existing `on`/`off` wiring:
```ts
    socket.on("message", (raw: Buffer) => {
      let frame: unknown;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      const f = frame as { type?: unknown };
      if (f.type === "hello") {
        const parsed = HelloSchema.safeParse((frame as { }));
        if (parsed.success) machines.register(parsed.data.machine, socket, parsed.data.files);
      } else if (f.type === "fs-response") {
        const parsed = FsResponseSchema.safeParse(frame);
        if (parsed.success) pending.settle(parsed.data.id, parsed.data);
      }
    });
```
And in the existing `socket.on("close", ...)` body add: `machines.unregisterSocket(socket);`

> Note: `HelloSchema.safeParse(frame)` will reject because `frame` has an extra `type` field only if the schema is strict; the default Zod object ignores unknown keys, so parsing `{type, machine, files}` against `HelloSchema` succeeds. Keep `HelloSchema` non-strict.

- [ ] **Step 4: Run — expect PASS** (503 + empty list).
- [ ] **Step 5: Typecheck, full hub suite, commit** (`feat(hub): fs tunnel routes, machine registry over ws`).

---

## Task 7: Daemon answers fs-request (HubSocket send + wiring)

**Files:** Modify `packages/daemon/src/hub-socket.ts`, `packages/daemon/src/main.ts`; test `packages/daemon/test/hub-socket-fs.test.ts`. (Depends on Tasks 3 + 6.)

**Interfaces:**
- Produces: `HubSocket.send(frame: unknown): void` (JSON-stringifies to the live ws); `HubSocketOptions.onFsRequest?: (req: FsRequest) => void`; `handleData` dispatches `fs-request` frames to `onFsRequest`.
- Daemon `main.ts`: build `GrantStore` (`CONCLAVE_GRANTS_FILE`) + `FileService`; in `onOpen`, after catch-up, `socket.send({ type: "hello", machine: cfg.machine, files: grants.roots() })`; wire `onFsRequest: async (req) => socket.send(await fileService.handle(req))`.

- [ ] **Step 1: Failing test** (a WS server sends fs-request; assert the daemon replies fs-response)

```ts
// packages/daemon/test/hub-socket-fs.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { HubSocket } from "../src/hub-socket.js";
import { GrantStore } from "../src/grants.js";
import { FileService } from "../src/file-service.js";

describe("HubSocket fs-request round-trip", () => {
  it("answers a jailed list with fs-response", async () => {
    const root = mkdtempSync(join(tmpdir(), "hsfs-"));
    writeFileSync(join(root, "a.txt"), "hi");
    const gf = join(mkdtempSync(join(tmpdir(), "gf-")), "grants.json");
    writeFileSync(gf, JSON.stringify({ files: [root] }));
    const svc = new FileService(new GrantStore(gf));

    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    const got = new Promise<any>((res) => {
      wss.on("connection", (ws) => {
        ws.on("message", (d) => res(JSON.parse(String(d))));
        ws.send(JSON.stringify({ type: "fs-request", id: "1", op: "list", path: root }));
      });
    });

    const socket = new HubSocket({
      hubUrl: `http://127.0.0.1:${port}`, token: "t",
      onMessage: () => undefined,
      onFsRequest: async (req) => socket.send(await svc.handle(req)),
    });
    socket.start();
    const resp = await got;
    expect(resp).toMatchObject({ id: "1", ok: true });
    expect((resp.result as Array<{ name: string }>).map((e) => e.name)).toContain("a.txt");
    socket.stop();
    wss.close();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

`hub-socket.ts`:
- Import `FsRequestSchema, type FsRequest` from `@conclave/shared`.
- `HubSocketOptions`: add `onFsRequest?: (req: FsRequest) => void;`
- Add method: `send(frame: unknown): void { this.ws?.send(JSON.stringify(frame)); }`
- In `handleData`, after the `task` branch:
```ts
        if (candidate.type === "fs-request" && this.opts.onFsRequest) {
          const parsed = FsRequestSchema.safeParse(frame);
          if (parsed.success) this.opts.onFsRequest(parsed.data);
          return;
        }
```
(Note: parse `frame`, not `candidate.request`, since the fs-request fields are top-level.)

`main.ts`:
- Import `GrantStore` from `./grants.js`, `FileService` from `./file-service.js`.
- `const grants = new GrantStore(process.env["CONCLAVE_GRANTS_FILE"] ?? "./conclave-grants.json");`
- `const fileService = new FileService(grants);`
- In the `HubSocket` options: `onFsRequest: (req) => { void (async () => socket.send(await fileService.handle(req)))(); },`
- In `onOpen`, after task catch-up: `socket.send({ type: "hello", machine: cfg.machine, files: grants.roots() });`

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Typecheck, full daemon suite, commit** (`feat(daemon): answer fs-request from the hub; send hello`).

---

## Task 8: Integration + verification

**Files:** Create `packages/daemon/test/fs-integration.test.ts`; modify `packages/daemon/README.md`.

- [ ] **Step 1: Integration test** — real hub (`buildServer` + `listen`) + a real `HubSocket` daemon connection wired to a `FileService` over a granted temp dir. Assert: after connect, `GET /api/machines` shows the machine; `POST /api/fs/:machine/list` returns entries; `POST /api/fs/:machine/read` on an ungranted path returns 422. (Model the server bootstrap on `packages/daemon/test/turn-report.test.ts`.)

- [ ] **Step 2: Run — expect PASS.**

- [ ] **Step 3: Live drive** — hub on an alt port; a daemon with `CONCLAVE_GRANTS_FILE` granting a temp dir (via `conclave-daemon grant`); `curl -X POST $H/api/fs/local/list -d '{"path":"<root>"}'` returns entries; a path outside the root returns 422; `GET /api/machines` shows `files:[root]`. (Use `setsid` + PGID or the /proc python sweep for teardown — `pkill -f` self-matches the wrapping shell.)

- [ ] **Step 4: Smoke checklist** — append to `packages/daemon/README.md`:
```
8. File access (step 5): run `conclave-daemon grant <dir>` on the machine; confirm
   GET /api/machines shows the granted root, POST /api/fs/<machine>/list returns
   entries within it, and a path outside any granted root returns 422 (path-jail).
```

- [ ] **Step 5: Full monorepo green + commit** (`npx pnpm -r typecheck`, `npx vitest run`; `test(file-access): hub↔daemon fs round-trip integration`).

---

## Self-Review Notes

- **Spec coverage:** §3 tunnel → Tasks 5–7; §4 grants/CLI → Tasks 2,4; §5 FileService → Task 3; §6 shared → Task 1; §7 hub surface → Task 6; §9 testing → tests each task + Task 8. §8 deferrals honored (no web UI, no browse grant, no binary, no persistent Machine/Workspace table).
- **Type consistency:** `FsRequest/FsResponse/Hello/FsEntry/FsStat`, `GrantStore` (`roots`/`isAllowed`/`resolveJailed`), `FileService` (`list`/`stat`/`read`/`write`/`handle`), `PendingRequests` (`create`/`settle`), `MachineRegistry` (`register`/`unregisterSocket`/`get`/`list`), `HubSocket.send`/`onFsRequest` — consistent across tasks.
- **Security:** path-jail is daemon-side (`resolveJailed` on every op); default-deny on empty grants; the hub only routes and cannot bypass the jail. Writes are logged (status message), never approval-gated (per §8).
- **Parallel:** Tasks 2–4 (daemon) and 5–6 (hub) are disjoint; 7–8 integrate.
