# Artifacts — Design

**Date:** 2026-07-13
**Build-order step:** 5 of 8, sub-project 3 of 4 (`docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §5 data model; §4 runner MCP tools). Built after delegation (sub-project 1).
**Scope:** Agents produce durable file work-products via a `create_artifact` MCP tool; the hub stores the blob centrally and announces it in-thread; the web lists artifacts in an ARTIFACTS sidebar and opens them read-only.
**Depends on:** steps 1–4 + delegation. All on `main`.

## 1. Goal

Give agents (and delegated tasks) a way to emit durable, named, content-addressed files — plans, tickets, diffs, generated code — that live outside the ephemeral chat stream, are handed off by id, and are visible/openable in the web app. This is the spec's "file handoff" concept, centralized on the hub.

## 2. Standing decisions (from brainstorming)

1. **Agent-created via `create_artifact` MCP tool** (not user-upload) is the MVP creation path. Text content inline.
2. **Sidebar list + inline read-only view** for the web (an artifact session tab). Full CodeMirror editor stays step 8.
3. **Central hub blob store** → the spec's `origin_machine` becomes **`createdBy`** (agent id / `"you"`); the hub is always the download source. Provenance, not location.
4. **`create_artifact` announces itself** via a `file`-type message in the thread (with the artifact id in `artifacts[]`), so it is visible in chat and the sidebar.
5. **Immutable + content-addressed** (`sha256`). Versions are separate artifacts by name (e.g. `plan` / `plan v2`).

## 3. Data model

New `Artifact` in `@conclave/shared` (metadata; blob is transported separately):

```
Artifact    { id, name, mime, size, sha256, createdBy, createdAt }
NewArtifact { name, mime?, content, createdBy? }   // content: text (utf-8) inline
```

- `mime` defaults to `text/plain` when omitted.
- `size` = byte length of the content; `sha256` = hex digest of the content bytes.
- `createdBy` defaults to `"unknown"` if not provided (the MCP tool passes the agent id; the hub could pass `"you"` for future user-upload).

## 4. Hub

### 4.1 Storage
New `artifacts` table (`db.ts`):

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

`ArtifactStore` (`packages/hub/src/artifacts.ts`):
- `create(input: NewArtifact): Artifact` — computes `size` + `sha256` from `Buffer.from(content, "utf-8")`, rejects `size > 50 MB` (`ArtifactTooLargeError`), inserts, returns **metadata** (no blob).
- `get(id): Artifact | undefined` — metadata.
- `getBlob(id): Buffer | undefined` — raw bytes.
- `list(): Artifact[]` — metadata, newest first.
- `ArtifactTooLargeError extends Error`.

### 4.2 HTTP
- `POST /api/artifacts` — body `NewArtifactSchema` → 201 `Artifact` (413 too large, 503 no store). Emits `mailbox.events.emit("artifact", artifact)`.
- `GET /api/artifacts` — `Artifact[]`.
- `GET /api/artifacts/:id` — `Artifact` | 404.
- `GET /api/artifacts/:id/blob` — raw bytes; headers `Content-Type: <mime>`, `Content-Disposition: inline; filename="<name>"`; 404 if missing. (Auth still required via the global onRequest hook — the `?token=` form works for browser `<a>`/fetch.)

### 4.3 WebSocket
`/ws` broadcasts `{ type: "artifact", artifact }` on the `mailbox.events` `"artifact"` event, wired alongside message/thread/turn/status/task with matching cleanup.

### 4.4 Wiring
`main.ts` constructs `ArtifactStore(db)` and passes it via `ServerOptions.artifacts`.

## 5. Daemon / MCP tool

- `HubClient.createArtifact(input: NewArtifact): Promise<Artifact>` → `POST /api/artifacts`.
- New bridge tool **`create_artifact`** in `buildBridgeServer`:
  - input `{ name: string, mime?: string, content: string }`.
  - creates the artifact (`createdBy: agentId`), then `postMessage(threadId, { from: agentId, to: [], type: "file", body: \`created artifact: ${name}\`, artifacts: [artifact.id] })`.
  - returns the artifact metadata (as tool text).
- Add `"mcp__hub__create_artifact"` to `HUB_MCP_TOOLS` (`agent-loop.ts`) so agents are permitted to call it.

## 6. Web

- **`hubClient`**: `listArtifacts()`, `getArtifact(id)`, `artifactBlobUrl(id)` (returns `/api/artifacts/${id}/blob?token=<token>` for `<a download>` / fetch-as-text).
- **socket**: `WsFrame` gains `{ type: "artifact"; artifact: Artifact }`.
- **store**: `artifactsById: Record<string, Artifact>`; `activeArtifactId: string | null`; `applyFrame` upserts on `"artifact"`; `setActiveArtifact(id | null)`; `reset` clears both. Hydrate the list in `startSync` (`hubClient.listArtifacts()`).
- **`ArtifactsSidebar`** section (in `Sidebar`, pinned area): rows with a doc icon colored by kind (name/mime heuristic: `plan` → `--artifact-plan`, `ticket` → `--artifact-ticket`, else muted), artifact name; click → `setActiveArtifact(id)`.
- **`ArtifactView`**: fetches `artifactBlobUrl(id)` as text, renders read-only in a `<pre>` (mono, code-block styling) with the name/mime header + a download link. Shown when `activeArtifactId` is set.
- **`SessionTabs`**: when `activeArtifactId` is set, show an artifact tab (`▦`, italic name) as active; clicking a thread tab calls `setActiveArtifact(null)`.
- **`App` main column**: when `activeArtifactId` is set, render `ArtifactView` in place of `GroupChat` + `Composer`; otherwise the chat as today.

## 7. Explicitly deferred

- Web user-upload of artifacts — agent-created only this MVP.
- Binary/base64 artifact content from agents — text inline only.
- **Promote** (message / code-block → artifact) — a separate UI action; later.
- Populating `Task.artifacts` from artifacts an agent creates mid-task — artifacts surface as `file` messages in the task thread for now (the daemon can't see MCP-tool side effects without a report-back path).
- Workspace-scoping the artifact list — global list this MVP.
- Artifact deletion / explicit versioning UI, full CodeMirror editor (step 8), file-link-in-chat → artifact navigation.

## 8. Testing (Vitest; spec §11)

- **shared**: `ArtifactSchema` / `NewArtifactSchema` (mime default, content required).
- **hub**: `ArtifactStore` create computes sha256 + size and rejects > 50 MB; `get`/`getBlob`/`list`; `POST /api/artifacts` → 201 + emits `artifact` event; `GET /:id/blob` returns bytes + `Content-Type`; list.
- **daemon**: `HubClient.createArtifact`; `buildBridgeServer` `create_artifact` tool creates the artifact and posts a `file` message (against a live hub server, like the existing bridge tests).
- **web**: `artifact` frame → `artifactsById`; `ArtifactsSidebar` lists + click sets `activeArtifactId`; `ArtifactView` fetches + renders text; `SessionTabs` shows the artifact tab.

## 9. Implementation order (for the plan)

1. shared: `Artifact` / `NewArtifact` schemas.
2. hub: `artifacts` table + `ArtifactStore` (+ `ArtifactTooLargeError`); tests.
3. hub: routes (`POST`/`GET`/`GET :id`/`GET :id/blob`) + `artifact` WS frame + `main.ts`; tests.
4. daemon: `HubClient.createArtifact` + bridge `create_artifact` tool + `HUB_MCP_TOOLS`; tests.
5. web: `hubClient` artifact methods + socket frame + store (`artifactsById`/`activeArtifactId`) + `startSync` hydrate; tests.
6. web: `ArtifactsSidebar` section wired into `Sidebar`; tests.
7. web: `ArtifactView` + `SessionTabs` artifact tab + `App` main wiring; tests.
8. e2e verification: agent (fake adapter) calls `create_artifact` against a live hub; artifact appears + downloadable; full monorepo green.
