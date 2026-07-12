import { existsSync, readFileSync, writeFileSync } from "node:fs";

export class SessionStore {
  private sessions: Record<string, string> = {};

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          this.sessions = parsed as Record<string, string>;
        }
      } catch {
        this.sessions = {};
      }
    }
  }

  get(threadId: string, agentId: string): string | undefined {
    return this.sessions[`${threadId}::${agentId}`];
  }

  set(threadId: string, agentId: string, sessionId: string): void {
    this.sessions[`${threadId}::${agentId}`] = sessionId;
    writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2));
  }
}
