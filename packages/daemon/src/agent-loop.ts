import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentRuntime, Approval, Message, Task, TurnRequest } from "@conclave/shared";
import type { RuntimeAdapter, TurnResult } from "./adapter.js";
import type { DaemonState } from "./daemon-state.js";
import type { HubClient } from "./hub-client.js";
import type { TurnQueue } from "./turn-queue.js";

const require = createRequire(import.meta.url);

export const HUB_MCP_TOOLS = [
  "mcp__hub__send_message",
  "mcp__hub__check_inbox",
  "mcp__hub__wait_for_reply",
  "mcp__hub__end_thread",
  "mcp__hub__create_artifact",
  "mcp__hub__request_approval",
  "mcp__hub__delegate_task",
];

const DEFAULT_BRIDGE = {
  command: process.execPath,
  args: [
    require.resolve("tsx/cli"),
    fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url)),
  ],
};

const RATE_LIMIT_RE = /rate.?limit|usage limit|too many requests|429/i;

export function parseResetTime(text: string): string | undefined {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (iso) return iso[0];
  return undefined;
}

export function shouldTrigger(agent: AgentConfig, m: Message): boolean {
  if (!m.to.includes(agent.id)) return false;
  if (m.from === agent.id) return false;
  if (m.type !== "text" && m.type !== "proposal") return false;
  return true;
}

function dangerClause(agent: AgentConfig): string {
  if (agent.dangerousActions.length === 0) return "";
  return (
    `\n\nDANGEROUS ACTIONS — before doing any of the following you MUST call the ` +
    `request_approval tool and then end your turn to wait for the decision: ` +
    `${agent.dangerousActions.join("; ")}.`
  );
}

export function buildTurnPrompt(agent: AgentConfig, m: Message, isFirstTurn: boolean): string {
  if (!isFirstTurn) return `[${m.from}]: ${m.body}`;
  const role = agent.role ? `${agent.role}\n\n` : "";
  return (
    `${role}You are agent "${agent.id}" in Conclave thread ${m.threadId}. ` +
    `Hub MCP tools are available: send_message, check_inbox, wait_for_reply, end_thread. ` +
    `Your final response text is posted to the thread automatically — use send_message only ` +
    `for additional mid-turn messages.\n\n[${m.from}]: ${m.body}${dangerClause(agent)}`
  );
}

export function buildDebatePrompt(
  agent: AgentConfig,
  turn: TurnRequest,
  messages: Message[],
  isFirstTurn: boolean,
): string {
  const rendered = messages.map((m) => `[${m.from}]: ${m.body}`).join("\n\n");
  const instruction = turn.instruction
    ? `\n\nInstruction from orchestrator: ${turn.instruction}`
    : "";
  if (!isFirstTurn) return `New messages:\n\n${rendered}${instruction}`;
  const role = agent.role ? `${agent.role}\n\n` : "";
  return (
    `${role}You are agent "${agent.id}" in Conclave debate thread ${turn.threadId}. ` +
    `Hub MCP tools are available: send_message, check_inbox, wait_for_reply, end_thread. ` +
    `When your position is final, call end_thread with a verdict (approve / reject / short ` +
    `position summary). Your final response text is posted to the thread automatically.` +
    `\n\nThread so far:\n\n${rendered}${instruction}${dangerClause(agent)}`
  );
}

export function buildTaskPrompt(agent: AgentConfig, task: Task): string {
  const role = agent.role ? `${agent.role}\n\n` : "";
  return (
    `${role}You are agent "${agent.id}" in Conclave task thread ${task.threadId}. ` +
    `Hub MCP tools are available: send_message, check_inbox, wait_for_reply, end_thread. ` +
    `Delegated task:\n\n${task.spec}\n\n` +
    `Work in this workspace. Your final response text is posted as the task result.` +
    `${dangerClause(agent)}`
  );
}

export function buildApprovalResumePrompt(a: Approval): string {
  const note = a.note ? `: ${a.note}` : "";
  return (
    `Your approval request "${a.action}" was ${a.state}${note}. ` +
    `Continue the task accordingly; if denied, adapt or wrap up and report what you did.`
  );
}

export async function runTaskCatchUp(
  hub: HubClient,
  agents: AgentConfig[],
  handle: (t: Task) => void,
): Promise<number> {
  let total = 0;
  for (const agent of agents) {
    const queued = await hub.listTasks(agent.id, "queued");
    for (const t of queued) handle(t);
    total += queued.length;
  }
  return total;
}

export interface AgentLoopOptions {
  agents: AgentConfig[];
  hub: HubClient;
  adapters: Partial<Record<AgentRuntime, RuntimeAdapter>>;
  state: DaemonState;
  queue: TurnQueue;
  hubUrl: string;
  token: string;
  bridgeCommand?: { command: string; args: string[] };
}

export async function runCatchUp(
  hub: HubClient,
  state: DaemonState,
  handle: (m: Message) => void,
): Promise<number> {
  let total = 0;
  for (;;) {
    const page = await hub.listAllMessages(state.getCursor(), 500);
    for (const m of page) handle(m);
    total += page.length;
    if (page.length < 500) return total;
  }
}

export class AgentLoop {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly startedTasks = new Set<string>();
  private readonly handledApprovals = new Set<string>();

  constructor(private readonly opts: AgentLoopOptions) {}

  handleTask(task: Task): void {
    if (this.startedTasks.has(task.id)) return;
    if (task.state !== "queued") return;
    const agent = this.opts.agents.find((a) => a.id === task.assignee);
    if (!agent) return;
    this.startedTasks.add(task.id);
    const work = this.opts.queue.run(agent.id, () => this.runTask(agent, task)).catch(() => undefined);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async runTask(agent: AgentConfig, task: Task): Promise<void> {
    const { hub } = this.opts;
    try {
      await hub.setTaskState(task.id, "running");
      await this.reportStatus(agent, "running", `task ${task.id}`, task.threadId);
      const adapter = this.opts.adapters[agent.runtime];
      if (!adapter) throw new Error(`no adapter for runtime ${agent.runtime}`);
      const result = await adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildTaskPrompt(agent, task),
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(task.threadId, agent.id),
      });
      if (result.sessionId) this.opts.state.setSession(task.threadId, agent.id, result.sessionId);
      await this.finishTaskTurn(agent, task.id, task.threadId, result);
    } catch (e) {
      await this.failTask(agent, task.id, task.threadId, e);
    }
  }

  // Shared completion for task turns (initial and approval-resumed): report,
  // post the result, then either pause (a pending approval flipped the task to
  // input-required), finish, or leave an already-finished task alone.
  private async finishTaskTurn(
    agent: AgentConfig,
    taskId: string,
    threadId: string,
    result: TurnResult,
  ): Promise<void> {
    const { hub } = this.opts;
    await this.reportTurn(agent, threadId, result);
    await this.reportTurnStatus(agent, threadId, result);
    if (result.isError) {
      await hub.setTaskState(taskId, "failed");
      return;
    }
    if (result.text.trim()) {
      await hub.postMessage(threadId, {
        from: agent.id, to: [], type: "text", body: result.text, artifacts: [],
      });
    }
    const current = await hub.getTask(taskId);
    if (current.state === "input-required") {
      await this.reportStatus(agent, "blocked", "awaiting approval", threadId);
      return;
    }
    if (current.state === "running") await hub.setTaskState(taskId, "done");
  }

  private async failTask(agent: AgentConfig, taskId: string, threadId: string, e: unknown): Promise<void> {
    await this.postFailure(agent, threadId, e);
    await this.reportStatus(agent, "idle", "", threadId);
    try {
      await this.opts.hub.setTaskState(taskId, "failed");
    } catch (stateErr) {
      console.error(
        `agent ${agent.id}: failed to mark task ${taskId} failed:`,
        stateErr instanceof Error ? stateErr.message : stateErr,
      );
    }
  }

  handleApproval(approval: Approval): void {
    if (approval.state === "pending" || !approval.taskId) return;
    if (this.handledApprovals.has(approval.id)) return;
    const agent = this.opts.agents.find((a) => a.id === approval.requestedBy);
    if (!agent) return;
    this.handledApprovals.add(approval.id);
    const work = this.opts.queue
      .run(agent.id, () => this.resumeAfterApproval(agent, approval))
      .catch(() => undefined);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async resumeAfterApproval(agent: AgentConfig, approval: Approval): Promise<void> {
    const { hub, state } = this.opts;
    const taskId = approval.taskId!;
    const threadId = approval.threadId;
    try {
      // The hub flips input-required → running on decide; anything else means
      // the task already finished (or another turn owns it) — do not resume.
      const task = await hub.getTask(taskId);
      if (task.state !== "running") return;
      await this.reportStatus(agent, "running", `task ${taskId}`, threadId);
      const adapter = this.opts.adapters[agent.runtime];
      if (!adapter) throw new Error(`no adapter for runtime ${agent.runtime}`);
      const sessionId = state.getSession(threadId, agent.id);
      const prompt = sessionId
        ? buildApprovalResumePrompt(approval)
        : `${buildTaskPrompt(agent, task)}\n\n${buildApprovalResumePrompt(approval)}`;
      const result = await adapter.runTurn({
        cwd: agent.workspace,
        prompt,
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(threadId, agent.id),
      });
      if (result.sessionId) state.setSession(threadId, agent.id, result.sessionId);
      await this.finishTaskTurn(agent, taskId, threadId, result);
    } catch (e) {
      await this.failTask(agent, taskId, threadId, e);
    }
  }

  handleMessage(m: Message): void {
    if (m.id <= this.opts.state.getCursor()) return;
    this.opts.state.setCursor(m.id);
    for (const agent of this.opts.agents) {
      if (!shouldTrigger(agent, m)) continue;
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

  handleTurnRequest(turn: TurnRequest): void {
    const agent = this.opts.agents.find((a) => a.id === turn.agentId);
    if (!agent) return;
    const work = this.opts.queue
      .run(agent.id, () => this.runDebateTurn(agent, turn))
      .catch(() => undefined);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private bridgeConfig(threadId: string, agentId: string): Record<string, unknown> {
    const { hubUrl, token } = this.opts;
    const bridge = this.opts.bridgeCommand ?? DEFAULT_BRIDGE;
    return {
      hub: {
        command: bridge.command,
        args: bridge.args,
        env: {
          CONCLAVE_HUB_URL: hubUrl,
          CONCLAVE_TOKEN: token,
          CONCLAVE_THREAD_ID: threadId,
          CONCLAVE_AGENT_ID: agentId,
        },
      },
    };
  }

  private async postFailure(agent: AgentConfig, threadId: string, e: unknown): Promise<void> {
    const { hub } = this.opts;
    const reason = e instanceof Error ? e.message : String(e);
    try {
      await hub.postMessage(threadId, {
        from: agent.id, to: [], type: "status",
        body: `agent ${agent.id} turn failed: ${reason}`, artifacts: [],
      });
    } catch (statusErr) {
      console.error(
        `agent ${agent.id}: failed to post turn-failure status to thread ${threadId}:`,
        statusErr instanceof Error ? statusErr.message : statusErr,
      );
    }
  }

  private async reportTurn(
    agent: AgentConfig,
    threadId: string,
    result: TurnResult,
  ): Promise<void> {
    if (result.tokens || result.costUsd > 0) {
      try {
        await this.opts.hub.postUsage({
          agent: agent.id,
          threadId,
          inputTokens: result.tokens?.input ?? 0,
          outputTokens: result.tokens?.output ?? 0,
          costUsd: result.costUsd,
        });
      } catch (e) {
        console.error(
          `agent ${agent.id}: failed to post usage:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    if (result.isError) {
      const rateLimited = RATE_LIMIT_RE.test(result.text);
      const label = rateLimited ? "rate-limited" : "error";
      try {
        await this.opts.hub.postMessage(threadId, {
          from: agent.id,
          to: [],
          type: "status",
          body: `agent ${agent.id} ${label}: ${result.text.slice(0, 200)}`,
          artifacts: [],
        });
      } catch (e) {
        console.error(
          `agent ${agent.id}: failed to post error status to thread ${threadId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  private async reportStatus(
    agent: AgentConfig,
    status: "running" | "blocked" | "idle",
    activity: string,
    threadId: string,
    resetsAt?: string,
  ): Promise<void> {
    try {
      await this.opts.hub.postStatus({ agent: agent.id, status, activity, threadId, resetsAt });
    } catch (e) {
      console.error(
        `agent ${agent.id}: failed to post status:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  private async reportTurnStatus(
    agent: AgentConfig,
    threadId: string,
    result: TurnResult,
  ): Promise<void> {
    if (result.isError && RATE_LIMIT_RE.test(result.text)) {
      await this.reportStatus(agent, "blocked", "rate-limited", threadId, parseResetTime(result.text));
    } else {
      await this.reportStatus(agent, "idle", "", threadId);
    }
  }

  private async runTurn(agent: AgentConfig, m: Message): Promise<void> {
    const { hub, state } = this.opts;
    try {
      const adapter = this.opts.adapters[agent.runtime];
      if (!adapter) throw new Error(`no adapter for runtime ${agent.runtime}`);
      const sessionId = state.getSession(m.threadId, agent.id);
      await this.reportStatus(agent, "running", `replying in thread ${m.threadId}`, m.threadId);
      const result = await adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildTurnPrompt(agent, m, sessionId === undefined),
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(m.threadId, agent.id),
      });
      if (result.sessionId) state.setSession(m.threadId, agent.id, result.sessionId);
      await this.reportTurn(agent, m.threadId, result);
      await this.reportTurnStatus(agent, m.threadId, result);
      if (!result.isError && result.text.trim()) {
        await hub.postMessage(m.threadId, {
          from: agent.id, to: m.from === "you" ? [m.from] : [], type: "text",
          body: result.text, artifacts: [],
        });
      }
    } catch (e) {
      await this.postFailure(agent, m.threadId, e);
      await this.reportStatus(agent, "idle", "", m.threadId);
    }
  }

  private async runDebateTurn(agent: AgentConfig, turn: TurnRequest): Promise<void> {
    const { hub, state } = this.opts;
    try {
      const since = Math.max(state.getWatermark(turn.threadId, agent.id), turn.sinceMessageId);
      const messages = (await hub.listMessages(turn.threadId, since)).filter(
        (m) => m.from !== agent.id,
      );
      const adapter = this.opts.adapters[agent.runtime];
      if (!adapter) throw new Error(`no adapter for runtime ${agent.runtime}`);
      const sessionId = state.getSession(turn.threadId, agent.id);
      await this.reportStatus(agent, "running", `debating in thread ${turn.threadId}`, turn.threadId);
      const result = await adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildDebatePrompt(agent, turn, messages, sessionId === undefined),
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(turn.threadId, agent.id),
      });
      const maxSeen = messages.at(-1)?.id;
      if (maxSeen !== undefined) state.setWatermark(turn.threadId, agent.id, maxSeen);
      if (result.sessionId) state.setSession(turn.threadId, agent.id, result.sessionId);
      await this.reportTurn(agent, turn.threadId, result);
      await this.reportTurnStatus(agent, turn.threadId, result);
      if (!result.isError && result.text.trim()) {
        await hub.postMessage(turn.threadId, {
          from: agent.id, to: [], type: "text", body: result.text, artifacts: [],
        });
      }
    } catch (e) {
      await this.postFailure(agent, turn.threadId, e);
      await this.reportStatus(agent, "idle", "", turn.threadId);
    }
  }
}
