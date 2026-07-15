import type { FsResponse } from "@conclave/shared";

export type FsSocket = { send(data: string): void };

export class PendingRequests {
  private readonly map = new Map<string, { resolve: (r: FsResponse) => void; timer: NodeJS.Timeout }>();

  create(id: string, timeoutMs: number): Promise<FsResponse> {
    return new Promise<FsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        reject(new Error(`fs request ${id} timed out`));
      }, timeoutMs);
      this.map.set(id, { resolve, timer });
    });
  }

  settle(id: string, res: FsResponse): void {
    const entry = this.map.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.map.delete(id);
    entry.resolve(res);
  }
}

export interface MachineConn {
  socket: FsSocket;
  roots: string[];
  terminals: boolean;
  lastSeen: string;
}

export class MachineRegistry {
  private readonly byMachine = new Map<string, MachineConn>();

  register(machine: string, socket: FsSocket, roots: string[], terminals = false): void {
    this.byMachine.set(machine, { socket, roots, terminals, lastSeen: new Date().toISOString() });
  }

  unregisterSocket(socket: FsSocket): void {
    for (const [machine, conn] of this.byMachine) {
      if (conn.socket === socket) this.byMachine.delete(machine);
    }
  }

  get(machine: string): MachineConn | undefined {
    return this.byMachine.get(machine);
  }

  machineOfSocket(socket: FsSocket): string | undefined {
    for (const [machine, conn] of this.byMachine) {
      if (conn.socket === socket) return machine;
    }
    return undefined;
  }

  list(): Array<{ machine: string; files: string[]; terminals: boolean; lastSeen: string }> {
    return [...this.byMachine.entries()].map(([machine, c]) => ({
      machine, files: c.roots, terminals: c.terminals, lastSeen: c.lastSeen,
    }));
  }
}
