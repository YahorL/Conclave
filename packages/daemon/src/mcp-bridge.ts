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
