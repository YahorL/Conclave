import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe("daemon entrypoint", () => {
  it("fails fast with a clean message when env is missing", () => {
    const res = spawnSync("npx", ["tsx", MAIN], {
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("CONCLAVE_HUB_URL is required");
    expect(res.stderr).not.toContain("at ");  // no stack trace frames
  });
});
