# Editor Save-Back Implementation Plan (step 8.3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only `FsFileView` into a CodeMirror 6 editor that saves through the existing daemon fs tunnel, and wire chat file links to open files in it.

**Architecture:** Web-only (the daemon `write` op and hub route with `edited <path>` status logging exist since step 5). Task 1 lays the data layer: `hubClient.fsWrite`, a pure `resolveFileLink` helper, store `fsDirty` + `activeFsFile.line`. Task 2 rewrites `FsFileView` around an `EditorView` (lazy language highlighting, CSS-variable theme, dirty/save/Mod-s/notice, scroll-to-line, `onViewReady` test seam). Task 3 brings chat links alive and adds the dirty guard to both deliberate file-open paths.

**Tech Stack:** `codemirror` (bundles state/view/commands/language/basic-setup) + `@codemirror/language-data`. Existing React/Zustand.

## Global Constraints

- Work on branch `feat/editor-save-back` (created in Task 1); merge to `main` with `--no-ff` after the whole plan.
- Web tests per-file: `npx pnpm --filter @conclave/web exec vitest run <path>`; NEVER the full web suite in foreground. `pnpm` not on PATH — `npx pnpm ...`. One heavy command at a time (~12 GB RAM machine).
- Tokens-only styling; the CodeMirror theme references CSS variables (`--code-bg`, `--text-code`, `--sel-bg`, `--sel-text`, `--text-muted`, `--font-mono`) — no hex.
- Last-write-wins: no conflict detection. Save passes `activeThreadId ?? undefined` so the hub logs `edited <path>` in-thread.
- Dirty guard ONLY on the two deliberate file-open paths (FileTree click, chat link) via `window.confirm("discard unsaved changes?")`; other navigation discards silently (documented spec limitation).
- Failed load (`"(failed to read file)"`) must HIDE the save affordance — never save the placeholder over a real file.
- CodeMirror-in-jsdom: add the guarded `Range` stubs below to `packages/web/src/test-setup.ts`; if CM throws on another missing DOM API, stub it minimally there and LIST the addition in your report.
- Commit message body ends with:
  `Claude-Session: https://claude.ai/code/session_01MJ8FKhtSEmDL7SuhNtRrGN`

Known-good jsdom stubs for CodeMirror (Task 2 adds them):

```ts
// CodeMirror 6 measures text with Range client rects, which jsdom lacks.
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  }
  if (!("getBoundingClientRect" in Range.prototype) || typeof document.createRange().getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
}
```

---

### Task 1: data layer — fsWrite, resolveFileLink, store fields

**Files:**
- Modify: `packages/web/src/lib/hubClient.ts` (add `fsWrite`)
- Create: `packages/web/src/lib/fileLink.ts`
- Modify: `packages/web/src/store/useConclaveStore.ts` (`fsDirty` + `setFsDirty`; `activeFsFile` gains `line?`)
- Test: `packages/web/src/lib/__tests__/fileLink.test.ts` (new), `packages/web/src/lib/__tests__/fsWrite.test.ts` (new)

**Interfaces:**
- Produces (Tasks 2–3 rely on exact names): `hubClient.fsWrite(machine: string, path: string, content: string, threadId?: string): Promise<{ ok?: boolean }>`; `resolveFileLink(raw, ctx): FileTarget | null` with `FileTarget = { machine: string; path: string; line?: number }` and `ctx = { activeWorkspace?: { machine: string; folderPath: string }; selectedMachine: string | null; machines: Array<{ machine: string }> }`; store `fsDirty: boolean`, `setFsDirty(v: boolean)`, `activeFsFile: { machine: string; path: string; line?: number } | null`.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/editor-save-back
```

- [ ] **Step 2: Write the failing tests**

`packages/web/src/lib/__tests__/fileLink.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveFileLink } from "../fileLink.js";

const ws = { machine: "m1", folderPath: "/home/me/proj" };
const ctx = (over: Partial<Parameters<typeof resolveFileLink>[1]> = {}) => ({
  activeWorkspace: ws, selectedMachine: null, machines: [{ machine: "m9" }], ...over,
});

describe("resolveFileLink", () => {
  it("splits a trailing :line and joins relative paths to the workspace folder", () => {
    expect(resolveFileLink("src/idem.ts:41", ctx())).toEqual({
      machine: "m1", path: "/home/me/proj/src/idem.ts", line: 41,
    });
  });

  it("keeps absolute paths as-is, no line when absent", () => {
    expect(resolveFileLink("/etc/conf/app.yaml", ctx())).toEqual({
      machine: "m1", path: "/etc/conf/app.yaml",
    });
  });

  it("machine precedence: workspace > selectedMachine > first machine", () => {
    expect(resolveFileLink("/a.ts", ctx())!.machine).toBe("m1");
    expect(resolveFileLink("/a.ts", ctx({ activeWorkspace: undefined, selectedMachine: "m5" }))!.machine).toBe("m5");
    expect(resolveFileLink("/a.ts", ctx({ activeWorkspace: undefined }))!.machine).toBe("m9");
  });

  it("returns null when unresolvable", () => {
    // relative path with no workspace
    expect(resolveFileLink("src/a.ts", ctx({ activeWorkspace: undefined }))).toBeNull();
    // no machine anywhere
    expect(resolveFileLink("/a.ts", { activeWorkspace: undefined, selectedMachine: null, machines: [] })).toBeNull();
  });

  it("does not treat a windows-style or malformed line suffix as a line", () => {
    expect(resolveFileLink("src/a.ts:abc", ctx())).toEqual({
      machine: "m1", path: "/home/me/proj/src/a.ts:abc",
    });
  });
});
```

`packages/web/src/lib/__tests__/fsWrite.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { hubClient } from "../hubClient.js";

describe("hubClient.fsWrite", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /api/fs/:machine/write with path, content, threadId", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await hubClient.fsWrite("m1", "/w/a.ts", "hello", "th-1");
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/fs/m1/write");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ path: "/w/a.ts", content: "hello", threadId: "th-1" });
  });

  it("throws on a non-2xx so callers can surface the failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 422 })));
    await expect(hubClient.fsWrite("m1", "/w/a.ts", "x")).rejects.toThrow();
  });
});
```

Also extend the store test (append to `packages/web/src/store/__tests__/terminals-store.test.ts` OR create a tiny `fs-store.test.ts` — implementer's choice, report which):

```ts
  it("fsDirty flag round-trips and resets", () => {
    useConclaveStore.getState().setFsDirty(true);
    expect(useConclaveStore.getState().fsDirty).toBe(true);
    useConclaveStore.getState().reset();
    expect(useConclaveStore.getState().fsDirty).toBe(false);
  });

  it("setActiveFsFile carries an optional line", () => {
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/a.ts", line: 41 });
    expect(useConclaveStore.getState().activeFsFile?.line).toBe(41);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/fileLink.test.ts src/lib/__tests__/fsWrite.test.ts`
Expected: FAIL — module/method missing.

- [ ] **Step 4: Implement**

`packages/web/src/lib/fileLink.ts`:

```ts
export interface FileTarget {
  machine: string;
  path: string;
  line?: number;
}

export interface FileLinkCtx {
  activeWorkspace?: { machine: string; folderPath: string };
  selectedMachine: string | null;
  machines: Array<{ machine: string }>;
}

// Resolve a chat file reference ("src/a.ts:41" or "/abs/b.ts") to a concrete
// machine + absolute path. Returns null when the reference cannot be resolved
// (relative path with no active workspace, or no known machine) — the link
// then stays inert.
export function resolveFileLink(raw: string, ctx: FileLinkCtx): FileTarget | null {
  const m = raw.match(/^(.*?):(\d+)$/);
  const pathPart = m ? m[1]! : raw;
  const line = m ? Number(m[2]) : undefined;

  let path: string;
  if (pathPart.startsWith("/")) {
    path = pathPart;
  } else if (ctx.activeWorkspace) {
    path = `${ctx.activeWorkspace.folderPath.replace(/\/$/, "")}/${pathPart}`;
  } else {
    return null;
  }

  const machine =
    ctx.activeWorkspace?.machine ?? ctx.selectedMachine ?? ctx.machines[0]?.machine;
  if (!machine) return null;

  return line === undefined ? { machine, path } : { machine, path, line };
}
```

`packages/web/src/lib/hubClient.ts` — add after `fsRead`:

```ts
  fsWrite: (machine: string, path: string, content: string, threadId?: string) =>
    req<{ ok?: boolean }>("POST", `/api/fs/${machine}/write`, { path, content, threadId }),
```

`packages/web/src/store/useConclaveStore.ts`:
- `State`: `activeFsFile: { machine: string; path: string; line?: number } | null;` (extend the existing type in place), `fsDirty: boolean;`, `setFsDirty(v: boolean): void;`
- `initial`: `fsDirty: false,`
- actions: `setFsDirty: (v) => set({ fsDirty: v }),` — and `setActiveFsFile` needs no change beyond the widened type (it stores what it's given). Also make each activation setter that nulls `activeFsFile` ALSO clear `fsDirty` (`setActiveThread`, `setActiveArtifact`, `setActiveTerminal` when activating): add `fsDirty: false` to those set objects — a discarded editor must not leave a stale dirty flag that later triggers a bogus confirm.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/fileLink.test.ts src/lib/__tests__/fsWrite.test.ts src/store/__tests__/` then `npx pnpm -r typecheck`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): fsWrite client, file-link resolver, fsDirty store state"
```

---

### Task 2: FsFileView → CodeMirror editor with save

**Files:**
- Modify: `packages/web/package.json` (deps: `"codemirror": "^6.0.1"`, `"@codemirror/language-data": "^6.5.1"`, and — required because pnpm's strict node_modules won't resolve undeclared transitive imports — `"@codemirror/state": "^6.5.0"`, `"@codemirror/view": "^6.36.0"` for the direct `keymap`/`Compartment` imports)
- Modify: `packages/web/src/test-setup.ts` (the guarded Range stubs from Global Constraints)
- Rewrite: `packages/web/src/components/FsFileView.tsx`
- Modify: `packages/web/src/components/FsFileView.module.css` (header additions; `.body` becomes the editor host)
- Test: `packages/web/src/components/__tests__/FsFileView.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's `hubClient.fsWrite`, store `fsDirty`/`setFsDirty`, `activeFsFile.line`, existing `hubClient.fsRead`, `activeThreadId`.
- Produces: `FsFileView` props gain `onViewReady?: (view: EditorView) => void` (test seam; unused in production). Testids: `fs-dirty`, `fs-save`, `fs-notice`, `fs-editor` (the CM host div).

- [ ] **Step 1: Add deps + stubs**

Add the two deps to `packages/web/package.json`, run `npx pnpm install` from the repo root. Append the guarded Range stubs (Global Constraints block) to `packages/web/src/test-setup.ts`.

- [ ] **Step 2: Write the failing test**

`packages/web/src/components/__tests__/FsFileView.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EditorView } from "codemirror";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const mocks = vi.hoisted(() => ({
  fsRead: vi.fn(async () => ({ content: "hello world" })),
  fsWrite: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/hubClient.js", () => ({ hubClient: mocks }));

import { FsFileView } from "../FsFileView.js";

function openFile(line?: number): void {
  const s = useConclaveStore.getState();
  s.reset();
  s.setActiveFsFile({ machine: "m1", path: "/w/a.ts", ...(line ? { line } : {}) });
}

async function renderWithView(): Promise<EditorView> {
  let view: EditorView | undefined;
  render(<FsFileView onViewReady={(v) => (view = v)} />);
  await waitFor(() => expect(view).toBeDefined());
  return view!;
}

function type(view: EditorView, text: string): void {
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  });
}

describe("FsFileView editor", () => {
  beforeEach(() => {
    mocks.fsRead.mockClear();
    mocks.fsWrite.mockClear();
    mocks.fsRead.mockResolvedValue({ content: "hello world" });
  });

  it("loads the file into the editor; clean state (no dirty dot, save disabled)", async () => {
    openFile();
    const view = await renderWithView();
    expect(view.state.doc.toString()).toBe("hello world");
    expect(screen.queryByTestId("fs-dirty")).toBeNull();
    expect((screen.getByTestId("fs-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("editing sets the dirty dot + store flag; save writes and clears", async () => {
    openFile();
    const s = useConclaveStore.getState();
    s.setActiveThread("th-1");
    s.setActiveFsFile({ machine: "m1", path: "/w/a.ts" }); // thread switch cleared it
    const view = await renderWithView();
    type(view, "!");
    expect(screen.getByTestId("fs-dirty")).toBeInTheDocument();
    expect(useConclaveStore.getState().fsDirty).toBe(true);

    await userEvent.click(screen.getByTestId("fs-save"));
    await waitFor(() => expect(mocks.fsWrite).toHaveBeenCalledWith("m1", "/w/a.ts", "hello world!", "th-1"));
    await waitFor(() => expect(screen.getByTestId("fs-notice").textContent).toContain("saved"));
    expect(useConclaveStore.getState().fsDirty).toBe(false);
    expect(screen.queryByTestId("fs-dirty")).toBeNull();
  });

  it("save failure shows the error and stays dirty", async () => {
    mocks.fsWrite.mockRejectedValueOnce(new Error("hub POST /api/fs/m1/write -> 422"));
    openFile();
    const view = await renderWithView();
    type(view, "!");
    await userEvent.click(screen.getByTestId("fs-save"));
    await waitFor(() => expect(screen.getByTestId("fs-notice").textContent).toContain("save failed"));
    expect(useConclaveStore.getState().fsDirty).toBe(true);
  });

  it("failed load hides the save affordance entirely", async () => {
    mocks.fsRead.mockRejectedValueOnce(new Error("nope"));
    openFile();
    render(<FsFileView />);
    await waitFor(() => expect(screen.getByText("(failed to read file)")).toBeInTheDocument());
    expect(screen.queryByTestId("fs-save")).toBeNull();
  });

  it("scrolls/selects the requested line on load", async () => {
    mocks.fsRead.mockResolvedValueOnce({ content: "l1\nl2\nl3\nl4" });
    openFile(3);
    const view = await renderWithView();
    await waitFor(() => {
      expect(view.state.selection.main.from).toBe(view.state.doc.line(3).from);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/FsFileView.test.tsx`
Expected: FAIL — no `onViewReady`, no editor, no testids.

- [ ] **Step 4: Implement**

`packages/web/src/components/FsFileView.tsx` (full rewrite):

```tsx
import { useEffect, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { hubClient } from "../lib/hubClient.js";
import styles from "./FsFileView.module.css";

const cmTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--code-bg)",
    color: "var(--text-code)",
    fontSize: "11.5px",
    height: "100%",
  },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--text-primary)" },
  ".cm-gutters": {
    backgroundColor: "var(--code-bg)",
    color: "var(--text-muted)",
    border: "none",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--sel-bg)",
  },
  "&.cm-focused .cm-selectionBackground *": { color: "var(--sel-text)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

export function FsFileView({ onViewReady }: { onViewReady?: (v: EditorView) => void }): JSX.Element | null {
  const file = useConclaveStore((s) => s.activeFsFile);
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const setFsDirty = useConclaveStore((s) => s.setFsDirty);
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [failed, setFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const markDirty = (v: boolean): void => {
    setDirty(v);
    setFsDirty(v);
  };

  const save = async (): Promise<void> => {
    const view = viewRef.current;
    if (!view || !file || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await hubClient.fsWrite(file.machine, file.path, view.state.doc.toString(), activeThreadId ?? undefined);
      markDirty(false);
      setNotice("saved ✓");
      setTimeout(() => setNotice(null), 2000);
    } catch (e) {
      setNotice(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!file || !host.current) return;
    let disposed = false;
    setFailed(false);
    setNotice(null);
    markDirty(false);

    void hubClient
      .fsRead(file.machine, file.path)
      .then(async (r) => {
        if (disposed || !host.current) return;
        const langCompartment = new Compartment();
        const view = new EditorView({
          doc: r.content,
          parent: host.current,
          extensions: [
            basicSetup,
            cmTheme,
            langCompartment.of([]),
            keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { void saveRef.current(); return true; } }]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) markDirty(true);
            }),
          ],
        });
        viewRef.current = view;

        const name = file.path.split("/").pop() ?? "";
        const desc = languages.find((l) => l.extensions.some((ext) => name.endsWith(`.${ext}`)));
        if (desc) {
          void desc.load().then((support) => {
            if (viewRef.current === view) view.dispatch({ effects: langCompartment.reconfigure(support) });
          });
        }

        if (file.line) {
          const line = Math.max(1, Math.min(file.line, view.state.doc.lines));
          const pos = view.state.doc.line(line).from;
          view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
        }
        onViewReady?.(view);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.machine, file?.path]);

  if (!file) return null;

  return (
    <div className={styles.view} data-testid="fs-file-view">
      <div className={styles.header}>
        <span className={styles.path}>{file.path}</span>
        {dirty && <span className={styles.dirty} data-testid="fs-dirty">●</span>}
        {notice && <span className={styles.notice} data-testid="fs-notice">{notice}</span>}
        {!failed && (
          <button
            className={styles.save}
            data-testid="fs-save"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            save
          </button>
        )}
        <span className={styles.machine}>{file.machine}</span>
      </div>
      {failed ? (
        <pre className={styles.body}>(failed to read file)</pre>
      ) : (
        <div className={styles.editor} data-testid="fs-editor" ref={host} />
      )}
    </div>
  );
}
```

Notes for the implementer:
- `markDirty` is called during the initial effect (before the view exists) to reset state on file switch — safe.
- The `languages.find` uses `LanguageDescription.extensions`; `matchFilename` also exists — either is acceptable, keep the extension match simple.
- `type` in the test dispatches changes directly; the update listener fires synchronously.

`packages/web/src/components/FsFileView.module.css` — keep `.view/.header/.path/.machine/.body`, add:

```css
.editor {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--code-bg);
}
.dirty {
  color: var(--warn);
  font-size: 10px;
}
.notice {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-secondary);
}
.save {
  background: none;
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 1px 10px;
  cursor: pointer;
}
.save:hover:not(:disabled) {
  color: var(--text-primary);
}
.save:disabled {
  opacity: 0.4;
  cursor: default;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/FsFileView.test.tsx`
Expected: PASS (5/5). If CodeMirror throws on a missing jsdom API, add a minimal guarded stub to test-setup.ts and list it in your report.

- [ ] **Step 6: Typecheck + build + commit**

Run: `npx pnpm -r typecheck`, then `npx pnpm --filter @conclave/web build` (CM bundles fine; language-data chunks load lazily).

```bash
git add packages/web pnpm-lock.yaml
git commit -m "feat(web): CodeMirror editor with save-back in FsFileView"
```

---

### Task 3: live chat file links + dirty guards + docs

**Files:**
- Modify: `packages/web/src/components/ChatMessage.tsx` (file segment handler)
- Modify: `packages/web/src/components/FileTree.tsx` (dirty guard on file click)
- Modify: `docs/DEPLOY.md` (one line: editor writes are logged in-thread; unsaved edits discard on navigation)
- Test: `packages/web/src/components/__tests__/FileLinks.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's `resolveFileLink` + store fields; Task 2's editor (opened via `setActiveFsFile`).
- Produces: clickable chat file links (testid unchanged — the existing `.file` anchor); guarded opens.

- [ ] **Step 1: Write the failing test**

`packages/web/src/components/__tests__/FileLinks.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessage } from "../ChatMessage.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

const msg = (body: string) => ({
  id: 1, threadId: "th-1", from: "codex", to: ["you"], type: "text" as const,
  body, artifacts: [], ts: "2026-07-17T12:00:00.000Z",
});

function seedWorkspace(): void {
  const s = useConclaveStore.getState();
  s.reset();
  s.applyFrame({
    type: "workspace",
    workspace: { id: "w1", name: "proj", machine: "m1", folderPath: "/home/me/proj", createdAt: "2026-07-17T00:00:00.000Z" },
  });
  s.setActiveWorkspace("w1");
}

describe("chat file links", () => {
  beforeEach(seedWorkspace);
  afterEach(() => vi.restoreAllMocks());

  it("clicking a resolvable link opens the file with its line", async () => {
    render(<ChatMessage message={msg("see src/idem.ts:41 for the fix")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(useConclaveStore.getState().activeFsFile).toEqual({
      machine: "m1", path: "/home/me/proj/src/idem.ts", line: 41,
    });
  });

  it("an unresolvable link stays inert", async () => {
    useConclaveStore.getState().reset(); // no workspace, no machines
    render(<ChatMessage message={msg("see src/idem.ts:41")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(useConclaveStore.getState().activeFsFile).toBeNull();
  });

  it("dirty guard: cancel keeps the current file", async () => {
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/other.ts" });
    useConclaveStore.getState().setFsDirty(true);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ChatMessage message={msg("see src/idem.ts:41")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(window.confirm).toHaveBeenCalled();
    expect(useConclaveStore.getState().activeFsFile?.path).toBe("/other.ts");
  });

  it("dirty guard: confirm proceeds", async () => {
    useConclaveStore.getState().setFsDirty(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ChatMessage message={msg("see src/idem.ts:41")} />);
    await userEvent.click(screen.getByText("src/idem.ts:41"));
    expect(useConclaveStore.getState().activeFsFile?.path).toBe("/home/me/proj/src/idem.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/FileLinks.test.tsx`
Expected: FAIL — link is inert (`preventDefault` only).

- [ ] **Step 3: Implement**

`packages/web/src/components/ChatMessage.tsx`:
- Add imports: `import { resolveFileLink } from "../lib/fileLink.js";`
- Add a helper (module scope):

```tsx
function openFileLink(raw: string): void {
  const s = useConclaveStore.getState();
  const target = resolveFileLink(raw, {
    activeWorkspace: s.activeWorkspaceId ? s.workspacesById[s.activeWorkspaceId] : undefined,
    selectedMachine: s.selectedMachine,
    machines: s.machines,
  });
  if (!target) return;
  if (s.fsDirty && !window.confirm("discard unsaved changes?")) return;
  s.setActiveFsFile(target);
}
```

- The `file` case in `Inline` becomes:

```tsx
    case "file":
      return (
        <a
          className={styles.file}
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openFileLink(seg.path);
          }}
        >
          {seg.path}
        </a>
      );
```

(`workspacesById[...]` has `machine` and `folderPath` — the Workspace shape satisfies `FileLinkCtx.activeWorkspace` structurally.)

`packages/web/src/components/FileTree.tsx` — the file-click becomes guarded:

```tsx
      <button
        className={styles.file}
        onClick={() => {
          const s = useConclaveStore.getState();
          if (s.fsDirty && !window.confirm("discard unsaved changes?")) return;
          setActiveFsFile({ machine, path });
        }}
      >
```

`docs/DEPLOY.md` — under the Files/registry area (after the registry example's notes), add:

```markdown
> **Editing files:** the web file viewer is an editor — saves write through the
> daemon (jailed to granted roots) and are logged as an `edited <path>` status
> message in the active thread. Unsaved edits are discarded when you navigate
> away (the file tree and chat links warn; other navigation doesn't).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/FileLinks.test.tsx src/components/__tests__/FsFileView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full checks, commit**

In order: `npx pnpm -r typecheck`; full web suite backgrounded (`timeout 180 npx pnpm --filter @conclave/web exec vitest run > /tmp/web-suite.log 2>&1; grep -E "Test Files|Tests " /tmp/web-suite.log`); `npx vitest run` (full backend — untouched); `npx pnpm --filter @conclave/web build`.

```bash
git add packages/web docs/DEPLOY.md
git commit -m "feat(web): live chat file links with dirty guard; document editor save-back"
```

---

## Coverage vs spec (self-check)

- fsWrite client + resolveFileLink (line split, precedence, null cases) + store fields incl. fsDirty cleared by other activation setters: Task 1. CodeMirror editor (lazy language, CSS-var theme, dirty/save/Mod-s/notice, in-flight guard, scroll-to-line clamp, failed-load hides save, onViewReady seam, jsdom Range stubs): Task 2. Chat links + FileTree dirty guards + DEPLOY.md line: Task 3.
- Spec's error-handling walked line-by-line: save 503/504/422 → notice, stays dirty (T2 test); read failure → placeholder + no save (T2 test); unresolvable link inert (T1+T3 tests). ✓ (lesson from 7.1 applied.)
- Honesty: highlighting/scroll visuals + the in-thread `edited <path>` message are manual smoke — record run/not-run at finish.
