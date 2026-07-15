# Agent-to-Agent ACLs — Design

Date: 2026-07-14
Status: approved
Parent: 2026-07-12-conclave-architecture-design.md (§6 Delegation, §7 Registry; step 6 of the build order)
Sub-project: 2 of 3 for step 6 (approvals ✅ → **ACLs** → web push)

## Goal

Agent-to-agent communication is **deny-by-default**. A flat list of unordered
ACL pairs in the registry opens specific agent pairs for both messaging and
delegation. The hub is the enforcement point. This replaces the current crude
daemon-wide `allowAgentTriggers` boolean (all-agents-on or all-off) with real
per-pair rules.

## Decisions made during brainstorming

1. **Hub-side enforcement at message post.** The hub rejects a disallowed
   agent→agent message (403) before it is stored. The ACL lives in the
   registry, which the hub owns, so this is the real security boundary — a
   compromised or misconfigured daemon cannot bypass it.
2. **Scope: messages + agent-initiated delegation.** Both the message channel
   and a new agent delegation path are gated by the same ACL.
3. **Symmetric + global pairs.** A pair `[dev, deploy]` opens communication
   both ways, everywhere. One flat unordered list; matches the spec's
   `dev↔deploy` notation. (Per-workspace scoping deferred.)
4. **`delegate_task` MCP tool.** An agent delegates via a dedicated tool
   mirroring `create_artifact`/`request_approval`, not a message convention.
5. **Loop-guard:** a turn triggered by *another agent* posts its result with
   `to: []` — visible in the thread but does not auto-retrigger the sender, so
   there is no dev→deploy→dev ping-pong. Deliberate continuation goes through
   an explicit `send_message` with a `to`. Human-triggered replies are
   unchanged (`to: [m.from]`).

## 1. ACL model (`packages/shared`)

Registry gains a top-level `acl` list of unordered pairs:

```yaml
agents:
  - id: dev
    # …
  - id: deploy
    # …
acl:
  - [dev, deploy]     # dev↔deploy both ways
  - [reviewer, dev]   # reviewer↔dev both ways
# audit talks to nobody (deny-by-default)
```

Schema (`packages/shared/src/registry.ts`):

```ts
export const AclPairSchema = z.tuple([z.string().min(1), z.string().min(1)]);
// added to RegistrySchema:
acl: z.array(AclPairSchema).default([]),
```

Pure helper (`packages/shared/src/registry.ts` or a small `acl.ts`,
re-exported from the shared index):

```ts
export function canCommunicate(registry: Registry, a: string, b: string): boolean {
  if (a === "you" || b === "you") return true;          // human always allowed, both ways
  return registry.acl.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  );                                                     // unordered pair present → allowed
}
```

Deny-by-default: absent a pair (and absent `"you"`), the result is `false`.
`canCommunicate(x, x)` is `false` — an agent never needs ACL to talk to
itself, and self-recipients are never gated (see §2).

## 2. Hub enforcement (`packages/hub`)

The hub already holds the full `registry`. Two agent-reachable write paths get
one check each.

### Messages — `POST /api/threads/:id/messages`

Used by the MCP `send_message` tool, daemon turn-result posts, and the web
composer. After the body validates, before `mailbox.appendMessage`:

- Let `from = body.from`. If `from` is **not** a registered agent (i.e. `"you"`
  or anything not in `registry.agents`), skip the check — allow.
- Otherwise, for each `recipient` in `body.to` that **is a registered agent and
  `!== from`** ("gated recipients"), require `canCommunicate(registry, from, recipient)`.
- If any gated recipient fails → `403 { error: "acl: <from> may not message <recipient>" }`,
  and the message is **not** stored.
- `to: []`, `to: ["you"]`, and recipients that are not registered agents pass
  (they trigger nobody per `shouldTrigger`, so they are inert).

`from` is set by the MCP bridge to the real agent id; the agent cannot override
it. So even under the single shared-token model this meaningfully contains
prompt-injected behavior.

Helper on the server (small, testable): `assertAclAllowed(registry, from, to): string | null`
returning the offending recipient or `null`; the route maps non-null → 403.

### Delegation — `POST /api/tasks`

- Request body (`NewTaskSchema`) gains optional `requestedBy: z.string().optional()`.
- In the route: `const requester = body.requestedBy ?? "you";` If `requester`
  is a registered agent, require `canCommunicate(registry, requester, body.assignee)`
  → else `403 { error: "acl: <requester> may not delegate to <assignee>" }`.
- `createTask` (`packages/hub/src/tasks.ts`) gains `requestedBy` (default `"you"`):
  the seeded spec message posts `from: requestedBy` (today hardcoded `"you"`),
  `to: []` unchanged. Everything else about task creation is unchanged, so an
  agent-delegated task flows identically to a user `/task` (thread + `queued`
  Task + `task` frame → assignee's daemon picks it up).

Ordering: the route runs the ACL check first. For an **agent** `requester`, a
missing pair → 403 (this also covers an unknown/typo assignee, since no pair
exists for it — the agent simply may not reach it). For `requester === "you"`
the ACL check is skipped, so an unknown assignee still falls through to the
existing `UnknownAssigneeError → 400` handler (`server.ts:88`), unchanged.

## 3. Daemon (`packages/daemon`)

### `delegate_task` MCP tool (`mcp-bridge.ts`)

```
inputs: { assignee: string, spec: string }
```

Calls `HubClient.createTask({ assignee, spec, requestedBy: agentId })`. On
success returns the created `Task` (ok). On a 403 the hub error surfaces through
the existing `err(e)` path, so the agent is told it may not delegate to that
assignee and can report it in its turn. New `HubClient.createTask(input)` →
`POST /api/tasks` (mirrors the existing `listTasks`/`setTaskState`/`createArtifact`
methods). Add `"mcp__hub__delegate_task"` to `HUB_MCP_TOOLS`.

### Retire `allowAgentTriggers`

The hub is now authoritative, so the daemon-wide flag is obsolete and wrong
(it would double-gate with a cruder rule). Changes:

- `shouldTrigger(agent, m)` drops the `allowAgentTriggers` parameter and its
  clause. It fires on any `text`/`proposal` message where `m.to.includes(agent.id)`
  and `m.from !== agent.id` — the sender being another agent is fine, because
  the hub already guaranteed the message is ACL-allowed to exist.
- Remove `allowAgentTriggers` from `AgentLoopOptions`, `DaemonConfig`,
  `loadDaemonConfig` (the `CONCLAVE_ALLOW_AGENT_TRIGGERS` env var), and `main.ts`.

### Loop-guard on agent-triggered turns (`agent-loop.ts` `runTurn`)

`runTurn` handles a message-triggered turn. Today it posts the result with
`to: [m.from]`. Change: **when `m.from !== "you"`** (the trigger was another
agent), post the result with `to: []` instead — visible, but does not
auto-retrigger the sender. When `m.from === "you"`, keep `to: [m.from]`.

This bounds agent↔agent ping-pong without a round cap: an agent that wants to
continue an exchange must deliberately call `send_message` with an explicit
`to` (itself ACL-checked at the hub). Debate turns (`runDebateTurn`, already
`to: []`) and task turns are unaffected.

## Out of scope

- Directional or per-workspace ACLs (symmetric + global only).
- Web UI for viewing/editing the ACL or registry (belongs with web registry
  editing, later). Enforcement is server-side; agents see denials as tool errors.
- A human-visible audit trail of denied attempts (agents report denials in
  their turn text; a thread status-message log can come later if it bites).
- Per-agent authentication — the single shared token and trusted-daemon model
  is unchanged; ACL adds meaning on top of the bridge-fixed `from` field.

## Testing

- **shared:** `AclPairSchema`/`RegistrySchema.acl` parse + default `[]`;
  `canCommunicate` truth table — `"you"` either side (both directions),
  symmetric pair (both orders), deny-by-default absent a pair, `canCommunicate(x,x)` false.
- **hub:** message route matrix — agent→agent allowed (201) / denied (403, not
  stored) / human `from:"you"` always (201) / `to:[]` and `to:["you"]` pass /
  multi-recipient with one disallowed → whole message 403. Task route —
  `requestedBy` agent allowed (201) / denied (403) / absent defaults to `"you"`
  (201); `createTask` seeds the spec message with `from: requestedBy`.
- **daemon:** `delegate_task` over a live hub (allowed → task created + `task`
  frame; denied → tool error); `shouldTrigger` fires on an agent-from message
  addressed to the agent with no flag; `runTurn` posts `to: []` when triggered
  by an agent and `to: [m.from]` when triggered by `"you"`. Update existing
  tests that pass `allowAgentTriggers` (turn-request, agent-loop, config).
