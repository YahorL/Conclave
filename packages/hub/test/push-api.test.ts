import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { PushStore } from "../src/push-store.js";
import { buildServer } from "../src/server.js";

const TOKEN = "push-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SUB = { endpoint: "https://push.example/ep1", keys: { p256dh: "p", auth: "a" } };

describe("push API", () => {
  let app: FastifyInstance;
  let store: PushStore;

  beforeEach(async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-pushapi-")), "t.db"));
    store = new PushStore(db);
    app = await buildServer({
      mailbox: new Mailbox(db), token: TOKEN, push: store, vapidPublicKey: "PUBKEY",
    });
  });

  it("requires auth", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/push/vapid-public-key" })).statusCode,
    ).toBe(401);
  });

  it("serves the vapid public key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/push/vapid-public-key", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key: "PUBKEY" });
  });

  it("subscribe stores the subscription (201); bad body 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/push/subscribe", headers: AUTH, payload: SUB,
    });
    expect(res.statusCode).toBe(201);
    expect(store.list().map((s) => s.endpoint)).toEqual([SUB.endpoint]);
    expect(
      (
        await app.inject({
          method: "POST", url: "/api/push/subscribe", headers: AUTH,
          payload: { endpoint: "https://x" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("unsubscribe removes by endpoint", async () => {
    store.upsert(SUB);
    const res = await app.inject({
      method: "POST", url: "/api/push/unsubscribe", headers: AUTH,
      payload: { endpoint: SUB.endpoint },
    });
    expect(res.statusCode).toBe(200);
    expect(store.list()).toEqual([]);
  });

  it("503s when push is not configured", async () => {
    const db2 = openDb(join(mkdtempSync(join(tmpdir(), "conclave-pushapi2-")), "t.db"));
    const bare = await buildServer({ mailbox: new Mailbox(db2), token: TOKEN });
    expect(
      (await bare.inject({ method: "GET", url: "/api/push/vapid-public-key", headers: AUTH }))
        .statusCode,
    ).toBe(503);
    expect(
      (await bare.inject({ method: "POST", url: "/api/push/subscribe", headers: AUTH, payload: SUB }))
        .statusCode,
    ).toBe(503);
    await bare.close();
  });
});
