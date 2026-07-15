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
import { ArtifactStore } from "@conclave/hub/src/artifacts.js";
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
    const db = openDb(join(dir, "t.db"));
    const mailbox = new Mailbox(db);
    app = await buildServer({ mailbox, token: TOKEN, artifacts: new ArtifactStore(db) });
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
      "check_inbox", "create_artifact", "end_thread", "request_approval", "send_message", "wait_for_reply",
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

    const madeArt = await client.callTool({
      name: "create_artifact",
      arguments: { name: "plan.md", content: "# Plan" },
    });
    const artMeta = JSON.parse(
      (madeArt.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { id: string; name: string };
    expect(artMeta.name).toBe("plan.md");
    const fileMsg = mailbox.listMessages(thread.id).find((m) => m.type === "file");
    expect(fileMsg?.artifacts).toEqual([artMeta.id]);

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
