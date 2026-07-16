# Teal Theme + Switcher Implementation Plan (step 8.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the handoff's Teal theme as a complete token set with a persisted Black/Teal switcher in a new Settings modal, applied before first paint.

**Architecture:** Restructure `tokens.css` into a shared base `:root` block plus per-theme `:root[data-theme=…]` blocks; add role tokens (`--accent`, mention/inline-code/file-link/badge) and repoint the components that used selection/usage tokens for accent/text roles. A tiny `lib/theme.ts` owns apply/persist/read; the store exposes `theme`/`setTheme`; an inline `<head>` script prevents theme flash; a gear-opened `SettingsModal` hosts the segmented control.

**Tech Stack:** Pure CSS variables + existing React/Zustand/lucide-react. No new dependencies.

## Global Constraints

- Work on branch `feat/teal-theme` (created in Task 1); merge to `main` with `--no-ff` after the whole plan.
- Web tests: `npx pnpm --filter @conclave/web exec vitest run <path relative to packages/web>`; NEVER the full web suite in foreground (hangs on teardown — background + grep + kill). Backend suites unaffected but run `npx vitest run` once at the end (Task 4). `pnpm` not on PATH — `npx pnpm ...`.
- **MEMORY: ~12 GB RAM machine.** One heavy command at a time.
- Token values are EXACT per the spec's table (docs/superpowers/specs/2026-07-16-teal-theme-design.md) — handoff values verbatim; the four interpolated values (`--border-2`, `--hover`, `--chip`, `--artifact-ticket` teal) as specified there.
- Shared tokens (8 `--agent-*` pairs, `--live`, `--blocked`, `--warn`, `--danger`, `--font-sans`, `--font-mono`) live ONLY in base `:root`; every other token must be defined in BOTH theme blocks.
- localStorage key: `"conclave-theme"`; allowed values `"black" | "teal"`; anything else → `"black"`.
- The sidebar icon rail is a HORIZONTAL strip (top of sidebar) — the gear goes right-aligned at its end (`margin-left: auto`), an approved adaptation of the spec's "bottom of the rail".
- Commit message body ends with:
  `Claude-Session: https://claude.ai/code/session_01MJ8FKhtSEmDL7SuhNtRrGN`

---

### Task 1: tokens.css restructure + token-parity test

**Files:**
- Modify: `packages/web/src/styles/tokens.css` (full rewrite, content below)
- Test: `packages/web/src/styles/__tests__/tokens.test.ts` (new)

**Interfaces:**
- Produces: base `:root` + `:root[data-theme="black"]` + `:root[data-theme="teal"]` blocks; new tokens `--accent`, `--mention-bg`, `--mention-text`, `--inline-code-text`, `--file-link`, `--badge-text` (both themes). Task 2 repoints components to these; Task 3's theme map uses `--surface` values `#0d0d0d` (black) / `#131918` (teal).

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/teal-theme
```

- [ ] **Step 2: Write the failing test**

`packages/web/src/styles/__tests__/tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

function block(selector: string): string {
  // Base ":root" must not match the ":root[data-theme=…]" selectors — anchor
  // it on "{" immediately following ":root".
  const re =
    selector === ":root"
      ? /^:root\s*\{([^}]*)\}/m
      : new RegExp(selector.replace(/[[\]"]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "m");
  const m = css.match(re);
  if (!m) throw new Error(`block not found: ${selector}`);
  return m[1]!;
}

function tokenNames(body: string): string[] {
  return [...body.matchAll(/--[\w-]+(?=\s*:)/g)].map((m) => m[0]).sort();
}

const SHARED = [
  "--agent-claude-code", "--agent-claude-code-text", "--agent-codex", "--agent-codex-text",
  "--agent-default", "--agent-default-text", "--agent-reviewer", "--agent-reviewer-text",
  "--blocked", "--danger", "--font-mono", "--font-sans", "--live", "--warn",
].sort();

describe("theme token structure", () => {
  it("defines the shared tokens once, in base :root only", () => {
    expect(tokenNames(block(":root"))).toEqual(SHARED);
    for (const theme of ["black", "teal"]) {
      const names = tokenNames(block(`:root[data-theme="${theme}"]`));
      for (const s of SHARED) expect(names).not.toContain(s);
    }
  });

  it("teal defines exactly the same token names as black", () => {
    expect(tokenNames(block(':root[data-theme="teal"]'))).toEqual(
      tokenNames(block(':root[data-theme="black"]')),
    );
  });

  it("includes the new role tokens in both themes", () => {
    for (const theme of ["black", "teal"]) {
      const names = tokenNames(block(`:root[data-theme="${theme}"]`));
      for (const t of ["--accent", "--mention-bg", "--mention-text", "--inline-code-text", "--file-link", "--badge-text"]) {
        expect(names).toContain(t);
      }
    }
  });

  it("pins the headline teal values", () => {
    const teal = block(':root[data-theme="teal"]');
    expect(teal).toContain("--surface: #131918");
    expect(teal).toContain("--accent: #2dd4bf");
    expect(teal).toContain("--sel-bg: #124e46");
    expect(teal).toContain("--usage-normal: #2dd4bf");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/styles/__tests__/tokens.test.ts`
Expected: FAIL — today's tokens.css has a single `:root[data-theme="black"]` block; no base `:root`, no teal block.

- [ ] **Step 4: Rewrite tokens.css**

Full new content of `packages/web/src/styles/tokens.css`:

```css
/* Shared across all themes: agent identity, status signals, fonts (handoff:
   "Agent identity colors, status colors and usage-bar severity gradients are
   shared across both themes"). Everything else is per-theme below. */
:root {
  --live: #2dd4bf;
  --blocked: #facc15;
  --warn: #f2a65a;
  --danger: #f87171;

  --agent-claude-code: #e8a06a;
  --agent-claude-code-text: #1a0f06;
  --agent-codex: #7dd3fc;
  --agent-codex-text: #06121a;
  --agent-reviewer: #c4b5fd;
  --agent-reviewer-text: #120a1f;
  --agent-default: #8a8a8a;
  --agent-default-text: #0a0a0a;

  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}

:root[data-theme="black"] {
  --chrome: #000000;
  --surface: #0d0d0d;
  --rail: #050505;
  --card: #0d0d0d;
  --border-strong: #333333;
  --border: #1f1f1f;
  --border-2: #262626;
  --hairline: #1a1a1a;
  --hover: #171717;
  --chip: #1f1f1f;

  --text-primary: #f5f5f5;
  --text-body: #c9c9c9;
  --text-secondary: #8a8a8a;
  --text-secondary-2: #737373;
  --text-muted: #555555;
  --text-code: #a3a3a3;
  --code-bg: #000000;
  --inline-code-bg: #171717;

  --usage-normal: #d4d4d4;

  --sel-bg: #f5f5f5;
  --sel-text: #0a0a0a;
  --accent: #f5f5f5;

  --mention-bg: #1f1f1f;
  --mention-text: #f5f5f5;
  --inline-code-text: #e5e5e5;
  --file-link: currentColor;
  --badge-text: #d4d4d4;

  --artifact-plan: #f28b82;
  --artifact-ticket: #fbbf24;
}

:root[data-theme="teal"] {
  --chrome: #0e1312;
  --surface: #131918;
  --rail: #101615;
  --card: #0f1514;
  --border-strong: #2a3a37;
  --border: #243230;
  --border-2: #243230;
  --hairline: #1c2624;
  --hover: #18211f;
  --chip: #1c2624;

  --text-primary: #e6edeb;
  --text-body: #c9d4d1;
  --text-secondary: #93a5a1;
  --text-secondary-2: #7c8c88;
  --text-muted: #5f6f6c;
  --text-code: #8fb5ac;
  --code-bg: #0e1312;
  --inline-code-bg: transparent;

  --usage-normal: #2dd4bf;

  --sel-bg: #124e46;
  --sel-text: #eafffb;
  --accent: #2dd4bf;

  --mention-bg: transparent;
  --mention-text: #2dd4bf;
  --inline-code-text: #5eead4;
  --file-link: #2dd4bf;
  --badge-text: #93a5a1;

  --artifact-plan: #5eead4;
  --artifact-ticket: #5eead4;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/styles/__tests__/tokens.test.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Sanity-check nothing broke, commit**

Run: `npx pnpm -r typecheck`, then a quick representative web test file (e.g. `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/TerminalsSection.test.tsx`) — CSS-only change, nothing should move.

```bash
git add packages/web/src/styles
git commit -m "feat(web): base/theme token split with the full Teal palette"
```

---

### Task 2: component role fixes (accent split, mention/inline-code/file/badge, leak cleanup) + no-hex regression test

**Files:**
- Modify: `packages/web/src/components/SessionTabs.module.css` (active-tab border → `--accent`)
- Modify: `packages/web/src/components/Sidebar.module.css` (rail active underline → `--accent`)
- Modify: `packages/web/src/components/StatusStrip.module.css` (status progress fill → `--accent`)
- Modify: `packages/web/src/components/ChatMessage.module.css` (mention/inlineCode/file/badge role tokens)
- Modify: `packages/web/src/components/WindowStrip.module.css` (`#e5e5e5` → `var(--text-body)`)
- Test: `packages/web/src/styles/__tests__/no-hex-in-components.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's tokens (`--accent`, `--mention-bg`, `--mention-text`, `--inline-code-text`, `--file-link`, `--badge-text`).
- Produces: components fully theme-clean; a regression test that fails on any future hex literal in component CSS.

- [ ] **Step 1: Write the failing regression test**

`packages/web/src/styles/__tests__/no-hex-in-components.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentsDir = fileURLToPath(new URL("../../components", import.meta.url));

describe("component CSS uses tokens, not hex literals", () => {
  it("no hex colors in any *.module.css", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(componentsDir).filter((f) => f.endsWith(".module.css"))) {
      const css = readFileSync(join(componentsDir, f), "utf8");
      for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/styles/__tests__/no-hex-in-components.test.ts`
Expected: FAIL listing exactly `ChatMessage.module.css: #e5e5e5` and `WindowStrip.module.css: #e5e5e5`. (If it lists more, those are additional leaks — fix them the same way and note them in your report.)

- [ ] **Step 3: Apply the role fixes**

- `SessionTabs.module.css` line ~24: `border-top-color: var(--sel-bg);` → `border-top-color: var(--accent);`
- `Sidebar.module.css` line ~23 (rail active underline): `border-bottom: 2px solid var(--sel-bg);` → `border-bottom: 2px solid var(--accent);`
- `StatusStrip.module.css` line ~70 (status-card progress fill): `background: var(--sel-bg);` → `background: var(--accent);`
  (Do NOT touch the `--usage-normal` usage-bar fill at line ~108 — that token is themed separately.)
- `ChatMessage.module.css`:
  - `.badge` line ~25: `color: var(--usage-normal);` → `color: var(--badge-text);`
  - `.mention`: `background: var(--chip);` → `background: var(--mention-bg);` and `color: var(--text-primary);` → `color: var(--mention-text);`
  - `.inlineCode`: `color: #e5e5e5;` → `color: var(--inline-code-text);` (keep `background: var(--inline-code-bg);`)
  - `.file`: `color: inherit;` → `color: var(--file-link);`
- `WindowStrip.module.css` line ~54: `color: #e5e5e5;` → `color: var(--text-body);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/styles/__tests__/no-hex-in-components.test.ts src/styles/__tests__/tokens.test.ts`
Expected: PASS. Also run the ChatMessage/SessionTabs-related test files if any exist (`ls packages/web/src/components/__tests__/`) — class-name-only changes, nothing should break.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -m "fix(web): repoint accent/mention/code/badge roles to theme tokens; drop hex leaks"
```

---

### Task 3: theme lib + store + no-flash boot

**Files:**
- Create: `packages/web/src/lib/theme.ts`
- Modify: `packages/web/src/store/useConclaveStore.ts` (theme state + setTheme)
- Modify: `packages/web/index.html` (inline no-flash script)
- Modify: `packages/web/src/main.tsx` (apply stored theme at boot)
- Test: `packages/web/src/lib/__tests__/theme.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 4 relies on): `Theme = "black" | "teal"`; `readStoredTheme(): Theme`; `applyTheme(t: Theme): void` (sets `document.documentElement.dataset.theme`, persists to `localStorage["conclave-theme"]`, updates `<meta name="theme-color">`); store `theme: Theme` + `setTheme(t: Theme): void`.

- [ ] **Step 1: Write the failing tests**

`packages/web/src/lib/__tests__/theme.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, readStoredTheme, THEME_SURFACE } from "../theme.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

function meta(): HTMLMetaElement {
  let el = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement("meta");
    el.name = "theme-color";
    document.head.appendChild(el);
  }
  return el;
}

describe("theme apply/persist/read", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "black";
    meta().content = "#0d0d0d";
  });

  it("applyTheme sets data-theme, persists, and updates the meta tag", () => {
    applyTheme("teal");
    expect(document.documentElement.dataset.theme).toBe("teal");
    expect(localStorage.getItem("conclave-theme")).toBe("teal");
    expect(meta().content).toBe(THEME_SURFACE.teal);
  });

  it("readStoredTheme defaults to black on missing or garbage values", () => {
    expect(readStoredTheme()).toBe("black");
    localStorage.setItem("conclave-theme", "mauve");
    expect(readStoredTheme()).toBe("black");
    localStorage.setItem("conclave-theme", "teal");
    expect(readStoredTheme()).toBe("teal");
  });

  it("store setTheme updates state and applies", () => {
    useConclaveStore.getState().setTheme("teal");
    expect(useConclaveStore.getState().theme).toBe("teal");
    expect(document.documentElement.dataset.theme).toBe("teal");
    useConclaveStore.getState().setTheme("black");
    expect(useConclaveStore.getState().theme).toBe("black");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/theme.test.ts`
Expected: FAIL — module not found / `setTheme` undefined.

- [ ] **Step 3: Implement**

`packages/web/src/lib/theme.ts`:

```ts
export type Theme = "black" | "teal";

const KEY = "conclave-theme";
const THEMES: Theme[] = ["black", "teal"];

// Meta theme-color must match each theme's --surface. jsdom can't resolve CSS
// variables from stylesheets, and the browser needs the value before styles
// settle anyway, so the surface colors are mirrored here (source of truth:
// tokens.css — the token-parity test pins the teal value).
export const THEME_SURFACE: Record<Theme, string> = {
  black: "#0d0d0d",
  teal: "#131918",
};

export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v as Theme) ? (v as Theme) : "black";
  } catch {
    return "black";
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode — session-only theming */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_SURFACE[t]);
}
```

`packages/web/src/store/useConclaveStore.ts`:
- import: `import { applyTheme, readStoredTheme, type Theme } from "../lib/theme.js";`
- `State` gains: `theme: Theme;` and `setTheme(t: Theme): void;`
- `initial` gains: `theme: readStoredTheme() as Theme,`
- action:

```ts
  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
  },
```

`packages/web/index.html` — inside `<head>`, immediately after the `<meta name="theme-color" …>` line, add:

```html
    <script>
      // Apply the persisted theme before first paint (default stays the
      // data-theme="black" attribute above for no-JS / first visit).
      try {
        var t = localStorage.getItem("conclave-theme");
        if (t === "teal" || t === "black") document.documentElement.dataset.theme = t;
      } catch (e) {}
    </script>
```

`packages/web/src/main.tsx` — after the CSS imports, before `createRoot`:

```ts
import { applyTheme, readStoredTheme } from "./lib/theme.js";

applyTheme(readStoredTheme());
```

(This re-applies what the inline script did AND syncs the meta tag for a stored
teal theme at boot.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/theme.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Typecheck + build, commit**

Run: `npx pnpm -r typecheck`, then `npx pnpm --filter @conclave/web build` (the inline script must not break the Vite HTML transform).

```bash
git add packages/web
git commit -m "feat(web): theme state with persisted no-flash boot and dynamic theme-color"
```

---

### Task 4: SettingsModal + gear button + final checks

**Files:**
- Create: `packages/web/src/components/SettingsModal.tsx`, `packages/web/src/components/SettingsModal.module.css`
- Modify: `packages/web/src/components/Sidebar.tsx` (gear at the right end of the rail), `packages/web/src/components/Sidebar.module.css` (spacer style if needed)
- Test: `packages/web/src/components/__tests__/SettingsModal.test.tsx` (new)

**Interfaces:**
- Consumes: store `theme`/`setTheme` (Task 3).
- Produces: gear button (testid `settings-open`) → modal (testid `settings-modal`) with segmented control (testids `theme-black` / `theme-teal`).

- [ ] **Step 1: Write the failing test**

`packages/web/src/components/__tests__/SettingsModal.test.tsx`:

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../Sidebar.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

describe("settings modal / theme switcher", () => {
  beforeEach(() => {
    localStorage.clear();
    useConclaveStore.getState().reset();
    useConclaveStore.getState().setTheme("black");
  });

  it("gear opens the modal; segmented control reflects and switches the theme", async () => {
    render(<Sidebar />);
    expect(screen.queryByTestId("settings-modal")).toBeNull();
    await userEvent.click(screen.getByTestId("settings-open"));
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    expect(screen.getByTestId("theme-black")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByTestId("theme-teal"));
    expect(useConclaveStore.getState().theme).toBe("teal");
    expect(document.documentElement.dataset.theme).toBe("teal");
    expect(screen.getByTestId("theme-teal")).toHaveAttribute("aria-pressed", "true");
  });

  it("closes on Escape and on backdrop click", async () => {
    render(<Sidebar />);
    await userEvent.click(screen.getByTestId("settings-open"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("settings-modal")).toBeNull();

    await userEvent.click(screen.getByTestId("settings-open"));
    await userEvent.click(screen.getByTestId("settings-backdrop"));
    expect(screen.queryByTestId("settings-modal")).toBeNull();
  });
});
```

If rendering `<Sidebar />` bare trips over missing store data, seed the minimum the existing Sidebar tests seed (check `src/components/__tests__/` for the established pattern) — the assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/SettingsModal.test.tsx`
Expected: FAIL — no `settings-open` testid.

- [ ] **Step 3: Implement**

`packages/web/src/components/SettingsModal.tsx`:

```tsx
import { useEffect } from "react";
import type { Theme } from "../lib/theme.js";
import { useConclaveStore } from "../store/useConclaveStore.js";
import styles from "./SettingsModal.module.css";

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const theme = useConclaveStore((s) => s.theme);
  const setTheme = useConclaveStore((s) => s.setTheme);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const seg = (t: Theme, label: string): JSX.Element => (
    <button
      data-testid={`theme-${t}`}
      className={theme === t ? styles.segActive : styles.seg}
      aria-pressed={theme === t}
      onClick={() => setTheme(t)}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.backdrop} data-testid="settings-backdrop" onClick={onClose}>
      <div className={styles.modal} data-testid="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>settings</div>
        <div className={styles.row}>
          <span className={styles.label}>color scheme</span>
          <span className={styles.segmented}>
            {seg("black", "Black")}
            {seg("teal", "Teal")}
          </span>
        </div>
      </div>
    </div>
  );
}
```

`packages/web/src/components/SettingsModal.module.css`:

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--card);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 16px 20px;
  min-width: 300px;
}
.title {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 12px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.label {
  font-size: 12.5px;
  color: var(--text-body);
}
.segmented {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  overflow: hidden;
}
.seg,
.segActive {
  background: none;
  border: none;
  font: inherit;
  font-size: 11.5px;
  padding: 4px 12px;
  cursor: pointer;
  color: var(--text-secondary);
}
.segActive {
  background: var(--sel-bg);
  color: var(--sel-text);
}
```

`packages/web/src/components/Sidebar.tsx`:
- imports: add `Settings` to the lucide-react import, `useState` to the react import (check what's already imported), and `import { SettingsModal } from "./SettingsModal.js";`
- component: add `const [settingsOpen, setSettingsOpen] = useState(false);`
- in the rail `<div className={styles.rail}>`, after the files button add:

```tsx
        <button
          className={styles.railBtn}
          style={{ marginLeft: "auto" }}
          aria-label="settings"
          data-testid="settings-open"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={16} />
        </button>
```

- at the end of the returned `<aside>` (after the chats/files content), render:

```tsx
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
```

(If the codebase style prefers a CSS class over the inline `marginLeft`, add a `.railSpacer`/`.railEnd` class in Sidebar.module.css — either is acceptable; keep it consistent with the file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/SettingsModal.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 5: Full checks**

Run in this order (one at a time): `npx pnpm -r typecheck`; the full web suite backgrounded (`timeout 180 npx pnpm --filter @conclave/web exec vitest run > /tmp/web-suite.log 2>&1; grep -E "Test Files|Tests " /tmp/web-suite.log`); `npx vitest run` (full backend — should be untouched); `npx pnpm --filter @conclave/web build`.

- [ ] **Step 6: Commit**

```bash
git add packages/web
git commit -m "feat(web): settings modal with Black/Teal scheme switcher"
```

---

## Coverage vs spec (self-check)

- Token restructure + full Teal palette + parity test: Task 1. Accent split, mention/inline-code/file/badge role fixes, both `#e5e5e5` leaks, no-hex regression test: Task 2. Theme lib (allowlist, private-mode no-op), store, no-flash inline script, boot apply, dynamic meta theme-color: Task 3. Gear + modal (Escape/backdrop close, segmented control): Task 4.
- Manual smoke (spec honesty): the no-flash boot and pixel fidelity vs `screenshots/3a-teal-main.png` are eyeball-only — record run/not-run at finish; never claim visual fidelity from these tests.
- Known limitations documented in the spec (xterm retint, PWA manifest/icon staying black) need no tasks.
