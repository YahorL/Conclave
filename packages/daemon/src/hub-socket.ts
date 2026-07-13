import WebSocket from "ws";
import {
  MessageSchema,
  TurnRequestSchema,
  type Message,
  type TurnRequest,
} from "@conclave/shared";

export interface HubSocketOptions {
  hubUrl: string;
  token: string;
  onOpen?: () => void | Promise<void>;
  onMessage: (m: Message) => void;
  onTurn?: (turn: TurnRequest) => void;
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
    this.reconnectTimer = undefined;
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

    // While onOpen runs (e.g. a catch-up scan), buffer live frames so they are
    // delivered after catch-up completes, in arrival order.
    let buffering = this.opts.onOpen !== undefined;
    const buffer: Array<Buffer | string> = [];

    const handleData = (data: Buffer | string): void => {
      try {
        const frame: unknown = JSON.parse(String(data));
        const candidate = frame as { type?: unknown; message?: unknown; turn?: unknown };
        if (candidate.type === "message") {
          const parsed = MessageSchema.safeParse(candidate.message);
          if (parsed.success) this.opts.onMessage(parsed.data);
          return;
        }
        if (candidate.type === "turn" && this.opts.onTurn) {
          const parsedTurn = TurnRequestSchema.safeParse(candidate.turn);
          if (parsedTurn.success) this.opts.onTurn(parsedTurn.data);
          return;
        }
      } catch {
        // ignore unparseable frames
      }
    };

    ws.on("message", (data: Buffer) => {
      if (buffering) buffer.push(data);
      else handleData(data);
    });

    ws.on("open", () => {
      if (!this.opts.onOpen) return;
      void Promise.resolve()
        .then(() => this.opts.onOpen!())
        .catch((err: unknown) => {
          console.error("onOpen failed:", err instanceof Error ? err.message : err);
        })
        .finally(() => {
          buffering = false;
          for (const data of buffer.splice(0)) handleData(data);
        });
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
