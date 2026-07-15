import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Registry } from "@conclave/shared";
import { loadRegistry } from "../src/registry.js";
import { openDb } from "../src/db.js";
import { Mailbox } from "../src/mailbox.js";
import { buildServer } from "../src/server.js";

const TOKEN = "reg-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const YAML = `
agents:
  - id: claude-code
    name: Claude Code
    runtime: claude-code
    machine: dev-box
    workspace: /home/me/proj
    role: "Primary dev agent."
    allowedTools: [Read, Grep]
  - id: deployer
    name: Deployer
    runtime: codex
    machine: server-1
    workspace: /srv/app
`;

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "conclave-reg-"));
  const p = join(dir, "registry.yaml");
  writeFileSync(p, content);
  return p;
}

describe("loadRegistry", () => {
  it("parses yaml with defaults", () => {
    const reg = loadRegistry(tmpFile(YAML));
    expect(reg.agents).toHaveLength(2);
    expect(reg.agents[0]!.allowedTools).toEqual(["Read", "Grep"]);
    expect(reg.agents[1]!.role).toBe("");
  });

  it("returns empty registry for a missing file", () => {
    expect(loadRegistry("/nonexistent/registry.yaml")).toEqual({ agents: [], acl: [] });
  });

  it("throws on schema-invalid yaml", () => {
    expect(() => loadRegistry(tmpFile("agents:\n  - id: x\n"))).toThrow();
  });
});

describe("GET /api/registry", () => {
  async function serverWith(registry: Registry) {
    const dir = mkdtempSync(join(tmpdir(), "conclave-reg-db-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    return buildServer({ mailbox, token: TOKEN, registry });
  }

  it("serves the registry, filtered by machine", async () => {
    const app = await serverWith(loadRegistry(tmpFile(YAML)));
    const all = await app.inject({ method: "GET", url: "/api/registry", headers: AUTH });
    expect(all.json<Registry>().agents).toHaveLength(2);
    const one = await app.inject({
      method: "GET", url: "/api/registry?machine=server-1", headers: AUTH,
    });
    const agents = one.json<Registry>().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).toBe("deployer");
    expect((await app.inject({ method: "GET", url: "/api/registry" })).statusCode).toBe(401);
  });

  it("defaults to an empty registry when not provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-reg-db-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    const app = await buildServer({ mailbox, token: TOKEN });
    const res = await app.inject({ method: "GET", url: "/api/registry", headers: AUTH });
    expect(res.json<Registry>()).toEqual({ agents: [], acl: [] });
  });
});
