import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../src/grants.js";
import { runCli } from "../src/cli.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-tgrant-")), "grants.json");
}

describe("terminals grant", () => {
  it("is false when the file is absent or lacks the key", () => {
    const f = tmpFile();
    expect(new GrantStore(f).terminalsGranted()).toBe(false);
    writeFileSync(f, JSON.stringify({ files: ["/w"] }));
    expect(new GrantStore(f).terminalsGranted()).toBe(false);
  });

  it("grant-terminals turns it on and preserves file roots; revoke turns it off", () => {
    const f = tmpFile();
    runCli(["grant", "/w"], f);
    runCli(["grant-terminals"], f);
    expect(new GrantStore(f).terminalsGranted()).toBe(true);
    expect(new GrantStore(f).roots()).toEqual(["/w"]);
    // a later files grant must not wipe the terminals flag
    runCli(["grant", "/w2"], f);
    expect(new GrantStore(f).terminalsGranted()).toBe(true);
    runCli(["revoke-terminals"], f);
    expect(new GrantStore(f).terminalsGranted()).toBe(false);
    const raw = JSON.parse(readFileSync(f, "utf8")) as { files: string[]; terminals: boolean };
    expect(raw.files).toEqual(["/w", "/w2"]);
  });
});
