# Web Push Notifications — Design

Date: 2026-07-15
Status: approved
Parent: 2026-07-12-conclave-architecture-design.md (§11 web push; step 6 of the build order)
Sub-project: 3 of 3 for step 6 (approvals ✅ → ACLs ✅ → **web push**)

## Goal

The user gets a push notification — on phone or desktop, even with the app
closed — when an agent blocks on an approval, a delegated task fails, a thread
settles, or an agent hits its usage limit. This is the payoff of the approvals
work: you can walk away and the system pulls you back only when it needs you.

## Decisions made during brainstorming

1. **Real web push, not in-page Notifications.** The in-page `Notification` API
   only fires while a tab is open, defeating the "away" use case. This needs a
   service worker + `PushManager` + VAPID + server-sent push — the only stack
   that delivers while the app is closed.
2. **Four triggers, all off existing hub events** (no new event plumbing):
   approval requested, task failed, thread settled, agent blocked. "Usage
   threshold" is interpreted as **agent became blocked** (the daemon already
   reports this with a `resetsAt` when a CLI hits its rate/usage limit) — not a
   pre-emptive 80%-of-budget crossing, which would need new plumbing (deferred).
3. **VAPID keys auto-generated and persisted** to the data dir on first boot;
   reused across restarts. Zero-config deploy; subscriptions stay valid.
4. **Minimal PWA manifest** for installability — required for push on iOS
   (iOS only delivers web push to an installed PWA). Just installability + the
   service worker; the full mobile-responsive layout stays in step 8.
5. **Push delivery rests on a manual smoke test.** Real end-to-end delivery
   needs a browser + a push service and is not unit-testable; the automated
   suite covers every server/helper seam, and a documented smoke checklist
   covers actual delivery (same model as the CLI adapters).

## 1. Dependencies, VAPID keys, subscription store (hub)

- Add **`web-push`** (npm) to `packages/hub` — implements the Web Push Protocol
  and VAPID signing.

**`packages/hub/src/vapid.ts`:**

```ts
export interface VapidKeys { publicKey: string; privateKey: string; }
// Reads <dataDir>/vapid.json; if absent, webpush.generateVAPIDKeys(),
// writes it (mode 0600), returns the keys. Stable across restarts.
export function loadOrCreateVapid(dataDir: string): VapidKeys;
```

**`packages/hub/src/push-store.ts`** — SQLite table (added to `migrate()` in
`db.ts`):

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

A browser `PushSubscription` serializes to `{endpoint, keys:{p256dh, auth}}`.

```ts
export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export class PushStore {
  constructor(db: Database.Database);
  upsert(sub: PushSubscription): void;   // dedup by endpoint (INSERT OR REPLACE)
  list(): PushSubscription[];
  remove(endpoint: string): void;
}
```

Shared schema `PushSubscriptionSchema` (`packages/shared/src/push.ts`,
re-exported from the index) validates the subscribe body.

## 2. Hub routes + notifier

**Routes** (all under the existing bearer-auth hook):

- `GET /api/push/vapid-public-key` → `{ key: string }` — the web app needs the
  PUBLIC key to subscribe (safe to serve; still authed like all `/api`).
- `POST /api/push/subscribe` — body `PushSubscription` → `store.upsert`, 201.
- `POST /api/push/unsubscribe` — body `{ endpoint: string }` → `store.remove`, 200.

`ServerOptions` gains `push?: PushStore` and `vapidPublicKey?: string`; routes
503 when `push` is unconfigured (mirrors the tasks/approvals guards).

**`packages/hub/src/notifier.ts`** — a long-lived listener wired in `main.ts`,
NOT in the request path:

```ts
export interface NotifyPayload { title: string; body: string; url: string; tag: string; }
export type SendFn = (sub: PushSubscription, payload: NotifyPayload) => Promise<void>;

export class Notifier {
  // Subscribes to mailbox.events ("approval","task","thread") and
  // status.events ("agent-status"). For each trigger, builds a payload and
  // fans out to store.list() via send(). On a 404/410 rejection, calls
  // store.remove(endpoint) to prune the dead subscription.
  constructor(deps: {
    mailboxEvents: EventEmitter;
    statusEvents: EventEmitter;
    store: PushStore;
    send: SendFn;                 // prod: webpush.sendNotification wrapper; tests: mock
  });
  start(): void;                  // attach listeners
  stop(): void;                   // detach (for clean shutdown / tests)
}
```

Trigger → payload mapping (only these states fire; all else is ignored):

| Event (emitter) | Fires when | Payload |
| --- | --- | --- |
| `approval` (mailbox) | `state === "pending"` | title "Approval needed", body = `action`, url `/?thread=<threadId>`, tag `approval-<id>` |
| `task` (mailbox) | `state === "failed"` | title "Task failed", body = first ~80 chars of `spec`, url `/?thread=<threadId>`, tag `task-<id>` |
| `thread` (mailbox) | `state === "settled"` | title "Thread settled", body = joined verdict values or "decision reached", url `/?thread=<id>`, tag `thread-<id>` |
| `agent-status` (status) | `status === "blocked"` | title "`<agent>` blocked", body = `resetsAt ? "resets <HH:MM>" : "usage limit reached"`, url `/`, tag `status-<agent>` |

- `tag` collapses repeats (an agent re-reporting `blocked`, or a re-emitted
  thread update, replaces the prior notification rather than stacking).
- The production `send` wrapper (in `main.ts`) is
  `(sub, payload) => webpush.sendNotification({endpoint, keys}, JSON.stringify(payload))`
  with `webpush.setVapidDetails("mailto:<contact>", pub, priv)` configured once;
  it rejects with a `statusCode` the Notifier inspects (404/410 → prune).
  `web-push` requires a contact in `setVapidDetails`; use a fixed
  `"mailto:conclave@localhost"` (no real address is needed for a self-hosted
  push subscriber — no new deploy var).

**Wiring (`main.ts`):** `loadOrCreateVapid(dataDir)` → `webpush.setVapidDetails`
→ `const push = new PushStore(db)` → `new Notifier({...}).start()` →
`buildServer({..., push, vapidPublicKey})`.

## 3. Web — service worker, manifest, subscribe flow, toggle

**`packages/web/public/sw.js`** (plain JS; `public/` is served at origin root so
the SW scope is `/`):

```js
self.addEventListener("push", (event) => {
  const d = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(d.title || "Conclave", {
      body: d.body || "", tag: d.tag, data: { url: d.url || "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      const hit = cs.find((c) => "focus" in c);
      return hit ? hit.focus() : self.clients.openWindow(url);
    }),
  );
});
```

**`packages/web/public/manifest.webmanifest`** — `name` "Conclave",
`short_name` "Conclave", `start_url` "/", `display` "standalone",
`background_color`/`theme_color` from the Black theme tokens, `icons`
192 + 512 (see Icons below). Linked from `index.html` plus a `theme-color` meta.

**`packages/web/src/lib/push.ts`:**

```ts
export function pushSupported(): boolean;   // "serviceWorker" in navigator && "PushManager" in window
export function pushPermission(): NotificationPermission;  // Notification.permission
export async function enablePush(): Promise<void>;
  // register("/sw.js") → Notification.requestPermission() (throw if not "granted")
  // → GET /api/push/vapid-public-key → pushManager.subscribe({userVisibleOnly:true, applicationServerKey})
  // → POST /api/push/subscribe with subscription.toJSON()
export async function disablePush(): Promise<void>;
  // registration.pushManager.getSubscription() → sub.unsubscribe() → POST /api/push/unsubscribe {endpoint}
export async function isPushEnabled(): Promise<boolean>;   // has an active subscription
// plus urlBase64ToUint8Array(base64) for applicationServerKey
```

Requests use the existing `hubClient` auth header.

**UI — bell toggle in the StatusStrip** (`packages/web/src/components/StatusStrip.tsx`):
a small monochrome button, lucide `Bell` when enabled / `BellOff` when not,
reflecting `pushPermission()`. Click toggles `enablePush`/`disablePush`. When
permission is `denied`, the button is disabled with a title hint (browser-level
block — nothing the app can override). Hidden entirely when `!pushSupported()`.
Section-4a tokens only; no new colors.

## 4. Icons, testing, deploy

**Icons.** The manifest needs real PNGs. I will create a minimal monochrome
Conclave mark as an SVG (a simple geometric mark consistent with section 4a —
NOT a fabricated logo or third-party branding) and generate `icon-192.png` and
`icon-512.png` from it into `packages/web/public/`. A tiny generation step
(sharp or resvg via a one-off script/command) produces the PNGs; the SVG is the
source of truth kept in the repo.

**Testing.** Real delivery needs a browser + push service — not unit-testable.
Automated coverage of every other seam:

- **hub `vapid.ts`**: generates + persists on first call; returns the SAME keys
  on a second call (temp dir); file written 0600.
- **hub `PushStore`**: upsert dedups by endpoint; list; remove.
- **hub push routes**: subscribe stores, unsubscribe removes, vapid-public-key
  returns the configured key, 401 unauthed, 503 when unconfigured.
- **hub `Notifier`** (the important one; inject a mock `send`): each trigger
  (approval pending, task failed, thread settled, agent blocked) fans out the
  correct payload to all stored subs; non-trigger states (task running,
  approval approved, thread open) send nothing; a `send` rejection with
  `statusCode` 410 prunes that subscription via `store.remove`.
- **web `push.ts`**: mock `navigator.serviceWorker`, `PushManager`, `fetch`,
  `Notification`; `enablePush` registers, requests permission, subscribes, and
  POSTs; `urlBase64ToUint8Array` round-trips a known key; `pushSupported`/
  `isPushEnabled` reflect the mocked environment.

The `sw.js` push/click handlers and true delivery are covered by a **manual
smoke checklist** documented in `docs/DEPLOY.md` (or a new `NOTIFICATIONS.md`):
enable in a browser, trigger an approval, confirm the notification arrives and
click-through focuses the thread.

**Deploy.** Localhost is a secure context, so the SW + push work in dev without
HTTPS. Production still needs HTTPS for a non-localhost origin — the existing
Tailscale-serve instructions in `docs/DEPLOY.md` already provide it; add a short
"Notifications" note: install the PWA from the HTTPS origin (required on iOS),
click the bell to enable. `vapid.json` lives in the data volume; deleting it
rotates keys and invalidates existing subscriptions (users re-enable).

## Out of scope

- Pre-emptive 80%-of-budget usage alerts (needs new threshold plumbing).
- Per-notification preferences / quiet hours / per-agent muting (one global
  on/off via the bell toggle).
- Tauri native notifications (step 8; the spec routes those through the native
  tray, not web push).
- Full mobile-responsive layout / rich PWA (step 8) — this manifest is
  installability only.
- Presence-aware suppression (don't-notify-if-actively-looking) — YAGNI.

## Testing note (honesty)

The automated suite will prove the hub builds correct payloads, stores/prunes
subscriptions, and that the web helper subscribes and POSTs correctly. It will
NOT prove a notification reaches a device — that claim rests on the manual
smoke. Reports will say "server + subscribe path green; delivery smoke: <result
or not-run>", never "push works" from tests alone.
