# Mobile Layout (design) — step 8.4

Date: 2026-07-18
Status: approved (user: "looks good")
Step: build-order step 8, sub-project 4 of 5 (8.1 Teal ✓, 8.2 meters ✓, 8.3 editor ✓; then Tauri)
Parent: arch spec §clients ("mobile a chat-first responsive layout"), §web ("Mobile:
chat-first, drawers for sidebar/status")
Reference: `design_handoff_conclave_phone/` — updated handoff with a Mobile Version
section (screens 5a–5c, screenshots `5a-phone-chat.png`, `5b-phone-workspace.png`,
`5c-phone-status.png`). The user designated this folder **reference, not authoritative**
("the claude design doesn't know what's already inside the app").

## Goal

Make the web app usable on a phone: a bottom-tab mobile shell (Workspace · Chats ·
Terminals · Status) rendered instead of the three-column desktop layout below a
breakpoint, reusing the existing store, hub client, and inner components. Desktop
markup unchanged.

## User-approved decisions

1. **Bottom tab bar** (phone handoff's paradigm) over the arch spec's drawer sketch —
   the arch spec's "drawers" line is superseded by this spec with user approval.
2. **Keep desktop chat rows** — no bubble restyle; one ChatMessage everywhere (minor
   CSS-only tightening allowed).
3. Take-over from mobile is **out of scope** (its desktop entry point, ContextToolbar,
   is not rendered on mobile) — documented limitation in DEPLOY.md.

## Components (all in packages/web)

### `lib/useIsMobile.ts` (new)

```ts
export function useIsMobile(): boolean
```

`window.matchMedia("(max-width: 768px)")`, subscribed via the `change` event
(`useSyncExternalStore`); reactive to resize/rotation. Breakpoint 768px, defined once
here and mirrored in CSS media queries.

### `App.tsx`

```tsx
const isMobile = useIsMobile();
return isMobile ? <MobileShell /> : (existing desktop tree, byte-for-byte unchanged);
```

`startSync()` effect stays in App (runs for both shells).

### `store/useConclaveStore.ts`

- `mobileTab: "workspace" | "chats" | "terminals" | "status"` (initial `"workspace"`)
  + `setMobileTab(tab)`. In the store (not local state) so activation flows can steer
  it: `setActiveThread` → also `mobileTab = "chats"`; `setActiveTerminal` and the
  `applyFrame` takeover auto-open branch → `mobileTab = "terminals"`;
  `setActiveFsFile` / `setActiveArtifact` → `mobileTab = "chats"` (detail views render
  in the Chats tab). These assignments are unconditional and harmless on desktop
  (nothing reads `mobileTab` there).
- `chatListOpen: boolean` (initial false) + `setChatListOpen(v)` — whether the Chats
  tab shows the thread list instead of the active thread. `setActiveThread` sets it
  false.

### `components/mobile/MobileShell.tsx` (new)

Full-viewport column: `<main>` (active tab's screen) + `<MobileTabBar />`. Renders
`SettingsModal` when open (gear lives on the Workspace screen). No WindowStrip, no
Sidebar, no SessionTabs, no ContextToolbar on mobile.

### `components/mobile/MobileTabBar.tsx` (new)

Fixed-height bottom bar per mock 5b: bg `var(--sidebar-bg)`, top border
`var(--border-standard)`, four buttons (glyph + 11px label): `▤ Workspace`,
`❖ Chats`, `❯_ Terminals`, `◉ Status`. Active `var(--text-primary)`, inactive
`var(--text-muted)`. Chats button shows a badge (existing unread-badge tokens) with
the sum of per-thread unread counts when > 0. `padding-bottom:
env(safe-area-inset-bottom)`; each target ≥ 44px tall. `data-testid="mobile-tab-<id>"`.

### `components/mobile/WorkspaceScreen.tsx` (new) — mock 5b

- Header: workspace name (20px 700), mono sub-line `<branch> · $<spent> / $<budget>
  today` (branch from workspace data; spend from usage summary totals — omit segments
  whose data is absent), right: ⚙ gear (opens SettingsModal). When more than one
  workspace exists, the name is a `<select>`-backed switcher (native select styled to
  match; simplest reliable control on mobile).
- Sections as card lists (cards: `var(--card-bg)` bg, `var(--border-standard)` border,
  radius 12px, padding ~13px 15px, min-height 44px; section headers uppercase 10.5px
  muted, `+` action where one exists today):
  - **CHATS** — title + preview line (last message snippet, muted 11.5px), unread
    badge; selected thread card uses the selection-pill tokens (`--sel-bg`/`--sel-text`).
    Tap → `setActiveThread(id)` (which flips to the Chats tab).
  - **TERMINALS** — mono rows: `❯_` glyph in owning agent's color, label, pulsing
    live dot when running. Tap → `setActiveTerminal(id)`. `+` opens the existing
    spawn picker (TerminalsSection's picker, reused or extracted).
  - **AGENTS** — avatar, name, activity line, right status (`● running` /
    `● blocked` etc., existing status tokens). Not tappable.
  - **ARTIFACTS** — doc rows; tap → `setActiveArtifact(id)`.

### `components/mobile/ChatsScreen.tsx` (new) — mock 5a

Three states, checked in order:

1. `activeFsFile` → `<FsFileView />` full-screen under a back header (‹ back clears
   `activeFsFile`, returning to the thread). Dirty guard: back uses the same
   `fsDirty && !confirm("discard unsaved changes?")` check as the desktop call sites.
2. `activeArtifactId` → `<ArtifactView />` under a back header (‹ clears it).
3. Otherwise: if `chatListOpen` or no `activeThreadId` → thread list (same card idiom
   as WorkspaceScreen's CHATS section); else the active thread: header (‹ back →
   `setChatListOpen(true)`; title; live sub-line `N agents · M running` from the
   thread's participants × agent statuses, with pulsing teal dot when M > 0; right
   avatar stack of participant avatars 22px) above the existing `<GroupChat />` +
   `<Composer />`.

### `components/mobile/TerminalsScreen.tsx` (new)

- `activeTerminalId` set → `<TerminalView />` full-screen under a back header
  (‹ clears `activeTerminalId`; kill stays inside TerminalView).
- Else: terminal card list (same rows as WorkspaceScreen's TERMINALS) + `+` spawn
  picker.

### `components/mobile/StatusScreen.tsx` (new) — mock 5c

Header "Status" + mono sub-line `<workspace> · live`, then StatusStrip's content
full-width: LIVE STATUS agent cards, USAGE LIMITS meters, `workspace today` footer.
**Reuse, don't duplicate:** extract StatusStrip's three sections into exported pieces
(`LiveStatusCards`, `UsageLimitsCard`, `WorkspaceTodayFooter` — one module, minimal
props) consumed by both StatusStrip (unchanged appearance) and StatusScreen.

### CSS / viewport

- `index.html` viewport meta gains `viewport-fit=cover`.
- Mobile modules use safe-area env() padding (header top, tab bar bottom).
- All colors via existing theme tokens (Black + Teal both work; the
  no-hex-in-components guard test already enforces this for the new components).
- Touch targets ≥ 44px on all mobile interactive rows/buttons.

### FsFileView code-split (folded-in follow-up)

`React.lazy(() => import("./FsFileView.js"))` + `<Suspense fallback>` at both usage
sites (desktop App, ChatsScreen) — moves CodeMirror (~500kB of the 912kB bundle) into
a lazy chunk. Verify with `npx pnpm --filter @conclave/web build` output.

## Data flow

No new backend calls, sockets, or frames. Mobile screens read the same store slices
the desktop components do; activation setters gain tab-steering side effects only.

## Error handling

- Connection-lost / failed-load states live inside the reused inner components
  (GroupChat, TerminalView, FsFileView, ArtifactView) and carry over unchanged.
- No workspaces / no threads / no terminals → each list renders its section header
  with an empty state line (muted text, e.g. `no terminals`), not a blank screen.
- Usage summary absent (hub starting) → Workspace header omits the spend sub-line
  segment; StatusScreen renders the same empty states StatusStrip has today.

## Testing

- `useIsMobile`: matchMedia mock — initial value, change-event reactivity.
- Store: `setActiveThread`/`setActiveTerminal`/`setActiveFsFile`/`setActiveArtifact`
  steer `mobileTab`; takeover `applyFrame` branch sets `mobileTab = "terminals"`;
  `chatListOpen` transitions.
- MobileShell: renders the right screen per tab; tab bar switches; Chats badge sums
  unread counts; desktop tree absent under mobile matchMedia and vice versa.
- WorkspaceScreen: cards render from store fixtures; chat tap activates thread and
  lands on Chats tab; empty states.
- ChatsScreen: three-state precedence (fsFile > artifact > chat/list); back-chevron
  transitions; dirty guard on back (mock confirm).
- TerminalsScreen: list ↔ view; auto-open on takeover fixture.
- StatusScreen: reuses the extracted sections (meters severity classes already tested
  in 8.2 — smoke one render here).
- **Honesty note:** real phone rendering, safe-area insets, and touch ergonomics are
  eyeball-only; jsdom has no layout. Record the manual smoke (open on a phone or
  narrow browser: navigate all four tabs, open chat/terminal/editor, rotate) as
  run/not-run. Bundle-split verified by build output, not by test.

## Out of scope

- Message bubbles (kept desktop rows); take-over from mobile; swipe gestures;
  workspace creation on mobile; drawers (superseded); Epic Mode / Fork on mobile
  (ContextToolbar not rendered); Tauri shell (8.5); PWA changes (manifest/sw shipped
  in web-push).
