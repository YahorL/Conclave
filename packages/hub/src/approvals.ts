import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Approval, ApprovalState, NewApproval } from "@conclave/shared";
import type { Mailbox } from "./mailbox.js";
import type { TaskStore } from "./tasks.js";

export class AlreadyDecidedError extends Error {
  constructor(id: string, state: ApprovalState) {
    super(`approval ${id} already decided: ${state}`);
  }
}

interface ApprovalRow {
  id: string;
  thread_id: string;
  task_id: string | null;
  requested_by: string;
  action: string;
  idempotency_key: string;
  state: string;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    threadId: r.thread_id,
    ...(r.task_id ? { taskId: r.task_id } : {}),
    requestedBy: r.requested_by,
    action: r.action,
    idempotencyKey: r.idempotency_key,
    state: r.state as ApprovalState,
    ...(r.note ? { note: r.note } : {}),
    createdAt: r.created_at,
    ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
  };
}

export class ApprovalStore {
  constructor(private readonly db: Database.Database) {}

  create(a: Approval): Approval {
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, thread_id, task_id, requested_by, action, idempotency_key, state, note, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.threadId, a.taskId ?? null, a.requestedBy, a.action,
        a.idempotencyKey, a.state, a.note ?? null, a.createdAt, a.decidedAt ?? null,
      );
    return a;
  }

  findByKey(requestedBy: string, key: string): Approval | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE requested_by = ? AND idempotency_key = ?")
      .get(requestedBy, key) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  list(state?: ApprovalState): Approval[] {
    const rows = state
      ? (this.db
          .prepare("SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC")
          .all(state) as ApprovalRow[])
      : (this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as ApprovalRow[]);
    return rows.map(rowToApproval);
  }

  decide(id: string, decision: "approved" | "denied", note?: string): Approval {
    const current = this.get(id);
    if (!current) throw new Error(`approval not found: ${id}`);
    if (current.state !== "pending") throw new AlreadyDecidedError(id, current.state);
    const decidedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE approvals SET state = ?, note = ?, decided_at = ? WHERE id = ?")
      .run(decision, note ?? null, decidedAt, id);
    return { ...current, state: decision, ...(note ? { note } : {}), decidedAt };
  }
}

export interface ApprovalDeps {
  mailbox: Mailbox;
  store: ApprovalStore;
  tasks?: TaskStore;
}

export function fileApproval(deps: ApprovalDeps, input: NewApproval): Approval {
  const existing = deps.store.findByKey(input.requestedBy, input.idempotencyKey);
  if (existing) return existing;

  const task = input.taskId
    ? deps.tasks?.get(input.taskId)
    : deps.tasks?.getByThread(input.threadId);
  const approval: Approval = {
    id: randomUUID(),
    threadId: input.threadId,
    ...(task ? { taskId: task.id } : {}),
    requestedBy: input.requestedBy,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    state: "pending",
    createdAt: new Date().toISOString(),
  };
  deps.store.create(approval);
  deps.mailbox.appendMessage(input.threadId, {
    from: input.requestedBy,
    to: [],
    type: "approval-request",
    body: JSON.stringify({ approvalId: approval.id, action: approval.action }),
    artifacts: [],
  });
  if (task && deps.tasks && task.state === "running") {
    const updated = deps.tasks.updateState(task.id, "input-required");
    deps.mailbox.events.emit("task", updated);
  }
  deps.mailbox.events.emit("approval", approval);
  return approval;
}

export function decideApproval(
  deps: ApprovalDeps,
  id: string,
  decision: "approved" | "denied",
  note?: string,
): Approval {
  const approval = deps.store.decide(id, decision, note);
  deps.mailbox.appendMessage(approval.threadId, {
    from: "you",
    to: [],
    type: "status",
    body: `you ${decision}: ${approval.action}${note ? ` — ${note}` : ""}`,
    artifacts: [],
  });
  if (approval.taskId && deps.tasks) {
    const t = deps.tasks.get(approval.taskId);
    if (t && t.state === "input-required") {
      const updated = deps.tasks.updateState(approval.taskId, "running");
      deps.mailbox.events.emit("task", updated);
    }
  }
  deps.mailbox.events.emit("approval", approval);
  return approval;
}
