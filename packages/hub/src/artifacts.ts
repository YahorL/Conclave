import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Artifact, NewArtifact } from "@conclave/shared";

const MAX_BYTES = 50 * 1024 * 1024;

export class ArtifactTooLargeError extends Error {
  constructor(size: number) {
    super(`artifact too large: ${size} bytes (max ${MAX_BYTES})`);
  }
}

interface ArtifactRow {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  created_by: string;
  created_at: string;
}

function rowToArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id, name: r.name, mime: r.mime, size: r.size, sha256: r.sha256,
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

const META_COLS = "id, name, mime, size, sha256, created_by, created_at";

export class ArtifactStore {
  constructor(private readonly db: Database.Database) {}

  create(input: NewArtifact): Artifact {
    const buf = Buffer.from(input.content, "utf-8");
    if (buf.byteLength > MAX_BYTES) throw new ArtifactTooLargeError(buf.byteLength);
    const artifact: Artifact = {
      id: randomUUID(),
      name: input.name,
      mime: input.mime,
      size: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
      createdBy: input.createdBy ?? "unknown",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO artifacts (id, name, mime, size, sha256, created_by, created_at, blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id, artifact.name, artifact.mime, artifact.size, artifact.sha256,
        artifact.createdBy, artifact.createdAt, buf,
      );
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare(`SELECT ${META_COLS} FROM artifacts WHERE id = ?`).get(id) as
      | ArtifactRow
      | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  getBlob(id: string): Buffer | undefined {
    const row = this.db.prepare("SELECT blob FROM artifacts WHERE id = ?").get(id) as
      | { blob: Buffer }
      | undefined;
    return row?.blob;
  }

  list(): Artifact[] {
    return (
      this.db.prepare(`SELECT ${META_COLS} FROM artifacts ORDER BY created_at DESC`).all() as ArtifactRow[]
    ).map(rowToArtifact);
  }
}
