# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

1. Ask, don't assume. If something is unclear, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements. When running unattended, pick the most reasonable interpretation, proceed, and record the assumption rather than blocking.

2. Implement the simplest solution for simple problems, better solutions for harder problems. Do not over-engineer or add flexibility that isn't needed yet.

3. Don't touch unrelated code but please do surface bad code or design smells you discover with me so we can address them as a separate issue.

4. Flag uncertainty explicitly. If you're unsure about something, see point 1 above. If it makes sense to do so, conduct a small, localised and low-risk experiment and bring the hypothesis and results to me to discuss. Confidence without certainty causes more damage than admitting a gap.

5. I'm always open to ideas on better ways to do things. Please don't hesitate to suggest a better way, or one that has long lasting impact over a tactical change. (as a few examples)

## Project Status

Conclave is a desktop-style app for orchestrating multiple coding agents (Claude Code, Codex, a reviewer agent, …) inside project-based workspaces: shared group chat with @mentions, agent DMs, real terminals, and live status/cost/usage reporting. **No application code exists yet** — the tech stack has not been chosen (the handoff suggests e.g. Tauri or Electron + React + xterm.js).

The only content is `design_handoff_conclave/`, a high-fidelity design handoff:

- `design_handoff_conclave/README.md` — the authoritative spec: design tokens for two themes (Black = default, Teal), typography, layout regions, interactions, and a state-management sketch. Read it in full before implementing anything.
- `design_handoff_conclave/Conclave Directions.dc.html` — static HTML design mock. Section `id="4a"` (Black theme) is canonical; `3a` is the Teal variant; `3b`–`3d` are superseded studies.
- `design_handoff_conclave/screenshots/` — full-screen captures of both themes.

Key handoff constraints: pixel-perfect fidelity to section 4a; all colors implemented as theme tokens (never hardcoded) with a Black/Teal switcher in Settings; monochrome UI where color carries meaning only. Epic Mode, Fork, and Promote/artifact semantics are underspecified — confirm before implementing beyond the visual treatment.
