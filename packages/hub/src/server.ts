import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AgentStatus, Approval, Artifact, Message, Task, Thread, TurnRequest, Registry, Workspace } from "@conclave/shared";
import {
  AgentStatusReportSchema,
  ApprovalDecisionSchema,
  ApprovalStateSchema,
  FsOpSchema,
  FsResponseSchema,
  HelloSchema,
  NewApprovalSchema,
  NewArtifactSchema,
  NewDebateSchema,
  NewMessageSchema,
  NewTaskSchema,
  NewThreadSchema,
  NewWorkspaceSchema,
  TaskStateSchema,
  UsageReportSchema,
} from "@conclave/shared";
import {
  Mailbox,
  NotAParticipantError,
  ThreadClosedError,
  ThreadNotFoundError,
} from "./mailbox.js";
import { getUsageSummary, listUsage, recordUsage } from "./usage.js";
import type { DebateOrchestrator } from "./orchestrator.js";
import type { AgentStatusStore } from "./status.js";
import { TaskStore, createTask, InvalidTransitionError, UnknownAssigneeError } from "./tasks.js";
import { ArtifactStore, ArtifactTooLargeError } from "./artifacts.js";
import { AlreadyDecidedError, ApprovalStore, decideApproval, fileApproval } from "./approvals.js";
import { WorkspaceStore } from "./workspaces.js";
import { MachineRegistry, PendingRequests } from "./fs-tunnel.js";

export interface ServerOptions {
  mailbox: Mailbox;
  token: string;
  registry?: Registry;
  db?: Database.Database;
  orchestrator?: DebateOrchestrator;
  status?: AgentStatusStore;
  budgetUsd?: number;
  tasks?: TaskStore;
  artifacts?: ArtifactStore;
  workspaces?: WorkspaceStore;
  approvals?: ApprovalStore;
  webDir?: string;
}

const VerdictBodySchema = z.object({
  agent: z.string().min(1),
  verdict: z.string().min(1),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { mailbox, token, registry: registryOpt } = opts;
  const registry: Registry = registryOpt ?? { agents: [] };
  const machines = new MachineRegistry();
  const pending = new PendingRequests();
  const app = Fastify();
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path === "/health") return;
    // When the hub serves the web app, its static files + SPA routes are public;
    // /api and the /ws upgrade still require the token.
    if (opts.webDir && req.method === "GET" && !path.startsWith("/api") && path !== "/ws") return;
    const header = req.headers.authorization;
    const query = req.query as { token?: string };
    if (header === `Bearer ${token}` || query.token === token) return;
    await reply.code(401).send({ error: "unauthorized" });
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ThreadNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ThreadClosedError) return reply.code(409).send({ error: err.message });
    if (err instanceof NotAParticipantError) return reply.code(403).send({ error: err.message });
    if (err instanceof UnknownAssigneeError) return reply.code(400).send({ error: err.message });
    if (err instanceof InvalidTransitionError) return reply.code(409).send({ error: err.message });
    if (err instanceof ArtifactTooLargeError) return reply.code(413).send({ error: err.message });
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

  app.get("/api/usage/summary", async (_req, reply) => {
    if (!opts.db) return reply.code(503).send({ error: "usage store not configured" });
    return getUsageSummary(opts.db, opts.budgetUsd ?? 25);
  });

  app.post("/api/status", async (req, reply) => {
    if (!opts.status) return reply.code(503).send({ error: "status store not configured" });
    const body = parseOr400(AgentStatusReportSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(opts.status.set(body));
  });

  app.get("/api/status", async (_req, reply) => {
    if (!opts.status) return reply.code(503).send({ error: "status store not configured" });
    return opts.status.list();
  });

  app.post("/api/debates", async (req, reply) => {
    if (!opts.orchestrator) return reply.code(503).send({ error: "orchestrator not configured" });
    const body = parseOr400(NewDebateSchema, req.body, reply);
    if (!body) return;
    return reply.code(201).send(opts.orchestrator.startDebate(body));
  });

  const TaskStateBodySchema = z.object({ state: TaskStateSchema });

  app.post("/api/tasks", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const body = parseOr400(NewTaskSchema, req.body, reply);
    if (!body) return;
    const task = createTask({ mailbox, store: opts.tasks, registry }, body);
    return reply.code(201).send(task);
  });

  app.get("/api/tasks", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const q = req.query as { assignee?: string; state?: string };
    if (q.assignee && q.state) {
      const state = TaskStateSchema.safeParse(q.state);
      if (!state.success) return reply.code(400).send({ error: "invalid state" });
      return opts.tasks.listByAssigneeState(q.assignee, state.data);
    }
    return opts.tasks.list();
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const task = opts.tasks.get(id);
    if (!task) return reply.code(404).send({ error: `task not found: ${id}` });
    return task;
  });

  app.post("/api/tasks/:id/state", async (req, reply) => {
    if (!opts.tasks) return reply.code(503).send({ error: "tasks store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(TaskStateBodySchema, req.body, reply);
    if (!body) return;
    if (!opts.tasks.get(id)) return reply.code(404).send({ error: `task not found: ${id}` });
    const task = opts.tasks.updateState(id, body.state);
    mailbox.events.emit("task", task);
    return task;
  });

  app.post("/api/approvals", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const body = parseOr400(NewApprovalSchema, req.body, reply);
    if (!body) return;
    const approval = fileApproval({ mailbox, store: opts.approvals, tasks: opts.tasks }, body);
    return reply.code(201).send(approval);
  });

  app.get("/api/approvals", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const q = req.query as { state?: string };
    if (q.state) {
      const state = ApprovalStateSchema.safeParse(q.state);
      if (!state.success) return reply.code(400).send({ error: "invalid state" });
      return opts.approvals.list(state.data);
    }
    return opts.approvals.list();
  });

  app.get("/api/approvals/:id", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const approval = opts.approvals.get(id);
    if (!approval) return reply.code(404).send({ error: `approval not found: ${id}` });
    return approval;
  });

  app.post("/api/approvals/:id/decide", async (req, reply) => {
    if (!opts.approvals) return reply.code(503).send({ error: "approvals store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const body = parseOr400(ApprovalDecisionSchema, req.body, reply);
    if (!body) return;
    if (!opts.approvals.get(id)) return reply.code(404).send({ error: `approval not found: ${id}` });
    try {
      return decideApproval(
        { mailbox, store: opts.approvals, tasks: opts.tasks },
        id, body.decision, body.note,
      );
    } catch (e) {
      if (e instanceof AlreadyDecidedError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  app.post("/api/artifacts", async (req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    const body = parseOr400(NewArtifactSchema, req.body, reply);
    if (!body) return;
    const artifact = opts.artifacts.create(body);
    mailbox.events.emit("artifact", artifact);
    return reply.code(201).send(artifact);
  });

  app.get("/api/artifacts", async (_req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    return opts.artifacts.list();
  });

  app.get("/api/artifacts/:id", async (req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const art = opts.artifacts.get(id);
    if (!art) return reply.code(404).send({ error: `artifact not found: ${id}` });
    return art;
  });

  app.get("/api/artifacts/:id/blob", async (req, reply) => {
    if (!opts.artifacts) return reply.code(503).send({ error: "artifacts store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const art = opts.artifacts.get(id);
    const blob = opts.artifacts.getBlob(id);
    if (!art || !blob) return reply.code(404).send({ error: `artifact not found: ${id}` });
    return reply
      .header("content-type", art.mime)
      .header("content-disposition", `inline; filename="${art.name}"`)
      .send(blob);
  });

  app.post("/api/workspaces", async (req, reply) => {
    if (!opts.workspaces) return reply.code(503).send({ error: "workspaces store not configured" });
    const body = parseOr400(NewWorkspaceSchema, req.body, reply);
    if (!body) return;
    const ws = opts.workspaces.create(body);
    mailbox.events.emit("workspace", ws);
    return reply.code(201).send(ws);
  });
  app.get("/api/workspaces", async (_req, reply) => {
    if (!opts.workspaces) return reply.code(503).send({ error: "workspaces store not configured" });
    return opts.workspaces.list();
  });
  app.get("/api/workspaces/:id", async (req, reply) => {
    if (!opts.workspaces) return reply.code(503).send({ error: "workspaces store not configured" });
    const { id } = IdParamsSchema.parse(req.params);
    const ws = opts.workspaces.get(id);
    if (!ws) return reply.code(404).send({ error: `workspace not found: ${id}` });
    return ws;
  });

  app.get("/api/machines", async () => machines.list());

  app.post("/api/fs/:machine/:op", async (req, reply) => {
    const params = req.params as { machine: string; op: string };
    const op = FsOpSchema.safeParse(params.op);
    if (!op.success) return reply.code(400).send({ error: "invalid op" });
    const conn = machines.get(params.machine);
    if (!conn) return reply.code(503).send({ error: `machine unreachable: ${params.machine}` });
    const body = (req.body ?? {}) as { path?: string; content?: string; threadId?: string };
    if (!body.path) return reply.code(400).send({ error: "path required" });
    const id = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: "fs-request", id, op: op.data, path: body.path,
        content: body.content, threadId: body.threadId,
      }),
    );
    let res;
    try {
      res = await pending.create(id, 10_000);
    } catch {
      return reply.code(504).send({ error: "fs request timed out" });
    }
    if (!res.ok) return reply.code(422).send({ error: res.error ?? "fs error" });
    if (op.data === "write" && body.threadId) {
      try {
        mailbox.appendMessage(body.threadId, {
          from: "you", to: [], type: "status", body: `edited ${body.path}`, artifacts: [],
        });
      } catch {
        /* thread may be closed/absent — best-effort log */
      }
    }
    return res.result;
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
    const onStatus = (status: AgentStatus): void => {
      socket.send(JSON.stringify({ type: "agent-status", status }));
    };
    const onTask = (task: Task): void => {
      socket.send(JSON.stringify({ type: "task", task }));
    };
    const onArtifact = (artifact: Artifact): void => {
      socket.send(JSON.stringify({ type: "artifact", artifact }));
    };
    const onWorkspace = (workspace: Workspace): void => {
      socket.send(JSON.stringify({ type: "workspace", workspace }));
    };
    const onApproval = (approval: Approval): void => {
      socket.send(JSON.stringify({ type: "approval", approval }));
    };
    mailbox.events.on("message", onMessage);
    mailbox.events.on("thread", onThread);
    mailbox.events.on("turn", onTurn);
    mailbox.events.on("task", onTask);
    mailbox.events.on("artifact", onArtifact);
    mailbox.events.on("workspace", onWorkspace);
    mailbox.events.on("approval", onApproval);
    if (opts.status) opts.status.events.on("agent-status", onStatus);

    socket.on("message", (raw: Buffer) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      const f = frame as { type?: unknown };
      if (f.type === "hello") {
        const parsed = HelloSchema.safeParse(frame);
        if (parsed.success) machines.register(parsed.data.machine, socket, parsed.data.files);
      } else if (f.type === "fs-response") {
        const parsed = FsResponseSchema.safeParse(frame);
        if (parsed.success) pending.settle(parsed.data.id, parsed.data);
      }
    });

    socket.on("close", () => {
      mailbox.events.off("message", onMessage);
      mailbox.events.off("thread", onThread);
      mailbox.events.off("turn", onTurn);
      mailbox.events.off("task", onTask);
      mailbox.events.off("artifact", onArtifact);
      mailbox.events.off("workspace", onWorkspace);
      mailbox.events.off("approval", onApproval);
      if (opts.status) opts.status.events.off("agent-status", onStatus);
      machines.unregisterSocket(socket);
    });
  });

  if (opts.webDir && existsSync(join(opts.webDir, "index.html"))) {
    const indexHtml = readFileSync(join(opts.webDir, "index.html"), "utf8").replaceAll(
      "CONCLAVE_TOKEN_PLACEHOLDER",
      token,
    );
    await app.register(fastifyStatic, { root: opts.webDir, index: false, wildcard: false });
    app.get("/", async (_req, reply) => reply.type("text/html").send(indexHtml));
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0];
      if (req.method === "GET" && !path.startsWith("/api") && path !== "/ws" && path !== "/health") {
        return reply.type("text/html").send(indexHtml);
      }
      return reply.code(404).send({ error: "not found" });
    });
  } else if (opts.webDir) {
    console.warn(`conclave hub: CONCLAVE_WEB_DIR is set but ${join(opts.webDir, "index.html")} does not exist — web app NOT served`);
  }

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
