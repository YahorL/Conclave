import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { NewWorkspace, Workspace } from "@conclave/shared";

interface WorkspaceRow {
  id: string; name: string; machine: string; folder_path: string; created_at: string;
}
function rowTo(r: WorkspaceRow): Workspace {
  return { id: r.id, name: r.name, machine: r.machine, folderPath: r.folder_path, createdAt: r.created_at };
}

export class WorkspaceStore {
  constructor(private readonly db: Database.Database) {}

  create(input: NewWorkspace): Workspace {
    const ws: Workspace = {
      id: randomUUID(),
      name: input.name ?? basename(input.folderPath) ?? input.folderPath,
      machine: input.machine,
      folderPath: input.folderPath,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO workspaces (id, name, machine, folder_path, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(ws.id, ws.name, ws.machine, ws.folderPath, ws.createdAt);
    return ws;
  }

  get(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    return row ? rowTo(row) : undefined;
  }

  list(): Workspace[] {
    return (this.db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC").all() as WorkspaceRow[]).map(rowTo);
  }
}
