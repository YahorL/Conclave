import type Database from "better-sqlite3";

export interface DebateRecord {
  id: string;
  threadId: string;
  participants: string[];
  stances: Record<string, string>;
  minRounds: number;
  maxRounds: number;
  round: number;
  state: "running" | "settled" | "inconclusive" | "interrupted";
}

interface DebateRow {
  id: string;
  thread_id: string;
  participants: string;
  stances: string;
  min_rounds: number;
  max_rounds: number;
  round: number;
  state: string;
  created_at: string;
}

export class DebateStore {
  constructor(private readonly db: Database.Database) {}

  create(rec: DebateRecord): void {
    this.db
      .prepare(
        `INSERT INTO debates (id, thread_id, participants, stances, min_rounds, max_rounds, round, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.threadId,
        JSON.stringify(rec.participants),
        JSON.stringify(rec.stances),
        rec.minRounds,
        rec.maxRounds,
        rec.round,
        rec.state,
        new Date().toISOString(),
      );
  }

  get(id: string): DebateRecord | undefined {
    const row = this.db.prepare("SELECT * FROM debates WHERE id = ?").get(id) as
      | DebateRow
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      threadId: row.thread_id,
      participants: JSON.parse(row.participants) as string[],
      stances: JSON.parse(row.stances) as Record<string, string>,
      minRounds: row.min_rounds,
      maxRounds: row.max_rounds,
      round: row.round,
      state: row.state as DebateRecord["state"],
    };
  }

  update(id: string, patch: Partial<Pick<DebateRecord, "round" | "state">>): void {
    if (patch.round !== undefined) {
      this.db.prepare("UPDATE debates SET round = ? WHERE id = ?").run(patch.round, id);
    }
    if (patch.state !== undefined) {
      this.db.prepare("UPDATE debates SET state = ? WHERE id = ?").run(patch.state, id);
    }
  }

  markRunningInterrupted(): number {
    const info = this.db
      .prepare("UPDATE debates SET state = 'interrupted' WHERE state = 'running'")
      .run();
    return info.changes;
  }
}
