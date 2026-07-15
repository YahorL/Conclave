import type { TerminalInfo } from "@conclave/shared";
import type { FsSocket } from "./fs-tunnel.js";

export class TerminalRegistry {
  private readonly byMachine = new Map<string, TerminalInfo[]>();
  private readonly attachments = new Map<string, Set<FsSocket>>();
  private readonly pendingAttach = new Map<string, FsSocket>();

  setList(machine: string, terminals: TerminalInfo[]): void {
    this.byMachine.set(machine, terminals);
    // drop attachments for terminals that no longer exist on any machine
    const liveIds = new Set(this.list().map((t) => t.id));
    for (const id of [...this.attachments.keys()]) {
      if (!liveIds.has(id)) this.attachments.delete(id);
    }
  }

  list(): TerminalInfo[] {
    return [...this.byMachine.values()].flat();
  }

  machineOf(id: string): string | undefined {
    for (const [machine, terms] of this.byMachine) {
      if (terms.some((t) => t.id === id)) return machine;
    }
    return undefined;
  }

  clearMachine(machine: string): void {
    this.byMachine.delete(machine);
  }

  attach(id: string, socket: FsSocket): void {
    const set = this.attachments.get(id) ?? new Set<FsSocket>();
    set.add(socket);
    this.attachments.set(id, set);
  }

  detach(id: string, socket: FsSocket): void {
    this.attachments.get(id)?.delete(socket);
  }

  detachSocket(socket: FsSocket): void {
    for (const set of this.attachments.values()) set.delete(socket);
    for (const [reqId, s] of this.pendingAttach) {
      if (s === socket) this.pendingAttach.delete(reqId);
    }
  }

  attached(id: string): FsSocket[] {
    return [...(this.attachments.get(id) ?? [])];
  }

  notePendingAttach(requestId: string, socket: FsSocket): void {
    this.pendingAttach.set(requestId, socket);
  }

  takePendingAttach(requestId: string): FsSocket | undefined {
    const s = this.pendingAttach.get(requestId);
    this.pendingAttach.delete(requestId);
    return s;
  }
}
