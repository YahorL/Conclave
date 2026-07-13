import type Database from "better-sqlite3";
import type { Task, TaskState } from "@conclave/shared";

export class InvalidTransitionError extends Error {
  constructor(from: TaskState, to: TaskState) {
    super(`invalid task transition: ${from} -> ${to}`);
  }
}

const ALLOWED: Record<TaskState, TaskState[]> = {
  queued: ["running", "failed"],
  running: ["done", "failed"],
  "input-required": ["running", "failed"],
  done: [],
  failed: [],
};

interface TaskRow {
  id: string;
  thread_id: string;
  assignee: string;
  spec: string;
  state: string;
  artifacts: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    threadId: r.thread_id,
    assignee: r.assignee,
    spec: r.spec,
    state: r.state as TaskState,
    artifacts: JSON.parse(r.artifacts) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class TaskStore {
  constructor(private readonly db: Database.Database) {}

  create(task: Task): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, thread_id, assignee, spec, state, artifacts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id, task.threadId, task.assignee, task.spec, task.state,
        JSON.stringify(task.artifacts), task.createdAt, task.updatedAt,
      );
    return task;
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  list(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as TaskRow[]).map(
      rowToTask,
    );
  }

  listByAssigneeState(assignee: string, state: TaskState): Task[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks WHERE assignee = ? AND state = ? ORDER BY created_at ASC")
        .all(assignee, state) as TaskRow[]
    ).map(rowToTask);
  }

  updateState(id: string, state: TaskState): Task {
    const current = this.get(id);
    if (!current) throw new Error(`task not found: ${id}`);
    if (!ALLOWED[current.state].includes(state)) {
      throw new InvalidTransitionError(current.state, state);
    }
    const updatedAt = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(state, updatedAt, id);
    return { ...current, state, updatedAt };
  }
}
