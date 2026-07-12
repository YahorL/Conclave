import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NewThread, Thread } from "@conclave/shared";

export class ThreadNotFoundError extends Error {
  constructor(id: string) {
    super(`thread not found: ${id}`);
  }
}

export class ThreadClosedError extends Error {
  constructor(id: string) {
    super(`thread is closed: ${id}`);
  }
}

export class NotAParticipantError extends Error {
  constructor(agent: string) {
    super(`not a participant: ${agent}`);
  }
}

interface ThreadRow {
  id: string;
  kind: string;
  workspace: string | null;
  participants: string;
  state: string;
  verdicts: string;
  created_at: string;
}

export class Mailbox {
  readonly events = new EventEmitter();

  constructor(private readonly db: Database.Database) {}

  createThread(input: NewThread): Thread {
    const thread: Thread = {
      id: randomUUID(),
      kind: input.kind,
      workspace: input.workspace ?? null,
      participants: input.participants,
      state: "open",
      verdicts: {},
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO threads (id, kind, workspace, participants, state, verdicts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.kind,
        thread.workspace,
        JSON.stringify(thread.participants),
        thread.state,
        JSON.stringify(thread.verdicts),
        thread.createdAt,
      );
    return thread;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? rowToThread(row) : undefined;
  }

  listThreads(): Thread[] {
    const rows = this.db
      .prepare("SELECT * FROM threads ORDER BY created_at DESC, rowid DESC")
      .all() as ThreadRow[];
    return rows.map(rowToThread);
  }
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    kind: row.kind as Thread["kind"],
    workspace: row.workspace,
    participants: JSON.parse(row.participants) as string[],
    state: row.state as Thread["state"],
    verdicts: JSON.parse(row.verdicts) as Record<string, string>,
    createdAt: row.created_at,
  };
}
