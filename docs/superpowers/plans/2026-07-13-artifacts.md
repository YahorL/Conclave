# Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents produce durable, named, content-addressed file artifacts via a `create_artifact` MCP tool; the hub stores the blob centrally and announces it in-thread; the web lists artifacts in an ARTIFACTS sidebar and opens them read-only.

**Architecture:** New `Artifact` model + hub blob store (SQLite BLOB, ≤50 MB, sha256). A `create_artifact` bridge tool creates the artifact (createdBy = agent id) and posts a `file` message referencing it. The web hydrates + live-updates an artifact list and renders a read-only viewer as an artifact session tab.

**Tech Stack:** Existing Fastify hub (better-sqlite3, Zod, node:crypto), the daemon MCP bridge (`@modelcontextprotocol/sdk`), `@conclave/web` (React + Zustand). Vitest throughout.

## Global Constraints

- **TypeScript everywhere**, ESM. `npx pnpm ...` (not on PATH).
- **Test invocation:** backend tests from **repo root** — `npx vitest run <path>`. Web tests — `npx pnpm --filter @conclave/web exec vitest run`. Typecheck per-package or `npx pnpm -r typecheck`.
- **Zod v4**; export schema + inferred type; `.js` import specifiers.
- **Auth:** every hub route except `/health` needs `Authorization: Bearer <token>` or `?token=` (the blob route is fetched by the browser with `?token=`).
- **Commit trailer:** end every commit message with `Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue`.
- TDD: failing test first. Commit after every green step. Branch: `feat/artifacts`.

## File Structure

**shared:** `packages/shared/src/artifact.ts` (create), `src/index.ts` (re-export).
**hub:** `db.ts` (artifacts table), `src/artifacts.ts` (`ArtifactStore`, `ArtifactTooLargeError`), `src/server.ts` (routes + WS frame + 413), `src/main.ts` (wire).
**daemon:** `src/hub-client.ts` (`createArtifact`), `src/mcp-bridge.ts` (`create_artifact` tool), `src/agent-loop.ts` (`HUB_MCP_TOOLS`).
**web:** `src/lib/hubClient.ts`, `src/lib/socket.ts`, `src/store/useConclaveStore.ts`, `src/store/sync.ts`, `src/components/Sidebar.tsx` (+ ARTIFACTS section), `src/components/ArtifactView.tsx` (+ css), `src/components/SessionTabs.tsx`, `src/App.tsx`.

---

## Task 1: Shared Artifact schemas

**Files:**
- Create: `packages/shared/src/artifact.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/artifact.test.ts`

**Interfaces:**
- Produces: `ArtifactSchema` = `{ id, name, mime, size, sha256, createdBy, createdAt }`; `NewArtifactSchema` = `{ name, mime (default "text/plain"), content, createdBy? }`; types `Artifact`, `NewArtifact`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/artifact.test.ts
import { describe, expect, it } from "vitest";
import { ArtifactSchema, NewArtifactSchema } from "../src/artifact.js";

describe("artifact schemas", () => {
  it("defaults mime and requires content on new artifacts", () => {
    const n = NewArtifactSchema.parse({ name: "plan.md", content: "# Plan" });
    expect(n.mime).toBe("text/plain");
    expect(() => NewArtifactSchema.parse({ name: "x" })).toThrow();
  });

  it("accepts full artifact metadata", () => {
    const a = ArtifactSchema.parse({
      id: "a1", name: "plan.md", mime: "text/markdown", size: 6, sha256: "abc",
      createdBy: "codex", createdAt: "2026-07-13T10:00:00Z",
    });
    expect(a.name).toBe("plan.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/artifact.test.ts`
Expected: FAIL — cannot resolve `../src/artifact.js`.

- [ ] **Step 3: Create the schema module**

```ts
// packages/shared/src/artifact.ts
import { z } from "zod";

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const NewArtifactSchema = z.object({
  name: z.string().min(1),
  mime: z.string().min(1).default("text/plain"),
  content: z.string().min(1),
  createdBy: z.string().min(1).optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
export type NewArtifact = z.infer<typeof NewArtifactSchema>;
```

- [ ] **Step 4: Re-export**

Add to `packages/shared/src/index.ts`: `export * from "./artifact.js";`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/test/artifact.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx pnpm --filter @conclave/shared typecheck
git add packages/shared/src/artifact.ts packages/shared/src/index.ts packages/shared/test/artifact.test.ts
git commit -m "feat(shared): artifact schemas

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 2: Hub artifacts table + ArtifactStore

**Files:**
- Modify: `packages/hub/src/db.ts` (artifacts table)
- Create: `packages/hub/src/artifacts.ts` (`ArtifactStore`, `ArtifactTooLargeError`)
- Test: `packages/hub/test/artifacts-store.test.ts`

**Interfaces:**
- Consumes: `Artifact`, `NewArtifact` (Task 1).
- Produces:
  - `class ArtifactTooLargeError extends Error`.
  - `class ArtifactStore { create(input: NewArtifact): Artifact; get(id): Artifact | undefined; getBlob(id): Buffer | undefined; list(): Artifact[] }` — `create` computes `size` + `sha256` from `Buffer.from(content, "utf-8")`, throws `ArtifactTooLargeError` if `size > 50*1024*1024`, returns metadata (no blob).

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/test/artifacts-store.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { ArtifactStore, ArtifactTooLargeError } from "../src/artifacts.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "conclave-art-"));
  return openDb(join(dir, "t.db"));
}

describe("ArtifactStore", () => {
  it("stores metadata + blob, computes size and sha256", () => {
    const store = new ArtifactStore(freshDb());
    const content = "# Plan\nbody";
    const art = store.create({ name: "plan.md", mime: "text/markdown", content });
    expect(art.size).toBe(Buffer.byteLength(content));
    expect(art.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(store.getBlob(art.id)?.toString("utf-8")).toBe(content);
    expect(store.list().map((a) => a.id)).toEqual([art.id]);
  });

  it("rejects content over 50MB", () => {
    const store = new ArtifactStore(freshDb());
    const huge = "x".repeat(50 * 1024 * 1024 + 1);
    expect(() => store.create({ name: "big", mime: "text/plain", content: huge })).toThrow(
      ArtifactTooLargeError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/artifacts-store.test.ts`
Expected: FAIL — cannot resolve `../src/artifacts.js`.

- [ ] **Step 3: Add the artifacts table**

In `packages/hub/src/db.ts`, append inside the `migrate` exec block after the `tasks` index:
```sql
    CREATE TABLE IF NOT EXISTS artifacts (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      sha256     TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      blob       BLOB NOT NULL
    );
```

- [ ] **Step 4: Implement ArtifactStore**

```ts
// packages/hub/src/artifacts.ts
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Artifact, NewArtifact } from "@conclave/shared";

const MAX_BYTES = 50 * 1024 * 1024;

export class ArtifactTooLargeError extends Error {
  constructor(size: number) {
    super(`artifact too large: ${size} bytes (max ${MAX_BYTES})`);
  }
}

interface ArtifactRow {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_by: string;
  created_at: string;
}

function rowToArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id, name: r.name, mime: r.mime, size: r.size, sha256: r.sha256,
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

const META_COLS = "id, name, mime, size, sha256, created_by, created_at";

export class ArtifactStore {
  constructor(private readonly db: Database.Database) {}

  create(input: NewArtifact): Artifact {
    const buf = Buffer.from(input.content, "utf-8");
    if (buf.byteLength > MAX_BYTES) throw new ArtifactTooLargeError(buf.byteLength);
    const artifact: Artifact = {
      id: randomUUID(),
      name: input.name,
      mime: input.mime,
      size: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
      createdBy: input.createdBy ?? "unknown",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO artifacts (id, name, mime, size, sha256, created_by, created_at, blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id, artifact.name, artifact.mime, artifact.size, artifact.sha256,
        artifact.createdBy, artifact.createdAt, buf,
      );
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare(`SELECT ${META_COLS} FROM artifacts WHERE id = ?`).get(id) as
      | ArtifactRow
      | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  getBlob(id: string): Buffer | undefined {
    const row = this.db.prepare("SELECT blob FROM artifacts WHERE id = ?").get(id) as
      | { blob: Buffer }
      | undefined;
    return row?.blob;
  }

  list(): Artifact[] {
    return (
      this.db.prepare(`SELECT ${META_COLS} FROM artifacts ORDER BY created_at DESC`).all() as ArtifactRow[]
    ).map(rowToArtifact);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/artifacts-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npx pnpm --filter @conclave/hub typecheck
git add packages/hub/src/db.ts packages/hub/src/artifacts.ts packages/hub/test/artifacts-store.test.ts
git commit -m "feat(hub): artifacts table and ArtifactStore (sha256, 50MB cap)

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 3: Hub artifact routes + WS frame

**Files:**
- Modify: `packages/hub/src/server.ts` (routes, 413, `artifact` WS frame, `ServerOptions.artifacts`)
- Modify: `packages/hub/src/main.ts` (construct + pass `ArtifactStore`)
- Test: `packages/hub/test/artifacts-api.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore`, `ArtifactTooLargeError`; `NewArtifactSchema`; `Artifact`.
- Produces:
  - `ServerOptions.artifacts?: ArtifactStore`.
  - `POST /api/artifacts` (body `NewArtifactSchema`) → 201 `Artifact` | 413 | 503; emits `mailbox.events` `"artifact"`.
  - `GET /api/artifacts` → `Artifact[]`; `GET /api/artifacts/:id` → `Artifact` | 404.
  - `GET /api/artifacts/:id/blob` → raw bytes, `Content-Type: <mime>`, `Content-Disposition: inline; filename="<name>"` | 404.
  - `/ws` frame `{ type: "artifact", artifact }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/test/artifacts-api.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Artifact } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { ArtifactStore } from "../src/artifacts.js";
import { buildServer } from "../src/server.js";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function freshServer(): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-aapi-"));
  const db = openDb(join(dir, "t.db"));
  return buildServer({ mailbox: new Mailbox(db), token: TOKEN, db, artifacts: new ArtifactStore(db) });
}

describe("artifacts API", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await freshServer();
  });

  it("creates, lists, and serves the blob with its mime", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/artifacts", headers: AUTH,
      payload: { name: "plan.md", mime: "text/markdown", content: "# Plan" },
    });
    expect(created.statusCode).toBe(201);
    const art = created.json<Artifact>();

    const list = await app.inject({ method: "GET", url: "/api/artifacts", headers: AUTH });
    expect(list.json<Artifact[]>().map((a) => a.id)).toEqual([art.id]);

    const blob = await app.inject({ method: "GET", url: `/api/artifacts/${art.id}/blob`, headers: AUTH });
    expect(blob.statusCode).toBe(200);
    expect(blob.headers["content-type"]).toContain("text/markdown");
    expect(blob.body).toBe("# Plan");
  });

  it("404 for an unknown blob", async () => {
    const res = await app.inject({ method: "GET", url: "/api/artifacts/nope/blob", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/artifacts-api.test.ts`
Expected: FAIL — routes 404.

- [ ] **Step 3: Wire the server**

In `packages/hub/src/server.ts`:

Imports — add `NewArtifactSchema` to the value import, `Artifact` to the type import, and:
```ts
import { ArtifactStore, ArtifactTooLargeError } from "./artifacts.js";
```

`ServerOptions` — add `artifacts?: ArtifactStore;`

Error handler — add before the ZodError line:
```ts
    if (err instanceof ArtifactTooLargeError) return reply.code(413).send({ error: err.message });
```

Routes — add near the task routes:
```ts
  app.post("/api/artifacts", async (req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    const body = parseOr400(NewArtifactSchema, req.body, reply);
    if (!body) return;
    const artifact = opts.artifacts.create(body);
    mailbox.events.emit("artifact", artifact);
    return reply.code(201).send(artifact);
  });

  app.get("/api/artifacts", async (_req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    return opts.artifacts.list();
  });

  app.get("/api/artifacts/:id", async (req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const art = opts.artifacts.get(id);
    if (!art) return reply.code(404).send({ error: `artifact not found: ${id}` });
    return art;
  });

  app.get("/api/artifacts/:id/blob", async (req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const art = opts.artifacts.get(id);
    const blob = opts.artifacts.getBlob(id);
    if (!art || !blob) return reply.code(404).send({ error: `artifact not found: ${id}` });
    return reply
      .header("content-type", art.mime)
      .header("content-disposition", `inline; filename="${art.name}"`)
      .send(blob);
  });
```

`/ws` — add the frame + cleanup (alongside message/thread/turn/status/task):
```ts
    const onArtifact = (artifact: Artifact): void => {
      socket.send(JSON.stringify({ type: "artifact", artifact }));
    };
    mailbox.events.on("artifact", onArtifact);
```
and in `socket.on("close", ...)`: `mailbox.events.off("artifact", onArtifact);`

- [ ] **Step 4: Wire main.ts**

Import `ArtifactStore`; after `const tasks = ...` add `const artifacts = new ArtifactStore(db);`; add `artifacts` to the `buildServer` options.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/hub/test/artifacts-api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck, full hub suite, commit**

```bash
npx pnpm --filter @conclave/hub typecheck
npx vitest run packages/hub
git add packages/hub/src/server.ts packages/hub/src/main.ts packages/hub/test/artifacts-api.test.ts
git commit -m "feat(hub): artifact routes, blob endpoint, ws artifact frame

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 4: Daemon HubClient.createArtifact + create_artifact bridge tool

**Files:**
- Modify: `packages/daemon/src/hub-client.ts` (`createArtifact`)
- Modify: `packages/daemon/src/mcp-bridge.ts` (`create_artifact` tool)
- Modify: `packages/daemon/src/agent-loop.ts` (`HUB_MCP_TOOLS`)
- Modify: `packages/daemon/test/mcp-bridge.test.ts` (assert the new tool + round-trip)

**Interfaces:**
- Consumes: `Artifact`, `NewArtifact`.
- Produces:
  - `HubClient.createArtifact(input: NewArtifact): Promise<Artifact>` → `POST /api/artifacts`.
  - bridge tool `create_artifact({ name, mime?, content })` — creates the artifact (`createdBy: agentId`), posts a `file` message `{ from: agentId, to: [], type: "file", body: "created artifact: <name>", artifacts: [id] }`, returns the artifact metadata.
  - `HUB_MCP_TOOLS` includes `"mcp__hub__create_artifact"`.

- [ ] **Step 1: Extend the bridge test (failing)**

In `packages/daemon/test/mcp-bridge.test.ts`:
- Import `ArtifactStore`: `import { ArtifactStore } from "@conclave/hub/src/artifacts.js";`
- Build the server with an artifacts store: `app = await buildServer({ mailbox, token: TOKEN, artifacts: new ArtifactStore(openDb(join(dir, "t.db"))) });` — reuse one db: create the db once, pass to both `Mailbox` and `ArtifactStore`.
- Update the tools assertion to include `create_artifact`:
```ts
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "check_inbox", "create_artifact", "end_thread", "send_message", "wait_for_reply",
    ]);
```
- Add a round-trip before `end_thread`:
```ts
    const madeArt = await client.callTool({
      name: "create_artifact",
      arguments: { name: "plan.md", content: "# Plan" },
    });
    const artMeta = JSON.parse(
      (madeArt.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { id: string; name: string };
    expect(artMeta.name).toBe("plan.md");
    const fileMsg = mailbox.listMessages(thread.id).find((m) => m.type === "file");
    expect(fileMsg?.artifacts).toEqual([artMeta.id]);
```

Refactor the db creation in the test so one `Database` instance backs both the `Mailbox` and the `ArtifactStore` (create `const db = openDb(join(dir, "t.db"));` then `new Mailbox(db)` and `new ArtifactStore(db)`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/daemon/test/mcp-bridge.test.ts`
Expected: FAIL — `create_artifact` not registered.

- [ ] **Step 3: Add HubClient.createArtifact**

In `packages/daemon/src/hub-client.ts`:
- Extend the shared type import with `Artifact, NewArtifact`.
- Add:
```ts
  createArtifact(input: NewArtifact): Promise<Artifact> {
    return this.request("POST", "/api/artifacts", input);
  }
```

- [ ] **Step 4: Register the bridge tool**

In `packages/daemon/src/mcp-bridge.ts`, inside `buildBridgeServer`, before `return server;`:
```ts
  server.registerTool(
    "create_artifact",
    {
      description:
        "Create a durable file artifact (plan, ticket, diff, code) from text content and attach it to the thread.",
      inputSchema: {
        name: z.string().min(1).describe("Artifact file name, e.g. plan.md"),
        mime: z.string().min(1).optional().describe("MIME type; defaults to text/plain"),
        content: z.string().min(1).describe("Artifact text content"),
      },
    },
    async ({ name, mime, content }) => {
      try {
        const artifact = await client.createArtifact({
          name, content, ...(mime ? { mime } : {}), createdBy: agentId,
        });
        await client.postMessage(threadId, {
          from: agentId, to: [], type: "file",
          body: `created artifact: ${name}`, artifacts: [artifact.id],
        });
        return ok(artifact);
      } catch (e) {
        return err(e);
      }
    },
  );
```

- [ ] **Step 5: Permit the tool**

In `packages/daemon/src/agent-loop.ts`, add to `HUB_MCP_TOOLS`:
```ts
  "mcp__hub__create_artifact",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/daemon/test/mcp-bridge.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, full daemon suite, commit**

```bash
npx pnpm --filter @conclave/daemon typecheck
npx vitest run packages/daemon
git add packages/daemon/src/hub-client.ts packages/daemon/src/mcp-bridge.ts packages/daemon/src/agent-loop.ts packages/daemon/test/mcp-bridge.test.ts
git commit -m "feat(daemon): create_artifact bridge tool and hub-client method

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 5: Web hubClient + socket frame + store

**Files:**
- Modify: `packages/web/src/lib/hubClient.ts` (`listArtifacts`, `getArtifact`, `artifactBlobUrl`)
- Modify: `packages/web/src/lib/socket.ts` (`artifact` frame)
- Modify: `packages/web/src/store/useConclaveStore.ts` (`artifactsById`, `activeArtifactId`, `setActiveArtifact`, clear on `setActiveThread`)
- Modify: `packages/web/src/store/sync.ts` (hydrate artifacts)
- Test: `packages/web/src/store/__tests__/artifact-store.test.ts`

**Interfaces:**
- Produces:
  - `hubClient.listArtifacts()`, `getArtifact(id)`, `artifactBlobUrl(id): string` (`/api/artifacts/${id}/blob?token=<token>`).
  - `WsFrame` gains `{ type: "artifact"; artifact: Artifact }`.
  - Store: `artifactsById: Record<string, Artifact>`; `activeArtifactId: string | null`; `setActiveArtifact(id: string | null)`; `applyFrame` upserts on `"artifact"`; `setActiveThread` also clears `activeArtifactId`; `reset` clears both.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/store/__tests__/artifact-store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Artifact } from "@conclave/shared";

const art: Artifact = {
  id: "a1", name: "plan.md", mime: "text/markdown", size: 6, sha256: "abc",
  createdBy: "codex", createdAt: "2026-07-13T10:00:00Z",
};

describe("artifacts in the store", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("upserts artifacts and toggles the active artifact", () => {
    const s = useConclaveStore.getState();
    s.applyFrame({ type: "artifact", artifact: art });
    expect(useConclaveStore.getState().artifactsById["a1"].name).toBe("plan.md");
    s.setActiveArtifact("a1");
    expect(useConclaveStore.getState().activeArtifactId).toBe("a1");
  });

  it("selecting a thread clears the active artifact", () => {
    const s = useConclaveStore.getState();
    s.setActiveArtifact("a1");
    s.setActiveThread("t1");
    expect(useConclaveStore.getState().activeArtifactId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/artifact-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: hubClient methods**

In `packages/web/src/lib/hubClient.ts`, extend the shared type import with `Artifact`, and add to the object:
```ts
  listArtifacts: () => req<Artifact[]>("GET", "/api/artifacts"),
  getArtifact: (id: string) => req<Artifact>("GET", `/api/artifacts/${id}`),
  artifactBlobUrl: (id: string) =>
    `/api/artifacts/${id}/blob${config.token ? `?token=${encodeURIComponent(config.token)}` : ""}`,
```
Add `import { config } from "./config.js";` if not already imported (it is, via `apiHeaders`; `config` is imported already).

- [ ] **Step 4: socket frame**

In `packages/web/src/lib/socket.ts`: import `Artifact`; add `| { type: "artifact"; artifact: Artifact }` to `WsFrame`.

- [ ] **Step 5: store**

In `packages/web/src/store/useConclaveStore.ts`:
- Import `Artifact`.
- `State`: add `artifactsById: Record<string, Artifact>;`, `activeArtifactId: string | null;`, `setActiveArtifact(id: string | null): void;`.
- `initial`: add `artifactsById: {} as Record<string, Artifact>,`, `activeArtifactId: null as string | null,`.
- `setActiveThread` — set `activeArtifactId: null` in its update:
```ts
  setActiveThread: (id) =>
    set((s) => ({
      activeThreadId: id,
      activeArtifactId: null,
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
```
- Add `setActiveArtifact: (id) => set({ activeArtifactId: id }),`.
- `applyFrame` — add:
```ts
        case "artifact":
          return { artifactsById: { ...s.artifactsById, [f.artifact.id]: f.artifact } };
```

- [ ] **Step 6: hydrate in sync**

In `packages/web/src/store/sync.ts`, add `hubClient.listArtifacts().catch(() => [])` to the `Promise.all`, and `store.setArtifacts?.(...)` — simplest: after hydrate, seed via `applyFrame` per artifact, OR add a `setArtifacts` action. Use a small loop:
```ts
    const artifacts = await hubClient.listArtifacts().catch(() => []);
    for (const a of artifacts) store.applyFrame({ type: "artifact", artifact: a });
```
(place after the existing hydrate assignments).

- [ ] **Step 7: Run tests, typecheck, commit**

```bash
npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/artifact-store.test.ts
npx pnpm --filter @conclave/web typecheck
git add packages/web/src/lib/hubClient.ts packages/web/src/lib/socket.ts packages/web/src/store/useConclaveStore.ts packages/web/src/store/sync.ts packages/web/src/store/__tests__/artifact-store.test.ts
git commit -m "feat(web): artifact hub-client, socket frame, store

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 6: Web ARTIFACTS sidebar section

**Files:**
- Modify: `packages/web/src/components/Sidebar.tsx` (+ `Sidebar.module.css`)
- Test: `packages/web/src/components/__tests__/SidebarArtifacts.test.tsx`

**Interfaces:**
- Consumes: `useConclaveStore` (`artifactsById`, `setActiveArtifact`).
- Produces: an ARTIFACTS section listing artifacts (doc icon colored by kind, name); click → `setActiveArtifact(id)`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/SidebarArtifacts.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { Sidebar } from "../Sidebar.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({ type: "artifact", artifact: { id: "a1", name: "idempotency-plan.md", mime: "text/markdown", size: 6, sha256: "abc", createdBy: "codex", createdAt: "2026-07-13T10:00:00Z" } });
});

it("lists artifacts and opens one on click", async () => {
  render(<Sidebar />);
  const row = screen.getByText("idempotency-plan.md");
  expect(row).toBeInTheDocument();
  await userEvent.click(row);
  expect(useConclaveStore.getState().activeArtifactId).toBe("a1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/SidebarArtifacts.test.tsx`
Expected: FAIL — no artifacts section.

- [ ] **Step 3: Add the section to Sidebar**

In `packages/web/src/components/Sidebar.tsx`:
- Add store selectors: `const artifacts = useConclaveStore((s) => Object.values(s.artifactsById));` and `const setActiveArtifact = useConclaveStore((s) => s.setActiveArtifact);`.
- Add an `artifactColor(a)` helper (module-local):
```tsx
function artifactColor(name: string): string {
  if (/ticket/i.test(name)) return "var(--artifact-ticket)";
  if (/plan/i.test(name)) return "var(--artifact-plan)";
  return "var(--text-secondary-2)";
}
```
- Render a section after AGENTS (only when there are artifacts):
```tsx
      {artifacts.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>artifacts</div>
          {artifacts.map((a) => (
            <button key={a.id} className={styles.artifactRow} onClick={() => setActiveArtifact(a.id)}>
              <span className={styles.artifactIcon} style={{ color: artifactColor(a.name) }}>▦</span>
              <span className={styles.artifactName}>{a.name}</span>
            </button>
          ))}
        </div>
      )}
```
Add to `Sidebar.module.css`:
```css
.artifactRow { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 7px 12px; border-radius: 7px; font-size: 12.5px; color: var(--text-secondary); }
.artifactRow:hover { background: var(--hover); }
.artifactIcon { font-size: 13px; flex: none; }
.artifactName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/SidebarArtifacts.test.tsx
npx pnpm --filter @conclave/web typecheck
git add packages/web/src/components/Sidebar.tsx packages/web/src/components/Sidebar.module.css packages/web/src/components/__tests__/SidebarArtifacts.test.tsx
git commit -m "feat(web): ARTIFACTS sidebar section

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 7: Web ArtifactView + artifact session tab

**Files:**
- Create: `packages/web/src/components/ArtifactView.tsx` (+ `ArtifactView.module.css`)
- Modify: `packages/web/src/components/SessionTabs.tsx` (artifact tab)
- Modify: `packages/web/src/App.tsx` (render `ArtifactView` when `activeArtifactId` set)
- Test: `packages/web/src/components/__tests__/ArtifactView.test.tsx`

**Interfaces:**
- Consumes: `useConclaveStore` (`activeArtifactId`, `artifactsById`, `setActiveArtifact`), `hubClient.artifactBlobUrl`.
- Produces:
  - `ArtifactView` — fetches the blob URL as text, renders read-only `<pre>` + name/mime header + download link.
  - `SessionTabs` shows an artifact tab (`▦`, italic) when `activeArtifactId` is set.
  - `App` renders `ArtifactView` instead of `GroupChat`+`Composer` when `activeArtifactId` is set.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/components/__tests__/ArtifactView.test.tsx
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ArtifactView } from "../ArtifactView.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("# Plan\nbody")));
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({ type: "artifact", artifact: { id: "a1", name: "plan.md", mime: "text/markdown", size: 6, sha256: "abc", createdBy: "codex", createdAt: "2026-07-13T10:00:00Z" } });
  s.setActiveArtifact("a1");
});

afterEach(() => vi.unstubAllGlobals());

it("renders the artifact name and fetched content", async () => {
  render(<ArtifactView />);
  expect(screen.getByText("plan.md")).toBeInTheDocument();
  expect(await screen.findByText(/# Plan/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/ArtifactView.test.tsx`
Expected: FAIL — cannot resolve `../ArtifactView.js`.

- [ ] **Step 3: Implement ArtifactView**

```tsx
// packages/web/src/components/ArtifactView.tsx
import { useEffect, useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./ArtifactView.module.css";

export function ArtifactView(): JSX.Element | null {
  const id = useConclaveStore((s) => s.activeArtifactId);
  const artifact = useConclaveStore((s) => (id ? s.artifactsById[id] : undefined));
  const [text, setText] = useState<string>("");

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void fetch(hubClient.artifactBlobUrl(id))
      .then((r) => r.text())
      .then((t) => {
        if (alive) setText(t);
      })
      .catch(() => {
        if (alive) setText("(failed to load artifact)");
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id || !artifact) return null;
  return (
    <div className={styles.view} data-testid="artifact-view">
      <div className={styles.header}>
        <span className={styles.name}>{artifact.name}</span>
        <span className={styles.mime}>{artifact.mime}</span>
        <a className={styles.download} href={hubClient.artifactBlobUrl(id)} download={artifact.name}>
          download
        </a>
      </div>
      <pre className={styles.body}>{text}</pre>
    </div>
  );
}
```

```css
/* packages/web/src/components/ArtifactView.module.css */
.view { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--surface); }
.header { display: flex; align-items: baseline; gap: 12px; padding: 12px 26px; border-bottom: 1px solid var(--hairline); }
.name { color: var(--text-primary); font-weight: 600; font-size: 13px; }
.mime { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }
.download { margin-left: auto; font-size: 11px; color: var(--text-secondary); text-decoration: underline; }
.body { flex: 1; overflow: auto; margin: 0; padding: 20px 26px; background: var(--code-bg);
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-code); white-space: pre-wrap; }
```

- [ ] **Step 4: Artifact tab in SessionTabs**

In `packages/web/src/components/SessionTabs.tsx`, add selectors `activeArtifactId`, `artifactsById` and render an artifact tab when set:
```tsx
  const activeArtifactId = useConclaveStore((s) => s.activeArtifactId);
  const artifactsById = useConclaveStore((s) => s.artifactsById);
```
After the thread tabs `.map`, add:
```tsx
      {activeArtifactId && artifactsById[activeArtifactId] && (
        <button className={styles.tabActive} onClick={() => undefined}>
          <span className={styles.glyph}>▦</span>
          <em>{artifactsById[activeArtifactId].name}</em>
        </button>
      )}
```
And make the thread tabs not appear "active" while an artifact is open — change the thread tab className to `id === activeId && !activeArtifactId ? styles.tabActive : styles.tab`.

- [ ] **Step 5: App renders ArtifactView**

In `packages/web/src/App.tsx`:
- Import `ArtifactView` and add `const activeArtifactId = useConclaveStore((s) => s.activeArtifactId);` (import `useConclaveStore`).
- Replace the `<GroupChat /> <Composer />` region with:
```tsx
          {activeArtifactId ? (
            <ArtifactView />
          ) : (
            <>
              <GroupChat />
              <Composer />
            </>
          )}
```
(Keep `SessionTabs` and `ContextToolbar` above always.)

- [ ] **Step 6: Run tests, full web suite, typecheck, commit**

```bash
npx pnpm --filter @conclave/web exec vitest run
npx pnpm --filter @conclave/web typecheck
git add packages/web/src/components/ArtifactView.tsx packages/web/src/components/ArtifactView.module.css packages/web/src/components/SessionTabs.tsx packages/web/src/App.tsx packages/web/src/components/__tests__/ArtifactView.test.tsx
git commit -m "feat(web): artifact read-only view and session tab

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Task 8: End-to-end verification

**Files:**
- Create: `packages/web/src/__tests__/artifact-integration.test.tsx`
- Modify: `packages/daemon/README.md` (smoke checklist: artifacts)

**Interfaces:** none (verification).

- [ ] **Step 1: App-level integration test**

Add an integration test (model on `task-integration.test.tsx`): stub fetch so `/api/artifacts` returns one artifact and the blob URL returns text; mount `<App/>`; assert the ARTIFACTS sidebar row renders; drive `setActiveArtifact` via the store; assert `ArtifactView` shows the content and the artifact tab appears.

- [ ] **Step 2: Run it**

Run: `npx pnpm --filter @conclave/web exec vitest run src/__tests__/artifact-integration.test.tsx`
Expected: PASS.

- [ ] **Step 3: Live drive (real hub + fake adapter)**

With a hub on an alt port (7799, token `dev`) and a daemon running the codex fake adapter (see `packages/web/README.md` / `packages/daemon/README.md`):
- `create_artifact` is exercised when an agent turn calls it. For a direct check, POST an artifact and fetch its blob:
```bash
H=http://localhost:7799; Q=token=dev; CT=content-type:application/json
A=$(curl -s -H "$CT" -X POST "$H/api/artifacts?$Q" -d '{"name":"plan.md","mime":"text/markdown","content":"# Plan\n- step 1"}')
ID=$(echo "$A" | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s "$H/api/artifacts/$ID/blob?$Q"          # -> "# Plan\n- step 1"
curl -s "$H/api/artifacts?$Q"                    # -> lists it
```
Open the web app and confirm the artifact appears in the ARTIFACTS sidebar and opens read-only. (A real agent `create_artifact` call belongs to the manual smoke checklist — quota-gated CLI.)

- [ ] **Step 4: Smoke checklist entry**

Append to `packages/daemon/README.md` (manual smoke checklist):
```
7. Artifacts (step 5): during a real agent turn/task, have the agent call the
   create_artifact MCP tool; confirm the artifact is stored (GET /api/artifacts),
   a `file` message is posted into the thread with the artifact id, and the web
   ARTIFACTS sidebar lists it and opens it read-only with a working download.
```

- [ ] **Step 5: Full monorepo green + commit**

```bash
npx pnpm -r typecheck
npx vitest run
npx pnpm --filter @conclave/web exec vitest run
git add packages/web/src/__tests__/artifact-integration.test.tsx packages/daemon/README.md
git commit -m "test(artifacts): app-level render; smoke checklist entry

Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue"
```

---

## Self-Review Notes

- **Spec coverage:** §3 model → Task 1; §4.1 store → Task 2; §4.2/4.3/4.4 routes+WS+wiring → Task 3; §5 daemon/tool → Task 4; §6 web client/store → Task 5, sidebar → Task 6, view+tab+app → Task 7; §8 testing → tests each task + Task 8. §7 deferrals honored (no user-upload, no binary, no Promote, no Task.artifacts population, no editor).
- **Type consistency:** `Artifact`/`NewArtifact`, `ArtifactStore` (`create`/`get`/`getBlob`/`list`), `ArtifactTooLargeError`, `HubClient.createArtifact`, bridge `create_artifact`, `HUB_MCP_TOOLS` entry `mcp__hub__create_artifact`, web `listArtifacts`/`getArtifact`/`artifactBlobUrl`, store `artifactsById`/`activeArtifactId`/`setActiveArtifact` + `artifact` frame — consistent across tasks.
- **Auth on blob:** `artifactBlobUrl` appends `?token=` so browser `<a download>` and `fetch` pass the global auth hook.
- **Deferred (not gaps):** user-upload, binary content, Promote, `Task.artifacts` population, workspace-scoping, deletion/versioning UI, full editor — all called out in spec §7.
