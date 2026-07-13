import type { AgentStatus, Artifact, Message, Task, Thread, TurnRequest } from "@conclave/shared";
import { config } from "./config.js";

export type WsFrame =
  | { type: "message"; message: Message }
  | { type: "thread"; thread: Thread }
  | { type: "turn"; turn: TurnRequest }
  | { type: "agent-status"; status: AgentStatus }
  | { type: "task"; task: Task }
  | { type: "artifact"; artifact: Artifact };

export function connectSocket(onFrame: (f: WsFrame) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const open = (): void => {
    if (closed) return;
    ws = new WebSocket(config.wsUrl());
    ws.onopen = () => {
      backoff = 500;
    };
    ws.onmessage = (ev) => {
      try {
        onFrame(JSON.parse(ev.data as string) as WsFrame);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
  };
  open();

  return () => {
    closed = true;
    ws?.close();
  };
}
