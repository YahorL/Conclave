# Browse-and-pick + Workspaces — Design

**Date:** 2026-07-13
**Build-order step:** 5 of 8, sub-project 2 of 4 → part (ii) of 2. (`docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §8, §5/7 Workspace.) Builds on the file-access foundation (2i).
**Scope:** A web Files rail to browse a machine's granted filesystem (via the hub↔daemon fs tunnel), a read-only file viewer, and a persistent Workspace entity created by picking a folder — surfaced as window-strip tabs that filter the chat list.
**Depends on:** steps 1–4 + delegation + artifacts + file-access foundation (2i: `/api/machines`, `POST /api/fs/:machine/:op`). On `main`.

## 1. Goal

Turn the file-access tunnel into a usable browse-and-pick experience: open a Files view, pick a machine, lazily expand its granted roots, read a file, and "Set as workspace" on a folder to create a persistent Workspace that scopes the workspace's chats.

## 2. Standing decisions (from brainstorming)

1. **Persistent Workspace entity** (hub `workspaces` store), created by folder-pick, shown as window-strip tabs.
2. **Files sidebar rail view** (a new rail icon toggles the sidebar between Chats and Files).
3. **Read-only** file viewer; the save-back editor is step 8.
4. **MVP scoping depth:** the active workspace filters the sidebar CHATS to threads with that workspace and defaults new threads/tasks to it. Deeper agent/artifact-by-workspace scoping is deferred.

## 3. Backend (hub): Workspace entity

- `Workspace { id, name, machine, folderPath, createdAt }`; `NewWorkspace { name?, machine, folderPath }` (name defaults to `basename(folderPath)`).
- `workspaces` table + `WorkspaceStore` (`create`, `get`, `list`).
- Routes: `POST /api/workspaces` → 201 Workspace (emits `mailbox.events "workspace"`); `GET /api/workspaces`; `GET /api/workspaces/:id` (404). No path re-validation — browse already went through granted roots.
- `/ws` frame `{ type: "workspace", workspace }` on create, wired alongside the existing frames with cleanup.
- `main.ts` constructs `WorkspaceStore(db)` and passes it via `ServerOptions.workspaces`.

## 4. Web

### Data layer
- `hubClient`: `listMachines()` (`GET /api/machines`), `fsList(machine, path)` (`POST /api/fs/:machine/list`), `fsRead(machine, path)` (`POST /api/fs/:machine/read`), `createWorkspace(input)` (`POST /api/workspaces`), `listWorkspaces()`.
- `socket`: `WsFrame` gains `{ type: "workspace"; workspace: Workspace }`.
- `store`: `sidebarView: "chats" | "files"`; `machines: MachineInfo[]`; `selectedMachine: string | null`; `fsChildren: Record<string, FsEntry[]>` (key `\`${machine}:${path}\``, lazy cache); `activeFsFile: { machine: string; path: string } | null`; `workspacesById: Record<string, Workspace>`; `activeWorkspaceId: string | null`. Actions: `setSidebarView`, `setSelectedMachine`, `setFsChildren`, `setActiveFsFile`, `setActiveWorkspace`; `applyFrame` upserts `workspace`; `reset` clears all new state; `setActiveThread`/`setActiveArtifact` clear `activeFsFile`; opening a file clears `activeArtifactId`. Hydrate `workspaces` (and lazily `machines` when the Files view opens) in `startSync`/on demand.
  - `MachineInfo = { machine: string; files: string[]; lastSeen: string }` (shape from `/api/machines`; declared locally in the store or a small web type).

### Components
- **`FilesPanel`** (rendered by `Sidebar` when `sidebarView === "files"`): a machine `<select>` (from `machines`; empty state "no machines connected") + a `FileTree` for `selectedMachine` rooted at that machine's granted roots.
- **`FileTree` / `FileTreeNode`** (recursive, lazy): a dir node toggles expansion → on first expand, `fsList(machine, path)` → cache in `fsChildren`; renders children (dirs first). File nodes → `setActiveFsFile({machine, path})`. Each dir node has a small **"＋ workspace"** action → `createWorkspace({ machine, folderPath: path })` then it appears in the window tabs.
- **`FsFileView`** (main column when `activeFsFile` set): fetches `fsRead(machine, path)`, renders read-only `<pre>` + path header. Mirrors `ArtifactView`.
- **`Sidebar`**: rail gains a **files icon**; clicking sets `sidebarView`. When `files`, render `FilesPanel` instead of the chats/agents/artifacts sections. The CHATS list (chats view) filters to threads matching the active workspace (see below).
- **`WindowStrip`**: render **workspace tabs** from `workspacesById`; active tab = `activeWorkspaceId`; clicking sets it. The `+`/settings/history icons stay.
- **`App`**: when `activeFsFile` is set, render `FsFileView` in the main column (in place of chat/artifact); precedence: `activeFsFile` > `activeArtifactId` > chat.

### Scoping
- The active workspace is a `Workspace`; its **`name`** (or id) matches `thread.workspace`. The sidebar CHATS filters to threads whose `workspace === activeWorkspace.name` (show all when no active workspace). New threads/tasks/debates created from the UI default their `workspace` to the active workspace name. (Threads created before workspaces exist keep their existing string; unaffected.)

## 5. Explicitly deferred

- File **editing / save-back** — step 8 editor (we built `writeFile` in 2i but keep the UI read-only here).
- Deeper scoping (agents/artifacts/spend by workspace), workspace rename/delete, per-workspace budget.
- Machine-wide time-limited browse grant; binary file rendering; a file-search.

## 6. Testing (Vitest; spec §11)

- **hub**: `WorkspaceStore` (create defaults name to basename, get, list); `POST /api/workspaces` → 201 + `workspace` event; `GET /api/workspaces`.
- **web**: hubClient fs/workspace methods (mocked fetch); `FileTree` lazy-expands a dir (calls `fsList`, renders children) and opens a file (`setActiveFsFile`); `FsFileView` fetches + renders; `FilesPanel` machine picker; `createWorkspace` from a dir node → `workspacesById` + a window tab; `WindowStrip` workspace tabs switch `activeWorkspaceId`; Sidebar CHATS filter by active workspace.
- **integration**: app-level render — a `workspace` frame shows a window tab; the Files view lists a machine and lazily expands (mocked fetch).

## 7. Implementation order (for the plan) — two tracks after Task 1

1. **shared**: `Workspace` / `NewWorkspace` schemas.
2. **[backend track]** hub `workspaces` table + `WorkspaceStore`; tests.
3. **[backend track]** hub routes + `workspace` WS frame + `main.ts`; tests.
4. **[web track]** hubClient fs/workspace methods + socket `workspace` frame + store (new state/actions) + hydrate; tests.
5. **[web track]** `FsFileView` (read-only) + `App` precedence; tests.
6. **[web track]** `FileTree`/`FileTreeNode` + `FilesPanel` (machine picker, lazy expand, open file, ＋workspace); tests.
7. **[web track]** `Sidebar` rail files-view toggle + CHATS workspace filter; tests.
8. **[web track]** `WindowStrip` workspace tabs + default-workspace on new threads; tests.
9. **integration + verification**: app-level test + live drive (`/api/workspaces` create + file browse) + full green.

Tasks **2–3 (backend, hub only)** and **4–8 (web only)** are disjoint after Task 1 and run in parallel; Task 9 integrates.
