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

    CREATE TABLE IF NOT EXISTS debates (
      id           TEXT PRIMARY KEY,
      thread_id    TEXT NOT NULL REFERENCES threads(id),
      participants TEXT NOT NULL,
      stances      TEXT NOT NULL DEFAULT '{}',
      min_rounds   INTEGER NOT NULL,
      max_rounds   INTEGER NOT NULL,
      round        INTEGER NOT NULL DEFAULT 0,
      state        TEXT NOT NULL DEFAULT 'running',
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent         TEXT NOT NULL,
      thread_id     TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      ts            TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS artifacts (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      sha256     TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      blob       BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      machine     TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id              TEXT PRIMARY KEY,
      thread_id       TEXT NOT NULL REFERENCES threads(id),
      task_id         TEXT,
      requested_by    TEXT NOT NULL,
      action          TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'pending',
      note            TEXT,
      created_at      TEXT NOT NULL,
      decided_at      TEXT,
      UNIQUE (requested_by, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
