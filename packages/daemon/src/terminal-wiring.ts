import type { TermToDaemonFrame, TerminalKind } from "@conclave/shared";
import type { TerminalService } from "./terminal-service.js";

export interface TerminalWiringDeps {
  service: TerminalService | null;
  granted: boolean;
  send: (frame: unknown) => void;
  resolveTakeover?: (
    agentId: string,
    threadId: string,
  ) => { kind: TerminalKind; cwd: string; resumeSessionId?: string } | null;
}

// Frame handler for hub->daemon terminal traffic plus upstream event wiring.
// The daemon never tracks attached clients — the hub owns subscriptions; this
// side only answers attach with a ring-buffer replay.
export function wireTerminals(deps: TerminalWiringDeps): {
  onTerm: (f: TermToDaemonFrame) => void;
  sendList: () => void;
} {
  const { service, send } = deps;
  const sendList = (): void => {
    send({ type: "term-list", terminals: service?.list() ?? [] });
  };

  if (service) {
    service.events.on("data", (terminalId: string, data: string) => {
      send({ type: "term-data", terminalId, data });
    });
    service.events.on("exit", (terminalId: string, exitCode: number) => {
      send({ type: "term-exit", terminalId, exitCode });
    });
    service.events.on("list-changed", sendList);
  }

  const onTerm = (f: TermToDaemonFrame): void => {
    if (!service || !deps.granted) {
      if (f.type === "term-spawn" || f.type === "term-takeover")
        send({ type: "term-error", message: "terminals not available on this machine" });
      return;
    }
    try {
      switch (f.type) {
        case "term-spawn":
          service.spawn({ kind: f.kind, cwd: f.cwd });
          break; // list-changed event already sent the updated term-list
        case "term-kill":
          service.kill(f.terminalId);
          break;
        case "term-data":
          service.write(f.terminalId, f.data);
          break;
        case "term-resize":
          service.resize(f.terminalId, f.cols, f.rows);
          break;
        case "term-attach":
          send({ type: "term-replay", terminalId: f.terminalId, requestId: f.requestId, data: service.replay(f.terminalId) });
          break;
        case "term-takeover": {
          const r = deps.resolveTakeover?.(f.agentId, f.threadId);
          if (!r) {
            send({ type: "term-error", message: `unknown agent: ${f.agentId}` });
            break;
          }
          service.spawn({ kind: r.kind, cwd: r.cwd, resumeSessionId: r.resumeSessionId, takeover: true, agentId: f.agentId });
          break; // list-changed event sends the updated term-list
        }
        case "term-detach":
          break; // hub-side bookkeeping only
      }
    } catch (err) {
      send({ type: "term-error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return { onTerm, sendList };
}
