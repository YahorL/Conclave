import Database from "better-sqlite3";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      workspace    TEXT,
      participants TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'open',
      verdicts     TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  TEXT NOT NULL REFERENCES threads(id),
      sender     TEXT NOT NULL,
      recipients TEXT NOT NULL,
      type       TEXT NOT NULL,
      body       TEXT NOT NULL,
      artifacts  TEXT NOT NULL DEFAULT '[]',
      ts         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
  `);
}
