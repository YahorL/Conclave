import { EventEmitter } from "node:events";
import type { AgentStatus, AgentStatusReport } from "@conclave/shared";

export class AgentStatusStore {
  readonly events = new EventEmitter();
  private readonly byAgent = new Map<string, AgentStatus>();

  constructor() {
    this.events.setMaxListeners(0);
  }

  set(report: AgentStatusReport): AgentStatus {
    const status: AgentStatus = { ...report, ts: new Date().toISOString() };
    this.byAgent.set(report.agent, status);
    this.events.emit("agent-status", status);
    return status;
  }

  list(): AgentStatus[] {
    return [...this.byAgent.values()];
  }
}
