# Mobile Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a bottom-tab mobile shell (Workspace · Chats · Terminals · Status) instead of the three-column desktop layout below 768px, reusing the existing store and inner components; desktop markup unchanged.

**Architecture:** A `useIsMobile()` matchMedia hook forks `App.tsx` between the untouched desktop tree and a new `MobileShell`. Mobile navigation state (`mobileTab`, `chatListOpen`) lives in the Zustand store so existing activation setters can steer tabs. StatusStrip's sections are extracted into shared pieces consumed by both shells; TerminalsSection and ChatList are reused across screens; FsFileView becomes a lazy chunk.

**Tech Stack:** React 18, Zustand, CSS modules with theme tokens, lucide-react icons, vitest + @testing-library/react (jsdom).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-mobile-layout-design.md`. Reference mocks: `design_handoff_conclave_phone/screenshots/5a–5c` (reference, not authoritative).
- Breakpoint: exactly `(max-width: 768px)`, defined once in `lib/useIsMobile.ts`.
- ALL colors via existing theme tokens (`var(--…)`) — the `no-hex-in-components` guard test will fail the build otherwise. No new tokens.
- Touch targets ≥ 44px on mobile interactive rows/buttons; tab bar gets `padding-bottom: env(safe-area-inset-bottom)`; screen headers `padding-top: env(safe-area-inset-top)`.
- Desktop tree in `App.tsx` stays byte-for-byte unchanged except the `FsFileView` → `LazyFsFileView` swap (Task 5).
- **Spec adaptations (approved deviations, record verbatim in code comments where noted):** the store has no unread counts — the Chats tab badge and chat-card badge use the existing pending-approval signal (`approvalsById`, `state === "pending"`). `Workspace` has no `branch` field — the Workspace header sub-line is `<machine> · $<spent> / $<budget> today`.
- Tab-steering: activation setters flip `mobileTab` only when activating (non-null argument); clearing (null) must NOT steer.
- ESM specifiers end in `.js`. Tests run from repo root: `npx pnpm --filter @conclave/web exec vitest run <path-relative-to-packages/web>`. Never run the full web suite without `timeout 180 … > log 2>&1` + grep (it hangs on teardown).
- Every commit message ends with the footer line `Claude-Session: https://claude.ai/code/session_01MJ8FKhtSEmDL7SuhNtRrGN`.

---

### Task 1: useIsMobile hook + store mobile-nav state + viewport meta

**Files:**
- Create: `packages/web/src/lib/useIsMobile.ts`
- Create: `packages/web/src/lib/__tests__/useIsMobile.test.tsx`
- Modify: `packages/web/src/store/useConclaveStore.ts`
- Create: `packages/web/src/store/__tests__/mobile-nav.test.ts`
- Modify: `packages/web/index.html` (viewport meta only)

**Interfaces:**
- Produces: `useIsMobile(): boolean`; `MOBILE_QUERY = "(max-width: 768px)"`; store fields `mobileTab: "workspace" | "chats" | "terminals" | "status"` (initial `"workspace"`), `chatListOpen: boolean` (initial `false`); setters `setMobileTab(tab)`, `setChatListOpen(v)`; exported type `MobileTab`.
- Consumes: existing store activation setters.

- [ ] **Step 1: Write the failing hook test**

`packages/web/src/lib/__tests__/useIsMobile.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useIsMobile } from "../useIsMobile.js";

type Listener = (e: { matches: boolean }) => void;

function stubMatchMedia(initial: boolean): { fire: (matches: boolean) => void } {
  let matches = initial;
  const listeners: Listener[] = [];
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (media: string) => ({
      get matches() {
        return matches;
      },
      media,
      addEventListener: (_: string, cb: Listener) => listeners.push(cb),
      removeEventListener: (_: string, cb: Listener) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    }),
  });
  return {
    fire: (m: boolean) => {
      matches = m;
      listeners.forEach((cb) => cb({ matches: m }));
    },
  };
}

function Probe(): JSX.Element {
  return <div data-testid="probe">{String(useIsMobile())}</div>;
}

describe("useIsMobile", () => {
  it("reflects the initial matchMedia state", () => {
    stubMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("updates when the media query changes", () => {
    const mm = stubMatchMedia(false);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("false");
    act(() => mm.fire(true));
    expect(screen.getByTestId("probe").textContent).toBe("true");
  });

  it("returns false when matchMedia is unavailable (jsdom default)", () => {
    // @ts-expect-error deliberately removing the stub
    delete window.matchMedia;
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("false");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/useIsMobile.test.tsx`
Expected: FAIL — cannot resolve `../useIsMobile.js`.

- [ ] **Step 3: Implement the hook**

`packages/web/src/lib/useIsMobile.ts`:

```ts
import { useSyncExternalStore } from "react";

// Single source of truth for the mobile breakpoint (spec: 768px).
export const MOBILE_QUERY = "(max-width: 768px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
```

- [ ] **Step 4: Run the hook test — expect PASS**

Run: `npx pnpm --filter @conclave/web exec vitest run src/lib/__tests__/useIsMobile.test.tsx`
Expected: 3 passed.

- [ ] **Step 5: Write the failing store test**

`packages/web/src/store/__tests__/mobile-nav.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { TerminalInfo } from "@conclave/shared";
import { useConclaveStore } from "../useConclaveStore.js";

const term = (id: string, agentId?: string): TerminalInfo => ({
  id,
  machine: "m1",
  kind: "claude",
  label: `t-${id}`,
  cwd: "/w",
  agentId,
  startedAt: "2026-07-18T10:00:00.000Z",
});

describe("mobile navigation state", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("starts on the workspace tab with the chat list closed", () => {
    expect(useConclaveStore.getState().mobileTab).toBe("workspace");
    expect(useConclaveStore.getState().chatListOpen).toBe(false);
  });

  it("setMobileTab and setChatListOpen update state", () => {
    useConclaveStore.getState().setMobileTab("status");
    useConclaveStore.getState().setChatListOpen(true);
    expect(useConclaveStore.getState().mobileTab).toBe("status");
    expect(useConclaveStore.getState().chatListOpen).toBe(true);
  });

  it("setActiveThread steers to chats and closes the list", () => {
    useConclaveStore.getState().setChatListOpen(true);
    useConclaveStore.getState().setActiveThread("th-1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
    expect(useConclaveStore.getState().chatListOpen).toBe(false);
  });

  it("setActiveTerminal(id) steers to terminals; clearing does not steer", () => {
    useConclaveStore.getState().setActiveTerminal("t1");
    expect(useConclaveStore.getState().mobileTab).toBe("terminals");
    useConclaveStore.getState().setMobileTab("workspace");
    useConclaveStore.getState().setActiveTerminal(null);
    expect(useConclaveStore.getState().mobileTab).toBe("workspace");
  });

  it("setActiveFsFile and setActiveArtifact steer to chats only when activating", () => {
    useConclaveStore.getState().setActiveFsFile({ machine: "m1", path: "/w/a.ts" });
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
    useConclaveStore.getState().setMobileTab("status");
    useConclaveStore.getState().setActiveFsFile(null);
    expect(useConclaveStore.getState().mobileTab).toBe("status");
    useConclaveStore.getState().setActiveArtifact("art-1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
    useConclaveStore.getState().setMobileTab("status");
    useConclaveStore.getState().setActiveArtifact(null);
    expect(useConclaveStore.getState().mobileTab).toBe("status");
  });

  it("takeover auto-open steers to terminals", () => {
    useConclaveStore.getState().setPendingTakeover({ agentId: "claude-code" });
    useConclaveStore.getState().applyFrame({
      type: "terminal-list",
      terminals: [term("t9", "claude-code")],
    });
    expect(useConclaveStore.getState().activeTerminalId).toBe("t9");
    expect(useConclaveStore.getState().mobileTab).toBe("terminals");
  });
});
```

- [ ] **Step 6: Run it — expect FAIL** (`mobileTab` undefined)

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__/mobile-nav.test.ts`

- [ ] **Step 7: Extend the store**

In `packages/web/src/store/useConclaveStore.ts`:

Add above the `State` interface:

```ts
export type MobileTab = "workspace" | "chats" | "terminals" | "status";
```

Add to the `State` interface (after `theme: Theme;`):

```ts
  mobileTab: MobileTab;
  chatListOpen: boolean;
```

and after `setTheme(t: Theme): void;`:

```ts
  setMobileTab(tab: MobileTab): void;
  setChatListOpen(v: boolean): void;
```

Add to `initial` (after `theme: …`):

```ts
  mobileTab: "workspace" as MobileTab,
  chatListOpen: false,
```

Add the setters (after `setTheme`):

```ts
  setMobileTab: (tab) => set({ mobileTab: tab }),
  setChatListOpen: (v) => set({ chatListOpen: v }),
```

Steer the activation setters — these are exact replacements:

`setActiveThread` — add two fields to its `set` object:

```ts
  setActiveThread: (id) =>
    set((s) => ({
      activeThreadId: id,
      activeArtifactId: null,
      activeFsFile: null,
      fsDirty: false,
      activeTerminalId: null,
      mobileTab: "chats",
      chatListOpen: false,
      openThreadIds: s.openThreadIds.includes(id) ? s.openThreadIds : [...s.openThreadIds, id],
    })),
```

`setActiveArtifact` — steer only when activating:

```ts
  setActiveArtifact: (id) =>
    set(
      id
        ? { activeArtifactId: id, activeFsFile: null, fsDirty: false, activeTerminalId: null, mobileTab: "chats" }
        : { activeArtifactId: id, activeFsFile: null, fsDirty: false, activeTerminalId: null },
    ),
```

`setActiveFsFile`:

```ts
  setActiveFsFile: (f) =>
    set(
      f
        ? { activeFsFile: f, activeArtifactId: null, activeTerminalId: null, mobileTab: "chats" }
        : { activeFsFile: f, activeArtifactId: null, activeTerminalId: null },
    ),
```

`setActiveTerminal`:

```ts
  setActiveTerminal: (id) =>
    set(
      id
        ? { activeTerminalId: id, activeArtifactId: null, activeFsFile: null, fsDirty: false, mobileTab: "terminals" }
        : { activeTerminalId: id },
    ),
```

In `applyFrame`'s `terminal-list` takeover branch, add `mobileTab: "terminals",` to the returned object (the one that already sets `activeTerminalId: fresh[0]!.id`).

- [ ] **Step 8: Run both new tests + existing store suite — expect PASS**

Run: `npx pnpm --filter @conclave/web exec vitest run src/store/__tests__ src/lib/__tests__/useIsMobile.test.tsx`
Expected: all pass (existing store tests must stay green — the steering fields are additive).

- [ ] **Step 9: Viewport meta**

In `packages/web/index.html`, change the viewport meta to:

```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/lib/useIsMobile.ts packages/web/src/lib/__tests__/useIsMobile.test.tsx packages/web/src/store/useConclaveStore.ts packages/web/src/store/__tests__/mobile-nav.test.ts packages/web/index.html
git commit -m "feat(web): mobile breakpoint hook and tab-steering store state"
```

---

### Task 2: StatusSections extraction + mobile StatusScreen

**Files:**
- Create: `packages/web/src/components/StatusSections.tsx`
- Modify: `packages/web/src/components/StatusStrip.tsx` (becomes a thin composition)
- Create: `packages/web/src/components/mobile/StatusScreen.tsx`
- Create: `packages/web/src/components/mobile/mobile.module.css`
- Create: `packages/web/src/components/mobile/__tests__/StatusScreen.test.tsx`

**Interfaces:**
- Produces: named exports from `StatusSections.tsx`: `LiveStatusCards(): JSX.Element`, `UsageLimitsSection(): JSX.Element`, `PushToggle(): JSX.Element | null`, `WorkspaceFooter(): JSX.Element`; `StatusScreen(): JSX.Element` (testid `status-screen`); the shared mobile stylesheet `mobile.module.css` with classes `.screen`, `.screenHeader`, `.title`, `.subline`, `.sectionHeader`, `.card`, `.cardSelected`, `.cardTitle`, `.cardPreview`, `.cardBadge`, `.empty`, `.backHeader`, `.backBtn`, `.backTitle`, `.termWrap` (later tasks import these — keep the names exact).
- Consumes: current `StatusStrip.tsx` internals (moved verbatim), `styles from "./StatusStrip.module.css"`.

- [ ] **Step 1: Extract StatusSections (refactor under existing green tests)**

Create `packages/web/src/components/StatusSections.tsx` by MOVING code out of `StatusStrip.tsx` — the `hhmm` helper, the `WindowMeter` component, and the three content regions — with identical markup, classnames, testids, and the same `import styles from "./StatusStrip.module.css";`:

```tsx
import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useConclaveStore } from "../store/useConclaveStore.js";
import { agentColorVar } from "../lib/agents.js";
import { disablePush, enablePush, isPushEnabled, pushPermission, pushSupported } from "../lib/push.js";
import { fmtTok, usageSeverity } from "../lib/severity.js";
import styles from "./StatusStrip.module.css";

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function WindowMeter({ label, agent, used, pct }: {
  label: string; agent: string; used: number; pct?: number;
}): JSX.Element {
  const key = label === "5h" ? "5h" : "wk";
  return (
    <span className={styles.window} data-testid={`win-${key}-${agent}`}>
      <span className={styles.winLabel}>{label}</span>
      {pct === undefined ? (
        <span className={styles.winText}>{fmtTok(used)} tok</span>
      ) : (
        <>
          <span className={styles.winTrack}>
            <span
              className={styles.winFill}
              data-severity={usageSeverity(pct)}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </span>
          <span className={styles.winPct} data-severity={usageSeverity(pct)}>{pct}%</span>
        </>
      )}
    </span>
  );
}

export function LiveStatusCards(): JSX.Element {
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  return (
    <>
      <div className={styles.sectionHeader}>live status</div>
      {agents.map((a) => {
        const st = statusByAgent[a.id];
        const status = st?.status ?? "idle";
        return (
          <div key={a.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.swatch} style={{ background: agentColorVar(a.id).bg }} />
              <span className={styles.name}>{a.name}</span>
              <span className={styles.status} data-status={status}>
                ● {status}
              </span>
            </div>
            <div className={styles.activity}>{st?.activity || "idle"}</div>
            <div className={styles.progressTrack}>
              <div className={status === "running" ? styles.progressRunning : styles.progressIdle} />
            </div>
          </div>
        );
      })}
    </>
  );
}

export function UsageLimitsSection(): JSX.Element {
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const usage = useConclaveStore((s) => s.usage);
  const budget = usage?.budgetUsd ?? 0;
  return (
    <>
      <div className={styles.sectionHeader}>usage limits</div>
      {(usage?.perAgent ?? []).map((u) => {
        const st = statusByAgent[u.agent];
        const pct = budget > 0 ? Math.round((u.costUsd / budget) * 100) : 0;
        return (
          <div key={u.agent} className={styles.usageRow}>
            <span className={styles.swatch} style={{ background: agentColorVar(u.agent).bg }} />
            <span className={styles.name}>{u.agent}</span>
            <span className={styles.metric}>
              {(u.inputTokens + u.outputTokens).toLocaleString()} tok · ${u.costUsd.toFixed(2)}
              {st?.status === "blocked" && st.resetsAt ? ` · resets ${hhmm(st.resetsAt)}` : ""}
            </span>
            <div className={styles.usageTrack}>
              <div
                className={styles.usageFill}
                data-severity={usageSeverity(pct)}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <div className={styles.windows}>
              <WindowMeter label="5h" agent={u.agent} used={u.window5hTokens} pct={u.window5hPct} />
              <WindowMeter label="wk" agent={u.agent} used={u.weeklyTokens} pct={u.weeklyPct} />
            </div>
          </div>
        );
      })}
    </>
  );
}

export function PushToggle(): JSX.Element | null {
  const [pushOn, setPushOn] = useState(false);
  useEffect(() => {
    if (pushSupported()) void isPushEnabled().then(setPushOn);
  }, []);
  if (!pushSupported()) return null;
  const denied = pushPermission() === "denied";
  const togglePush = async (): Promise<void> => {
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
      } else {
        await enablePush();
        setPushOn(true);
      }
    } catch {
      setPushOn(await isPushEnabled()); // re-sync on failure (e.g. permission refused)
    }
  };
  return (
    <button
      className={styles.pushToggle}
      data-testid="push-toggle"
      disabled={denied}
      title={
        denied
          ? "notifications blocked in browser settings"
          : pushOn
            ? "disable notifications"
            : "enable notifications"
      }
      onClick={() => void togglePush()}
    >
      {pushOn ? <Bell size={13} /> : <BellOff size={13} />}
      <span>{pushOn ? "notifications on" : "notifications off"}</span>
    </button>
  );
}

export function WorkspaceFooter(): JSX.Element {
  const usage = useConclaveStore((s) => s.usage);
  const budget = usage?.budgetUsd ?? 0;
  return (
    <div className={styles.footer}>
      <span>workspace today</span>
      <span className={styles.spend}>
        ${(usage?.totalCostUsd ?? 0).toFixed(2)} / ${budget}
      </span>
    </div>
  );
}
```

Note the one intentional behavior detail: `PushToggle` calls its hooks before the `pushSupported()` early return so hook order is stable (`useState`/`useEffect` run unconditionally).

Replace `packages/web/src/components/StatusStrip.tsx` entirely with:

```tsx
import { LiveStatusCards, PushToggle, UsageLimitsSection, WorkspaceFooter } from "./StatusSections.js";
import styles from "./StatusStrip.module.css";

export function StatusStrip(): JSX.Element {
  return (
    <aside className={styles.strip} data-testid="status-strip">
      <LiveStatusCards />
      <UsageLimitsSection />
      <PushToggle />
      <WorkspaceFooter />
    </aside>
  );
}
```

- [ ] **Step 2: Run the existing status tests — expect PASS (pure refactor)**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/StatusStrip.test.tsx src/components/__tests__/UsageMeters.test.tsx src/components/__tests__/PushToggle.test.tsx`
Expected: all pass unchanged. If any fails, the extraction diverged — fix the extraction, not the tests.

- [ ] **Step 3: Write the failing StatusScreen test**

`packages/web/src/components/mobile/__tests__/StatusScreen.test.tsx`:

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { StatusScreen } from "../StatusScreen.js";

describe("StatusScreen", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("renders header, live status cards, and usage meters full-width", () => {
    useConclaveStore.setState({
      agents: [
        { id: "claude-code", name: "claude-code", runtime: "claude", machine: "m1" },
      ] as never,
      statusByAgent: {
        "claude-code": { agent: "claude-code", status: "running", activity: "writing migration", ts: "2026-07-18T10:00:00.000Z" },
      } as never,
      usage: {
        perAgent: [{
          agent: "claude-code", inputTokens: 1000, outputTokens: 500, costUsd: 2.1,
          window5hTokens: 4200, weeklyTokens: 9000, window5hPct: 42,
        }],
        totalCostUsd: 2.1,
        budgetUsd: 25,
      } as never,
      workspacesById: {
        w1: { id: "w1", name: "payments-service", machine: "m1", folderPath: "/w", createdAt: "2026-07-18T09:00:00.000Z" },
      } as never,
      activeWorkspaceId: "w1",
    });
    render(<StatusScreen />);
    expect(screen.getByTestId("status-screen")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("payments-service · live")).toBeTruthy();
    expect(screen.getByText("● running")).toBeTruthy();
    expect(screen.getByTestId("win-5h-claude-code").textContent).toContain("42%");
    expect(screen.getByText("workspace today")).toBeTruthy();
  });

  it("renders without a workspace or usage (empty hub)", () => {
    render(<StatusScreen />);
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByText("workspace today")).toBeTruthy();
  });
});
```

(If the `agents` fixture shape mismatches `AgentConfig`, check `packages/shared/src/registry.ts` and use the minimal valid literal — the `as never` casts keep TS out of the way in fixtures, matching existing web test idiom.)

- [ ] **Step 4: Run it — expect FAIL (module not found)**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/StatusScreen.test.tsx`

- [ ] **Step 5: Create the shared mobile stylesheet and StatusScreen**

`packages/web/src/components/mobile/mobile.module.css`:

```css
/* Shared mobile-screen idiom (mocks 5a–5c). All colors are theme tokens. */
.screen {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 14px 20px;
  padding-top: calc(14px + env(safe-area-inset-top));
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.screenHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 2px 10px;
}
.title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}
.subline {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 3px;
}
.sectionHeader {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.card,
.cardSelected {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 13px 15px;
  min-height: 44px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.cardSelected {
  background: var(--sel-bg);
  color: var(--sel-text);
  font-weight: 600;
}
.cardTitle {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cardPreview {
  display: block;
  font-size: 11.5px;
  color: var(--text-secondary-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cardBadge {
  background: var(--hover);
  color: var(--text-primary);
  border-radius: 8px;
  font-size: 10.5px;
  padding: 1px 6px;
}
.cardSelected .cardBadge {
  background: var(--surface);
}
.empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 4px 2px;
}
.backHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  padding-top: calc(8px + env(safe-area-inset-top));
  border-bottom: 1px solid var(--border);
  background: var(--rail);
}
.backBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
}
.backTitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.termWrap {
  display: flex;
  flex-direction: column;
}
.termWrap button {
  min-height: 44px;
}
```

Every `var(--…)` above is an existing token from `src/styles/tokens.css` (`--card`, `--rail`, `--border`, `--hover`, `--sel-bg`, `--sel-text`, `--surface`, `--text-*`, `--font-mono`, `--live`, `--blocked`) — do NOT invent new tokens.

`packages/web/src/components/mobile/StatusScreen.tsx`:

```tsx
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { LiveStatusCards, PushToggle, UsageLimitsSection, WorkspaceFooter } from "../StatusSections.js";
import styles from "./mobile.module.css";

export function StatusScreen(): JSX.Element {
  const ws = useConclaveStore((s) =>
    s.activeWorkspaceId ? s.workspacesById[s.activeWorkspaceId] : undefined,
  );
  return (
    <div className={styles.screen} data-testid="status-screen">
      <header className={styles.screenHeader}>
        <div>
          <h1 className={styles.title}>Status</h1>
          <div className={styles.subline}>{ws ? `${ws.name} · live` : "live"}</div>
        </div>
      </header>
      <LiveStatusCards />
      <UsageLimitsSection />
      <PushToggle />
      <WorkspaceFooter />
    </div>
  );
}
```

- [ ] **Step 6: Run the StatusScreen test — expect PASS**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/StatusScreen.test.tsx`

- [ ] **Step 7: Run the token guard + typecheck**

Run: `npx pnpm --filter @conclave/web exec vitest run src/styles/__tests__` then `npx pnpm --filter @conclave/web typecheck`
Expected: pass (no hex in the new files; types clean).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/StatusSections.tsx packages/web/src/components/StatusStrip.tsx packages/web/src/components/mobile/
git commit -m "feat(web): extract status sections; mobile Status screen"
```

---

### Task 3: shared label helpers + ChatList + WorkspaceScreen

**Files:**
- Create: `packages/web/src/lib/labels.ts`
- Modify: `packages/web/src/components/Sidebar.tsx` (import the helpers instead of its private copies)
- Create: `packages/web/src/components/mobile/ChatList.tsx`
- Create: `packages/web/src/components/mobile/WorkspaceScreen.tsx`
- Create: `packages/web/src/components/mobile/__tests__/WorkspaceScreen.test.tsx`

**Interfaces:**
- Produces: `threadLabel(workspace: string | null, kind: string): string` and `artifactColor(name: string): string` in `lib/labels.ts`; `ChatList(): JSX.Element` (testid `mobile-chat-list`; thread tap = `setActiveThread` + `hubClient.listMessages` load, exactly like Sidebar); `WorkspaceScreen(): JSX.Element` (testid `workspace-screen`).
- Consumes: `mobile.module.css` classes from Task 2; store fields from Task 1; existing `TerminalsSection`, `SettingsModal`, `Avatar`, `agentColorVar`.

- [ ] **Step 1: Move the label helpers**

`packages/web/src/lib/labels.ts`:

```ts
export function threadLabel(workspace: string | null, kind: string): string {
  if (workspace) return workspace;
  return kind === "dm" ? "direct message" : "thread";
}

export function artifactColor(name: string): string {
  if (/ticket/i.test(name)) return "var(--artifact-ticket)";
  if (/plan/i.test(name)) return "var(--artifact-plan)";
  return "var(--text-secondary-2)";
}
```

In `Sidebar.tsx`: delete its private `threadLabel` and `artifactColor` functions and add `import { artifactColor, threadLabel } from "../lib/labels.js";`.

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/__tests__/Sidebar.test.tsx src/components/__tests__/SidebarArtifacts.test.tsx`
Expected: pass unchanged.

- [ ] **Step 2: Write the failing WorkspaceScreen test**

`packages/web/src/components/mobile/__tests__/WorkspaceScreen.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { WorkspaceScreen } from "../WorkspaceScreen.js";

vi.mock("../../../lib/hubClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/hubClient.js")>();
  return {
    ...mod,
    hubClient: {
      ...mod.hubClient,
      listMessages: vi.fn().mockResolvedValue([]),
      listMachines: vi.fn().mockResolvedValue([]),
    },
  };
});

function seed(): void {
  useConclaveStore.setState({
    workspacesById: {
      w1: { id: "w1", name: "payments-service", machine: "m1", folderPath: "/w", createdAt: "2026-07-18T09:00:00.000Z" },
    } as never,
    activeWorkspaceId: "w1",
    threads: [
      { id: "th-1", kind: "group", workspace: "payments-service", participants: ["you", "claude-code"], state: "open", verdicts: {}, createdAt: "2026-07-18T09:00:00.000Z" },
    ] as never,
    agents: [{ id: "claude-code", name: "claude-code", runtime: "claude", machine: "m1" }] as never,
    statusByAgent: {
      "claude-code": { agent: "claude-code", status: "running", activity: "writing migration", ts: "2026-07-18T10:00:00.000Z" },
    } as never,
    usage: { perAgent: [], totalCostUsd: 4.82, budgetUsd: 25 } as never,
    approvalsById: {
      ap1: { id: "ap1", threadId: "th-1", state: "pending" },
    } as never,
    artifactsById: {
      art1: { id: "art1", name: "idempotency plan", threadId: "th-1" },
    } as never,
  });
}

describe("WorkspaceScreen", () => {
  beforeEach(() => {
    useConclaveStore.getState().reset();
    seed();
  });

  it("shows workspace header with machine + spend sub-line", () => {
    render(<WorkspaceScreen />);
    expect(screen.getByText("payments-service")).toBeTruthy();
    expect(screen.getByText("m1 · $4.82 / $25 today")).toBeTruthy();
  });

  it("chat card tap activates the thread and steers to the chats tab", () => {
    render(<WorkspaceScreen />);
    fireEvent.click(screen.getByTestId("mobile-chat-th-1"));
    expect(useConclaveStore.getState().activeThreadId).toBe("th-1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
  });

  it("shows the pending-approval badge on the chat card", () => {
    render(<WorkspaceScreen />);
    expect(screen.getByTestId("mobile-approval-badge").textContent).toBe("!");
  });

  it("lists agents with status and artifacts, and opens artifacts", () => {
    render(<WorkspaceScreen />);
    expect(screen.getByText("● running")).toBeTruthy();
    fireEvent.click(screen.getByText("idempotency plan"));
    expect(useConclaveStore.getState().activeArtifactId).toBe("art1");
    expect(useConclaveStore.getState().mobileTab).toBe("chats");
  });

  it("gear opens the settings modal", () => {
    render(<WorkspaceScreen />);
    fireEvent.click(screen.getByTestId("mobile-settings-open"));
    expect(screen.getByTestId("settings-backdrop")).toBeTruthy();
  });

  it("renders empty states without data", () => {
    useConclaveStore.getState().reset();
    render(<WorkspaceScreen />);
    expect(screen.getByText("no chats")).toBeTruthy();
  });
});
```

(The `mobile-chat-<id>` testid comes from `ChatList`, implemented in Step 4.)

- [ ] **Step 3: Run it — expect FAIL (module not found)**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/WorkspaceScreen.test.tsx`

- [ ] **Step 4: Implement ChatList**

`packages/web/src/components/mobile/ChatList.tsx`:

```tsx
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { hubClient } from "../../lib/hubClient.js";
import { threadLabel } from "../../lib/labels.js";
import styles from "./mobile.module.css";

// Chats tab badge + card badge use the pending-approval signal — the store has
// no unread counts (approved deviation from the phone mock's unread badges).
export function ChatList(): JSX.Element {
  const threads = useConclaveStore((s) => s.threads);
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const setActiveThread = useConclaveStore((s) => s.setActiveThread);
  const setMessages = useConclaveStore((s) => s.setMessages);
  const messagesByThread = useConclaveStore((s) => s.messagesByThread);
  const workspacesById = useConclaveStore((s) => s.workspacesById);
  const activeWorkspaceId = useConclaveStore((s) => s.activeWorkspaceId);
  const approvalsById = useConclaveStore((s) => s.approvalsById);

  const active = activeWorkspaceId ? workspacesById[activeWorkspaceId] : undefined;
  const shown = active ? threads.filter((t) => t.workspace === active.name) : threads;
  const pending = new Set(
    Object.values(approvalsById)
      .filter((a) => a.state === "pending")
      .map((a) => a.threadId),
  );

  const open = async (id: string): Promise<void> => {
    setActiveThread(id);
    setMessages(id, await hubClient.listMessages(id));
  };

  return (
    <div className={styles.cardList} data-testid="mobile-chat-list">
      {shown.length === 0 && <div className={styles.empty}>no chats</div>}
      {shown.map((t) => {
        const msgs = messagesByThread[t.id];
        const last = msgs?.[msgs.length - 1];
        return (
          <button
            key={t.id}
            className={t.id === activeThreadId ? styles.cardSelected : styles.card}
            data-testid={`mobile-chat-${t.id}`}
            onClick={() => void open(t.id)}
          >
            <span className={styles.cardTitle}>
              <span>{threadLabel(t.workspace, t.kind)}</span>
              {last && (
                <span className={styles.cardPreview}>{`${last.from}: ${last.body.slice(0, 80)}`}</span>
              )}
            </span>
            {pending.has(t.id) && (
              <span className={styles.cardBadge} data-testid="mobile-approval-badge">!</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

Add to `mobile.module.css`:

```css
.cardList {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
```

- [ ] **Step 5: Implement WorkspaceScreen**

`packages/web/src/components/mobile/WorkspaceScreen.tsx`:

```tsx
import { useState } from "react";
import { Settings } from "lucide-react";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { agentColorVar } from "../../lib/agents.js";
import { artifactColor } from "../../lib/labels.js";
import { Avatar } from "../Avatar.js";
import { SettingsModal } from "../SettingsModal.js";
import { TerminalsSection } from "../TerminalsSection.js";
import { ChatList } from "./ChatList.js";
import styles from "./mobile.module.css";

export function WorkspaceScreen(): JSX.Element {
  const workspacesById = useConclaveStore((s) => s.workspacesById);
  const activeWorkspaceId = useConclaveStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useConclaveStore((s) => s.setActiveWorkspace);
  const usage = useConclaveStore((s) => s.usage);
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);
  const artifacts = useConclaveStore((s) => Object.values(s.artifactsById));
  const setActiveArtifact = useConclaveStore((s) => s.setActiveArtifact);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const workspaces = Object.values(workspacesById);
  const active = activeWorkspaceId ? workspacesById[activeWorkspaceId] : undefined;
  // Workspace has no branch field; the mock's `main · …` sub-line uses machine
  // instead. Absent segments are omitted (spec: no fake data while the hub loads).
  const subline = [
    active?.machine,
    usage ? `$${usage.totalCostUsd.toFixed(2)} / $${usage.budgetUsd} today` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={styles.screen} data-testid="workspace-screen">
      <header className={styles.screenHeader}>
        <div>
          {workspaces.length > 1 ? (
            <select
              className={styles.wsSelect}
              aria-label="workspace"
              value={activeWorkspaceId ?? ""}
              onChange={(e) => setActiveWorkspace(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : (
            <h1 className={styles.title}>{active?.name ?? workspaces[0]?.name ?? "conclave"}</h1>
          )}
          {subline && <div className={styles.subline}>{subline}</div>}
        </div>
        <button
          className={styles.gearBtn}
          aria-label="settings"
          data-testid="mobile-settings-open"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={18} />
        </button>
      </header>

      <div className={styles.sectionHeader}>chats</div>
      <ChatList />

      <div className={styles.termWrap}>
        <TerminalsSection />
      </div>

      <div className={styles.sectionHeader}>agents</div>
      {agents.length === 0 && <div className={styles.empty}>no agents</div>}
      {agents.map((a) => {
        const st = statusByAgent[a.id];
        const status = st?.status ?? "idle";
        return (
          <div key={a.id} className={styles.card} data-testid={`mobile-agent-${a.id}`}>
            <Avatar name={a.id} kind="agent" size={26} />
            <span className={styles.cardTitle}>
              <span style={{ color: agentColorVar(a.id).bg, fontWeight: 600 }}>{a.name}</span>
              <span className={styles.cardPreview}>{st?.activity || "idle"}</span>
            </span>
            <span className={styles.agentStatus} data-status={status}>● {status}</span>
          </div>
        );
      })}

      {artifacts.length > 0 && (
        <>
          <div className={styles.sectionHeader}>artifacts</div>
          {artifacts.map((a) => (
            <button key={a.id} className={styles.card} onClick={() => setActiveArtifact(a.id)}>
              <span style={{ color: artifactColor(a.name) }}>▦</span>
              <span className={styles.cardTitle}>{a.name}</span>
            </button>
          ))}
        </>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
```

Add to `mobile.module.css`:

```css
.wsSelect {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  background: transparent;
  border: none;
  padding: 0;
}
.gearBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}
.agentStatus {
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}
.agentStatus[data-status="running"] {
  color: var(--live);
}
.agentStatus[data-status="blocked"] {
  color: var(--blocked);
}
.agentStatus[data-status="idle"] {
  color: var(--text-muted);
}
```

- [ ] **Step 6: Run the tests — expect PASS**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/WorkspaceScreen.test.tsx src/components/__tests__/Sidebar.test.tsx`

- [ ] **Step 7: Typecheck + commit**

Run: `npx pnpm --filter @conclave/web typecheck`

```bash
git add packages/web/src/lib/labels.ts packages/web/src/components/Sidebar.tsx packages/web/src/components/mobile/
git commit -m "feat(web): mobile Workspace screen with shared chat list"
```

---

### Task 4: ChatsScreen + TerminalsScreen + lazy FsFileView

**Files:**
- Create: `packages/web/src/components/LazyFsFileView.tsx`
- Create: `packages/web/src/components/mobile/ChatsScreen.tsx`
- Create: `packages/web/src/components/mobile/TerminalsScreen.tsx`
- Create: `packages/web/src/components/mobile/__tests__/ChatsScreen.test.tsx`
- Create: `packages/web/src/components/mobile/__tests__/TerminalsScreen.test.tsx`

**Interfaces:**
- Produces: `ChatsScreen(): JSX.Element` (testid `chats-screen`), `TerminalsScreen(): JSX.Element` (testid `terminals-screen`), `LazyFsFileView(): JSX.Element` (Suspense-wrapped `React.lazy` FsFileView — Task 5 swaps the desktop App to it).
- Consumes: Task 1 store fields (`chatListOpen`, `setChatListOpen`); Task 2 `mobile.module.css` (`.backHeader`, `.backBtn`, `.backTitle`, `.screen`, `.termWrap`, `.sectionHeader`); Task 3 `ChatList`, `threadLabel`; existing `GroupChat`, `Composer`, `ArtifactView`, `TerminalView`, `TerminalsSection`, `Avatar`.

- [ ] **Step 1: Write the failing ChatsScreen test**

`packages/web/src/components/mobile/__tests__/ChatsScreen.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { ChatsScreen } from "../ChatsScreen.js";

vi.mock("../../../lib/hubClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/hubClient.js")>();
  return {
    ...mod,
    hubClient: {
      ...mod.hubClient,
      listMessages: vi.fn().mockResolvedValue([]),
      fsRead: vi.fn().mockResolvedValue({ content: "" }),
    },
  };
});

function seedThread(): void {
  useConclaveStore.setState({
    threads: [
      { id: "th-1", kind: "group", workspace: "payments-service", participants: ["you", "claude-code", "codex"], state: "open", verdicts: {}, createdAt: "2026-07-18T09:00:00.000Z" },
    ] as never,
    agents: [
      { id: "claude-code", name: "claude-code", runtime: "claude", machine: "m1" },
      { id: "codex", name: "codex", runtime: "codex", machine: "m1" },
    ] as never,
    statusByAgent: {
      "claude-code": { agent: "claude-code", status: "running", activity: "x", ts: "2026-07-18T10:00:00.000Z" },
    } as never,
  });
}

describe("ChatsScreen", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("shows the thread list when no thread is active", () => {
    seedThread();
    render(<ChatsScreen />);
    expect(screen.getByTestId("mobile-chat-list")).toBeTruthy();
  });

  it("shows the active thread with back header and live sub-line", () => {
    seedThread();
    useConclaveStore.setState({ activeThreadId: "th-1" });
    render(<ChatsScreen />);
    expect(screen.getByText("payments-service")).toBeTruthy();
    expect(screen.getByText("2 agents · 1 running")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().chatListOpen).toBe(true);
  });

  it("renders the artifact view full-screen when an artifact is active", () => {
    seedThread();
    useConclaveStore.setState({
      activeThreadId: "th-1",
      activeArtifactId: "art1",
      artifactsById: { art1: { id: "art1", name: "plan", threadId: "th-1" } } as never,
    });
    render(<ChatsScreen />);
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeArtifactId).toBeNull();
  });

  it("back from a dirty editor asks for confirmation and aborts on cancel", () => {
    seedThread();
    useConclaveStore.setState({
      activeThreadId: "th-1",
      activeFsFile: { machine: "m1", path: "/w/a.ts" },
      fsDirty: true,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ChatsScreen />);
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeFsFile).not.toBeNull();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeFsFile).toBeNull();
    confirm.mockRestore();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/ChatsScreen.test.tsx`

- [ ] **Step 3: Implement LazyFsFileView and ChatsScreen**

`packages/web/src/components/LazyFsFileView.tsx`:

```tsx
import { Suspense, lazy } from "react";

// Code-splits CodeMirror (the bulk of the main bundle) into a lazy chunk.
const Inner = lazy(() => import("./FsFileView.js").then((m) => ({ default: m.FsFileView })));

export function LazyFsFileView(): JSX.Element {
  return (
    <Suspense fallback={<div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>loading editor…</div>}>
      <Inner />
    </Suspense>
  );
}
```

`packages/web/src/components/mobile/ChatsScreen.tsx`:

```tsx
import { ChevronLeft } from "lucide-react";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { threadLabel } from "../../lib/labels.js";
import { ArtifactView } from "../ArtifactView.js";
import { Avatar } from "../Avatar.js";
import { Composer } from "../Composer.js";
import { GroupChat } from "../GroupChat.js";
import { LazyFsFileView } from "../LazyFsFileView.js";
import { ChatList } from "./ChatList.js";
import styles from "./mobile.module.css";

export function ChatsScreen(): JSX.Element {
  const activeFsFile = useConclaveStore((s) => s.activeFsFile);
  const activeArtifactId = useConclaveStore((s) => s.activeArtifactId);
  const activeThreadId = useConclaveStore((s) => s.activeThreadId);
  const chatListOpen = useConclaveStore((s) => s.chatListOpen);
  const setChatListOpen = useConclaveStore((s) => s.setChatListOpen);
  const setActiveFsFile = useConclaveStore((s) => s.setActiveFsFile);
  const setActiveArtifact = useConclaveStore((s) => s.setActiveArtifact);
  const thread = useConclaveStore((s) => s.threads.find((t) => t.id === s.activeThreadId));
  const agents = useConclaveStore((s) => s.agents);
  const statusByAgent = useConclaveStore((s) => s.statusByAgent);

  if (activeFsFile) {
    const closeEditor = (): void => {
      // Same dirty guard as the desktop file-open call sites.
      if (useConclaveStore.getState().fsDirty && !window.confirm("discard unsaved changes?")) return;
      setActiveFsFile(null);
    };
    return (
      <div className={styles.detailScreen} data-testid="chats-screen">
        <header className={styles.backHeader}>
          <button className={styles.backBtn} data-testid="mobile-back" aria-label="back" onClick={closeEditor}>
            <ChevronLeft size={18} />
          </button>
          <span className={styles.backTitle}>{activeFsFile.path.split("/").pop()}</span>
        </header>
        <LazyFsFileView />
      </div>
    );
  }

  if (activeArtifactId) {
    return (
      <div className={styles.detailScreen} data-testid="chats-screen">
        <header className={styles.backHeader}>
          <button
            className={styles.backBtn}
            data-testid="mobile-back"
            aria-label="back"
            onClick={() => setActiveArtifact(null)}
          >
            <ChevronLeft size={18} />
          </button>
          <span className={styles.backTitle}>artifact</span>
        </header>
        <ArtifactView />
      </div>
    );
  }

  if (chatListOpen || !thread) {
    return (
      <div className={styles.screen} data-testid="chats-screen">
        <div className={styles.sectionHeader}>chats</div>
        <ChatList />
      </div>
    );
  }

  const agentParticipants = thread.participants.filter((p) => agents.some((a) => a.id === p));
  const running = agentParticipants.filter((p) => statusByAgent[p]?.status === "running").length;

  return (
    <div className={styles.detailScreen} data-testid="chats-screen">
      <header className={styles.backHeader}>
        <button
          className={styles.backBtn}
          data-testid="mobile-back"
          aria-label="back"
          onClick={() => setChatListOpen(true)}
        >
          <ChevronLeft size={18} />
        </button>
        <span className={styles.chatTitleWrap}>
          <span className={styles.backTitle}>{threadLabel(thread.workspace, thread.kind)}</span>
          <span className={styles.chatSub}>
            {running > 0 && <span className={styles.liveDot} />}
            {agentParticipants.length} agents · {running} running
          </span>
        </span>
        <span className={styles.avatarStack}>
          {agentParticipants.slice(0, 3).map((p) => (
            <Avatar key={p} name={p} kind="agent" size={22} />
          ))}
        </span>
      </header>
      <GroupChat />
      <Composer />
    </div>
  );
}
```

Add to `mobile.module.css`:

```css
.detailScreen {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}
.chatTitleWrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.chatSub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-muted);
}
.liveDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--live);
  animation: mobilePulse 1.6s ease-in-out infinite;
}
.avatarStack {
  display: flex;
  gap: 4px;
}
@keyframes mobilePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

- [ ] **Step 4: Run the ChatsScreen test — expect PASS**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/ChatsScreen.test.tsx`
(FsFileView renders inside the dirty-guard test via the lazy import — if jsdom needs the CodeMirror Range stubs they are already in `src/test-setup.ts`; if the lazy chunk resolves asynchronously and the assertion runs before mount, that is fine: the test only asserts store state and the back button, which render synchronously.)

- [ ] **Step 5: Write the failing TerminalsScreen test**

`packages/web/src/components/mobile/__tests__/TerminalsScreen.test.tsx`:

```tsx
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { TerminalsScreen } from "../TerminalsScreen.js";

const term = {
  id: "t1",
  machine: "m1",
  kind: "claude" as const,
  label: "claude-code · pnpm test",
  cwd: "/w",
  agentId: "claude-code",
  startedAt: "2026-07-18T10:00:00.000Z",
};

describe("TerminalsScreen", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("lists terminals when none is active", () => {
    useConclaveStore.setState({ terminals: [term] });
    render(<TerminalsScreen />);
    expect(screen.getByTestId("terminals-section")).toBeTruthy();
    expect(screen.getByText("claude-code · pnpm test")).toBeTruthy();
  });

  it("opens the terminal view when a terminal is active, back returns to the list", () => {
    useConclaveStore.setState({ terminals: [term], activeTerminalId: "t1" });
    render(<TerminalsScreen />);
    expect(screen.getByTestId("terminal-view")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-back"));
    expect(useConclaveStore.getState().activeTerminalId).toBeNull();
  });
});
```

- [ ] **Step 6: Run it — expect FAIL, then implement TerminalsScreen**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/TerminalsScreen.test.tsx`

`packages/web/src/components/mobile/TerminalsScreen.tsx`:

```tsx
import { ChevronLeft } from "lucide-react";
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { TerminalView } from "../TerminalView.js";
import { TerminalsSection } from "../TerminalsSection.js";
import styles from "./mobile.module.css";

export function TerminalsScreen(): JSX.Element {
  const activeTerminalId = useConclaveStore((s) => s.activeTerminalId);
  const setActiveTerminal = useConclaveStore((s) => s.setActiveTerminal);
  const terminals = useConclaveStore((s) => s.terminals);
  const info = terminals.find((t) => t.id === activeTerminalId);

  if (activeTerminalId) {
    return (
      <div className={styles.detailScreen} data-testid="terminals-screen">
        <header className={styles.backHeader}>
          <button
            className={styles.backBtn}
            data-testid="mobile-back"
            aria-label="back"
            onClick={() => setActiveTerminal(null)}
          >
            <ChevronLeft size={18} />
          </button>
          <span className={styles.backTitle}>{info?.label ?? "terminal"}</span>
        </header>
        <TerminalView />
      </div>
    );
  }

  return (
    <div className={styles.screen} data-testid="terminals-screen">
      <div className={styles.termWrap}>
        <TerminalsSection />
      </div>
      {terminals.length === 0 && <div className={styles.empty}>no terminals</div>}
    </div>
  );
}
```

(`TerminalsSection` renders only its header when there are no terminals; the
empty line below it satisfies the spec's empty-state requirement.)

- [ ] **Step 7: Run both screen tests — expect PASS**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/ChatsScreen.test.tsx src/components/mobile/__tests__/TerminalsScreen.test.tsx`

- [ ] **Step 8: Typecheck + commit**

Run: `npx pnpm --filter @conclave/web typecheck`

```bash
git add packages/web/src/components/LazyFsFileView.tsx packages/web/src/components/mobile/
git commit -m "feat(web): mobile Chats and Terminals screens; lazy editor chunk"
```

---

### Task 5: MobileShell + tab bar + App fork + docs + bundle check

**Files:**
- Create: `packages/web/src/components/mobile/MobileTabBar.tsx`
- Create: `packages/web/src/components/mobile/MobileShell.tsx`
- Modify: `packages/web/src/App.tsx`
- Create: `packages/web/src/components/mobile/__tests__/MobileShell.test.tsx`
- Modify: `docs/DEPLOY.md` (add Mobile section)

**Interfaces:**
- Consumes: all four screens (Tasks 2–4), `useIsMobile` + store fields (Task 1), `LazyFsFileView` (Task 4).
- Produces: `MobileShell(): JSX.Element` (testid `mobile-shell`), `MobileTabBar(): JSX.Element` (testids `mobile-tab-bar`, `mobile-tab-<workspace|chats|terminals|status>`, badge `mobile-chats-badge`).

- [ ] **Step 1: Write the failing shell test**

`packages/web/src/components/mobile/__tests__/MobileShell.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useConclaveStore } from "../../../store/useConclaveStore.js";
import { MobileShell } from "../MobileShell.js";

vi.mock("../../../lib/hubClient.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/hubClient.js")>();
  return {
    ...mod,
    hubClient: { ...mod.hubClient, listMessages: vi.fn().mockResolvedValue([]), listMachines: vi.fn().mockResolvedValue([]) },
  };
});

describe("MobileShell", () => {
  beforeEach(() => useConclaveStore.getState().reset());

  it("renders the workspace screen and tab bar initially", () => {
    render(<MobileShell />);
    expect(screen.getByTestId("mobile-shell")).toBeTruthy();
    expect(screen.getByTestId("workspace-screen")).toBeTruthy();
    expect(screen.getByTestId("mobile-tab-bar")).toBeTruthy();
  });

  it("switches screens via the tab bar", () => {
    render(<MobileShell />);
    fireEvent.click(screen.getByTestId("mobile-tab-status"));
    expect(screen.getByTestId("status-screen")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-tab-terminals"));
    expect(screen.getByTestId("terminals-screen")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mobile-tab-chats"));
    expect(screen.getByTestId("chats-screen")).toBeTruthy();
  });

  it("shows the pending-approval badge on the Chats tab", () => {
    useConclaveStore.setState({
      approvalsById: {
        a1: { id: "a1", threadId: "th-1", state: "pending" },
        a2: { id: "a2", threadId: "th-2", state: "pending" },
        a3: { id: "a3", threadId: "th-1", state: "approved" },
      } as never,
    });
    render(<MobileShell />);
    expect(screen.getByTestId("mobile-chats-badge").textContent).toBe("2");
  });

  it("store steering moves the shell to the right tab", () => {
    render(<MobileShell />);
    useConclaveStore.getState().setActiveTerminal("t-x");
    expect(screen.getByTestId("terminals-screen")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/MobileShell.test.tsx`

- [ ] **Step 3: Implement MobileTabBar and MobileShell**

`packages/web/src/components/mobile/MobileTabBar.tsx`:

```tsx
import { Activity, LayoutList, MessageCircle, SquareTerminal } from "lucide-react";
import { useConclaveStore, type MobileTab } from "../../store/useConclaveStore.js";
import styles from "./mobile.module.css";

const TABS: ReadonlyArray<{ id: MobileTab; label: string; Icon: typeof Activity }> = [
  { id: "workspace", label: "Workspace", Icon: LayoutList },
  { id: "chats", label: "Chats", Icon: MessageCircle },
  { id: "terminals", label: "Terminals", Icon: SquareTerminal },
  { id: "status", label: "Status", Icon: Activity },
];

export function MobileTabBar(): JSX.Element {
  const mobileTab = useConclaveStore((s) => s.mobileTab);
  const setMobileTab = useConclaveStore((s) => s.setMobileTab);
  const approvalsById = useConclaveStore((s) => s.approvalsById);
  // Pending-approval threads stand in for unread counts (approved deviation).
  const pendingThreads = new Set(
    Object.values(approvalsById)
      .filter((a) => a.state === "pending")
      .map((a) => a.threadId),
  ).size;

  return (
    <nav className={styles.tabBar} data-testid="mobile-tab-bar">
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={mobileTab === id ? styles.tabActive : styles.tab}
          data-testid={`mobile-tab-${id}`}
          onClick={() => setMobileTab(id)}
        >
          <span className={styles.tabIcon}>
            <Icon size={18} />
            {id === "chats" && pendingThreads > 0 && (
              <span className={styles.tabBadge} data-testid="mobile-chats-badge">
                {pendingThreads}
              </span>
            )}
          </span>
          <span className={styles.tabLabel}>{label}</span>
        </button>
      ))}
    </nav>
  );
}
```

`packages/web/src/components/mobile/MobileShell.tsx`:

```tsx
import { useConclaveStore } from "../../store/useConclaveStore.js";
import { ChatsScreen } from "./ChatsScreen.js";
import { MobileTabBar } from "./MobileTabBar.js";
import { StatusScreen } from "./StatusScreen.js";
import { TerminalsScreen } from "./TerminalsScreen.js";
import { WorkspaceScreen } from "./WorkspaceScreen.js";
import styles from "./mobile.module.css";

export function MobileShell(): JSX.Element {
  const mobileTab = useConclaveStore((s) => s.mobileTab);
  return (
    <div className={styles.shell} data-testid="mobile-shell">
      {mobileTab === "workspace" && <WorkspaceScreen />}
      {mobileTab === "chats" && <ChatsScreen />}
      {mobileTab === "terminals" && <TerminalsScreen />}
      {mobileTab === "status" && <StatusScreen />}
      <MobileTabBar />
    </div>
  );
}
```

Add to `mobile.module.css`:

```css
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
}
.tabBar {
  display: flex;
  background: var(--rail);
  border-top: 1px solid var(--border);
  padding-bottom: env(safe-area-inset-bottom);
}
.tab,
.tabActive {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 0 6px;
  min-height: 48px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}
.tabActive {
  color: var(--text-primary);
}
.tabIcon {
  position: relative;
  display: flex;
}
.tabBadge {
  position: absolute;
  top: -4px;
  right: -10px;
  background: var(--hover);
  color: var(--text-primary);
  border-radius: 8px;
  font-size: 9px;
  padding: 0 4px;
  line-height: 13px;
}
.tabLabel {
  font-size: 11px;
}
```

(All tokens above already exist in `tokens.css`.)

- [ ] **Step 4: Run the shell test — expect PASS**

Run: `npx pnpm --filter @conclave/web exec vitest run src/components/mobile/__tests__/MobileShell.test.tsx`

- [ ] **Step 5: Fork App.tsx**

Replace `packages/web/src/App.tsx` with:

```tsx
import { useEffect } from "react";
import { startSync } from "./store/sync.js";
import { useConclaveStore } from "./store/useConclaveStore.js";
import { useIsMobile } from "./lib/useIsMobile.js";
import { WindowStrip } from "./components/WindowStrip.js";
import { Sidebar } from "./components/Sidebar.js";
import { SessionTabs } from "./components/SessionTabs.js";
import { ContextToolbar } from "./components/ContextToolbar.js";
import { GroupChat } from "./components/GroupChat.js";
import { Composer } from "./components/Composer.js";
import { StatusStrip } from "./components/StatusStrip.js";
import { ArtifactView } from "./components/ArtifactView.js";
import { LazyFsFileView } from "./components/LazyFsFileView.js";
import { TerminalView } from "./components/TerminalView.js";
import { MobileShell } from "./components/mobile/MobileShell.js";
import styles from "./App.module.css";

export function App(): JSX.Element {
  useEffect(() => startSync(), []);
  const isMobile = useIsMobile();
  const activeArtifactId = useConclaveStore((s) => s.activeArtifactId);
  const activeFsFile = useConclaveStore((s) => s.activeFsFile);
  const activeTerminalId = useConclaveStore((s) => s.activeTerminalId);
  if (isMobile) return <MobileShell />;
  return (
    <div className={styles.app} data-testid="app-root">
      <WindowStrip />
      <div className={styles.body}>
        <Sidebar />
        <main className={styles.main}>
          <SessionTabs />
          <ContextToolbar />
          {activeTerminalId ? (
            <TerminalView />
          ) : activeFsFile ? (
            <LazyFsFileView />
          ) : activeArtifactId ? (
            <ArtifactView />
          ) : (
            <>
              <GroupChat />
              <Composer />
            </>
          )}
        </main>
        <StatusStrip />
      </div>
    </div>
  );
}
```

(All hooks run before the `isMobile` branch — hook order is stable across renders. The only desktop change is `FsFileView` → `LazyFsFileView`.)

- [ ] **Step 6: Full web suite + typecheck**

Run: `timeout 180 npx pnpm --filter @conclave/web exec vitest run > /tmp/claude-1000/-home-nyx-ai-Projects-Conclave/d72ac626-53b6-4068-a137-1681ebdb5c73/scratchpad/web-suite.log 2>&1; grep -E "Test Files|Tests " /tmp/claude-1000/-home-nyx-ai-Projects-Conclave/d72ac626-53b6-4068-a137-1681ebdb5c73/scratchpad/web-suite.log`
Expected: all files pass (113 existing + new). Then `npx pnpm --filter @conclave/web typecheck`.

- [ ] **Step 7: Build and verify the code split**

Run: `timeout 300 npx pnpm --filter @conclave/web build 2>&1 | tail -20`
Expected: build succeeds and the output lists a separate `FsFileView-*.js` chunk (CodeMirror weight, several hundred kB) with the main entry chunk substantially smaller than the previous ~912kB. Record both numbers in the report.

- [ ] **Step 8: DEPLOY.md**

Append to the web/UI area of `docs/DEPLOY.md` (near the editor/terminals notes):

```markdown
## Mobile layout

Below 768px the web app renders a bottom-tab mobile shell (Workspace · Chats ·
Terminals · Status) instead of the desktop three-column layout — same hub URL, no
extra setup; add it to the home screen via the existing PWA manifest. Notes:

- The Chats tab badge counts threads with pending approvals (Conclave has no
  read/unread tracking).
- Terminal take-over is desktop-only for now: its entry point (the context
  toolbar's ⇄ button) is not rendered on mobile. Agent terminals opened from the
  Terminals tab are still fully interactive.
- Epic Mode / Fork (context toolbar) are likewise desktop-only.
- Navigating away from an unsaved editor via the tab bar discards edits silently
  (same documented limitation as desktop navigation); the in-editor back button
  asks for confirmation.
```

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/mobile/ packages/web/src/App.tsx docs/DEPLOY.md
git commit -m "feat(web): mobile shell with bottom tab bar; lazy editor on desktop"
```

---

## Manual smoke (record run/not-run in the final report)

On a phone or a ≤768px browser window: navigate all four tabs; open a chat from Workspace; send a message; open a terminal and type; open a file link from chat, edit, save; check Teal theme; check safe-area padding and 44px touch targets; confirm rotating/resizing across 768px swaps shells live.
