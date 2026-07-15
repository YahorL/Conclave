import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disablePush, enablePush, initPushNavigation, pushSupported, urlBase64ToUint8Array,
} from "../push.js";

interface MockEnv {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  listeners: Map<string, (ev: MessageEvent) => void>;
  fetchMock: ReturnType<typeof vi.fn>;
}

function mockEnv(opts: { permission?: NotificationPermission; hasSub?: boolean } = {}): MockEnv {
  const unsubscribe = vi.fn(async () => true);
  const subscription = {
    endpoint: "https://push.example/ep1",
    unsubscribe,
    toJSON: () => ({ endpoint: "https://push.example/ep1", keys: { p256dh: "p", auth: "a" } }),
  };
  const subscribe = vi.fn(async () => subscription);
  const registration = {
    pushManager: {
      subscribe,
      getSubscription: vi.fn(async () => (opts.hasSub ? subscription : null)),
    },
  };
  const register = vi.fn(async () => registration);
  const listeners = new Map<string, (ev: MessageEvent) => void>();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      getRegistration: vi.fn(async () => registration),
      addEventListener: (type: string, cb: (ev: MessageEvent) => void) => listeners.set(type, cb),
    },
  });
  vi.stubGlobal("PushManager", function PushManager() { /* presence check only */ });
  vi.stubGlobal("Notification", {
    permission: opts.permission ?? "default",
    requestPermission: vi.fn(async () => opts.permission ?? "granted"),
  });
  const fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).includes("vapid-public-key")) {
      return new Response(JSON.stringify({ key: "AQID" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { subscribe, unsubscribe, register, listeners, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error cleanup of the defineProperty stub
  delete navigator.serviceWorker;
});

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
  });
});

describe("pushSupported", () => {
  it("is false without serviceWorker, true with the full stack mocked", () => {
    expect(pushSupported()).toBe(false);
    mockEnv();
    expect(pushSupported()).toBe(true);
  });
});

describe("enablePush", () => {
  it("registers the SW, subscribes, and POSTs the subscription", async () => {
    const env = mockEnv();
    await enablePush();
    expect(env.register).toHaveBeenCalledWith("/sw.js");
    expect(env.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    const subscribeCall = env.fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/api/push/subscribe"),
    );
    expect(subscribeCall).toBeTruthy();
    expect(JSON.parse((subscribeCall![1] as RequestInit).body as string).endpoint).toBe(
      "https://push.example/ep1",
    );
  });

  it("throws and does not subscribe when permission is denied", async () => {
    const env = mockEnv({ permission: "denied" });
    await expect(enablePush()).rejects.toThrow(/denied/);
    expect(env.subscribe).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("unsubscribes and POSTs the endpoint", async () => {
    const env = mockEnv({ hasSub: true });
    await disablePush();
    expect(env.unsubscribe).toHaveBeenCalled();
    const call = env.fetchMock.mock.calls.find(([u]) => String(u).includes("/api/push/unsubscribe"));
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      endpoint: "https://push.example/ep1",
    });
  });

  it("is a no-op without a subscription", async () => {
    const env = mockEnv({ hasSub: false });
    await disablePush();
    expect(env.fetchMock).not.toHaveBeenCalled();
  });
});

describe("initPushNavigation", () => {
  it("routes SW navigate messages to the callback with the thread id", () => {
    const env = mockEnv();
    const seen: string[] = [];
    initPushNavigation((id) => seen.push(id));
    env.listeners.get("message")!({ data: { type: "navigate", url: "/?thread=th9" } } as MessageEvent);
    env.listeners.get("message")!({ data: { type: "other" } } as MessageEvent);
    expect(seen).toEqual(["th9"]);
  });
});
