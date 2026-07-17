# Editor Save-Back (design) — step 8.3

Date: 2026-07-17
Status: approved (user: "yes")
Step: build-order step 8, sub-project 3 of 5 (8.1 Teal ✓, 8.2 meters ✓; then mobile, Tauri)
Parent: arch spec §8 ("single-file viewer/editor (CodeMirror, syntax highlighting), save writes back through the daemon. Not an IDE… File links in chat open here. Edits are user actions — no approval gate, but every write is logged as a status message")

## Goal

Upgrade the read-only `FsFileView` into a CodeMirror 6 editor whose saves write
back through the existing daemon fs tunnel, and bring chat file links to life
(click → open in the editor). Last-write-wins; no IDE ambitions.

## User-approved decisions

1. **CodeMirror 6** (arch-spec choice): `codemirror` basic setup +
   `@codemirror/language-data` lazy per-language highlighting by filename.
2. **Chat file links wired + last-write-wins saves** — no conflict detection;
   the hub's existing `edited <path>` status-message logging covers the audit
   trail (pass the active thread id).

## What already exists (no backend changes needed)

- Daemon `FileService` `write` op — path-jailed to granted roots (step 5).
- Hub `POST /api/fs/:machine/write {path, content, threadId?}` — 503/504/422
  error conventions; when `threadId` is present, appends a `status` message
  `edited <path>` to that thread. **This sub-project is web-only.**

## Components (all in packages/web)

### deps

`codemirror` (bundles @codemirror/state/view/commands/language/basic-setup),
`@codemirror/language-data`. No other additions.

### `lib/hubClient.ts`

```ts
fsWrite: (machine: string, path: string, content: string, threadId?: string) =>
  req<{ ok?: boolean }>("POST", `/api/fs/${machine}/write`, { path, content, threadId }),
```

(The write route returns the FsResponse `result` — treat any 2xx as success;
non-2xx throws via `req`, message surfaced in the save notice.)

### `lib/fileLink.ts` (new, pure — unit-testable)

```ts
export interface FileTarget { machine: string; path: string; line?: number }
export function resolveFileLink(
  raw: string, // e.g. "payments/middleware/idem.ts:41" or "/abs/path.ts"
  ctx: {
    activeWorkspace?: { machine: string; folderPath: string };
    selectedMachine: string | null;
    machines: Array<{ machine: string }>;
  },
): FileTarget | null
```

- Split a trailing `:<digits>` into `line`.
- Absolute path (`/…`): used as-is. Relative: joined to
  `activeWorkspace.folderPath` when available; with no workspace, a relative
  path cannot be resolved → return null (link stays inert).
- Machine precedence: `activeWorkspace.machine` → `selectedMachine` → first of
  `machines` → null (inert).

### `store/useConclaveStore.ts`

- `fsDirty: boolean` (initial false) + `setFsDirty(v: boolean)`.
- `activeFsFile` gains an optional `line?: number` (carried by
  `setActiveFsFile` for scroll-to-line; existing callers unaffected).

### `components/FsFileView.tsx` (rewrite)

- CodeMirror 6 `EditorView` replacing the `<pre>`:
  - Extensions: `basicSetup`, a compartment-loaded language from
    `@codemirror/language-data` (`LanguageDescription.matchFilename`; none
    matched → plain), an update listener setting `fsDirty` when
    `doc !== loaded content`, a save keymap (`Mod-s`, preventDefault).
  - Theme: `EditorView.theme` referencing CSS variables (`--code-bg`,
    `--text-code`, `--sel-bg`, `--sel-text`, `--text-muted`, `--font-mono`) so
    both themes apply without new tokens.
- Header (existing idiom) gains: dirty dot (`●`, `--warn`, testid `fs-dirty`),
  `save` button (testid `fs-save`, disabled while clean or saving), transient
  notice (testid `fs-notice`): `saved ✓` (auto-clears ~2s) or
  `save failed: <message>` (persists until next save/edit).
- Save: `hubClient.fsWrite(file.machine, file.path, view.state.doc.toString(),
  activeThreadId ?? undefined)` → on success clear dirty + show saved; on
  throw show the error. Guard against double-save (in-flight flag).
- Load: existing `fsRead` flow; on success also `setFsDirty(false)` and, if
  `file.line`, dispatch a scroll (`EditorView.scrollIntoView` on the line's
  position, best-effort — out-of-range line clamps to doc end).
- Unmount/switch discards edits (documented limitation; guard below covers the
  deliberate file-open paths).

### Dirty guard (two call sites)

`FileTree` file-click and the chat-link handler both check
`useConclaveStore.getState().fsDirty` and abort unless
`window.confirm("discard unsaved changes?")`. Other navigation (threads,
terminals, artifacts, other rails) discards silently — documented, not an IDE.

### `components/ChatMessage.tsx`

The `file` segment's dead `<a>` becomes a real handler: `resolveFileLink(seg.path,
{activeWorkspace, selectedMachine, machines})`; null → render as today (inert);
otherwise dirty-guard then `setActiveFsFile({machine, path, line})`.
`activeWorkspace` = `workspacesById[activeWorkspaceId]` from the store.

## Error handling

- Save failure (daemon down 503, timeout 504, jail/fs error 422) → `save
  failed: <hub error message>`; buffer and dirty state untouched — user can
  retry.
- Read failure keeps the existing "(failed to read file)" state (editor not
  mounted → no accidental save of the error placeholder: save button hidden
  when the load failed).
- Unresolvable chat link (no workspace for a relative path, no machines) →
  link renders but does nothing (same as today).

## Testing

- `fileLink.test.ts`: pure-function matrix — line split, absolute vs relative,
  workspace/selected/first-machine precedence, null cases.
- `hubClient` fsWrite arg/URL shape (fetch stub).
- `FsFileView` (jsdom; CodeMirror's headless APIs work in jsdom — if a DOM gap
  appears (`getClientRects` etc.), stub minimally in test-setup and note it):
  load → edit via `view.dispatch` → dirty dot appears → save calls `fsWrite`
  with (machine, path, doc, activeThreadId) → `saved ✓`; failure path shows
  message and stays dirty; Mod-s triggers save; failed load hides save.
- Chat link: resolvable link calls `setActiveFsFile` with line; unresolvable
  stays inert; dirty-guard confirm aborts on cancel (mock `window.confirm`).
- **Honesty note:** highlighting fidelity and scroll-to-line visuals are
  eyeball-only (jsdom can't verify rendering); tests cover state and calls.
  Record the manual smoke (open a file from chat, edit, save, see the status
  message in-thread) as run/not-run.

## Out of scope

- LSP, search, multi-file, tabs-for-files; conflict detection/3-way merge;
  autosave; binary files; artifact-view editing; mobile layout (8.4).
