import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { Task } from "@conclave/shared";
import { HubSocket } from "../src/hub-socket.js";

const TASK: Task = {
  id: "t1", threadId: "th1", assignee: "codex", spec: "x", state: "queued",
  artifacts: [], createdAt: "2026-07-13T10:00:00Z", updatedAt: "2026-07-13T10:00:00Z",
};

describe("HubSocket task frames", () => {
  it("dispatches {type:task} frames to onTask", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "task", task: TASK })));

    const onTask = vi.fn();
    const socket = new HubSocket({
      hubUrl: `http://127.0.0.1:${port}`, token: "t",
      onMessage: () => undefined, onTask,
    });
    socket.start();
    await vi.waitFor(() => expect(onTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" })));
    socket.stop();
    wss.close();
  });
});
