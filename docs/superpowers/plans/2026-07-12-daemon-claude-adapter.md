# Conclave Step 2: Daemon + Claude Code Adapter + MCP Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daemon that watches the hub, spawns headless Claude Code sessions in an agent's workspace when messages address that agent, posts replies back into the thread, and gives each session an MCP bridge (send_message / check_inbox / wait_for_reply / end_thread) — so you can talk to a real agent via curl.

**Architecture:** New workspace package `@conclave/daemon`. It connects outbound to the hub (WebSocket for triggers, HTTP for everything else), runs one `RuntimeAdapter` per runtime (only `ClaudeCodeAdapter` in this step), serializes turns per agent, and persists thread→session ids so `--resume` keeps conversation context across turns and daemon restarts. The MCP bridge is a tiny stdio server the CLI spawns per session; it proxies four tools to the hub HTTP API. The hub gains one read-only endpoint: `GET /api/registry` serving a `registry.yaml`.

**Tech Stack:** Node ≥ 22 (global fetch), TypeScript strict ESM, `ws` (client), `yaml`, `@modelcontextprotocol/sdk` (stdio server), Vitest. No build pipeline yet — everything runs via tsx, same as step 1.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-conclave-architecture-design.md` (§3, §4, §7). This plan implements build-order step 2 only — single machine, no debates (step 3), no artifacts/tasks (step 5), no ACL matrix/approvals (step 6). Do not stub them.
- **Claude CLI contract (verified against v2.1.207):** headless turn = `claude -p --output-format stream-json --verbose --permission-mode dontAsk --allowedTools <csv> --mcp-config <inline-json> --strict-mcp-config [--resume <session-id>]`, prompt piped via **stdin**. Events are NDJSON; `session_id` appears on `system/init` and `result` events; `result` carries `result` (text), `is_error`, `total_cost_usd`, `usage`. Session id is stable across `--resume` turns. Do NOT use `--bare` (it would skip AGENTS.md/CLAUDE.md, which the spec makes canonical). Do NOT use `--dangerously-skip-permissions`.
- **Adapter deviation from spec §4 (approved):** the spec sketches `start/resume/events/stop`; headless `-p` processes are turn-scoped, so the real interface is `RuntimeAdapter.runTurn(opts): Promise<TurnResult>` with an `onEvent` callback and optional `sessionId` for resume. Record this as the contract going forward.
- **Trigger rule (loop safety):** an agent turn fires only when a message's `to` includes the agent id, `from !== agent.id`, `type` is `text` or `proposal`, and `from === "you"` unless `CONCLAVE_ALLOW_AGENT_TRIGGERS=1`. Agents never trigger themselves; agent→agent triggers stay off by default (ACLs are step 6).
- **MCP zod split:** `@modelcontextprotocol/sdk@^1.12` peers zod v3. Daemon depends on `zod@^3.25` (bridge tool shapes only). `@conclave/shared` stays on zod v4 — never mix instances inside one schema tree.
- Env contracts: hub adds optional `registry.yaml` in `CONCLAVE_DATA_DIR`; daemon uses `CONCLAVE_HUB_URL`, `CONCLAVE_TOKEN`, `CONCLAVE_MACHINE` (all required), `CONCLAVE_CLAUDE_BIN` (default `claude`), `CONCLAVE_STATE_FILE` (default `./daemon-state.json`), `CONCLAVE_ALLOW_AGENT_TRIGGERS` (default `0`).
- Tests never invoke the real `claude` binary (subscription quota): adapter tests use the fake-claude fixture; a real smoke run is manual (Task 9). Integration tests run against a real in-process hub (`buildServer` + `listen({port: 0})`).
- TypeScript strict, no `any`. Conventional commits, no attribution trailers. TDD per task. `npx pnpm ...` (pnpm is not on PATH).
- Baseline before Task 1: 32 tests passing (26 hub + 6 shared), typecheck clean.

---

### Task 1: Registry — shared schema, hub loader, GET /api/registry

**Files:**
- Create: `packages/shared/src/registry.ts`, `packages/hub/src/registry.ts`
- Modify: `packages/shared/src/index.ts`, `packages/hub/src/server.ts` (opts + one route), `packages/hub/src/main.ts` (load registry.yaml)
- Test: `packages/shared/test/registry.test.ts`, `packages/hub/test/registry.test.ts`

**Interfaces:**
- Consumes: `buildServer({ mailbox, token })` from step 1.
- Produces:
  - shared: `AgentConfigSchema`, `RegistrySchema`, types `AgentConfig`, `Registry`. Fields: `AgentConfig { id, name, runtime: "claude-code"|"codex", machine, workspace, role (default ""), allowedTools (default []) }`, `Registry { agents: AgentConfig[] }`.
  - hub: `loadRegistry(path: string): Registry` (missing file → `{ agents: [] }`; invalid YAML/schema → throws).
  - `buildServer` opts become `{ mailbox, token, registry?: Registry }` (default `{ agents: [] }`); new route `GET /api/registry?machine=<name>` → `Registry` (agents filtered by machine when the param is present). Authed like every other route.

- [ ] **Step 1: Write the failing shared test**

`packages/shared/test/registry.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify RED**

Run: `npx pnpm vitest run packages/shared`
Expected: FAIL — registry exports missing.

- [ ] **Step 3: Implement shared schema**

`packages/shared/src/registry.ts`:
```ts
import { z } from "zod";

export const AgentRuntimeSchema = z.enum(["claude-code", "codex"]);

export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtime: AgentRuntimeSchema,
  machine: z.string().min(1),
  workspace: z.string().min(1),
  role: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
});

export const RegistrySchema = z.object({
  agents: z.array(AgentConfigSchema).default([]),
});

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type Registry = z.infer<typeof RegistrySchema>;
```

`packages/shared/src/index.ts` (append line):
```ts
export * from "./registry.js";
```

- [ ] **Step 4: GREEN for shared**

Run: `npx pnpm vitest run packages/shared` — Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing hub test**

`packages/hub/test/registry.test.ts`:
```ts
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
    expect(loadRegistry("/nonexistent/registry.yaml")).toEqual({ agents: [] });
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
    expect(res.json<Registry>()).toEqual({ agents: [] });
  });
});
```

- [ ] **Step 6: RED**

Run: `npx pnpm vitest run packages/hub/test/registry.test.ts`
Expected: FAIL — `registry.ts` missing, buildServer rejects `registry` opt.

- [ ] **Step 7: Implement hub side**

Run: `npx pnpm --filter @conclave/hub add yaml`

`packages/hub/src/registry.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { RegistrySchema, type Registry } from "@conclave/shared";

export function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return { agents: [] };
  return RegistrySchema.parse(parse(readFileSync(path, "utf8")));
}
```

`packages/hub/src/server.ts` — extend the options interface and add the route after the existing `/api/threads` routes:
```ts
export interface ServerOptions {
  mailbox: Mailbox;
  token: string;
  registry?: Registry;
}
```
(add `import type { Registry } from "@conclave/shared";` to the existing type import), and inside `buildServer`:
```ts
  const registry: Registry = opts.registry ?? { agents: [] };

  app.get("/api/registry", async (req) => {
    const query = req.query as { machine?: string };
    if (!query.machine) return registry;
    return { agents: registry.agents.filter((a) => a.machine === query.machine) };
  });
```

`packages/hub/src/main.ts` — load the registry next to the db and pass it in:
```ts
import { loadRegistry } from "./registry.js";
// after mkdirSync(...):
const registry = loadRegistry(join(dataDir, "registry.yaml"));
const app = await buildServer({ mailbox, token, registry });
console.log(`conclave hub: ${registry.agents.length} agent(s) registered`);
```
(keep the existing listen/log lines).

- [ ] **Step 8: GREEN + full suite**

Run: `npx pnpm vitest run packages/hub` — Expected: PASS (31 hub tests: 26 + 5 new).
Run: `npx pnpm typecheck` — Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/shared packages/hub pnpm-lock.yaml
git commit -m "feat: agent registry schema, yaml loader, /api/registry endpoint"
```

---

### Task 2: Daemon package scaffold + HubClient

**Files:**
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/src/config.ts`, `packages/daemon/src/hub-client.ts`
- Test: `packages/daemon/test/hub-client.test.ts`

**Interfaces:**
- Consumes: hub `buildServer` (test-side), shared types.
- Produces:
  - `loadDaemonConfig(env: NodeJS.ProcessEnv): DaemonConfig` — `DaemonConfig { hubUrl, token, machine, claudeBin, stateFile, allowAgentTriggers: boolean }`; throws with a clear message when a required var is missing; strips a trailing `/` from `hubUrl`.
  - `class HubClient { constructor(hubUrl: string, token: string) }` with: `getRegistry(machine: string): Promise<AgentConfig[]>`, `getThread(id: string): Promise<Thread>`, `postMessage(threadId: string, msg: NewMessage): Promise<Message>`, `listMessages(threadId: string, after?: number, waitSec?: number): Promise<Message[]>`, `setVerdict(threadId: string, agent: string, verdict: string): Promise<Thread>`. Non-2xx → throws `HubApiError` (has `status: number`).

- [ ] **Step 1: Scaffold package**

`packages/daemon/package.json`:
```json
{
  "name": "@conclave/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "dev": "tsx src/main.ts"
  }
}
```

`packages/daemon/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run:
```bash
npx pnpm --filter @conclave/daemon add "@conclave/shared@workspace:*" ws tsx zod@^3.25 @modelcontextprotocol/sdk yaml
npx pnpm --filter @conclave/daemon add -D @types/ws "@conclave/hub@workspace:*"
```
(`@conclave/hub` is a DEV dependency only — integration tests spin up an in-process hub; the daemon runtime never imports it. zod v3 here is exclusively for the MCP bridge in Task 6.)

- [ ] **Step 2: Write the failing tests**

`packages/daemon/test/hub-client.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { loadDaemonConfig } from "../src/config.js";
import { HubClient, HubApiError } from "../src/hub-client.js";

const TOKEN = "dc-token";

describe("loadDaemonConfig", () => {
  const base = {
    CONCLAVE_HUB_URL: "http://hub:7777/",
    CONCLAVE_TOKEN: "t",
    CONCLAVE_MACHINE: "dev-box",
  };

  it("loads with defaults and strips trailing slash", () => {
    const cfg = loadDaemonConfig(base);
    expect(cfg.hubUrl).toBe("http://hub:7777");
    expect(cfg.claudeBin).toBe("claude");
    expect(cfg.stateFile).toBe("./daemon-state.json");
    expect(cfg.allowAgentTriggers).toBe(false);
  });

  it("throws naming the missing variable", () => {
    expect(() => loadDaemonConfig({ ...base, CONCLAVE_TOKEN: undefined })).toThrow(
      /CONCLAVE_TOKEN/,
    );
  });

  it("parses CONCLAVE_ALLOW_AGENT_TRIGGERS=1", () => {
    expect(
      loadDaemonConfig({ ...base, CONCLAVE_ALLOW_AGENT_TRIGGERS: "1" }).allowAgentTriggers,
    ).toBe(true);
  });
});

describe("HubClient against a live hub", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function liveHub(): Promise<{ client: HubClient; mailbox: Mailbox }> {
    const dir = mkdtempSync(join(tmpdir(), "conclave-hc-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({
      mailbox,
      token: TOKEN,
      registry: {
        agents: [{
          id: "claude-code", name: "CC", runtime: "claude-code",
          machine: "dev-box", workspace: "/tmp/x", role: "", allowedTools: [],
        }],
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return { client: new HubClient(`http://127.0.0.1:${port}`, TOKEN), mailbox };
  }

  it("round-trips registry, messages, and verdicts", async () => {
    const { client, mailbox } = await liveHub();
    const agents = await client.getRegistry("dev-box");
    expect(agents.map((a) => a.id)).toEqual(["claude-code"]);

    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const posted = await client.postMessage(t.id, {
      from: "claude-code", to: ["you"], type: "text", body: "hello", artifacts: [],
    });
    expect(posted.id).toBeGreaterThan(0);
    expect((await client.listMessages(t.id)).map((m) => m.body)).toEqual(["hello"]);
    expect((await client.listMessages(t.id, posted.id))).toEqual([]);

    const settled = await client.setVerdict(t.id, "claude-code", "approve");
    expect(settled.verdicts["claude-code"]).toBe("approve");
    expect((await client.getThread(t.id)).id).toBe(t.id);
  });

  it("throws HubApiError with status on failures", async () => {
    const { client } = await liveHub();
    await expect(client.getThread("nope")).rejects.toThrowError(HubApiError);
    await expect(client.getThread("nope")).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 3: RED**

Run: `npx pnpm vitest run packages/daemon`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

`packages/daemon/src/config.ts`:
```ts
export interface DaemonConfig {
  hubUrl: string;
  token: string;
  machine: string;
  claudeBin: string;
  stateFile: string;
  allowAgentTriggers: boolean;
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv): DaemonConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    hubUrl: required("CONCLAVE_HUB_URL").replace(/\/$/, ""),
    token: required("CONCLAVE_TOKEN"),
    machine: required("CONCLAVE_MACHINE"),
    claudeBin: env["CONCLAVE_CLAUDE_BIN"] ?? "claude",
    stateFile: env["CONCLAVE_STATE_FILE"] ?? "./daemon-state.json",
    allowAgentTriggers: env["CONCLAVE_ALLOW_AGENT_TRIGGERS"] === "1",
  };
}
```

`packages/daemon/src/hub-client.ts`:
```ts
import type { AgentConfig, Message, NewMessage, Registry, Thread } from "@conclave/shared";

export class HubApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`hub api error ${status}: ${body}`);
  }
}

export class HubClient {
  constructor(
    private readonly hubUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.hubUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HubApiError(res.status, text);
    return JSON.parse(text) as T;
  }

  async getRegistry(machine: string): Promise<AgentConfig[]> {
    const reg = await this.request<Registry>(
      "GET",
      `/api/registry?machine=${encodeURIComponent(machine)}`,
    );
    return reg.agents;
  }

  getThread(id: string): Promise<Thread> {
    return this.request("GET", `/api/threads/${id}`);
  }

  postMessage(threadId: string, msg: NewMessage): Promise<Message> {
    return this.request("POST", `/api/threads/${threadId}/messages`, msg);
  }

  listMessages(threadId: string, after = 0, waitSec = 0): Promise<Message[]> {
    return this.request(
      "GET",
      `/api/threads/${threadId}/messages?after=${after}&wait=${waitSec}`,
    );
  }

  setVerdict(threadId: string, agent: string, verdict: string): Promise<Thread> {
    return this.request("POST", `/api/threads/${threadId}/verdict`, { agent, verdict });
  }
}
```

Note: the test imports hub internals via `@conclave/hub/src/...` paths. Add an exports map entry to `packages/hub/package.json` so this resolves:
```json
  "exports": {
    ".": "./src/index.ts",
    "./src/*": "./src/*"
  }
```
(if the hub package.json has no `exports` field yet, add it exactly as above; keep `main` if present).

- [ ] **Step 5: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (5 tests).
Run: `npx pnpm typecheck` — Expected: clean (three packages now).

- [ ] **Step 6: Commit**

```bash
git add packages/daemon packages/hub/package.json pnpm-lock.yaml
git commit -m "feat(daemon): package scaffold, env config, typed hub client"
```

---

### Task 3: stream-json parser

**Files:**
- Create: `packages/daemon/src/stream-json.ts`
- Test: `packages/daemon/test/stream-json.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 4 depends on these exact names):
  - `interface CliEvent { type: string; subtype?: string; session_id?: string; result?: string; is_error?: boolean; total_cost_usd?: number }` (extra fields preserved via index signature `[key: string]: unknown`).
  - `parseStreamLine(line: string): CliEvent | null` — returns null for blank/non-JSON lines (never throws).
  - `interface ParsedTurn { sessionId: string; text: string; isError: boolean; costUsd: number }`
  - `summarizeTurn(events: CliEvent[]): ParsedTurn` — throws `new Error("no result event in CLI output")` when no `type === "result"` event exists; `sessionId` comes from the result event (fallback: any event with `session_id`); `text` = result event's `result` field (default `""`); `costUsd` = `total_cost_usd` (default 0).

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/stream-json.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseStreamLine, summarizeTurn, type CliEvent } from "../src/stream-json.js";

const INIT = `{"type":"system","subtype":"init","session_id":"sess-1"}`;
const RESULT = `{"type":"result","subtype":"success","session_id":"sess-1","result":"Hello from Claude","is_error":false,"total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5}}`;

describe("parseStreamLine", () => {
  it("parses NDJSON events", () => {
    expect(parseStreamLine(INIT)).toMatchObject({ type: "system", session_id: "sess-1" });
  });

  it("returns null for blank and garbage lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
    expect(parseStreamLine("not json {")).toBeNull();
    expect(parseStreamLine(`"just a string"`)).toBeNull();
  });
});

describe("summarizeTurn", () => {
  it("extracts session, text, cost from a result event", () => {
    const events = [parseStreamLine(INIT)!, parseStreamLine(RESULT)!];
    expect(summarizeTurn(events)).toEqual({
      sessionId: "sess-1",
      text: "Hello from Claude",
      isError: false,
      costUsd: 0.0123,
    });
  });

  it("flags error results", () => {
    const events: CliEvent[] = [
      { type: "result", session_id: "s", result: "boom", is_error: true },
    ];
    const turn = summarizeTurn(events);
    expect(turn.isError).toBe(true);
    expect(turn.costUsd).toBe(0);
  });

  it("throws when there is no result event", () => {
    const events = [parseStreamLine(INIT)!];
    expect(() => summarizeTurn(events)).toThrow(/no result event/);
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/stream-json.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/daemon/src/stream-json.ts`:
```ts
export interface CliEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  [key: string]: unknown;
}

export interface ParsedTurn {
  sessionId: string;
  text: string;
  isError: boolean;
  costUsd: number;
}

export function parseStreamLine(line: string): CliEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    if (typeof (parsed as { type?: unknown }).type !== "string") return null;
    return parsed as CliEvent;
  } catch {
    return null;
  }
}

export function summarizeTurn(events: CliEvent[]): ParsedTurn {
  const result = events.find((e) => e.type === "result");
  if (!result) throw new Error("no result event in CLI output");
  const sessionId =
    result.session_id ?? events.find((e) => typeof e.session_id === "string")?.session_id;
  return {
    sessionId: sessionId ?? "",
    text: result.result ?? "",
    isError: result.is_error === true,
    costUsd: result.total_cost_usd ?? 0,
  };
}
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (10 daemon tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): stream-json event parser and turn summarizer"
```

---

### Task 4: ClaudeCodeAdapter (spawn, resume, fake-claude tests)

**Files:**
- Create: `packages/daemon/src/adapter.ts`, `packages/daemon/src/claude-adapter.ts`, `packages/daemon/test/fixtures/fake-claude.mjs`
- Test: `packages/daemon/test/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `parseStreamLine`, `summarizeTurn`, `CliEvent`, `ParsedTurn` (Task 3).
- Produces (Tasks 7–8 depend on these exact names):
  - `interface TurnOptions { cwd: string; prompt: string; sessionId?: string; allowedTools: string[]; mcpServers?: Record<string, unknown>; timeoutMs?: number; onEvent?: (e: CliEvent) => void }`
  - `type TurnResult = ParsedTurn`
  - `interface RuntimeAdapter { runTurn(opts: TurnOptions): Promise<TurnResult> }`
  - `class ClaudeCodeAdapter implements RuntimeAdapter { constructor(bin?: string) }` — spawns `<bin>` with args `["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--allowedTools", allowedTools.join(","), ...(mcpServers ? ["--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config"] : []), ...(sessionId ? ["--resume", sessionId] : [])]`, cwd = `opts.cwd`, prompt written to stdin then stdin closed. Rejects on: non-zero exit with no result event, spawn error, or timeout (default 600 000 ms; kill with SIGKILL). Non-zero exit WITH a result event resolves normally (the result event carries `is_error`).

- [ ] **Step 1: Create the fake claude fixture**

`packages/daemon/test/fixtures/fake-claude.mjs`:
```js
#!/usr/bin/env node
// Emits Claude-CLI-shaped stream-json. Captures its invocation for assertions.
import { appendFileSync, readFileSync } from "node:fs";

const capture = process.env.FAKE_CLAUDE_CAPTURE;
const stdin = readFileSync(0, "utf8");
const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx === -1 ? "fake-sess-new" : args[resumeIdx + 1];

if (capture) {
  appendFileSync(
    capture,
    JSON.stringify({ args, stdin, cwd: process.cwd() }) + "\n",
  );
}

if (process.env.FAKE_CLAUDE_MODE === "no-result") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_MODE === "hang") {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: `echo: ${stdin.trim()}`,
      is_error: false,
      total_cost_usd: 0.01,
    }),
  );
}
```

- [ ] **Step 2: Write the failing tests**

`packages/daemon/test/claude-adapter.test.ts`:
```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/claude-adapter.js";
import type { CliEvent } from "../src/stream-json.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

interface Capture {
  args: string[];
  stdin: string;
  cwd: string;
}

function captureFile(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-cap-")), "cap.ndjson");
}

function readCaptures(path: string): Capture[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Capture);
}

describe("ClaudeCodeAdapter", () => {
  it("spawns with the contract flags, pipes prompt via stdin, runs in cwd", async () => {
    const cap = captureFile();
    process.env["FAKE_CLAUDE_CAPTURE"] = cap;
    const cwd = mkdtempSync(join(tmpdir(), "conclave-ws-"));
    const adapter = new ClaudeCodeAdapter(FAKE);
    const events: CliEvent[] = [];

    const result = await adapter.runTurn({
      cwd,
      prompt: "hello agent",
      allowedTools: ["Read", "mcp__hub__send_message"],
      mcpServers: { hub: { command: "node", args: ["bridge.js"] } },
      onEvent: (e) => events.push(e),
    });

    expect(result.sessionId).toBe("fake-sess-new");
    expect(result.text).toBe("echo: hello agent");
    expect(result.costUsd).toBe(0.01);
    expect(events.map((e) => e.type)).toEqual(["system", "result"]);

    const [c] = readCaptures(cap);
    expect(c!.stdin).toBe("hello agent");
    expect(c!.cwd).toBe(cwd);
    expect(c!.args).toContain("-p");
    expect(c!.args).toContain("--strict-mcp-config");
    expect(c!.args).not.toContain("--resume");
    const toolsIdx = c!.args.indexOf("--allowedTools");
    expect(c!.args[toolsIdx + 1]).toBe("Read,mcp__hub__send_message");
    const mcpIdx = c!.args.indexOf("--mcp-config");
    expect(JSON.parse(c!.args[mcpIdx + 1]!)).toEqual({
      mcpServers: { hub: { command: "node", args: ["bridge.js"] } },
    });
  });

  it("passes --resume and keeps the session id", async () => {
    const cap = captureFile();
    process.env["FAKE_CLAUDE_CAPTURE"] = cap;
    const adapter = new ClaudeCodeAdapter(FAKE);
    const result = await adapter.runTurn({
      cwd: process.cwd(),
      prompt: "again",
      sessionId: "sess-42",
      allowedTools: ["Read"],
    });
    expect(result.sessionId).toBe("sess-42");
    const [c] = readCaptures(cap);
    const resumeIdx = c!.args.indexOf("--resume");
    expect(c!.args[resumeIdx + 1]).toBe("sess-42");
  });

  it("rejects when the CLI dies without a result event", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "no-result";
    const adapter = new ClaudeCodeAdapter(FAKE);
    await expect(
      adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [] }),
    ).rejects.toThrow(/no result event|exit/);
    delete process.env["FAKE_CLAUDE_MODE"];
  });

  it("kills and rejects on timeout", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    const adapter = new ClaudeCodeAdapter(FAKE);
    await expect(
      adapter.runTurn({ cwd: process.cwd(), prompt: "x", allowedTools: [], timeoutMs: 500 }),
    ).rejects.toThrow(/timeout/i);
    delete process.env["FAKE_CLAUDE_MODE"];
  }, 10_000);
});
```

- [ ] **Step 3: RED**

Run: `npx pnpm vitest run packages/daemon/test/claude-adapter.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

`packages/daemon/src/adapter.ts`:
```ts
import type { CliEvent, ParsedTurn } from "./stream-json.js";

export interface TurnOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  allowedTools: string[];
  mcpServers?: Record<string, unknown>;
  timeoutMs?: number;
  onEvent?: (e: CliEvent) => void;
}

export type TurnResult = ParsedTurn;

export interface RuntimeAdapter {
  runTurn(opts: TurnOptions): Promise<TurnResult>;
}
```

`packages/daemon/src/claude-adapter.ts`:
```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "./adapter.js";
import { parseStreamLine, summarizeTurn, type CliEvent } from "./stream-json.js";

const DEFAULT_TIMEOUT_MS = 600_000;

export class ClaudeCodeAdapter implements RuntimeAdapter {
  constructor(private readonly bin = "claude") {}

  runTurn(opts: TurnOptions): Promise<TurnResult> {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "dontAsk",
      "--allowedTools", opts.allowedTools.join(","),
    ];
    if (opts.mcpServers) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: opts.mcpServers }));
      args.push("--strict-mcp-config");
    }
    if (opts.sessionId) args.push("--resume", opts.sessionId);

    return new Promise<TurnResult>((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
      const events: CliEvent[] = [];
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        fail(new Error(`claude turn timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      function fail(err: Error): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }

      function succeed(result: TurnResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }

      child.on("error", (err) => fail(new Error(`failed to spawn ${this.bin}: ${err.message}`)));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const event = parseStreamLine(line);
        if (!event) return;
        events.push(event);
        opts.onEvent?.(event);
      });

      child.on("close", (code) => {
        try {
          succeed(summarizeTurn(events));
        } catch (err) {
          const detail = stderr.trim().slice(-500);
          fail(
            new Error(
              `${(err as Error).message} (exit code ${code}${detail ? `, stderr: ${detail}` : ""})`,
            ),
          );
        }
      });

      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  }
}
```

- [ ] **Step 5: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (14 daemon tests; timeout test takes ~0.5s).
Run: `npx pnpm typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): claude code adapter with resume, mcp config, timeout"
```

---

### Task 5: SessionStore + TurnQueue

**Files:**
- Create: `packages/daemon/src/session-store.ts`, `packages/daemon/src/turn-queue.ts`
- Test: `packages/daemon/test/session-store.test.ts`, `packages/daemon/test/turn-queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 8 depends on these exact names):
  - `class SessionStore { constructor(filePath: string) }` — `get(threadId: string, agentId: string): string | undefined`, `set(threadId: string, agentId: string, sessionId: string): void`. Persists synchronously to JSON on every `set`; a missing or corrupt file loads as empty (never throws on load).
  - `class TurnQueue { run<T>(agentId: string, fn: () => Promise<T>): Promise<T> }` — serializes `fn` invocations per agentId (a rejected fn does not wedge the queue); different agentIds run concurrently.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/session-store.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "conclave-ss-")), "state.json");
}

describe("SessionStore", () => {
  it("stores and retrieves per thread+agent, persisting across instances", () => {
    const path = tmpPath();
    const store = new SessionStore(path);
    expect(store.get("t1", "a1")).toBeUndefined();
    store.set("t1", "a1", "sess-1");
    store.set("t1", "a2", "sess-2");
    expect(store.get("t1", "a1")).toBe("sess-1");
    const reloaded = new SessionStore(path);
    expect(reloaded.get("t1", "a2")).toBe("sess-2");
  });

  it("survives a corrupt state file", () => {
    const path = tmpPath();
    writeFileSync(path, "{corrupt");
    const store = new SessionStore(path);
    expect(store.get("t", "a")).toBeUndefined();
    store.set("t", "a", "s");
    expect(new SessionStore(path).get("t", "a")).toBe("s");
  });
});
```

`packages/daemon/test/turn-queue.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { TurnQueue } from "../src/turn-queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TurnQueue", () => {
  it("serializes same-agent turns, keeps agents independent", async () => {
    const queue = new TurnQueue();
    const order: string[] = [];
    const a1 = queue.run("a", async () => {
      await sleep(80);
      order.push("a-first");
    });
    const a2 = queue.run("a", async () => {
      order.push("a-second");
    });
    const b1 = queue.run("b", async () => {
      order.push("b-while-a-busy");
    });
    await Promise.all([a1, a2, b1]);
    expect(order.indexOf("b-while-a-busy")).toBeLessThan(order.indexOf("a-first"));
    expect(order.indexOf("a-first")).toBeLessThan(order.indexOf("a-second"));
  });

  it("continues after a rejected turn and propagates the rejection", async () => {
    const queue = new TurnQueue();
    const failing = queue.run("a", async () => {
      throw new Error("turn failed");
    });
    await expect(failing).rejects.toThrow("turn failed");
    const after = await queue.run("a", async () => "recovered");
    expect(after).toBe("recovered");
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`packages/daemon/src/session-store.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export class SessionStore {
  private sessions: Record<string, string> = {};

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          this.sessions = parsed as Record<string, string>;
        }
      } catch {
        this.sessions = {};
      }
    }
  }

  get(threadId: string, agentId: string): string | undefined {
    return this.sessions[`${threadId}::${agentId}`];
  }

  set(threadId: string, agentId: string, sessionId: string): void {
    this.sessions[`${threadId}::${agentId}`] = sessionId;
    writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2));
  }
}
```

`packages/daemon/src/turn-queue.ts`:
```ts
export class TurnQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(agentId) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    this.tails.set(agentId, next.catch(() => undefined));
    return next;
  }
}
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (18 daemon tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): persistent session store and per-agent turn queue"
```

---

### Task 6: MCP bridge (stdio server with 4 hub tools)

**Files:**
- Create: `packages/daemon/src/mcp-bridge.ts`
- Test: `packages/daemon/test/mcp-bridge.test.ts`

**Interfaces:**
- Consumes: `HubClient` (Task 2).
- Produces: an executable module (run via `npx tsx packages/daemon/src/mcp-bridge.ts`) that reads env `CONCLAVE_HUB_URL`, `CONCLAVE_TOKEN`, `CONCLAVE_THREAD_ID`, `CONCLAVE_AGENT_ID` and serves MCP server name `hub` over stdio with tools:
  - `send_message { body: string, to?: string[] }` → posts to the thread as the agent (`type: "text"`), returns the posted message JSON as text content.
  - `check_inbox { after?: number }` → lists thread messages after id, excluding the agent's own, returns JSON array as text.
  - `wait_for_reply { after: number, timeout_seconds?: number (default 60, max 60) }` → long-polls the hub, excluding the agent's own messages, returns JSON array (possibly empty).
  - `end_thread { verdict: string }` → sets the agent's verdict, returns the updated thread JSON.
  - Tool errors (hub down, 4xx) return `isError: true` content with the message — never crash the process.
  - Also exports `buildBridgeServer(client: HubClient, threadId: string, agentId: string): McpServer` for the entrypoint and any direct reuse; the module runs `main()` only when executed directly (import.meta.url check).

- [ ] **Step 1: Write the failing test**

The test drives the real bridge process over real stdio using the MCP SDK client (zod v3 is already a daemon dependency; the SDK ships its own client classes).

`packages/daemon/test/mcp-bridge.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Message, Thread } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";

const TOKEN = "bridge-token";
const BRIDGE = fileURLToPath(new URL("../src/mcp-bridge.ts", import.meta.url));

describe("mcp-bridge over stdio against a live hub", () => {
  let app: FastifyInstance;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await app.close();
  });

  it("serves the four tools and round-trips them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conclave-bridge-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const thread = mailbox.createThread({
      kind: "chat",
      participants: ["you", "claude-code"],
    });
    mailbox.appendMessage(thread.id, {
      from: "you", to: ["claude-code"], type: "text", body: "ping", artifacts: [],
    });

    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", BRIDGE],
        env: {
          ...process.env,
          CONCLAVE_HUB_URL: `http://127.0.0.1:${port}`,
          CONCLAVE_TOKEN: TOKEN,
          CONCLAVE_THREAD_ID: thread.id,
          CONCLAVE_AGENT_ID: "claude-code",
        },
      }),
    );

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "check_inbox", "end_thread", "send_message", "wait_for_reply",
    ]);

    const inbox = await client.callTool({ name: "check_inbox", arguments: {} });
    const inboxMsgs = JSON.parse(
      (inbox.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Message[];
    expect(inboxMsgs.map((m) => m.body)).toEqual(["ping"]);

    const sent = await client.callTool({
      name: "send_message",
      arguments: { body: "pong", to: ["you"] },
    });
    const sentMsg = JSON.parse(
      (sent.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Message;
    expect(sentMsg.from).toBe("claude-code");
    expect(mailbox.listMessages(thread.id).map((m) => m.body)).toEqual(["ping", "pong"]);

    // check_inbox excludes own messages
    const inbox2 = await client.callTool({
      name: "check_inbox",
      arguments: { after: 0 },
    });
    const inbox2Msgs = JSON.parse(
      (inbox2.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Message[];
    expect(inbox2Msgs.map((m) => m.body)).toEqual(["ping"]);

    const ended = await client.callTool({
      name: "end_thread",
      arguments: { verdict: "done: replied" },
    });
    const endedThread = JSON.parse(
      (ended.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as Thread;
    expect(endedThread.verdicts["claude-code"]).toBe("done: replied");

    // tool error path: end_thread again on the (possibly settled) thread with bad agent state
    const bad = await client.callTool({
      name: "send_message",
      arguments: { body: "" },
    });
    expect(bad.isError).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/mcp-bridge.test.ts`
Expected: FAIL — bridge module missing (transport spawn fails / connect times out).

- [ ] **Step 3: Implement**

`packages/daemon/src/mcp-bridge.ts`:
```ts
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubClient } from "./hub-client.js";

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function err(e: unknown): ToolText {
  return {
    content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

export function buildBridgeServer(
  client: HubClient,
  threadId: string,
  agentId: string,
): McpServer {
  const server = new McpServer({ name: "hub", version: "0.1.0" });

  server.registerTool(
    "send_message",
    {
      description: "Send a message into the current Conclave thread as this agent.",
      inputSchema: {
        body: z.string().min(1).describe("Message text"),
        to: z.array(z.string()).optional().describe("Recipient ids, e.g. [\"you\"]"),
      },
    },
    async ({ body, to }) => {
      try {
        return ok(
          await client.postMessage(threadId, {
            from: agentId, to: to ?? [], type: "text", body, artifacts: [],
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "check_inbox",
    {
      description: "List messages in the current thread (excluding your own).",
      inputSchema: {
        after: z.number().int().nonnegative().optional()
          .describe("Only messages with id greater than this"),
      },
    },
    async ({ after }) => {
      try {
        const msgs = await client.listMessages(threadId, after ?? 0);
        return ok(msgs.filter((m) => m.from !== agentId));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "wait_for_reply",
    {
      description:
        "Wait up to timeout_seconds for a new message after the given id; returns messages (possibly empty).",
      inputSchema: {
        after: z.number().int().nonnegative().describe("Last seen message id"),
        timeout_seconds: z.number().int().positive().max(60).optional(),
      },
    },
    async ({ after, timeout_seconds }) => {
      try {
        const msgs = await client.listMessages(threadId, after, timeout_seconds ?? 60);
        return ok(msgs.filter((m) => m.from !== agentId));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "end_thread",
    {
      description:
        "Record your final verdict and end your participation in this thread. Verdict is required.",
      inputSchema: {
        verdict: z.string().min(1).describe("approve | reject | short position summary"),
      },
    },
    async ({ verdict }) => {
      try {
        return ok(await client.setVerdict(threadId, agentId, verdict));
      } catch (e) {
        return err(e);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      console.error(`mcp-bridge: ${name} is required`);
      process.exit(1);
    }
    return v;
  };
  const client = new HubClient(need("CONCLAVE_HUB_URL").replace(/\/$/, ""), need("CONCLAVE_TOKEN"));
  const server = buildBridgeServer(client, need("CONCLAVE_THREAD_ID"), need("CONCLAVE_AGENT_ID"));
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
```

Note on the SDK: `registerTool` with a raw zod-v3 shape as `inputSchema` is the current 1.x API. If the installed SDK version predates `registerTool` (< 1.10), use `server.tool(name, description, shape, handler)` with the same shapes — but prefer upgrading the dep to `^1.12` (Task 2 installed latest 1.x, so `registerTool` is expected to exist; verify with `npx pnpm why @modelcontextprotocol/sdk`).

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/daemon/test/mcp-bridge.test.ts` — Expected: PASS (1 test, ~5-10s: real stdio spawn via tsx).
Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (19 daemon tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): mcp bridge exposing hub tools over stdio"
```

---

### Task 7: HubSocket (WebSocket client with reconnect)

**Files:**
- Create: `packages/daemon/src/hub-socket.ts`
- Test: `packages/daemon/test/hub-socket.test.ts`

**Interfaces:**
- Consumes: hub `/ws` endpoint (step 1): frames `{type:"message", message}` / `{type:"thread", thread}`.
- Produces (Task 8 depends on this):
  - `class HubSocket { constructor(opts: { hubUrl: string; token: string; onMessage: (m: Message) => void; reconnectDelayMs?: number }) }` with `start(): void` and `stop(): void`. Converts `http(s)://` to `ws(s)://`, connects to `/ws?token=...`, invokes `onMessage` for every `type === "message"` frame (ignores other frames and unparseable data), reconnects after `reconnectDelayMs` (default 1000) on close/error until `stop()` is called. `stop()` closes the socket and cancels pending reconnects.

- [ ] **Step 1: Write the failing test**

`packages/daemon/test/hub-socket.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Message } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubSocket } from "../src/hub-socket.js";

const TOKEN = "hs-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await sleep(25);
  }
}

describe("HubSocket", () => {
  let app: FastifyInstance;
  let socket: HubSocket | undefined;

  afterEach(async () => {
    socket?.stop();
    await app.close();
  });

  async function liveHub() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-hs-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    return { mailbox, url: `http://127.0.0.1:${port}` };
  }

  it("delivers message events", async () => {
    const { mailbox, url } = await liveHub();
    const seen: Message[] = [];
    socket = new HubSocket({ hubUrl: url, token: TOKEN, onMessage: (m) => seen.push(m) });
    socket.start();
    await sleep(300); // let it connect
    const t = mailbox.createThread({ kind: "chat", participants: ["you"] });
    mailbox.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "over the wire", artifacts: [],
    });
    await until(() => seen.length === 1);
    expect(seen[0]!.body).toBe("over the wire");
  });

  it("reconnects after the server restarts", async () => {
    const { mailbox, url } = await liveHub();
    const port = Number(new URL(url).port);
    const seen: Message[] = [];
    socket = new HubSocket({
      hubUrl: url, token: TOKEN, onMessage: (m) => seen.push(m), reconnectDelayMs: 100,
    });
    socket.start();
    await sleep(300);

    await app.close(); // drop the connection
    await sleep(200);

    // restart on the SAME port with a fresh hub sharing no state (new db, fine)
    const dir = mkdtempSync(join(tmpdir(), "conclave-hs2-"));
    const mailbox2 = new Mailbox(openDb(join(dir, "t2.db")));
    app = await buildServer({ mailbox: mailbox2, token: TOKEN });
    await app.listen({ port, host: "127.0.0.1" });

    await sleep(500); // allow reconnect
    const t = mailbox2.createThread({ kind: "chat", participants: ["you"] });
    mailbox2.appendMessage(t.id, {
      from: "you", to: [], type: "text", body: "after restart", artifacts: [],
    });
    await until(() => seen.some((m) => m.body === "after restart"));
    expect(mailbox).toBeDefined();
  }, 15_000);
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/hub-socket.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/daemon/src/hub-socket.ts`:
```ts
import WebSocket from "ws";
import { MessageSchema, type Message } from "@conclave/shared";

export interface HubSocketOptions {
  hubUrl: string;
  token: string;
  onMessage: (m: Message) => void;
  reconnectDelayMs?: number;
}

export class HubSocket {
  private ws: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly opts: HubSocketOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const wsUrl = `${this.opts.hubUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("message", (data) => {
      try {
        const frame: unknown = JSON.parse(String(data));
        const candidate = (frame as { type?: unknown; message?: unknown });
        if (candidate.type !== "message") return;
        const parsed = MessageSchema.safeParse(candidate.message);
        if (parsed.success) this.opts.onMessage(parsed.data);
      } catch {
        // ignore unparseable frames
      }
    });

    const scheduleReconnect = (): void => {
      if (this.stopped || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect();
      }, this.opts.reconnectDelayMs ?? 1000);
    };

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  }
}
```

- [ ] **Step 4: GREEN**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (21 daemon tests; reconnect test takes a few seconds).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): hub websocket client with reconnect"
```

---

### Task 8: AgentLoop — trigger rules, prompt building, turn wiring (E2E)

**Files:**
- Create: `packages/daemon/src/agent-loop.ts`
- Test: `packages/daemon/test/agent-loop.test.ts`

**Interfaces:**
- Consumes: `HubClient` (2), `RuntimeAdapter`/`TurnOptions`/`TurnResult` (4), `SessionStore` (5), `TurnQueue` (5), `AgentConfig` (1), `Message` (shared).
- Produces (Task 9 depends on this):
  - `const HUB_MCP_TOOLS = ["mcp__hub__send_message", "mcp__hub__check_inbox", "mcp__hub__wait_for_reply", "mcp__hub__end_thread"]`
  - `shouldTrigger(agent: AgentConfig, m: Message, allowAgentTriggers: boolean): boolean` — pure; true iff `m.to.includes(agent.id)` AND `m.from !== agent.id` AND `(m.type === "text" || m.type === "proposal")` AND `(m.from === "you" || allowAgentTriggers)`.
  - `buildTurnPrompt(agent: AgentConfig, m: Message, isFirstTurn: boolean): string` — first turn: role preamble + agent/thread intro + tool hint + the message; later turns: sender line + body only.
  - `class AgentLoop { constructor(opts: { agents: AgentConfig[]; hub: HubClient; adapter: RuntimeAdapter; store: SessionStore; queue: TurnQueue; hubUrl: string; token: string; allowAgentTriggers: boolean; bridgeCommand?: { command: string; args: string[] } }) }` with `handleMessage(m: Message): void` (fire-and-forget; internally enqueues per matching agent) and `idle(): Promise<void>` (resolves when all in-flight turns finish — for tests/shutdown).
  - Behavior per triggered agent: enqueue on `queue.run(agent.id, ...)`; inside the turn — look up `sessionId = store.get(m.threadId, agent.id)`; build prompt (`isFirstTurn = sessionId === undefined`); call `adapter.runTurn({ cwd: agent.workspace, prompt, sessionId, allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS], mcpServers: { hub: { command, args, env: { CONCLAVE_HUB_URL, CONCLAVE_TOKEN, CONCLAVE_THREAD_ID: m.threadId, CONCLAVE_AGENT_ID: agent.id } } } })`; store the returned sessionId; post the result text to the thread as `{ from: agent.id, to: [m.from], type: "text", body: result.text }` (skip posting when `result.text` is empty); on turn error, post `{ type: "status", body: "agent <id> turn failed: <message>" }` and swallow (never crash the loop). Default `bridgeCommand`: `{ command: "npx", args: ["tsx", <abs path to src/mcp-bridge.ts resolved from import.meta.url>] }`.

- [ ] **Step 1: Write the failing tests**

`packages/daemon/test/agent-loop.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AgentConfig, Message } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { buildServer } from "@conclave/hub/src/server.js";
import { HubClient } from "../src/hub-client.js";
import { SessionStore } from "../src/session-store.js";
import { TurnQueue } from "../src/turn-queue.js";
import type { RuntimeAdapter, TurnOptions, TurnResult } from "../src/adapter.js";
import {
  AgentLoop, HUB_MCP_TOOLS, buildTurnPrompt, shouldTrigger,
} from "../src/agent-loop.js";

const TOKEN = "al-token";

const AGENT: AgentConfig = {
  id: "claude-code", name: "Claude Code", runtime: "claude-code",
  machine: "dev-box", workspace: "/tmp/agent-ws", role: "You are the dev agent.",
  allowedTools: ["Read"],
};

function msg(partial: Partial<Message>): Message {
  return {
    id: 1, threadId: "t1", from: "you", to: ["claude-code"],
    type: "text", body: "hi", artifacts: [], ts: new Date().toISOString(),
    ...partial,
  };
}

describe("shouldTrigger", () => {
  it("applies all four rules", () => {
    expect(shouldTrigger(AGENT, msg({}), false)).toBe(true);
    expect(shouldTrigger(AGENT, msg({ to: ["someone-else"] }), false)).toBe(false);
    expect(shouldTrigger(AGENT, msg({ from: "claude-code", to: ["claude-code"] }), false)).toBe(false);
    expect(shouldTrigger(AGENT, msg({ type: "status" }), false)).toBe(false);
    expect(shouldTrigger(AGENT, msg({ from: "codex" }), false)).toBe(false);
    expect(shouldTrigger(AGENT, msg({ from: "codex" }), true)).toBe(true);
    expect(shouldTrigger(AGENT, msg({ type: "proposal" }), false)).toBe(true);
  });
});

describe("buildTurnPrompt", () => {
  it("includes role and tool hint on first turn only", () => {
    const first = buildTurnPrompt(AGENT, msg({}), true);
    expect(first).toContain("You are the dev agent.");
    expect(first).toContain("claude-code");
    expect(first).toContain("send_message");
    expect(first).toContain("hi");
    const later = buildTurnPrompt(AGENT, msg({ body: "again" }), false);
    expect(later).not.toContain("You are the dev agent.");
    expect(later).toContain("[you]: again");
  });
});

class FakeAdapter implements RuntimeAdapter {
  calls: TurnOptions[] = [];
  failNext = false;

  async runTurn(opts: TurnOptions): Promise<TurnResult> {
    this.calls.push(opts);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated CLI crash");
    }
    return {
      sessionId: opts.sessionId ?? "fake-sess-1",
      text: `reply to: ${opts.prompt.split("\n").at(-1)}`,
      isError: false,
      costUsd: 0.01,
    };
  }
}

describe("AgentLoop end-to-end (live hub, fake adapter)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "conclave-al-"));
    const mailbox = new Mailbox(openDb(join(dir, "t.db")));
    app = await buildServer({ mailbox, token: TOKEN });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const adapter = new FakeAdapter();
    const loop = new AgentLoop({
      agents: [AGENT],
      hub: new HubClient(hubUrl, TOKEN),
      adapter,
      store: new SessionStore(join(dir, "state.json")),
      queue: new TurnQueue(),
      hubUrl,
      token: TOKEN,
      allowAgentTriggers: false,
      bridgeCommand: { command: "node", args: ["/fake/bridge.js"] },
    });
    return { mailbox, adapter, loop };
  }

  it("runs a turn and posts the reply; resumes on the second turn", async () => {
    const { mailbox, adapter, loop } = await setup();
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "first ask", artifacts: [],
    });

    loop.handleMessage(m1);
    await loop.idle();

    const bodies = mailbox.listMessages(t.id).map((m) => m.body);
    expect(bodies.some((b) => b.includes("first ask"))).toBe(true);
    expect(adapter.calls[0]!.sessionId).toBeUndefined();
    expect(adapter.calls[0]!.cwd).toBe("/tmp/agent-ws");
    expect(adapter.calls[0]!.allowedTools).toEqual(["Read", ...HUB_MCP_TOOLS]);
    const env = (adapter.calls[0]!.mcpServers!["hub"] as { env: Record<string, string> }).env;
    expect(env["CONCLAVE_THREAD_ID"]).toBe(t.id);
    expect(env["CONCLAVE_AGENT_ID"]).toBe("claude-code");

    const m2 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "second ask", artifacts: [],
    });
    loop.handleMessage(m2);
    await loop.idle();
    expect(adapter.calls[1]!.sessionId).toBe("fake-sess-1");
  });

  it("does not trigger on its own replies (no loops)", async () => {
    const { mailbox, adapter, loop } = await setup();
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "ask", artifacts: [],
    });
    loop.handleMessage(m1);
    await loop.idle();
    // feed the agent's own reply back through the loop, as HubSocket would
    for (const m of mailbox.listMessages(t.id)) loop.handleMessage(m);
    await loop.idle();
    expect(adapter.calls).toHaveLength(1);
  });

  it("posts a status message when a turn fails", async () => {
    const { mailbox, adapter, loop } = await setup();
    adapter.failNext = true;
    const t = mailbox.createThread({ kind: "chat", participants: ["you", "claude-code"] });
    const m1 = mailbox.appendMessage(t.id, {
      from: "you", to: ["claude-code"], type: "text", body: "ask", artifacts: [],
    });
    loop.handleMessage(m1);
    await loop.idle();
    const status = mailbox.listMessages(t.id).find((m) => m.type === "status");
    expect(status).toBeDefined();
    expect(status!.body).toContain("simulated CLI crash");
  });
});
```

- [ ] **Step 2: RED**

Run: `npx pnpm vitest run packages/daemon/test/agent-loop.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/daemon/src/agent-loop.ts`:
```ts
import { fileURLToPath } from "node:url";
import type { AgentConfig, Message } from "@conclave/shared";
import type { RuntimeAdapter } from "./adapter.js";
import type { HubClient } from "./hub-client.js";
import type { SessionStore } from "./session-store.js";
import type { TurnQueue } from "./turn-queue.js";

export const HUB_MCP_TOOLS = [
  "mcp__hub__send_message",
  "mcp__hub__check_inbox",
  "mcp__hub__wait_for_reply",
  "mcp__hub__end_thread",
];

const DEFAULT_BRIDGE = {
  command: "npx",
  args: ["tsx", fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url))],
};

export function shouldTrigger(
  agent: AgentConfig,
  m: Message,
  allowAgentTriggers: boolean,
): boolean {
  if (!m.to.includes(agent.id)) return false;
  if (m.from === agent.id) return false;
  if (m.type !== "text" && m.type !== "proposal") return false;
  if (m.from !== "you" && !allowAgentTriggers) return false;
  return true;
}

export function buildTurnPrompt(agent: AgentConfig, m: Message, isFirstTurn: boolean): string {
  if (!isFirstTurn) return `[${m.from}]: ${m.body}`;
  const role = agent.role ? `${agent.role}\n\n` : "";
  return (
    `${role}You are agent "${agent.id}" in Conclave thread ${m.threadId}. ` +
    `Hub MCP tools are available: send_message, check_inbox, wait_for_reply, end_thread. ` +
    `Your final response text is posted to the thread automatically — use send_message only ` +
    `for additional mid-turn messages.\n\n[${m.from}]: ${m.body}`
  );
}

export interface AgentLoopOptions {
  agents: AgentConfig[];
  hub: HubClient;
  adapter: RuntimeAdapter;
  store: SessionStore;
  queue: TurnQueue;
  hubUrl: string;
  token: string;
  allowAgentTriggers: boolean;
  bridgeCommand?: { command: string; args: string[] };
}

export class AgentLoop {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly opts: AgentLoopOptions) {}

  handleMessage(m: Message): void {
    for (const agent of this.opts.agents) {
      if (!shouldTrigger(agent, m, this.opts.allowAgentTriggers)) continue;
      const turn = this.opts.queue
        .run(agent.id, () => this.runTurn(agent, m))
        .catch(() => undefined);
      this.inFlight.add(turn);
      void turn.finally(() => this.inFlight.delete(turn));
    }
  }

  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private async runTurn(agent: AgentConfig, m: Message): Promise<void> {
    const { hub, store, hubUrl, token } = this.opts;
    const bridge = this.opts.bridgeCommand ?? DEFAULT_BRIDGE;
    try {
      const sessionId = store.get(m.threadId, agent.id);
      const result = await this.opts.adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildTurnPrompt(agent, m, sessionId === undefined),
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: {
          hub: {
            command: bridge.command,
            args: bridge.args,
            env: {
              CONCLAVE_HUB_URL: hubUrl,
              CONCLAVE_TOKEN: token,
              CONCLAVE_THREAD_ID: m.threadId,
              CONCLAVE_AGENT_ID: agent.id,
            },
          },
        },
      });
      if (result.sessionId) store.set(m.threadId, agent.id, result.sessionId);
      if (result.text.trim()) {
        await hub.postMessage(m.threadId, {
          from: agent.id, to: [m.from], type: "text", body: result.text, artifacts: [],
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      try {
        await hub.postMessage(m.threadId, {
          from: agent.id, to: [], type: "status",
          body: `agent ${agent.id} turn failed: ${reason}`, artifacts: [],
        });
      } catch {
        // hub unreachable — nothing more we can do from here
      }
    }
  }
}
```

- [ ] **Step 4: GREEN + full suite**

Run: `npx pnpm vitest run packages/daemon` — Expected: PASS (26 daemon tests).
Run: `npx pnpm test && npx pnpm typecheck` — Expected: 66 tests total (9 shared + 31 hub + 26 daemon), all passing; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): agent loop with trigger rules, resume, error status"
```

---

### Task 9: Daemon entrypoint, README, manual real-claude smoke

**Files:**
- Create: `packages/daemon/src/main.ts`, `packages/daemon/README.md`
- Modify: `.gitignore` (add `daemon-state.json`)

**Interfaces:**
- Consumes: everything above.
- Produces: `CONCLAVE_HUB_URL=... CONCLAVE_TOKEN=... CONCLAVE_MACHINE=... npx pnpm --filter @conclave/daemon dev` runs the daemon: fetches its registry slice, starts the socket, logs triggers and turn completions.

- [ ] **Step 1: Implement the entrypoint**

`packages/daemon/src/main.ts`:
```ts
import { loadDaemonConfig } from "./config.js";
import { HubClient } from "./hub-client.js";
import { HubSocket } from "./hub-socket.js";
import { SessionStore } from "./session-store.js";
import { TurnQueue } from "./turn-queue.js";
import { ClaudeCodeAdapter } from "./claude-adapter.js";
import { AgentLoop } from "./agent-loop.js";

const cfg = loadDaemonConfig(process.env);
const hub = new HubClient(cfg.hubUrl, cfg.token);

const agents = (await hub.getRegistry(cfg.machine)).filter(
  (a) => a.runtime === "claude-code",
);
if (agents.length === 0) {
  console.warn(`no claude-code agents registered for machine "${cfg.machine}" — idling`);
}
for (const a of agents) console.log(`agent ${a.id} → ${a.workspace}`);

const loop = new AgentLoop({
  agents,
  hub,
  adapter: new ClaudeCodeAdapter(cfg.claudeBin),
  store: new SessionStore(cfg.stateFile),
  queue: new TurnQueue(),
  hubUrl: cfg.hubUrl,
  token: cfg.token,
  allowAgentTriggers: cfg.allowAgentTriggers,
});

const socket = new HubSocket({
  hubUrl: cfg.hubUrl,
  token: cfg.token,
  onMessage: (m) => {
    loop.handleMessage(m);
  },
});
socket.start();
console.log(`conclave daemon on ${cfg.machine}: watching ${agents.length} agent(s) via ${cfg.hubUrl}`);
```

Add to `.gitignore` under the "Build output" section:
```
daemon-state.json
```

- [ ] **Step 2: Write the README**

`packages/daemon/README.md`:
```markdown
# @conclave/daemon

Watches the hub; when a message @-addresses one of this machine's agents,
spawns a headless Claude Code turn in the agent's workspace and posts the
reply back. Sessions resume per (thread, agent). Each turn gets an MCP
bridge (`hub` server: send_message / check_inbox / wait_for_reply /
end_thread).

## Run

CONCLAVE_HUB_URL=http://127.0.0.1:7777 CONCLAVE_TOKEN=dev \
CONCLAVE_MACHINE=dev-box npx pnpm --filter @conclave/daemon dev

Env: CONCLAVE_HUB_URL, CONCLAVE_TOKEN, CONCLAVE_MACHINE (required) ·
CONCLAVE_CLAUDE_BIN (default `claude`) · CONCLAVE_STATE_FILE (default
`./daemon-state.json`) · CONCLAVE_ALLOW_AGENT_TRIGGERS (default 0 — agents
only respond to "you")

## Registry

Agents live in `registry.yaml` in the hub's data dir:

    agents:
      - id: claude-code
        name: Claude Code
        runtime: claude-code
        machine: dev-box
        workspace: /abs/path/to/project
        role: "You are the primary dev agent."
        allowedTools: [Read, Grep, Glob]

## Smoke test (manual — burns real quota)

1. Hub: `CONCLAVE_TOKEN=dev npx pnpm --filter @conclave/hub dev` (with a
   registry.yaml in its data dir as above, machine matching yours)
2. Daemon: as above
3. Create a thread and @ the agent:

       curl -s -X POST localhost:7777/api/threads -H "Authorization: Bearer dev" \
         -H "Content-Type: application/json" \
         -d '{"kind":"chat","participants":["you","claude-code"]}'
       curl -s -X POST localhost:7777/api/threads/<ID>/messages \
         -H "Authorization: Bearer dev" -H "Content-Type: application/json" \
         -d '{"from":"you","to":["claude-code"],"body":"Introduce yourself and use send_message to say hi twice."}'
       curl -s "localhost:7777/api/threads/<ID>/messages?after=0&wait=60" \
         -H "Authorization: Bearer dev"

Expect the agent's reply (and any extra send_message posts) in the list.
```

- [ ] **Step 3: Full verification**

Run: `npx pnpm test && npx pnpm typecheck`
Expected: all tests passing (record the exact printed total), typecheck clean across shared/hub/daemon.

- [ ] **Step 4: Manual smoke decision**

The real-claude smoke (README steps) costs subscription quota and needs the local `claude` login. DO NOT run it automatically — report to the controller that the code path is ready and let the human decide when to run it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(daemon): runnable entrypoint and operator readme"
```
