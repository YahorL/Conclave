import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";

describe("RingBuffer", () => {
  it("returns everything under the cap, in order", () => {
    const rb = new RingBuffer(1024);
    rb.push(Buffer.from("hello "));
    rb.push(Buffer.from("world"));
    expect(rb.snapshot().toString()).toBe("hello world");
  });

  it("evicts oldest chunks beyond the byte cap", () => {
    const rb = new RingBuffer(10);
    rb.push(Buffer.from("aaaaa"));
    rb.push(Buffer.from("bbbbb"));
    rb.push(Buffer.from("cc"));
    const out = rb.snapshot().toString();
    expect(out.endsWith("bbbbbcc")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.includes("a")).toBe(false); // the whole oldest chunk was dropped
  });
});
