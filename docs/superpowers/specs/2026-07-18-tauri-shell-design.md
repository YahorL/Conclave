# Tauri Shell (design) — step 8.5

Date: 2026-07-18
Status: approved (user: "yes")
Step: build-order step 8, sub-project 5 of 5 — THE FINAL SPEC ITEM
Parent: arch spec §9 ("Tauri: webview onto the hub URL, tray + native notifications.
Nothing else Tauri-specific at launch.")

## Goal

A Tauri 2 desktop app (`packages/desktop`) that is a plain window onto the hub URL,
adding a tray icon, close-to-tray, and native notifications delivered over the hub's
existing WebSocket. The remote page gets zero Tauri APIs.

## User-approved decisions

1. **Hub URL via first-run screen**, persisted, editable from the tray ("Change hub
   URL…"). No rebuild to switch hubs.
2. **Close-to-tray**: window close hides; the app (and notifications) keep running;
   tray Quit exits.
3. **Approved deviation from arch spec:** the parenthetical "bundled build as
   fallback" is dropped (YAGNI) — the hub has served the web app itself since step
   5.4; a bundled copy would add a stale-asset + token/config path with no value.

## Security stance

The webview is a plain browser: **no remote capabilities, no Tauri IPC exposed to
the hub page**. All native behavior lives in Rust. The shell obtains the hub token
exactly as any browser does — from the served page (`window.__CONCLAVE_TOKEN__`
injection) — the same single-token trust model DEPLOY.md already documents. The
persisted config holds the hub URL only, never the token (token re-fetched each
start, held in memory).

## Components

### hub (one addition): Notifier ws broadcast

`NotifierDeps` gains optional `broadcast?: (payload: NotifyPayload) => void`.
`fanOut` invokes it (when present) before the push fan-out — so notify frames flow
even with zero push subscriptions. `main.ts` wires it to a broadcast function
exposed by the server that sends `JSON.stringify({ type: "notify", payload })` to
all `/ws` sockets (same mechanism as the existing `usage` frame broadcast; the
`wsSockets` set already exists in server.ts — the plan pins how the hook is
exposed). Daemons and browsers ignore unknown frame types (established behavior —
web `applyFrame` has a default no-op case; daemon ignores unknown frames, verified
in 8.2).

No shared-schema change is required for the MVP (the payload shape
`{title, body, url, tag}` is `NotifyPayload` from `packages/hub/src/notifier.ts`);
the frame is producer-defined like `usage`. Hub test: an approval event yields both
a push send AND a ws `notify` frame; zero-subscription case still broadcasts.

### packages/desktop (new, NOT a pnpm workspace TypeScript package)

A Tauri 2 project; Rust workspace member only in its own Cargo.toml (do not add it
to pnpm-workspace — it has no JS build step). Layout:

- `launcher/index.html` — static, self-contained first-run page (inline CSS matching
  the Black theme palette by value — this page lives outside the token pipeline;
  hex is acceptable here and the no-hex guard only scans packages/web). Input +
  "connect" button; calls the Rust command `set_hub_url(url)`; shows the command's
  error message on failure. No JS framework, no build step.
- `src-tauri/` — Rust app:
  - **config.rs** — `{ hub_url: String }` persisted as JSON at
    `app_config_dir()/config.json`; load (missing/corrupt → None), save. Unit
    tests: round-trip, corrupt-file → None, URL normalization (trim, strip trailing
    `/`, require http(s) scheme).
  - **commands.rs** — `get_hub_url()`; `set_hub_url(url)`: normalize → GET
    `<url>/health` (reqwest, short timeout) → on success persist, navigate the main
    window to the hub URL, (re)start the notify client; on failure return an error
    string for the launcher to display.
  - **notify.rs** — background tokio task: GET `<hubUrl>/` and extract the token
    from the `window.__CONCLAVE_TOKEN__ = "…"` line (unit-tested regex; extraction
    failure → log warn, retry with the ws loop — notifications simply stay off
    until it works); connect `tokio-tungstenite` to `<hubUrl>/ws?token=<token>`
    (verified: the hub's auth hook accepts `?token=` on the upgrade —
    server.ts `query.token === token`); on `{type:"notify"}` frames raise a native notification via
    tauri-plugin-notification (title, body). Notification click → show + focus the
    window and navigate it to `<hubUrl><payload.url>` (reuses the existing
    `?thread=` deep-link). Reconnect with exponential backoff (cap ~30s); token
    re-fetched on each reconnect (hub restart rotates nothing today, but re-fetch
    is free). Frame parse is serde-based and unit-tested (unknown types ignored).
  - **main.rs / lib.rs** — window starts on the launcher when no config, else
    navigates straight to the hub URL; tray icon (generated from the existing
    `packages/web/public/icon-512.png` via `tauri icon`) with menu: Show/Hide,
    "Change hub URL…" (navigates the window to the bundled launcher page and shows
    it), Quit. `WindowEvent::CloseRequested` → `prevent_close()` + hide. Tray
    left-click shows/focuses.
- `tauri.conf.json` — app id `dev.conclave.desktop`, window title "Conclave",
  bundle targets Linux (deb/appimage defaults); CSP left to the hub's pages
  (remote), launcher is inline-only.

### docs

`docs/DEPLOY.md` gains a "Desktop app (Tauri)" section: build prerequisites (Rust +
webkit2gtk-4.1/gtk3), `cargo tauri build`, first-run hub URL, tray/close-to-tray
behavior, notifications note (works while hidden; same events as web push; requires
the hub reachable), and the manual-smoke checklist recorded run/not-run.

## Data flow

Launch → config? → launcher page ⇄ `set_hub_url` (validate /health, persist) →
webview navigates to hub (hub serves the web app + token as for any browser).
In parallel: notify task fetches token → ws connect → hub event → Notifier fanOut →
`notify` frame → native notification → click → show window + navigate to deep link.

## Error handling

- Launcher: invalid scheme / unreachable / non-2xx health → inline error, config
  untouched.
- Configured hub unreachable at startup: the webview shows the webview's own load
  error; tray "Change hub URL…" always recovers. (No custom offline page — YAGNI.)
- Notify task: token extraction or ws failure → warn log + backoff retry loop;
  never crashes the app; Quit aborts the task.
- Corrupt config file → treated as first run.

## Testing (honest)

- Rust unit tests (`cargo test` in src-tauri): config round-trip/corrupt/normalize,
  token-extraction regex (real index.html snippet fixture), notify-frame serde
  (valid, unknown-type ignored, malformed → ignored).
- Hub vitest: Notifier broadcast (with + without subscriptions).
- Compile proof in-sandbox: `cargo check` per task; one `cargo tauri build
  --no-bundle` (or debug build) at the end — toolchain + webkit2gtk verified
  present.
- **Manual smokes NOT runnable in sandbox (no display), recorded in DEPLOY.md:**
  window/tray/close-to-tray behavior, launcher flow, notification display and
  click-through, deep-link navigation.

## Out of scope

- Bundled-frontend fallback (approved deviation); macOS/Windows builds (config is
  cross-platform; only Linux verifiable here); auto-updater; single-instance guard;
  code signing; exposing any Tauri API to the hub page; hub-side changes beyond the
  Notifier broadcast.
