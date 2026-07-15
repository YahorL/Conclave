import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Registry } from "@conclave/shared";
import { openDb } from "@conclave/hub/src/db.js";
import { Mailbox } from "@conclave/hub/src/mailbox.js";
import { TaskStore, createTask } from "@conclave/hub/src/tasks.js";
import { ApprovalStore, decideApproval } from "@conclave/hub/src/approvals.js";
import { buildServer } from "@conclave/hub/src/server.js";

const TOKEN = "appr-bridge-token";
const BRIDGE = fileURLToPath(new URL("../src/mcp-bridge.ts", import.meta.url));
const REGISTRY: Registry = {
  agents: [{
    id: "codex", name: "codex", runtime: "codex", machine: "m1",
    workspace: "/w", role: "", allowedTools: [], dangerousActions: [],
  }],
};

function text(res: unknown): string {
  return (res as { content: Array<{ type: string; text: string }> }).content[0]!.text;
}

describe("request_approval MCP tool against a live hub", () => {
  let app: FastifyInstance;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await app.close();
  });

  it("files pending, is idempotent, returns the decision once decided", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "conclave-atool-")), "t.db"));
    const mailbox = new Mailbox(db);
    const tasks = new TaskStore(db);
    const approvals = new ApprovalStore(db);
    app = await buildServer({ mailbox, token: TOKEN, registry: REGISTRY, tasks, approvals });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const task = createTask({ mailbox, store: tasks, registry: REGISTRY }, {
      assignee: "codex", spec: "deploy",
    });
    tasks.updateState(task.id, "running");

    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", BRIDGE],
        env: {
          ...process.env,
          CONCLAVE_HUB_URL: `http://127.0.0.1:${port}`,
          CONCLAVE_TOKEN: TOKEN,
          CONCLAVE_THREAD_ID: task.threadId,
          CONCLAVE_AGENT_ID: "codex",
        },
      }),
    );

    const first = JSON.parse(text(await client.callTool({
      name: "request_approval", arguments: { action: "run deploy.sh" },
    }))) as { state: string; approvalId: string; message: string };
    expect(first.state).toBe("pending");
    expect(first.message).toContain("end your turn");
    expect(tasks.get(task.id)?.state).toBe("input-required");
    const msg = mailbox.listMessages(task.threadId).find((m) => m.type === "approval-request");
    expect(msg).toBeTruthy();

    // same action, no explicit key → same approval (default key is derived)
    const second = JSON.parse(text(await client.callTool({
      name: "request_approval", arguments: { action: "run deploy.sh" },
    }))) as { approvalId: string };
    expect(second.approvalId).toBe(first.approvalId);

    // once decided, a retried request returns the decision instead of pending
    decideApproval({ mailbox, store: approvals, tasks }, first.approvalId, "approved", "go");
    const third = JSON.parse(text(await client.callTool({
      name: "request_approval", arguments: { action: "run deploy.sh" },
    }))) as { state: string; note?: string };
    expect(third.state).toBe("approved");
    expect(third.note).toBe("go");
  }, 30_000);
});
