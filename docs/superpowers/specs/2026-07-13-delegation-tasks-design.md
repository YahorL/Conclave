# Delegation Tasks — Design

**Date:** 2026-07-13
**Build-order step:** 5 of 8, sub-project 1 of 4 (`docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` §12; §6 Delegation).
**Scope:** `/task @agent <spec>` delegates a tracked unit of work to a registry agent; the assignee's daemon runs it in the agent's workspace and streams state + result into a dedicated task thread.
**Depends on:** steps 1–4 (hub mailbox/threads/messages/registry/usage/status/`/ws`; daemon agent-loop/turn-queue/adapters; web chat). All merged to `main`.

## 1. Goal

Turn the existing conversational turn machinery into tracked **delegation**: a user assigns a task to an agent, the agent works in its workspace, and the task's lifecycle (queued → running → done/failed) plus its result are visible in a dedicated thread the web app already renders. Reuse `adapter.runTurn` and the per-agent `TurnQueue` — the new surface is the `Task` record, its state machine, the creation path, and daemon pickup.

## 2. Standing decisions (from brainstorming)

1. **Dedicated task thread.** `/task` creates a new `kind: "task"` thread (not in-place in the current thread). Matches the data model (`Task.threadId`, `Thread.kind "task"`), isolates each delegated unit, and carries its own state.
2. **State transitions + final result** (no live event streaming this MVP). Post `queued→running→done|failed` status lines and the agent's final output. Reuses the `runTurn` path exactly. Token/tool streaming can be added later.
3. **User-initiated `/task` only.** Agent-to-agent task creation needs ACLs (deny-by-default; full matrix later) and is deferred.

## 3. Data model

New `Task` in `@conclave/shared`:

```
Task {
  id:        string (uuid)
  threadId:  string
  assignee:  string          // agent id (must resolve in the registry)
  spec:      string          // the work description / prompt
  state:     "queued" | "running" | "input-required" | "done" | "failed"
  artifacts: string[]        // artifact ids (populated by the artifacts sub-project)
  createdAt: string (ISO)
  updatedAt: string (ISO)
}
NewTask { assignee, spec, workspace?: string }
```

`input-required` is reserved for step-6 approvals/interactive input; MVP transitions are
`queued → running → done | failed` only.

Allowed state transitions (enforced hub-side):
- `queued → running`
- `running → done`
- `running → failed`
- (`queued → failed` permitted for pre-run rejection, e.g. unknown assignee at pickup)

Any other transition is rejected `409`.

## 4. Hub

### 4.1 Storage
New `tasks` table (migration in `db.ts`):

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  assignee   TEXT NOT NULL,
  spec       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'queued',
  artifacts  TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_state ON tasks(assignee, state);
```

`TaskStore` (`packages/hub/src/tasks.ts`): `create(task)`, `get(id)`, `list()`,
`listByAssigneeState(assignee, state)`, `updateState(id, state)` (stamps `updatedAt`,
returns the updated Task; throws on invalid transition).

### 4.2 Creation service
`createTask(mailbox, store, input)` (a small service, testable without HTTP):
1. Resolve the assignee in the registry; reject unknown assignee (`400`).
2. `mailbox.createThread({ kind: "task", participants: [input.assignee, "you"], workspace })`.
3. Insert `Task { state: "queued", ... }`.
4. `mailbox.appendMessage(threadId, { from: "you", to: [], type: "text", body: input.spec, artifacts: [] })`
   — **`to: []`** so the message path does NOT trigger the chat turn (`shouldTrigger` needs
   `to.includes(agent)`); the task frame is the sole execution trigger.
5. Emit `{ type: "task", task }` on `mailbox.events` (`"task"` event).
6. Return the Task.

### 4.3 HTTP
- `POST /api/tasks` — body `NewTaskSchema` → `createTask` → `201` Task (503 if no orchestrator/registry wired; registry is required to resolve assignee — pass registry into the service).
- `GET /api/tasks` — all tasks (optional `?assignee=&state=` filter for daemon catch-up).
- `GET /api/tasks/:id` — one task (404 if missing).
- `POST /api/tasks/:id/state` — body `{ state }` → `updateState` → `200` Task (409 invalid transition, 404 missing). Daemon → hub.

### 4.4 WebSocket
`/ws` broadcasts `{ type: "task", task }` on the `mailbox.events` `"task"` event (daemon
filters to its agents; clients update their task store). Wire alongside the existing
message/thread/turn/agent-status frames, with matching `off` cleanup on socket close.

### 4.5 Thread broadcast on creation
`mailbox.createThread` currently emits no event, so newly created threads are invisible to
connected clients until refresh. Change `createThread` to `this.events.emit("thread", thread)`
after insert. This makes task threads (and debate threads) appear live via the existing
`{type:"thread"}` frame + the web store's `applyFrame("thread")` upsert. Low risk: the frame
is an upsert; existing consumers already handle `thread` frames.

## 5. Daemon

- **`HubSocket`**: add `onTask?: (task: Task) => void`; parse `{type:"task"}` frames with
  `TaskSchema` and dispatch (mirrors the existing `onTurn` handling).
- **`AgentLoop.handleTask(task)`**: if `task.assignee` is one of my agents AND `task.state === "queued"`
  AND not already started (dedupe `Set<taskId>`) → `queue.run(task.assignee, () => this.runTask(agent, task))`.
- **Task catch-up** in `onOpen` (before/with message catch-up): for each of my agents,
  `GET /api/tasks?assignee=<id>&state=queued` and `handleTask` each. Because tasks are
  persisted, this recovers tasks queued while the daemon was down — closing the turn-frame-loss
  gap (step-3 review) for tasks.
- **`runTask(agent, task)`**:
  1. Mark started (dedupe set); `POST /api/tasks/:id/state {running}`; `reportStatus(running, "task <id>")`.
  2. `adapter.runTurn({ cwd: agent.workspace, prompt: buildTaskPrompt(agent, task), sessionId: undefined, allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS], mcpServers: bridge(task.threadId, agent.id) })`.
  3. `reportTurn` (usage + error status) as for turns.
  4. On success: `postMessage(task.threadId, { from: agent.id, to: [], type: "text", body: result.text })`;
     `POST /api/tasks/:id/state {done}`.
  5. On `result.isError` or thrown error: post a `status` message with the reason;
     `POST /api/tasks/:id/state {failed}`. `reportTurnStatus` handles blocked/idle.
- **`buildTaskPrompt(agent, task)`**: role prefix + "You are agent \"<id>\". Delegated task:\n\n<spec>\n\nWork in this workspace. Hub MCP tools are available. Your final response is posted as the task result."
- A rate-limited/blocked agent yields `result.isError` → task `failed` with the reason
  (no usage-threshold pre-check this MVP).

Wire `onTask` and task catch-up in `daemon/src/main.ts`.

## 6. Web

- **Composer**: when the text starts with `/task`, parse `/task @<agent> <spec>`. The agent must
  be a known registry agent; the rest is the spec. On send → `hubClient.createTask({ assignee, spec, workspace: activeThread?.workspace })`, then fetch the returned `task.threadId` thread +
  messages and `setActiveThread` it. Show a small hint while composing (`/task @agent …`).
  `@mention` autocomplete (step 4) also assists after `/task @`.
- **Store**: add `tasksById: Record<string, Task>`; `applyFrame` handles `{type:"task"}` →
  upsert by id. New task threads arrive via the now-broadcast `{type:"thread"}` frame.
- **`ContextToolbar`**: when the active thread's `kind === "task"`, show `● task: <state>`
  from the task whose `threadId` matches (colored by state: running teal, failed danger,
  done muted). Transitions also appear as status lines in the chat (already rendered).
- **hubClient**: `createTask`, `getTask`, `listTasks`.

## 7. Explicitly deferred (with owning step/sub-project)

- Agent-to-agent task creation — needs ACLs (later in step 5 / step 6).
- Gated-action approvals, web push, `input-required` interactive tasks — **step 6**.
- Live CLI-event streaming into the thread — later (chose state+result).
- Usage-threshold scheduling refusal (§6 usage-aware scheduling) — needs the 5h-window data
  deferred in step 4; blocked agents surface as `failed` tasks meanwhile.
- Artifacts on task output (`Task.artifacts`, `create_artifact`) — **artifacts sub-project**.
- Task cancellation / retry UI — later.

## 8. Testing (Vitest; spec §11)

- **shared**: `TaskSchema` / `NewTaskSchema` accept/reject; state enum.
- **hub**: `TaskStore` CRUD + transition guard (reject `queued→done`, `running→queued`);
  `createTask` creates a `task` thread with the spec message `to: []` and emits a `task` event;
  `POST /api/tasks` (unknown assignee → 400); `/state` invalid transition → 409; catch-up
  filter (`listByAssigneeState`); `createThread` now emits a `thread` event.
- **daemon**: `handleTask` runs the agent and reports `running`→`done`, posts the result;
  `isError` → `failed` + status message; catch-up picks up queued tasks on connect;
  double-delivery (frame + catch-up) runs the task once.
- **web**: composer `/task @agent spec` → `createTask` called with parsed assignee+spec;
  `task` frame → `tasksById` upsert; toolbar shows state on a task thread.

## 9. Implementation order (for the plan)

1. shared: `Task`/`NewTask`/`TaskState` schemas.
2. hub: `tasks` table + `TaskStore` (+ transition guard); tests.
3. hub: `createTask` service + `mailbox.createThread` thread-event; tests.
4. hub: `/api/tasks` routes + `/state` + `{type:"task"}` WS frame; tests.
5. daemon: `HubSocket.onTask`; `AgentLoop.handleTask`/`runTask` + dedupe; tests.
6. daemon: task catch-up on connect + `main.ts` wiring; tests.
7. web: hubClient `createTask`/`listTasks`; store `tasksById` + `task` frame; tests.
8. web: composer `/task` parsing + thread select; `ContextToolbar` task state; tests.
9. e2e verification: seed a task via `/task` against a live hub + fake adapter; full green.
