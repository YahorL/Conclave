# @conclave/web

React + Vite web client for Conclave — the section-4a (Black theme) screen:
group chat with @mentions, thread/session tabs, a sidebar of chats + agents,
and a right rail of live agent status and usage. Drives everything from real
hub data (real data or a clean absence — nothing fabricated).

## Develop

The dev server proxies `/api` and `/ws` to the hub. Point it at a running hub
and pass the hub's auth token:

```bash
# 1. start a hub (from repo root)
CONCLAVE_TOKEN=dev CONCLAVE_PORT=7799 CONCLAVE_BUDGET_USD=25 \
  CONCLAVE_DATA_DIR=./data-dev npx tsx packages/hub/src/main.ts

# 2. start the web app against it
CONCLAVE_HUB_URL=http://localhost:7799 VITE_CONCLAVE_TOKEN=dev \
  npx pnpm --filter @conclave/web dev
# open http://localhost:5273
```

`CONCLAVE_HUB_URL` (dev-server env) sets the proxy target; `VITE_CONCLAVE_TOKEN`
(build-time env, see `.env.local.example`) is sent as the bearer token / `?token=`.

## Test

```bash
npx pnpm --filter @conclave/web exec vitest run   # unit + integration (jsdom)
npx pnpm --filter @conclave/web typecheck
npx pnpm --filter @conclave/web build             # production build (fonts bundled)
```

`src/__tests__/integration.test.tsx` mounts the whole App against hub-shaped
responses and asserts the full hubClient → store → component pipeline renders
section-4a content. It is the CI-safe complement to the browser visual check.

## End-to-end / visual check (needs a browser)

`e2e/visual.spec.ts` is a Playwright spec (not run by Vitest). To exercise it,
seed a hub with realistic data, run the app against it, then run Playwright and
diff the screenshot against `design_handoff_conclave/screenshots/4a-black-main.png`.

Seed recipe (hub on :7799, token `dev`):

```bash
H=http://localhost:7799; Q=token=dev; CT=content-type:application/json
# registry.yaml in the hub data dir must list claude-code / codex / reviewer agents.
TID=$(curl -s -H "$CT" -X POST "$H/api/threads?$Q" \
  -d '{"kind":"chat","participants":["you","claude-code","codex","reviewer"],"workspace":"payments-service"}' \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -H "$CT" -X POST "$H/api/threads/$TID/messages?$Q" -d '{"from":"claude-code","type":"proposal","body":"See payments/middleware/idem.ts:41"}'
curl -s -H "$CT" -X POST "$H/api/status?$Q" -d '{"agent":"claude-code","status":"running","activity":"writing migration 0043","threadId":"'$TID'"}'
curl -s -H "$CT" -X POST "$H/api/usage?$Q"  -d '{"agent":"claude-code","inputTokens":120000,"outputTokens":38000,"costUsd":2.10}'
# ...repeat for codex / reviewer; see the section-4a screenshot for content.
```

Then: `npx playwright test packages/web/e2e/visual.spec.ts`.

> Sandbox note: the automated pixel diff cannot run in CI environments without a
> browser binary. The integration test above covers the render pipeline; the
> Playwright spec is for a human/CI with Chromium available.

## Deferred (later build-order steps)

Terminals + take-over (7); artifacts + Promote (5/8); file-link navigation,
Teal theme + scheme switcher, mobile/PWA, Tauri shell (8); `/task` delegation
(5); approvals + web push (6); full 5h/week rate-limit windows (5+);
hub-serves-static packaging (5); Epic Mode / Fork (unspecified).
