# Approvals — Design

Date: 2026-07-14
Status: approved
Parent: 2026-07-12-conclave-architecture-design.md (§6 Delegation — gated actions; step 6 of the build order)
Sub-project: 1 of 3 for step 6 (approvals → ACLs → web push)

## Goal

An agent about to do something dangerous asks for permission; the task pauses;
the user approves or denies from the browser; the agent resumes with the
decision. This is the enabler for leaving agents running unattended.

## Decisions made during brainstorming

1. **Advisory + turn-split enforcement.** The CLIs run turn-based one-shot
   subprocesses (`claude -p … --permission-mode dontAsk`), so there is no
   live session to pause. `request_approval` is an MCP tool the agent is
   *instructed* to call before dangerous actions (per-agent `dangerousActions`
   list injected into its prompt). Calling it ends the turn; the daemon
   resumes the session when the user decides. Honest trust level: a rogue
   agent could skip the call, but `allowedTools` still caps what it can run.
   Hard enforcement (claude `--permission-prompt-tool`, codex sandbox
   approvals) is deliberately deferred.
2. **Deny resumes with the denial.** The session is resumed with
   "denied: <note>" and the agent adapts (finds another way or wraps up).
   Approve works identically with "approved". One code path; a denial rarely
   means the whole task is worthless.
3. Approvals work in any thread. The task state machine
   (`running ⇄ input-required`) and session-resume only engage when the
   approval carries a `taskId`; in debates/chats the decision message simply
   joins the next orchestrated turn's context.

## Data model (`packages/shared/src/approval.ts`)

```ts
ApprovalState = "pending" | "approved" | "denied"

Approval {
  id: string
  threadId: string
  taskId?: string          // present when requested during a task run
  requestedBy: string      // agent id
  action: string           // human-readable, e.g. "run scripts/deploy.sh prod"
  idempotencyKey: string   // unique per (requestedBy, idempotencyKey)
  state: ApprovalState
  note?: string            // user's optional note on decide
  createdAt: string
  decidedAt?: string
}

NewApproval { threadId, taskId?, requestedBy, action, idempotencyKey }
ApprovalDecision { decision: "approved" | "denied", note?: string }
```

Registry: `AgentConfigSchema` gains `dangerousActions: z.array(z.string()).default([])`
— plain human-readable patterns ("deploys", "git push", "rm -rf"). They are
injected into the agent's task/turn prompt as a MUST-request-approval
instruction, not runtime-enforced.

## Hub (`packages/hub`)

**`ApprovalStore`** (SQLite table `approvals`):

- `create(input)` — idempotency-keyed: if `(requestedBy, idempotencyKey)`
  already exists, return the existing row unchanged (any state). A retried
  task therefore gets the original decision instead of filing a duplicate.
- `get(id)`, `list(state?)`.
- `decide(id, decision, note?)` — only `pending → approved|denied`;
  deciding an already-decided approval throws (route → 409). This is the
  guarantee that a gated action cannot be double-authorized.

**Filing side effects** (hub `createApproval` helper, mirroring `createTask`):

- Posts an `approval-request` message into the thread (type already exists in
  `MessageTypeSchema`): `from: requestedBy`, `to: []`, body = JSON
  `{approvalId, action}` so clients can find the approval and render the card
  (see Web section).
- If `taskId` present: task `running → input-required`.
- Broadcasts WS frame `{type: "approval", approval}`.

**Deciding side effects:**

- Updates state; posts a `status` message into the thread
  ("you approved/denied: <action> — <note>"); if `taskId` present:
  `input-required → running`; broadcasts the updated `approval` frame.

**Routes** (all authed, like every `/api` route):

- `POST /api/approvals` — body `NewApproval` (daemon files one). Returns the
  approval (existing one if idempotency-hit).
- `GET /api/approvals?state=pending` — list.
- `GET /api/approvals/:id`.
- `POST /api/approvals/:id/decide` — body `ApprovalDecision`; 404 unknown,
  409 already decided.

## Daemon (`packages/daemon`)

**MCP tool `request_approval`** (mcp-bridge):

```
inputs: { action: string, idempotencyKey?: string }   // key defaults to a hash of (threadId, action)
```

Files the approval via the hub client, then returns text telling the agent:
"Approval <state>. Pending: end your turn now — you will be resumed with the
decision." If the idempotency key hits an already-decided approval, the tool
returns that decision immediately (retried task, no re-ask).

**Agent-loop:**

- Handles the `approval` WS frame. On a *decided* approval whose `taskId`
  belongs to a task this daemon started and whose session id is known:
  resume the session with the decision prompt
  ("Your approval request '<action>' was approved/denied<: note>. Continue
  accordingly.") — same turn plumbing as task turns, reusing status
  reporting and result posting.
- `handledApprovals: Set<string>` dedupes re-delivered frames (mirror of
  `startedTasks`).
- Approvals without `taskId` (debate/chat): no resume — the decision message
  already sits in the thread and joins the next orchestrated turn.

**Prompt injection:** `buildTaskPrompt` (and debate turn prompts) append,
when the agent's registry entry has `dangerousActions`:
"Before doing any of the following you MUST call request_approval and end
your turn: <list>."

## Web (`packages/web`)

- **Approval card**: `approval-request` messages render as a card instead of
  a plain bubble — requesting agent, action text, state chip
  (PENDING / APPROVED / DENIED), and for pending: Approve / Deny buttons plus
  an optional note input. Buttons act via `POST …/decide`; the WS `approval`
  frame flips the card state on every client. Monochrome, section-4a tokens;
  no new colors — state is carried by the chip text and border weight.
- **ContextToolbar**: pending-approval indicator when the active thread has
  one ("1 approval waiting").
- **Sidebar**: thread rows with pending approvals get a badge (the
  "come back and look" cue until web push lands in sub-project 3).
- **Store**: `approvalsById`, hydrated from `GET /api/approvals` on load and
  updated by the `approval` frame; `decideApproval(id, decision, note?)`.

Message body for `approval-request` is JSON `{approvalId, action}` so the
card can find its approval in the store; `parseMessage` treats it like any
other typed message (no markdown parsing of the body).

## Out of scope

- Hard enforcement via CLI permission hooks (future; layered on this protocol).
- Approval expiry/timeouts — pending approvals wait indefinitely (single-user app).
- ACL checks and web push — sub-projects 2 and 3.

## Testing

- **shared**: schema round-trips, defaults.
- **hub**: ApprovalStore unit tests (idempotent create returns same row,
  decide transitions, double-decide throws, task-state coupling both ways);
  route tests (401 unauthed, 404, 409, thread message + WS frame emitted).
- **daemon**: `request_approval` tool files and returns pending / returns
  existing decision on idempotency hit; agent-loop resumes with decision
  prompt exactly once per approval (dedupe), no resume without taskId.
- **web**: approval card renders pending with buttons, decided without;
  decide calls API; frame updates card; toolbar/sidebar indicators.
