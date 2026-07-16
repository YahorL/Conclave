import type { AgentStatus, Approval, Artifact, Message, Task, TerminalInfo, Thread, TurnRequest, Workspace } from "@conclave/shared";
import { config } from "./config.js";

export type WsFrame =
  | { type: "message"; message: Message }
  | { type: "thread"; thread: Thread }
  | { type: "turn"; turn: TurnRequest }
  | { type: "agent-status"; status: AgentStatus }
  | { type: "task"; task: Task }
  | { type: "artifact"; artifact: Artifact }
  | { type: "workspace"; workspace: Workspace }
  | { type: "approval"; approval: Approval }
  | { type: "terminal-list"; terminals: TerminalInfo[] };

export type TermStreamFrame = {
  type: "term-data" | "term-replay" | "term-exit" | "term-error";
  terminalId?: string;
  requestId?: string;
  data?: string;
  exitCode?: number;
  message?: string;
};

// High-frequency terminal frames bypass the Zustand store: TerminalView
// subscribes directly. NOTE "terminal-list" also starts with "term-", so
// dispatch is by explicit membership, never prefix.
const TERM_STREAM_TYPES = new Set(["term-data", "term-replay", "term-exit", "term-error"]);

const termHandlers = new Set<(f: TermStreamFrame) => void>();
let current: WebSocket | null = null;

export function onTermFrame(fn: (f: TermStreamFrame) => void): () => void {
  termHandlers.add(fn);
  return () => termHandlers.delete(fn);
}

export function sendFrame(frame: unknown): boolean {
  if (!current || current.readyState !== WebSocket.OPEN) return false;
  current.send(JSON.stringify(frame));
  return true;
}

export function connectSocket(onFrame: (f: WsFrame) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const open = (): void => {
    if (closed) return;
    ws = new WebSocket(config.wsUrl());
    ws.onopen = () => {
      backoff = 500;
      current = ws;
    };
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data as string) as { type?: string };
        if (typeof frame.type === "string" && TERM_STREAM_TYPES.has(frame.type)) {
          for (const fn of termHandlers) fn(frame as TermStreamFrame);
        } else {
          onFrame(frame as WsFrame);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (current === ws) current = null;
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
  };
  open();

  return () => {
    closed = true;
    if (current === ws) current = null;
    ws?.close();
  };
}
