import { afterEach, describe, expect, it, vi } from "vitest";
import { hubClient } from "../hubClient.js";

describe("hubClient.fsWrite", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /api/fs/:machine/write with path, content, threadId", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await hubClient.fsWrite("m1", "/w/a.ts", "hello", "th-1");
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("/api/fs/m1/write");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ path: "/w/a.ts", content: "hello", threadId: "th-1" });
  });

  it("throws on a non-2xx so callers can surface the failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 422 })));
    await expect(hubClient.fsWrite("m1", "/w/a.ts", "x")).rejects.toThrow();
  });
});
