import { describe, expect, it } from "vitest";
import { childEnv } from "../src/child-env.js";

describe("childEnv", () => {
  it("strips CONCLAVE_TOKEN from a copy", () => {
    const src = { CONCLAVE_TOKEN: "secret", PATH: "/usr/bin", HOME: "/home/x" };
    const out = childEnv(src);
    expect(out["CONCLAVE_TOKEN"]).toBeUndefined();
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["HOME"]).toBe("/home/x");
  });

  it("does not mutate the source env", () => {
    const src = { CONCLAVE_TOKEN: "secret", PATH: "/usr/bin" };
    childEnv(src);
    expect(src["CONCLAVE_TOKEN"]).toBe("secret");
  });

  it("defaults to process.env and preserves non-token vars", () => {
    process.env["CONCLAVE_TEST_MARKER"] = "keep-me";
    process.env["CONCLAVE_TOKEN"] = "secret";
    try {
      const out = childEnv();
      expect(out["CONCLAVE_TOKEN"]).toBeUndefined();
      expect(out["CONCLAVE_TEST_MARKER"]).toBe("keep-me");
    } finally {
      delete process.env["CONCLAVE_TEST_MARKER"];
      delete process.env["CONCLAVE_TOKEN"];
    }
  });
});
