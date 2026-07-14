# File-access Foundation — Design

**Date:** 2026-07-13
**Build-order step:** 5 of 8, sub-project 2 of 4 → part (i) of 2. (`docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §8, §5 Machine/Workspace.) Part (ii) browse-and-pick UI follows separately.
**Scope:** On-machine grant model + a request/response file-RPC tunnel through the hub so the web can list/stat/read/write files on a specific machine's daemon, path-jailed to granted roots. No web UI here (curl-testable); the browse-and-pick UI is 5c-ii.
**Depends on:** steps 1–4 + delegation + artifacts. On `main`.

## 1. Goal

Let a client ask the hub to perform a filesystem operation on a named machine; the hub tunnels a request to that machine's daemon over the existing WebSocket and returns the correlated response. The daemon executes the op **path-jailed to roots granted on that machine itself** (default-deny). A compromised hub or stolen client token cannot read files or escape granted roots — enforcement is daemon-local.

## 2. Standing decisions (from brainstorming)

1. **Split** the sub-project; build this foundation first, then the browse-and-pick UI (5c-ii).
2. **On-machine grant = local grants file + `conclave-daemon` CLI** (`grant`/`grants`/`revoke`). The hub cannot grant itself.
3. **Tunnel through the hub** (request/response over WS, correlated by id) — clients never talk to daemons; daemons need no inbound ports.
4. Daemon **reports its granted root paths** to the hub (browse starting points); path-jail is still enforced daemon-side.
5. **Writes are logged**: an fs `write` may carry a `threadId`; on success the hub posts a status message recording the edit (§8).

## 3. New infra: request/response tunnel

Today hub→daemon is one-way broadcast; daemons reply via HTTP. File RPCs add targeted request/response:

- **Daemon `hello`** on WS connect → `{ type: "hello", machine, files: string[] }` (granted roots). The hub keeps an in-memory `machine → { socket, grantedRoots, lastSeen }` map (the **machine registry**), updated on `hello` and cleared on socket close.
- **Hub fs routes** (client → hub HTTP): `POST /api/fs/:machine/list|stat|read|write`. The hub:
  1. looks up the machine's socket (503 `machine unreachable` if absent),
  2. generates a correlation `id`, sends `{ type: "fs-request", id, op, path, content?, threadId? }` to that socket,
  3. awaits `{ type: "fs-response", id, ok, result?, error? }` from that socket, correlated by `id`, with a timeout (504 `fs timeout`),
  4. returns `result` (200) or the daemon's `error` (422 `fs error`) to the caller.
- **Daemon** gains the ability to *send* WS frames (it only received before). On `fs-request` it runs the op via `FileService` and replies `fs-response` (`ok:false, error` on jail/permission/IO failure).

Pending-request correlation lives in a small `PendingRequests` helper on the hub: `create(id) → Promise`, `resolve(id, response)`, timeout auto-rejects and cleans up.

## 4. Grant model (daemon, on-machine)

- **Grants file** at `CONCLAVE_GRANTS_FILE` (default `./conclave-grants.json`): `{ "files": ["/abs/root", ...] }`.
- **`GrantStore`** (`packages/daemon/src/grants.ts`): `roots(): string[]` (reads + parses the file each call — cheap; missing/invalid file ⇒ `[]`), `isAllowed(absPath): boolean`, `resolveJailed(path): string` (resolves the path and throws `PathJailError` unless inside a granted root).
- **CLI** `packages/daemon/src/cli.ts` (bin: `conclave-daemon`): `grant <path>` (resolve to absolute, append to the grants file, dedupe), `grants` (print roots), `revoke <path>` (remove). Run on the machine itself. Re-read per RPC ⇒ grants take effect without a daemon restart.
- **Default-deny:** empty roots ⇒ every fs op fails `not granted`; the machine reports `files: []`.

### Path-jail
`resolveJailed(path)`: `const abs = resolve(path)` (absolute inputs) — reject unless some granted `root` satisfies `abs === root || abs.startsWith(root + sep)`. This blocks `..` traversal (already resolved) and ungranted roots. Symlink escape hardening (realpath) is noted as a follow-up; MVP uses lexical resolution.

## 5. File RPCs (daemon FileService)

`packages/daemon/src/file-service.ts` — each op calls `grants.resolveJailed(path)` first:
- `list(path): FsEntry[]` — `readdir(..., {withFileTypes:true})` → `[{ name, kind: "file"|"dir", size? }]` (size via `stat` for files; dirs omit size).
- `stat(path): FsStat` — `{ kind: "file"|"dir", size, mtime (ISO) }`.
- `read(path): { content: string }` — utf-8; reject files larger than 5 MB (`FileTooLargeError` → `error`). Binary deferred.
- `write(path, content): { ok: true }` — writes utf-8; parent dir must exist and be jailed. (Hub logs the edit if `threadId` was supplied.)

## 6. Shared contract (schemas)

`packages/shared/src/fs.ts`:
- `FsOpSchema = enum(["list","stat","read","write"])`.
- `FsRequestSchema = { id, op, path, content?, threadId? }`.
- `FsResponseSchema = { id, ok, result? (unknown), error? }`.
- `HelloSchema = { machine, files: string[] }`.
- `FsEntrySchema = { name, kind: "file"|"dir", size? }`; `FsStatSchema = { kind, size, mtime }`.
- Types exported for both hub + daemon.

## 7. Hub surface

- `GET /api/machines` → `[{ machine, files: string[], lastSeen }]` (connected daemons + grant state) — for the UI later.
- `POST /api/fs/:machine/:op` (op ∈ list|stat|read|write) → tunneled result. Body: `{ path, content?, threadId? }`. 503/504/422 per §3. Auth via the global hook.
- `/ws`: parse `hello` and `fs-response` frames (from daemons); send `fs-request` frames to a specific socket.

## 8. Explicitly deferred

- Web browse-and-pick, file tree, folder→Workspace creation, editor — **5c-ii / step 8**.
- Machine-wide time-limited browse grant — browsing is jailed to granted roots for MVP.
- Binary file content, realpath/symlink jail hardening, a persistent `Machine`/`Workspace` table (machines tracked in-memory from live connections).
- Approval gates on writes (§8: writes are user actions; only logged).

## 9. Testing (Vitest; spec §11)

- **shared**: fs schemas parse/reject.
- **daemon**: `GrantStore` (allow granted, reject ungranted, reject `..` escape, empty ⇒ deny); `FileService` (list/stat/read/write in a temp granted dir; reject outside; 5 MB read cap); CLI `grant`/`grants`/`revoke` mutate the grants file.
- **hub**: `PendingRequests` (resolve, timeout); machine registry (`hello` adds, close removes); fs route 503 when machine not connected; fs route round-trip against a fake in-process daemon socket.
- **integration**: real hub + a real daemon WS connection (`HubSocket`) → round-trip a `list` (granted) and a jailed `read` reject; `GET /api/machines` shows the connected machine.

## 10. Implementation order (for the plan) — parallelizable

1. **shared**: fs schemas (contract for both sides).
2. **[daemon track]** `GrantStore` + path-jail; tests.
3. **[daemon track]** `FileService` (list/stat/read/write) on GrantStore; tests.
4. **[daemon track]** `conclave-daemon` CLI (grant/grants/revoke); tests.
5. **[hub track]** `PendingRequests` + machine registry; tests.
6. **[hub track]** hub `hello`/`fs-response` handling + `fs-request` send + `POST /api/fs/:machine/:op` + `GET /api/machines`; tests.
7. **daemon**: `HubSocket` send + `fs-request`→`FileService`→`fs-response`; `hello` on connect; `main.ts` wiring. (depends on 2–3, 6)
8. **integration**: real hub ↔ daemon round-trip + jail reject + `/api/machines`; full monorepo green.

Tasks **2–4 (daemon track)** and **5–6 (hub track)** are independent (disjoint files/packages) and can be built in parallel after Task 1; Tasks 7–8 integrate.
