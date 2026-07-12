# @conclave/hub

Mailbox hub: SQLite-backed threads/messages with an HTTP + WebSocket API.
See `docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §3, §5.

## Run

CONCLAVE_TOKEN=dev pnpm --filter @conclave/hub dev

Env: `CONCLAVE_TOKEN` (required) · `CONCLAVE_PORT` (default 7777) · `CONCLAVE_DATA_DIR` (default ./data)

## API

All routes need `Authorization: Bearer $TOKEN` (or `?token=`), except `GET /health`.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/threads` | `{kind, participants, workspace?}` | 201 Thread |
| `GET /api/threads` | – | Thread[] |
| `GET /api/threads/:id` | – | Thread |
| `POST /api/threads/:id/messages` | `{from, body, to?, type?, artifacts?}` | 201 Message |
| `GET /api/threads/:id/messages?after=N&wait=S` | – | Message[] (long-polls up to S≤60s) |
| `POST /api/threads/:id/verdict` | `{agent, verdict}` | Thread (settles when all voted) |
| `POST /api/threads/:id/close` | – | Thread |
| `GET /ws` | WebSocket | pushes `{type:"message"|"thread", ...}` frames |
