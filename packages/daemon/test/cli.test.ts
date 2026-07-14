import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function gf(): string {
  return join(mkdtempSync(join(tmpdir(), "cli-")), "grants.json");
}

describe("conclave-daemon CLI", () => {
  it("grants, dedupes, and revokes roots", () => {
    const file = gf();
    runCli(["grant", "/tmp/ws"], file);
    runCli(["grant", "/tmp/ws"], file); // dedupe
    expect(JSON.parse(readFileSync(file, "utf8")).files).toEqual([resolve("/tmp/ws")]);
    runCli(["revoke", "/tmp/ws"], file);
    expect(JSON.parse(readFileSync(file, "utf8")).files).toEqual([]);
  });
});
