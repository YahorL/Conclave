import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Message, NewMessage, NewThread, Thread } from "@conclave/shared";

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

export interface MessageRow {
  id: number;
  thread_id: string;
  sender: string;
  recipients: string;
  type: string;
  body: string;
  artifacts: string;
  ts: string;
}

export class Mailbox {
  readonly events = new EventEmitter();

  constructor(private readonly db: Database.Database) {
    this.events.setMaxListeners(0);
  }

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

  appendMessage(threadId: string, input: NewMessage): Message {
    const thread = this.requireOpenThread(threadId);
    const ts = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO messages (thread_id, sender, recipients, type, body, artifacts, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        input.from,
        JSON.stringify(input.to),
        input.type,
        input.body,
        JSON.stringify(input.artifacts),
        ts,
      );
    const message: Message = {
      id: Number(info.lastInsertRowid),
      threadId: thread.id,
      from: input.from,
      to: input.to,
      type: input.type,
      body: input.body,
      artifacts: input.artifacts,
      ts,
    };
    this.events.emit("message", message);
    return message;
  }

  listMessages(threadId: string, afterId = 0): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id ASC")
      .all(threadId, afterId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  listAllMessages(afterId = 0, limit = 500): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit) as MessageRow[];
    return rows.map(rowToMessage);
  }

  setVerdict(threadId: string, agent: string, verdict: string): Thread {
    const thread = this.requireOpenThread(threadId);
    if (!thread.participants.includes(agent)) throw new NotAParticipantError(agent);
    const verdicts = { ...thread.verdicts, [agent]: verdict };
    const settled = thread.participants.every((p) => verdicts[p] !== undefined);
    const state: Thread["state"] = settled ? "settled" : thread.state;
    this.db
      .prepare("UPDATE threads SET verdicts = ?, state = ? WHERE id = ?")
      .run(JSON.stringify(verdicts), state, threadId);
    const updated: Thread = { ...thread, verdicts, state };
    this.events.emit("thread", updated);
    return updated;
  }

  closeThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    this.db.prepare("UPDATE threads SET state = 'closed' WHERE id = ?").run(threadId);
    const updated: Thread = { ...thread, state: "closed" };
    this.events.emit("thread", updated);
    return updated;
  }

  private requireOpenThread(threadId: string): Thread {
    const thread = this.getThread(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    if (thread.state === "closed") throw new ThreadClosedError(threadId);
    return thread;
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

export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    from: row.sender,
    to: JSON.parse(row.recipients) as string[],
    type: row.type as Message["type"],
    body: row.body,
    artifacts: JSON.parse(row.artifacts) as string[],
    ts: row.ts,
  };
}
