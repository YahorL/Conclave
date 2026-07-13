import WebSocket from "ws";
import { MessageSchema, type Message } from "@conclave/shared";

export interface HubSocketOptions {
  hubUrl: string;
  token: string;
  onMessage: (m: Message) => void;
  reconnectDelayMs?: number;
}

export class HubSocket {
  private ws: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private started = false;

  constructor(private readonly opts: HubSocketOptions) {}

  start(): void {
    // Guard against re-entrancy: if a socket is already open/connecting, this
    // is a no-op so callers can't accidentally spin up a second live socket.
    if (this.started && this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const wsUrl = `${this.opts.hubUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(this.opts.token)}`;

    // If a previous socket is still referenced (e.g. a fresh connect() is
    // superseding one whose close/error hasn't fired yet), close it now. The
    // identity guard below makes that old socket's eventual close/error a
    // no-op, so this can't recurse back into connect().
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
      this.ws.close();
    }

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("message", (data) => {
      try {
        const frame: unknown = JSON.parse(String(data));
        const candidate = (frame as { type?: unknown; message?: unknown });
        if (candidate.type !== "message") return;
        const parsed = MessageSchema.safeParse(candidate.message);
        if (parsed.success) this.opts.onMessage(parsed.data);
      } catch {
        // ignore unparseable frames
      }
    });

    const scheduleReconnect = (): void => {
      if (ws !== this.ws) return; // stale socket event — a newer connection owns the lifecycle
      if (this.stopped || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect();
      }, this.opts.reconnectDelayMs ?? 1000);
    };

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  }
}
