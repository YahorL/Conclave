import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

interface StateShape {
  sessions: Record<string, string>;
  cursor: number;
  watermarks: Record<string, number>;
}

const EMPTY: StateShape = { sessions: {}, cursor: 0, watermarks: {} };

export class DaemonState {
  private state: StateShape;

  constructor(private readonly filePath: string) {
    this.state = { ...EMPTY, sessions: {}, watermarks: {} };
    if (!existsSync(filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj["cursor"] === "number" &&
        typeof obj["sessions"] === "object" &&
        obj["sessions"] !== null
      ) {
        const wm = obj["watermarks"];
        this.state = {
          sessions: obj["sessions"] as Record<string, string>,
          cursor: obj["cursor"],
          watermarks:
            typeof wm === "object" && wm !== null && !Array.isArray(wm)
              ? (wm as Record<string, number>)
              : {},
        };
      } else if (Object.values(obj).every((v) => typeof v === "string")) {
        // legacy step-2 SessionStore flat file
        this.state = { sessions: obj as Record<string, string>, cursor: 0, watermarks: {} };
      }
    } catch {
      // corrupt file — start empty
    }
  }

  private key(threadId: string, agentId: string): string {
    return JSON.stringify([threadId, agentId]);
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.filePath);
  }

  getSession(threadId: string, agentId: string): string | undefined {
    return this.state.sessions[this.key(threadId, agentId)];
  }

  setSession(threadId: string, agentId: string, sessionId: string): void {
    this.state.sessions[this.key(threadId, agentId)] = sessionId;
    this.persist();
  }

  getCursor(): number {
    return this.state.cursor;
  }

  setCursor(id: number): void {
    if (id <= this.state.cursor) return;
    this.state.cursor = id;
    this.persist();
  }

  getWatermark(threadId: string, agentId: string): number {
    return this.state.watermarks[this.key(threadId, agentId)] ?? 0;
  }

  setWatermark(threadId: string, agentId: string, id: number): void {
    if (id <= this.getWatermark(threadId, agentId)) return;
    this.state.watermarks[this.key(threadId, agentId)] = id;
    this.persist();
  }
}
