import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { PushSubscriptionInfo } from "@conclave/shared";
import { openDb } from "../src/db.js";
import { PushStore } from "../src/push-store.js";

function sub(endpoint: string): PushSubscriptionInfo {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}

describe("PushStore", () => {
  let store: PushStore;
  beforeEach(() => {
    store = new PushStore(openDb(join(mkdtempSync(join(tmpdir(), "conclave-push-")), "t.db")));
  });

  it("stores and lists subscriptions", () => {
    store.upsert(sub("https://push.example/1"));
    store.upsert(sub("https://push.example/2"));
    expect(store.list().map((s) => s.endpoint).sort()).toEqual([
      "https://push.example/1",
      "https://push.example/2",
    ]);
  });

  it("upsert dedups by endpoint and updates keys", () => {
    store.upsert(sub("https://push.example/1"));
    store.upsert({ endpoint: "https://push.example/1", keys: { p256dh: "p2", auth: "a2" } });
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.keys.p256dh).toBe("p2");
  });

  it("removes by endpoint", () => {
    store.upsert(sub("https://push.example/1"));
    store.remove("https://push.example/1");
    expect(store.list()).toEqual([]);
  });
});
