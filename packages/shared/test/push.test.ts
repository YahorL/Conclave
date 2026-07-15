import { describe, expect, it } from "vitest";
import { PushSubscriptionSchema } from "../src/index.js";

describe("PushSubscriptionSchema", () => {
  it("parses a browser subscription JSON", () => {
    const s = PushSubscriptionSchema.parse({
      endpoint: "https://push.example/ep1",
      keys: { p256dh: "pkey", auth: "akey" },
    });
    expect(s.endpoint).toBe("https://push.example/ep1");
    expect(s.keys.auth).toBe("akey");
  });

  it("rejects missing keys", () => {
    expect(PushSubscriptionSchema.safeParse({ endpoint: "https://x" }).success).toBe(false);
    expect(
      PushSubscriptionSchema.safeParse({ endpoint: "https://x", keys: { p256dh: "p" } }).success,
    ).toBe(false);
  });
});
