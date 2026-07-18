// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentsDir = fileURLToPath(new URL("../../components", import.meta.url));

describe("component CSS uses tokens, not hex literals", () => {
  it("no hex colors in any *.module.css", () => {
    const offenders: string[] = [];
    // recursive: true — subdirectories (e.g. components/mobile/) must be covered too.
    const entries = readdirSync(componentsDir, { recursive: true }).map(String);
    for (const f of entries.filter((f) => f.endsWith(".module.css"))) {
      const css = readFileSync(join(componentsDir, f), "utf8");
      for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
