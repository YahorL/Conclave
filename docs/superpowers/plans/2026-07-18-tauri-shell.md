# Tauri Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri 2 desktop app (`packages/desktop`) that is a plain window onto the hub URL, adding a tray icon, close-to-tray, and native notifications delivered over the hub's existing WebSocket.

**Architecture:** Task 1 is a pure-TypeScript hub change (Notifier also broadcasts a `notify` ws frame). Tasks 2–5 build a Rust/Tauri app whose webview loads the hub URL with zero Tauri APIs exposed; all native behavior (config, tray, notifications) is Rust-side. Pure Rust functions (config, token extraction, frame parsing) are TDD'd with `cargo test`; the Tauri wiring is compile-gated with `cargo build` plus manual smoke.

**Tech Stack:** Node/TypeScript + vitest (hub); Rust + Tauri 2 + tauri-plugin-notification + tokio + tokio-tungstenite + reqwest + serde (desktop).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-18-tauri-shell-design.md`.
- The remote hub page gets **zero Tauri APIs / no remote capabilities** — do not expose `invoke` or any command to loaded hub URLs; commands are only used by the bundled launcher page.
- Config persists the **hub URL only, never the token** (token is re-fetched from the served page each start, held in memory).
- Notify frame shape on the wire: `{"type":"notify","payload":{"title":…,"body":…,"url":…,"tag":…}}` — `payload` is the hub's `NotifyPayload`.
- `/ws` auth: append `?token=<token>` to the upgrade URL (verified against the hub's onRequest hook: `query.token === token`).
- `packages/desktop` is **NOT** a pnpm workspace member (no JS build). Do not add it to `pnpm-workspace.yaml`. It is a standalone Cargo project under `packages/desktop/src-tauri`.
- Rust toolchain is at `~/.cargo/bin` (cargo 1.95). System deps webkit2gtk-4.1 / gtk3 / libsoup-3.0 are present. The Tauri CLI is NOT installed — build with plain `cargo build` / `cargo test` against the manifest, never `cargo tauri`.
- Rust builds are heavy (first build compiles hundreds of crates + links webkit): use `timeout 600000` on the first `cargo build`, and never run another heavy command concurrently (the box has ~12GB RAM).
- Tauri 2 minor-API drift: if a specific method signature fails to compile, treat the compiler error as the source of truth and adapt the call while preserving the documented behavior; note any such adaptation in the report.
- Hub tests run from repo root: `npx vitest run packages/hub/test/<file>`. ESM `.js` specifiers in hub TS.
- Every commit message ends with the footer line `Claude-Session: https://claude.ai/code/session_01MJ8FKhtSEmDL7SuhNtRrGN`.

---

### Task 1: Hub — Notifier broadcasts a `notify` ws frame

**Files:**
- Modify: `packages/hub/src/notifier.ts`
- Modify: `packages/hub/src/server.ts`
- Modify: `packages/hub/src/main.ts`
- Test: `packages/hub/test/notifier.test.ts` (extend if it exists, else create)
- Test: `packages/hub/test/notify-frame.test.ts` (new, server-level)

**Interfaces:**
- Produces: `NotifierDeps.broadcast?: (payload: NotifyPayload) => void`; a `HubApp` type = `FastifyInstance & { broadcastNotify(payload: NotifyPayload): void }` returned by `buildServer`; the wire frame `{ type: "notify", payload }`.
- Consumes: existing `NotifyPayload` (exported from `notifier.ts`), `wsSockets` set in `server.ts`.

- [ ] **Step 1: Write the failing Notifier unit test**

Check whether `packages/hub/test/notifier.test.ts` exists (`ls packages/hub/test/notifier.test.ts`). If it does, ADD these cases; if not, create the file with them. The test drives the Notifier through a real approval event and asserts the broadcast fires independently of push subscriptions.

```ts
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Notifier, type NotifyPayload } from "../src/notifier.js";
import type { Approval } from "@conclave/shared";

function makeApproval(): Approval {
  return {
    id: "ap1",
    threadId: "th1",
    requestedBy: "claude-code",
    action: "deploy to prod",
    idempotencyKey: "k1",
    state: "pending",
    createdAt: "2026-07-18T10:00:00.000Z",
  } as Approval;
}

describe("Notifier broadcast", () => {
  it("broadcasts a notify payload even with zero push subscriptions", async () => {
    const mailboxEvents = new EventEmitter();
    const broadcast = vi.fn<[NotifyPayload], void>();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = new Notifier({
      mailboxEvents,
      store: { list: () => [], remove: () => {} } as never,
      send,
      broadcast,
    });
    notifier.start();
    mailboxEvents.emit("approval", makeApproval());
    await notifier.idle();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]![0]).toMatchObject({ title: expect.any(String), url: expect.any(String) });
    expect(send).not.toHaveBeenCalled(); // no subscriptions
    notifier.stop();
  });

  it("broadcasts AND push-sends when a subscription exists", async () => {
    const mailboxEvents = new EventEmitter();
    const broadcast = vi.fn<[NotifyPayload], void>();
    const send = vi.fn().mockResolvedValue(undefined);
    const sub = { endpoint: "https://push.example/x", keys: { p256dh: "a", auth: "b" } };
    const notifier = new Notifier({
      mailboxEvents,
      store: { list: () => [sub], remove: () => {} } as never,
      send,
      broadcast,
    });
    notifier.start();
    mailboxEvents.emit("approval", makeApproval());
    await notifier.idle();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    notifier.stop();
  });
});
```

(If `notifier.test.ts` already imports helpers/fixtures, reuse them rather than duplicating; keep the two assertions above.)

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run packages/hub/test/notifier.test.ts`
Expected: FAIL — `broadcast` is not an accepted dep / never called.

- [ ] **Step 3: Add `broadcast` to the Notifier**

In `packages/hub/src/notifier.ts`, add to `NotifierDeps`:

```ts
  broadcast?: (payload: NotifyPayload) => void;
```

In `fanOut`, call the broadcast before the push fan-out (so it fires even with no subscriptions). The method currently starts:

```ts
  private fanOut(payload: NotifyPayload | null): void {
    if (!payload) return;
```

Insert immediately after that guard:

```ts
    this.deps.broadcast?.(payload);
```

- [ ] **Step 4: Run the Notifier test — expect PASS**

Run: `npx vitest run packages/hub/test/notifier.test.ts`

- [ ] **Step 5: Write the failing server-level test**

`packages/hub/test/notify-frame.test.ts` — this mirrors the real ws-client pattern in `packages/hub/test/terminals.test.ts` (open a listening server on port 0, connect a `ws` client with `?token=`, collect frames):

```ts
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { buildServer, type HubApp } from "../src/server.js";
import { Mailbox } from "../src/mailbox.js";

const TOKEN = "t0";

interface Frame { type: string; payload?: { title?: string; url?: string } }

describe("broadcastNotify", () => {
  let app: HubApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("sends a notify frame to connected ws sockets", async () => {
    const db = new Database(":memory:");
    const mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN } as never);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const seen: Frame[] = [];
    ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Frame));
    await new Promise((r) => ws.on("open", r));

    app.broadcastNotify({ title: "t", body: "b", url: "/?thread=th1", tag: "x" });
    await new Promise((r) => setTimeout(r, 50));

    const notify = seen.find((f) => f.type === "notify");
    expect(notify).toBeDefined();
    expect(notify!.payload).toMatchObject({ title: "t", url: "/?thread=th1" });
    ws.close();
  });
});
```

**Note to implementer:** if `buildServer`'s required options are more than `{ mailbox, token }` (check `ServerOptions`), copy the minimal option set from `terminals.test.ts`'s server build — the point is a running server with a `/ws` route, not a full hub. `Mailbox`'s constructor takes the sqlite `db` (verified). The `as never` cast on the options mirrors the existing hub-test idiom for partial option objects.

- [ ] **Step 6: Run it — expect FAIL** (`HubApp` / `broadcastNotify` missing)

Run: `npx vitest run packages/hub/test/notify-frame.test.ts`

- [ ] **Step 7: Expose `broadcastNotify` from the server**

In `packages/hub/src/server.ts`:

Add an import of the payload type near the top (with the other imports):

```ts
import type { NotifyPayload } from "./notifier.js";
```

Add the exported type (near the top-level exports, e.g. above `buildServer`):

```ts
export type HubApp = FastifyInstance & { broadcastNotify(payload: NotifyPayload): void };
```

Inside `buildServer`, right after the existing `broadcastTerminalList` closure (which is defined just after `const wsSockets = …`), add:

```ts
  const broadcastNotify = (payload: NotifyPayload): void => {
    const raw = JSON.stringify({ type: "notify", payload });
    for (const s of wsSockets) s.send(raw);
  };
```

At the end of `buildServer`, the function currently does `return app;`. Change it to attach the method and return the widened type:

```ts
  (app as HubApp).broadcastNotify = broadcastNotify;
  return app as HubApp;
```

Change the function signature return type from `Promise<FastifyInstance>` to `Promise<HubApp>` (line ~74: `export async function buildServer(opts: ServerOptions): Promise<HubApp> {`). Ensure `FastifyInstance` is imported (it is — check the existing import; if `buildServer` currently returns `Promise<FastifyInstance>`, the type is already imported).

- [ ] **Step 8: Run the server test — expect PASS**

Run: `npx vitest run packages/hub/test/notify-frame.test.ts`

- [ ] **Step 9: Wire the broadcast in main.ts**

In `packages/hub/src/main.ts`, the Notifier is currently constructed and started BEFORE `buildServer`. Reorder so the app is built first, then the Notifier receives the broadcast. Concretely:

1. Move the whole `new Notifier({ … }).start();` block to AFTER the `const app = await buildServer({ … });` call.
2. Add `broadcast: (payload) => app.broadcastNotify(payload),` to the `NotifierDeps` object (alongside `mailboxEvents`, `statusEvents`, `store`, `send`).
3. Keep a reference so it can be started: change `new Notifier({ … }).start();` to

```ts
const notifier = new Notifier({
  mailboxEvents: mailbox.events,
  statusEvents: status.events,
  store: push,
  broadcast: (payload) => app.broadcastNotify(payload),
  send: async (sub, payload) => {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
    );
  },
});
notifier.start();
```

placed after `buildServer`. Confirm `push` and `webpush`/`vapid` setup still precede this (they do — they're above the current Notifier block; moving the Notifier down keeps them in scope).

- [ ] **Step 10: Typecheck + full hub suite**

Run: `npx pnpm --filter @conclave/hub typecheck` then `npx vitest run packages/hub/test`
Expected: typecheck clean; all hub tests pass (the reorder is behavior-preserving; broadcast is additive).

- [ ] **Step 11: Commit**

```bash
git add packages/hub/src/notifier.ts packages/hub/src/server.ts packages/hub/src/main.ts packages/hub/test/notifier.test.ts packages/hub/test/notify-frame.test.ts
git commit -m "feat(hub): broadcast notify frame over ws for desktop shell"
```

---

### Task 2: Desktop scaffold — Cargo project, launcher, config module

**Files:**
- Create: `packages/desktop/src-tauri/Cargo.toml`
- Create: `packages/desktop/src-tauri/build.rs`
- Create: `packages/desktop/src-tauri/tauri.conf.json`
- Create: `packages/desktop/src-tauri/src/main.rs`
- Create: `packages/desktop/src-tauri/src/lib.rs`
- Create: `packages/desktop/src-tauri/src/config.rs`
- Create: `packages/desktop/src-tauri/icons/icon.png` (copied from web icon)
- Create: `packages/desktop/launcher/index.html`
- Create: `packages/desktop/.gitignore`

**Interfaces:**
- Produces: `config::{Config, normalize_url, load, save}` — `Config { hub_url: String }`; `normalize_url(&str) -> Result<String, String>` (trim, strip trailing `/`, require http/https); `load(&Path) -> Option<Config>`; `save(&Path, &Config) -> std::io::Result<()>`. `run()` in lib.rs is the Tauri entry point.

- [ ] **Step 1: Create the Cargo manifest and build script**

`packages/desktop/src-tauri/Cargo.toml`:

```toml
[package]
name = "conclave-desktop"
version = "0.1.0"
edition = "2021"
description = "Conclave desktop shell"

[lib]
name = "conclave_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["blocking"] }
tokio = { version = "1", features = ["rt-multi-thread", "time", "macros"] }
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-native-roots"] }
futures-util = "0.3"
url = "2"

[features]
# default features intentionally empty
```

`packages/desktop/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 2: Create tauri.conf.json (v2 schema, static launcher, no JS build)**

`packages/desktop/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Conclave",
  "version": "0.1.0",
  "identifier": "dev.conclave.desktop",
  "build": {
    "frontendDist": "../launcher"
  },
  "app": {
    "windows": [
      {
        "title": "Conclave",
        "width": 1200,
        "height": 800,
        "resizable": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.png"]
  }
}
```

- [ ] **Step 3: Copy an icon**

Run:
```bash
mkdir -p packages/desktop/src-tauri/icons
cp packages/web/public/icon-512.png packages/desktop/src-tauri/icons/icon.png
```

- [ ] **Step 4: Launcher page**

`packages/desktop/launcher/index.html` (self-contained, Black-theme palette by value — this page is outside the token pipeline and the no-hex guard only scans `packages/web`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Conclave — connect</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
        background: #0d0d0d; color: #f5f5f5;
        font-family: "IBM Plex Sans", system-ui, sans-serif;
      }
      .card { width: 340px; }
      h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
      p { color: #8a8a8a; font-size: 12.5px; margin: 0 0 16px; }
      label { display: block; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #737373; margin-bottom: 6px; }
      input {
        width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
        border: 1px solid #333; background: #050505; color: #f5f5f5; font-size: 13px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
      }
      button {
        margin-top: 12px; width: 100%; padding: 10px; border: none; border-radius: 8px;
        background: #f5f5f5; color: #0a0a0a; font-size: 13px; font-weight: 600; cursor: pointer;
      }
      button:disabled { opacity: .5; cursor: default; }
      .err { margin-top: 10px; color: #f87171; font-size: 12px; min-height: 15px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connect to your hub</h1>
      <p>Enter the URL of your Conclave hub.</p>
      <label for="url">Hub URL</label>
      <input id="url" type="text" placeholder="http://localhost:8787" autocomplete="off" />
      <button id="go">Connect</button>
      <div class="err" id="err"></div>
    </div>
    <script>
      const { invoke } = window.__TAURI__.core;
      const input = document.getElementById("url");
      const btn = document.getElementById("go");
      const err = document.getElementById("err");
      invoke("get_hub_url").then((u) => { if (u) input.value = u; }).catch(() => {});
      async function connect() {
        err.textContent = "";
        btn.disabled = true;
        try {
          await invoke("set_hub_url", { url: input.value });
        } catch (e) {
          err.textContent = String(e);
          btn.disabled = false;
        }
      }
      btn.addEventListener("click", connect);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
    </script>
  </body>
</html>
```

(The launcher is the ONLY page allowed to use `window.__TAURI__` — it is bundled and local, not the remote hub page.)

- [ ] **Step 5: Write the failing config tests**

`packages/desktop/src-tauri/src/config.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub hub_url: String,
}

/// Trim, strip a single trailing slash, and require an http(s) scheme.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("hub URL is empty".into());
    }
    let parsed = url::Url::parse(t).map_err(|_| "not a valid URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("URL must start with http:// or https://".into());
    }
    Ok(t.trim_end_matches('/').to_string())
}

pub fn load(path: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(config).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_trailing_slash_and_trims() {
        assert_eq!(normalize_url("  http://localhost:8787/  ").unwrap(), "http://localhost:8787");
        assert_eq!(normalize_url("https://hub.example").unwrap(), "https://hub.example");
    }

    #[test]
    fn normalize_rejects_bad_scheme_and_empty() {
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("localhost:8787").is_err());
        assert!(normalize_url("   ").is_err());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!("conclave-cfg-{}", std::process::id()));
        let path = dir.join("config.json");
        let cfg = Config { hub_url: "http://localhost:8787".into() };
        save(&path, &cfg).unwrap();
        assert_eq!(load(&path), Some(cfg));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_or_corrupt_returns_none() {
        assert_eq!(load(Path::new("/nonexistent/conclave/config.json")), None);
        let dir = std::env::temp_dir().join(format!("conclave-corrupt-{}", std::process::id()));
        let path = dir.join("config.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 6: Minimal main.rs / lib.rs so the crate compiles and tests run**

`packages/desktop/src-tauri/src/lib.rs`:

```rust
mod config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`packages/desktop/src-tauri/src/main.rs`:

```rust
// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    conclave_desktop_lib::run()
}
```

- [ ] **Step 7: `.gitignore` for Rust build output**

`packages/desktop/.gitignore`:

```
src-tauri/target/
```

- [ ] **Step 8: Run the config unit tests (compiles the crate as a lib)**

Run: `cd packages/desktop/src-tauri && timeout 600000 ~/.cargo/bin/cargo test --lib 2>&1 | tail -25; cd -`
Expected: first run downloads + compiles many crates (slow), then `test result: ok. 4 passed`. If the Tauri app fails to fully link here it's fine — `--lib` compiles and runs the config module tests without building the full binary. If linking the binary is triggered and fails on a Tauri API detail, note it; the config tests themselves must pass.

- [ ] **Step 9: Commit**

```bash
git add packages/desktop
git commit -m "feat(desktop): tauri scaffold, launcher page, config module with tests"
```

---

### Task 3: Hub-URL commands + startup routing

**Files:**
- Create: `packages/desktop/src-tauri/src/commands.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `config::{Config, normalize_url, load, save}`.
- Produces: Tauri commands `get_hub_url() -> Option<String>` and `set_hub_url(url: String) -> Result<(), String>`; a `config_path(&AppHandle) -> PathBuf` helper; `navigate_to_hub(&AppHandle, &str)` helper; startup logic in `run()` that loads config and, when present, navigates the main window to the hub URL (else stays on the launcher).

- [ ] **Step 1: Write the failing normalize-guard test in commands.rs**

The command's network path (health check) is not unit-testable without a server, so the TDD unit here targets the pure guard the command relies on. `packages/desktop/src-tauri/src/commands.rs`:

```rust
use crate::config::{self, Config};
use tauri::{AppHandle, Manager, Runtime};
use std::path::PathBuf;

fn config_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("no app config dir")
        .join("config.json")
}

pub fn navigate_to_hub<R: Runtime>(app: &AppHandle<R>, hub_url: &str) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(u) = url::Url::parse(hub_url) {
            let _ = win.navigate(u);
        }
    }
}

#[tauri::command]
pub fn get_hub_url<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    config::load(&config_path(&app)).map(|c| c.hub_url)
}

#[tauri::command]
pub fn set_hub_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let normalized = config::normalize_url(&url)?;
    // Validate reachability against the hub health endpoint.
    let health = format!("{normalized}/health");
    let resp = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?
        .get(&health)
        .send()
        .map_err(|_| "could not reach the hub at that URL".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("hub health check failed ({})", resp.status()));
    }
    config::save(&config_path(&app), &Config { hub_url: normalized.clone() })
        .map_err(|e| e.to_string())?;
    navigate_to_hub(&app, &normalized);
    crate::notify::restart(&app, &normalized); // defined in Task 4; see note
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::config::normalize_url;

    #[test]
    fn command_relies_on_normalize_guard() {
        // The command rejects bad input via normalize_url before any I/O.
        assert!(normalize_url("nonsense").is_err());
        assert_eq!(normalize_url("http://h/").unwrap(), "http://h");
    }
}
```

**Important:** `crate::notify::restart` does not exist until Task 4. To keep this task compiling on its own, in THIS task add a temporary no-op module at the bottom of `lib.rs`:

```rust
pub mod notify {
    use tauri::{AppHandle, Runtime};
    // Placeholder replaced in Task 4.
    pub fn restart<R: Runtime>(_app: &AppHandle<R>, _hub_url: &str) {}
}
```

Task 4 replaces this with the real module (its own file). Alternatively omit the `crate::notify::restart` line here and add it in Task 4 — but including it now keeps the wiring visible. Implementer's choice; if omitting, delete the placeholder too.

- [ ] **Step 2: Run the guard test — expect FAIL** (module not yet wired)

Run: `cd packages/desktop/src-tauri && ~/.cargo/bin/cargo test --lib commands 2>&1 | tail -15; cd -`
Expected: FAIL to compile until Step 3 wires the module.

- [ ] **Step 3: Wire commands + startup routing in lib.rs**

Replace `packages/desktop/src-tauri/src/lib.rs` with:

```rust
mod commands;
mod config;

pub mod notify {
    use tauri::{AppHandle, Runtime};
    // Placeholder replaced in Task 4.
    pub fn restart<R: Runtime>(_app: &AppHandle<R>, _hub_url: &str) {}
}

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_hub_url,
            commands::set_hub_url
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let path = app
                .path()
                .app_config_dir()
                .expect("no app config dir")
                .join("config.json");
            if let Some(cfg) = config::load(&path) {
                commands::navigate_to_hub(&handle, &cfg.hub_url);
                notify::restart(&handle, &cfg.hub_url);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Run the commands test — expect PASS**

Run: `cd packages/desktop/src-tauri && timeout 600000 ~/.cargo/bin/cargo test --lib 2>&1 | tail -20; cd -`
Expected: all config + commands unit tests pass (`5 passed` total). Compilation of the command handlers proves the Tauri command/AppHandle API usage.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src/commands.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): hub-url commands with health check and startup routing"
```

---

### Task 4: Native notifications over the hub WebSocket

**Files:**
- Create: `packages/desktop/src-tauri/src/notify.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs` (replace the placeholder `notify` module with `mod notify;`)

**Interfaces:**
- Consumes: `config` (hub URL string), Tauri `AppHandle`, tauri-plugin-notification.
- Produces: `notify::restart(&AppHandle, &str)` (aborts any running task, spawns a fresh one); `notify::extract_token(&str) -> Option<String>`; `notify::NotifyFrame` (serde) + `notify::parse_frame(&str) -> Option<NotifyPayload>`.

- [ ] **Step 1: Write the failing extraction + frame-parse tests**

`packages/desktop/src-tauri/src/notify.rs`:

```rust
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Deserialize, PartialEq)]
pub struct NotifyPayload {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub tag: String,
}

#[derive(Debug, Deserialize)]
struct NotifyFrame {
    r#type: String,
    payload: NotifyPayload,
}

/// Pull the injected hub token out of the served index.html.
pub fn extract_token(html: &str) -> Option<String> {
    let marker = "__CONCLAVE_TOKEN__";
    let idx = html.find(marker)?;
    let after = &html[idx + marker.len()..];
    let q1 = after.find('"')?;
    let rest = &after[q1 + 1..];
    let q2 = rest.find('"')?;
    let token = &rest[..q2];
    if token.is_empty() || token == "CONCLAVE_TOKEN_PLACEHOLDER" {
        return None;
    }
    Some(token.to_string())
}

/// Parse a ws text frame; return the payload only for `{"type":"notify",…}`.
pub fn parse_frame(text: &str) -> Option<NotifyPayload> {
    let frame: NotifyFrame = serde_json::from_str(text).ok()?;
    if frame.r#type != "notify" {
        return None;
    }
    Some(frame.payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_real_token_ignoring_placeholder() {
        let html = r#"<script>window.__CONCLAVE_TOKEN__ = "abc123";</script>"#;
        assert_eq!(extract_token(html), Some("abc123".to_string()));
        let placeholder = r#"window.__CONCLAVE_TOKEN__ = "CONCLAVE_TOKEN_PLACEHOLDER";"#;
        assert_eq!(extract_token(placeholder), None);
        assert_eq!(extract_token("no token here"), None);
    }

    #[test]
    fn parses_only_notify_frames() {
        let ok = r#"{"type":"notify","payload":{"title":"T","body":"B","url":"/?thread=x","tag":"g"}}"#;
        assert_eq!(
            parse_frame(ok),
            Some(NotifyPayload { title: "T".into(), body: "B".into(), url: "/?thread=x".into(), tag: "g".into() })
        );
        assert!(parse_frame(r#"{"type":"usage","summary":{}}"#).is_none());
        assert!(parse_frame("not json").is_none());
    }
}
```

- [ ] **Step 2: Run the tests — expect FAIL** (module not declared)

Run: `cd packages/desktop/src-tauri && ~/.cargo/bin/cargo test --lib notify 2>&1 | tail -15; cd -`
Expected: FAIL — `notify` still the placeholder module in lib.rs.

- [ ] **Step 3: Add the runtime task (ws client + notification raising)**

Append to `notify.rs`:

```rust
// Holds the abort handle for the current notify task so restart() can cancel it.
static TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

/// Cancel any running notify loop and spawn a fresh one for `hub_url`.
pub fn restart<R: Runtime>(app: &AppHandle<R>, hub_url: &str) {
    let mut guard = TASK.lock().unwrap();
    if let Some(handle) = guard.take() {
        handle.abort();
    }
    let app = app.clone();
    let hub_url = hub_url.to_string();
    *guard = Some(tauri::async_runtime::spawn(async move {
        run_loop(app, hub_url).await;
    }));
}

async fn run_loop<R: Runtime>(app: AppHandle<R>, hub_url: String) {
    let mut backoff = 1u64;
    loop {
        match connect_once(&app, &hub_url).await {
            Ok(()) => backoff = 1,
            Err(e) => {
                eprintln!("conclave notify: {e}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn connect_once<R: Runtime>(app: &AppHandle<R>, hub_url: &str) -> Result<(), String> {
    use futures_util::StreamExt;

    let html = reqwest::get(format!("{hub_url}/"))
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let token = extract_token(&html).ok_or("no token in served page")?;

    let ws_url = {
        let mut u = url::Url::parse(hub_url).map_err(|e| e.to_string())?;
        match u.scheme() {
            "https" => u.set_scheme("wss").ok(),
            _ => u.set_scheme("ws").ok(),
        };
        u.set_path("/ws");
        u.set_query(Some(&format!("token={token}")));
        u.to_string()
    };

    let (mut stream, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .map_err(|e| e.to_string())?;

    while let Some(msg) = stream.next().await {
        let msg = msg.map_err(|e| e.to_string())?;
        if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
            if let Some(payload) = parse_frame(&text) {
                show_notification(app, &payload, hub_url);
            }
        }
    }
    Ok(())
}

fn show_notification<R: Runtime>(app: &AppHandle<R>, payload: &NotifyPayload, hub_url: &str) {
    let _ = app
        .notification()
        .builder()
        .title(&payload.title)
        .body(&payload.body)
        .show();
    // Deep-link on the next window show is best-effort: store the target so a
    // click handler (or the user reopening) lands on the right thread. For the
    // MVP we navigate immediately if a url is present, matching the ?thread= flow.
    if !payload.url.is_empty() {
        if let Some(win) = app.get_webview_window("main") {
            if let Ok(u) = url::Url::parse(&format!("{hub_url}{}", payload.url)) {
                let _ = win.navigate(u);
            }
        }
    }
}
```

**Note on click-through:** Tauri's notification plugin on Linux does not deliver a reliable per-notification click callback, so this MVP navigates the (possibly hidden) window to the deep link when the notification is shown; the tray/Show brings it forward. Record this as a deviation from the spec's "click → navigate" in the report — the deep-link destination is honored, the trigger is show-time not click-time. If the plugin version in use DOES expose `on_action`/click, prefer wiring the navigation there instead and note it.

- [ ] **Step 4: Replace the placeholder module in lib.rs**

In `packages/desktop/src-tauri/src/lib.rs`, delete the inline `pub mod notify { … }` placeholder block and replace it with a top-level module declaration alongside the others:

```rust
mod commands;
mod config;
mod notify;
```

(The `notify::restart(...)` calls in `commands.rs` and the `setup` hook now resolve to the real module.)

- [ ] **Step 5: Run notify tests + full lib test + typecheck-compile**

Run: `cd packages/desktop/src-tauri && timeout 600000 ~/.cargo/bin/cargo test --lib 2>&1 | tail -20; cd -`
Expected: all unit tests pass (config + commands + notify = 7 tests); the crate compiles with the async task wired.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src-tauri/src/notify.rs packages/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): native notifications from hub notify frames over ws"
```

---

### Task 5: Tray, close-to-tray, change-hub, compile proof, docs

**Files:**
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: tray icon + menu (Show/Hide, Change hub URL…, Quit); close-to-tray window behavior; the final compiled binary.

- [ ] **Step 1: Add tray + window-close handling to run()**

Replace the `tauri::Builder` chain in `packages/desktop/src-tauri/src/lib.rs`'s `run()` with the version below (keeps the existing `invoke_handler` and `setup` config-load logic, adds tray build inside `setup` and a window-event handler):

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{TrayIconBuilder, TrayIconEvent},
        Manager, WindowEvent,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_hub_url,
            commands::set_hub_url
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Tray menu: Show/Hide, Change hub URL…, Quit.
            let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
            let change = MenuItem::with_id(app, "change", "Change hub URL…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &change, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                    "change" => {
                        if let Some(win) = app.get_webview_window("main") {
                            // Navigate back to the bundled launcher page.
                            let _ = win.navigate("tauri://localhost".parse().unwrap());
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Load persisted hub URL and route the window.
            let path = app
                .path()
                .app_config_dir()
                .expect("no app config dir")
                .join("config.json");
            if let Some(cfg) = config::load(&path) {
                commands::navigate_to_hub(&handle, &cfg.hub_url);
                notify::restart(&handle, &cfg.hub_url);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Note:** the "Change hub URL…" navigation target for the bundled launcher may be `tauri://localhost` or `index.html` depending on the Tauri 2 asset-protocol scheme in use. If `tauri://localhost` does not load the launcher, use the form that loads the bundled `index.html` (check the running app's initial URL). Record the working value in the report.

- [ ] **Step 2: Compile-proof build (debug, no bundle)**

Run: `cd packages/desktop/src-tauri && timeout 600000 ~/.cargo/bin/cargo build 2>&1 | tail -25; cd -`
Expected: `Finished` — the full binary links against webkit2gtk. This is the compile proof. (Do NOT attempt `cargo tauri build`/bundling — the CLI is absent and bundling is out of scope.)

- [ ] **Step 3: Run the full unit-test suite once more**

Run: `cd packages/desktop/src-tauri && ~/.cargo/bin/cargo test --lib 2>&1 | tail -15; cd -`
Expected: 7 passed (config 4 + commands 1 + notify 2).

- [ ] **Step 4: DEPLOY.md — Desktop app section**

Append to `docs/DEPLOY.md` (after the Mobile section), matching the file's heading style:

```markdown
## Desktop app (Tauri)

A native desktop shell (`packages/desktop`) wraps the same web app in a window and
adds a tray icon and native notifications.

**Build prerequisites (Linux):** Rust toolchain, `webkit2gtk-4.1`, `gtk3`,
`libsoup-3.0`. Build the binary with `cargo build --release` in
`packages/desktop/src-tauri` (bundling into `.deb`/AppImage uses the Tauri CLI:
`cargo install tauri-cli` then `cargo tauri build`).

**First run:** the app opens a launcher asking for your hub URL
(e.g. `http://localhost:8787` or your tailscale URL). It validates the URL against
`<url>/health`, saves it to the platform config dir, and loads the hub. Change it
later from the tray menu → "Change hub URL…".

**Tray & window:** closing the window hides it to the tray (the app keeps running
and notifications keep arriving); the tray icon click or menu "Show / Hide" toggles
it; "Quit" exits fully.

**Notifications:** the shell opens its own WebSocket to the hub and raises a native
notification for the same events as web push (approvals, task failures, thread
settled, agent blocked). No service worker is involved, so this works inside the
desktop webview where web push does not. Notifications require the hub to be
reachable. On Linux the deep-link navigates the window to the relevant thread when
the notification fires (per-notification click callbacks are not reliably delivered
by the Linux notification backend).

**Security:** the hub page runs with no Tauri APIs exposed; the shell holds the hub
token in memory (re-fetched from the served page each start), never on disk — the
same single-token trust model as the browser client.

**Manual smoke (NOT RUN in the build sandbox — no display):** launch the app, enter
a hub URL, verify the web app loads; close the window and confirm it hides to tray;
trigger an approval/task-failure and confirm a native notification appears and its
click/show navigates to the thread; "Change hub URL…" returns to the launcher; Quit
exits.
```

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src-tauri/src/lib.rs docs/DEPLOY.md
git commit -m "feat(desktop): tray, close-to-tray, change-hub, docs"
```

---

## Manual smoke (record run/not-run in the final report)

No display in the sandbox — the entire window/tray/notification flow is manual. On a
Linux desktop: `cargo build --release`, run the binary, enter a hub URL, verify the
web app loads and behaves as in a browser; close → hides to tray; tray toggle/quit;
trigger each of the four notification events (approval pending, task failed, thread
settled, agent blocked) and confirm native notifications + deep-link navigation;
"Change hub URL…" returns to the launcher and reconnecting works.
