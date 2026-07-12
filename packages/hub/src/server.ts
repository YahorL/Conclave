import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { NewMessageSchema, NewThreadSchema } from "@conclave/shared";
import {
  Mailbox,
  NotAParticipantError,
  ThreadClosedError,
  ThreadNotFoundError,
} from "./mailbox.js";

export interface ServerOptions {
  mailbox: Mailbox;
  token: string;
}

const VerdictBodySchema = z.object({
  agent: z.string().min(1),
  verdict: z.string().min(1),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { mailbox, token } = opts;
  const app = Fastify();
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const header = req.headers.authorization;
    const query = req.query as { token?: string };
    if (header === `Bearer ${token}` || query.token === token) return;
    await reply.code(401).send({ error: "unauthorized" });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ThreadNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ThreadClosedError) return reply.code(409).send({ error: err.message });
    if (err instanceof NotAParticipantError) return reply.code(403).send({ error: err.message });
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
    const query = req.query as { after?: string };
    const after = Number(query.after ?? 0);
    return mailbox.listMessages(id, Number.isFinite(after) ? after : 0);
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
