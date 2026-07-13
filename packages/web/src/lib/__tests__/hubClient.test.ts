import { afterEach, describe, expect, it, vi } from "vitest";
import { hubClient } from "../hubClient.js";

afterEach(() => vi.restoreAllMocks());

describe("hubClient", () => {
  it("GET /api/threads returns parsed json with auth header", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "t1" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const threads = await hubClient.listThreads();
    expect(threads).toEqual([{ id: "t1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/threads", expect.objectContaining({ method: "GET" }));
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(hubClient.listThreads()).rejects.toThrow();
  });
});
