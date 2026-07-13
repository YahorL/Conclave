import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { Message, Thread, TurnRequest, Registry } from "@conclave/shared";
import { NewMessageSchema, NewThreadSchema, UsageReportSchema } from "@conclave/shared";
import {
  Mailbox,
  NotAParticipantError,
  ThreadClosedError,
  ThreadNotFoundError,
} from "./mailbox.js";
import { listUsage, recordUsage } from "./usage.js";

export interface ServerOptions {
  mailbox: Mailbox;
  token: string;
  registry?: Registry;
  db?: Database.Database;
}

const VerdictBodySchema = z.object({
  agent: z.string().min(1),
  verdict: z.string().min(1),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { mailbox, token, registry: registryOpt } = opts;
  const registry: Registry = registryOpt ?? { agents: [] };
  const app = Fastify();
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.split("?")[0] === "/health") return;
    const header = req.headers.authorization;
    const query = req.query as { token?: string };
    if (header === `Bearer ${token}` || query.token === token) return;
    await reply.code(401).send({ error: "unauthorized" });
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ThreadNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ThreadClosedError) return reply.code(409).send({ error: err.message });
    if (err instanceof NotAParticipantError) return reply.code(403).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request" });
    if (typeof err.statusCode === "number" && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/threads", async (req, reply) => {
    const body = parseOr400(NewThreadSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(mailbox.createThread(body));
  });

  app.get("/api/threads", async () => mailbox.listThreads());

  app.get("/api/threads/:id", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const thread = mailbox.getThread(id);
    if (!thread) return reply.code(404).send({ error: `thread not found: ${id}` });
    return thread;
  });

  app.post("/api/threads/:id/messages", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(NewMessageSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(mailbox.appendMessage(id, body));
  });

  app.get("/api/threads/:id/messages", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    if (!mailbox.getThread(id)) return reply.code(404).send({ error: `thread not found: ${id}` });
    const query = req.query as { after?: string; wait?: string };
    const afterRaw = Number(query.after ?? 0);
    const after = Number.isFinite(afterRaw) ? afterRaw : 0;
    const waitRaw = Number(query.wait ?? 0);
    const waitMs = Math.min(Number.isFinite(waitRaw) ? waitRaw : 0, 60) * 1000;

    let messages = mailbox.listMessages(id, after);
    if (messages.length === 0 && waitMs > 0) {
      await waitForThreadMessage(mailbox, id, waitMs);
      messages = mailbox.listMessages(id, after);
    }
    return messages;
  });

  app.post("/api/threads/:id/verdict", async (req, reply) => {
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(VerdictBodySchema, req.body, reply);
    if (!body) return;
    return mailbox.setVerdict(id, body.agent, body.verdict);
  });

  app.post("/api/threads/:id/close", async (req) => {
    const { id } = IdParamsSchema.parse(req.params);
    return mailbox.closeThread(id);
  });

  app.get("/api/registry", async (req) => {
    const query = req.query as { machine?: string };
    if (!query.machine) return registry;
    return { agents: registry.agents.filter((a) => a.machine === query.machine) };
  });

  app.get("/api/messages", async (req) => {
    const query = req.query as { after?: string; limit?: string };
    const after = Number(query.after ?? 0);
    const limit = Number(query.limit ?? 500);
    return mailbox.listAllMessages(
      Number.isFinite(after) ? after : 0,
      Number.isFinite(limit) ? Math.min(limit, 500) : 500,
    );
  });

  app.post("/api/usage", async (req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    const body = parseOr400(UsageReportSchema, req.body, reply);
    if (!body) return;
    recordUsage(opts.db, body);
    return reply.code(201).send({ ok: true });
  });

  app.get("/api/usage", async (_req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    return listUsage(opts.db);
  });

  app.get("/ws", { websocket: true }, (socket) => {
    const onMessage = (message: Message): void => {
      socket.send(JSON.stringify({ type: "message", message }));
    };
    const onThread = (thread: Thread): void => {
      socket.send(JSON.stringify({ type: "thread", thread }));
    };
    const onTurn = (turn: TurnRequest): void => {
      socket.send(JSON.stringify({ type: "turn", turn }));
    };
    mailbox.events.on("message", onMessage);
    mailbox.events.on("thread", onThread);
    mailbox.events.on("turn", onTurn);
    socket.on("close", () => {
      mailbox.events.off("message", onMessage);
      mailbox.events.off("thread", onThread);
      mailbox.events.off("turn", onTurn);
    });
  });

  return app;
}

function parseOr400<T>(
  schema: z.ZodType<T>,
  input: unknown,
  reply: FastifyReply,
): T | undefined {
  const result = schema.safeParse(input);
  if (!result.success) {
    void reply.code(400).send({ error: "invalid body", issues: result.error.issues });
    return undefined;
  }
  return result.data;
}

function waitForThreadMessage(
  mailbox: Mailbox,
  threadId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function onMessage(message: Message): void {
      if (message.threadId === threadId) done();
    }
    function onThread(thread: Thread): void {
      if (thread.id === threadId && (thread.state === "settled" || thread.state === "closed")) {
        done();
      }
    }
    function done(): void {
      clearTimeout(timer);
      mailbox.events.off("message", onMessage);
      mailbox.events.off("thread", onThread);
      resolve();
    }
    mailbox.events.on("message", onMessage);
    mailbox.events.on("thread", onThread);
  });
}
