import { describe, expect, it } from "vitest";
import { FsRequestSchema, FsResponseSchema, HelloSchema } from "../src/fs.js";

describe("fs schemas", () => {
  it("parses a request and rejects a bad op", () => {
    expect(FsRequestSchema.parse({ id: "1", op: "list", path: "/x" }).op).toBe("list");
    expect(() => FsRequestSchema.parse({ id: "1", op: "delete", path: "/x" })).toThrow();
  });
  it("parses response and hello", () => {
    expect(FsResponseSchema.parse({ id: "1", ok: true, result: [] }).ok).toBe(true);
    expect(HelloSchema.parse({ machine: "m1", files: ["/w"] }).files).toEqual(["/w"]);
  });
});
