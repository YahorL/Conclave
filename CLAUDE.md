# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

1. Ask, don't assume. If something is unclear, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements. When running unattended, pick the most reasonable interpretation, proceed, and record the assumption rather than blocking.

2. Implement the simplest solution for simple problems, better solutions for harder problems. Do not over-engineer or add flexibility that isn't needed yet.

3. Don't touch unrelated code but please do surface bad code or design smells you discover with me so we can address them as a separate issue.

4. Flag uncertainty explicitly. If you're unsure about something, see point 1 above. If it makes sense to do so, conduct a small, localised and low-risk experiment and bring the hypothesis and results to me to discuss. Confidence without certainty causes more damage than admitting a gap.

5. I'm always open to ideas on better ways to do things. Please don't hesitate to suggest a better way, or one that has long lasting impact over a tactical change. (as a few examples)

## Project Status

Conclave is a desktop-style app for orchestrating multiple coding agents (Claude Code, Codex, a reviewer agent, …) inside project-based workspaces: shared group chat with @mentions, agent DMs, real terminals, and live status/cost/usage reporting. **The application is built** — steps 1–8 of the build order are implemented and merged to `main`.

### Architecture (read these first)

- `docs/ARCHITECTURE.md` — **authoritative** end-to-end architecture: the hub-and-spoke model, the wire protocol (HTTP + WebSocket frame catalogue), the MCP bridge, and every major flow (chat turn, debate, task, approval, fs tunnel, terminals) with diagrams. Read this before touching cross-cutting behavior.
- `docs/DEPLOY.md` — how to run the hub (Docker) + a daemon per agent machine, and register agents via `registry.yaml`.

The stack is a **pnpm monorepo** (`packages/*`):

- `@conclave/shared` — Zod schemas/types; the single wire contract every package imports.
- `@conclave/hub` — Fastify + SQLite central server (HTTP `/api/*` + WebSocket `/ws`); also serves the web app.
- `@conclave/daemon` — per-machine worker; spawns `claude`/`codex` CLIs, owns file/terminal access (path-jailed), reports usage.
- `@conclave/web` — React + Vite PWA (zustand store), the whole UI; Black/Teal themes.
- `@conclave/desktop` — Tauri v2 (Rust) shell wrapping the hub page with a tray + native notifications.

### Design handoff (UI fidelity reference)

`design_handoff_conclave/` remains the authoritative reference for visual fidelity:

- `design_handoff_conclave/README.md` — design tokens for two themes (Black = default, Teal), typography, layout regions, interactions, state-management sketch.
- `design_handoff_conclave/Conclave Directions.dc.html` — static HTML mock. Section `id="4a"` (Black theme) is canonical; `3a` is the Teal variant; `3b`–`3d` are superseded studies.
- `design_handoff_conclave/screenshots/` — full-screen captures of both themes.

Key handoff constraints: pixel-perfect fidelity to section 4a; all colors implemented as theme tokens (never hardcoded) with a Black/Teal switcher in Settings; monochrome UI where color carries meaning only. Epic Mode, Fork, and Promote/artifact semantics are underspecified — confirm before implementing beyond the visual treatment.
