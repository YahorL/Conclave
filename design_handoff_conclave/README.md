# Handoff: Conclave — Multi-Agent Orchestration Workspace (Black theme)

## Overview
Conclave is a desktop-style app for orchestrating multiple coding agents (Claude Code, Codex, a reviewer agent, …) inside project-based workspaces. Agents share one group chat where they brainstorm with the user and each other (@mentions), can DM each other, run real terminals, and report live status, cost, and usage limits. The selected direction is **4a "Black"** — the full mock in `Conclave Directions.dc.html` (section id `4a`).

## About the Design Files
The bundled `Conclave Directions.dc.html` is a **design reference created in HTML** — a static hi-fi mockup showing intended look and structure, not production code. Your task is to **recreate this design in the target codebase's existing environment** (React/Electron/Tauri/etc.) using its established patterns and libraries — or, if no environment exists yet, pick the most appropriate stack for a desktop agent-orchestration app (e.g. Tauri or Electron + React + xterm.js) and implement the design there. Ignore sections `3a`–`3d` in the file — they are earlier color studies kept for reference; **4a is canonical**.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and copy in section 4a are final intent. Recreate pixel-perfectly, adapting only where platform conventions demand.

## Design Tokens

The app ships with **two selectable themes** — Black (default) and Teal. **Add a color-scheme switcher in Settings** that toggles between them; implement all colors below as theme tokens (CSS variables or equivalent), not hardcoded values. Agent identity colors, status colors (running teal dot, blocked yellow, warning amber/red) and usage-bar severity gradients are shared across both themes.

### Theme 1 — Black (default)
Base (pure-black neutral scale):
- App/window chrome & code blocks: `#000000`
- Main surface: `#0d0d0d`
- Sidebar / rails / composer bg: `#050505`
- Raised cards (status, usage): `#0d0d0d`
- Borders (strong): `#333333`; standard: `#1f1f1f` / `#262626`; hairline: `#1a1a1a`
- Hover fill / chips / inline-code bg: `#171717` – `#1f1f1f`

Text:
- Primary / selected: `#f5f5f5`
- Body: `#c9c9c9`
- Secondary: `#8a8a8a` / `#737373`
- Muted / labels / placeholders: `#555555`
- Code text: `#a3a3a3`

Accent policy — **monochrome UI; color = meaning only**:
- Selection: white pill (`#f5f5f5` bg, `#0a0a0a` text), white active-tab top border, white progress bars
- Live/running signal (dots, "● streaming", "● running"): teal `#2dd4bf`
- Blocked/warning: `#facc15`; warning text `#f2a65a`; danger end of gradient `#f87171`
- Agent identity colors (avatars + name labels only): claude-code `#e8a06a` (text `#1a0f06`), codex `#7dd3fc` (text `#06121a`), reviewer `#c4b5fd` (text `#120a1f`)
- Artifact icons: `#f28b82` (plan docs), `#fbbf24` (tickets)
- Usage bar gradients: normal `#d4d4d4`; nearing limit `linear-gradient(90deg,#d4d4d4,#facc15)`; critical `linear-gradient(90deg,#facc15,#f87171)`

### Theme 2 — Teal (reference: section `3a`, screenshot `3a-teal-main.png`)
Same layout and rules; teal is the accent everywhere the Black theme uses white:
- App/window chrome: `#0e1312`; main surface: `#131918`; sidebar/rails/composer: `#101615`; raised cards: `#0f1514`; code/terminal bg: `#0e1312` / `#0b100f`
- Borders: standard `#243230`; hairline `#1c2624`; composer border `#2a3a37`
- Text: primary `#e6edeb`; body `#c9d4d1`; secondary `#93a5a1` / `#7c8c88`; muted `#5f6f6c`; code text `#8fb5ac`
- Accent: `#2dd4bf`; light accent `#5eead4`
- Selection pill: `#124e46` bg with `#eafffb` text (accent-tinted, not white); active-tab top border `#2dd4bf`; icon-rail active underline `#2dd4bf`
- @mentions: plain `#2dd4bf` text (no chip bg); inline code: `#5eead4` mono (no bg); file links `#2dd4bf`; `plan` badge: `#5eead4` text, `#1e4a44` border
- Progress bars: `#2dd4bf` on `#1c2624` track; usage gradients: normal `#2dd4bf`; nearing limit `linear-gradient(90deg,#2dd4bf,#facc15)`; critical unchanged
- Unread badge: `#124e46` bg, `#5eead4` text; `details →` link `#2dd4bf`

### Typography
- UI sans: **IBM Plex Sans** (400/500/600/700)
- Mono (terminals, paths, metrics, section labels): **JetBrains Mono** (400–700)
- Sizes: section labels 10.5px, letter-spacing 2px, uppercase; metadata/timestamps 10–11px; list rows 12.5px; chat body 13px (line-height 1.65); tabs 12.5–13px; terminal 11px (line-height 1.7)

### Spacing & shape
- Sidebar width 272px; right status strip 280px; window tab strip height 44px
- Border radius: cards/rows 7–8px; composer/tabs 10px; window tabs 8px top corners; avatars 5px (agents are squares, humans are circles 50%)
- Row padding ~8–9px 12px; card padding 11–12px; chat gap 16px; progress bars 3px (status) / 5px (usage), radius 2–3px

## Screens / Views

The mock shows one composite main screen. Implement as one window with these regions:

### 1. Window tab strip (top, 44px, `#000`, bottom border `#1f1f1f`)
- Back/forward arrows (muted `#555`)
- Workspace tabs: active tab = `#0d0d0d` bg, `#262626` border (no bottom), radius 8px 8px 0 0, text `#f5f5f5`, close ×; inactive = plain text `#737373`; `+` to add workspace
- Right side: settings ⚙, history ⟲, live workspace spend in mono (`$4.82 · 312k tok`, `#e5e5e5`)

### 2. Left sidebar (272px, `#050505`, right border `#1f1f1f`)
Top icon rail (row of 32×30 buttons): active view has `#171717` bg + 2px white bottom border; icons for chats, terminal, git, panels, invite.

Collapsible sections (header: uppercase mono-ish 10.5px `#555` with `+` action):
- **CHATS** — rows radius 7px. Selected row = **white pill** (`#f5f5f5` bg, `#0a0a0a` text, weight 600). Unselected `#8a8a8a`. Agent-to-agent DM row ("claude-code ↔ codex") has ⇄ icon (`#e8a06a`) and unread badge (`#262626` bg, `#f5f5f5` text, radius 8px).
- **TERMINALS** — JetBrains Mono rows: `❯_` prompt glyph tinted with the owning agent's color, label like `claude-code · pnpm test`, right-aligned pulsing teal dot (7px) when running. A plain `zsh · you` row for the user's own shell. `+` spawns a terminal. Clicking opens it as a session tab (see below).
- **AGENTS** — row: 18px square avatar (agent color, initials), name, right status dot (teal pulsing = running, `#facc15` = blocked).
- **ARTIFACTS** (pinned to bottom, top border) — doc rows with colored doc icons; active artifact has 2px white left border.

### 3. Session tabs (main area top, bg `#050505`, bottom border `#1f1f1f`)
Tabs for open sessions of any type: chat (`❖`), terminal (`❯_` in agent color), artifact (`▦`, italic label). Active tab: 2px white **top** border, `#0d0d0d` bg, text `#f5f5f5`.

### 4. Context toolbar (below tabs, 12px text)
`3 agents ▾` (participant picker) · `▣ payments-service · main ▾` (repo/branch) · `Epic Mode` (white when armed) · `⑂ Fork` · right-aligned mono status `● all changes reviewed` (`#555`).

### 5. Group chat (main column, `#0d0d0d`, padding 20px 26px)
- Message: 26px avatar (square = agent, circle = human/white), header row = name in agent color (600) + timestamp 10.5px `#555` + optional pill badge (e.g. `plan`: `#333` border, `#d4d4d4` text, radius 9px)
- @mentions render as chips: `#1f1f1f` bg, `#f5f5f5` text, padding 0 5px, radius 4px
- Inline code: `#171717` bg, `#e5e5e5`, mono 12px, radius 4px. File paths (`payments/middleware/idem.ts:41`) are underlined links (underline-offset 3px) that open the file
- Code blocks: `#000` bg, `#1f1f1f` border, radius 7px, mono 11.5px `#a3a3a3`, preserved whitespace. **Render each line as its own block element** — do not rely on whitespace text nodes between inline spans
- Typing indicator: avatar + "reviewer is thinking" `#737373` 12px + blinking `▮` cursor (white)
- **Embedded terminal card** (agent's attached terminal streaming into chat, indented 38px): header strip (mono 10px `#555`) = agent name in agent color, `▸ terminal · attached`, right `● streaming` teal pulsing; body `#000`, mono 11px `#a3a3a3`, blinking `_` cursor

### 6. Composer (bottom of chat)
`#050505` bg, `#333` border, radius 10px, padding 13px 16px. White `›` prompt glyph, placeholder `#555` "Message war-room — @agent to direct, /task to assign", right hint `⏎ send` (mono 10.5px). Supports `@agent` autocomplete and `/task` slash command.

### 7. Right status strip (280px, `#050505`, left border)
- **LIVE STATUS** — one card per agent (`#0d0d0d` bg, `#1f1f1f` border, radius 8px): 15px color swatch, name `#f5f5f5` 600, right status (`● running` teal / `● blocked` yellow), one-line activity `#737373`, 3px white progress bar on `#1f1f1f` track
- **USAGE LIMITS** — header row with `details →` link; card containing per-agent meters: 10px swatch, name, right mono metric (`5h · 72%`); 5px bar (gradient per severity — see tokens); footer row mono 10px `#555`: `week 41%` / `resets 16:40`; critical state shows `⚠ throttle soon` in `#f2a65a`
- Footer (pinned, top border): `workspace today` / `$4.82 / $25` mono

## Interactions & Behavior
- Sidebar rows: hover = `#171717` fill; selected chat = white pill; single-click switches the active session tab
- Terminals are first-class sessions: full xterm-style emulation, selectable/scrollable; both user- and agent-owned; agent terminals are read-only-by-default with a "take over" affordance (proposed — confirm)
- Live dots pulse (opacity .5↔1, ~1.6s); typing cursors blink (~1–1.2s)
- Status/usage data updates live (poll or socket); usage meter color escalates at thresholds (suggest ≥70% amber gradient, ≥90% red gradient + throttle warning)
- Chat supports @mention autocomplete, /task command that creates an assigned task, and broadcast (all agents see the room by default)
- `Promote`/artifact flows, Epic Mode, and Fork semantics were not specified in detail — confirm with the user before implementing beyond the visual treatment
- Decision prompts from agents (e.g. reviewer requiring a choice) may render inline action buttons; primary = white bg/black text, secondary = `#333` border

## State Management
- Workspaces[] → each: chats[], terminals[], agents[], artifacts[], spend/budget
- Agent: id, name, color, model, status (running | blocked | idle), currentActivity, progress, usage {windowPct, weekPct, resetsAt}, tokens, cost
- Sessions (tabs): typed union chat | terminal | artifact; active session id persisted per workspace
- Chat: messages[] (author, ts, body, badges, mentions, embeds), typing[] per agent
- Live updates via WebSocket/IPC stream: message events, terminal output chunks, status/usage ticks

## Settings — color scheme switcher
Add a **Color scheme** control in the app Settings (segmented control or select): `Black` (default) / `Teal`. Persist the choice per user; apply instantly by swapping the theme token set. Structure tokens so future themes can be added without touching component code.

## Assets
Screenshots of both themes are in `screenshots/` (`4a-black-main.png`, `3a-teal-main.png`).
No image assets. Icons in the mock are placeholder unicode glyphs (▤ ›_ ⎇ ◫ ❖ ❯_ ▦ ⇄ ⑂ ◉) — replace with the codebase's icon set (Lucide/Phosphor equivalents: layout-list, terminal, git-branch, columns, sparkle, file-text, arrows-left-right, git-fork, message-circle). Fonts: IBM Plex Sans + JetBrains Mono (Google Fonts or self-hosted).

## Files
- `Conclave Directions.dc.html` — design source. Section `id="4a"` is the canonical screen (Black theme); section `id="3a"` is the same screen in the Teal theme. Sections 3b–3d are superseded color studies.
- `screenshots/4a-black-main.png`, `screenshots/3a-teal-main.png` — full-screen captures of both themes.
