import { describe, expect, it } from "vitest";
import { RegistrySchema, canCommunicate, type Registry } from "../src/index.js";

function reg(acl: [string, string][]): Registry {
  return RegistrySchema.parse({ agents: [], acl });
}

describe("registry acl schema", () => {
  it("defaults acl to []", () => {
    expect(RegistrySchema.parse({ agents: [] }).acl).toEqual([]);
  });

  it("parses pairs", () => {
    expect(reg([["dev", "deploy"]]).acl).toEqual([["dev", "deploy"]]);
  });

  it("rejects a non-pair", () => {
    expect(RegistrySchema.safeParse({ agents: [], acl: [["dev"]] }).success).toBe(false);
    expect(RegistrySchema.safeParse({ agents: [], acl: [["a", "b", "c"]] }).success).toBe(false);
  });
});

describe("canCommunicate", () => {
  const r = reg([["dev", "deploy"]]);

  it("allows the human either side, both directions", () => {
    expect(canCommunicate(r, "you", "dev")).toBe(true);
    expect(canCommunicate(r, "audit", "you")).toBe(true);
  });

  it("allows a present pair in both orders", () => {
    expect(canCommunicate(r, "dev", "deploy")).toBe(true);
    expect(canCommunicate(r, "deploy", "dev")).toBe(true);
  });

  it("denies by default when no pair exists", () => {
    expect(canCommunicate(r, "dev", "audit")).toBe(false);
    expect(canCommunicate(reg([]), "dev", "deploy")).toBe(false);
  });

  it("denies an agent talking to itself", () => {
    expect(canCommunicate(r, "dev", "dev")).toBe(false);
  });
});
