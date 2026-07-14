# Browse-and-pick + Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web Files rail to browse a machine's granted filesystem via the hub↔daemon fs tunnel, a read-only file viewer, and a persistent Workspace entity created by picking a folder — shown as window-strip tabs that filter the chat list.

**Architecture:** hub `workspaces` store + routes + WS frame; web Files rail (machine picker + lazy file tree), `FsFileView` (read-only), and workspace tabs. Consumes the existing `/api/machines` + `/api/fs/:machine/:op` from sub-project 2i.

**Tech Stack:** hub (Fastify, better-sqlite3, Zod), `@conclave/web` (React, Zustand). Vitest.

## Global Constraints

- **TypeScript everywhere**, ESM, `npx pnpm ...` (not on PATH).
- **Test invocation:** backend tests from **repo root** — `npx vitest run <path>`. Web tests — `npx pnpm --filter @conclave/web exec vitest run [file]`. Typecheck per-package: `npx pnpm --filter <pkg> typecheck`.
- **Zod v4**; export schema + inferred type; `.js` import specifiers.
- **Auth:** hub routes need the token; the web blob/read is a POST with the auth header (fetch), not an `<a>` — no `?token=` needed here.
- **Commit trailer:** end every commit message with `Claude-Session: https://claude.ai/code/session_01PAMVXwVrKN8TRiBMtSpLue`.
- TDD: failing test first; commit after every green step. Branch: `feat/browse-and-pick`.
- **Web CSS modules:** vitest runs with `css:false`, so `styles.x` is `undefined` in tests — assert by text/testid/role, never class.

## Parallelization

After **Task 1** (shared schema), the **backend track (Tasks 2–3, hub only)** and **web track (Tasks 4–8, web only)** are disjoint and run in parallel. **Task 9** integrates.

---

## Task 1: Shared Workspace schemas

**Files:** Create `packages/shared/src/workspace.ts`; modify `src/index.ts`; test `packages/shared/test/workspace.test.ts`.

**Interfaces (Produces):** `WorkspaceSchema {id, name, machine, folderPath, createdAt}`; `NewWorkspaceSchema {name?, machine, folderPath}`; types `Workspace`, `NewWorkspace`.

- [ ] **Step 1: Failing test**

```ts
// packages/shared/test/workspace.test.ts
import { describe, expect, it } from "vitest";
import { NewWorkspaceSchema, WorkspaceSchema } from "../src/workspace.js";

describe("workspace schemas", () => {
  it("parses new + full workspace", () => {
    expect(NewWorkspaceSchema.parse({ machine: "local", folderPath: "/w" }).machine).toBe("local");
    expect(() => NewWorkspaceSchema.parse({ machine: "local" })).toThrow();
    const w = WorkspaceSchema.parse({
      id: "w1", name: "svc", machine: "local", folderPath: "/w", createdAt: "2026-07-13T10:00:00Z",
    });
    expect(w.name).toBe("svc");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

```ts
// packages/shared/src/workspace.ts
import { z } from "zod";

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  machine: z.string().min(1),
  folderPath: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const NewWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  machine: z.string().min(1),
  folderPath: z.string().min(1),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type NewWorkspace = z.infer<typeof NewWorkspaceSchema>;
```
Add to `src/index.ts`: `export * from "./workspace.js";`

- [ ] **Step 4: Run — expect PASS.** **Step 5:** typecheck + commit (`feat(shared): workspace schemas`).

---

## Task 2 [backend track]: Hub workspaces table + WorkspaceStore

**Files:** Modify `packages/hub/src/db.ts`; create `packages/hub/src/workspaces.ts`; test `packages/hub/test/workspaces-store.test.ts`.

**Interfaces:** Consumes `Workspace`, `NewWorkspace`. Produces `class WorkspaceStore { create(input: NewWorkspace): Workspace; get(id): Workspace | undefined; list(): Workspace[] }` — `create` fills `name` from `basename(folderPath)` when absent, generates uuid + createdAt.

- [ ] **Step 1: Failing test**

```ts
// packages/hub/test/workspaces-store.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { WorkspaceStore } from "../src/workspaces.js";

function store(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), "conclave-ws-"));
  return new WorkspaceStore(openDb(join(dir, "t.db")));
}

describe("WorkspaceStore", () => {
  it("creates with a default name (basename) and lists", () => {
    const s = store();
    const w = s.create({ machine: "local", folderPath: "/home/me/payments-service" });
    expect(w.name).toBe("payments-service");
    expect(s.get(w.id)?.machine).toBe("local");
    expect(s.list().map((x) => x.id)).toEqual([w.id]);
  });
  it("honors an explicit name", () => {
    expect(store().create({ name: "custom", machine: "m", folderPath: "/w" }).name).toBe("custom");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Add table** in `db.ts` migrate block (after artifacts):

```sql
    CREATE TABLE IF NOT EXISTS workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      machine     TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
```

- [ ] **Step 4: Implement**

```ts
// packages/hub/src/workspaces.ts
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { NewWorkspace, Workspace } from "@conclave/shared";

interface WorkspaceRow {
  id: string; name: string; machine: string; folder_path: string; created_at: string;
}
function rowTo(r: WorkspaceRow): Workspace {
  return { id: r.id, name: r.name, machine: r.machine, folderPath: r.folder_path, createdAt: r.created_at };
}

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: NewWorkspace): Workspace {
    const ws: Workspace = {
      id: randomUUID(),
      name: input.name ?? basename(input.folderPath) ?? input.folderPath,
      machine: input.machine,
      folderPath: input.folderPath,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO workspaces (id, name, machine, folder_path, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(ws.id, ws.name, ws.machine, ws.folderPath, ws.createdAt);
    return ws;
  }

  get(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    return row ? rowTo(row) : undefined;
  }

  list(): Workspace[] {
    return (this.db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC").all() as WorkspaceRow[]).map(rowTo);
  }
}
```

- [ ] **Step 5: Run — expect PASS.** **Step 6:** typecheck + commit (`feat(hub): workspaces table and WorkspaceStore`).

---

## Task 3 [backend track]: Hub workspace routes + WS frame

**Files:** Modify `packages/hub/src/server.ts`, `packages/hub/src/main.ts`; test `packages/hub/test/workspaces-api.test.ts`.

**Interfaces:** `ServerOptions.workspaces?: WorkspaceStore`; `POST /api/workspaces` (body `NewWorkspaceSchema`) → 201 + emits `mailbox.events "workspace"`; `GET /api/workspaces`; `GET /api/workspaces/:id` (404); `/ws` frame `{type:"workspace", workspace}`.

- [ ] **Step 1: Failing test**

```ts
// packages/hub/test/workspaces-api.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workspace } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { WorkspaceStore } from "../src/workspaces.js";
import { buildServer } from "../src/server.js";

const TOKEN = "t"; const AUTH = { authorization: `Bearer ${TOKEN}` };
async function fresh(): Promise<FastifyInstance> {
  const dir = mkdtempSync(join(tmpdir(), "conclave-wsapi-"));
  const db = openDb(join(dir, "t.db"));
  return buildServer({ mailbox: new Mailbox(db), token: TOKEN, workspaces: new WorkspaceStore(db) });
}

describe("workspaces API", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await fresh(); });
  it("creates and lists a workspace", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/workspaces", headers: AUTH,
      payload: { machine: "local", folderPath: "/home/me/svc" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<Workspace>().name).toBe("svc");
    const list = await app.inject({ method: "GET", url: "/api/workspaces", headers: AUTH });
    expect(list.json<Workspace[]>()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement in `server.ts`**

Imports: add `NewWorkspaceSchema` (value) and `Workspace` (type) from `@conclave/shared`; `import { WorkspaceStore } from "./workspaces.js";`. `ServerOptions`: add `workspaces?: WorkspaceStore;`.

Routes (near tasks/artifacts routes):
```ts
  app.post("/api/workspaces", async (req, reply) => {
    if (!opts.workspaces) return reply.code(503).send({ error: "workspaces store not configured" });
    const body = parseOr400(NewWorkspaceSchema, req.body, reply);
    if (!body) return;
    const ws = opts.workspaces.create(body);
    mailbox.events.emit("workspace", ws);
    return reply.code(201).send(ws);
  });
  app.get("/api/workspaces", async (_req, reply) => {
    if (!opts.workspaces) return reply.code(503).send({ error: "workspaces store not configured" });
    return opts.workspaces.list();
  });
  app.get("/api/workspaces/:id", async (req, reply) => {
    if (!opts.workspaces) return reply.code(503).send({ error: "workspaces store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const ws = opts.workspaces.get(id);
    if (!ws) return reply.code(404).send({ error: `workspace not found: ${id}` });
    return ws;
  });
```

`/ws` handler — add the frame + cleanup (alongside message/thread/turn/task/artifact):
```ts
    const onWorkspace = (workspace: Workspace): void => {
      socket.send(JSON.stringify({ type: "workspace", workspace }));
    };
    mailbox.events.on("workspace", onWorkspace);
```
and in `socket.on("close", ...)`: `mailbox.events.off("workspace", onWorkspace);`

- [ ] **Step 4: Wire `main.ts`** — import `WorkspaceStore`; `const workspaces = new WorkspaceStore(db);`; add `workspaces` to the `buildServer` options.

- [ ] **Step 5: Run — expect PASS.** **Step 6:** typecheck, `npx vitest run packages/hub`, commit (`feat(hub): workspace routes and ws frame`).

---

## Task 4 [web track]: hubClient fs/workspace + socket frame + store

**Files:** Modify `packages/web/src/lib/hubClient.ts`, `src/lib/socket.ts`, `src/store/useConclaveStore.ts`, `src/store/sync.ts`; test `packages/web/src/store/__tests__/workspace-store.test.ts`.

**Interfaces:**
- `hubClient`: `listMachines()` → `MachineInfo[]`; `fsList(machine, path)` → `FsEntry[]` (`POST /api/fs/${machine}/list` body `{path}`); `fsRead(machine, path)` → `{content:string}` (`POST /api/fs/${machine}/read`); `createWorkspace(input: NewWorkspace)` → `Workspace`; `listWorkspaces()` → `Workspace[]`. Export `type MachineInfo = { machine: string; files: string[]; lastSeen: string }`.
- `WsFrame` gains `{ type: "workspace"; workspace: Workspace }`.
- Store new state: `sidebarView: "chats"|"files"` (init "chats"); `machines: MachineInfo[]`; `selectedMachine: string|null`; `fsChildren: Record<string, FsEntry[]>`; `activeFsFile: {machine:string; path:string}|null`; `workspacesById: Record<string, Workspace>`; `activeWorkspaceId: string|null`. Actions: `setSidebarView(v)`, `setMachines(m)`, `setSelectedMachine(id)`, `setFsChildren(key, entries)`, `setActiveFsFile(f)`, `setActiveWorkspace(id)`; `applyFrame` upserts `workspace`; `reset` clears all new fields; `setActiveThread` and `setActiveArtifact` also set `activeFsFile: null`; `setActiveFsFile(non-null)` also sets `activeArtifactId: null` and `activeThreadId` unchanged. Hydrate workspaces in `startSync` (`listWorkspaces` → for each `applyFrame workspace`).

- [ ] **Step 1: Failing test**

```ts
// packages/web/src/store/__tests__/workspace-store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useConclaveStore } from "../useConclaveStore.js";
import type { Workspace } from "@conclave/shared";

const ws: Workspace = { id: "w1", name: "svc", machine: "local", folderPath: "/w", createdAt: "2026-07-13T10:00:00Z" };

describe("workspaces + files in the store", () => {
  beforeEach(() => useConclaveStore.getState().reset());
  it("upserts workspaces and toggles views/files", () => {
    const s = useConclaveStore.getState();
    s.applyFrame({ type: "workspace", workspace: ws });
    expect(useConclaveStore.getState().workspacesById["w1"].name).toBe("svc");
    s.setSidebarView("files");
    expect(useConclaveStore.getState().sidebarView).toBe("files");
    s.setActiveFsFile({ machine: "local", path: "/w/a.txt" });
    expect(useConclaveStore.getState().activeFsFile?.path).toBe("/w/a.txt");
    s.setActiveThread("t1");
    expect(useConclaveStore.getState().activeFsFile).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: hubClient** — extend shared type import with `FsEntry, NewWorkspace, Workspace`; add:
```ts
export type MachineInfo = { machine: string; files: string[]; lastSeen: string };
```
and in the object:
```ts
  listMachines: () => req<MachineInfo[]>("GET", "/api/machines"),
  fsList: (machine: string, path: string) =>
    req<FsEntry[]>("POST", `/api/fs/${machine}/list`, { path }),
  fsRead: (machine: string, path: string) =>
    req<{ content: string }>("POST", `/api/fs/${machine}/read`, { path }),
  createWorkspace: (input: NewWorkspace) => req<Workspace>("POST", "/api/workspaces", input),
  listWorkspaces: () => req<Workspace[]>("GET", "/api/workspaces"),
```
- [ ] **Step 4: socket** — import `Workspace`; add `| { type: "workspace"; workspace: Workspace }` to `WsFrame`.
- [ ] **Step 5: store** — add the state fields to `State` + `initial`, the actions, `applyFrame` case `workspace`, the `activeFsFile` clears, and `setActiveThread`/`setActiveArtifact` clearing `activeFsFile`. Import `FsEntry, Workspace`.
```ts
        case "workspace":
          return { workspacesById: { ...s.workspacesById, [f.workspace.id]: f.workspace } };
```
`setActiveFsFile: (f) => set({ activeFsFile: f, activeArtifactId: null }),`
- [ ] **Step 6: sync** — after existing hydrate: `const wss = await hubClient.listWorkspaces().catch(() => []); for (const w of wss) store.applyFrame({ type: "workspace", workspace: w });`
- [ ] **Step 7: Run — expect PASS.** **Step 8:** typecheck + commit (`feat(web): fs/workspace hub-client, socket frame, store`).

---

## Task 5 [web track]: FsFileView + App precedence

**Files:** Create `packages/web/src/components/FsFileView.tsx` (+ `.module.css`); modify `packages/web/src/App.tsx`; test `packages/web/src/components/__tests__/FsFileView.test.tsx`.

**Interfaces:** `FsFileView` reads `activeFsFile` from the store, fetches `hubClient.fsRead(machine, path)`, renders read-only `<pre>` + a header showing the path. `App`: when `activeFsFile` set → render `FsFileView`; else if `activeArtifactId` → `ArtifactView`; else chat.

- [ ] **Step 1: Failing test**

```tsx
// packages/web/src/components/__tests__/FsFileView.test.tsx
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { FsFileView } from "../FsFileView.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: "line one" }))));
  const s = useConclaveStore.getState();
  s.reset();
  s.setActiveFsFile({ machine: "local", path: "/w/a.txt" });
});
afterEach(() => vi.unstubAllGlobals());

it("shows the path and fetched content", async () => {
  render(<FsFileView />);
  expect(screen.getByText(/\/w\/a\.txt/)).toBeInTheDocument();
  expect(await screen.findByText(/line one/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** (mirror `ArtifactView`)

```tsx
// packages/web/src/components/FsFileView.tsx
import { useEffect, useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./FsFileView.module.css";

export function FsFileView(): JSX.Element | null {
  const file = useConclaveStore((s) => s.activeFsFile);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!file) return;
    let alive = true;
    void hubClient
      .fsRead(file.machine, file.path)
      .then((r) => { if (alive) setText(r.content); })
      .catch(() => { if (alive) setText("(failed to read file)"); });
    return () => { alive = false; };
  }, [file?.machine, file?.path]);
  if (!file) return null;
  return (
    <div className={styles.view} data-testid="fs-file-view">
      <div className={styles.header}>
        <span className={styles.path}>{file.path}</span>
        <span className={styles.machine}>{file.machine}</span>
      </div>
      <pre className={styles.body}>{text}</pre>
    </div>
  );
}
```
```css
/* FsFileView.module.css */
.view { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--surface); }
.header { display: flex; align-items: baseline; gap: 12px; padding: 12px 26px; border-bottom: 1px solid var(--hairline); }
.path { color: var(--text-primary); font-weight: 600; font-size: 13px; font-family: var(--font-mono); }
.machine { margin-left: auto; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }
.body { flex: 1; overflow: auto; margin: 0; padding: 20px 26px; background: var(--code-bg);
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-code); white-space: pre-wrap; }
```

- [ ] **Step 4: App** — import `FsFileView` + `useConclaveStore` (already imported). Add `const activeFsFile = useConclaveStore((s) => s.activeFsFile);` and change the main-column conditional to:
```tsx
          {activeFsFile ? (
            <FsFileView />
          ) : activeArtifactId ? (
            <ArtifactView />
          ) : (
            <>
              <GroupChat />
              <Composer />
            </>
          )}
```

- [ ] **Step 5: Run — expect PASS.** **Step 6:** typecheck + commit (`feat(web): read-only fs file view`).

---

## Task 6 [web track]: FileTree + FilesPanel

**Files:** Create `packages/web/src/components/FileTree.tsx`, `src/components/FilesPanel.tsx` (+ `.module.css` each); test `packages/web/src/components/__tests__/FileTree.test.tsx`.

**Interfaces:**
- `FileTreeNode({ machine, path, name, kind })`: dir → button toggles expansion; on first expand, `hubClient.fsList(machine, path)` → `setFsChildren(\`${machine}:${path}\`, entries)`; render children (from `fsChildren`) as nested `FileTreeNode`s (children paths = `${path}/${child.name}`). Dir also has a `＋` button → `hubClient.createWorkspace({ machine, folderPath: path })`. File → button → `setActiveFsFile({ machine, path })`.
- `FileTree({ machine, roots })`: render a dir `FileTreeNode` per root path (name = the root's basename or the path).
- `FilesPanel`: machine `<select>` bound to `selectedMachine` (options from `machines`); when a machine is selected, render `FileTree` with that machine's `files` (granted roots) from `machines`. Empty states: "no machines connected" / "select a machine".

- [ ] **Step 1: Failing test**

```tsx
// packages/web/src/components/__tests__/FileTree.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { hubClient } from "../../lib/hubClient.js";
import { FileTree } from "../FileTree.js";

beforeEach(() => {
  useConclaveStore.getState().reset();
});

it("lazily expands a dir and opens a file", async () => {
  vi.spyOn(hubClient, "fsList").mockResolvedValue([
    { name: "a.txt", kind: "file", size: 3 },
    { name: "sub", kind: "dir" },
  ]);
  render(<FileTree machine="local" roots={["/w"]} />);
  await userEvent.click(screen.getByText("/w"));
  expect(hubClient.fsList).toHaveBeenCalledWith("local", "/w");
  const file = await screen.findByText("a.txt");
  await userEvent.click(file);
  expect(useConclaveStore.getState().activeFsFile).toEqual({ machine: "local", path: "/w/a.txt" });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

```tsx
// packages/web/src/components/FileTree.tsx
import { useState } from "react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import type { FsEntry } from "@conclave/shared";
import styles from "./FileTree.module.css";

function join(base: string, name: string): string {
  return `${base.replace(/\/$/, "")}/${name}`;
}

function Node({ machine, path, name, kind }: { machine: string; path: string; name: string; kind: "file" | "dir" }): JSX.Element {
  const [open, setOpen] = useState(false);
  const key = `${machine}:${path}`;
  const children = useConclaveStore((s) => s.fsChildren[key]);
  const setFsChildren = useConclaveStore((s) => s.setFsChildren);
  const setActiveFsFile = useConclaveStore((s) => s.setActiveFsFile);

  if (kind === "file") {
    return (
      <button className={styles.file} onClick={() => setActiveFsFile({ machine, path })}>
        {name}
      </button>
    );
  }
  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && !children) setFsChildren(key, await hubClient.fsList(machine, path));
  };
  return (
    <div className={styles.dir}>
      <div className={styles.dirRow}>
        <button className={styles.dirName} onClick={() => void toggle()}>
          {open ? "▾" : "▸"} {name}
        </button>
        <button
          className={styles.pick}
          title="Set as workspace"
          onClick={() => void hubClient.createWorkspace({ machine, folderPath: path })}
        >
          ＋
        </button>
      </div>
      {open && children && (
        <div className={styles.children}>
          {[...children]
            .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
            .map((c: FsEntry) => (
              <Node key={c.name} machine={machine} path={join(path, c.name)} name={c.name} kind={c.kind} />
            ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ machine, roots }: { machine: string; roots: string[] }): JSX.Element {
  return (
    <div className={styles.tree} data-testid="file-tree">
      {roots.map((r) => (
        <Node key={r} machine={machine} path={r} name={r} kind="dir" />
      ))}
    </div>
  );
}
```
```css
/* FileTree.module.css */
.tree { padding: 4px 0; }
.dir { }
.dirRow { display: flex; align-items: center; }
.dirName { flex: 1; text-align: left; padding: 5px 8px; font-size: 12.5px; color: var(--text-body); font-family: var(--font-mono); }
.dirName:hover { background: var(--hover); }
.pick { padding: 5px 8px; color: var(--text-muted); }
.pick:hover { color: var(--text-primary); }
.children { padding-left: 12px; }
.file { display: block; width: 100%; text-align: left; padding: 5px 8px 5px 20px; font-size: 12.5px; color: var(--text-secondary); font-family: var(--font-mono); }
.file:hover { background: var(--hover); color: var(--text-primary); }
```

```tsx
// packages/web/src/components/FilesPanel.tsx
import { useConclaveStore } from "../store/useConclaveStore.js";
import { FileTree } from "./FileTree.js";
import styles from "./FilesPanel.module.css";

export function FilesPanel(): JSX.Element {
  const machines = useConclaveStore((s) => s.machines);
  const selected = useConclaveStore((s) => s.selectedMachine);
  const setSelected = useConclaveStore((s) => s.setSelectedMachine);
  const current = machines.find((m) => m.machine === selected);

  return (
    <div className={styles.panel} data-testid="files-panel">
      <div className={styles.header}>files</div>
      {machines.length === 0 ? (
        <div className={styles.empty}>no machines connected</div>
      ) : (
        <select
          className={styles.picker}
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value || null)}
        >
          <option value="">select a machine…</option>
          {machines.map((m) => (
            <option key={m.machine} value={m.machine}>{m.machine}</option>
          ))}
        </select>
      )}
      {current && <FileTree machine={current.machine} roots={current.files} />}
    </div>
  );
}
```
```css
/* FilesPanel.module.css */
.panel { display: flex; flex-direction: column; overflow-y: auto; }
.header { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase; color: var(--text-muted); padding: 12px 12px 8px; }
.picker { margin: 0 12px 8px; background: var(--card); color: var(--text-body); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12.5px; }
.empty { padding: 8px 14px; font-size: 12px; color: var(--text-muted); }
```

- [ ] **Step 4: Run — expect PASS.** **Step 5:** typecheck + commit (`feat(web): lazy file tree and files panel`).

---

## Task 7 [web track]: Sidebar rail Files toggle + CHATS workspace filter

**Files:** Modify `packages/web/src/components/Sidebar.tsx` (+ css); test `packages/web/src/components/__tests__/SidebarFiles.test.tsx`.

**Interfaces:** Sidebar rail shows a second icon (files, `FolderTree`/`Folder` from lucide-react); clicking sets `sidebarView`. When `sidebarView === "files"`, render `<FilesPanel/>` (and lazy-load machines: on switching to files, if `machines` empty, `hubClient.listMachines()` → `setMachines`). When `"chats"`, render the existing chats/agents/artifacts sections, but the CHATS list filters to threads matching the active workspace: `const active = workspacesById[activeWorkspaceId]; const shown = active ? threads.filter(t => t.workspace === active.name) : threads;`.

- [ ] **Step 1: Failing test**

```tsx
// packages/web/src/components/__tests__/SidebarFiles.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { hubClient } from "../../lib/hubClient.js";
import { Sidebar } from "../Sidebar.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  useConclaveStore.getState().reset();
});

it("switches to the files view when the files rail icon is clicked", async () => {
  vi.spyOn(hubClient, "listMachines").mockResolvedValue([{ machine: "local", files: ["/w"], lastSeen: "x" }]);
  render(<Sidebar />);
  await userEvent.click(screen.getByLabelText("files"));
  expect(useConclaveStore.getState().sidebarView).toBe("files");
  expect(await screen.findByTestId("files-panel")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — add to `Sidebar`:
  - imports: `Folder` from `lucide-react`, `FilesPanel`, `hubClient`.
  - selectors: `sidebarView`, `setSidebarView`, `machines`, `setMachines`, `workspacesById`, `activeWorkspaceId`.
  - rail: add a second button `aria-label="files"` with `<Folder size={16}/>`; the chats button keeps `aria-label="chats"` and sets `sidebarView("chats")`; active class when the view matches. On files click: `setSidebarView("files"); if (machines.length===0) void hubClient.listMachines().then(setMachines);`.
  - body: `sidebarView === "files" ? <FilesPanel/> : (<>…existing chats/agents/artifacts…</>)`.
  - CHATS filter: replace `threads.map` source with the `shown` filtered list above.

- [ ] **Step 4: Run — expect PASS.** **Step 5:** typecheck + commit (`feat(web): sidebar files rail view and workspace-filtered chats`).

---

## Task 8 [web track]: WindowStrip workspace tabs + default workspace

**Files:** Modify `packages/web/src/components/WindowStrip.tsx` (+ css); modify `packages/web/src/components/Composer.tsx` (default workspace on `/task`); test `packages/web/src/components/__tests__/WindowStripWorkspaces.test.tsx`.

**Interfaces:** `WindowStrip` renders a tab per workspace (from `workspacesById`), active = `activeWorkspaceId`, click → `setActiveWorkspace(id)`. The existing spend/settings/history stay. Composer `/task` and message posts default `workspace` to the active workspace name where the API accepts it (tasks: `createTask({..., workspace: active?.name})`).

- [ ] **Step 1: Failing test**

```tsx
// packages/web/src/components/__tests__/WindowStripWorkspaces.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { WindowStrip } from "../WindowStrip.js";

beforeEach(() => {
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({ type: "workspace", workspace: { id: "w1", name: "svc", machine: "local", folderPath: "/w", createdAt: "2026-07-13T10:00:00Z" } });
});

it("shows a workspace tab and activates it on click", async () => {
  render(<WindowStrip />);
  await userEvent.click(screen.getByText("svc"));
  expect(useConclaveStore.getState().activeWorkspaceId).toBe("w1");
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — in `WindowStrip`, add selectors `workspacesById`, `activeWorkspaceId`, `setActiveWorkspace`; render workspace tabs (mirroring the existing single tab styling) before the right-side icons; each tab button `onClick={() => setActiveWorkspace(w.id)}` with active styling when `w.id === activeWorkspaceId`. Keep the existing derived-workspace tab only when there are no persistent workspaces (fallback), else render the workspace tabs. In `Composer`, when creating a task, pass `workspace: active?.name` where `active = workspacesById[activeWorkspaceId]` (guard undefined → the existing `activeThread?.workspace` fallback).

- [ ] **Step 4: Run — expect PASS.** **Step 5:** typecheck, full web suite (`npx pnpm --filter @conclave/web exec vitest run`), commit (`feat(web): window-strip workspace tabs and default workspace`).

---

## Task 9: Integration + verification

**Files:** Create `packages/web/src/__tests__/workspace-integration.test.tsx`; modify `packages/daemon/README.md`.

- [ ] **Step 1: App-level integration test** — mount `<App/>` with stubbed WebSocket + fetch (model on `artifact-integration.test.tsx`): `/api/workspaces` returns one workspace → assert a window tab shows its name; `/api/machines` returns a machine; switch to the files view (click the files rail icon) → assert the machine appears in the picker.
- [ ] **Step 2: Run — expect PASS.**
- [ ] **Step 3: Live drive** — hub + a daemon with a granted dir (as in the 2i smoke); `curl -X POST /api/workspaces -d '{"machine":"local","folderPath":"<granted dir>"}'` → GET /api/workspaces lists it; open the web app, Files view, pick the machine, expand the root, open a file, click ＋ on a folder → a workspace tab appears. (Use setsid/PGID or the /proc python sweep for teardown.)
- [ ] **Step 4: Smoke checklist** — append to `packages/daemon/README.md`:
```
9. Browse-and-pick (step 5): in the web Files rail, pick a machine, expand a
   granted root, open a file (read-only), and "＋ workspace" a folder — confirm
   POST /api/workspaces creates it and it appears as a window tab that filters
   the chat list.
```
- [ ] **Step 5: Full monorepo green + commit** (`npx pnpm -r typecheck`, `npx vitest run`, `npx pnpm --filter @conclave/web exec vitest run`; `test(browse-and-pick): app-level workspace + files render; smoke entry`).

---

## Self-Review Notes

- **Spec coverage:** §3 Workspace → Tasks 1–3; §4 data layer → Task 4, FsFileView → 5, FileTree/FilesPanel → 6, Sidebar rail + filter → 7, WindowStrip tabs + default → 8; §6 testing → tests each task + Task 9. §5 deferrals honored (read-only, no deep scoping, no rename/budget).
- **Type consistency:** `Workspace`/`NewWorkspace`, `WorkspaceStore` (`create`/`get`/`list`), `MachineInfo`, hubClient `listMachines`/`fsList`/`fsRead`/`createWorkspace`/`listWorkspaces`, store `sidebarView`/`machines`/`selectedMachine`/`fsChildren`/`activeFsFile`/`workspacesById`/`activeWorkspaceId` + actions, `workspace` frame — consistent across tasks.
- **Precedence:** main column renders `activeFsFile` > `activeArtifactId` > chat; selecting a thread/artifact clears `activeFsFile`; opening a file clears `activeArtifactId`.
- **Parallel:** Tasks 2–3 (hub) and 4–8 (web) are disjoint; Task 9 integrates.
