import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RegistrySchema, type Registry, type Task } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { TaskStore } from "@conclave/hub/src/tasks.js";
import { buildServer } from "@conclave/hub/src/server.js";

const TOKEN = "delegate-token";
const BRIDGE = fileURLToPath(new URL("../src/mcp-bridge.ts", import.meta.url));
const REGISTRY: Registry = RegistrySchema.parse({
  agents: [
    { id: "dev", name: "dev", runtime: "codex", machine: "m", workspace: "/w" },
    { id: "deploy", name: "deploy", runtime: "codex", machine: "m", workspace: "/w" },
    { id: "audit", name: "audit", runtime: "codex", machine: "m", workspace: "/w" },
  ],
  acl: [["dev", "deploy"]],
});

function text(res: unknown): string {
  return (res as { content: Array<{ type: string; text: string }> }).content[0]!.text;
}

describe("delegate_task MCP tool against a live hub", () => {
  let app: FastifyInstance;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await app.close();
  });

  async function connect(mailbox: Mailbox, port: number, threadId: string): Promise<Client> {
    const c = new Client({ name: "test", version: "0.0.0" });
    await c.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", BRIDGE],
        env: {
          ...process.env,
          CONCLAVE_HUB_URL: `http://127.0.0.1:${port}`,
          CONCLAVE_TOKEN: TOKEN,
          CONCLAVE_THREAD_ID: threadId,
          CONCLAVE_AGENT_ID: "dev",
        },
      }),
    );
    return c;
  }

  it("delegates to an allowed assignee and creates a task; denies a non-paired one", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-deleg-")), "t.db"));
    const mailbox = new Mailbox(db);
    const tasks = new TaskStore(db);
    app = await buildServer({ mailbox, token: TOKEN, registry: REGISTRY, tasks });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const thread = mailbox.createThread({ kind: "chat", participants: ["dev", "you"] });

    client = await connect(mailbox, port, thread.id);

    const okRes = await client.callTool({
      name: "delegate_task", arguments: { assignee: "deploy", spec: "ship it" },
    });
    expect(okRes.isError).toBeFalsy();
    const task = JSON.parse(text(okRes)) as Task;
    expect(task.assignee).toBe("deploy");
    expect(tasks.get(task.id)?.assignee).toBe("deploy");

    const denied = await client.callTool({
      name: "delegate_task", arguments: { assignee: "audit", spec: "no" },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("403");
  }, 30_000);
});
