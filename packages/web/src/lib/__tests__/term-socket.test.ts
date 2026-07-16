import { afterEach, describe, expect, it, vi } from "vitest";
import { connectSocket, onTermFrame, sendFrame, type WsFrame } from "../socket.js";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.onclose?.();
  }
}

describe("socket term plumbing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWS.instances = [];
  });

  it("dispatches term stream frames to onTermFrame subscribers, not applyFrame; terminal-list goes to applyFrame", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const frames: WsFrame[] = [];
    const close = connectSocket((f) => frames.push(f));
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();

    const termSeen: unknown[] = [];
    const off = onTermFrame((f) => termSeen.push(f));

    ws.onmessage?.({ data: JSON.stringify({ type: "term-data", terminalId: "t1", data: "aGk=" }) });
    ws.onmessage?.({ data: JSON.stringify({ type: "terminal-list", terminals: [] }) });

    expect(termSeen).toHaveLength(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("terminal-list");

    off();
    ws.onmessage?.({ data: JSON.stringify({ type: "term-exit", terminalId: "t1", exitCode: 0 }) });
    expect(termSeen).toHaveLength(1);
    close();
  });

  it("sendFrame serializes to the open socket and reports false when closed", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const close = connectSocket(() => {});
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();
    expect(sendFrame({ type: "term-detach", terminalId: "t1" })).toBe(true);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "term-detach", terminalId: "t1" });
    close();
    expect(sendFrame({ type: "term-detach", terminalId: "t1" })).toBe(false);
  });
});
