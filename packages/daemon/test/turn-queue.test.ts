import { describe, expect, it } from "vitest";
import { TurnQueue } from "../src/turn-queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TurnQueue", () => {
  it("serializes same-agent turns, keeps agents independent", async () => {
    const queue = new TurnQueue();
    const order: string[] = [];
    const a1 = queue.run("a", async () => {
      await sleep(80);
      order.push("a-first");
    });
    const a2 = queue.run("a", async () => {
      order.push("a-second");
    });
    const b1 = queue.run("b", async () => {
      order.push("b-while-a-busy");
    });
    await Promise.all([a1, a2, b1]);
    expect(order.indexOf("b-while-a-busy")).toBeLessThan(order.indexOf("a-first"));
    expect(order.indexOf("a-first")).toBeLessThan(order.indexOf("a-second"));
  });

  it("continues after a rejected turn and propagates the rejection", async () => {
    const queue = new TurnQueue();
    const failing = queue.run("a", async () => {
      throw new Error("turn failed");
    });
    await expect(failing).rejects.toThrow("turn failed");
    const after = await queue.run("a", async () => "recovered");
    expect(after).toBe("recovered");
  });
});
