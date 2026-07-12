import { describe, expect, it } from "vitest";
import { AgentConfigSchema, RegistrySchema } from "../src/index.js";

describe("RegistrySchema", () => {
  it("parses a full agent and applies defaults", () => {
    const agent = AgentConfigSchema.parse({
      id: "claude-code",
      name: "Claude Code",
      runtime: "claude-code",
      machine: "dev-box",
      workspace: "/home/me/proj",
    });
    expect(agent.role).toBe("");
    expect(agent.allowedTools).toEqual([]);
  });

  it("rejects unknown runtimes and missing workspace", () => {
    expect(
      AgentConfigSchema.safeParse({
        id: "g", name: "G", runtime: "gemini", machine: "m", workspace: "/x",
      }).success,
    ).toBe(false);
    expect(
      AgentConfigSchema.safeParse({
        id: "c", name: "C", runtime: "codex", machine: "m",
      }).success,
    ).toBe(false);
  });

  it("defaults agents to empty", () => {
    expect(RegistrySchema.parse({})).toEqual({ agents: [] });
  });
});
