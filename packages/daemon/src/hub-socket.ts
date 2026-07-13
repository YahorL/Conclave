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

  constructor(private readonly opts: HubSocketOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const wsUrl = `${this.opts.hubUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(this.opts.token)}`;
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
