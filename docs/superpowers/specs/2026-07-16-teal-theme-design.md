# Teal Theme + Switcher (design) — step 8.1

Date: 2026-07-16
Status: approved (user: "proceed" after design review)
Step: build-order step 8, sub-project 1 of 5 (then: rate-limit-window meters, editor save-back, mobile layout, Tauri shell)
Parent: design_handoff_conclave/README.md (§"Theme 2 — Teal", §"Settings"), arch spec §9

## Goal

Ship the handoff's second theme — Teal — as a full CSS-variable token set, plus a
Settings surface with a Black/Teal switcher (persisted, applied before first
paint). Restructure tokens so future themes are added without touching component
code (handoff requirement).

## User-approved decisions

1. **Order:** Teal first among the step-8 sub-projects (usage meters judged
   already-built; a separate small sub-project will add 5h/weekly rate-limit
   windows later).
2. **Settings UI:** gear button at the bottom of the sidebar icon rail → small
   centered modal with a "Color scheme" segmented control (Black / Teal); closes
   on backdrop click and Escape. Modal is the future home of other settings.
3. **Token structure:** shared tokens hoisted to a base `:root` block; only
   differing tokens live under `:root[data-theme="black"|"teal"]`.
4. **Design-review amendments** (found by role-auditing components against the
   handoff, all approved): the `--accent` split, structural mention/inline-code
   tokens, the `.badge` role fix, and dynamic `<meta name="theme-color">` — all
   detailed below.

## Token restructure (`packages/web/src/styles/tokens.css`)

Three blocks:

**Base `:root`** (shared across themes, per handoff: "Agent identity colors,
status colors and usage-bar severity gradients are shared"):
- the 8 `--agent-*` colors and their `-text` pairs
- `--live: #2dd4bf`, `--blocked: #facc15`, `--warn: #f2a65a`, `--danger: #f87171`
- `--font-sans`, `--font-mono`

**`:root[data-theme="black"]`** — every themed token at today's values, plus the
new role tokens at their Black values (below).

**`:root[data-theme="teal"]`** — the same token names at the handoff §"Theme 2"
values:

| token | black | teal |
| --- | --- | --- |
| `--chrome` | `#000000` | `#0e1312` |
| `--surface` | `#0d0d0d` | `#131918` |
| `--rail` | `#050505` | `#101615` |
| `--card` | `#0d0d0d` | `#0f1514` |
| `--border` | `#1f1f1f` | `#243230` |
| `--border-strong` | `#333333` | `#2a3a37` (composer border) |
| `--border-2` | `#262626` | `#243230` (interpolated: reuse standard border) |
| `--hairline` | `#1a1a1a` | `#1c2624` |
| `--hover` | `#171717` | `#18211f` (interpolated: teal-tinted hover) |
| `--chip` | `#1f1f1f` | `#1c2624` (interpolated: hairline-level chip) |
| `--text-primary` | `#f5f5f5` | `#e6edeb` |
| `--text-body` | `#c9c9c9` | `#c9d4d1` |
| `--text-secondary` | `#8a8a8a` | `#93a5a1` |
| `--text-secondary-2` | `#737373` | `#7c8c88` |
| `--text-muted` | `#555555` | `#5f6f6c` |
| `--text-code` | `#a3a3a3` | `#8fb5ac` |
| `--code-bg` | `#000000` | `#0e1312` (terminal `#0b100f` stays a TerminalView concern) |
| `--inline-code-bg` | `#171717` | `transparent` (teal: "no bg") |
| `--sel-bg` | `#f5f5f5` | `#124e46` |
| `--sel-text` | `#0a0a0a` | `#eafffb` |
| `--usage-normal` | `#d4d4d4` | `#2dd4bf` |
| `--artifact-plan` | `#f28b82` | `#5eead4` |
| `--artifact-ticket` | `#fbbf24` | `#5eead4` (interpolated: handoff themes only `plan`) |
| **new** `--accent` | `#f5f5f5` | `#2dd4bf` |
| **new** `--mention-bg` | `#1f1f1f` | `transparent` |
| **new** `--mention-text` | `#f5f5f5` | `#2dd4bf` |
| **new** `--inline-code-text` | `#e5e5e5` | `#5eead4` |
| **new** `--file-link` | `currentColor` | `#2dd4bf` |
| **new** `--badge-text` | `#d4d4d4` | `#5eead4` (corrected — handoff is explicit: `plan` badge `#5eead4` text; `#93a5a1` was a transcription error) |
| **new** `--badge-border` | `#333333` | `#1e4a44` (handoff: `plan` badge `#1e4a44` border) |
| **new** `--human-avatar-bg` | `#f5f5f5` | `#124e46` (handoff mock: teal human avatar) |
| **new** `--human-avatar-text` | `#0a0a0a` | `#5eead4` |
| **new** `--progress-track` | `#1f1f1f` | `#1c2624` (handoff: progress bars on `#1c2624` track) |

Values marked "interpolated" are not in the handoff (it is silent on those
tokens for Teal); they are teal-tinted picks consistent with its palette and may
be tuned against `screenshots/3a-teal-main.png` during review.

## Component role fixes (the design-review amendments)

1. **`--accent` split.** `--sel-bg` currently paints both the selection pill and
   the accent lines; those diverge in Teal (`#124e46` vs `#2dd4bf`). Repoint the
   accent-role usages to `var(--accent)`:
   - `SessionTabs.module.css` active-tab `border-top-color`
   - `Sidebar.module.css` icon-rail active underline (`border-bottom`)
   - `StatusStrip.module.css` status-card progress fill (line ~70)
   `--sel-bg`/`--sel-text` remain strictly the selection pill (Sidebar row).
2. **Mention / inline code / file links** (`ChatMessage.module.css`):
   `.mention` → `background: var(--mention-bg); color: var(--mention-text);`
   `.inlineCode` → `background: var(--inline-code-bg); color: var(--inline-code-text);`
   (absorbs the hardcoded `#e5e5e5`); `.file` → `color: var(--file-link);`
   (Black `currentColor` preserves today's inherit behavior).
3. **`.badge` role fix** (`ChatMessage.module.css:25`): uses `--usage-normal` as
   a text color — in Teal that token becomes the bright usage-bar teal. Repoint
   to the new `--badge-text`.
4. **Second literal leak:** `WindowStrip.module.css:54` `color: #e5e5e5` →
   `var(--text-body)`.
5. **`<meta name="theme-color">`** (index.html, hardcoded `#0d0d0d`): `setTheme`
   also updates the meta tag to the active theme's `--surface` value so browser
   chrome matches. The PWA manifest colors and app icon are static files and
   stay Black-branded — documented known limitation.

## Switcher

- **Store** (`useConclaveStore`): `theme: "black" | "teal"` (initial: read
  `localStorage["conclave-theme"]`, default `"black"`); `setTheme(t)` sets the
  state, `document.documentElement.dataset.theme = t`, persists to
  localStorage, and updates the theme-color meta.
- **No-flash boot:** a tiny inline script in `packages/web/index.html` `<head>`
  (before the bundle) reads `localStorage["conclave-theme"]` and sets
  `data-theme` on `<html>`; the hardcoded `data-theme="black"` attribute stays
  as the no-JS/first-visit default.
- **Settings surface:** `SettingsModal.tsx` (+ module CSS, tokens only) with a
  "color scheme" segmented control (`Black` / `Teal`, testids `theme-black` /
  `theme-teal`, current selection highlighted); opened by a gear button
  (lucide `Settings`, testid `settings-open`) at the BOTTOM of the sidebar icon
  rail; closes on backdrop click and Escape (testid `settings-modal`).

## Error handling

- Corrupt/unknown localStorage value → treat as `"black"` (both the inline
  script and the store guard with an allowlist).
- localStorage unavailable (private mode) → theme still applies for the session;
  persistence silently no-ops (try/catch).

## Testing

- **Token parity test** (new, `packages/web/src/styles/__tests__/tokens.test.ts`
  or similar): parse `tokens.css` with a regex; assert the `teal` block defines
  exactly the same token names as the `black` block (catches a half-themed
  token silently falling back to nothing). Also assert no `--agent-*`/`--live`/
  `--blocked`/`--warn`/`--danger`/`--font-*` appear in the theme blocks (they
  live in base `:root` only).
- **Store test:** `setTheme("teal")` updates state, `document.documentElement
  .dataset.theme`, localStorage, and the meta tag; allowlist guard on bad
  stored values.
- **SettingsModal test:** gear opens modal; segmented control reflects the
  current theme and switches it; Escape and backdrop close it.
- **Leak regression:** extend or add a test/grep-check asserting no hex literals
  in component CSS (excluding tokens.css) — locks in the cleanup.
- **Manual smoke (honesty):** the no-flash boot script (jsdom can't verify paint
  order) and pixel-fidelity vs `screenshots/3a-teal-main.png` are eyeball-only.
  Record run/not-run.

## Known limitations

- Open xterm terminals keep their construction-time colors until reattach
  (carried from 7.1; noted there).
- PWA manifest colors + icon stay Black-branded (static files).
- The `--artifact-ticket` and interpolated tokens are best-guess Teal values
  pending visual review.
- Teal mentions/inline code keep their Black padding: with a transparent bg the
  padding leaves slight phantom width vs the mock's plain text — accepted
  simplification.
- The sidebar terminal runningDot uses a muted token rather than `--live`
  (pre-existing from 7.1, filed as follow-up).

## Out of scope

- Rate-limit-window meters, editor save-back, mobile layout, Tauri (later
  step-8 sub-projects); any component restructuring beyond the role fixes above.
