import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export class PathJailError extends Error {
  constructor(p: string) {
    super(`path not within a granted root: ${p}`);
  }
}

export class GrantStore {
  constructor(private readonly grantsFile: string) {}

  roots(): string[] {
    if (!existsSync(this.grantsFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.grantsFile, "utf8")) as { files?: unknown };
      if (!Array.isArray(parsed.files)) return [];
      return parsed.files.filter((r): r is string => typeof r === "string").map((r) => resolve(r));
    } catch {
      return [];
    }
  }

  isAllowed(p: string): boolean {
    const abs = resolve(p);
    return this.roots().some((root) => abs === root || abs.startsWith(root + sep));
  }

  resolveJailed(p: string): string {
    const abs = resolve(p);
    if (!this.isAllowed(abs)) throw new PathJailError(p);
    return abs;
  }
}
