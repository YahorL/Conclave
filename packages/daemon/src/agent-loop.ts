import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AgentConfig, Message, TurnRequest } from "@conclave/shared";
import type { RuntimeAdapter } from "./adapter.js";
import type { DaemonState } from "./daemon-state.js";
import type { HubClient } from "./hub-client.js";
import type { TurnQueue } from "./turn-queue.js";

const require = createRequire(import.meta.url);

export const HUB_MCP_TOOLS = [
  "mcp__hub__send_message",
  "mcp__hub__check_inbox",
  "mcp__hub__wait_for_reply",
  "mcp__hub__end_thread",
];

const DEFAULT_BRIDGE = {
  command: process.execPath,
  args: [
    require.resolve("tsx/cli"),
    fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url)),
  ],
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
    `\n\nThread so far:\n\n${rendered}${instruction}`
  );
}

export interface AgentLoopOptions {
  agents: AgentConfig[];
  hub: HubClient;
  adapter: RuntimeAdapter;
  state: DaemonState;
  queue: TurnQueue;
  hubUrl: string;
  token: string;
  allowAgentTriggers: boolean;
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

  constructor(private readonly opts: AgentLoopOptions) {}

  handleMessage(m: Message): void {
    if (m.id <= this.opts.state.getCursor()) return;
    this.opts.state.setCursor(m.id);
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

  private async runTurn(agent: AgentConfig, m: Message): Promise<void> {
    const { hub, state } = this.opts;
    try {
      const sessionId = state.getSession(m.threadId, agent.id);
      const result = await this.opts.adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildTurnPrompt(agent, m, sessionId === undefined),
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(m.threadId, agent.id),
      });
      if (result.sessionId) state.setSession(m.threadId, agent.id, result.sessionId);
      if (result.text.trim()) {
        await hub.postMessage(m.threadId, {
          from: agent.id, to: [m.from], type: "text", body: result.text, artifacts: [],
        });
      }
    } catch (e) {
      await this.postFailure(agent, m.threadId, e);
    }
  }

  private async runDebateTurn(agent: AgentConfig, turn: TurnRequest): Promise<void> {
    const { hub, state } = this.opts;
    try {
      const since = Math.max(state.getWatermark(turn.threadId, agent.id), turn.sinceMessageId);
      const messages = (await hub.listMessages(turn.threadId, since)).filter(
        (m) => m.from !== agent.id,
      );
      const sessionId = state.getSession(turn.threadId, agent.id);
      const result = await this.opts.adapter.runTurn({
        cwd: agent.workspace,
        prompt: buildDebatePrompt(agent, turn, messages, sessionId === undefined),
        sessionId,
        allowedTools: [...agent.allowedTools, ...HUB_MCP_TOOLS],
        mcpServers: this.bridgeConfig(turn.threadId, agent.id),
      });
      const maxSeen = messages.at(-1)?.id;
      if (maxSeen !== undefined) state.setWatermark(turn.threadId, agent.id, maxSeen);
      if (result.sessionId) state.setSession(turn.threadId, agent.id, result.sessionId);
      if (result.text.trim()) {
        await hub.postMessage(turn.threadId, {
          from: agent.id, to: [], type: "text", body: result.text, artifacts: [],
        });
      }
    } catch (e) {
      await this.postFailure(agent, turn.threadId, e);
    }
  }
}
