import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FsEntry, FsRequest, FsResponse, FsStat } from "@conclave/shared";
import type { GrantStore } from "./grants.js";

const MAX_READ = 5 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(size: number) {
    super(`file too large to read: ${size} bytes (max ${MAX_READ})`);
  }
}

export class FileService {
  constructor(private readonly grants: GrantStore) {}

  async list(path: string): Promise<FsEntry[]> {
    const dir = this.grants.resolveJailed(path);
    const entries = await readdir(dir, { withFileTypes: true });
    const out: FsEntry[] = [];
    for (const e of entries) {
      if (e.isDirectory()) out.push({ name: e.name, kind: "dir" });
      else {
        const s = await stat(join(dir, e.name));
        out.push({ name: e.name, kind: "file", size: s.size });
      }
    }
    return out;
  }

  async stat(path: string): Promise<FsStat> {
    const abs = this.grants.resolveJailed(path);
    const s = await stat(abs);
    return { kind: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtime.toISOString() };
  }

  async read(path: string): Promise<{ content: string }> {
    const abs = this.grants.resolveJailed(path);
    const s = await stat(abs);
    if (s.size > MAX_READ) throw new FileTooLargeError(s.size);
    return { content: await readFile(abs, "utf8") };
  }

  async write(path: string, content: string): Promise<{ ok: true }> {
    const abs = this.grants.resolveJailed(path);
    await writeFile(abs, content, "utf8");
    return { ok: true };
  }

  async handle(req: FsRequest): Promise<FsResponse> {
    try {
      let result: unknown;
      if (req.op === "list") result = await this.list(req.path);
      else if (req.op === "stat") result = await this.stat(req.path);
      else if (req.op === "read") result = await this.read(req.path);
      else result = await this.write(req.path, req.content ?? "");
      return { id: req.id, ok: true, result };
    } catch (e) {
      return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
