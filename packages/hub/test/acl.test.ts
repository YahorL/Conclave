import { describe, expect, it } from "vitest";
import { RegistrySchema, type Registry } from "@conclave/shared";
import { assertAclAllowed } from "../src/acl.js";

function reg(): Registry {
  return RegistrySchema.parse({
    agents: [
      { id: "dev", name: "dev", runtime: "codex", machine: "m", workspace: "/w" },
      { id: "deploy", name: "deploy", runtime: "codex", machine: "m", workspace: "/w" },
      { id: "audit", name: "audit", runtime: "codex", machine: "m", workspace: "/w" },
    ],
    acl: [["dev", "deploy"]],
  });
}

describe("assertAclAllowed", () => {
  const r = reg();

  it("returns null when from is not a registered agent (human or unknown)", () => {
    expect(assertAclAllowed(r, "you", ["dev", "deploy"])).toBeNull();
    expect(assertAclAllowed(r, "outsider", ["dev"])).toBeNull();
  });

  it("returns null for allowed recipients, self, human, and non-agents", () => {
    expect(assertAclAllowed(r, "dev", ["deploy"])).toBeNull();
    expect(assertAclAllowed(r, "dev", [])).toBeNull();
    expect(assertAclAllowed(r, "dev", ["you"])).toBeNull();
    expect(assertAclAllowed(r, "dev", ["dev"])).toBeNull();          // self not gated
    expect(assertAclAllowed(r, "dev", ["some-label"])).toBeNull();   // not a registered agent
  });

  it("returns the first disallowed agent recipient", () => {
    expect(assertAclAllowed(r, "dev", ["audit"])).toBe("audit");
    expect(assertAclAllowed(r, "dev", ["deploy", "audit"])).toBe("audit");
  });
});
