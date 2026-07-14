import { describe, expect, it, vi } from "vitest";
import { MachineRegistry, PendingRequests } from "../src/fs-tunnel.js";

describe("PendingRequests", () => {
  it("resolves on settle and rejects on timeout", async () => {
    const p = new PendingRequests();
    const pr = p.create("1", 1000);
    p.settle("1", { id: "1", ok: true, result: 42 });
    expect((await pr).result).toBe(42);
    await expect(p.create("2", 5)).rejects.toThrow();
  });
});

describe("MachineRegistry", () => {
  it("registers by machine and unregisters by socket", () => {
    const reg = new MachineRegistry();
    const socket = { send: vi.fn() };
    reg.register("m1", socket, ["/w"]);
    expect(reg.get("m1")?.roots).toEqual(["/w"]);
    expect(reg.list()[0]).toMatchObject({ machine: "m1", files: ["/w"] });
    reg.unregisterSocket(socket);
    expect(reg.get("m1")).toBeUndefined();
  });
});
